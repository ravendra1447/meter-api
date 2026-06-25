const app = require('./app');
const env = require('./config/env');
const pool = require('./config/database');
const { initCron } = require('./cron/billingCron');

initCron();

app.listen(env.port, () => {
  console.log(`RentMeter API listening on http://127.0.0.1:${env.port}`);
  console.log(`API info: http://127.0.0.1:${env.port}/api`);
});
