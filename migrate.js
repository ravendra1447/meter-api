const pool = require('./src/config/database');

async function run() {
  const conn = await pool.getConnection();
  try {
    console.log('Creating property_expenses table...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS property_expenses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        property_id INT NOT NULL,
        owner_id INT NOT NULL,
        category VARCHAR(100) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        expense_date DATE NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log('Creating tenant_complaints table...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tenant_complaints (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        property_id INT NOT NULL,
        category VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        status ENUM('open', 'in_progress', 'resolved', 'closed') DEFAULT 'open',
        resolved_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
      )
    `);

    console.log('Migrations applied successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    conn.release();
    pool.end();
  }
}

run();
