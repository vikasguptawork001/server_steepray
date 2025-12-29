const PDFDocument = require('pdfkit');

const generateBillPDF = (transaction, items, res) => {
  try {
    const doc = new PDFDocument({ margin: 50 });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=bill_${transaction.bill_number}.pdf`);

    // Handle errors
    doc.on('error', (error) => {
      console.error('PDF generation error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate PDF' });
      }
    });

    doc.pipe(res);

    // Header
    doc.fontSize(24).text('STEEPRAY INFO SOLUTIONS', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();

    // Bill details
    doc.fontSize(12);
    doc.text(`Bill Number: ${transaction.bill_number}`, { align: 'left' });
    doc.text(`Date: ${new Date(transaction.transaction_date).toLocaleDateString()}`, { align: 'left' });
    doc.moveDown();

    // Party details
    doc.text('Bill To:', { underline: true });
    doc.text(`Name: ${transaction.party_name || 'N/A'}`);
    if (transaction.mobile_number) doc.text(`Mobile: ${transaction.mobile_number}`);
    if (transaction.address) doc.text(`Address: ${transaction.address}`);
    doc.moveDown();

    // Items table
    doc.text('Items:', { underline: true });
    doc.moveDown(0.5);

    // Table header
    const tableTop = doc.y;
    doc.fontSize(10);
    doc.text('S.No', 50, tableTop);
    doc.text('Product', 100, tableTop);
    doc.text('Qty', 300, tableTop);
    doc.text('Rate', 350, tableTop);
    doc.text('Amount', 400, tableTop);

    let y = tableTop + 20;
    let serialNumber = 1;

    items.forEach(item => {
      // Convert to numbers to handle string values from database
      const saleRate = parseFloat(item.sale_rate) || 0;
      const totalAmount = parseFloat(item.total_amount) || 0;
      const quantity = parseInt(item.quantity) || 0;
      const productName = (item.product_name || 'N/A').substring(0, 30);

      doc.text(serialNumber.toString(), 50, y);
      doc.text(productName, 100, y);
      doc.text(quantity.toString(), 300, y);
      doc.text(`₹${saleRate.toFixed(2)}`, 350, y);
      doc.text(`₹${totalAmount.toFixed(2)}`, 400, y);
      y += 20;
      serialNumber++;
    });

    // Total
    y += 10;
    doc.moveTo(300, y).lineTo(500, y).stroke();
    y += 10;
    doc.fontSize(12);
    
    // Convert transaction amounts to numbers
    const totalAmount = parseFloat(transaction.total_amount) || 0;
    const paidAmount = parseFloat(transaction.paid_amount) || 0;
    const balanceAmount = parseFloat(transaction.balance_amount) || 0;

    doc.text('Total Amount:', 300, y);
    doc.text(`₹${totalAmount.toFixed(2)}`, 400, y);
    y += 15;
    doc.text('Paid Amount:', 300, y);
    doc.text(`₹${paidAmount.toFixed(2)}`, 400, y);
    y += 15;
    doc.text('Balance Amount:', 300, y);
    doc.text(`₹${balanceAmount.toFixed(2)}`, 400, y);

    // Footer
    doc.fontSize(10);
    doc.text('Thank you for your business!', { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('Generate PDF error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
    }
  }
};

module.exports = { generateBillPDF };



