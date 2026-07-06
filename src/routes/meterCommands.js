const express = require('express');
const { ok, fail } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const diMasterService = require('../services/diMasterService');

const router = express.Router();

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

router.get('/meter-commands', async (req, res, next) => {
  try {
    const pool = require('../config/database');
    const clauses = [];
    const params = [];

    if (req.query.meter_id) {
      clauses.push('meter_id = ?');
      params.push(Number(req.query.meter_id));
    }
    if (req.query.di_code) {
      clauses.push('di_code = ?');
      params.push(diMasterService.normalizeDiCode(req.query.di_code));
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT * FROM meter_commands ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    );
    return ok(res, rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
