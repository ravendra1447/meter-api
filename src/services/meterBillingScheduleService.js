const pool = require('../config/database');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function formatDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return value.replace('T', ' ').slice(0, 19);
  }
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function jsonStringify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }

  return parts;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  const target = { year, month, day, hour, minute, second: 0 };
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  for (let i = 0; i < 5; i++) {
    const parts = getZonedParts(new Date(utcMs), timeZone);
    const diffMs =
      (target.year - parts.year) * 365.25 * 24 * 3600000 +
      (target.month - parts.month) * 30 * 24 * 3600000 +
      (target.day - parts.day) * 24 * 3600000 +
      (target.hour - parts.hour) * 3600000 +
      (target.minute - parts.minute) * 60000 +
      (target.second - parts.second) * 1000;

    utcMs += diffMs;
    if (Math.abs(diffMs) < 1000) break;
  }

  return new Date(utcMs);
}

function addMonthsZoned(year, month, months, timeZone) {
  let targetMonth = month + months;
  let targetYear = year;

  while (targetMonth > 12) {
    targetMonth -= 12;
    targetYear += 1;
  }
  while (targetMonth < 1) {
    targetMonth += 12;
    targetYear -= 1;
  }

  const maxDay = daysInMonth(targetYear, targetMonth);
  return { year: targetYear, month: targetMonth, day: maxDay };
}

async function authorizeMeter(ownerId, electricityMeterId) {
  const [rows] = await pool.query(
    `SELECT em.*, p.owner_id
     FROM electricity_meters em
     INNER JOIN properties p ON p.id = em.property_id
     WHERE em.id = ?
     LIMIT 1`,
    [electricityMeterId]
  );

  if (!rows.length) {
    throw httpError(404, 'Electricity meter not found');
  }

  if (rows[0].owner_id !== ownerId) {
    throw httpError(403, 'You do not have access to this meter.');
  }

  return rows[0];
}

async function authorizeSchedule(ownerId, schedule) {
  if (schedule.owner_id !== ownerId) {
    throw httpError(403, 'You do not have access to this schedule.');
  }
}

async function resolveSmartMeter(electricityMeter, smartMeterId) {
  const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [smartMeterId]);

  if (!rows.length) {
    throw httpError(404, 'Smart meter not found');
  }

  const smartMeter = rows[0];

  if (smartMeter.meter_number !== electricityMeter.meter_number) {
    throw httpError(422, 'Smart meter number does not match electricity meter.');
  }

  return smartMeter;
}

function computeNextRun(data) {
  const timeZone = data.timezone || 'Asia/Kolkata';
  const now = new Date();
  const nowParts = getZonedParts(now, timeZone);

  const [hourStr, minuteStr] = String(data.run_time || '00:00').split(':');
  const hour = Number(hourStr) || 0;
  const minute = Number(minuteStr) || 0;
  const runDay = Number(data.run_day ?? nowParts.day);

  if ((data.schedule_type || 'monthly') === 'monthly') {
    const currentMonthDays = daysInMonth(nowParts.year, nowParts.month);
    let candidateDay = Math.min(runDay, currentMonthDays);

    let candidate = zonedDateTimeToUtc(
      nowParts.year,
      nowParts.month,
      candidateDay,
      hour,
      minute,
      timeZone
    );

    const nowUtc = now.getTime();
    if (candidate.getTime() <= nowUtc) {
      const next = addMonthsZoned(nowParts.year, nowParts.month, 1, timeZone);
      const nextMonthDays = daysInMonth(next.year, next.month);
      candidateDay = Math.min(runDay, nextMonthDays);
      candidate = zonedDateTimeToUtc(next.year, next.month, candidateDay, hour, minute, timeZone);
    }

    return formatDateTime(candidate);
  }

  let candidate = zonedDateTimeToUtc(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    hour,
    minute,
    timeZone
  );

  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowParts = getZonedParts(tomorrow, timeZone);
    candidate = zonedDateTimeToUtc(
      tomorrowParts.year,
      tomorrowParts.month,
      tomorrowParts.day,
      hour,
      minute,
      timeZone
    );
  }

  return formatDateTime(candidate);
}

