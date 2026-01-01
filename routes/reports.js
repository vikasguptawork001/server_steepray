const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

// Get sales report
router.get('/sales', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, gst_filter } = req.query; // gst_filter: 'all', 'with_gst', 'without_gst'
    
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

    // Filter by GST status
    if (gst_filter === 'with_gst') {
      query += ' AND st.with_gst = 1';
    } else if (gst_filter === 'without_gst') {
      query += ' AND st.with_gst = 0';
    }

    query += ' ORDER BY st.transaction_date DESC, st.id DESC';

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
        totalTransactions: transactions.length,
        withGstCount,
        withoutGstCount
      }
    });
  } catch (error) {
    console.error('Sales report error:', error);
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
    const { from_date, to_date, party_type } = req.query;
    
    let query = `SELECT 
      rt.return_date,
      rt.party_type,
      COALESCE(sp.party_name, bp.party_name) as party_name,
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

    const totalReturns = transactions.reduce((sum, t) => sum + (parseFloat(t.return_amount) || 0), 0);

    res.json({
      transactions,
      summary: {
        totalReturns,
        totalTransactions: transactions.length
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








