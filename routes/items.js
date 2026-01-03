const express = require('express');
const multer = require('multer');
const pool = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const { validateItem } = require('../middleware/validation');

const router = express.Router();

// Configure multer for image uploads (3MB limit)
const upload = multer({
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  storage: multer.memoryStorage()
});

// Get all items with pagination and search
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 200, search = '', searchField = '' } = req.query;
    
    // Ensure page and limit are valid integers
    const pageNum = Math.max(1, parseInt(page) || 1);
    let limitNum;
    if (limit === 'all') {
      limitNum = 999999; // Very large number for "all"
    } else {
      limitNum = Math.max(1, Math.min(10000, parseInt(limit) || 200));
    }
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
      } else if (searchField === 'remarks') {
        query += ' AND remarks LIKE ?';
        params.push(`%${search}%`);
      }
    }

    // Use template literals for LIMIT/OFFSET since they're validated integers
    // This avoids MySQL parameterization issues with LIMIT/OFFSET
    query += ` ORDER BY id DESC LIMIT ${limitNum} OFFSET ${offset}`;

    const [items] = await pool.execute(query, params);

    // Remove image blob and purchase_rate based on role
    const processedItems = items.map(item => {
      const processed = { ...item };
      // Remove image blob (too large for list)
      delete processed.image;
      // Remove purchase_rate if not super admin
      if (req.user.role !== 'super_admin') {
        delete processed.purchase_rate;
      }
      return processed;
    });

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
      } else if (searchField === 'remarks') {
        countQuery += ' AND remarks LIKE ?';
        countParams.push(`%${search}%`);
      }
    }
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      items: processedItems,
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
    const { product_name, brand, product_code, remarks } = req.body;
    
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
    if (remarks) {
      query += ' AND remarks LIKE ?';
      params.push(`%${remarks}%`);
    }

    query += ' ORDER BY id DESC';

    const [items] = await pool.execute(query, params);
    
    // Remove image blob and purchase_rate based on role
    const processedItems = items.map(item => {
      const processed = { ...item };
      delete processed.image;
      if (req.user.role !== 'super_admin') {
        delete processed.purchase_rate;
      }
      return processed;
    });
    
    res.json({ items: processedItems });
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
      'SELECT id, product_name, product_code, brand, quantity, sale_rate FROM items WHERE product_name LIKE ? OR product_code LIKE ? OR brand LIKE ? OR remarks LIKE ? LIMIT 10',
      [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]
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
    const [items] = await pool.execute(
      `SELECT i.*, 
       u1.user_id as created_by_user, 
       u2.user_id as updated_by_user
       FROM items i
       LEFT JOIN users u1 ON i.created_by = u1.user_id
       LEFT JOIN users u2 ON i.updated_by = u2.user_id
       WHERE i.id = ?`,
      [req.params.id]
    );
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const item = items[0];
    // Convert image blob to base64 if exists
    if (item.image) {
      item.image_base64 = item.image.toString('base64');
      delete item.image; // Remove blob from response
    }
    // Format timestamps
    if (item.created_at) {
      item.created_at_formatted = new Date(item.created_at).toLocaleString();
    }
    if (item.updated_at) {
      item.updated_at_formatted = new Date(item.updated_at).toLocaleString();
    }
    res.json({ item });
  } catch (error) {
    console.error('Get item error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper function to check for duplicates
async function checkDuplicate(product_name, product_code, brand, excludeId = null) {
  let query = `SELECT id FROM items WHERE (
    (product_name = ? AND product_code = ? AND brand = ?) OR
    (product_name = ? AND product_code = ? AND brand IS NULL AND ? IS NULL) OR
    (product_name = ? AND product_code IS NULL AND ? IS NULL AND brand = ?) OR
    (product_name = ? AND product_code IS NULL AND ? IS NULL AND brand IS NULL AND ? IS NULL)
  )`;
  const params = [
    product_name, product_code, brand,
    product_name, product_code, brand,
    product_name, product_code, brand,
    product_name, product_code, brand
  ];
  
  if (excludeId) {
    query += ' AND id != ?';
    params.push(parseInt(excludeId)); // Ensure it's an integer
  }
  
  const [duplicates] = await pool.execute(query, params);
  return duplicates.length > 0;
}

// Helper function to save item history
async function saveItemHistory(itemId, itemData, actionType, userId) {
  try {
    await pool.execute(
      `INSERT INTO items_history 
      (item_id, product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, 
       quantity, alert_quantity, rack_number, remarks, action_type, changed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        itemId,
        itemData.product_name,
        itemData.product_code || null,
        itemData.brand || null,
        itemData.hsn_number || null,
        itemData.tax_rate || 0,
        itemData.sale_rate,
        itemData.purchase_rate,
        itemData.quantity || 0,
        itemData.alert_quantity || 0,
        itemData.rack_number || null,
        itemData.remarks || null,
        actionType,
        userId
      ]
    );
  } catch (error) {
    console.error('Error saving item history:', error);
    // Don't throw - history is not critical
  }
}

// Add new item (only admin and super_admin)
router.post('/', authenticateToken, authorizeRole('admin', 'super_admin'), upload.single('image'), async (req, res) => {
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
      rack_number,
      remarks
    } = req.body;

    // Parse tax_rate to ensure it's a number (FormData sends strings)
    const parsedTaxRate = tax_rate !== undefined && tax_rate !== null && tax_rate !== '' 
      ? parseFloat(tax_rate) 
      : 18;
    const validTaxRates = [5, 18, 28];
    const finalTaxRate = !isNaN(parsedTaxRate) && validTaxRates.includes(parsedTaxRate) 
      ? parsedTaxRate 
      : 18;
    
    // Debug log to verify tax_rate is being received correctly
    console.log('Received tax_rate:', tax_rate, 'Parsed:', parsedTaxRate, 'Final:', finalTaxRate);

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

    // Validate sale_rate >= purchase_rate
    const saleRateNum = parseFloat(sale_rate);
    const purchaseRateNum = parseFloat(purchase_rate);
    if (saleRateNum < purchaseRateNum) {
      return res.status(400).json({ error: 'Sale rate must be greater than or equal to purchase rate' });
    }

    // Validate remarks length
    if (remarks && remarks.length > 200) {
      return res.status(400).json({ error: 'Remarks must be 200 characters or less' });
    }

    // Check for duplicates (Product Name, Product Code, Brand combination)
    const isDuplicate = await checkDuplicate(
      product_name.trim(),
      product_code ? product_code.trim() : null,
      brand ? brand.trim() : null
    );
    
    if (isDuplicate) {
      return res.status(400).json({ 
        error: 'A product with the same Product Name, Product Code, and Brand already exists' 
      });
    }

    // Handle image upload
    let imageBuffer = null;
    if (req.file) {
      if (req.file.size > 3 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image size must be less than 3MB' });
      }
      imageBuffer = req.file.buffer;
    }

    const userId = req.user.user_id;

    const [result] = await pool.execute(
      `INSERT INTO items (product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, 
       quantity, alert_quantity, rack_number, remarks, image, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        product_name.trim(),
        product_code ? product_code.trim() : null,
        brand ? brand.trim() : null,
        hsn_number ? hsn_number.trim() : null,
        finalTaxRate,
        sale_rate,
        purchase_rate,
        alert_quantity || 0,
        rack_number ? rack_number.trim() : null,
        remarks ? remarks.trim().substring(0, 200) : null,
        imageBuffer,
        userId
      ]
    );

    // Fetch the created item to return complete data
    const [items] = await pool.execute('SELECT * FROM items WHERE id = ?', [result.insertId]);
    const newItem = items[0];
    
    // Save history
    await saveItemHistory(result.insertId, newItem, 'created', userId);
    
    // Remove image blob from response
    if (newItem.image) {
      newItem.image_base64 = newItem.image.toString('base64');
      delete newItem.image;
    }
    
    res.json({ 
      message: 'Item added successfully', 
      id: result.insertId,
      item: newItem
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
router.put('/:id', authenticateToken, authorizeRole('admin', 'super_admin'), upload.single('image'), async (req, res) => {
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
      rack_number,
      remarks
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

    // Validate sale_rate >= purchase_rate
    // Get current purchase_rate if not being updated
    let currentPurchaseRate = purchase_rate;
    if (currentPurchaseRate === undefined && req.user.role !== 'super_admin') {
      // If not super admin and purchase_rate not provided, get from existing item
      const [existingItems] = await pool.execute('SELECT purchase_rate FROM items WHERE id = ?', [req.params.id]);
      if (existingItems.length > 0) {
        currentPurchaseRate = existingItems[0].purchase_rate;
      }
    }
    
    if (currentPurchaseRate !== undefined && !isNaN(currentPurchaseRate)) {
      const saleRateNum = parseFloat(sale_rate);
      const purchaseRateNum = parseFloat(currentPurchaseRate);
      if (saleRateNum < purchaseRateNum) {
        return res.status(400).json({ error: 'Sale rate must be greater than or equal to purchase rate' });
      }
    }

    // Validate remarks length
    if (remarks && remarks.length > 200) {
      return res.status(400).json({ error: 'Remarks must be 200 characters or less' });
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

    // Check for duplicates (Product Name, Product Code, Brand combination) - exclude current item
    const isDuplicate = await checkDuplicate(
      product_name.trim(),
      product_code ? product_code.trim() : null,
      brand ? brand.trim() : null,
      req.params.id
    );
    
    if (isDuplicate) {
      return res.status(400).json({ 
        error: 'A product with the same Product Name, Product Code, and Brand already exists' 
      });
    }

    // Handle image upload
    let imageUpdate = '';
    const params = [
      product_name.trim(),
      product_code ? product_code.trim() : null,
      brand ? brand.trim() : null,
      hsn_number ? hsn_number.trim() : null,
      tax_rate || 0,
      sale_rate,
      quantity,
      alert_quantity || 0,
      rack_number ? rack_number.trim() : null,
      remarks ? remarks.trim().substring(0, 200) : null
    ];

    if (req.file) {
      if (req.file.size > 3 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image size must be less than 3MB' });
      }
      imageUpdate = ', image = ?';
      params.push(req.file.buffer);
    }

    let query = `UPDATE items SET 
      product_name = ?, product_code = ?, brand = ?, hsn_number = ?, tax_rate = ?, 
      sale_rate = ?, quantity = ?, alert_quantity = ?, rack_number = ?, remarks = ?, updated_by = ?${imageUpdate}`;
    
    params.push(req.user.user_id);

    if (purchase_rate !== undefined && req.user.role === 'super_admin') {
      query += ', purchase_rate = ?';
      params.push(purchase_rate);
    }

    query += ' WHERE id = ?';
    params.push(req.params.id);

    await pool.execute(query, params);
    
    // Check if quantity reached alert quantity and update order sheet
    const finalAlertQty = alert_quantity !== undefined ? alert_quantity : existingItems[0].alert_quantity;
    if (quantity <= finalAlertQty) {
      // Calculate required quantity (alert_quantity - current_quantity, minimum 1)
      const requiredQty = Math.max(1, finalAlertQty - quantity);
      await pool.execute(
        'INSERT INTO order_sheet (item_id, required_quantity, current_quantity, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE required_quantity = ?, current_quantity = ?, status = ?',
        [req.params.id, requiredQty, quantity, 'pending', requiredQty, quantity, 'pending']
      );
    } else {
      // Remove from order sheet if quantity is above alert
      await pool.execute(
        'DELETE FROM order_sheet WHERE item_id = ? AND status = ?',
        [req.params.id, 'pending']
      );
    }
    
    // Fetch updated item
    const [updatedItems] = await pool.execute('SELECT * FROM items WHERE id = ?', [req.params.id]);
    const updatedItem = updatedItems[0];
    
    // Save history
    await saveItemHistory(req.params.id, updatedItem, 'updated', req.user.user_id);
    
    // Remove image blob from response
    if (updatedItem.image) {
      updatedItem.image_base64 = updatedItem.image.toString('base64');
      delete updatedItem.image;
    }
    
    res.json({ 
      message: 'Item updated successfully',
      item: updatedItem
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

    // Get item data before deletion for history
    const [items] = await pool.execute('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Save history before deletion
    await saveItemHistory(req.params.id, items[0], 'deleted', req.user.user_id);

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
        const { item_id, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number, remarks } = item;

        // Validate sale_rate >= purchase_rate
        const saleRateNum = parseFloat(sale_rate);
        const purchaseRateNum = parseFloat(purchase_rate);
        if (isNaN(saleRateNum) || isNaN(purchaseRateNum) || saleRateNum < purchaseRateNum) {
          await connection.rollback();
          return res.status(400).json({ error: `Sale rate must be greater than or equal to purchase rate for item: ${item.product_name || 'Unknown'}` });
        }

        if (item_id) {
          // Update existing item
          await connection.execute(
            'UPDATE items SET quantity = quantity + ?, product_code = ?, brand = ?, hsn_number = ?, tax_rate = ?, sale_rate = ?, purchase_rate = ?, alert_quantity = ?, rack_number = ?, remarks = ? WHERE id = ?',
            [quantity, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, alert_quantity, rack_number, remarks || null, item_id]
          );

          // Record purchase transaction
          await connection.execute(
            'INSERT INTO purchase_transactions (buyer_party_id, item_id, quantity, purchase_rate, total_amount, transaction_date) VALUES (?, ?, ?, ?, ?, CURDATE())',
            [buyer_party_id, item_id, quantity, purchase_rate, purchase_rate * quantity]
          );
        } else {
          // Create new item
          const [result] = await connection.execute(
            'INSERT INTO items (product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [item.product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number, remarks || null]
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

// Get total stock amount (sum of purchase_rate * quantity) - super admin only
router.get('/stock/total-amount', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can view total stock amount' });
    }

    const [result] = await pool.execute(
      'SELECT SUM(purchase_rate * quantity) as total_stock_amount FROM items'
    );

    res.json({ 
      total_stock_amount: result[0].total_stock_amount || 0 
    });
  } catch (error) {
    console.error('Get total stock amount error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;


