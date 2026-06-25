const pool = require('../config/database');

const TYPE_ELECTRICITY = 'electricity_consumption';
const STATUS_ACTIVE = 'active';

async function loadConsumptionWithRelations(conn, consumptionId) {
  const [consumptionRows] = await conn.query(
    'SELECT * FROM electricity_consumptions WHERE id = ? LIMIT 1',
    [consumptionId]
  );
  const consumption = consumptionRows[0];

  const [propertyRows] = await conn.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [
    consumption.property_id,
  ]);
  const [meterRows] = await conn.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [
    consumption.meter_id,
  ]);

  let creator = null;
  if (consumption.created_by) {
    const [creatorRows] = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [
      consumption.created_by,
    ]);
    creator = creatorRows[0] ?? null;
  }

  consumption.property = propertyRows[0] ?? null;
  consumption.meter = meterRows[0] ?? null;
  consumption.creator = creator;

  return consumption;
}

async function record(data, createdBy) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [propertyRows] = await conn.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [
      data.property_id,
    ]);
    if (!propertyRows.length) {
      const err = new Error('Property not found.');
      err.status = 404;
      throw err;
    }
    const property = propertyRows[0];

    const [meterRows] = await conn.query(
      'SELECT * FROM electricity_meters WHERE id = ? AND property_id = ? LIMIT 1',
      [data.meter_id, property.id]
    );
    if (!meterRows.length) {
      const err = new Error('Meter not found.');
      err.status = 404;
      throw err;
    }
    const meter = meterRows[0];

    if (meter.status !== 'active') {
      const err = new Error('Meter is not active.');
      err.status = 400;
      throw err;
    }

    const [tenantAssignmentRows] = await conn.query(
      `SELECT * FROM property_tenants
       WHERE property_id = ? AND status = 'active'
       LIMIT 1`,
      [property.id]
    );
    if (!tenantAssignmentRows.length) {
      const err = new Error('No active tenant found for this property.');
      err.status = 400;
      throw err;
    }
    const tenantAssignment = tenantAssignmentRows[0];

    const units = Number(data.total_consumed_units);
    const tariff = Number(meter.tariff_per_unit);
    const totalAmount = Math.round(units * tariff * 100) / 100;
    const previousReading = Number(meter.last_reading ?? 0);
    const currentReading = previousReading + units;

    const [insertResult] = await conn.query(
      `INSERT INTO electricity_consumptions (
        property_id, meter_id, previous_reading, current_reading,
        total_consumed_units, tariff_per_unit, total_amount,
        calculation_date, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        property.id,
        meter.id,
        previousReading,
        currentReading,
        units,
        tariff,
        totalAmount,
        data.calculation_date,
        createdBy.id,
      ]
    );

    await conn.query(
      'UPDATE electricity_meters SET last_reading = ?, updated_at = NOW() WHERE id = ?',
      [currentReading, meter.id]
    );

    if (meter.meter_type === 'prepaid') {
      const newBalance = Math.max(0, Number(meter.current_balance) - totalAmount);
      await conn.query(
        'UPDATE electricity_meters SET current_balance = ?, updated_at = NOW() WHERE id = ?',
        [newBalance, meter.id]
      );
    }

    await conn.query(
      `INSERT INTO tenant_unbilled_charges (
        tenant_id, electricity_consumption_id, activity_type, amount,
        created_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        tenantAssignment.tenant_id,
        insertResult.insertId,
        TYPE_ELECTRICITY,
        totalAmount,
        createdBy.id,
        STATUS_ACTIVE,
      ]
    );

    await conn.commit();

    return loadConsumptionWithRelations(conn, insertResult.insertId);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  record,
};