async function loadSchedule(scheduleId) {
  const [rows] = await pool.query('SELECT * FROM meter_billing_schedules WHERE id = ? LIMIT 1', [
    scheduleId,
  ]);

  if (!rows.length) {
    throw httpError(404, 'Schedule not found');
  }

  return rows[0];
}

async function create(ownerId, data) {
  const electricityMeter = await authorizeMeter(ownerId, data.meter_id);

  let smartMeterId = data.smart_meter_id ?? null;

  if (smartMeterId) {
    await resolveSmartMeter(electricityMeter, smartMeterId);
  } else {
    const [smartRows] = await pool.query(
      'SELECT id FROM meters WHERE meter_number = ? LIMIT 1',
      [electricityMeter.meter_number]
    );
    smartMeterId = smartRows.length ? smartRows[0].id : null;
  }

  const nextRun = computeNextRun(data);

  const [result] = await pool.query(
    `INSERT INTO meter_billing_schedules
      (owner_id, electricity_meter_id, smart_meter_id, schedule_type, schedule_name,
       run_time, run_day, timezone, data_points, protocol, action, billing, notifications,
       status, next_run, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      ownerId,
      electricityMeter.id,
      smartMeterId,
      data.schedule_type,
      data.schedule_name,
      data.run_time,
      data.run_day ?? null,
      data.timezone ?? 'Asia/Kolkata',
      jsonStringify(data.data_points ?? []),
      jsonStringify(data.protocol ?? null),
      data.action ?? 'read_data',
      jsonStringify(data.billing ?? []),
      jsonStringify(data.notifications ?? []),
      data.status ?? 'active',
      nextRun,
    ]
  );

  // Sync to schedules table if there's a relay schedule
  if (data.billing && smartMeterId) {
    const b = data.billing;
    if (b.relay_schedule_type && b.relay_schedule_type !== 'none') {
      let scheduleTime = null;
      if (b.relay_schedule_type === 'once' && b.relay_off_date && b.relay_off_time) {
        scheduleTime = `${b.relay_off_date} ${b.relay_off_time}:00`;
      } else if (b.relay_schedule_type === 'daily' && b.relay_off_time) {
        const today = new Date().toISOString().split('T')[0];
        scheduleTime = `${today} ${b.relay_off_time}:00`;
      } else if (b.relay_off_time) {
        const today = new Date().toISOString().split('T')[0];
        scheduleTime = `${today} ${b.relay_off_time}:00`;
      }

      if (scheduleTime) {
        await pool.query(
          `INSERT INTO schedules (meter_id, action, di_code, schedule_time, repeat_type, is_active, created_at)
           VALUES (?, 'OFF', NULL, ?, ?, 1, NOW())`,
          [smartMeterId, scheduleTime, b.relay_schedule_type.toUpperCase()]
        );
      }
    }
  }

  return loadSchedule(result.insertId);
}

async function update(schedule, ownerId, data) {
  await authorizeSchedule(ownerId, schedule);

  const updates = [];
  const values = [];

  if (data.meter_id !== undefined) {
    const electricityMeter = await authorizeMeter(ownerId, data.meter_id);
    updates.push('electricity_meter_id = ?');
    values.push(electricityMeter.id);
    schedule.electricity_meter_id = electricityMeter.id;
  }

  if (data.smart_meter_id !== undefined) {
    const electricityMeterId = data.electricity_meter_id ?? schedule.electricity_meter_id;
    const [electricityRows] = await pool.query(
      'SELECT * FROM electricity_meters WHERE id = ? LIMIT 1',
      [electricityMeterId]
    );

    if (electricityRows.length) {
      await resolveSmartMeter(electricityRows[0], data.smart_meter_id);
    }

    updates.push('smart_meter_id = ?');
    values.push(data.smart_meter_id);
    schedule.smart_meter_id = data.smart_meter_id;
  }

  const scalarFields = [
    'schedule_type',
    'schedule_name',
    'run_time',
    'run_day',
    'timezone',
    'action',
    'status',
  ];

  for (const field of scalarFields) {
    if (data[field] !== undefined && data[field] !== null) {
      updates.push(`${field} = ?`);
      values.push(data[field]);
      schedule[field] = data[field];
    }
  }

  const jsonFields = ['data_points', 'protocol', 'billing', 'notifications'];
  for (const field of jsonFields) {
    if (data[field] !== undefined && data[field] !== null) {
      updates.push(`${field} = ?`);
      values.push(jsonStringify(data[field]));
      schedule[field] = data[field];
    }
  }

  if (updates.length) {
    updates.push('updated_at = NOW()');
    values.push(schedule.id);
    await pool.query(
      `UPDATE meter_billing_schedules SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
  }

  if (
    data.run_time !== undefined ||
    data.run_day !== undefined ||
    data.schedule_type !== undefined
  ) {
    const fresh = await loadSchedule(schedule.id);
    const nextRun = computeNextRun(fresh);
    await pool.query(
      'UPDATE meter_billing_schedules SET next_run = ?, updated_at = NOW() WHERE id = ?',
      [nextRun, schedule.id]
    );
  }

  // Sync to schedules table if there's a relay schedule update
  if (data.billing && schedule.smart_meter_id) {
    const b = data.billing;
    if (b.relay_schedule_type && b.relay_schedule_type !== 'none') {
      let scheduleTime = null;
      if (b.relay_schedule_type === 'once' && b.relay_off_date && b.relay_off_time) {
        scheduleTime = `${b.relay_off_date} ${b.relay_off_time}:00`;
      } else if (b.relay_schedule_type === 'daily' && b.relay_off_time) {
        const today = new Date().toISOString().split('T')[0];
        scheduleTime = `${today} ${b.relay_off_time}:00`;
      } else if (b.relay_off_time) {
        const today = new Date().toISOString().split('T')[0];
        scheduleTime = `${today} ${b.relay_off_time}:00`;
      }

      if (scheduleTime) {
        await pool.query(
          `INSERT INTO schedules (meter_id, action, di_code, schedule_time, repeat_type, is_active, created_at)
           VALUES (?, 'OFF', NULL, ?, ?, 1, NOW())`,
          [schedule.smart_meter_id, scheduleTime, b.relay_schedule_type.toUpperCase()]
        );
      }
    }
  }

  return loadSchedule(schedule.id);
}

