const crypto = require('crypto');
const pool = require('../config/database');
const paymentMethods = require('../utils/paymentMethods');

function formatUser(user) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    role: user.role,
    is_active: !!user.is_active,
  };
}

async function generatePropertyCode(conn = pool) {
  for (let i = 0; i < 20; i++) {
    const code = 'PROP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const [rows] = await conn.query('SELECT id FROM properties WHERE property_code = ? LIMIT 1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not generate unique property code');
}

async function activeTenantAssignment(tenantUserId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT pt.*, p.*, pt.id AS assignment_id, p.id AS property_id
     FROM property_tenants pt
     INNER JOIN properties p ON p.id = pt.property_id
     WHERE pt.tenant_id = ? AND pt.status = 'active'
     ORDER BY pt.id DESC LIMIT 1`,
    [tenantUserId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.assignment_id,
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
    accepted_payment_methods: paymentMethods.resolved(
      paymentMethods.parseRow(row.accepted_payment_methods)
    ),
    property: {
      id: row.property_id,
      owner_id: row.owner_id,
      property_code: row.property_code,
      name: row.name,
      address: row.address,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      monthly_rent: row.monthly_rent,
      maintenance_charges: row.maintenance_charges,
      water_charges: row.water_charges,
      security_deposit_amount: row.security_deposit_amount,
      status: row.status,
    },
  };
}

async function paginatedQuery(sql, countSql, params, page = 1, perPage = 20) {
  const [[{ total }]] = await pool.query(countSql, params);
  const offset = (page - 1) * perPage;
  const [rows] = await pool.query(`${sql} LIMIT ? OFFSET ?`, [...params, perPage, offset]);
  return { rows, total: Number(total), page, perPage };
}

function mobileRegex(mobile) {
  return /^[6-9]\d{9}$/.test(mobile);
}

module.exports = {
  formatUser,
  generatePropertyCode,
  activeTenantAssignment,
  paginatedQuery,
  mobileRegex,
};
