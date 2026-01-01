const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { validateTransaction } = require('../middleware/validation');

const router = express.Router();

// Create sale transaction
router.post('/sale', authenticateToken, validateTransaction, async (req, res) => {
  try {
    const { seller_party_id, items, payment_status, paid_amount, with_gst = false, previous_balance_paid = 0 } = req.body;

    if (!seller_party_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Seller party and items are required' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // First, validate all items and stock before processing
      const itemValidations = [];
      for (const item of items) {
        const [itemData] = await connection.execute('SELECT * FROM items WHERE id = ?', [item.item_id]);
        if (itemData.length === 0) {
          throw new Error(`Item with id ${item.item_id} not found`);
        }
        if (itemData[0].quantity < item.quantity) {
          throw new Error(`Insufficient stock for item ${itemData[0].product_name}. Available: ${itemData[0].quantity}, Requested: ${item.quantity}`);
        }
        itemValidations.push(itemData[0]);
      }

      let subtotal = 0;
      let totalTaxAmount = 0;
      const saleItems = [];

      // Calculate subtotal and process items
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemData = itemValidations[i];

        const itemTotal = item.quantity * item.sale_rate;
        
        // Calculate item-wise discount
        let itemDiscount = 0;
        const itemDiscountType = item.discount_type || 'amount';
        if (itemDiscountType === 'percentage' && item.discount_percentage !== null && item.discount_percentage !== undefined) {
          itemDiscount = (itemTotal * item.discount_percentage) / 100;
        } else {
          itemDiscount = parseFloat(item.discount || 0);
        }
        
        // Ensure discount doesn't exceed item total
        itemDiscount = Math.min(itemDiscount, itemTotal);
        
        const itemTotalAfterDiscount = itemTotal - itemDiscount;
        let itemSubtotal = itemTotalAfterDiscount;
        let itemTax = 0;
        let taxableValue = itemTotalAfterDiscount;
        
        // Calculate tax if with_gst is true (GST-inclusive pricing)
        if (with_gst && itemData.tax_rate && itemData.tax_rate > 0) {
          // GST-inclusive: sale_rate includes GST after discount
          // Taxable value = Total / (1 + GST/100)
          taxableValue = itemTotalAfterDiscount / (1 + itemData.tax_rate / 100);
          itemTax = itemTotalAfterDiscount - taxableValue;
          itemSubtotal = taxableValue; // Subtotal is taxable value
          
          totalTaxAmount += itemTax;
          subtotal += taxableValue; // Accumulate taxable value for GST
        } else {
          subtotal += itemSubtotal; // Accumulate subtotal for non-GST
        }
        
        saleItems.push({ 
          ...item, 
          itemSubtotal,
          itemTotal,
          itemDiscount,
          itemTotalAfterDiscount,
          itemTax,
          taxableValue,
          tax_rate: itemData.tax_rate || 0
        });
      }

      // Calculate final total
      let totalAmount;
      if (with_gst) {
        // For GST-inclusive: total = taxable value + tax
        totalAmount = subtotal + totalTaxAmount;
      } else {
        // For non-GST: total = subtotal (after discounts)
        totalAmount = subtotal;
      }

      // Add previous balance amount being paid to total
      // If customer is paying ₹X of previous balance along with new invoice, grand total = invoice + X
      const previousBalancePaidAmount = parseFloat(previous_balance_paid) || 0;
      const grandTotal = totalAmount + previousBalancePaidAmount;

      // Generate bill number
      const [billCount] = await connection.execute('SELECT COUNT(*) as count FROM sale_transactions');
      const billNumber = `BILL-${Date.now()}-${billCount[0].count + 1}`;

      // Calculate balance and validate paid amount
      const finalPaidAmount = payment_status === 'fully_paid' ? grandTotal : (parseFloat(paid_amount) || 0);
      
      // Validate paid amount doesn't exceed grand total
      if (finalPaidAmount > grandTotal) {
        throw new Error(`Paid amount (₹${finalPaidAmount.toFixed(2)}) cannot exceed grand total (₹${grandTotal.toFixed(2)})`);
      }
      
      if (finalPaidAmount < 0) {
        throw new Error('Paid amount cannot be negative');
      }
      
      // Calculate balance amount (for transaction record - includes previous balance in grand total)
      const balanceAmount = Math.max(0, grandTotal - finalPaidAmount);
      
      // Calculate new transaction balance (for seller balance update - excludes previous balance payment)
      // This is the amount owed from this new transaction only
      // Formula: newTransactionBalance = totalAmount - amountPaidTowardsNewInvoice
      // amountPaidTowardsNewInvoice = finalPaidAmount - previousBalancePaidAmount
      const amountPaidTowardsNewInvoice = Math.max(0, finalPaidAmount - previousBalancePaidAmount);
      const newTransactionBalance = Math.max(0, totalAmount - amountPaidTowardsNewInvoice);

      // Create sale transaction
      // Check if previous_balance_paid column exists
      const [columns] = await connection.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'sale_transactions' 
        AND COLUMN_NAME = 'previous_balance_paid'
      `);
      
      const hasPreviousBalancePaid = columns.length > 0;
      
      let insertQuery, insertValues;
      if (hasPreviousBalancePaid) {
        insertQuery = `INSERT INTO sale_transactions (seller_party_id, transaction_date, subtotal, discount, tax_amount, total_amount, paid_amount, balance_amount, payment_status, bill_number, with_gst, previous_balance_paid)
         VALUES (?, CURDATE(), ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`;
        insertValues = [seller_party_id, subtotal, totalTaxAmount, grandTotal, finalPaidAmount, balanceAmount, payment_status, billNumber, with_gst ? 1 : 0, previousBalancePaidAmount];
      } else {
        // Fallback if column doesn't exist
        insertQuery = `INSERT INTO sale_transactions (seller_party_id, transaction_date, subtotal, discount, tax_amount, total_amount, paid_amount, balance_amount, payment_status, bill_number, with_gst)
         VALUES (?, CURDATE(), ?, 0, ?, ?, ?, ?, ?, ?, ?)`;
        insertValues = [seller_party_id, subtotal, totalTaxAmount, grandTotal, finalPaidAmount, balanceAmount, payment_status, billNumber, with_gst ? 1 : 0];
        console.warn('Warning: previous_balance_paid column does not exist. Please run the migration: server/database/add_previous_balance_paid.sql');
      }
      
      const [saleResult] = await connection.execute(insertQuery, insertValues);

      const saleTransactionId = saleResult.insertId;

      // Create sale items and update stock
      for (const item of saleItems) {
        await connection.execute(
          'INSERT INTO sale_items (sale_transaction_id, item_id, quantity, sale_rate, total_amount, discount, discount_type, discount_percentage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [saleTransactionId, item.item_id, item.quantity, item.sale_rate, item.itemSubtotal, item.itemDiscount || 0, item.discount_type || 'amount', item.discount_percentage || null]
        );

        // Update item quantity
        await connection.execute(
          'UPDATE items SET quantity = quantity - ? WHERE id = ?',
          [item.quantity, item.item_id]
        );

        // Check if quantity reached alert quantity and update order sheet
        const [updatedItem] = await connection.execute(
          'SELECT quantity, alert_quantity FROM items WHERE id = ?',
          [item.item_id]
        );
        
        if (updatedItem[0] && updatedItem[0].quantity <= updatedItem[0].alert_quantity) {
          await connection.execute(
            'INSERT INTO order_sheet (item_id, required_quantity, current_quantity, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE required_quantity = ?, current_quantity = ?, status = ?',
            [item.item_id, updatedItem[0].alert_quantity, updatedItem[0].quantity, 'pending', updatedItem[0].alert_quantity, updatedItem[0].quantity, 'pending']
          );
        }
      }

      // Update seller party balance
      // Logic: 
      // 1. Subtract the previous balance that was paid (reduces what they owe from old transactions)
      // 2. Add the new balance from this transaction (what they owe from this transaction)
      // Formula: new_balance = old_balance - previous_balance_paid + new_transaction_balance
      await connection.execute(
        'UPDATE seller_parties SET balance_amount = balance_amount - ? + ?, paid_amount = paid_amount + ? WHERE id = ?',
        [previousBalancePaidAmount, newTransactionBalance, finalPaidAmount, seller_party_id]
      );

      await connection.commit();

      // Get complete transaction details
      const [transaction] = await connection.execute(
        `SELECT st.*, sp.party_name, sp.mobile_number, sp.address 
         FROM sale_transactions st 
         JOIN seller_parties sp ON st.seller_party_id = sp.id 
         WHERE st.id = ?`,
        [saleTransactionId]
      );

      const [itemsData] = await connection.execute(
        `SELECT si.*, i.product_name, i.brand, i.hsn_number 
         FROM sale_items si 
         JOIN items i ON si.item_id = i.id 
         WHERE si.sale_transaction_id = ?`,
        [saleTransactionId]
      );

      // Get updated seller party info to return
      const [updatedSeller] = await connection.execute(
        'SELECT * FROM seller_parties WHERE id = ?',
        [seller_party_id]
      );

      res.json({
        message: 'Sale transaction created successfully',
        transaction: {
          ...transaction[0],
          items: itemsData
        },
        seller: updatedSeller[0] || null
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create sale error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Create return transaction (supports both buyer and seller parties, multiple items)
router.post('/return', authenticateToken, async (req, res) => {
  try {
    const { seller_party_id, buyer_party_id, items, reason, party_type, return_type } = req.body;

    // Support both old format (single item) and new format (array of items)
    let itemsArray = [];
    if (items && Array.isArray(items) && items.length > 0) {
      // New format: array of items
      itemsArray = items;
    } else if (req.body.item_id && req.body.quantity) {
      // Old format: single item (backward compatibility)
      itemsArray = [{
        item_id: req.body.item_id,
        quantity: req.body.quantity,
        return_amount: req.body.return_amount || 0
      }];
    } else {
      return res.status(400).json({ error: 'Items array or item_id/quantity is required' });
    }

    // Validate that either seller or buyer party is provided
    if (!seller_party_id && !buyer_party_id) {
      return res.status(400).json({ error: 'Party (buyer or seller) is required' });
    }

    // Determine party type and ID
    const finalPartyType = party_type || (seller_party_id ? 'seller' : 'buyer');
    const finalPartyId = seller_party_id || buyer_party_id;

    if (!finalPartyId) {
      return res.status(400).json({ error: 'Either seller_party_id or buyer_party_id must be provided' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      let totalReturnAmount = 0;
      const itemIdsToCheck = [];

      // Process each item
      for (const itemData of itemsArray) {
        const { item_id, quantity, return_amount } = itemData;

        if (!item_id || !quantity || quantity <= 0) {
          throw new Error('Valid item_id and quantity are required for all items');
        }

        // Get item details
        const [itemDetails] = await connection.execute(
          'SELECT quantity, purchase_rate, sale_rate FROM items WHERE id = ?',
          [item_id]
        );

        if (itemDetails.length === 0) {
          throw new Error(`Item with id ${item_id} not found`);
        }

        const currentQuantity = itemDetails[0].quantity;
        const purchaseRate = itemDetails[0].purchase_rate || 0;
        const saleRate = itemDetails[0].sale_rate || 0;

        // For buyer returns: subtract from stock only (no balance transactions)
        if (finalPartyType === 'buyer') {
          if (currentQuantity < quantity) {
            throw new Error(`Insufficient stock for item ${item_id}. Available: ${currentQuantity}, Requested: ${quantity}`);
          }
          
          // Subtract from stock
          await connection.execute(
            'UPDATE items SET quantity = quantity - ? WHERE id = ?',
            [quantity, item_id]
          );

          // For buyer returns, don't record return_amount (set to 0) - just track the return
          await connection.execute(
            `INSERT INTO return_transactions (seller_party_id, buyer_party_id, party_type, item_id, quantity, return_amount, return_date, reason)
             VALUES (?, ?, ?, ?, ?, 0, CURDATE(), ?)`,
            [
              seller_party_id || null,
              buyer_party_id || null,
              finalPartyType,
              item_id,
              quantity,
              reason || 'Buyer return - stock quantity decreased'
            ]
          );
        } else {
          // For seller returns: add to stock
          await connection.execute(
            'UPDATE items SET quantity = quantity + ? WHERE id = ?',
            [quantity, item_id]
          );

          // Calculate return amount (use provided return_amount or calculate from sale_rate)
          const calculatedReturnAmount = return_amount || (saleRate * quantity);
          totalReturnAmount += calculatedReturnAmount;
          
          await connection.execute(
            `INSERT INTO return_transactions (seller_party_id, buyer_party_id, party_type, item_id, quantity, return_amount, return_date, reason)
             VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?)`,
            [
              seller_party_id || null,
              buyer_party_id || null,
              finalPartyType,
              item_id,
              quantity,
              calculatedReturnAmount,
              reason || 'Return from seller'
            ]
          );
        }

        itemIdsToCheck.push(item_id);
      }

      // Check if quantities are now above alert quantity and remove from order sheet
      for (const itemId of itemIdsToCheck) {
        const [updatedItem] = await connection.execute(
          'SELECT quantity, alert_quantity FROM items WHERE id = ?',
          [itemId]
        );
        
        if (updatedItem[0] && updatedItem[0].quantity > updatedItem[0].alert_quantity) {
          await connection.execute(
            'DELETE FROM order_sheet WHERE item_id = ? AND status = ?',
            [itemId, 'pending']
          );
        }
      }

      // Update party balance only if return_type is 'adjust' (adjust in account) and party is seller
      // This feature is only for sellers, not buyers
      if (return_type === 'adjust' && totalReturnAmount > 0 && finalPartyType === 'seller') {
        // Deduct from seller balance (they're returning items, so we owe them less)
        await connection.execute(
          'UPDATE seller_parties SET balance_amount = balance_amount + ? WHERE id = ?',
          [totalReturnAmount, finalPartyId]
        );
      }

      await connection.commit();
      res.json({ message: 'Return transaction created successfully', items_processed: itemsArray.length });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create return error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Get sale transactions
router.get('/sales', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, seller_party_id } = req.query;
    
    let query = `SELECT st.*, sp.party_name 
                 FROM sale_transactions st 
                 JOIN seller_parties sp ON st.seller_party_id = sp.id 
                 WHERE 1=1`;
    const params = [];

    if (from_date) {
      query += ' AND st.transaction_date >= ?';
      params.push(from_date);
    }
    if (to_date) {
      query += ' AND st.transaction_date <= ?';
      params.push(to_date);
    }
    if (seller_party_id) {
      query += ' AND st.seller_party_id = ?';
      params.push(seller_party_id);
    }

    query += ' ORDER BY st.transaction_date DESC, st.id DESC';

    const [transactions] = await pool.execute(query, params);
    res.json({ transactions });
  } catch (error) {
    console.error('Get sales error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get return transactions (supports both buyer and seller)
router.get('/returns', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, seller_party_id, buyer_party_id, party_type } = req.query;
    
    let query = `SELECT 
      rt.*, 
      COALESCE(sp.party_name, bp.party_name) as party_name,
      rt.party_type,
      i.product_name, 
      i.brand 
    FROM return_transactions rt 
    LEFT JOIN seller_parties sp ON rt.seller_party_id = sp.id 
    LEFT JOIN buyer_parties bp ON rt.buyer_party_id = bp.id
    JOIN items i ON rt.item_id = i.id 
    WHERE 1=1`;
    const params = [];

    if (from_date) {
      query += ' AND rt.return_date >= ?';
      params.push(from_date);
    }
    if (to_date) {
      query += ' AND rt.return_date <= ?';
      params.push(to_date);
    }
    if (seller_party_id) {
      query += ' AND rt.seller_party_id = ?';
      params.push(seller_party_id);
    }
    if (buyer_party_id) {
      query += ' AND rt.buyer_party_id = ?';
      params.push(buyer_party_id);
    }
    if (party_type) {
      query += ' AND rt.party_type = ?';
      params.push(party_type);
    }

    query += ' ORDER BY rt.return_date DESC, rt.id DESC';

    const [transactions] = await pool.execute(query, params);
    res.json({ transactions });
  } catch (error) {
    console.error('Get returns error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single sale transaction with items
router.get('/sales/:id', authenticateToken, async (req, res) => {
  try {
    const [transactions] = await pool.execute(
      `SELECT st.*, sp.party_name, sp.mobile_number, sp.address, sp.email 
       FROM sale_transactions st 
       JOIN seller_parties sp ON st.seller_party_id = sp.id 
       WHERE st.id = ?`,
      [req.params.id]
    );

    if (transactions.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const [items] = await pool.execute(
      `SELECT si.*, i.product_name, i.brand, i.hsn_number 
       FROM sale_items si 
       JOIN items i ON si.item_id = i.id 
       WHERE si.sale_transaction_id = ?`,
      [req.params.id]
    );

    res.json({
      transaction: {
        ...transactions[0],
        items
      }
    });
  } catch (error) {
    console.error('Get sale transaction error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;


