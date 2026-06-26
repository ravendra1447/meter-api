// cron/scheduleCron.js

const cron = require('node-cron');
const pool = require('../config/database');

/**
 * Main schedule processor - runs every minute
 * Handles both ON and OFF schedules with proper relay control
 */
async function processDailySchedules() {
  const now = new Date();
  console.log(`[${now.toISOString()}] ⏰ Checking schedules...`);

  try {
    // Get all active schedules with meter info
    const [schedules] = await pool.query(`
      SELECT 
        mbs.*,
        em.id as electricity_meter_id,
        em.meter_number,
        em.pending_relay_action as current_pending,
        em.current_balance,
        m.id as smart_meter_id,
        m.relay_status
      FROM meter_billing_schedules mbs
      INNER JOIN electricity_meters em ON em.id = mbs.electricity_meter_id
      LEFT JOIN meters m ON m.meter_number = em.meter_number
      WHERE mbs.status = 'active'
        AND em.status = 'active'
    `);

    if (!schedules.length) {
      return;
    }

    let executedCount = 0;

    for (const schedule of schedules) {
      if (!schedule.billing) continue;

      let billing;
      try {
        billing = typeof schedule.billing === 'string' 
          ? JSON.parse(schedule.billing) 
          : schedule.billing;
      } catch (e) {
        console.error(`Error parsing billing for schedule ${schedule.id}`);
        continue;
      }

      const scheduleType = billing.relay_schedule_type || 'daily';
      if (scheduleType === 'none') continue;

      const scheduleDay = parseInt(billing.relay_schedule_day || '1', 10);
      const offTime = billing.relay_off_time || billing.daily_off_time || null;
      const onTime = billing.relay_on_time || billing.daily_on_time || null;

      if (!offTime && !onTime) continue;

      // Get current time in schedule's timezone
      const tz = schedule.timezone || 'Asia/Kolkata';
      const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      
      const currentTime = `${String(tzDate.getHours()).padStart(2, '0')}:${String(tzDate.getMinutes()).padStart(2, '0')}`;
      const currentDayOfWeek = tzDate.getDay() === 0 ? 7 : tzDate.getDay();
      const currentDateOfMonth = tzDate.getDate();
      const currentDateString = `${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}-${String(tzDate.getDate()).padStart(2, '0')}`;

      // Check if today is the scheduled day
      let isOffDay = false;
      let isOnDay = false;

      switch (scheduleType) {
        case 'daily':
          isOffDay = true;
          isOnDay = true;
          break;

        case 'weekly':
          isOffDay = (currentDayOfWeek === scheduleDay);
          let expectedOnDay = scheduleDay;
          if (offTime && onTime && offTime > onTime) {
            expectedOnDay = (scheduleDay % 7) + 1;
          }
          isOnDay = (currentDayOfWeek === expectedOnDay);
          break;

        case 'monthly':
          isOffDay = (currentDateOfMonth === scheduleDay);
          let expectedOnMonthDay = scheduleDay;
          if (offTime && onTime && offTime > onTime) {
            const tempDate = new Date(tzDate);
            tempDate.setDate(scheduleDay + 1);
            expectedOnMonthDay = tempDate.getDate();
          }
          isOnDay = (currentDateOfMonth === expectedOnMonthDay);
          break;

        case 'once':
          if (billing.relay_off_date && billing.relay_off_date === currentDateString) {
            isOffDay = true;
          }
          if (billing.relay_on_date && billing.relay_on_date === currentDateString) {
            isOnDay = true;
          }
          break;
      }

      // ========== OFF TIME - METER CUT ==========
      if (offTime && isOffDay) {
        const diff = timeDifference(currentTime, offTime);
        if (diff >= -2 && diff <= 2) {
          // Check if already executed today
          const [existing] = await pool.query(
            `SELECT id FROM schedule_execution_logs 
             WHERE schedule_id = ? AND action = 'OFF' 
             AND DATE(executed_at) = CURDATE()`,
            [schedule.id]
          );

          if (existing.length === 0) {
            console.log(`[Schedule] 🔴 OFF time reached for meter ${schedule.meter_number} at ${currentTime}`);
            await executeScheduleAction(schedule, 'OFF', schedule.electricity_meter_id, schedule.smart_meter_id);
            executedCount++;
          }
        }
      }

      // ========== ON TIME ==========
      if (onTime && isOnDay) {
        const diff = timeDifference(currentTime, onTime);
        if (diff >= -2 && diff <= 2) {
          const [existing] = await pool.query(
            `SELECT id FROM schedule_execution_logs 
             WHERE schedule_id = ? AND action = 'ON' 
             AND DATE(executed_at) = CURDATE()`,
            [schedule.id]
          );

          if (existing.length === 0) {
            console.log(`[Schedule] 🟢 ON time reached for meter ${schedule.meter_number} at ${currentTime}`);
            await executeScheduleAction(schedule, 'ON', schedule.electricity_meter_id, schedule.smart_meter_id);
            executedCount++;
          }
        }
      }
    }

    if (executedCount > 0) {
      console.log(`[${now.toISOString()}] ✅ ${executedCount} schedule(s) executed`);
    }

    // ========== CHECK BALANCE FOR AUTO OFF/ON ==========
    await checkBalanceAndRelay();

  } catch (error) {
    console.error('[Schedule] Error:', error);
  }
}

