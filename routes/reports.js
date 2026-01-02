const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

// Get sales report
router.get('/sales', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, gst_filter, page = 1, limit = 50 } = req.query; // gst_filter: 'all', 'with_gst', 'without_gst'
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset = (pageNum - 1) * limitNum;
    
    let baseQuery = `FROM sale_transactions st 
    JOIN seller_parties sp ON st.seller_party_id = sp.id 
    WHERE 1=1`;
    const params = [];

    if (from_date) {
      baseQuery += ' AND st.transaction_date >= ?';
      params.push(from_date);
    } else {
      baseQuery += ' AND st.transaction_date = CURDATE()';
    }
    
    if (to_date) {
      baseQuery += ' AND st.transaction_date <= ?';
      params.push(to_date);
    }

    // Filter by GST status
    if (gst_filter === 'with_gst') {
      baseQuery += ' AND st.with_gst = 1';
    } else if (gst_filter === 'without_gst') {
      baseQuery += ' AND st.with_gst = 0';
    }

    // Get total count
    const [countResult] = await pool.execute(`SELECT COUNT(*) as total ${baseQuery}`, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limitNum);

    // Get paginated data
    // Note: LIMIT and OFFSET cannot use placeholders in prepared statements, so we use template literals
    let query = `SELECT 
      st.id,
      st.transaction_date,
      st.bill_number,
      sp.party_name,
      st.total_amount,
      st.paid_amount,
      st.balance_amount,
      st.payment_status,
      st.with_gst,
      st.previous_balance_paid
    ${baseQuery}
    ORDER BY st.transaction_date DESC, st.id DESC
    LIMIT ${limitNum} OFFSET ${offset}`;
    
    const [transactions] = await pool.execute(query, params);

    // Calculate totals
    let totalSales = 0;
    let totalPaid = 0;
    let totalBalance = 0;
    let totalProfit = 0;

    for (const txn of transactions) {
      totalSales += parseFloat(txn.total_amount) || 0;
      totalPaid += parseFloat(txn.paid_amount) || 0;
      totalBalance += parseFloat(txn.balance_amount) || 0;
    }

    // Calculate profit (only for super admin)
    if (req.user.role === 'super_admin') {
      for (const txn of transactions) {
        const [items] = await pool.execute(
          `SELECT si.quantity, si.sale_rate, i.purchase_rate 
           FROM sale_items si 
           JOIN items i ON si.item_id = i.id 
           WHERE si.sale_transaction_id = (SELECT id FROM sale_transactions WHERE bill_number = ? LIMIT 1)`,
          [txn.bill_number]
        );
        
        for (const item of items) {
          const profit = (item.sale_rate - item.purchase_rate) * item.quantity;
          totalProfit += profit;
        }
      }
    }

    // Count bills with and without GST
    const withGstCount = transactions.filter(t => t.with_gst === 1 || t.with_gst === true).length;
    const withoutGstCount = transactions.filter(t => t.with_gst === 0 || t.with_gst === false).length;

    res.json({
      transactions,
      summary: {
        totalSales,
        totalPaid,
        totalBalance,
        totalProfit: req.user.role === 'super_admin' ? totalProfit : null,
        totalTransactions: totalRecords,
        withGstCount,
        withoutGstCount
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages
      }
    });
  } catch (error) {
    console.error('Sales report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get item-wise sales report (aggregated by item)
router.get('/sales/items', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, gst_filter, item_query, seller_party_id, page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset = (pageNum - 1) * limitNum;

    let baseQuery = `
      FROM sale_items si
      JOIN sale_transactions st ON si.sale_transaction_id = st.id
      JOIN items i ON si.item_id = i.id
      WHERE 1=1
    `;

    const params = [];

    if (from_date) {
      baseQuery += ' AND st.transaction_date >= ?';
      params.push(from_date);
    }

    if (to_date) {
      baseQuery += ' AND st.transaction_date <= ?';
      params.push(to_date);
    }

    if (gst_filter === 'with_gst') {
      baseQuery += ' AND st.with_gst = 1';
    } else if (gst_filter === 'without_gst') {
      baseQuery += ' AND st.with_gst = 0';
    }

    if (seller_party_id) {
      baseQuery += ' AND st.seller_party_id = ?';
      params.push(seller_party_id);
    }

    if (item_query) {
      baseQuery += ' AND (i.product_name LIKE ? OR i.brand LIKE ? OR i.hsn_number LIKE ?)';
      const like = `%${item_query}%`;
      params.push(like, like, like);
    }

    // Get total count (count distinct items after grouping)
    // We need to count the distinct items that match the filters
    const countQuery = `
      SELECT COUNT(DISTINCT i.id) as total
      ${baseQuery}
    `;
    const [countResult] = await pool.execute(countQuery, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limitNum);

    // Get paginated data
    let query = `
      SELECT
        i.id AS item_id,
        i.product_name,
        i.brand,
        i.hsn_number,
        COALESCE(i.tax_rate, 0) AS tax_rate,
        SUM(si.quantity) AS total_quantity,
        SUM(si.quantity * si.sale_rate) AS gross_amount,
        SUM(COALESCE(si.discount, 0)) AS discount_amount,
        SUM(si.total_amount) AS taxable_or_net_amount,
        SUM(
          CASE
            WHEN st.with_gst = 1 THEN (si.total_amount * (COALESCE(i.tax_rate, 0) / 100))
            ELSE 0
          END
        ) AS gst_amount,
        SUM(
          CASE
            WHEN st.with_gst = 1 THEN (si.total_amount + (si.total_amount * (COALESCE(i.tax_rate, 0) / 100)))
            ELSE si.total_amount
          END
        ) AS net_amount,
        COUNT(DISTINCT st.id) AS bills_count,
        COUNT(DISTINCT st.seller_party_id) AS parties_count
      ${baseQuery}
      GROUP BY i.id, i.product_name, i.brand, i.hsn_number, i.tax_rate
      ORDER BY net_amount DESC, total_quantity DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const [items] = await pool.execute(query, params);

    // Calculate summary from ALL items (not just current page)
    // We need to run the same query without LIMIT to get totals
    const summaryQuery = `
      SELECT
        COUNT(DISTINCT i.id) AS totalItems,
        SUM(si.quantity) AS totalQuantity,
        SUM(si.quantity * si.sale_rate) AS totalGross,
        SUM(COALESCE(si.discount, 0)) AS totalDiscount,
        SUM(si.total_amount) AS totalTaxableOrNet,
        SUM(
          CASE
            WHEN st.with_gst = 1 THEN (si.total_amount * (COALESCE(i.tax_rate, 0) / 100))
            ELSE 0
          END
        ) AS totalGst,
        SUM(
          CASE
            WHEN st.with_gst = 1 THEN (si.total_amount + (si.total_amount * (COALESCE(i.tax_rate, 0) / 100)))
            ELSE si.total_amount
          END
        ) AS totalNet,
        COUNT(DISTINCT st.id) AS totalBills
      ${baseQuery}
    `;
    const [summaryResult] = await pool.execute(summaryQuery, params);
    const summaryRow = summaryResult[0];
    
    const summary = {
      totalItems: parseInt(summaryRow.totalItems, 10) || 0,
      totalQuantity: parseFloat(summaryRow.totalQuantity) || 0,
      totalGross: parseFloat(summaryRow.totalGross) || 0,
      totalDiscount: parseFloat(summaryRow.totalDiscount) || 0,
      totalTaxableOrNet: parseFloat(summaryRow.totalTaxableOrNet) || 0,
      totalGst: parseFloat(summaryRow.totalGst) || 0,
      totalNet: parseFloat(summaryRow.totalNet) || 0,
      totalBills: parseInt(summaryRow.totalBills, 10) || 0
    };

    res.json({ 
      items, 
      summary,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages
      }
    });
  } catch (error) {
    console.error('Item-wise sales report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export item-wise sales report to Excel
router.get('/sales/items/export', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, gst_filter, item_query, seller_party_id } = req.query;

    // Reuse the same query as /sales/items
    let query = `
      SELECT
        i.product_name,
        i.brand,
        i.hsn_number,
        COALESCE(i.tax_rate, 0) AS tax_rate,
        SUM(si.quantity) AS total_quantity,
        SUM(si.quantity * si.sale_rate) AS gross_amount,
        SUM(COALESCE(si.discount, 0)) AS discount_amount,
        SUM(si.total_amount) AS taxable_or_net_amount,
        SUM(
          CASE
            WHEN st.with_gst = 1 THEN (si.total_amount * (COALESCE(i.tax_rate, 0) / 100))
            ELSE 0
          END
        ) AS gst_amount,
        SUM(
          CASE
            WHEN st.with_gst = 1 THEN (si.total_amount + (si.total_amount * (COALESCE(i.tax_rate, 0) / 100)))
            ELSE si.total_amount
          END
        ) AS net_amount,
        COUNT(DISTINCT st.id) AS bills_count
      FROM sale_items si
      JOIN sale_transactions st ON si.sale_transaction_id = st.id
      JOIN items i ON si.item_id = i.id
      WHERE 1=1
    `;

    const params = [];

    if (from_date) {
      query += ' AND st.transaction_date >= ?';
      params.push(from_date);
    } else {
      query += ' AND st.transaction_date = CURDATE()';
    }

    if (to_date) {
      query += ' AND st.transaction_date <= ?';
      params.push(to_date);
    }

    if (gst_filter === 'with_gst') {
      query += ' AND st.with_gst = 1';
    } else if (gst_filter === 'without_gst') {
      query += ' AND st.with_gst = 0';
    }

    if (seller_party_id) {
      query += ' AND st.seller_party_id = ?';
      params.push(seller_party_id);
    }

    if (item_query) {
      query += ' AND (i.product_name LIKE ? OR i.brand LIKE ? OR i.hsn_number LIKE ?)';
      const like = `%${item_query}%`;
      params.push(like, like, like);
    }

    query += `
      GROUP BY i.id, i.product_name, i.brand, i.hsn_number, i.tax_rate
      ORDER BY net_amount DESC, total_quantity DESC
    `;

    const [rows] = await pool.execute(query, params);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Item-wise Sales');

    worksheet.columns = [
      { header: 'Product Name', key: 'product_name', width: 30 },
      { header: 'Brand', key: 'brand', width: 18 },
      { header: 'HSN', key: 'hsn_number', width: 14 },
      { header: 'Tax %', key: 'tax_rate', width: 10 },
      { header: 'Total Qty', key: 'total_quantity', width: 10 },
      { header: 'Gross Amount', key: 'gross_amount', width: 15 },
      { header: 'Discount', key: 'discount_amount', width: 12 },
      { header: 'Taxable/Net', key: 'taxable_or_net_amount', width: 15 },
      { header: 'GST Amount', key: 'gst_amount', width: 12 },
      { header: 'Net Amount', key: 'net_amount', width: 15 },
      { header: 'Bills Count', key: 'bills_count', width: 12 }
    ];

    rows.forEach((r) => {
      worksheet.addRow({
        product_name: r.product_name,
        brand: r.brand,
        hsn_number: r.hsn_number,
        tax_rate: r.tax_rate,
        total_quantity: r.total_quantity,
        gross_amount: r.gross_amount,
        discount_amount: r.discount_amount,
        taxable_or_net_amount: r.taxable_or_net_amount,
        gst_amount: r.gst_amount,
        net_amount: r.net_amount,
        bills_count: r.bills_count
      });
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.total_quantity += parseFloat(r.total_quantity) || 0;
        acc.gross_amount += parseFloat(r.gross_amount) || 0;
        acc.discount_amount += parseFloat(r.discount_amount) || 0;
        acc.taxable_or_net_amount += parseFloat(r.taxable_or_net_amount) || 0;
        acc.gst_amount += parseFloat(r.gst_amount) || 0;
        acc.net_amount += parseFloat(r.net_amount) || 0;
        return acc;
      },
      {
        total_quantity: 0,
        gross_amount: 0,
        discount_amount: 0,
        taxable_or_net_amount: 0,
        gst_amount: 0,
        net_amount: 0
      }
    );

    worksheet.addRow({});
    worksheet.addRow({
      product_name: 'TOTAL',
      total_quantity: totals.total_quantity,
      gross_amount: totals.gross_amount,
      discount_amount: totals.discount_amount,
      taxable_or_net_amount: totals.taxable_or_net_amount,
      gst_amount: totals.gst_amount,
      net_amount: totals.net_amount
    });

    const from = from_date || new Date().toISOString().split('T')[0];
    const to = to_date || from;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=item_wise_sales_${from}_${to}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export item-wise sales report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export sales report to Excel
router.get('/sales/export', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    
    let query = `SELECT 
      st.transaction_date,
      st.bill_number,
      sp.party_name,
      st.total_amount,
      st.paid_amount,
      st.balance_amount,
      st.payment_status
    FROM sale_transactions st 
    JOIN seller_parties sp ON st.seller_party_id = sp.id 
    WHERE 1=1`;
    const params = [];

    if (from_date) {
      query += ' AND st.transaction_date >= ?';
      params.push(from_date);
    } else {
      query += ' AND st.transaction_date = CURDATE()';
    }
    
    if (to_date) {
      query += ' AND st.transaction_date <= ?';
      params.push(to_date);
    }

    query += ' ORDER BY st.transaction_date DESC';

    const [transactions] = await pool.execute(query, params);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sales Report');

    // Add headers
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Bill Number', key: 'bill_number', width: 20 },
      { header: 'Party Name', key: 'party_name', width: 30 },
      { header: 'Total Amount', key: 'total_amount', width: 15 },
      { header: 'Paid Amount', key: 'paid_amount', width: 15 },
      { header: 'Balance Amount', key: 'balance_amount', width: 15 },
      { header: 'Payment Status', key: 'payment_status', width: 15 }
    ];

    // Add data
    transactions.forEach(txn => {
      worksheet.addRow({
        date: txn.transaction_date,
        bill_number: txn.bill_number,
        party_name: txn.party_name,
        total_amount: txn.total_amount,
        paid_amount: txn.paid_amount,
        balance_amount: txn.balance_amount,
        payment_status: txn.payment_status
      });
    });

    // Add summary row
    const totalSales = transactions.reduce((sum, t) => sum + (parseFloat(t.total_amount) || 0), 0);
    const totalPaid = transactions.reduce((sum, t) => sum + (parseFloat(t.paid_amount) || 0), 0);
    const totalBalance = transactions.reduce((sum, t) => sum + (parseFloat(t.balance_amount) || 0), 0);

    worksheet.addRow({});
    worksheet.addRow({
      date: 'TOTAL',
      total_amount: totalSales,
      paid_amount: totalPaid,
      balance_amount: totalBalance
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=sales_report.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export sales report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get return report
router.get('/returns', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, party_type, page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset = (pageNum - 1) * limitNum;
    
    let baseQuery = `FROM return_transactions rt 
    LEFT JOIN seller_parties sp ON rt.seller_party_id = sp.id 
    LEFT JOIN buyer_parties bp ON rt.buyer_party_id = bp.id
    JOIN items i ON rt.item_id = i.id 
    WHERE 1=1`;
    const params = [];

    if (from_date) {
      baseQuery += ' AND rt.return_date >= ?';
      params.push(from_date);
    } else {
      baseQuery += ' AND rt.return_date = CURDATE()';
    }
    
    if (to_date) {
      baseQuery += ' AND rt.return_date <= ?';
      params.push(to_date);
    }

    if (party_type) {
      baseQuery += ' AND rt.party_type = ?';
      params.push(party_type);
    }

    // Get total count
    const [countResult] = await pool.execute(`SELECT COUNT(*) as total ${baseQuery}`, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limitNum);

    // Get paginated data
    let query = `SELECT 
      rt.id,
      rt.return_date,
      rt.party_type,
      COALESCE(sp.party_name, bp.party_name) as party_name,
      i.product_name,
      i.brand,
      rt.quantity,
      rt.return_amount,
      rt.reason
    ${baseQuery}
    ORDER BY rt.return_date DESC
    LIMIT ${limitNum} OFFSET ${offset}`;

    const [transactions] = await pool.execute(query, params);

    const totalReturns = transactions.reduce((sum, t) => sum + (parseFloat(t.return_amount) || 0), 0);

    res.json({
      transactions,
      summary: {
        totalReturns,
        totalTransactions: totalRecords
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages
      }
    });
  } catch (error) {
    console.error('Return report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export return report to Excel
router.get('/returns/export', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, party_type } = req.query;
    
    let query = `SELECT 
      rt.return_date,
      COALESCE(sp.party_name, bp.party_name) as party_name,
      rt.party_type,
      i.product_name,
      i.brand,
      rt.quantity,
      rt.return_amount,
      rt.reason
    FROM return_transactions rt 
    LEFT JOIN seller_parties sp ON rt.seller_party_id = sp.id 
    LEFT JOIN buyer_parties bp ON rt.buyer_party_id = bp.id
    JOIN items i ON rt.item_id = i.id 
    WHERE 1=1`;
    const params = [];

    if (from_date) {
      query += ' AND rt.return_date >= ?';
      params.push(from_date);
    } else {
      query += ' AND rt.return_date = CURDATE()';
    }
    
    if (to_date) {
      query += ' AND rt.return_date <= ?';
      params.push(to_date);
    }

    if (party_type) {
      query += ' AND rt.party_type = ?';
      params.push(party_type);
    }

    query += ' ORDER BY rt.return_date DESC';

    const [transactions] = await pool.execute(query, params);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Return Report');

    worksheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Party Type', key: 'party_type', width: 12 },
      { header: 'Party Name', key: 'party_name', width: 30 },
      { header: 'Product Name', key: 'product_name', width: 30 },
      { header: 'Brand', key: 'brand', width: 20 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Return Amount', key: 'return_amount', width: 15 },
      { header: 'Reason', key: 'reason', width: 30 }
    ];

    transactions.forEach(txn => {
      worksheet.addRow({
        date: txn.return_date,
        party_type: txn.party_type === 'buyer' ? 'Buyer' : 'Seller',
        party_name: txn.party_name,
        product_name: txn.product_name,
        brand: txn.brand,
        quantity: txn.quantity,
        return_amount: txn.return_amount,
        reason: txn.reason
      });
    });

    const totalReturns = transactions.reduce((sum, t) => sum + (parseFloat(t.return_amount) || 0), 0);
    worksheet.addRow({});
    worksheet.addRow({
      date: 'TOTAL',
      return_amount: totalReturns
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=return_report.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export return report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;








