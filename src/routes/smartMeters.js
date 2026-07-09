const express = require('express');
const pool = require('../config/database');
const { ok, fail } = require('../utils/response');
const smartMeterService = require('../services/smartMeterService');
const meterReadingService = require('../services/meterReadingService');

// Hex Helper Functions for DL/T 645
function add33Hex(str) {
  const num = parseInt(str, 16) + 0x33;
  return num.toString(16).toUpperCase().padStart(2, '0');
}

function calcCS(frameStr) {
  const bytes = frameStr.replace(/\s+/g, '').match(/.{1,2}/g) || [];
  let sum = 0;
  for (let b of bytes) sum += parseInt(b, 16);
  return (sum % 256).toString(16).toUpperCase().padStart(2, '0');
}

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, meter_number, bluetooth_mac, meter_address, relay_status, tariff, next_cutoff_date, pending_schedule_sync
       FROM meters
       WHERE status = 'active'
       ORDER BY meter_number ASC`
    );
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const { bluetooth_mac: bluetoothMac, meter_number: meterNumber, tariff, latitude, longitude, installation_date } = req.body;

    if (!bluetoothMac) {
      return fail(res, 'The bluetooth mac field is required.', 422);
    }

    const meter = await smartMeterService.registerByMac(
      bluetoothMac,
      meterNumber ?? null,
      tariff != null ? Number(tariff) : null,
      {
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        installation_date: installation_date ?? new Date(),
      }
    );

    return res.status(200).json({
      success: true,
      registered: true,
      data: meter,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/by-mac/:mac', async (req, res, next) => {
  try {
    const meter = await smartMeterService.findByMac(req.params.mac);

    if (!meter) {
      return fail(res, 'Meter not registered for this MAC address.', 404);
    }

    return ok(res, meter);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { meter_number: meterNumber, bluetooth_mac: bluetoothMac, meter_address: meterAddress, tariff, latitude, longitude, installation_date } =
      req.body;

    if (!meterNumber) {
      return fail(res, 'The meter number field is required.', 422);
    }

    const [existing] = await pool.query('SELECT id FROM meters WHERE meter_number = ? LIMIT 1', [meterNumber]);
    if (existing.length) {
      return fail(res, 'The meter number has already been taken.', 422);
    }

    const [result] = await pool.query(
      `INSERT INTO meters (meter_number, bluetooth_mac, meter_address, tariff, status, created_at, updated_at, latitude, longitude, installation_date, first_scan_date, scan_count, last_scan_date)
       VALUES (?, ?, ?, ?, 'active', NOW(), NOW(), ?, ?, COALESCE(?, NOW()), NOW(), 1, NOW())`,
      [meterNumber, bluetoothMac ?? null, meterAddress ?? null, tariff ?? 8, latitude ?? null, longitude ?? null, installation_date ?? null]
    );

    const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [result.insertId]);
    return ok(res, rows[0], null, 201);
  } catch (e) {
    next(e);
  }
});

router.get('/:meterId/dashboard', async (req, res, next) => {
  try {
    const data = await meterReadingService.dashboard(Number(req.params.meterId));
    return ok(res, data);
  } catch (e) {
    if (e.status === 404) return fail(res, e.message, 404);
    next(e);
  }
});

router.post('/:meterId/set-cutoff', async (req, res, next) => {
  try {
    const { cutoff_date } = req.body;
    if (!cutoff_date) return fail(res, 'cutoff_date is required', 422);
    
    // Fix: Do not use new Date().toISOString() as it converts local time to UTC (-5.5 hours)
    // Flutter sends '2026-08-05T19:00:00.000', we just need '2026-08-05 19:00:00'
    const formattedDate = cutoff_date.substring(0, 19).replace('T', ' ');
    const timeOnly = formattedDate.split(' ')[1];

    // 1. Check if the ID belongs to electricity_meters
    const [emRows] = await pool.query('SELECT meter_number FROM electricity_meters WHERE id = ?', [req.params.meterId]);
    
    let actualMeterId = req.params.meterId; // fallback

    if (emRows.length > 0) {
      const meterNumber = emRows[0].meter_number;
      // Update meters table by meter_number
      await pool.query(
        `UPDATE meters SET next_cutoff_date = ?, pending_schedule_sync = true, updated_at = NOW() WHERE meter_number = ?`,
        [formattedDate, meterNumber]
      );

      // We need the ACTUAL meters.id for meter_relay_schedules foreign key
      const [mRows] = await pool.query('SELECT id FROM meters WHERE meter_number = ? LIMIT 1', [meterNumber]);
      if (mRows.length > 0) {
        actualMeterId = mRows[0].id;
      }
    } else {
      // Fallback: update meters table directly by ID
      await pool.query(
        `UPDATE meters SET next_cutoff_date = ?, pending_schedule_sync = true, updated_at = NOW() WHERE id = ?`,
        [formattedDate, actualMeterId]
      );
    }

    // 2. Also save it in meter_relay_schedules as requested
    await pool.query(
      `INSERT INTO meter_relay_schedules (meter_id, action, schedule_time, is_active, created_at, updated_at) VALUES (?, 'ON', ?, 1, NOW(), NOW())`,
      [actualMeterId, timeOnly]
    );

    // 3. DYNAMIC HEX GENERATION
    // Fetch configs for this meter
    let meterNumStr = '010051140526';
    if (emRows.length > 0) meterNumStr = emRows[0].meter_number;

    const [configs] = await pool.query('SELECT param_key, param_value FROM meter_config WHERE meter_id = ?', [actualMeterId]);
    const configMap = {};
    for (let row of configs) configMap[row.param_key] = row.param_value;
    
    const passHex = configMap['password'] || '02000000';
    const oprHex = configMap['operator_code'] || '00000000';

    const passFormatted = passHex.match(/.{1,2}/g).map(add33Hex).join(' '); 
    const oprFormatted = oprHex.match(/.{1,2}/g).map(add33Hex).join(' '); 

    // Address bytes NOT reversed, as per your exact requirement
    const addrBytes = meterNumStr.padStart(12, '0').match(/.{1,2}/g).join(' '); 

    // Time Formatting: ss mm hh dd MM YY
    const parts = formattedDate.split(/[- :]/); // e.g., '2026', '08', '05', '19', '00', '00'
    const YY = parts[0].slice(-2);
    const MM = parts[1];
    const dd = parts[2];
    const hh = parts[3];
    const mm = parts[4];
    const ss = parts[5];
    const timeHex = [ss, mm, hh, dd, MM, YY].map(add33Hex).join(' ');

    // N1 = 1A (+33), N2 = 00 (+33)
    const n1Hex = add33Hex('1A');
    const n2Hex = add33Hex('00');

    // Assembly (Relay Control = 1C) exactly as requested
    const lengthHex = '10'; // 16 bytes: 4(Pass) + 4(Opr) + 1(N1) + 1(N2) + 6(Time)
    const frameBody = `68 ${addrBytes} 68 1C ${lengthHex} ${passFormatted} ${oprFormatted} ${n1Hex} ${n2Hex} ${timeHex}`;
    const cs = calcCS(frameBody);
    const command_hex = `FE FE FE FE\n${frameBody}\n${cs}\n16`;

    return ok(res, { 
      message: 'Cutoff date updated manually and saved to schedule table',
      command_hex: command_hex 
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:meter/relay-capabilities', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [req.params.meter]);
    if (!rows.length) return fail(res, 'Meter not found.', 404);

    const meter = rows[0];
    const mqttConfigured = Boolean(process.env.MQTT_BROKER_URL);

    return ok(res, {
      meter_id: meter.id,
      meter_number: meter.meter_number,
      sim_enabled: Boolean(meter.sim_enabled),
      mqtt_online: Boolean(meter.mqtt_online),
      mqtt_configured: mqttConfigured,
      last_mqtt_at: meter.last_mqtt_at ?? null,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:meter/relay-command', async (req, res, next) => {
  try {
    const { action } = req.body;

    if (!action || !['ON', 'OFF'].includes(action)) {
      return fail(res, 'The action field must be ON or OFF.', 422);
    }

    if (!process.env.MQTT_BROKER_URL) {
      return res.status(503).json({
        success: false,
        mqtt_configured: false,
        message: 'MQTT broker not configured. Add MQTT_BROKER_URL to server .env',
      });
    }

    return res.status(503).json({
      success: false,
      mqtt_configured: true,
      message: '4G relay via MQTT is not implemented in Node API yet.',
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/:meter/relay', async (req, res, next) => {
  try {
    const { relay_status: relayStatus } = req.body;

    if (!relayStatus || !['ON', 'OFF'].includes(relayStatus)) {
      return fail(res, 'The relay status field must be ON or OFF.', 422);
    }

    const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [req.params.meter]);
    if (!rows.length) return fail(res, 'Meter not found.', 404);

    const meter = await smartMeterService.syncRelay(rows[0], relayStatus);

    return res.json({
      success: true,
      relay_status: meter.relay_status,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:meterId/sync-schedule', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, pending_schedule_sync FROM meters WHERE id = ? LIMIT 1', [req.params.meterId]);
    if (!rows.length) return fail(res, 'Meter not found.', 404);

    await pool.query('UPDATE meters SET pending_schedule_sync = false, updated_at = NOW() WHERE id = ?', [req.params.meterId]);

    return res.json({
      success: true,
      message: 'Schedule sync confirmed successfully',
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:meterId/log-packet', async (req, res, next) => {
  try {
    const { request_hex, response_hex, command_type, di_code, status, parsed, direction, frame, parsed_data } = req.body;
    const meterId = req.params.meterId;
    
    // Log to raw_packets
    await pool.query(
      `INSERT INTO raw_packets (meter_id, request_hex, response_hex, parsed, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [meterId, request_hex, response_hex, parsed ? 1 : 0]
    );

    // Log to meter_commands if it's a specific command type
    if (command_type) {
      await pool.query(
        `INSERT INTO meter_commands (meter_id, command_type, di_code, request_hex, response_hex, status, retry_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
        [meterId, command_type, di_code || null, request_hex, response_hex, status || 'COMPLETED']
      );
    }
    
    // Log to dl645_logs
    if (frame || parsed_data) {
      await pool.query(
        `INSERT INTO dl645_logs (meter_id, direction, frame, parsed_data, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [meterId, direction || 'TX', frame || request_hex || response_hex, parsed_data ? JSON.stringify(parsed_data) : null]
      );
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('Failed to log packet:', e);
    return res.json({ success: false, error: e.message });
  }
});

