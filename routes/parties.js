const express = require('express');
const pool = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const { validateParty } = require('../middleware/validation');

const router = express.Router();

// Helper function to check for duplicate mobile/email
async function checkDuplicateMobileEmail(table, mobile_number, email, excludeId = null) {
  const conditions = [];
  const params = [];
  
  if (mobile_number && mobile_number.trim() !== '') {
    conditions.push('mobile_number = ?');
    params.push(mobile_number.trim());
  }
  
  if (email && email.trim() !== '') {
    conditions.push('email = ?');
    params.push(email.trim().toLowerCase());
  }
  
  if (conditions.length === 0) {
    return { mobileExists: false, emailExists: false };
  }
  
  let query = `SELECT id, mobile_number, email FROM ${table} WHERE (${conditions.join(' OR ')})`;
  
  if (excludeId) {
    query += ' AND id != ?';
    params.push(parseInt(excludeId));
  }
  
  const [results] = await pool.execute(query, params);
  
  const mobileExists = results.some(r => r.mobile_number && r.mobile_number === mobile_number?.trim());
  const emailExists = results.some(r => r.email && r.email.toLowerCase() === email?.trim().toLowerCase());
  
  return { mobileExists, emailExists };
}

// Get all buyer parties
router.get('/buyers', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset = (pageNum - 1) * limitNum;

    // Get total count
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM buyer_parties');
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limitNum);

    // Get paginated data
    // Note: LIMIT and OFFSET cannot use placeholders in prepared statements, so we use template literals
    const [parties] = await pool.execute(
      `SELECT * FROM buyer_parties ORDER BY party_name LIMIT ${limitNum} OFFSET ${offset}`
    );
    
    res.json({ 
      parties,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages
      }
    });
  } catch (error) {
    console.error('Get buyer parties error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get retail buyer party (default for quick sale)
router.get('/buyers/retail', authenticateToken, async (req, res) => {
  try {
    const [parties] = await pool.execute(
      "SELECT * FROM buyer_parties WHERE party_name = 'Retail Buyer' LIMIT 1"
    );
    if (parties.length === 0) {
      return res.status(404).json({ error: 'Retail Buyer party not found. Please create it first.' });
    }
    res.json({ party: parties[0] });
  } catch (error) {
    console.error('Get retail buyer error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get retail seller party (for quick sale)
router.get('/sellers/retail', authenticateToken, async (req, res) => {
  try {
    const [parties] = await pool.execute(
      "SELECT * FROM seller_parties WHERE party_name = 'Retail Seller' LIMIT 1"
    );
    if (parties.length === 0) {
      return res.status(404).json({ error: 'Retail Seller party not found. Please create it first.' });
    }
    res.json({ party: parties[0] });
  } catch (error) {
    console.error('Get retail seller error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single buyer party
router.get('/buyers/:id', authenticateToken, async (req, res) => {
  try {
    const [parties] = await pool.execute('SELECT * FROM buyer_parties WHERE id = ?', [req.params.id]);
    if (parties.length === 0) {
      return res.status(404).json({ error: 'Buyer party not found' });
    }
    res.json({ party: parties[0] });
  } catch (error) {
    console.error('Get buyer party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add buyer party (only admin and super_admin)
router.post('/buyers', authenticateToken, authorizeRole('admin', 'super_admin'), validateParty, async (req, res) => {
  try {
    const {
      party_name,
      mobile_number,
      email,
      address,
      opening_balance,
      closing_balance,
      gst_number
    } = req.body;

    // Validate GST number (alphanumeric, max 20 chars)
    if (gst_number && (gst_number.length > 20 || !/^[A-Za-z0-9]+$/.test(gst_number))) {
      return res.status(400).json({ error: 'GST number must be alphanumeric and maximum 20 characters' });
    }

    // Check for duplicate mobile number and email
    const { mobileExists, emailExists } = await checkDuplicateMobileEmail('buyer_parties', mobile_number, email);
    if (mobileExists) {
      return res.status(400).json({ error: 'Mobile number already exists' });
    }
    if (emailExists) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const [result] = await pool.execute(
      `INSERT INTO buyer_parties (party_name, mobile_number, email, address, opening_balance, closing_balance, balance_amount, gst_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [party_name, mobile_number || null, email ? email.toLowerCase() : null, address, opening_balance || 0, closing_balance || 0, opening_balance || 0, gst_number || null]
    );

    res.json({ message: 'Buyer party added successfully', id: result.insertId });
  } catch (error) {
    console.error('Add buyer party error:', error);
    // Handle MySQL duplicate entry error
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.sqlMessage.includes('mobile_number')) {
        return res.status(400).json({ error: 'Mobile number already exists' });
      }
      if (error.sqlMessage.includes('email')) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      return res.status(400).json({ error: 'Duplicate entry detected' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Update buyer party
router.put('/buyers/:id', authenticateToken, async (req, res) => {
  try {
    const {
      party_name,
      mobile_number,
      email,
      address,
      opening_balance,
      closing_balance,
      gst_number
    } = req.body;

    // Validate GST number (alphanumeric, max 20 chars)
    if (gst_number && (gst_number.length > 20 || !/^[A-Za-z0-9]+$/.test(gst_number))) {
      return res.status(400).json({ error: 'GST number must be alphanumeric and maximum 20 characters' });
    }

    // Check for duplicate mobile number and email (exclude current party)
    const { mobileExists, emailExists } = await checkDuplicateMobileEmail('buyer_parties', mobile_number, email, req.params.id);
    if (mobileExists) {
      return res.status(400).json({ error: 'Mobile number already exists' });
    }
    if (emailExists) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    await pool.execute(
      `UPDATE buyer_parties SET party_name = ?, mobile_number = ?, email = ?, address = ?, opening_balance = ?, closing_balance = ?, gst_number = ?
       WHERE id = ?`,
      [party_name, mobile_number || null, email ? email.toLowerCase() : null, address, opening_balance, closing_balance, gst_number || null, req.params.id]
    );

    res.json({ message: 'Buyer party updated successfully' });
  } catch (error) {
    console.error('Update buyer party error:', error);
    // Handle MySQL duplicate entry error
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.sqlMessage.includes('mobile_number')) {
        return res.status(400).json({ error: 'Mobile number already exists' });
      }
      if (error.sqlMessage.includes('email')) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      return res.status(400).json({ error: 'Duplicate entry detected' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all seller parties
router.get('/sellers', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const offset = (pageNum - 1) * limitNum;

    // Get total count
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM seller_parties');
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limitNum);

    // Get paginated data
    // Note: LIMIT and OFFSET cannot use placeholders in prepared statements, so we use template literals
    const [parties] = await pool.execute(
      `SELECT * FROM seller_parties ORDER BY party_name LIMIT ${limitNum} OFFSET ${offset}`
    );
    
    res.json({ 
      parties,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalRecords,
        totalPages
      }
    });
  } catch (error) {
    console.error('Get seller parties error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single seller party
router.get('/sellers/:id', authenticateToken, async (req, res) => {
  try {
    const [parties] = await pool.execute('SELECT * FROM seller_parties WHERE id = ?', [req.params.id]);
    if (parties.length === 0) {
      return res.status(404).json({ error: 'Seller party not found' });
    }
    res.json({ party: parties[0] });
  } catch (error) {
    console.error('Get seller party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add seller party (only admin and super_admin)
router.post('/sellers', authenticateToken, authorizeRole('admin', 'super_admin'), validateParty, async (req, res) => {
  try {
    const {
      party_name,
      mobile_number,
      email,
      address,
      opening_balance,
      closing_balance,
      gst_number
    } = req.body;

    // Validate GST number (alphanumeric, max 20 chars)
    if (gst_number && (gst_number.length > 20 || !/^[A-Za-z0-9]+$/.test(gst_number))) {
      return res.status(400).json({ error: 'GST number must be alphanumeric and maximum 20 characters' });
    }

    // Check for duplicate mobile number and email
    const { mobileExists, emailExists } = await checkDuplicateMobileEmail('seller_parties', mobile_number, email);
    if (mobileExists) {
      return res.status(400).json({ error: 'Mobile number already exists' });
    }
    if (emailExists) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const [result] = await pool.execute(
      `INSERT INTO seller_parties (party_name, mobile_number, email, address, opening_balance, closing_balance, balance_amount, gst_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [party_name, mobile_number || null, email ? email.toLowerCase() : null, address, opening_balance || 0, closing_balance || 0, opening_balance || 0, gst_number || null]
    );

    res.json({ message: 'Seller party added successfully', id: result.insertId });
  } catch (error) {
    console.error('Add seller party error:', error);
    // Handle MySQL duplicate entry error
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.sqlMessage.includes('mobile_number')) {
        return res.status(400).json({ error: 'Mobile number already exists' });
      }
      if (error.sqlMessage.includes('email')) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      return res.status(400).json({ error: 'Duplicate entry detected' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Update seller party
router.put('/sellers/:id', authenticateToken, async (req, res) => {
  try {
    const {
      party_name,
      mobile_number,
      email,
      address,
      opening_balance,
      closing_balance,
      gst_number
    } = req.body;

    // Validate GST number (alphanumeric, max 20 chars)
    if (gst_number && (gst_number.length > 20 || !/^[A-Za-z0-9]+$/.test(gst_number))) {
      return res.status(400).json({ error: 'GST number must be alphanumeric and maximum 20 characters' });
    }

    // Check for duplicate mobile number and email (exclude current party)
    const { mobileExists, emailExists } = await checkDuplicateMobileEmail('seller_parties', mobile_number, email, req.params.id);
    if (mobileExists) {
      return res.status(400).json({ error: 'Mobile number already exists' });
    }
    if (emailExists) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    await pool.execute(
      `UPDATE seller_parties SET party_name = ?, mobile_number = ?, email = ?, address = ?, opening_balance = ?, closing_balance = ?, gst_number = ?
       WHERE id = ?`,
      [party_name, mobile_number || null, email ? email.toLowerCase() : null, address, opening_balance, closing_balance, gst_number || null, req.params.id]
    );

    res.json({ message: 'Seller party updated successfully' });
  } catch (error) {
    console.error('Update seller party error:', error);
    // Handle MySQL duplicate entry error
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.sqlMessage.includes('mobile_number')) {
        return res.status(400).json({ error: 'Mobile number already exists' });
      }
      if (error.sqlMessage.includes('email')) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      return res.status(400).json({ error: 'Duplicate entry detected' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;


