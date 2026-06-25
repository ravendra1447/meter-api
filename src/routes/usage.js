const express = require('express');
const { ok, fail } = require('../utils/response');
const meterReadingService = require('../services/meterReadingService');

const router = express.Router();

router.get('/daily/:meterId', async (req, res, next) => {
  try {
    const data = await meterReadingService.dailyUsage(Number(req.params.meterId));
    return ok(res, data);
  } catch (e) {
    if (e.status === 404) return fail(res, e.message, 404);
    next(e);
  }
});

module.exports = router;
