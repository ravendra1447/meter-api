const app = require('./app');
const env = require('./config/env');
const pool = require('./config/database');
const { initCron } = require('./cron/billingCron');

// Run DB Migrations
(async () => {
  try {
    await pool.query('ALTER TABLE property_tenants ADD COLUMN agreement_duration_months INT DEFAULT 11');
    await pool.query('ALTER TABLE property_tenants ADD COLUMN deposit_paid BOOLEAN DEFAULT FALSE');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.error('DB Migration error:', err);
    }
  }
})();

initCron();

app.listen(env.port, () => {
  console.log(`RentMeter API listening on http://127.0.0.1:${env.port}`);
  console.log(`API info: http://127.0.0.1:${env.port}/api`);
});
