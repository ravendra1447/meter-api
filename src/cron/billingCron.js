const pool = require('../config/database');
const NotificationService = require('../services/notificationService');
const billingStatementService = require('../services/billingStatementService');

async function processDailyBilling() {
  console.log('====================================================');
  console.log('[CRON] Starting Daily 12:00 PM Bill & Disconnect Check');
  console.log('====================================================');

  try {
    const [tenants] = await pool.query(`
      SELECT pt.tenant_id, u.name, u.mobile, pt.property_id
      FROM property_tenants pt
      INNER JOIN users u ON u.id = pt.tenant_id
      WHERE pt.status = 'active'
    `);

    for (const tenantRow of tenants) {
      const statement = await billingStatementService.getStatementForTenantUser(tenantRow.tenant_id);
      
      if (!statement || !['due', 'overdue'].includes(statement.status) || statement.total <= 0) {
        continue;
      }

      // Check Grace Period from meter schedule
      const [meterRows] = await pool.query(`SELECT * FROM electricity_meters WHERE property_id = ? AND status = 'active' LIMIT 1`, [tenantRow.property_id]);
      const meter = meterRows[0];
      
      let graceDays = 5;
      if (meter) {
        const [scheduleRows] = await pool.query(`SELECT billing FROM meter_billing_schedules WHERE electricity_meter_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [meter.id]);
        if (scheduleRows.length && scheduleRows[0].billing) {
          try {
            const billingObj = typeof scheduleRows[0].billing === 'string' ? JSON.parse(scheduleRows[0].billing) : scheduleRows[0].billing;
            if (billingObj && billingObj.grace_days !== undefined) graceDays = Number(billingObj.grace_days);
          } catch(e) {}
        }
      }

      // 1. Send WhatsApp Notification
      await NotificationService.sendBillDueNotification(
        { id: tenantRow.tenant_id, name: tenantRow.name, mobile: tenantRow.mobile },
        statement,
        graceDays
      );

      // 2. Check if Grace Period Expired -> Trigger Auto Disconnect (Relay OFF)
      const dueDate = new Date(statement.due_date);
      dueDate.setDate(dueDate.getDate() + graceDays);
      const now = new Date();

      if (now.getTime() > dueDate.getTime() && meter) {
        console.log(`[AUTO DISCONNECT] Grace period expired for tenant ${tenantRow.name}. Tripping relay...`);
        const [smartRows] = await pool.query('SELECT id FROM meters WHERE meter_number = ? LIMIT 1', [meter.meter_number]);
        if (smartRows.length) {
          await pool.query('UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?', ['OFF', smartRows[0].id]);
        }
      }
    }
    console.log('[CRON] Daily check finished.');
  } catch (err) {
    console.error('[CRON] Error:', err);
  }
}

// Start the cron loop. It checks the time every minute, and executes only at 12:00 PM.
function initCron() {
  setInterval(() => {
    const now = new Date();
    // Run at 12:00 PM exactly. (Check hours and minutes, ensure it only runs once in that minute)
    if (now.getHours() === 12 && now.getMinutes() === 0) {
      processDailyBilling();
    }
  }, 60 * 1000); // Check every minute
  
  console.log('[CRON] Billing Cron Initialized. Waiting for 12:00 PM...');
}

module.exports = {
  initCron,
  processDailyBilling
};