/**
 * Calculate time difference in minutes
 */
function timeDifference(currentTime, scheduledTime) {
  const [curHour, curMin] = currentTime.split(':').map(Number);
  const [schHour, schMin] = scheduledTime.split(':').map(Number);
  return (curHour * 60 + curMin) - (schHour * 60 + schMin);
}

/**
 * Execute a scheduled action
 */
async function executeScheduleAction(schedule, action, electricityMeterId, smartMeterId) {
  try {
    console.log(`[Schedule] Executing ${action} for meter ${schedule.meter_number}`);

    // Update electricity_meters table
    await pool.query(
      `UPDATE electricity_meters 
       SET pending_relay_action = ?, updated_at = NOW() 
       WHERE id = ?`,
      [action, electricityMeterId]
    );

    // Update meters table (for BLE sync)
    if (smartMeterId) {
      await pool.query(
        `UPDATE meters 
         SET pending_relay_action = ?, relay_status = ?, updated_at = NOW() 
         WHERE id = ?`,
        [action, action, smartMeterId]
      );
    }

    // Log execution
    await pool.query(
      `INSERT INTO schedule_execution_logs 
       (schedule_id, meter_id, action, executed_at, status) 
       VALUES (?, ?, ?, NOW(), 'pending')`,
      [schedule.id, electricityMeterId, action]
    );

    console.log(`[Schedule] ✅ ${action} action set for meter ${schedule.meter_number}`);

  } catch (error) {
    console.error(`[Schedule] ❌ Error executing ${action}:`, error);
  }
}

/**
 * Check balance and auto disconnect/reconnect
 */
