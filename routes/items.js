const express = require('express');
const pool = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const { validateItem } = require('../middleware/validation');

const router = express.Router();

// Get all items with pagination and search
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 200, search = '', searchField = '' } = req.query;
    
    // Ensure page and limit are valid integers
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, Math.min(1000, parseInt(limit) || 200)); // Max 1000 items per page
    const offset = (pageNum - 1) * limitNum;

    let query = 'SELECT * FROM items WHERE 1=1';
    const params = [];

    if (search && searchField) {
      if (searchField === 'product_name') {
        query += ' AND product_name LIKE ?';
        params.push(`%${search}%`);
      } else if (searchField === 'brand') {
        query += ' AND brand LIKE ?';
        params.push(`%${search}%`);
      } else if (searchField === 'product_code') {
        query += ' AND product_code LIKE ?';
        params.push(`%${search}%`);
      }
    }

    // Use template literals for LIMIT/OFFSET since they're validated integers
    // This avoids MySQL parameterization issues with LIMIT/OFFSET
    query += ` ORDER BY id DESC LIMIT ${limitNum} OFFSET ${offset}`;

    const [items] = await pool.execute(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM items WHERE 1=1';
    const countParams = [];
    if (search && searchField) {
      if (searchField === 'product_name') {
        countQuery += ' AND product_name LIKE ?';
        countParams.push(`%${search}%`);
      } else if (searchField === 'brand') {
        countQuery += ' AND brand LIKE ?';
        countParams.push(`%${search}%`);
      } else if (searchField === 'product_code') {
        countQuery += ' AND product_code LIKE ?';
        countParams.push(`%${search}%`);
      }
    }
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get items error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Advanced search with multiple conditions
router.post('/advanced-search', authenticateToken, async (req, res) => {
  try {
    const { product_name, brand, product_code } = req.body;
    
    let query = 'SELECT * FROM items WHERE 1=1';
    const params = [];

    if (product_name) {
      query += ' AND product_name LIKE ?';
      params.push(`%${product_name}%`);
    }
    if (brand) {
      query += ' AND brand LIKE ?';
      params.push(`%${brand}%`);
    }
    if (product_code) {
      query += ' AND product_code LIKE ?';
      params.push(`%${product_code}%`);
    }

    query += ' ORDER BY id DESC';

    const [items] = await pool.execute(query, params);
    res.json({ items });
  } catch (error) {
    console.error('Advanced search error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search items for autocomplete
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }

    const [items] = await pool.execute(
      'SELECT id, product_name, product_code, brand, quantity, sale_rate FROM items WHERE product_name LIKE ? OR product_code LIKE ? LIMIT 10',
      [`%${q}%`, `%${q}%`]
    );

    res.json({ items });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single item
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const [items] = await pool.execute('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json({ item: items[0] });
  } catch (error) {
    console.error('Get item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add new item (only admin and super_admin)
router.post('/', authenticateToken, authorizeRole('admin', 'super_admin'), validateItem, async (req, res) => {
  try {
    const {
      product_name,
      product_code,
      brand,
      hsn_number,
      tax_rate,
      sale_rate,
      purchase_rate,
      alert_quantity,
      rack_number
    } = req.body;

    // Validation
    if (!product_name || product_name.trim() === '') {
      return res.status(400).json({ error: 'Product name is required' });
    }

    if (sale_rate === undefined || sale_rate === null || sale_rate < 0) {
      return res.status(400).json({ error: 'Sale rate is required and must be a positive number' });
    }

    if (purchase_rate === undefined || purchase_rate === null || purchase_rate < 0) {
      return res.status(400).json({ error: 'Purchase rate is required and must be a positive number' });
    }

    const [result] = await pool.execute(
      `INSERT INTO items (product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        product_name.trim(),
        product_code ? product_code.trim() : null,
        brand ? brand.trim() : null,
        hsn_number ? hsn_number.trim() : null,
        tax_rate || 0,
        sale_rate,
        purchase_rate,
        alert_quantity || 0,
        rack_number ? rack_number.trim() : null
      ]
    );

    // Fetch the created item to return complete data
    const [items] = await pool.execute('SELECT * FROM items WHERE id = ?', [result.insertId]);
    
    res.json({ 
      message: 'Item added successfully', 
      id: result.insertId,
      item: items[0]
    });
  } catch (error) {
    console.error('Add item error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Product code already exists. Please use a different product code.' });
    }
    res.status(500).json({ error: 'Server error while adding item' });
  }
});

// Update item (admin and super_admin can update, only super_admin can edit purchase rate)
router.put('/:id', authenticateToken, authorizeRole('admin', 'super_admin'), async (req, res) => {
  try {
    const {
      product_name,
      product_code,
      brand,
      hsn_number,
      tax_rate,
      sale_rate,
      purchase_rate,
      quantity,
      alert_quantity,
      rack_number
    } = req.body;

    // Validation
    if (!product_name || typeof product_name !== 'string' || product_name.trim().length === 0) {
      return res.status(400).json({ error: 'Product name is required and must be a non-empty string' });
    }

    if (product_name.length > 255) {
      return res.status(400).json({ error: 'Product name must be less than 255 characters' });
    }

    if (sale_rate === undefined || sale_rate === null || isNaN(sale_rate) || sale_rate < 0) {
      return res.status(400).json({ error: 'Sale rate is required and must be a positive number' });
    }

    if (quantity === undefined || quantity === null || isNaN(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'Quantity is required and must be 0 or greater' });
    }

    // Check if user is super admin for purchase_rate update
    if (purchase_rate !== undefined && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can update purchase rate' });
    }

    if (purchase_rate !== undefined && req.user.role === 'super_admin' && (isNaN(purchase_rate) || purchase_rate < 0)) {
      return res.status(400).json({ error: 'Purchase rate must be a positive number' });
    }

    // Check if item exists
    const [existingItems] = await pool.execute('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (existingItems.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    let query = `UPDATE items SET 
      product_name = ?, product_code = ?, brand = ?, hsn_number = ?, tax_rate = ?, 
      sale_rate = ?, quantity = ?, alert_quantity = ?, rack_number = ?`;
    const params = [
      product_name.trim(),
      product_code ? product_code.trim() : null,
      brand ? brand.trim() : null,
      hsn_number ? hsn_number.trim() : null,
      tax_rate || 0,
      sale_rate,
      quantity,
      alert_quantity || 0,
      rack_number ? rack_number.trim() : null
    ];

    if (purchase_rate !== undefined && req.user.role === 'super_admin') {
      query += ', purchase_rate = ?';
      params.push(purchase_rate);
    }

    query += ' WHERE id = ?';
    params.push(req.params.id);

    await pool.execute(query, params);
    
    // Check if quantity reached alert quantity and update order sheet
    if (quantity <= (alert_quantity || existingItems[0].alert_quantity)) {
      await pool.execute(
        'INSERT INTO order_sheet (item_id, required_quantity, current_quantity, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE required_quantity = ?, current_quantity = ?, status = ?',
        [req.params.id, alert_quantity || existingItems[0].alert_quantity, quantity, 'pending', alert_quantity || existingItems[0].alert_quantity, quantity, 'pending']
      );
    } else {
      // Remove from order sheet if quantity is above alert
      await pool.execute(
        'UPDATE order_sheet SET status = ? WHERE item_id = ? AND status = ?',
        ['completed', req.params.id, 'pending']
      );
    }
    
    // Fetch updated item
    const [updatedItems] = await pool.execute('SELECT * FROM items WHERE id = ?', [req.params.id]);
    
    res.json({ 
      message: 'Item updated successfully',
      item: updatedItems[0]
    });
  } catch (error) {
    console.error('Update item error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Product code already exists. Please use a different product code.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete item (only super admin)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can delete items' });
    }

    await pool.execute('DELETE FROM items WHERE id = ?', [req.params.id]);
    res.json({ message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add items in bulk (purchase) - only admin and super_admin
router.post('/purchase', authenticateToken, authorizeRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { buyer_party_id, items } = req.body;

    if (!buyer_party_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Buyer party and items are required' });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      for (const item of items) {
        const { item_id, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number } = item;

        if (item_id) {
          // Update existing item
          await connection.execute(
            'UPDATE items SET quantity = quantity + ?, product_code = ?, brand = ?, hsn_number = ?, tax_rate = ?, sale_rate = ?, purchase_rate = ?, alert_quantity = ?, rack_number = ? WHERE id = ?',
            [quantity, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, alert_quantity, rack_number, item_id]
          );

          // Record purchase transaction
          await connection.execute(
            'INSERT INTO purchase_transactions (buyer_party_id, item_id, quantity, purchase_rate, total_amount, transaction_date) VALUES (?, ?, ?, ?, ?, CURDATE())',
            [buyer_party_id, item_id, quantity, purchase_rate, purchase_rate * quantity]
          );
        } else {
          // Create new item
          const [result] = await connection.execute(
            'INSERT INTO items (product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [item.product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number]
          );

          // Record purchase transaction
          await connection.execute(
            'INSERT INTO purchase_transactions (buyer_party_id, item_id, quantity, purchase_rate, total_amount, transaction_date) VALUES (?, ?, ?, ?, ?, CURDATE())',
            [buyer_party_id, result.insertId, quantity, purchase_rate, purchase_rate * quantity]
          );
        }

        // Check if quantity reached alert quantity
        const [itemData] = await connection.execute('SELECT quantity, alert_quantity FROM items WHERE id = ?', [item_id || result.insertId]);
        if (itemData[0] && itemData[0].quantity <= itemData[0].alert_quantity) {
          await connection.execute(
            'INSERT INTO order_sheet (item_id, required_quantity, current_quantity, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE required_quantity = ?, current_quantity = ?, status = ?',
            [item_id || result.insertId, itemData[0].alert_quantity, itemData[0].quantity, 'pending', itemData[0].alert_quantity, itemData[0].quantity, 'pending']
          );
        }
      }

      await connection.commit();
      res.json({ message: 'Items added successfully' });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Purchase items error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;


