const express = require('express');

const authRouter = require('./auth');
const ownerRouter = require('./owner');
const tenantRouter = require('./tenant');
const masterRouter = require('./master');
const smartMetersRouter = require('./smartMeters');
const bluetoothRouter = require('./bluetooth');
const usageRouter = require('./usage');
const mqttRouter = require('./mqtt');
const locationRouter = require('./locationRoutes'); // ADD THIS

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Prepaid Meter & Tenant Billing API',
    version: '1.0',
    runtime: 'node',
    endpoints: {
      auth: {
        'POST /api/auth/owner/register': 'Register property owner',
        'POST /api/auth/tenant/register': 'Register tenant (requires property_code)',
        'POST /api/auth/login': 'Login with mobile + password',
        'GET /api/auth/me': 'Current user (Bearer token)',
        'POST /api/auth/logout': 'Logout (Bearer token)',
      },
      owner: {
        'GET /api/owner/properties': 'List properties',
        'POST /api/owner/properties': 'Create property',
        'GET /api/owner/properties/{id}': 'Property details',
        'POST /api/owner/properties/{id}/meters': 'Add electricity meter',
        'GET /api/owner/meters-with-location': 'Get meters with location',
      },
      master: {
        'GET /api/master/dashboard': 'Stats overview',
        'CRUD /api/master/owners': 'Manage all owners',
        'CRUD /api/master/properties': 'Manage all properties',
        'CRUD /api/master/tenants': 'Manage all tenants',
        'CRUD /api/master/meters': 'Manage all meters',
      },
      tenant: {
        'GET /api/tenant/property': 'View linked property',
        'GET /api/tenant/meters': 'View meters',
      },
      web_panel: 'http://127.0.0.1:8000/master/login',
      bluetooth: {
        'POST /api/bluetooth/reading': 'Save meter reading from Flutter app',
        'POST /api/bluetooth/relay': 'Sync relay ON/OFF after BLE command',
        'GET /api/usage/daily/{meterId}': 'Daily consumption history',
        'GET /api/smart-meters': 'List smart meters',
        'GET /api/smart-meters/by-mac/{mac}': 'Find meter by Bluetooth MAC',
        'POST /api/smart-meters/register': 'Auto-register meter by MAC',
        'GET /api/smart-meters/{meterId}/dashboard': 'Meter dashboard data',
        'POST /api/smart-meters': 'Register new smart meter',
      },
      // ========== LOCATION ENDPOINTS ==========
      location: {
        'POST /api/meters/location': 'Save meter GPS location',
        'POST /api/meters/installation': 'Save meter installation date',
        'GET /api/meters/{meterId}/scan-info': 'Get meter scan information',
        'GET /api/meters/location-history/{meterId}': 'Get location history',
        'GET /api/meters/installation-logs/{meterId}': 'Get installation logs',
        'GET /api/owner/meters-with-location': 'Get meters with location (owner)',
      },
      mqtt: {
        'POST /api/mqtt/uplink': 'MQTT uplink webhook stub',
      },
    },
    note: 'Use Master Web Panel for full management. Login: 9999999999 / master123',
  });
});

// ========== REGISTER ROUTES ==========
router.use('/auth', authRouter);
router.use('/owner', ownerRouter);
router.use('/tenant', tenantRouter);
router.use('/master', masterRouter);
router.use('/smart-meters', smartMetersRouter);
router.use('/bluetooth', bluetoothRouter);
router.use('/usage', usageRouter);
router.use('/mqtt', mqttRouter);
router.use('/', locationRouter); // ADD THIS - No prefix needed

module.exports = router;