async function formatSchedule(schedule) {
  let relayStatus = schedule.last_relay_status;

  if (!relayStatus && schedule.smart_meter_id) {
    const [smartRows] = await pool.query(
      'SELECT relay_status FROM meters WHERE id = ? LIMIT 1',
      [schedule.smart_meter_id]
    );
    relayStatus = smartRows.length ? smartRows[0].relay_status : null;
  }

  relayStatus = relayStatus || 'ON';

  return {
    id: schedule.id,
    meter_id: schedule.electricity_meter_id,
    smart_meter_id: schedule.smart_meter_id,
    schedule_name: schedule.schedule_name,
    schedule_type: schedule.schedule_type,
    run_time: schedule.run_time,
    run_day: schedule.run_day,
    timezone: schedule.timezone,
    last_run: formatDateTime(schedule.last_run),
    next_run: formatDateTime(schedule.next_run),
    data_points: parseJson(schedule.data_points, []),
    protocol: parseJson(schedule.protocol, null),
    action: schedule.action,
    billing: parseJson(schedule.billing, null),
    notifications: parseJson(schedule.notifications, null),
    billing_status: {
      bill_generated: !!schedule.bill_generated,
      units_used: schedule.last_units_used != null ? Number(schedule.last_units_used) : null,
      amount: schedule.last_amount != null ? Number(schedule.last_amount) : null,
      due_date: formatDate(schedule.last_due_date),
      grace_end: formatDate(schedule.last_grace_end),
      disconnect_date: formatDate(schedule.last_disconnect_date),
      status: schedule.last_billing_status,
    },
    relay_status: relayStatus,
    status: schedule.status,
  };
}

module.exports = {
  create,
  update,
  formatSchedule,
  computeNextRun,
};
