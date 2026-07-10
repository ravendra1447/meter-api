const pool = require('../config/database');

function now() {
  return new Date();
}

function startOfMonth(date = now()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date = now()) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function billingPeriodLabel() {
  const d = now();
  const month = d.toLocaleString('en-US', { month: 'long' });
  return `${month} ${d.getFullYear()} billing`;
}

function formatMoney(amount) {
  return `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusLabel(status) {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'overdue':
      return 'Overdue';
    default:
      return 'Payment Due';
  }
}

function statusClass(status) {
  switch (status) {
    case 'paid':
      return 'badge--paid';
    case 'overdue':
      return 'badge--overdue';
    default:
      return 'badge--due';
  }
}

function resolveDueDate(config) {
  const current = now();

  if (config?.bill_cycle_day === 'last_day_of_month') {
    return endOfMonth(current);
  }

  if (config?.bill_cycle_day != null && config.bill_cycle_day !== '' && !Number.isNaN(Number(config.bill_cycle_day))) {
    return new Date(
      current.getFullYear(),
      current.getMonth(),
      Number(config.bill_cycle_day),
      current.getHours(),
      current.getMinutes(),
      current.getSeconds(),
      current.getMilliseconds()
    );
  }

  const due = startOfMonth(current);
  due.setDate(due.getDate() + 9);
  return due;
}

function buildLineItems(period, rent, maintenance, waterAmount, waterUnits, waterRate, electricityAmount, elecUnits, elecRate) {
  const items = [
    {
      title: 'Monthly Rent',
      subtitle: period,
      usage: '—',
      rate: '—',
      amount: rent,
    },
    {
      title: 'Maintenance Charges',
      subtitle: 'Common area, security, upkeep',
      usage: '—',
      rate: '—',
      amount: maintenance,
    },
  ];

  if (waterAmount > 0) {
    items.push({
      title: 'Water Charges',
      subtitle: 'Metered supply',
      usage: waterUnits ? `${waterUnits} kL` : '—',
      rate: waterRate ? `${formatMoney(waterRate)}/kL` : '—',
      amount: waterAmount,
    });
  }

  if (electricityAmount > 0) {
    items.push({
      title: 'Electricity Charges',
      subtitle: 'As per meter consumption',
      usage: elecUnits > 0 ? `${elecUnits} kWh` : '—',
      rate: elecRate > 0 ? `${formatMoney(elecRate)}/kWh` : '—',
      amount: electricityAmount,
    });
  }

  return items;
}

function computePortfolioStats(statements) {
  const billed = statements.reduce((sum, s) => sum + s.total, 0);
  const paid = statements.filter((s) => s.status === 'paid').reduce((sum, s) => sum + s.total, 0);
  const outstanding = statements
    .filter((s) => s.status === 'due' || s.status === 'overdue')
    .reduce((sum, s) => sum + s.total, 0);

  return {
    units: statements.length,
    billed,
    outstanding,
    paid,
  };
}

async function sumCharge(conn, sql, params) {
  const [rows] = await conn.query(sql, params);
  return Number(rows[0]?.total ?? 0);
}

async function resolveStatus(conn, tenantId, dueDate, total) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM tenant_unbilled_charges
     WHERE tenant_id = ? AND status = 'active'`,
    [tenantId]
  );
  const activeCount = Number(rows[0].cnt);

  if (total <= 0 || activeCount === 0) {
    return 'paid';
  }

  if (now().getTime() > dueDate.getTime()) {
    return 'overdue';
  }

  return 'due';
}

