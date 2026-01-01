const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get order sheet items
router.get('/', authenticateToken, async (req, res) => {
  try {
    // First, update order sheet based on current item quantities and alert quantities
    await pool.execute(
      `UPDATE order_sheet os
       INNER JOIN items i ON os.item_id = i.id
       SET os.current_quantity = i.quantity,
           os.required_quantity = GREATEST(1, i.alert_quantity - i.quantity)
       WHERE os.status = 'pending' AND i.quantity <= i.alert_quantity`
    );
    
    // Remove items from order sheet if quantity is now above alert
    await pool.execute(
      `DELETE os FROM order_sheet os
       INNER JOIN items i ON os.item_id = i.id
       WHERE os.status = 'pending' AND i.quantity > i.alert_quantity`
    );
    
    // Also automatically add items to order sheet if they meet the criteria
    await pool.execute(
      `INSERT INTO order_sheet (item_id, required_quantity, current_quantity, status)
       SELECT i.id, GREATEST(1, i.alert_quantity - i.quantity), i.quantity, 'pending'
       FROM items i
       WHERE i.quantity <= i.alert_quantity 
         AND i.alert_quantity > 0
         AND NOT EXISTS (
           SELECT 1 FROM order_sheet os WHERE os.item_id = i.id AND os.status = 'pending'
         )`
    );

    const [orders] = await pool.execute(
      `SELECT os.*, i.product_name, i.brand, i.product_code, i.rack_number, i.sale_rate
       FROM order_sheet os
       JOIN items i ON os.item_id = i.id
       WHERE os.status = 'pending'
       ORDER BY os.created_at DESC`
    );

    res.json({ orders });
  } catch (error) {
    console.error('Get order sheet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark order as completed (delete from order_sheet)
router.put('/:id/complete', authenticateToken, async (req, res) => {
  try {
    // Delete the order from order_sheet instead of just marking as completed
    await pool.execute(
      'DELETE FROM order_sheet WHERE id = ?',
      [req.params.id]
    );

    res.json({ message: 'Order marked as completed and removed from order sheet' });
  } catch (error) {
    console.error('Complete order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export order sheet to Excel
router.get('/export', authenticateToken, async (req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT os.*, i.product_name, i.brand, i.product_code, i.rack_number, i.sale_rate
       FROM order_sheet os
       JOIN items i ON os.item_id = i.id
       WHERE os.status = 'pending'
       ORDER BY os.created_at DESC`
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Order Sheet');

    worksheet.columns = [
      { header: 'Product Name', key: 'product_name', width: 30 },
      { header: 'Product Code', key: 'product_code', width: 20 },
      { header: 'Brand', key: 'brand', width: 20 },
      { header: 'Current Quantity', key: 'current_quantity', width: 15 },
      { header: 'Required Quantity', key: 'required_quantity', width: 15 },
      { header: 'Rack Number', key: 'rack_number', width: 15 },
      { header: 'Sale Rate', key: 'sale_rate', width: 15 }
    ];

    orders.forEach(order => {
      worksheet.addRow({
        product_name: order.product_name,
        product_code: order.product_code,
        brand: order.brand,
        current_quantity: order.current_quantity,
        required_quantity: order.required_quantity,
        rack_number: order.rack_number,
        sale_rate: order.sale_rate
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=order_sheet.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export order sheet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;








