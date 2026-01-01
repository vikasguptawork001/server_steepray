const PDFDocument = require('pdfkit');

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

    // Items Table Header
    const tableTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    
    let xPos = 50;
    doc.text('Sr.', xPos, tableTop);
    xPos += 30;
    doc.text('Product ID', xPos, tableTop);
    xPos += 80;
    doc.text('Product Description', xPos, tableTop);
    
    if (withGst) {
      xPos += 120;
      doc.text('HSN', xPos, tableTop);
      xPos += 50;
      doc.text('Rate', xPos, tableTop);
      xPos += 50;
      doc.text('Qty', xPos, tableTop);
      xPos += 40;
      doc.text('Taxable Value', xPos, tableTop);
      xPos += 70;
      doc.text('GST%', xPos, tableTop);
      xPos += 40;
      doc.text('Amount', xPos, tableTop);
    } else {
      xPos += 200;
      doc.text('Rate', xPos, tableTop);
      xPos += 50;
      doc.text('Qty', xPos, tableTop);
      xPos += 40;
      doc.text('Amount', xPos, tableTop);
    }

    // Draw table header line
    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
    
    let y = tableTop + 25;
    let serialNumber = 1;
    let totalTaxableValue = 0;
    let totalCgst = 0;
    let totalSgst = 0;

    doc.fontSize(8).font('Helvetica');
    items.forEach(item => {
      const saleRate = parseFloat(item.sale_rate) || 0;
      const quantity = parseInt(item.quantity) || 0;
      const itemTotal = saleRate * quantity;
      const productName = (item.product_name || 'N/A').substring(0, 25);
      const productCode = (item.product_code || '-').substring(0, 15);
      const hsn = item.hsn_number || '-';
      const taxRate = parseFloat(item.tax_rate) || 0;

      let taxableValue = itemTotal;
      let cgst = 0;
      let sgst = 0;
      let amount = itemTotal;

      if (withGst && taxRate > 0) {
        taxableValue = itemTotal / (1 + taxRate / 100);
        const tax = itemTotal - taxableValue;
        cgst = tax / 2;
        sgst = tax / 2;
        amount = itemTotal; // Amount includes GST
        totalTaxableValue += taxableValue;
        totalCgst += cgst;
        totalSgst += sgst;
      } else {
        totalTaxableValue += itemTotal;
      }

      xPos = 50;
      doc.text(serialNumber.toString(), xPos, y);
      xPos += 30;
      doc.text(productCode, xPos, y);
      xPos += 80;
      doc.text(productName, xPos, y);
      
      if (withGst) {
        xPos += 120;
        doc.text(hsn, xPos, y);
        xPos += 50;
        doc.text(`₹${saleRate.toFixed(2)}`, xPos, y);
        xPos += 50;
        doc.text(quantity.toString(), xPos, y);
        xPos += 40;
        doc.text(`₹${taxableValue.toFixed(2)}`, xPos, y);
        xPos += 70;
        doc.text(`${taxRate}%`, xPos, y);
        xPos += 40;
        doc.text(`₹${amount.toFixed(2)}`, xPos, y);
      } else {
        xPos += 200;
        doc.text(`₹${saleRate.toFixed(2)}`, xPos, y);
        xPos += 50;
        doc.text(quantity.toString(), xPos, y);
        xPos += 40;
        doc.text(`₹${amount.toFixed(2)}`, xPos, y);
      }

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
    
    if (withGst) {
      const taxableAfterDiscount = totalTaxableValue - discount;
      doc.text('Taxable Amount:', 350, y);
      doc.text(`₹${taxableAfterDiscount.toFixed(2)}`, 450, y, { align: 'right' });
      y += 15;
      if (discount > 0) {
        doc.text('Discount:', 350, y);
        doc.text(`-₹${discount.toFixed(2)}`, 450, y, { align: 'right' });
        y += 15;
      }
      doc.text('CGST:', 350, y);
      doc.text(`₹${totalCgst.toFixed(2)}`, 450, y, { align: 'right' });
      y += 15;
      doc.text('SGST:', 350, y);
      doc.text(`₹${totalSgst.toFixed(2)}`, 450, y, { align: 'right' });
      y += 15;
    } else {
      doc.text('Subtotal:', 350, y);
      doc.text(`₹${subtotal.toFixed(2)}`, 450, y, { align: 'right' });
      y += 15;
      if (discount > 0) {
        doc.text('Discount:', 350, y);
        doc.text(`-₹${discount.toFixed(2)}`, 450, y, { align: 'right' });
        y += 15;
      }
    }

    doc.fontSize(12).font('Helvetica-Bold');
    doc.moveTo(350, y).lineTo(550, y).stroke();
    y += 15;
    doc.text('Invoice Amount:', 350, y);
    doc.text(`₹${totalAmount.toFixed(2)}`, 450, y, { align: 'right' });
    y += 20;
    doc.fontSize(10).font('Helvetica');
    doc.text('Paid Amount:', 350, y);
    doc.text(`₹${paidAmount.toFixed(2)}`, 450, y, { align: 'right' });
    y += 15;
    doc.fontSize(11).font('Helvetica-Bold');
    doc.text('Balance Amount:', 350, y);
    doc.text(`₹${balanceAmount.toFixed(2)}`, 450, y, { align: 'right' });

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
    
    let summaryYPos = summaryY + 15;
    doc.text(`Taxable Amount: ₹${withGst ? (totalTaxableValue - discount).toFixed(2) : (subtotal - discount).toFixed(2)}`, summaryBoxX + 10, summaryYPos);
    summaryYPos += 12;
    if (withGst) {
      doc.text(`CGST: ₹${totalCgst.toFixed(2)}`, summaryBoxX + 10, summaryYPos);
      summaryYPos += 12;
      doc.text(`SGST: ₹${totalSgst.toFixed(2)}`, summaryBoxX + 10, summaryYPos);
      summaryYPos += 12;
    }
    doc.text(`Invoice Amount: ₹${totalAmount.toFixed(2)}`, summaryBoxX + 10, summaryYPos);

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



