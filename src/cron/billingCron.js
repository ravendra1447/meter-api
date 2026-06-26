// cron/billingCron.js

const pool = require('../config/database');
const NotificationService = require('../services/notificationService');
const billingStatementService = require('../services/billingStatementService');

/**
 * Process daily billing - runs at 12:00 PM
 * Checks for due bills and triggers auto disconnect
 */
async function processDailyBilling() {
  console.log('====================================================');
  console.log('[CRON] Starting Daily 12:00 PM Bill & Disconnect Check');
  console.log('====================================================');

  try {
    // Get all active tenants
    const [tenants] = await pool.query(`
      SELECT pt.tenant_id, u.name, u.mobile, pt.property_id
      FROM property_tenants pt
      INNER JOIN users u ON u.id = pt.tenant_id
      WHERE pt.status = 'active'
    `);

    console.log(`[CRON] Found ${tenants.length} active tenants`);

    let notifiedCount = 0;
    let disconnectedCount = 0;

    for (const tenantRow of tenants) {
      // Get tenant's billing statement
      const statement = await billingStatementService.getStatementForTenantUser(tenantRow.tenant_id);
      
      if (!statement || !['due', 'overdue'].includes(statement.status) || statement.total <= 0) {
        continue;
      }

      console.log(`[CRON] Tenant ${tenantRow.name} has ${statement.status} bill: ₹${statement.total}`);

      // Check Grace Period from meter schedule
      const [meterRows] = await pool.query(
        `SELECT * FROM electricity_meters 
         WHERE property_id = ? AND status = 'active' 
         LIMIT 1`, 
        [tenantRow.property_id]
      );
      const meter = meterRows[0];
      
      let graceDays = 5;
      let disconnectDay = 7; // Default disconnect on 7th of month
      
      if (meter) {
        const [scheduleRows] = await pool.query(
          `SELECT billing FROM meter_billing_schedules 
           WHERE electricity_meter_id = ? AND status = 'active' 
           ORDER BY id DESC LIMIT 1`, 
          [meter.id]
        );
        
        if (scheduleRows.length && scheduleRows[0].billing) {
          try {
            const billingObj = typeof scheduleRows[0].billing === 'string' 
              ? JSON.parse(scheduleRows[0].billing) 
              : scheduleRows[0].billing;
              
            if (billingObj) {
              if (billingObj.grace_days !== undefined) {
                graceDays = Number(billingObj.grace_days);
              }
              if (billingObj.disconnect_day !== undefined) {
                disconnectDay = Number(billingObj.disconnect_day);
              }
            }
          } catch(e) {
            console.error(`[CRON] Error parsing billing JSON for meter ${meter.id}:`, e);
          }
        }
      }

      // 1. Send WhatsApp Notification
      try {
        await NotificationService.sendBillDueNotification(
          { id: tenantRow.tenant_id, name: tenantRow.name, mobile: tenantRow.mobile },
          statement,
          graceDays
        );
        notifiedCount++;
        console.log(`[CRON] ✅ Notification sent to ${tenantRow.name}`);
      } catch (notifError) {
        console.error(`[CRON] ❌ Notification error for tenant ${tenantRow.tenant_id}:`, notifError.message);
      }

      // 2. Check if Grace Period Expired -> Trigger Auto Disconnect (Relay OFF)
      const dueDate = new Date(statement.due_date);
      dueDate.setDate(dueDate.getDate() + graceDays);
      const now = new Date();

      // Check if current date is past disconnect day
      const currentDay = now.getDate();
      const isPastDisconnectDay = (currentDay >= disconnectDay);

      // Check if grace period expired AND it's past disconnect day
      const graceExpired = now.getTime() > dueDate.getTime();
      const shouldDisconnect = (graceExpired && isPastDisconnectDay) || 
                               (statement.status === 'overdue' && isPastDisconnectDay);

      if (shouldDisconnect && meter) {
        console.log(`[AUTO DISCONNECT] ⚡ Grace period expired for tenant ${tenantRow.name}. Tripping relay...`);
        
        // Get smart meter id
        const [smartRows] = await pool.query(
          'SELECT id, pending_relay_action FROM meters WHERE meter_number = ? LIMIT 1', 
          [meter.meter_number]
        );
        
        if (smartRows.length) {
          // Update pending relay action in meters table
          await pool.query(
            'UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?', 
            ['OFF', smartRows[0].id]
          );
          
          // Also update electricity_meters table
          await pool.query(
            'UPDATE electricity_meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?',
            ['OFF', meter.id]
          );
          
          disconnectedCount++;
          console.log(`[AUTO DISCONNECT] ✅ Pending relay set to OFF for meter ${meter.meter_number}`);
        } else {
          console.log(`[AUTO DISCONNECT] ⚠️ Smart meter not found for meter number ${meter.meter_number}`);
        }
      }
    }

    console.log('====================================================');
    console.log(`[CRON] ✅ Daily check finished.`);
    console.log(`[CRON] 📨 Notifications sent: ${notifiedCount}`);
    console.log(`[CRON] 🔌 Disconnections triggered: ${disconnectedCount}`);
    console.log('====================================================');

  } catch (err) {
    console.error('[CRON] ❌ Error:', err);
  }
}

/**
 * Start the cron loop. It checks the time every minute, and executes only at 12:00 PM.
 */
function initCron() {
  setInterval(() => {
    const now = new Date();
    // Run at 12:00 PM exactly
    if (now.getHours() === 12 && now.getMinutes() === 0) {
      processDailyBilling();
    }
  }, 60 * 1000); // Check every minute
  
  console.log('[CRON] 📅 Billing Cron Initialized. Waiting for 12:00 PM...');
}

/**
 * Run billing check manually (for testing)
 */
async function runManualBillingCheck() {
  console.log('[CRON] 🔄 Manual billing check triggered...');
  await processDailyBilling();
}

module.exports = {
  initCron,
  processDailyBilling,
  runManualBillingCheck
};