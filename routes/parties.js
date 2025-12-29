const express = require('express');
const pool = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const { validateParty } = require('../middleware/validation');

const router = express.Router();

// Get all buyer parties
router.get('/buyers', authenticateToken, async (req, res) => {
  try {
    const [parties] = await pool.execute('SELECT * FROM buyer_parties ORDER BY party_name');
    res.json({ parties });
  } catch (error) {
    console.error('Get buyer parties error:', error);
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
      closing_balance
    } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO buyer_parties (party_name, mobile_number, email, address, opening_balance, closing_balance, balance_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [party_name, mobile_number, email, address, opening_balance || 0, closing_balance || 0, opening_balance || 0]
    );

    res.json({ message: 'Buyer party added successfully', id: result.insertId });
  } catch (error) {
    console.error('Add buyer party error:', error);
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
      closing_balance
    } = req.body;

    await pool.execute(
      `UPDATE buyer_parties SET party_name = ?, mobile_number = ?, email = ?, address = ?, opening_balance = ?, closing_balance = ?
       WHERE id = ?`,
      [party_name, mobile_number, email, address, opening_balance, closing_balance, req.params.id]
    );

    res.json({ message: 'Buyer party updated successfully' });
  } catch (error) {
    console.error('Update buyer party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all seller parties
router.get('/sellers', authenticateToken, async (req, res) => {
  try {
    const [parties] = await pool.execute('SELECT * FROM seller_parties ORDER BY party_name');
    res.json({ parties });
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
      closing_balance
    } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO seller_parties (party_name, mobile_number, email, address, opening_balance, closing_balance, balance_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [party_name, mobile_number, email, address, opening_balance || 0, closing_balance || 0, opening_balance || 0]
    );

    res.json({ message: 'Seller party added successfully', id: result.insertId });
  } catch (error) {
    console.error('Add seller party error:', error);
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
      closing_balance
    } = req.body;

    await pool.execute(
      `UPDATE seller_parties SET party_name = ?, mobile_number = ?, email = ?, address = ?, opening_balance = ?, closing_balance = ?
       WHERE id = ?`,
      [party_name, mobile_number, email, address, opening_balance, closing_balance, req.params.id]
    );

    res.json({ message: 'Seller party updated successfully' });
  } catch (error) {
    console.error('Update seller party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;


