const PDFDocument = require('pdfkit');

// Helper function to format currency (handles rupee symbol encoding)
const formatCurrency = (amount) => {
  try {
    // Try to use rupee symbol, fallback to Rs. if encoding issue
    return `₹${amount.toFixed(2)}`;
  } catch (e) {
    return `Rs.${amount.toFixed(2)}`;
  }
};

const generateBillPDF = (transaction, items, res) => {
  try {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
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

    const withGst = transaction.with_gst === 1 || transaction.with_gst === true;
    const discount = parseFloat(transaction.discount) || 0;
    const taxAmount = parseFloat(transaction.tax_amount) || 0;
    const subtotal = parseFloat(transaction.subtotal) || 0;

    // Professional Header
    doc.fontSize(20).font('Helvetica-Bold').text('STEEPRAY INFO SOLUTIONS', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).font('Helvetica').text('Insert Company Address', { align: 'center' });
    
    // GSTIN and Location
    doc.moveDown(0.5);
    doc.fontSize(10);
    doc.text('GSTIN:', 50, doc.y);
    doc.text('Location:', 300, doc.y, { align: 'right' });
    doc.moveDown(0.8);
    
    // Tax Invoice Title
    doc.fontSize(18).font('Helvetica-Bold').text('TAX INVOICE', { align: 'center' });
    doc.moveDown(0.5);

    // Invoice Details Section
    const invoiceTop = doc.y;
    doc.fontSize(10).font('Helvetica');
    
    // Left Column - Invoice & Customer Info
    doc.text(`Invoice No: ${transaction.bill_number}`, 50, invoiceTop);
    doc.text(`Cust. ID: ${transaction.seller_party_id}`, 50, invoiceTop + 15);
    doc.text(`Name: ${transaction.party_name || 'N/A'}`, 50, invoiceTop + 30);
    doc.text(`Address: ${(transaction.address || 'N/A').substring(0, 40)}`, 50, invoiceTop + 45);
    
    // Right Column - Date & Transaction Info
    doc.text(`Date: ${new Date(transaction.transaction_date).toLocaleDateString()}`, 300, invoiceTop, { align: 'right' });
    doc.text(`Type: ${withGst ? 'GST' : 'Non-GST'}`, 300, invoiceTop + 15, { align: 'right' });
    doc.text(`Due Date: ${new Date(transaction.transaction_date).toLocaleDateString()}`, 300, invoiceTop + 30, { align: 'right' });
    if (transaction.gst_number) {
      doc.text(`GSTIN: ${transaction.gst_number}`, 300, invoiceTop + 45, { align: 'right' });
    }
    doc.text('POS: Insert POS', 300, invoiceTop + 60, { align: 'right' });

    doc.moveDown(2);

    // Items Table Header - Simplified
    const tableTop = doc.y;
    doc.fontSize(10).font('Helvetica-Bold');
    
    let xPos = 50;
    doc.text('Sr.', xPos, tableTop);
    xPos += 30;
    doc.text('Product Description', xPos, tableTop);
    xPos += 180;
    doc.text('Qty', xPos, tableTop);
    xPos += 35;
    doc.text('Rate', xPos, tableTop);
    xPos += 50;
    if (withGst) {
      doc.text('GST%', xPos, tableTop);
      xPos += 35;
    }
    doc.text('Discount', xPos, tableTop);
    xPos += 55;
    doc.text('Amount', xPos, tableTop);

    // Draw table header line
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
    
    let y = tableTop + 25;
    let serialNumber = 1;
    let totalTaxableValue = 0;
    let totalCgst = 0;
    let totalSgst = 0;

    doc.fontSize(9).font('Helvetica');
    items.forEach(item => {
      const saleRate = parseFloat(item.sale_rate) || 0;
      const quantity = parseInt(item.quantity) || 0;
      const itemTotal = saleRate * quantity;
      
      // Truncate product description with ".." if too long
      let productName = item.product_name || 'N/A';
      const maxLength = 35; // Maximum characters for product description
      if (productName.length > maxLength) {
        productName = productName.substring(0, maxLength - 2) + '..';
      }
      
      const taxRate = parseFloat(item.tax_rate) || 0;

      // Calculate item-level discount (matching backend logic)
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

      let taxableValue = itemTotalAfterDiscount;
      let cgst = 0;
      let sgst = 0;
      let amount = itemTotalAfterDiscount;

      if (withGst && taxRate > 0) {
        // GST-inclusive: taxable value = total after discount / (1 + GST/100)
        taxableValue = itemTotalAfterDiscount / (1 + taxRate / 100);
        const tax = itemTotalAfterDiscount - taxableValue;
        cgst = tax / 2;
        sgst = tax / 2;
        amount = itemTotalAfterDiscount; // Amount includes GST
        totalTaxableValue += taxableValue;
        totalCgst += cgst;
        totalSgst += sgst;
      } else {
        totalTaxableValue += itemTotalAfterDiscount;
      }

      xPos = 50;
      // Serial number
      doc.text(serialNumber.toString(), xPos, y);
      xPos += 30;
      // Product description (truncated if needed)
      doc.text(productName, xPos, y);
      xPos += 180;
      // Quantity
      doc.text(quantity.toString(), xPos, y);
      xPos += 35;
      // Rate
      doc.text(formatCurrency(saleRate), xPos, y);
      xPos += 50;
      // GST% (only for GST invoices)
      if (withGst) {
        doc.text(`${taxRate}%`, xPos, y);
        xPos += 35;
      }
      // Discount
      if (itemDiscount > 0) {
        doc.text(`-${formatCurrency(itemDiscount)}`, xPos, y);
      } else {
        doc.text('-', xPos, y);
      }
      xPos += 55;
      // Amount
      doc.text(formatCurrency(amount), xPos, y);

      y += 18;
      serialNumber++;
    });

    // Summary Section
    y += 10;
    doc.moveTo(50, y).lineTo(550, y).stroke();
    y += 15;

    const totalAmount = parseFloat(transaction.total_amount) || 0;
    const paidAmount = parseFloat(transaction.paid_amount) || 0;
    const balanceAmount = parseFloat(transaction.balance_amount) || 0;

    doc.fontSize(10).font('Helvetica');
    
    // Calculate total discount from all items (calculate once, use everywhere)
    let totalItemDiscount = 0;
    items.forEach(item => {
      const saleRate = parseFloat(item.sale_rate) || 0;
      const quantity = parseInt(item.quantity) || 0;
      const itemTotal = saleRate * quantity;
      
      let itemDiscount = 0;
      const itemDiscountType = item.discount_type || 'amount';
      if (itemDiscountType === 'percentage' && item.discount_percentage !== null && item.discount_percentage !== undefined) {
        itemDiscount = (itemTotal * item.discount_percentage) / 100;
      } else {
        itemDiscount = parseFloat(item.discount || 0);
      }
      itemDiscount = Math.min(itemDiscount, itemTotal);
      totalItemDiscount += itemDiscount;
    });
    
    if (withGst) {
      doc.text('Taxable Amount:', 350, y);
      doc.text(formatCurrency(totalTaxableValue), 450, y, { align: 'right' });
      y += 15;
      if (totalItemDiscount > 0) {
        doc.text('Total Discount:', 350, y);
        doc.text(`-${formatCurrency(totalItemDiscount)}`, 450, y, { align: 'right' });
        y += 15;
      }
      doc.text('CGST:', 350, y);
      doc.text(formatCurrency(totalCgst), 450, y, { align: 'right' });
      y += 15;
      doc.text('SGST:', 350, y);
      doc.text(formatCurrency(totalSgst), 450, y, { align: 'right' });
      y += 15;
    } else {
      doc.text('Subtotal:', 350, y);
      doc.text(formatCurrency(totalTaxableValue), 450, y, { align: 'right' });
      y += 15;
      if (totalItemDiscount > 0) {
        doc.text('Total Discount:', 350, y);
        doc.text(`-${formatCurrency(totalItemDiscount)}`, 450, y, { align: 'right' });
        y += 15;
      }
    }

    doc.fontSize(12).font('Helvetica-Bold');
    doc.moveTo(350, y).lineTo(550, y).stroke();
    y += 15;
    doc.text('Invoice Amount:', 350, y);
    doc.text(formatCurrency(totalAmount), 450, y, { align: 'right' });
    y += 20;
    doc.fontSize(10).font('Helvetica');
    doc.text('Paid Amount:', 350, y);
    doc.text(formatCurrency(paidAmount), 450, y, { align: 'right' });
    y += 15;
    doc.fontSize(11).font('Helvetica-Bold');
    doc.text('Balance Amount:', 350, y);
    doc.text(formatCurrency(balanceAmount), 450, y, { align: 'right' });

    // Remarks and Summary Box
    y += 30;
    const summaryY = y;
    
    // Left side - Remarks
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Remarks:', 50, summaryY);
    doc.font('Helvetica');
    doc.fontSize(9);
    doc.text('Thank You. Visit Again.', 50, summaryY + 15);
    
    // Right side - Summary box
    const summaryBoxX = 350;
    doc.rect(summaryBoxX, summaryY - 5, 200, 80).stroke();
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Summary', summaryBoxX + 10, summaryY);
    doc.font('Helvetica');
    doc.fontSize(9);
    
    // Use the same totalItemDiscount calculated above
    let summaryYPos = summaryY + 15;
    doc.text(`Taxable Amount: ${formatCurrency(totalTaxableValue)}`, summaryBoxX + 10, summaryYPos);
    summaryYPos += 12;
    if (totalItemDiscount > 0) {
      doc.text(`Total Discount: -${formatCurrency(totalItemDiscount)}`, summaryBoxX + 10, summaryYPos);
      summaryYPos += 12;
    }
    if (withGst) {
      doc.text(`CGST: ${formatCurrency(totalCgst)}`, summaryBoxX + 10, summaryYPos);
      summaryYPos += 12;
      doc.text(`SGST: ${formatCurrency(totalSgst)}`, summaryBoxX + 10, summaryYPos);
      summaryYPos += 12;
    }
    doc.text(`Invoice Amount: ${formatCurrency(totalAmount)}`, summaryBoxX + 10, summaryYPos);

    // Footer
    y = doc.page.height - 100;
    doc.fontSize(9).font('Helvetica');
    doc.text('Thank You. Visit Again.', { align: 'center', y: y });

    doc.end();
  } catch (error) {
    console.error('Generate PDF error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
    }
  }
};

module.exports = { generateBillPDF };



