const express = require('express');

const authRouter = require('./auth');
const ownerRouter = require('./owner');
const tenantRouter = require('./tenant');
const masterRouter = require('./master');
const smartMetersRouter = require('./smartMeters');
const bluetoothRouter = require('./bluetooth');
const usageRouter = require('./usage');
const mqttRouter = require('./mqtt');
const meterCommandsRouter = require('./meterCommands');
const complaintsRouter = require('./complaints');
const expensesRouter = require('./expenses');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Prepaid Meter & Tenant Billing API',
    version: '1.0',
    runtime: 'node'
  });
});

router.use('/auth', authRouter);
router.use('/owner', ownerRouter);
router.use('/tenant', tenantRouter);
router.use('/master', masterRouter);
router.use('/smart-meters', smartMetersRouter);
router.use('/bluetooth', bluetoothRouter);
router.use('/usage', usageRouter);
router.use('/mqtt', mqttRouter);
router.use('/complaints', complaintsRouter);
router.use('/expenses', expensesRouter);
router.use('/', meterCommandsRouter);

module.exports = router;