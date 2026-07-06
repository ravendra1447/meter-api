const pool = require('../config/database');

function normalizeDiCode(raw) {
  const hex = String(raw || '')
    .replace(/[^0-9A-Fa-f]/g, '')
    .toUpperCase();
  if (!hex || hex.length > 8) return null;
  return hex.padStart(8, '0');
}

function parseJsonField(value, fallback = []) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function formatDiRow(row) {
  if (!row) return null;
  const dataFields = parseJsonField(row.data_fields, []);
  const controlCode = String(row.control_code || '11').toUpperCase();
  const isRead = controlCode === '11';

  return {
    id: row.id,
    di: row.di_code,
    di_code: row.di_code,
    name: row.di_name,
    di_name: row.di_name,
    page: row.page,
    controlCode,
    control_code: controlCode,
    lengthType: row.length_type,
    length_type: row.length_type,
    needPA: Boolean(row.need_pa),
    need_pa: Boolean(row.need_pa),
    needPassword: Boolean(row.need_password),
    need_password: Boolean(row.need_password),
    needOperator: Boolean(row.need_operator),
    need_operator: Boolean(row.need_operator),
    dataFields,
    data_fields: dataFields,
    unit: row.unit,
    data_length: row.data_length,
    category: row.category || (isRead ? 'read' : 'write'),
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dlt645: {
      control: `0x${controlCode}`,
      command_type: isRead ? 'read' : 'write',
      di_bytes: row.di_code.match(/.{2}/g) || [],
    },
  };
}

async function listDiMaster() {
  const [rows] = await pool.query('SELECT * FROM di_master ORDER BY di_code ASC');
  return rows.map(formatDiRow);
}

async function getByDiCode(diCode) {
  const normalized = normalizeDiCode(diCode);
  if (!normalized) return null;

  const [rows] = await pool.query('SELECT * FROM di_master WHERE di_code = ? LIMIT 1', [normalized]);
  return formatDiRow(rows[0]);
}

