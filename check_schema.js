const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkSchema() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USERNAME || 'meteruser',
    password: process.env.DB_PASSWORD || 'meter@123',
    database: process.env.DB_DATABASE || 'billing_app',
  });

  try {
    const [rows] = await connection.query("DESCRIBE meters");
    console.log("Columns in 'meters' table:");
    rows.forEach(row => console.log(row.Field));
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await connection.end();
  }
}

checkSchema();
