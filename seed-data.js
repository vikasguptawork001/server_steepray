const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function seedData() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'inventory_management',
    });

    console.log('✓ Connected to database');
    console.log('Starting to seed data...\n');

    // 1. Add users (admin and sales)
    console.log('1. Adding users...');
    const adminPassword = await bcrypt.hash('admin123', 10);
    const salesPassword = await bcrypt.hash('sales123', 10);

    await connection.execute(
      'INSERT INTO users (user_id, password, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id=user_id',
      ['admin1', adminPassword, 'admin']
    );
    console.log('   ✓ Added admin user: admin1 (password: admin123)');

    await connection.execute(
      'INSERT INTO users (user_id, password, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id=user_id',
      ['sales1', salesPassword, 'sales']
    );
    console.log('   ✓ Added sales user: sales1 (password: sales123)');

    // 2. Add 5 buyer parties
    console.log('\n2. Adding buyer parties...');
    const buyerParties = [
      { name: 'ABC Wholesale Ltd', mobile: '9876543210', email: 'abc@wholesale.com', address: '123 Main Street, Mumbai', opening: 50000 },
      { name: 'XYZ Distributors', mobile: '9876543211', email: 'xyz@dist.com', address: '456 Commerce Road, Delhi', opening: 30000 },
      { name: 'Prime Suppliers', mobile: '9876543212', email: 'prime@suppliers.com', address: '789 Trade Avenue, Bangalore', opening: 75000 },
      { name: 'Global Imports', mobile: '9876543213', email: 'global@imports.com', address: '321 Export Street, Chennai', opening: 40000 },
      { name: 'Mega Traders', mobile: '9876543214', email: 'mega@traders.com', address: '654 Business Park, Pune', opening: 60000 }
    ];

    const buyerIds = [];
    for (const party of buyerParties) {
      const [result] = await connection.execute(
        'INSERT INTO buyer_parties (party_name, mobile_number, email, address, opening_balance, balance_amount) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE party_name=party_name',
        [party.name, party.mobile, party.email, party.address, party.opening, party.opening]
      );
      const [existing] = await connection.execute('SELECT id FROM buyer_parties WHERE party_name = ?', [party.name]);
      buyerIds.push(existing[0].id);
      console.log(`   ✓ Added buyer: ${party.name}`);
    }

    // 3. Add 5 seller parties
    console.log('\n3. Adding seller parties...');
    const sellerParties = [
      { name: 'Retail Mart', mobile: '9876543220', email: 'retail@mart.com', address: '111 Shop Street, Mumbai', opening: 0 },
      { name: 'Super Store', mobile: '9876543221', email: 'super@store.com', address: '222 Market Road, Delhi', opening: 0 },
      { name: 'City Center', mobile: '9876543222', email: 'city@center.com', address: '333 Plaza Avenue, Bangalore', opening: 0 },
      { name: 'Mega Mall', mobile: '9876543223', email: 'mega@mall.com', address: '444 Mall Street, Chennai', opening: 0 },
      { name: 'Trade Hub', mobile: '9876543224', email: 'trade@hub.com', address: '555 Hub Road, Pune', opening: 0 }
    ];

    const sellerIds = [];
    for (const party of sellerParties) {
      const [result] = await connection.execute(
        'INSERT INTO seller_parties (party_name, mobile_number, email, address, opening_balance, balance_amount) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE party_name=party_name',
        [party.name, party.mobile, party.email, party.address, party.opening, party.opening]
      );
      const [existing] = await connection.execute('SELECT id FROM seller_parties WHERE party_name = ?', [party.name]);
      sellerIds.push(existing[0].id);
      console.log(`   ✓ Added seller: ${party.name}`);
    }

    // 4. Add 10 products
    console.log('\n4. Adding products...');
    const products = [
      { name: 'Laptop Dell XPS 15', code: 'LAP-DELL-XPS15', brand: 'Dell', hsn: '84713000', tax: 18, sale: 85000, purchase: 70000, qty: 50, alert: 10, rack: 'A1' },
      { name: 'Wireless Mouse Logitech', code: 'MSE-LOG-MX3', brand: 'Logitech', hsn: '84716050', tax: 18, sale: 2500, purchase: 1800, qty: 100, alert: 20, rack: 'A2' },
      { name: 'Mechanical Keyboard', code: 'KB-MECH-RGB', brand: 'Corsair', hsn: '84716050', tax: 18, sale: 12000, purchase: 9000, qty: 75, alert: 15, rack: 'A3' },
      { name: 'Monitor 27 inch 4K', code: 'MON-27-4K', brand: 'LG', hsn: '85285200', tax: 18, sale: 35000, purchase: 28000, qty: 40, alert: 8, rack: 'B1' },
      { name: 'USB-C Cable 2m', code: 'CBL-USB-C-2M', brand: 'Anker', hsn: '85444290', tax: 18, sale: 800, purchase: 500, qty: 200, alert: 50, rack: 'B2' },
      { name: 'Webcam HD 1080p', code: 'CAM-HD-1080', brand: 'Logitech', hsn: '85258032', tax: 18, sale: 4500, purchase: 3200, qty: 60, alert: 12, rack: 'B3' },
      { name: 'External SSD 1TB', code: 'SSD-EXT-1TB', brand: 'Samsung', hsn: '84717010', tax: 18, sale: 8500, purchase: 6500, qty: 80, alert: 16, rack: 'C1' },
      { name: 'Gaming Headset', code: 'HS-GAME-7.1', brand: 'SteelSeries', hsn: '85183000', tax: 18, sale: 15000, purchase: 11000, qty: 45, alert: 9, rack: 'C2' },
      { name: 'Laptop Stand Aluminum', code: 'STD-LAP-AL', brand: 'Rain Design', hsn: '84733090', tax: 18, sale: 3500, purchase: 2500, qty: 90, alert: 18, rack: 'C3' },
      { name: 'Power Bank 20000mAh', code: 'PB-20K', brand: 'Anker', hsn: '85044000', tax: 18, sale: 2800, purchase: 2000, qty: 120, alert: 25, rack: 'D1' }
    ];

    const itemIds = [];
    for (const product of products) {
      const [result] = await connection.execute(
        'INSERT INTO items (product_name, product_code, brand, hsn_number, tax_rate, sale_rate, purchase_rate, quantity, alert_quantity, rack_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE product_name=product_name',
        [product.name, product.code, product.brand, product.hsn, product.tax, product.sale, product.purchase, product.qty, product.alert, product.rack]
      );
      const [existing] = await connection.execute('SELECT id FROM items WHERE product_code = ?', [product.code]);
      itemIds.push(existing[0].id);
      console.log(`   ✓ Added product: ${product.name}`);
    }

    // 5. Add purchase transactions (to increase stock)
    console.log('\n5. Adding purchase transactions...');
    const purchaseDates = [
      new Date('2024-01-15'),
      new Date('2024-01-20'),
      new Date('2024-02-01'),
      new Date('2024-02-10'),
      new Date('2024-02-25')
    ];

    // Purchase some items from different buyers
    const purchases = [
      { buyerId: buyerIds[0], itemId: itemIds[0], qty: 20, rate: 70000, date: purchaseDates[0] },
      { buyerId: buyerIds[0], itemId: itemIds[1], qty: 50, rate: 1800, date: purchaseDates[0] },
      { buyerId: buyerIds[1], itemId: itemIds[2], qty: 30, rate: 9000, date: purchaseDates[1] },
      { buyerId: buyerIds[1], itemId: itemIds[3], qty: 15, rate: 28000, date: purchaseDates[1] },
      { buyerId: buyerIds[2], itemId: itemIds[4], qty: 100, rate: 500, date: purchaseDates[2] },
      { buyerId: buyerIds[2], itemId: itemIds[5], qty: 30, rate: 3200, date: purchaseDates[2] },
      { buyerId: buyerIds[3], itemId: itemIds[6], qty: 40, rate: 6500, date: purchaseDates[3] },
      { buyerId: buyerIds[3], itemId: itemIds[7], qty: 20, rate: 11000, date: purchaseDates[3] },
      { buyerId: buyerIds[4], itemId: itemIds[8], qty: 45, rate: 2500, date: purchaseDates[4] },
      { buyerId: buyerIds[4], itemId: itemIds[9], qty: 60, rate: 2000, date: purchaseDates[4] }
    ];

    for (const purchase of purchases) {
      await connection.execute(
        'INSERT INTO purchase_transactions (buyer_party_id, item_id, quantity, purchase_rate, total_amount, transaction_date) VALUES (?, ?, ?, ?, ?, ?)',
        [purchase.buyerId, purchase.itemId, purchase.qty, purchase.rate, purchase.qty * purchase.rate, purchase.date]
      );
    }
    console.log(`   ✓ Added ${purchases.length} purchase transactions`);

    // 6. Add sale transactions
    console.log('\n6. Adding sale transactions...');
    const saleDates = [
      new Date('2024-03-01'),
      new Date('2024-03-05'),
      new Date('2024-03-10'),
      new Date('2024-03-15'),
      new Date('2024-03-20')
    ];

    // Create sales with multiple items
    const sales = [
      {
        sellerId: sellerIds[0],
        date: saleDates[0],
        items: [
          { itemId: itemIds[0], qty: 2, rate: 85000 },
          { itemId: itemIds[1], qty: 5, rate: 2500 }
        ],
        paymentStatus: 'fully_paid'
      },
      {
        sellerId: sellerIds[1],
        date: saleDates[1],
        items: [
          { itemId: itemIds[2], qty: 3, rate: 12000 },
          { itemId: itemIds[3], qty: 1, rate: 35000 }
        ],
        paymentStatus: 'fully_paid'
      },
      {
        sellerId: sellerIds[2],
        date: saleDates[2],
        items: [
          { itemId: itemIds[4], qty: 10, rate: 800 },
          { itemId: itemIds[5], qty: 2, rate: 4500 }
        ],
        paymentStatus: 'partially_paid',
        paidAmount: 15000
      },
      {
        sellerId: sellerIds[3],
        date: saleDates[3],
        items: [
          { itemId: itemIds[6], qty: 5, rate: 8500 },
          { itemId: itemIds[7], qty: 2, rate: 15000 }
        ],
        paymentStatus: 'fully_paid'
      },
      {
        sellerId: sellerIds[4],
        date: saleDates[4],
        items: [
          { itemId: itemIds[8], qty: 8, rate: 3500 },
          { itemId: itemIds[9], qty: 12, rate: 2800 }
        ],
        paymentStatus: 'partially_paid',
        paidAmount: 50000
      }
    ];

    for (let i = 0; i < sales.length; i++) {
      const sale = sales[i];
      let totalAmount = 0;
      const saleItems = [];

      // Calculate total
      for (const item of sale.items) {
        const itemTotal = item.qty * item.rate;
        totalAmount += itemTotal;
        saleItems.push({ ...item, itemTotal });
      }

      const paidAmount = sale.paymentStatus === 'fully_paid' ? totalAmount : (sale.paidAmount || 0);
      const balanceAmount = totalAmount - paidAmount;
      const billNumber = `BILL-${Date.now()}-${i + 1}`;

      // Insert sale transaction
      const [saleResult] = await connection.execute(
        'INSERT INTO sale_transactions (seller_party_id, transaction_date, total_amount, paid_amount, balance_amount, payment_status, bill_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [sale.sellerId, sale.date, totalAmount, paidAmount, balanceAmount, sale.paymentStatus, billNumber]
      );

      const saleTransactionId = saleResult.insertId;

      // Insert sale items and update stock
      for (const item of saleItems) {
        await connection.execute(
          'INSERT INTO sale_items (sale_transaction_id, item_id, quantity, sale_rate, total_amount) VALUES (?, ?, ?, ?, ?)',
          [saleTransactionId, item.itemId, item.qty, item.rate, item.itemTotal]
        );

        // Update item quantity
        await connection.execute(
          'UPDATE items SET quantity = quantity - ? WHERE id = ?',
          [item.qty, item.itemId]
        );
      }

      // Update seller party balance
      await connection.execute(
        'UPDATE seller_parties SET balance_amount = balance_amount + ?, paid_amount = paid_amount + ? WHERE id = ?',
        [balanceAmount, paidAmount, sale.sellerId]
      );

      console.log(`   ✓ Added sale transaction ${i + 1} (Bill: ${billNumber}, Amount: ₹${totalAmount})`);
    }

    console.log('\n✓ All seed data added successfully!');
    console.log('\nSummary:');
    console.log('  - 1 admin user (admin1 / admin123)');
    console.log('  - 1 sales user (sales1 / sales123)');
    console.log('  - 10 products');
    console.log('  - 5 buyer parties');
    console.log('  - 5 seller parties');
    console.log('  - 10 purchase transactions');
    console.log('  - 5 sale transactions');

  } catch (error) {
    console.error('✗ Error seeding data:', error.message);
    console.error(error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

seedData();





