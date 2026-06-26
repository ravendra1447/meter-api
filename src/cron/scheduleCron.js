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

    console.log(`[Schedule] Found ${schedules.length} active schedules`);
    
    // Log all schedules for debugging
    if (schedules.length > 0) {
      console.log(`[Schedule] Schedules:`, JSON.stringify(schedules.map(s => ({
        id: s.id,
        electricity_meter_id: s.electricity_meter_id,
        schedule_type: s.schedule_type,
        run_time: s.run_time,
        billing: s.billing
      })), null, 2));
    }

    if (!schedules.length) return;

    const now = new Date();

    for (const schedule of schedules) {
      if (!schedule.billing) {
        console.log(`[Schedule] Schedule ${schedule.id} has no billing data, skipping`);
        continue;
      }
      
      const tz = schedule.timezone || 'Asia/Kolkata';
      const tzDateString = now.toLocaleString('en-US', { timeZone: tz });
      const tzDate = new Date(tzDateString);
      
      const hours = tzDate.getHours().toString().padStart(2, '0');
      const minutes = tzDate.getMinutes().toString().padStart(2, '0');
      const currentTime = `${hours}:${minutes}`;
      
      const billing = typeof schedule.billing === 'string' 
        ? JSON.parse(schedule.billing) 
        : schedule.billing;

      console.log(`[Schedule] Processing schedule ${schedule.id}:`, billing);

      const scheduleType = billing.relay_schedule_type || 'daily';
      if (scheduleType === 'none') continue;

      const scheduleDay = parseInt(billing.relay_schedule_day || '1', 10);
      const offTime = billing.relay_off_time || billing.daily_off_time;
      const onTime = billing.relay_on_time || billing.daily_on_time;

      console.log(`[Schedule] OffTime: ${offTime}, OnTime: ${onTime}, CurrentTime: ${currentTime}`);

      if (!offTime && !onTime) {
        console.log(`[Schedule] No relay times set, skipping`);
        continue;
      }

      let targetAction = null;

      const currentDayOfWeek = tzDate.getDay() === 0 ? 7 : tzDate.getDay(); // 1-7
      const currentDateOfMonth = tzDate.getDate(); // 1-31
      
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
      } else if (scheduleType === 'once') {
        const year = tzDate.getFullYear();
        const month = (tzDate.getMonth() + 1).toString().padStart(2, '0');
        const day = tzDate.getDate().toString().padStart(2, '0');
        const currentDateString = `${year}-${month}-${day}`;
        
        if (billing.relay_off_date && billing.relay_off_date === currentDateString) {
          isOffDay = true;
        }
        if (billing.relay_on_date && billing.relay_on_date === currentDateString) {
          isOnDay = true;
        }
      }

      // Trigger within 2 minutes of scheduled time to handle server restarts/delays
      // Check if current time is within 2 minutes after scheduled time
      const [offHour, offMin] = offTime ? offTime.split(':').map(Number) : [0, 0];
      const [onHour, onMin] = onTime ? onTime.split(':').map(Number) : [0, 0];
      const currentHour = tzDate.getHours();
      const currentMin = tzDate.getMinutes();
      const currentTotalMinutes = currentHour * 60 + currentMin;
      
      const offTotalMinutes = offHour * 60 + offMin;
      const onTotalMinutes = onHour * 60 + onMin;
      
      console.log(`[Schedule] Time check: current=${currentTotalMinutes}, off=${offTotalMinutes}, on=${onTotalMinutes}`);
      console.log(`[Schedule] Day check: isOffDay=${isOffDay}, isOnDay=${isOnDay}`);
      
      // Allow trigger if within 2 minutes after scheduled time
      const offWithinWindow = offTime && isOffDay && 
        (currentTotalMinutes >= offTotalMinutes && currentTotalMinutes <= offTotalMinutes + 2);
      const onWithinWindow = onTime && isOnDay && 
        (currentTotalMinutes >= onTotalMinutes && currentTotalMinutes <= onTotalMinutes + 2);
      
      console.log(`[Schedule] Window check: offWithinWindow=${offWithinWindow}, onWithinWindow=${onWithinWindow}`);
      
      if (offWithinWindow) {
        targetAction = 'OFF';
        console.log(`[Schedule] Setting targetAction to OFF`);
      } else if (onWithinWindow) {
        targetAction = 'ON';
        console.log(`[Schedule] Setting targetAction to ON`);
      } else {
        console.log(`[Schedule] No action triggered - time window not matched`);
      }

      if (targetAction) {
        const [meterRows] = await pool.query(
          'SELECT id, pending_relay_action FROM electricity_meters WHERE id = ?',
          [schedule.electricity_meter_id]
        );
        
        if (meterRows.length > 0) {
          const meter = meterRows[0];
          console.log(`[Schedule] Meter ${meter.id} time is ${currentTime}, setting pending_relay_action to ${targetAction}`);
          console.log(`[Schedule] Schedule ID: ${schedule.id}, Type: ${scheduleType}, OffTime: ${offTime}, OnTime: ${onTime}`);
          
          const [result1] = await pool.query(
            'UPDATE electricity_meters SET pending_relay_action = ? WHERE id = ? AND pending_relay_action != ?',
            [targetAction, meter.id, targetAction]
          );
          console.log(`[Schedule] Updated electricity_meters: ${result1.affectedRows} rows`);
          
          // Also update legacy meters table so the UI reflects it instantly, AND BLE sync will pick up the pending action
          const [result2] = await pool.query(
            'UPDATE meters SET pending_relay_action = ?, relay_status = ? WHERE meter_number = (SELECT meter_number FROM electricity_meters WHERE id = ?) AND (relay_status != ? OR pending_relay_action != ?)',
            [targetAction, targetAction, meter.id, targetAction, targetAction]
          );
          console.log(`[Schedule] Updated meters table: ${result2.affectedRows} rows`);
        } else {
          console.log(`[Schedule] Meter ${schedule.electricity_meter_id} not found`);
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