async function checkBalanceAndRelay() {
  try {
    // ========== BALANCE <= 0 → OFF ==========
    const [meters] = await pool.query(`
      SELECT 
        em.id as electricity_meter_id,
        em.meter_number,
        em.current_balance,
        m.id as smart_meter_id,
        m.relay_status
      FROM electricity_meters em
      INNER JOIN meters m ON m.meter_number = em.meter_number
      WHERE em.status = 'active'
        AND em.current_balance <= 0
        AND m.relay_status = 'ON'
    `);

    for (const meter of meters) {
      console.log(`[Balance] 💰 Balance ₹${meter.current_balance} for meter ${meter.meter_number}, setting OFF...`);
      
      await pool.query(
        `UPDATE meters 
         SET pending_relay_action = 'OFF', relay_status = 'OFF', updated_at = NOW() 
         WHERE id = ?`,
        [meter.smart_meter_id]
      );

      await pool.query(
        `UPDATE electricity_meters 
         SET pending_relay_action = 'OFF', updated_at = NOW() 
         WHERE id = ?`,
        [meter.electricity_meter_id]
      );

      console.log(`[Balance] ✅ OFF action set for meter ${meter.meter_number}`);
    }

    // ========== BALANCE > 0 AND RELAY OFF → ON ==========
    const [positiveMeters] = await pool.query(`
      SELECT 
        em.id as electricity_meter_id,
        em.meter_number,
        em.current_balance,
        m.id as smart_meter_id,
        m.relay_status
      FROM electricity_meters em
      INNER JOIN meters m ON m.meter_number = em.meter_number
      WHERE em.status = 'active'
        AND em.current_balance > 0
        AND m.relay_status = 'OFF'
    `);

    for (const meter of positiveMeters) {
      console.log(`[Balance] 💰 Balance ₹${meter.current_balance} for meter ${meter.meter_number}, setting ON...`);
      
      await pool.query(
        `UPDATE meters 
         SET pending_relay_action = 'ON', relay_status = 'ON', updated_at = NOW() 
         WHERE id = ?`,
        [meter.smart_meter_id]
      );

      await pool.query(
        `UPDATE electricity_meters 
         SET pending_relay_action = 'ON', updated_at = NOW() 
         WHERE id = ?`,
        [meter.electricity_meter_id]
      );

      console.log(`[Balance] ✅ ON action set for meter ${meter.meter_number}`);
    }

  } catch (error) {
    console.error('[Balance] Error:', error);
  }
}

/**
 * Get pending relay actions (called from BLE service)
 */
async function getPendingRelayActions() {
  try {
    const [pendingMeters] = await pool.query(`
      SELECT 
        m.id as smart_meter_id,
        m.meter_number,
        m.pending_relay_action as action,
        m.relay_status as current_status,
        em.id as electricity_meter_id,
        em.current_balance
      FROM meters m
      INNER JOIN electricity_meters em ON em.meter_number = m.meter_number
      WHERE m.pending_relay_action IS NOT NULL
        AND m.pending_relay_action != ''
        AND m.pending_relay_action != m.relay_status
    `);

    return pendingMeters;
  } catch (error) {
    console.error('[Pending] Error:', error);
    return [];
  }
}

/**
 * Mark relay action as executed (called from BLE service after successful relay)
 */
async function markRelayExecuted(smartMeterId, action) {
  try {
    await pool.query(
      `UPDATE meters 
       SET pending_relay_action = NULL, relay_status = ?, updated_at = NOW() 
       WHERE id = ?`,
      [action, smartMeterId]
    );

    await pool.query(
      `UPDATE electricity_meters 
       SET pending_relay_action = NULL, updated_at = NOW() 
       WHERE meter_number = (SELECT meter_number FROM meters WHERE id = ?)`,
      [smartMeterId]
    );

    // Update execution log status
    await pool.query(
      `UPDATE schedule_execution_logs 
       SET status = 'executed', executed_at = NOW() 
       WHERE meter_id = (SELECT electricity_meter_id FROM meters WHERE id = ?) 
       AND action = ? 
       AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [smartMeterId, action]
    );

    console.log(`[Relay] ✅ ${action} executed for meter ${smartMeterId}`);
    return true;
  } catch (error) {
    console.error('[Relay] Error marking executed:', error);
    return false;
  }
}

/**
 * Start the schedule cron job
 */
function startScheduleCron() {
  cron.schedule('* * * * *', async () => {
    try {
      await processDailySchedules();
    } catch (error) {
      console.error('Schedule cron error:', error);
    }
  });

  console.log('✅ Relay Schedule Cron Job started (checking every minute)');

  // Run once on startup
  setTimeout(async () => {
    await processDailySchedules();
  }, 5000);
}

module.exports = {
  startScheduleCron,
  processDailySchedules,
  getPendingRelayActions,
  markRelayExecuted
};