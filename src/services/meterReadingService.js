const pool = require('../config/database');
const prepaidRelayService = require('./prepaidRelayService');
const smartMeterService = require('./smartMeterService');

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function saveReading(
  meterId,
  totalReading,
  voltage = null,
  current = null,
  relayStatus = null,
  bluetoothMac = null
) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // FIX: Get meter with property_id via electricity_meters
    const [meters] = await conn.query(
      `SELECT m.*, em.property_id, em.id AS em_id 
       FROM meters m 
       LEFT JOIN electricity_meters em ON m.meter_number = em.meter_number 
       WHERE m.id = ? FOR UPDATE`,
      [meterId]
    );

    if (!meters.length) {
      throw httpError(404, 'Meter not found');
    }

    let meter = meters[0];

    // FIX: Check if property exists
    if (meter.property_id === null || meter.property_id === undefined) {
      throw httpError(400, 'Meter is not associated with any property');
    }

    if (meter.status !== 'active') {
      throw httpError(400, 'Meter is not active.');
    }

    const isBleSync = bluetoothMac !== null && String(bluetoothMac).trim() !== '';

    if (!isBleSync && totalReading < Number(meter.current_reading)) {
      throw httpError(400, 'Reading cannot be less than current meter reading.');
    }

    if (isBleSync && totalReading < Number(meter.month_start_reading)) {
      await conn.query('UPDATE meters SET month_start_reading = ?, updated_at = NOW() WHERE id = ?', [
        totalReading,
        meterId,
      ]);
      const [refreshed] = await conn.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [meterId]);
      meter = refreshed[0];
    }

    let monthlyUsage = round2(totalReading - Number(meter.month_start_reading));
    monthlyUsage = Math.max(0, monthlyUsage);

    const [previousRows] = await conn.query(
      'SELECT total_reading FROM meter_readings WHERE meter_id = ? ORDER BY id DESC LIMIT 1',
      [meterId]
    );
    const previousReading = previousRows.length ? previousRows[0].total_reading : null;

    let dailyConsumption =
      previousReading !== null ? round2(totalReading - Number(previousReading)) : 0;
    if (dailyConsumption < 0) {
      dailyConsumption = 0;
    }

    const today = todayDateString();

    await conn.query(
      `INSERT INTO meter_readings
        (meter_id, reading_date, total_reading, daily_consumption, voltage, current, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [meterId, today, totalReading, dailyConsumption, voltage, current]
    );

    // Track real-time telemetry
    if ((voltage !== null || current !== null) && meter.em_id) {
      const p = (voltage && current) ? round2(voltage * current) : 0;
      await conn.query(
        `INSERT INTO instantaneous_data
          (meter_id, voltage, current, power, frequency, recorded_at, created_at)
         VALUES (?, ?, ?, ?, 50.0, NOW(), NOW())`,
        [meter.em_id, voltage, current, p]
      );
    }

    // FIX: Use property_id from the joined query instead of NULL
    const billAmount = round2(Math.max(0, monthlyUsage) * Number(meter.tariff));
    await conn.query(
      `INSERT INTO electricity_consumptions
        (property_id, meter_id, previous_reading, current_reading, total_consumed_units, tariff_per_unit, total_amount, calculation_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
      [meter.property_id, meterId, meter.month_start_reading, totalReading, Math.max(0, monthlyUsage), meter.tariff, billAmount]
    );

    const meterUpdates = ['current_reading = ?', 'monthly_usage = ?', 'updated_at = NOW()'];
    const meterValues = [totalReading, Math.max(0, monthlyUsage)];

    if (relayStatus !== null) {
      meterUpdates.push('relay_status = ?');
      meterValues.push(relayStatus);
    }

    if (bluetoothMac) {
      meterUpdates.push('bluetooth_mac = ?');
      meterValues.push(smartMeterService.formatMacForStorage(bluetoothMac));
    }

    meterValues.push(meterId);
    await conn.query(`UPDATE meters SET ${meterUpdates.join(', ')} WHERE id = ?`, meterValues);

    let relayActionRequired = null;
    let currentBalance = null;

    if (isBleSync) {
      const electricityMeter = await prepaidRelayService.resolveElectricityMeter(meter, conn);
      if (electricityMeter) {
        const updatedElectricityMeter = await prepaidRelayService.deductBalanceForConsumption(
          electricityMeter,
          dailyConsumption,
          conn
        );
        currentBalance = Number(updatedElectricityMeter.current_balance);

        const [freshMeterRows] = await conn.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [
          meterId,
        ]);
        relayActionRequired = await prepaidRelayService.syncPendingRelayFromBalance(
          freshMeterRows[0],
          updatedElectricityMeter,
          conn
        );
      }
    }

    const [finalMeterRows] = await conn.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [meterId]);
    const finalMeter = finalMeterRows[0];

    await conn.commit();

    return {
      daily_consumption: dailyConsumption,
      monthly_usage: Math.max(0, monthlyUsage),
      bill_amount: round2(Math.max(0, monthlyUsage) * Number(meter.tariff)),
      current_balance: currentBalance,
      balance_depleted: currentBalance !== null && currentBalance <= 0,
      relay_action_required: relayActionRequired,
      pending_relay_action: finalMeter.pending_relay_action,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function dailyUsage(meterId) {
  const [meterRows] = await pool.query('SELECT id FROM meters WHERE id = ? LIMIT 1', [meterId]);
  if (!meterRows.length) {
    throw httpError(404, 'Meter not found');
  }

  const [readings] = await pool.query(
    `SELECT reading_date, total_reading, daily_consumption
     FROM meter_readings
     WHERE meter_id = ?
     ORDER BY reading_date ASC, id ASC`,
    [meterId]
  );

  return readings.map((reading) => ({
    date: typeof reading.reading_date === 'string'
      ? reading.reading_date.slice(0, 10)
      : reading.reading_date,
    total_reading: Number(reading.total_reading),
    daily_consumption: Number(reading.daily_consumption),
  }));
}

async function dashboard(meterId) {
  const [meterRows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [meterId]);
  if (!meterRows.length) {
    throw httpError(404, 'Meter not found');
  }

  const meter = meterRows[0];
  const today = todayDateString();

  const [todayRows] = await pool.query(
    `SELECT daily_consumption
     FROM meter_readings
     WHERE meter_id = ? AND reading_date = ?
     ORDER BY id DESC
     LIMIT 1`,
    [meterId, today]
  );

  const monthlyUsage = Number(meter.monthly_usage);
  const tariff = Number(meter.tariff);

  return {
    meter_id: meter.id,
    meter_number: meter.meter_number,
    current_reading: Number(meter.current_reading),
    month_start_reading: Number(meter.month_start_reading),
    monthly_usage: monthlyUsage,
    today_consumption: todayRows.length ? Number(todayRows[0].daily_consumption) : 0,
    tariff,
    bill_amount: round2(monthlyUsage * tariff),
    relay_status: meter.relay_status,
    status: meter.status,
  };
}

module.exports = {
  saveReading,
  dailyUsage,
  dashboard,
};