const pool = require('../config/database');

/**
 * Deduct prepaid balance for units consumed (kWh × tariff).
 */
async function deductBalanceForConsumption(electricityMeter, unitsConsumed, conn = pool) {
  if (unitsConsumed <= 0) {
    return electricityMeter;
  }

  const tariff = Number(electricityMeter.tariff_per_unit);
  const charge = Math.round(unitsConsumed * tariff * 100) / 100;
  const newBalance = Math.max(
    0,
    Math.round((Number(electricityMeter.current_balance) - charge) * 100) / 100
  );

  let gracePeriodQuery = '';
  let queryParams = [newBalance, electricityMeter.last_reading];

  if (newBalance <= 0 && Number(electricityMeter.current_balance) > 0) {
    gracePeriodQuery = ', grace_period_ends_at = DATE_ADD(CURDATE(), INTERVAL 5 DAY) + INTERVAL 11 HOUR';
  }

  await conn.query(
    `UPDATE electricity_meters
     SET current_balance = ?, last_reading = ?${gracePeriodQuery}, updated_at = NOW()
     WHERE id = ?`,
    [...queryParams, electricityMeter.id]
  );

  const [rows] = await conn.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [
    electricityMeter.id,
  ]);

  return rows[0];
}

/**
 * Queue BLE relay OFF when balance is 0; ON when balance restored after trip.
 */
async function syncPendingRelayFromBalance(smartMeter, electricityMeter, conn = pool) {
  const balance = Number(electricityMeter.current_balance);

  if (balance <= 0) {
    const isGraceActive = electricityMeter.grace_period_ends_at && new Date(electricityMeter.grace_period_ends_at) > new Date();
    if (!isGraceActive) {
      await conn.query(
        'UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?',
        ['OFF', smartMeter.id]
      );
      return 'OFF';
    }
    return null;
  }

  if (smartMeter.relay_status === 'OFF') {
    await conn.query(
      'UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?',
      ['ON', smartMeter.id]
    );
    return 'ON';
  }

  await conn.query(
    'UPDATE meters SET pending_relay_action = NULL, updated_at = NOW() WHERE id = ?',
    [smartMeter.id]
  );

  return null;
}

async function resolveElectricityMeter(smartMeter, conn = pool) {
  const [rows] = await conn.query(
    `SELECT * FROM electricity_meters
     WHERE meter_number = ? AND status = 'active'
     LIMIT 1`,
    [smartMeter.meter_number]
  );

  return rows[0] ?? null;
}

module.exports = {
  deductBalanceForConsumption,
  syncPendingRelayFromBalance,
  resolveElectricityMeter,
};
