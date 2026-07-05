const express = require('express');
const pool = require('../config/database');
const { ok, fail } = require('../utils/response');
const smartMeterService = require('../services/smartMeterService');
const meterReadingService = require('../services/meterReadingService');

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
    
    // Format date for MySQL
    const formattedDate = new Date(cutoff_date).toISOString().slice(0, 19).replace('T', ' ');

    await pool.query(
      `UPDATE meters SET next_cutoff_date = ?, pending_schedule_sync = true, updated_at = NOW() WHERE id = ?`,
      [formattedDate, req.params.meterId]
    );
    return ok(res, { message: 'Cutoff date updated manually' });
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

module.exports = router;
