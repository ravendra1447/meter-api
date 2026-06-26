const pool = require('../config/database');
const paymentMethods = require('../utils/paymentMethods');

const STATUS_PENDING = 'pending';
const STATUS_APPROVED = 'approved';
const STATUS_REJECTED = 'rejected';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function formatDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

async function upsertTenantCharge(conn, tenantId, chargeType, amount) {
  const [existing] = await conn.query(
    'SELECT id FROM tenant_other_active_charges WHERE tenant_id = ? AND charge_type = ? LIMIT 1',
    [tenantId, chargeType]
  );

  if (existing.length) {
    await conn.query(
      'UPDATE tenant_other_active_charges SET amount = ?, status = ?, updated_at = NOW() WHERE id = ?',
      [amount, 'active', existing[0].id]
    );
    return;
  }

  await conn.query(
    `INSERT INTO tenant_other_active_charges
      (tenant_id, charge_type, amount, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', NOW(), NOW())`,
    [tenantId, chargeType, amount]
  );
}

async function searchProperty(query) {
  const like = `%${query}%`;

  const [rows] = await pool.query(
    `SELECT
       p.id, p.property_code, p.name, p.address, p.city, p.state, p.pincode,
       p.monthly_rent, p.maintenance_charges, p.water_charges, p.security_deposit_amount,
       u.name AS owner_name, u.mobile AS owner_mobile
     FROM properties p
     LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.status = 'active'
       AND (p.property_code = ? OR p.name LIKE ? OR p.address LIKE ?)
     LIMIT 1`,
    [query, like, like]
  );

  if (!rows.length) {
    return null;
  }

  const property = rows[0];

  return {
    id: property.id,
    property_code: property.property_code,
    name: property.name,
    address: property.address,
    city: property.city,
    state: property.state,
    pincode: property.pincode,
    monthly_rent: Number(property.monthly_rent),
    maintenance_charges: Number(property.maintenance_charges),
    water_charges: Number(property.water_charges),
    security_deposit_amount: Number(property.security_deposit_amount),
    owner: {
      name: property.owner_name,
      mobile: property.owner_mobile,
    },
  };
}

async function createRequest(tenant, propertyCode, message = null) {
  const [propertyRows] = await pool.query(
    'SELECT * FROM properties WHERE property_code = ? AND status = ? LIMIT 1',
    [propertyCode, 'active']
  );

  if (!propertyRows.length) {
    throw httpError(404, 'Property not found');
  }

  const property = propertyRows[0];

  const [assignmentRows] = await pool.query(
    `SELECT id FROM property_tenants
     WHERE tenant_id = ? AND property_id = ? AND status = 'active'
     LIMIT 1`,
    [tenant.id, property.id]
  );

  if (assignmentRows.length) {
    throw httpError(422, 'You are already linked to this property.');
  }

  const [pendingRows] = await pool.query(
    `SELECT id FROM tenant_property_requests
     WHERE tenant_id = ? AND property_id = ? AND status = ?
     LIMIT 1`,
    [tenant.id, property.id, STATUS_PENDING]
  );

  if (pendingRows.length) {
    throw httpError(422, 'A pending request already exists for this property.');
  }

  const [result] = await pool.query(
    `INSERT INTO tenant_property_requests
      (tenant_id, property_id, status, tenant_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [tenant.id, property.id, STATUS_PENDING, message]
  );

  const requestId = result.insertId;

  const [requestRows] = await pool.query(
    `SELECT
       tpr.*,
       p.id AS property_id, p.name AS property_name, p.property_code AS property_property_code,
       u.id AS tenant_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
     FROM tenant_property_requests tpr
     INNER JOIN properties p ON p.id = tpr.property_id
     INNER JOIN users u ON u.id = tpr.tenant_id
     WHERE tpr.id = ?
     LIMIT 1`,
    [requestId]
  );

  const row = requestRows[0];

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    property_id: row.property_id,
    status: row.status,
    tenant_message: row.tenant_message,
    owner_remark: row.owner_remark,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    property: {
      id: row.property_id,
      name: row.property_name,
      property_code: row.property_property_code,
    },
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      mobile: row.tenant_mobile,
      email: row.tenant_email,
    },
  };
}

async function approve(request, ownerId, terms) {
  const [propertyRows] = await pool.query(
    'SELECT * FROM properties WHERE id = ? LIMIT 1',
    [request.property_id]
  );

  if (!propertyRows.length) {
    throw httpError(404, 'Property not found');
  }

  const property = propertyRows[0];

  if (property.owner_id !== ownerId) {
    throw httpError(403, 'You do not have access to this request.');
  }

  if (request.status !== STATUS_PENDING) {
    throw httpError(422, 'This request has already been processed.');
  }

  const agreementFrom = new Date(terms.agreement_from);
  const agreementMonths = Number(terms.agreement_period_months);
  const agreementTo = terms.agreement_to
    ? new Date(terms.agreement_to)
    : addMonths(agreementFrom, agreementMonths);

  if (!terms.agreement_to) {
    agreementTo.setDate(agreementTo.getDate() - 1);
  }

  const moveInDate = terms.move_in_date ?? formatDate(agreementFrom);

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [assignmentResult] = await conn.query(
      `INSERT INTO property_tenants
        (property_id, tenant_id, move_in_date, status, monthly_rent, water_charges,
         maintenance_charges, security_deposit_amount, agreement_period_months,
         agreement_from, agreement_to, accepted_payment_methods, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        request.property_id,
        request.tenant_id,
        moveInDate,
        terms.monthly_rent,
        terms.water_charges,
        terms.maintenance_charges,
        terms.security_deposit_amount,
        agreementMonths,
        formatDate(agreementFrom),
        formatDate(agreementTo),
        paymentMethods.toJson(
          paymentMethods.normalize(terms.accepted_payment_methods) || paymentMethods.DEFAULT
        ),
      ]
    );

    await upsertTenantCharge(conn, request.tenant_id, 'water_charges', terms.water_charges);
    await upsertTenantCharge(
      conn,
      request.tenant_id,
      'maintenance_charges',
      terms.maintenance_charges
    );

    await conn.query(
      `UPDATE tenant_property_requests
       SET status = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [STATUS_APPROVED, request.id]
    );

    await conn.commit();

    const assignmentId = assignmentResult.insertId;

    const [assignmentRows] = await pool.query(
      `SELECT pt.*,
         p.id AS property_id, p.property_code, p.name AS property_name, p.address,
         p.city, p.state, p.pincode, p.owner_id,
         u.id AS tenant_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.id = ?
       LIMIT 1`,
      [assignmentId]
    );

    const row = assignmentRows[0];

    return {
      id: row.id,
      property_id: row.property_id,
      tenant_id: row.tenant_id,
      move_in_date: row.move_in_date,
      move_out_date: row.move_out_date,
      status: row.status,
      monthly_rent: row.monthly_rent,
      water_charges: row.water_charges,
      maintenance_charges: row.maintenance_charges,
      security_deposit_amount: row.security_deposit_amount,
      agreement_period_months: row.agreement_period_months,
      agreement_from: row.agreement_from,
      agreement_to: row.agreement_to,
      created_at: row.created_at,
      updated_at: row.updated_at,
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        mobile: row.tenant_mobile,
        email: row.tenant_email,
      },
      property: {
        id: row.property_id,
        property_code: row.property_code,
        name: row.property_name,
        address: row.address,
        city: row.city,
        state: row.state,
        pincode: row.pincode,
        owner_id: row.owner_id,
      },
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function reject(request, ownerId, remark = null) {
  const [propertyRows] = await pool.query(
    'SELECT * FROM properties WHERE id = ? LIMIT 1',
    [request.property_id]
  );

  if (!propertyRows.length) {
    throw httpError(404, 'Property not found');
  }

  const property = propertyRows[0];

  if (property.owner_id !== ownerId) {
    throw httpError(403, 'You do not have access to this request.');
  }

  if (request.status !== STATUS_PENDING) {
    throw httpError(422, 'This request has already been processed.');
  }

  await pool.query(
    `UPDATE tenant_property_requests
     SET status = ?, owner_remark = ?, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [STATUS_REJECTED, remark, request.id]
  );

  const [rows] = await pool.query(
    `SELECT
       tpr.*,
       p.id AS property_id, p.name AS property_name, p.property_code AS property_property_code,
       u.id AS tenant_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
     FROM tenant_property_requests tpr
     INNER JOIN properties p ON p.id = tpr.property_id
     INNER JOIN users u ON u.id = tpr.tenant_id
     WHERE tpr.id = ?
     LIMIT 1`,
    [request.id]
  );

  const row = rows[0];

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    property_id: row.property_id,
    status: row.status,
    tenant_message: row.tenant_message,
    owner_remark: row.owner_remark,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      mobile: row.tenant_mobile,
      email: row.tenant_email,
    },
    property: {
      id: row.property_id,
      name: row.property_name,
      property_code: row.property_property_code,
    },
  };
}

