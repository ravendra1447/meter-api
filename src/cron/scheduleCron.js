const cron = require('node-cron');
const pool = require('../config/db');

/**
 * Checks all active schedules for daily_off_time and daily_on_time.
 * If the current time has crossed either threshold within the last hour, 
 * it sets the pending_relay_action appropriately.
 */
async function processDailySchedules() {
  try {
    const [schedules] = await pool.query(`
      SELECT * FROM meter_billing_schedules WHERE status = 'active'
    `);

    if (!schedules.length) return;

    // Get current time in 'HH:mm' format
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;

    for (const schedule of schedules) {
      if (!schedule.billing) continue;
      
      const billing = typeof schedule.billing === 'string' 
        ? JSON.parse(schedule.billing) 
        : schedule.billing;

      const offTime = billing.daily_off_time; // e.g. "23:00"
      const onTime = billing.daily_on_time;   // e.g. "06:00"

      if (!offTime && !onTime) continue;

      let targetAction = null;

      // We need to determine the currently active window.
      // E.g., OFF = 23:00, ON = 06:00
      // Current = 23:15 -> OFF window
      // Current = 06:15 -> ON window

      if (offTime && onTime) {
        if (offTime > onTime) {
          // Night schedule (e.g. 23:00 to 06:00)
          if (currentTime >= offTime || currentTime < onTime) {
            targetAction = 'OFF';
          } else {
            targetAction = 'ON';
          }
        } else {
          // Day schedule (e.g. 09:00 to 18:00)
          if (currentTime >= offTime && currentTime < onTime) {
            targetAction = 'OFF';
          } else {
            targetAction = 'ON';
          }
        }
      } else if (offTime) {
        // Only OFF specified. We set to OFF if current time is >= offTime.
        // We probably only want to trigger it once.
        if (currentTime === offTime) targetAction = 'OFF';
      } else if (onTime) {
        // Only ON specified
        if (currentTime === onTime) targetAction = 'ON';
      }

      if (targetAction) {
        // Check current pending_relay_action. If it's different or null, update it.
        const [meterRows] = await pool.query(
          'SELECT id, pending_relay_action FROM electricity_meters WHERE id = ?',
          [schedule.meter_id]
        );
        
        if (meterRows.length > 0) {
          const meter = meterRows[0];
          if (meter.pending_relay_action !== targetAction) {
            console.log(`[Schedule] Meter ${meter.id} time is ${currentTime}, setting pending_relay_action to ${targetAction}`);
            await pool.query(
              'UPDATE electricity_meters SET pending_relay_action = ? WHERE id = ?',
              [targetAction, meter.id]
            );
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in processDailySchedules:', error);
  }
}

// Run every minute to check schedule thresholds
function startScheduleCron() {
  cron.schedule('* * * * *', () => {
    processDailySchedules();
  });
  console.log('Daily Relay Schedule Cron Job started (runs every minute).');
}

module.exports = { startScheduleCron };