async function createDiMaster(body) {
  const diCode = normalizeDiCode(body.di || body.di_code);
  if (!diCode) {
    const err = new Error('Valid di_code is required (up to 8 hex digits).');
    err.status = 422;
    throw err;
  }

  const diName = String(body.name || body.di_name || '').trim();
  if (!diName) {
    const err = new Error('name / di_name is required.');
    err.status = 422;
    throw err;
  }

  const dataFields = body.dataFields ?? body.data_fields ?? [];
  const controlCode = String(body.controlCode || body.control_code || '11')
    .replace(/^0x/i, '')
    .toUpperCase()
    .padStart(2, '0')
    .slice(-2);

  const [existing] = await pool.query('SELECT id FROM di_master WHERE di_code = ? LIMIT 1', [diCode]);
  if (existing.length) {
    const err = new Error(`DI code ${diCode} already exists.`);
    err.status = 422;
    throw err;
  }

  const [result] = await pool.query(
    `INSERT INTO di_master
      (di_code, di_name, page, control_code, length_type, need_pa, need_password, need_operator,
       data_fields, unit, data_length, category, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      diCode,
      diName,
      body.page ?? null,
      controlCode,
      body.lengthType || body.length_type || '04',
      (body.needPA ?? body.need_pa) ? 1 : 0,
      (body.needPassword ?? body.need_password) ? 1 : 0,
      (body.needOperator ?? body.need_operator) ? 1 : 0,
      JSON.stringify(Array.isArray(dataFields) ? dataFields : []),
      body.unit ?? null,
      body.data_length ?? body.dataLength ?? null,
      body.category ?? (controlCode === '11' ? 'read' : 'write'),
      body.description ?? null,
    ]
  );

  const [rows] = await pool.query('SELECT * FROM di_master WHERE id = ? LIMIT 1', [result.insertId]);
  return formatDiRow(rows[0]);
}

async function queueCommand({ meterId, diCode, payload, commandType }) {
  const normalizedDi = normalizeDiCode(diCode);
  if (!normalizedDi) {
    const err = new Error('Valid di_code is required.');
    err.status = 422;
    throw err;
  }

  const meter = Number(meterId);
  if (!meter) {
    const err = new Error('meter_id is required.');
    err.status = 422;
    throw err;
  }

  const [meterRows] = await pool.query('SELECT id FROM meters WHERE id = ? LIMIT 1', [meter]);
  if (!meterRows.length) {
    const err = new Error('Meter not found.');
    err.status = 404;
    throw err;
  }

  const di = await getByDiCode(normalizedDi);
  if (!di) {
    const err = new Error(`DI code ${normalizedDi} not found in di_master.`);
    err.status = 404;
    throw err;
  }

  const resolvedType =
    commandType ||
    di.dlt645.command_type ||
    (di.controlCode === '11' ? 'read' : 'write');

  const [result] = await pool.query(
    `INSERT INTO command_queue
      (meter_id, command_type, di_code, payload, status, retry_count, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, NOW())`,
    [meter, resolvedType, normalizedDi, JSON.stringify(payload || {})]
  );

  const [logResult] = await pool.query(
    `INSERT INTO meter_commands
      (meter_id, command_type, di_code, status, retry_count, created_at)
     VALUES (?, ?, ?, 'pending', 0, NOW())`,
    [meter, resolvedType, normalizedDi]
  );

  const [rows] = await pool.query('SELECT * FROM command_queue WHERE id = ? LIMIT 1', [result.insertId]);

  return {
    queue: formatQueueRow(rows[0]),
    di,
    meter_command_id: logResult.insertId,
  };
}

function formatQueueRow(row) {
  if (!row) return null;
  let payload = {};
  if (row.payload) {
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch {
      payload = {};
    }
  }

  return {
    id: row.id,
    meter_id: row.meter_id,
    command_type: row.command_type,
    di_code: row.di_code,
    payload,
    status: row.status,
    retry_count: row.retry_count,
    created_at: row.created_at,
    sent_at: row.sent_at,
    ack_at: row.ack_at,
  };
}

async function listCommandQueue({ meterId, status }) {
  const clauses = [];
  const params = [];

  if (meterId) {
    clauses.push('meter_id = ?');
    params.push(Number(meterId));
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT * FROM command_queue ${where} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  return rows.map(formatQueueRow);
}

async function updateCommandQueue(id, body) {
  const queueId = Number(id);
  const [rows] = await pool.query('SELECT * FROM command_queue WHERE id = ? LIMIT 1', [queueId]);
  if (!rows.length) {
    const err = new Error('Command queue item not found.');
    err.status = 404;
    throw err;
  }

  const updates = [];
  const params = [];

  if (body.status) {
    updates.push('status = ?');
    params.push(body.status);
    if (body.status === 'sent') {
      updates.push('sent_at = NOW()');
    }
    if (body.status === 'acked') {
      updates.push('ack_at = NOW()');
    }
  }

  if (body.request_hex != null || body.response_hex != null) {
    const [cmdRows] = await pool.query(
      `SELECT id FROM meter_commands
       WHERE meter_id = ? AND di_code = ? AND status IN ('pending','sent')
       ORDER BY id DESC LIMIT 1`,
      [rows[0].meter_id, rows[0].di_code]
    );

    if (cmdRows.length) {
      const cmdUpdates = [];
      const cmdParams = [];
      if (body.request_hex != null) {
        cmdUpdates.push('request_hex = ?');
        cmdParams.push(body.request_hex);
      }
      if (body.response_hex != null) {
        cmdUpdates.push('response_hex = ?');
        cmdParams.push(body.response_hex);
      }
      if (body.status === 'acked' || body.status === 'success') {
        cmdUpdates.push("status = 'success'");
      } else if (body.status === 'failed') {
        cmdUpdates.push("status = 'failed'");
      }
      if (cmdUpdates.length) {
        cmdParams.push(cmdRows[0].id);
        await pool.query(
          `UPDATE meter_commands SET ${cmdUpdates.join(', ')} WHERE id = ?`,
          cmdParams
        );
      }
    }
  }

  if (!updates.length) {
    return formatQueueRow(rows[0]);
  }

  params.push(queueId);
  await pool.query(`UPDATE command_queue SET ${updates.join(', ')} WHERE id = ?`, params);

  const [updated] = await pool.query('SELECT * FROM command_queue WHERE id = ? LIMIT 1', [queueId]);
  return formatQueueRow(updated[0]);
}

module.exports = {
  normalizeDiCode,
  listDiMaster,
  getByDiCode,
  createDiMaster,
  queueCommand,
  listCommandQueue,
  updateCommandQueue,
};