async function formatAssignment(assignment) {
  const [rows] = await pool.query(
    `SELECT
       pt.*,
       p.id AS property_id, p.property_code, p.name AS property_name, p.address,
       p.city, p.state, p.pincode, p.monthly_rent AS property_monthly_rent,
       p.water_charges AS property_water_charges,
       p.maintenance_charges AS property_maintenance_charges,
       p.security_deposit_amount AS property_security_deposit_amount,
       o.id AS owner_id, o.name AS owner_name, o.mobile AS owner_mobile,
       u.id AS tenant_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
     FROM property_tenants pt
     INNER JOIN properties p ON p.id = pt.property_id
     LEFT JOIN users o ON o.id = p.owner_id
     INNER JOIN users u ON u.id = pt.tenant_id
     WHERE pt.id = ?
     LIMIT 1`,
    [assignment.id]
  );

  if (!rows.length) {
    throw httpError(404, 'Assignment not found');
  }

  const row = rows[0];

  return {
    assignment_id: row.id,
    move_in_date: formatDate(row.move_in_date),
    move_out_date: formatDate(row.move_out_date),
    status: row.status,
    monthly_rent: Number(row.monthly_rent ?? row.property_monthly_rent),
    water_charges: Number(row.water_charges ?? row.property_water_charges),
    maintenance_charges: Number(row.maintenance_charges ?? row.property_maintenance_charges),
    security_deposit_amount: Number(
      row.security_deposit_amount ?? row.property_security_deposit_amount
    ),
    agreement_period_months: row.agreement_period_months,
    agreement_from: formatDate(row.agreement_from),
    agreement_to: formatDate(row.agreement_to),
    accepted_payment_methods: paymentMethods.resolved(
      paymentMethods.parseRow(row.accepted_payment_methods)
    ),
    property: {
      id: row.property_id,
      property_code: row.property_code,
      name: row.property_name,
      address: row.address,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
    },
    owner: {
      id: row.owner_id,
      name: row.owner_name,
      mobile: row.owner_mobile,
    },
  };
}

module.exports = {
  STATUS_PENDING,
  STATUS_APPROVED,
  STATUS_REJECTED,
  searchProperty,
  createRequest,
  approve,
  reject,
  formatAssignment,
};