async function buildStatement(assignment, conn = pool) {
  const property = assignment.property;
  const tenant = assignment.tenant;
  const tenantId = tenant.id;

  let rent = Number(assignment.monthly_rent ?? property.monthly_rent ?? 0);
  let maintenance = Number(assignment.maintenance_charges ?? property.maintenance_charges ?? 0);

  if (maintenance <= 0) {
    maintenance = await sumCharge(
      conn,
      `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_other_active_charges
       WHERE tenant_id = ? AND charge_type = 'maintenance_charges' AND status = 'active'`,
      [tenantId]
    );
  }

  let waterFixed = Number(assignment.water_charges ?? property.water_charges ?? 0);
  if (waterFixed <= 0) {
    waterFixed = await sumCharge(
      conn,
      `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_other_active_charges
       WHERE tenant_id = ? AND charge_type = 'water_charges' AND status = 'active'`,
      [tenantId]
    );
  }

  const waterUnbilled = await sumCharge(
    conn,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_unbilled_charges
     WHERE tenant_id = ? AND activity_type = 'water_charges' AND status = 'active'`,
    [tenantId]
  );
  const waterAmount = waterFixed + waterUnbilled;

  const maintenanceUnbilled = await sumCharge(
    conn,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_unbilled_charges
     WHERE tenant_id = ? AND activity_type = 'maintenance_charges' AND status = 'active'`,
    [tenantId]
  );
  const maintenanceTotal = maintenance + maintenanceUnbilled;

  const rentUnbilled = await sumCharge(
    conn,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_unbilled_charges
     WHERE tenant_id = ? AND activity_type = 'monthly_rental' AND status = 'active'`,
    [tenantId]
  );
  const rentTotal = rent + rentUnbilled;

  const [consumptionRows] = await conn.query(
    `SELECT * FROM electricity_consumptions
     WHERE property_id = ?
     ORDER BY calculation_date DESC
     LIMIT 1`,
    [property.id]
  );
  const consumption = consumptionRows[0] ?? null;

  const electricityUnbilled = await sumCharge(
    conn,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_unbilled_charges
     WHERE tenant_id = ? AND activity_type = 'electricity_consumption' AND status = 'active'`,
    [tenantId]
  );

  const electricityAmount = consumption
    ? Number(consumption.total_amount)
    : electricityUnbilled;

  const elecUnits = consumption ? Number(consumption.total_consumed_units) : 0;
  const elecRate = consumption ? Number(consumption.tariff_per_unit) : 0;
  const prevReading = consumption ? Number(consumption.previous_reading) : 0;
  const currReading = consumption ? Number(consumption.current_reading) : 0;

  const waterUnits = waterAmount > 0 && waterFixed > 0
    ? Math.round((waterAmount / Math.max(1, waterFixed / 6)) * 10) / 10
    : null;
  const waterRate = waterFixed > 0
    ? Math.round((waterFixed / Math.max(1, waterUnits ?? 1)) * 100) / 100
    : null;

  const subtotal = rentTotal + maintenanceTotal + waterAmount + electricityAmount;

  const currentMonth = now().getMonth() + 1;
  const previousBalance = await sumCharge(
    conn,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM tenant_unbilled_charges
     WHERE tenant_id = ? AND status = 'used' AND MONTH(updated_at) < ?`,
    [tenantId, currentMonth]
  );

  const taxRate = 0;
  const tax = 0;
  const total = subtotal + tax + previousBalance;

  const [configRows] = await conn.query(
    'SELECT * FROM tenant_bill_configurations WHERE tenant_id = ? LIMIT 1',
    [tenantId]
  );
  const config = configRows[0] ?? null;
  const dueDate = resolveDueDate(config);
  const status = await resolveStatus(conn, tenantId, dueDate, total);

  const period = billingPeriodLabel();
  const lineItems = buildLineItems(
    period,
    rentTotal,
    maintenanceTotal,
    waterAmount,
    waterUnits,
    waterRate,
    electricityAmount,
    elecUnits,
    elecRate
  );

  const addressParts = [property.address, property.city, property.state, property.pincode].filter(Boolean);

  return {
    id: assignment.id,
    property_tenant_id: assignment.id,
    invoice_no: `INV-${now().getFullYear()}-${String(assignment.id).padStart(4, '0')}`,
    period,
    issue_date: formatYmd(startOfMonth()),
    due_date: formatYmd(dueDate),
    status,
    status_label: statusLabel(status),
    status_class: statusClass(status),
    previous_balance: previousBalance,
    tax_rate_pct: taxRate,
    property: {
      name: property.name,
      address: addressParts.join(', '),
      unit: property.property_code,
    },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email ?? '—',
      phone: tenant.mobile,
    },
    rent: rentTotal,
    maintenance: maintenanceTotal,
    water_amount: waterAmount,
    electricity_amount: electricityAmount,
    subtotal,
    tax,
    total,
    line_items: lineItems,
    electricity: {
      previous_reading: prevReading,
      current_reading: currReading,
      units: elecUnits,
      rate: elecRate,
    },
    consumption,
  };
}

const ASSIGNMENT_SELECT = `
  SELECT
    pt.*,
    p.id AS property_id,
    p.name AS property_name,
    p.address AS property_address,
    p.city AS property_city,
    p.state AS property_state,
    p.pincode AS property_pincode,
    p.property_code AS property_code,
    p.monthly_rent AS property_monthly_rent,
    p.maintenance_charges AS property_maintenance_charges,
    p.water_charges AS property_water_charges,
    u.id AS tenant_user_id,
    u.name AS tenant_name,
    u.email AS tenant_email,
    u.mobile AS tenant_mobile
  FROM property_tenants pt
  INNER JOIN properties p ON p.id = pt.property_id
  INNER JOIN users u ON u.id = pt.tenant_id
`;

function mapAssignmentRow(row) {
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
    property: {
      id: row.property_id,
      name: row.property_name,
      address: row.property_address,
      city: row.property_city,
      state: row.property_state,
      pincode: row.property_pincode,
      property_code: row.property_code,
      monthly_rent: row.property_monthly_rent,
      maintenance_charges: row.property_maintenance_charges,
      water_charges: row.property_water_charges,
    },
    tenant: {
      id: row.tenant_user_id,
      name: row.tenant_name,
      email: row.tenant_email,
      mobile: row.tenant_mobile,
    },
  };
}

async function listStatements(ownerId = null, search = null) {
  const conditions = ["pt.status = 'active'"];
  const params = [];

  if (ownerId) {
    conditions.push('p.owner_id = ?');
    params.push(ownerId);
  }

  if (search) {
    const like = `%${search}%`;
    conditions.push(`(
      u.name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?
      OR p.name LIKE ? OR p.property_code LIKE ?
    )`);
    params.push(like, like, like, like, like);
  }

  const sql = `${ASSIGNMENT_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY pt.created_at DESC`;

  const [rows] = await pool.query(sql, params);
  const assignments = rows.map(mapAssignmentRow);
  const statements = [];

  for (const assignment of assignments) {
    statements.push(await buildStatement(assignment));
  }

  return {
    statements,
    stats: computePortfolioStats(statements),
    period: billingPeriodLabel(),
  };
}

async function getStatement(propertyTenantId, ownerId = null) {
  const conditions = ['pt.id = ?', "pt.status = 'active'"];
  const params = [propertyTenantId];

  if (ownerId) {
    conditions.push('p.owner_id = ?');
    params.push(ownerId);
  }

  const sql = `${ASSIGNMENT_SELECT}
    WHERE ${conditions.join(' AND ')}
    LIMIT 1`;

  const [rows] = await pool.query(sql, params);
  if (!rows.length) {
    return null;
  }

  return buildStatement(mapAssignmentRow(rows[0]));
}

async function getStatementForTenantUser(tenantUserId) {
  const sql = `${ASSIGNMENT_SELECT}
    WHERE pt.tenant_id = ? AND pt.status = 'active'
    LIMIT 1`;

  const [rows] = await pool.query(sql, [tenantUserId]);
  if (!rows.length) {
    return null;
  }

  return buildStatement(mapAssignmentRow(rows[0]));
}

module.exports = {
  listStatements,
  getStatement,
  getStatementForTenantUser,
  buildStatement,
  formatMoney,
  formatDate,
};
