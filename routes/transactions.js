const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { validateTransaction } = require('../middleware/validation');

const router = express.Router();

// Create sale transaction
router.post('/sale', authenticateToken, validateTransaction, async (req, res) => {
  try {
    const { seller_party_id, items, payment_status, paid_amount } = req.body;

    if (!seller_party_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Seller party and items are required' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      let totalAmount = 0;
      const saleItems = [];

      // Calculate total and validate items
      for (const item of items) {
        const [itemData] = await connection.execute('SELECT * FROM items WHERE id = ?', [item.item_id]);
        if (itemData.length === 0) {
          throw new Error(`Item with id ${item.item_id} not found`);
        }
        if (itemData[0].quantity < item.quantity) {
          throw new Error(`Insufficient stock for item ${itemData[0].product_name}`);
        }

        const itemTotal = item.quantity * item.sale_rate;
        totalAmount += itemTotal;
        saleItems.push({ ...item, itemTotal });
      }

      // Generate bill number
      const [billCount] = await connection.execute('SELECT COUNT(*) as count FROM sale_transactions');
      const billNumber = `BILL-${Date.now()}-${billCount[0].count + 1}`;

      // Calculate balance
      const finalPaidAmount = payment_status === 'fully_paid' ? totalAmount : (paid_amount || 0);
      const balanceAmount = totalAmount - finalPaidAmount;

      // Create sale transaction
      const [saleResult] = await connection.execute(
        `INSERT INTO sale_transactions (seller_party_id, transaction_date, total_amount, paid_amount, balance_amount, payment_status, bill_number)
         VALUES (?, CURDATE(), ?, ?, ?, ?, ?)`,
        [seller_party_id, totalAmount, finalPaidAmount, balanceAmount, payment_status, billNumber]
      );

      const saleTransactionId = saleResult.insertId;

      // Create sale items and update stock
      for (const item of saleItems) {
        await connection.execute(
          'INSERT INTO sale_items (sale_transaction_id, item_id, quantity, sale_rate, total_amount) VALUES (?, ?, ?, ?, ?)',
          [saleTransactionId, item.item_id, item.quantity, item.sale_rate, item.itemTotal]
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
      await connection.execute(
        'UPDATE seller_parties SET balance_amount = balance_amount + ?, paid_amount = paid_amount + ? WHERE id = ?',
        [balanceAmount, finalPaidAmount, seller_party_id]
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

      res.json({
        message: 'Sale transaction created successfully',
        transaction: {
          ...transaction[0],
          items: itemsData
        }
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

// Create return transaction
router.post('/return', authenticateToken, async (req, res) => {
  try {
    const { seller_party_id, item_id, quantity, return_amount, reason } = req.body;

    if (!seller_party_id || !item_id || !quantity) {
      return res.status(400).json({ error: 'Seller party, item, and quantity are required' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // Create return transaction
      await connection.execute(
        `INSERT INTO return_transactions (seller_party_id, item_id, quantity, return_amount, return_date, reason)
         VALUES (?, ?, ?, ?, CURDATE(), ?)`,
        [seller_party_id, item_id, quantity, return_amount || 0, reason]
      );

      // Update item quantity (add back to stock)
      await connection.execute(
        'UPDATE items SET quantity = quantity + ? WHERE id = ?',
        [quantity, item_id]
      );

      // Check if quantity is now above alert quantity and remove from order sheet
      const [updatedItem] = await connection.execute(
        'SELECT quantity, alert_quantity FROM items WHERE id = ?',
        [item_id]
      );
      
      if (updatedItem[0] && updatedItem[0].quantity > updatedItem[0].alert_quantity) {
        // Remove from order sheet if quantity is above alert
        await connection.execute(
          'UPDATE order_sheet SET status = ? WHERE item_id = ? AND status = ?',
          ['completed', item_id, 'pending']
        );
      }

      // Update seller party balance if return amount is provided
      if (return_amount) {
        await connection.execute(
          'UPDATE seller_parties SET balance_amount = balance_amount - ? WHERE id = ?',
          [return_amount, seller_party_id]
        );
      }

      await connection.commit();
      res.json({ message: 'Return transaction created successfully' });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create return error:', error);
    res.status(500).json({ error: 'Server error' });
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

// Get return transactions
router.get('/returns', authenticateToken, async (req, res) => {
  try {
    const { from_date, to_date, seller_party_id } = req.query;
    
    let query = `SELECT rt.*, sp.party_name, i.product_name, i.brand 
                 FROM return_transactions rt 
                 JOIN seller_parties sp ON rt.seller_party_id = sp.id 
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


