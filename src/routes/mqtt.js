const express = require('express');
const { fail } = require('../utils/response');

const router = express.Router();

router.post('/uplink', async (req, res) => {
  const secret = process.env.MQTT_UPLINK_SECRET;
  if (secret && req.headers['x-mqtt-secret'] !== secret) {
    return fail(res, 'Unauthorized', 401);
  }

  const topic = req.body.topic ?? '/device/unknown/uplink';
  let payload = req.body.payload ?? req.body;

  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(res, 'Invalid payload', 422);
  }

  return res.json({
    success: true,
    message: 'Uplink received',
    topic,
    payload,
  });
});

module.exports = router;
