const express = require('express');
const pool = require('../config/database');
const { fail } = require('../utils/response');
const meterReadingService = require('../services/meterReadingService');
const smartMeterService = require('../services/smartMeterService');

const router = express.Router();

router.post('/reading', async (req, res, next) => {
  try {
    const {
      meter_id: meterId,
      total_reading: totalReading,
      voltage,
      current,
      relay_status: relayStatus,
      bluetooth_mac: bluetoothMac,
    } = req.body;

    if (meterId == null || totalReading == null) {
      return fail(res, 'meter_id and total_reading are required.', 422);
    }

    const result = await meterReadingService.saveReading(
      Number(meterId),
      Number(totalReading),
      voltage != null ? Number(voltage) : null,
      current != null ? Number(current) : null,
      relayStatus ?? null,
      bluetoothMac ?? null
    );

    return res.json({
      success: true,
      daily_consumption: result.daily_consumption,
      monthly_usage: result.monthly_usage,
      bill_amount: result.bill_amount,
      current_balance: result.current_balance ?? null,
      balance_depleted: result.balance_depleted ?? false,
      relay_action_required: result.relay_action_required ?? null,
      pending_relay_action: result.pending_relay_action ?? null,
    });
  } catch (e) {
    if (e.status) return fail(res, e.message, e.status);
    next(e);
  }
});

router.post('/relay', async (req, res, next) => {
  try {
    const { meter_id: meterId, relay_status: relayStatus } = req.body;

    if (meterId == null) {
      return fail(res, 'The meter id field is required.', 422);
    }

    if (!relayStatus || !['ON', 'OFF'].includes(relayStatus)) {
      return fail(res, 'The relay status field must be ON or OFF.', 422);
    }

    const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [meterId]);
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

module.exports = router;
