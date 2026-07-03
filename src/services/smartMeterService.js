const pool = require('../config/database');

function normalizeMac(mac) {
  return mac.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
}

function formatMac(normalized) {
  if (normalized.length !== 12) {
    return normalized;
  }

  const pairs = normalized.match(/.{1,2}/g);
  return pairs.join(':');
}

function meterNumberToAddress(meterNumber) {
  const digits = meterNumber.replace(/\D/g, '');
  if (digits === '') {
    return 'AAAAAAAAAAAA';
  }

  const normalized = digits.slice(-12).padStart(12, '0');
  const bytes = [];

  for (let i = 5; i >= 0; i--) {
    const pair = normalized.slice(i * 2, i * 2 + 2);
    const value = parseInt(pair[0], 10) * 16 + parseInt(pair[1], 10);
    bytes.push(value.toString(16).toUpperCase().padStart(2, '0'));
  }

  return bytes.join('');
}

async function findByMac(mac) {
  const normalized = normalizeMac(mac);

  const [rows] = await pool.query(
    `SELECT * FROM meters
     WHERE REPLACE(UPPER(bluetooth_mac), ':', '') = ?
     LIMIT 1`,
    [normalized]
  );

  return rows[0] ?? null;
}

async function registerByMac(mac, meterNumber = null, tariff = null, locationData = {}) {
  const normalizedMac = normalizeMac(mac);
  const formattedMac = formatMac(normalizedMac);
  const { latitude = null, longitude = null, installation_date = null } = locationData;

  const existing = await findByMac(normalizedMac);

  if (existing) {
    // Check if it is linked to an electricity_meter
    const [linkedRows] = await pool.query(
      'SELECT id, meter_name FROM electricity_meters WHERE meter_number = ? LIMIT 1',
      [existing.meter_number]
    );

    if (linkedRows.length > 0) {
      const error = new Error('This meter is already registered');
      error.status = 422;
      throw error;
    }

    const updates = [];
    const params = [];

    if (meterNumber != null) {
      updates.push('meter_number = ?');
      params.push(meterNumber);
    }
    updates.push('bluetooth_mac = ?');
    params.push(formattedMac);
    if (tariff != null) {
      updates.push('tariff = ?');
      params.push(tariff);
    }
    
    // Update scan information
    updates.push('last_scan_date = NOW()');
    updates.push('scan_count = COALESCE(scan_count, 0) + 1');
    if (latitude) {
      updates.push('latitude = ?');
      params.push(latitude);
    }
    if (longitude) {
      updates.push('longitude = ?');
      params.push(longitude);
    }

    updates.push('updated_at = NOW()');
    params.push(existing.id);

    await pool.query(`UPDATE meters SET ${updates.join(', ')} WHERE id = ?`, params.slice());

    const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [existing.id]);
    return rows[0];
  }

  if (meterNumber) {
    const [byNumberRows] = await pool.query(
      'SELECT * FROM meters WHERE meter_number = ? LIMIT 1',
      [meterNumber]
    );

    if (byNumberRows.length) {
      const byNumber = byNumberRows[0];
      const updates = ['bluetooth_mac = ?'];
      const params = [formattedMac];

      if (tariff != null) {
        updates.push('tariff = ?');
        params.push(tariff);
      }
      updates.push('meter_address = ?');
      params.push(meterNumberToAddress(meterNumber));
      
      updates.push('last_scan_date = NOW()');
      updates.push('scan_count = COALESCE(scan_count, 0) + 1');
      if (latitude) {
        updates.push('latitude = ?');
        params.push(latitude);
      }
      if (longitude) {
        updates.push('longitude = ?');
        params.push(longitude);
      }

      updates.push('updated_at = NOW()');
      params.push(byNumber.id);

      await pool.query(`UPDATE meters SET ${updates.join(', ')} WHERE id = ?`, params);

      const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [byNumber.id]);
      return rows[0];
    }
  }

  const resolvedNumber = meterNumber ?? `BLE-${normalizedMac.slice(-8)}`;

  const [result] = await pool.query(
    `INSERT INTO meters (
      meter_number, bluetooth_mac, meter_address, tariff, status, created_at, updated_at,
      latitude, longitude, installation_date, first_scan_date, scan_count, last_scan_date
    ) VALUES (?, ?, ?, ?, 'active', NOW(), NOW(), ?, ?, COALESCE(?, NOW()), NOW(), 1, NOW())`,
    [
      resolvedNumber,
      formattedMac,
      meterNumberToAddress(resolvedNumber),
      tariff ?? 8,
      latitude,
      longitude,
      installation_date,
    ]
  );
  
  const meterId = result.insertId;

  // Insert location log
  if (latitude || longitude) {
    await pool.query(
      `INSERT INTO location_logs (meter_id, latitude, longitude, accuracy, scan_date, created_at)
       VALUES (?, ?, ?, NULL, NOW(), NOW())`,
      [meterId, latitude, longitude]
    );
  }

  // Insert installation log
  await pool.query(
    `INSERT INTO installation_logs (meter_id, installed_by, installation_date, notes, created_at)
     VALUES (?, NULL, COALESCE(?, NOW()), 'Meter registered via API', NOW())`,
    [meterId, installation_date]
  );

  const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [meterId]);
  return rows[0];
}

async function syncRelay(meter, relayStatus) {
  await pool.query(
    'UPDATE meters SET relay_status = ?, updated_at = NOW() WHERE id = ?',
    [relayStatus, meter.id]
  );

  await pool.query(
    `INSERT INTO relay_logs (meter_id, action, command_hex, response_hex, status, action_time, created_at)
     VALUES (?, ?, NULL, NULL, 'SUCCESS', NOW(), NOW())`,
    [meter.id, relayStatus]
  );

  await pool.query(
    `INSERT INTO event_logs (meter_id, event_type, message, created_at)
     VALUES (?, ?, ?, NOW())`,
    [meter.id, 'RELAY_TOGGLE', `Relay was manually synced to ${relayStatus} via API`]
  );

  const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [meter.id]);
  return rows[0];
}

function formatMacForStorage(mac) {
  const normalized = normalizeMac(mac);
  return formatMac(normalized);
}

module.exports = {
  normalizeMac,
  findByMac,
  registerByMac,
  syncRelay,
  formatMacForStorage,
};
