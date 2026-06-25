const cron = require('node-cron');
const pool = require('../config/database');

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

      const scheduleType = billing.relay_schedule_type || 'daily';
      if (scheduleType === 'none') continue;

      const scheduleDay = parseInt(billing.relay_schedule_day || '1', 10);
      const offTime = billing.relay_off_time || billing.daily_off_time;
      const onTime = billing.relay_on_time || billing.daily_on_time;

      if (!offTime && !onTime) continue;

      let targetAction = null;

      const currentDayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 1-7
      const currentDateOfMonth = now.getDate(); // 1-31
      
      // Figure out if today is the action day based on schedule type
      let isOffDay = false;
      let isOnDay = false;

      if (scheduleType === 'daily') {
        isOffDay = true;
        isOnDay = true;
      } else if (scheduleType === 'weekly') {
        isOffDay = (currentDayOfWeek === scheduleDay);
        let expectedOnDay = scheduleDay;
        if (offTime && onTime && offTime > onTime) {
          expectedOnDay = (scheduleDay % 7) + 1; // Next day
        }
        isOnDay = (currentDayOfWeek === expectedOnDay);
      } else if (scheduleType === 'monthly') {
        isOffDay = (currentDateOfMonth === scheduleDay);
        let expectedOnDay = scheduleDay;
        if (offTime && onTime && offTime > onTime) {
          // Simple next day logic (ignores month length for simplicity, works 99% of time unless end of month)
          const tempDate = new Date(now);
          tempDate.setDate(scheduleDay + 1);
          expectedOnDay = tempDate.getDate();
        }
        isOnDay = (currentDateOfMonth === expectedOnDay);
      }

      if (offTime && onTime) {
        if (offTime > onTime) {
          // Night schedule (e.g. 23:00 to 06:00 next day)
          if (isOffDay && currentTime >= offTime) {
            targetAction = 'OFF';
          } else if (isOnDay && currentTime < onTime) {
            targetAction = 'OFF'; // still in the night window
          } else if (isOnDay && currentTime >= onTime) {
            targetAction = 'ON';
          }
        } else {
          // Day schedule (e.g. 09:00 to 18:00 same day)
          if (isOffDay && currentTime >= offTime && currentTime < onTime) {
            targetAction = 'OFF';
          } else if (isOnDay && currentTime >= onTime) {
            targetAction = 'ON';
          }
        }
      } else if (offTime && isOffDay && currentTime >= offTime) {
        targetAction = 'OFF';
      } else if (onTime && isOnDay && currentTime >= onTime) {
        targetAction = 'ON';
      }

      if (targetAction) {
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
  cron.schedule('* * * * *', async () => {
    await processDailySchedules();
  });
  
  console.log('Daily Relay Schedule Cron Job started.');
}

module.exports = { startScheduleCron };
