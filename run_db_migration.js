const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USERNAME || 'meteruser',
    password: process.env.DB_PASSWORD || 'meter@123',
    database: process.env.DB_DATABASE || 'billing_app',
    multipleStatements: true,
  });

  try {
    const sqlPath = path.join(__dirname, 'db_migrations_dynamic_commands.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('Running dynamic commands migration...');
    await connection.query(sql);
    console.log('✅ Dynamic commands inserted successfully into the database!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await connection.end();
  }
}

runMigration();
