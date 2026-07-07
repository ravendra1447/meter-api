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
    console.log("Adding missing columns to 'meters' table...");
    
    // Add columns one by one, ignoring errors if they already exist
    const columns = [
      "ALTER TABLE meters ADD COLUMN scheduler_relay_trip_at DATETIME NULL",
      "ALTER TABLE meters ADD COLUMN scheduler_pre_alarm_at DATETIME NULL",
      "ALTER TABLE meters ADD COLUMN last_scheduler_freeze_key VARCHAR(255) NULL"
    ];

    for (const sql of columns) {
      try {
        await connection.query(sql);
        console.log("✅ Executed:", sql);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log("ℹ️ Column already exists, skipping:", sql);
        } else {
          console.error("❌ Error executing:", sql, err.message);
        }
      }
    }
    
    console.log("Done! Please restart your PM2 meter-api server.");
  } catch (e) {
    console.error("Connection Error:", e);
  } finally {
    await connection.end();
  }
}

fixTable();
