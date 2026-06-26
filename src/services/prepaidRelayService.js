const pool = require('../config/database');

/**
 * Deduct prepaid balance for units consumed (kWh × tariff).
 */
async function deductBalanceForConsumption(electricityMeter, unitsConsumed, totalReading, conn = pool) {
  if (unitsConsumed <= 0 && (!totalReading || totalReading <= Number(electricityMeter.last_reading))) {
    return electricityMeter;
  }

  const newReading = totalReading && totalReading > Number(electricityMeter.last_reading) 
    ? totalReading 
    : electricityMeter.last_reading;

  if (electricityMeter.meter_type === 'postpaid') {
    // For postpaid, we do not deduct balance, just update reading
    await conn.query(
      `UPDATE electricity_meters
       SET last_reading = ?, updated_at = NOW()
       WHERE id = ?`,
      [newReading, electricityMeter.id]
    );
  } else {
    // Prepaid: Deduct balance
    const tariff = Number(electricityMeter.tariff_per_unit);
    const charge = Math.round(unitsConsumed * tariff * 100) / 100;
    const newBalance = Math.max(
      0,
      Math.round((Number(electricityMeter.current_balance) - charge) * 100) / 100
    );

    await conn.query(
      `UPDATE electricity_meters
       SET current_balance = ?, last_reading = ?, updated_at = NOW()
       WHERE id = ?`,
      [newBalance, newReading, electricityMeter.id]
    );
  }

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

  // If balance is depleted, force it OFF immediately.
  if (balance <= 0) {
    if (smartMeter.pending_relay_action !== 'OFF') {
      await conn.query(
        'UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?',
        ['OFF', smartMeter.id]
      );
    }
    return 'OFF';
  }

  // If balance is positive, just return whatever action is currently pending (like from a schedule).
  // We no longer automatically force ON here or clear to NULL, because payments/schedules manage that explicitly.
  return smartMeter.pending_relay_action;
}

async function resolveElectricityMeter(smartMeter) {
  const [rows] = await pool.query(
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