router.post('/:meterId/load-profile', async (req, res, next) => {
  try {
    const meterId = req.params.meterId;
    const { di_code, value, record_date } = req.body;
    
    if (!di_code || value === undefined) {
      return fail(res, 'di_code and value are required', 422);
    }

    await pool.query(
      `INSERT INTO load_profiles (meter_id, di_code, value, record_date, created_at)
       VALUES (?, ?, ?, COALESCE(?, CURDATE()), NOW())`,
      [meterId, di_code, value, record_date || null]
    );

    return res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.post('/:meterId/schedule', async (req, res, next) => {
  try {
    const meterId = req.params.meterId;
    const { action, di_code, schedule_time, repeat_type, is_active } = req.body;
    
    if (!action || !schedule_time) {
      return fail(res, 'action and schedule_time are required', 422);
    }

    const [result] = await pool.query(
      `INSERT INTO schedules (meter_id, action, di_code, schedule_time, repeat_type, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [meterId, action, di_code || null, schedule_time, repeat_type || 'NONE', is_active !== false]
    );

    const [rows] = await pool.query('SELECT * FROM schedules WHERE id = ? LIMIT 1', [result.insertId]);
    return res.json({ success: true, schedule: rows[0] });
  } catch (e) {
    next(e);
  }
});

router.get('/:meterId/config', async (req, res, next) => {
  try {
    const meterId = req.params.meterId;
    const [rows] = await pool.query('SELECT param_key, param_value FROM meter_config WHERE meter_id = ?', [meterId]);
    const config = {};
    for (const row of rows) {
      config[row.param_key] = row.param_value;
    }
    return res.json({ success: true, config });
  } catch (e) {
    next(e);
  }
});

router.post('/:meterId/config', async (req, res, next) => {
  try {
    const meterId = req.params.meterId;
    const { param_key, param_value } = req.body;
    
    if (!param_key) {
      return fail(res, 'param_key is required', 422);
    }

    await pool.query(
      `INSERT INTO meter_config (meter_id, param_key, param_value, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), updated_at = NOW()`,
      [meterId, param_key, param_value]
    );

    return res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
