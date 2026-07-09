const express = require('express');
const { ok, fail } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const diMasterService = require('../services/diMasterService');
const meterCommandLogService = require('../services/meterCommandLogService');

const router = express.Router();


// ========== NEW: DYNAMIC COMMANDS ========== (Public/Unauthenticated)

router.get('/dynamic-commands', async (req, res, next) => {
  try {
    const pool = require('../config/database');
    const [rows] = await pool.query('SELECT * FROM dynamic_meter_commands');
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

router.post('/dynamic-commands/log', async (req, res, next) => {
  try {
    const pool = require('../config/database');
    const { meter_id, command_name, request_hex, response_hex, status } = req.body;
    let mappedType = command_name || 'unknown';
    switch (command_name) {
      case 'enable_schedule':
      case 'Programming Enable':
      case 'Programming Enable (broadcast)':
      case 'write_cutoff_schedule':
      case 'write_date':
      case 'write_time':
        mappedType = 'write';
        break;

      case 'relay_control_on':
      case 'relay_control_off':
      case 'relay_trip_schedule':
        mappedType = 'relay';
        break;

      default:
        mappedType = 'read';
    }

    await pool.query(
      `INSERT INTO meter_commands_log
        (meter_id, electricity_meter_id, command_type, di_code, command_name, source, channel, request_hex, response_hex, status, created_at)
       VALUES (?, ?, ?, 'DYNAMIC', ?, 'ble', 'flutter', ?, ?, ?, NOW())`,
      [meter_id || 0, meter_id || 0, mappedType, command_name, request_hex, response_hex, status || 'pending']
    );

    console.log(`\n======================================================`);
    console.log(`🔌 DYNAMIC COMMAND LOG RECEIVED`);
    console.log(`Meter ID : ${meter_id}`);
    console.log(`Command  : ${command_name}`);
    console.log(`Status   : ${status}`);
    console.log(`Req HEX  : ${request_hex || 'None'}`);
    console.log(`Res HEX  : ${response_hex || 'None'}`);
    console.log(`======================================================\n`);

    return ok(res, {}, 'Execution logged successfully', 201);
  } catch (e) {
    next(e);
  }
});

router.use(authenticate);

router.get('/di-master', async (req, res, next) => {
  try {
    const rows = await diMasterService.listDiMaster();
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

router.get('/di-master/:diCode', async (req, res, next) => {
  try {
    const row = await diMasterService.getByDiCode(req.params.diCode);
    if (!row) {
      return fail(res, 'DI code not found.', 404);
    }
    return ok(res, row);
  } catch (e) {
    next(e);
  }
});

router.post('/di-master', async (req, res, next) => {
  try {
    if (!['owner', 'master'].includes(req.user.role) && !req.user.is_property_owner) {
      return fail(res, 'Only owners or master can add DI definitions.', 403);
    }

    const row = await diMasterService.createDiMaster(req.body);
    return ok(res, row, 'DI definition created.', 201);
  } catch (e) {
    if (e.status) return fail(res, e.message, e.status);
    next(e);
  }
});

router.get('/command-queue', async (req, res, next) => {
  try {
    const rows = await diMasterService.listCommandQueue({
      meterId: req.query.meter_id,
      status: req.query.status,
    });
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

router.post('/command-queue', async (req, res, next) => {
  try {
    const { meter_id: meterId, di_code: diCode, payload, command_type: commandType } = req.body;
    const result = await diMasterService.queueCommand({
      meterId,
      diCode,
      payload,
      commandType,
    });
    return ok(res, result, 'Command queued for meter.', 201);
  } catch (e) {
    if (e.status) return fail(res, e.message, e.status);
    next(e);
  }
});

router.patch('/command-queue/:id', async (req, res, next) => {
  try {
    const row = await diMasterService.updateCommandQueue(req.params.id, req.body);
    return ok(res, row, 'Command queue updated.');
  } catch (e) {
    if (e.status) return fail(res, e.message, e.status);
    next(e);
  }
});

router.get('/meter-commands-log', async (req, res, next) => {
  try {
    const rows = await meterCommandLogService.listCommands({
      meterId: req.query.meter_id,
      electricityMeterId: req.query.electricity_meter_id,
      controlCode: req.query.control_code,
      relayCmd: req.query.relay_cmd,
      status: req.query.status,
      limit: req.query.limit,
    });
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

/** @deprecated use GET /meter-commands-log */
router.get('/meter-commands', async (req, res, next) => {
  try {
    const rows = await meterCommandLogService.listCommands({
      meterId: req.query.meter_id,
      controlCode: req.query.control_code,
      limit: req.query.limit,
    });
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;