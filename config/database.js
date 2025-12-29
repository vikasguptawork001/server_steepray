const mysql = require('mysql2/promise');
const config = require('./config');

const poolConfig = {
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  waitForConnections: true,
  connectionLimit: config.database.connectionLimit,
  queueLimit: config.database.queueLimit
};

// Add SSL configuration if enabled
if (config.database.ssl) {
  poolConfig.ssl = config.database.ssl;
}

const pool = mysql.createPool(poolConfig);

// Test connection on startup
pool.getConnection()
  .then(connection => {
    console.log('✅ Database connected successfully');
    connection.release();
  })
  .catch(error => {
    console.error('❌ Database connection error:', error.message);
  });

module.exports = pool;


