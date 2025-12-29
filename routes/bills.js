const express = require('express');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { generateBillPDF } = require('../utils/pdfGenerator');

const router = express.Router();

// Get bill PDF
router.get('/:id/pdf', authenticateToken, async (req, res) => {
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

    if (items.length === 0) {
      return res.status(404).json({ error: 'No items found for this transaction' });
    }

    generateBillPDF(transactions[0], items, res);
  } catch (error) {
    console.error('Generate PDF error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error: ' + error.message });
    }
  }
});

module.exports = router;




