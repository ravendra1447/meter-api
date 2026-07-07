const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USERNAME || 'meteruser',
    password: process.env.DB_PASSWORD || 'meter@123',
    database: process.env.DB_DATABASE || 'billing_app',
  });

  try {
    console.log("Altering 'meter_commands' table to support longer command_type...");
    await connection.query("ALTER TABLE meter_commands MODIFY command_type VARCHAR(100) NOT NULL;");
    console.log("✅ Executed: ALTER TABLE meter_commands MODIFY command_type VARCHAR(100)");
  } catch (err) {
    console.error("❌ Error executing alter table:", err.message);
  } finally {
    await connection.end();
  }
}

fixTable();
