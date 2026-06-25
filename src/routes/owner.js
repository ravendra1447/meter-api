const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const env = require('../config/env');
const { ok, fail, paginate } = require('../utils/response');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  generatePropertyCode,
  mobileRegex,
  paginatedQuery,
} = require('../helpers/userHelpers');
const billingStatementService = require('../services/billingStatementService');
const tenantPropertyRequestService = require('../services/tenantPropertyRequestService');
const meterBillingScheduleService = require('../services/meterBillingScheduleService');
const electricityConsumptionService = require('../services/electricityConsumptionService');
const smartMeterService = require('../services/smartMeterService');
const prepaidRelayService = require('../services/prepaidRelayService');

const router = express.Router();

router.use(authenticate, requireRole('owner'));

const SALT_ROUNDS = 10;

function serviceError(res, err) {
  return fail(res, err.message, err.status || 500);
}

async function ownerTenantIds(ownerId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT pt.tenant_id
     FROM property_tenants pt
     INNER JOIN properties p ON p.id = pt.property_id
     WHERE p.owner_id = ?`,
    [ownerId]
  );
  return rows.map((r) => r.tenant_id);
}

async function ownerHasTenant(ownerId, tenantId) {
  const ids = await ownerTenantIds(ownerId);
  return ids.includes(Number(tenantId));
}

async function loadOwnerProperty(propertyId, ownerId) {
  const [rows] = await pool.query(
    'SELECT * FROM properties WHERE id = ? AND owner_id = ? LIMIT 1',
    [propertyId, ownerId]
  );
  return rows[0] ?? null;
}

async function loadOwnerMeter(meterId, ownerId) {
  const [rows] = await pool.query(
    `SELECT em.*, p.owner_id
     FROM electricity_meters em
     INNER JOIN properties p ON p.id = em.property_id
     WHERE em.id = ?
     LIMIT 1`,
    [meterId]
  );
  const meter = rows[0] ?? null;
  if (!meter) return null;
  if (meter.owner_id !== ownerId) return { forbidden: true };
  return meter;
}

async function resolveSmartMeter(electricityMeter) {
  const [rows] = await pool.query(
    'SELECT * FROM meters WHERE meter_number = ? LIMIT 1',
    [electricityMeter.meter_number]
  );
  return rows[0] ?? null;
}

async function resolveOrCreateSmartMeter(electricityMeter) {
  let smart = await resolveSmartMeter(electricityMeter);
  if (smart) return smart;

  const [result] = await pool.query(
    `INSERT INTO meters (meter_number, tariff, relay_status, status, created_at, updated_at)
     VALUES (?, ?, 'ON', 'active', NOW(), NOW())`,
    [electricityMeter.meter_number, electricityMeter.tariff_per_unit ?? 8]
  );

  const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [result.insertId]);
  return rows[0];
}

function mqttConfigured() {
  return Boolean(env.mqtt?.brokerUrl);
}

// ── Dashboard & Reports ─────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const ownerId = req.user.id;
    const billingData = await billingStatementService.listStatements(ownerId);
    const statements = billingData.statements;

    const [properties] = await pool.query(
      `SELECT p.*,
         (SELECT COUNT(*) FROM property_tenants pt WHERE pt.property_id = p.id AND pt.status = 'active') AS active_tenants_count,
         (SELECT COUNT(*) FROM electricity_meters em WHERE em.property_id = p.id) AS electricity_meters_count
       FROM properties p
       WHERE p.owner_id = ?
       ORDER BY p.id DESC`,
      [ownerId]
    );

    const mapped = properties.map((property) => {
      const statement = statements.find(
        (s) => (s.property?.unit ?? null) === property.property_code
      );

      return {
        id: property.id,
        name: property.name,
        property_code: property.property_code,
        address: property.address,
        city: property.city,
        monthly_rent: property.monthly_rent,
        status: property.status,
        tenants_count: Number(property.active_tenants_count),
        meters_count: Number(property.electricity_meters_count),
        tenant_name: statement?.tenant?.name ?? null,
        bill_status: statement?.status ?? 'due',
        bill_status_label: statement?.status_label ?? 'Payment Due',
        bill_amount: statement?.total ?? 0,
        property_tenant_id: statement?.property_tenant_id ?? null,
      };
    });

    const [[{ tenants }]] = await pool.query(
      `SELECT COUNT(*) AS tenants FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE p.owner_id = ? AND pt.status = 'active'`,
      [ownerId]
    );

    const [[{ meters }]] = await pool.query(
      `SELECT COUNT(*) AS meters FROM electricity_meters em
       INNER JOIN properties p ON p.id = em.property_id
       WHERE p.owner_id = ?`,
      [ownerId]
    );

    return ok(res, {
      stats: {
        properties: mapped.length,
        tenants: Number(tenants),
        meters: Number(meters),
        pending_amount: billingData.stats?.outstanding ?? 0,
      },
      properties: mapped,
      statements: billingData.statements,
      period: billingData.period,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load dashboard.', 500);
  }
});

async function ownerCollectionHandler(req, res) {
  try {
    const data = await billingStatementService.listStatements(req.user.id);

    const propertyWise = data.statements.map((s) => ({
      property: s.property?.name ?? '—',
      tenant: s.tenant?.name ?? '—',
      total: s.total,
      status: s.status,
      status_label: s.status_label,
      collection_pct: s.status === 'paid' ? 100 : 0,
    }));

    return ok(res, {
      period: data.period,
      stats: data.stats,
      statements: data.statements,
      property_wise: propertyWise,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load collection report.', 500);
  }
}

router.get('/collection', ownerCollectionHandler);
router.get('/reports', ownerCollectionHandler);

// ── Tenants ─────────────────────────────────────────────────────────────────

router.get('/tenants', async (req, res) => {
  try {
    const ownerId = req.user.id;
    const billing = await billingStatementService.listStatements(ownerId);
    const statementMap = {};
    for (const s of billing.statements) {
      statementMap[s.property_tenant_id] = s;
    }

    const [assignments] = await pool.query(
      `SELECT pt.*,
         p.id AS prop_id, p.name AS prop_name, p.property_code AS prop_code, p.owner_id,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE p.owner_id = ?
       ORDER BY pt.id DESC`,
      [ownerId]
    );

    const data = assignments.map((a) => {
      const stmt = statementMap[a.id];
      return {
        id: a.id,
        property_id: a.property_id,
        property_name: a.prop_name,
        property_code: a.prop_code,
        tenant: {
          id: a.tenant_user_id,
          name: a.tenant_name,
          mobile: a.tenant_mobile,
          email: a.tenant_email,
        },
        move_in_date: a.move_in_date,
        status: a.status,
        bill_status: stmt?.status ?? 'due',
        bill_status_label: stmt?.status_label ?? 'Payment Due',
        bill_amount: stmt?.total ?? 0,
      };
    });

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load tenants.', 500);
  }
});

router.post('/tenants', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const {
      name,
      mobile,
      email,
      password,
      property_id,
      move_in_date,
    } = req.body;

    if (!name || !mobile || !password || !property_code) {
      return fail(res, 'Name, mobile, password, and property_code are required.', 422);
    }
    if (!mobileRegex(mobile)) {
      return fail(res, 'Invalid mobile number format.', 422);
    }
    if (password.length < 6) {
      return fail(res, 'Password must be at least 6 characters.', 422);
    }

    const [propRows] = await conn.query(
      'SELECT id, security_deposit_amount FROM properties WHERE property_code = ? AND owner_id = ? LIMIT 1',
      [property_code, req.user.id]
    );

    if (!propRows.length) {
      return fail(res, 'Invalid property code.', 404);
    }

    const property = propRows[0];

    const [existingMobile] = await conn.query(
      'SELECT id FROM users WHERE mobile = ? LIMIT 1',
      [mobile]
    );
    if (existingMobile.length) {
      return fail(res, 'Mobile number already registered.', 422);
    }

    if (email) {
      const [existingEmail] = await conn.query(
        'SELECT id FROM users WHERE email = ? LIMIT 1',
        [email]
      );
      if (existingEmail.length) {
        return fail(res, 'Email already registered.', 422);
      }
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const moveIn = move_in_date ?? new Date().toISOString().slice(0, 10);

    await conn.beginTransaction();

    const [userResult] = await conn.query(
      `INSERT INTO users (name, mobile, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'tenant', 1, NOW(), NOW())`,
      [name, mobile, email ?? null, hashed]
    );

    const [assignmentResult] = await conn.query(
      `INSERT INTO property_tenants (property_id, tenant_id, move_in_date, agreement_duration_months, deposit_paid, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, FALSE, 'active', NOW(), NOW())`,
      [property.id, userResult.insertId, moveIn, agreement_duration_months]
    );

    // Create a one-time charge for Security Deposit if it exists
    if (property.security_deposit_amount && Number(property.security_deposit_amount) > 0) {
      await conn.query(
        `INSERT INTO tenant_unbilled_charges (tenant_id, amount, description, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', NOW(), NOW())`,
        [userResult.insertId, Number(property.security_deposit_amount), 'Security Deposit (Advance)']
      );
    }

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT pt.*,
         p.id AS prop_id, p.name AS prop_name, p.property_code,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.id = ? LIMIT 1`,
      [assignmentResult.insertId]
    );

    const row = rows[0];
    const assignment = {
      ...row,
      tenant: {
        id: row.tenant_user_id,
        name: row.tenant_name,
        mobile: row.tenant_mobile,
        email: row.tenant_email,
      },
      property: {
        id: row.prop_id,
        name: row.prop_name,
        property_code: row.property_code,
      },
    };

    return ok(res, assignment, 'Tenant added successfully.', 201);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Failed to add tenant.', 500);
  } finally {
    conn.release();
  }
});

router.put('/tenants/:propertyTenant', async (req, res) => {
  try {
    const propertyTenantId = parseInt(req.params.propertyTenant, 10);
    const [assignmentRows] = await pool.query(
      `SELECT pt.*, p.owner_id
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE pt.id = ? LIMIT 1`,
      [propertyTenantId]
    );

    if (!assignmentRows.length) {
      return fail(res, 'Tenant assignment not found.', 404);
    }
    if (assignmentRows[0].owner_id !== req.user.id) {
      return fail(res, 'Unauthorized.', 403);
    }

    const { move_in_date, move_out_date, status } = req.body;
    if (status && !['active', 'inactive'].includes(status)) {
      return fail(res, 'Invalid status.', 422);
    }

    const updates = [];
    const values = [];

    if (move_in_date !== undefined) {
      updates.push('move_in_date = ?');
      values.push(move_in_date);
    }
    if (move_out_date !== undefined) {
      updates.push('move_out_date = ?');
      values.push(move_out_date);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      values.push(propertyTenantId);
      await pool.query(
        `UPDATE property_tenants SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    const [rows] = await pool.query(
      `SELECT pt.*,
         p.id AS prop_id, p.name AS prop_name, p.property_code,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.id = ? LIMIT 1`,
      [propertyTenantId]
    );

    const row = rows[0];
    return ok(res, {
      ...row,
      tenant: {
        id: row.tenant_user_id,
        name: row.tenant_name,
        mobile: row.tenant_mobile,
        email: row.tenant_email,
      },
      property: {
        id: row.prop_id,
        name: row.prop_name,
        property_code: row.property_code,
      },
    }, 'Tenant updated.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update tenant.', 500);
  }
});

router.delete('/tenants/:propertyTenant', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const propertyTenantId = parseInt(req.params.propertyTenant, 10);
    const [assignmentRows] = await conn.query(
      `SELECT pt.*, p.owner_id
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE pt.id = ? LIMIT 1`,
      [propertyTenantId]
    );

    if (!assignmentRows.length) {
      return fail(res, 'Tenant assignment not found.', 404);
    }
    if (assignmentRows[0].owner_id !== req.user.id) {
      return fail(res, 'Unauthorized.', 403);
    }

    const tenantId = assignmentRows[0].tenant_id;

    await conn.beginTransaction();
    await conn.query('DELETE FROM property_tenants WHERE id = ?', [propertyTenantId]);
    await conn.query('DELETE FROM users WHERE id = ?', [tenantId]);
    await conn.commit();

    return ok(res, null, 'Tenant removed.');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Failed to remove tenant.', 500);
  } finally {
    conn.release();
  }
});

router.post('/tenants/:propertyTenant/remind', async (req, res) => {
  try {
    const propertyTenantId = parseInt(req.params.propertyTenant, 10);
    const [assignmentRows] = await pool.query(
      `SELECT pt.*, p.owner_id,
         u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM property_tenants pt
       INNER JOIN properties p ON p.id = pt.property_id
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.id = ? LIMIT 1`,
      [propertyTenantId]
    );

    if (!assignmentRows.length) {
      return fail(res, 'Tenant assignment not found.', 404);
    }
    if (assignmentRows[0].owner_id !== req.user.id) {
      return fail(res, 'Unauthorized.', 403);
    }

    const assignment = assignmentRows[0];
    const statement = await billingStatementService.getStatement(
      propertyTenantId,
      req.user.id
    );

    return ok(res, {
      tenant_name: assignment.tenant_name,
      amount: statement?.total ?? 0,
      due_date: statement?.due_date ?? null,
      sent_at: new Date().toISOString(),
    }, `Bill reminder sent to ${assignment.tenant_mobile}.`);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to send reminder.', 500);
  }
});

// ── Property Requests ─────────────────────────────────────────────────────────

router.get('/property-requests', async (req, res) => {
  try {
    const [requests] = await pool.query(
      `SELECT
         tpr.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email,
         p.id AS prop_id, p.name AS prop_name, p.property_code, p.address, p.monthly_rent,
         p.maintenance_charges, p.water_charges, p.security_deposit_amount, p.owner_id
       FROM tenant_property_requests tpr
       INNER JOIN properties p ON p.id = tpr.property_id
       INNER JOIN users u ON u.id = tpr.tenant_id
       WHERE p.owner_id = ?
       ORDER BY tpr.id DESC`,
      [req.user.id]
    );

    const data = requests.map((row) => ({
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
        id: row.tenant_user_id,
        name: row.tenant_name,
        mobile: row.tenant_mobile,
        email: row.tenant_email,
      },
      property: {
        id: row.prop_id,
        name: row.prop_name,
        property_code: row.property_code,
        address: row.address,
        monthly_rent: row.monthly_rent,
        maintenance_charges: row.maintenance_charges,
        water_charges: row.water_charges,
        security_deposit_amount: row.security_deposit_amount,
        owner_id: row.owner_id,
      },
    }));

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load property requests.', 500);
  }
});

router.post('/property-requests/:propertyRequest/approve', async (req, res) => {
  try {
    const requestId = parseInt(req.params.propertyRequest, 10);
    const [requestRows] = await pool.query(
      'SELECT * FROM tenant_property_requests WHERE id = ? LIMIT 1',
      [requestId]
    );

    if (!requestRows.length) {
      return fail(res, 'Property request not found.', 404);
    }

    const {
      monthly_rent,
      water_charges,
      maintenance_charges,
      security_deposit_amount,
      agreement_period_months,
      agreement_from,
      agreement_to,
      move_in_date,
    } = req.body;

    if (
      monthly_rent === undefined ||
      water_charges === undefined ||
      maintenance_charges === undefined ||
      security_deposit_amount === undefined ||
      !agreement_period_months ||
      !agreement_from
    ) {
      return fail(res, 'Required approval terms are missing.', 422);
    }

    const assignment = await tenantPropertyRequestService.approve(
      requestRows[0],
      req.user.id,
      {
        monthly_rent,
        water_charges,
        maintenance_charges,
        security_deposit_amount,
        agreement_period_months,
        agreement_from,
        agreement_to,
        move_in_date,
      }
    );

    const formatted = await tenantPropertyRequestService.formatAssignment(assignment);

    return ok(res, formatted, 'Tenant request approved and property linked.');
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to approve request.', 500);
  }
});

router.post('/property-requests/:propertyRequest/reject', async (req, res) => {
  try {
    const requestId = parseInt(req.params.propertyRequest, 10);
    const [requestRows] = await pool.query(
      'SELECT * FROM tenant_property_requests WHERE id = ? LIMIT 1',
      [requestId]
    );

    if (!requestRows.length) {
      return fail(res, 'Property request not found.', 404);
    }

    const { owner_remark } = req.body;
    if (owner_remark && owner_remark.length > 500) {
      return fail(res, 'Remark must not exceed 500 characters.', 422);
    }

    const result = await tenantPropertyRequestService.reject(
      requestRows[0],
      req.user.id,
      owner_remark ?? null
    );

    return ok(res, result, 'Tenant request rejected.');
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to reject request.', 500);
  }
});

// ── Billing Schedules ─────────────────────────────────────────────────────────

router.get('/billing-schedules', async (req, res) => {
  try {
    const [schedules] = await pool.query(
      `SELECT mbs.*
       FROM meter_billing_schedules mbs
       WHERE mbs.owner_id = ?
       ORDER BY mbs.id DESC`,
      [req.user.id]
    );

    const data = await Promise.all(
      schedules.map((s) => meterBillingScheduleService.formatSchedule(s))
    );

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load billing schedules.', 500);
  }
});

router.post('/billing-schedules', async (req, res) => {
  try {
    const {
      meter_id,
      smart_meter_id,
      schedule_type,
      schedule_name,
      run_time,
      run_day,
      timezone,
      data_points,
      protocol,
      action,
      billing,
      notifications,
      status,
    } = req.body;

    if (!meter_id || !schedule_type || !schedule_name || !run_time) {
      return fail(res, 'meter_id, schedule_type, schedule_name, and run_time are required.', 422);
    }

    const schedule = await meterBillingScheduleService.create(req.user.id, {
      meter_id,
      smart_meter_id,
      schedule_type,
      schedule_name,
      run_time,
      run_day,
      timezone,
      data_points,
      protocol,
      action,
      billing,
      notifications,
      status,
    });

    const formatted = await meterBillingScheduleService.formatSchedule(schedule);
    return ok(res, formatted, 'Billing schedule created.', 201);
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to create billing schedule.', 500);
  }
});

router.get('/billing-schedules/:billingSchedule', async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.billingSchedule, 10);
    const [rows] = await pool.query(
      'SELECT * FROM meter_billing_schedules WHERE id = ? LIMIT 1',
      [scheduleId]
    );

    if (!rows.length) {
      return fail(res, 'Schedule not found.', 404);
    }
    if (rows[0].owner_id !== req.user.id) {
      return fail(res, 'Forbidden.', 403);
    }

    const formatted = await meterBillingScheduleService.formatSchedule(rows[0]);
    return ok(res, formatted);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load billing schedule.', 500);
  }
});

router.put('/billing-schedules/:billingSchedule', async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.billingSchedule, 10);
    const [rows] = await pool.query(
      'SELECT * FROM meter_billing_schedules WHERE id = ? LIMIT 1',
      [scheduleId]
    );

    if (!rows.length) {
      return fail(res, 'Schedule not found.', 404);
    }
    if (rows[0].owner_id !== req.user.id) {
      return fail(res, 'Forbidden.', 403);
    }

    const schedule = await meterBillingScheduleService.update(rows[0], req.user.id, req.body);
    const formatted = await meterBillingScheduleService.formatSchedule(schedule);

    return ok(res, formatted, 'Billing schedule updated.');
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to update billing schedule.', 500);
  }
});

// ── Properties ────────────────────────────────────────────────────────────────

router.get('/properties', async (req, res) => {
  try {
    const [properties] = await pool.query(
      `SELECT p.*,
         (SELECT COUNT(*) FROM property_tenants pt WHERE pt.property_id = p.id AND pt.status = 'active') AS active_tenants_count,
         (SELECT COUNT(*) FROM electricity_meters em WHERE em.property_id = p.id) AS electricity_meters_count
       FROM properties p
       WHERE p.owner_id = ?
       ORDER BY p.id DESC`,
      [req.user.id]
    );

    return ok(res, properties);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load properties.', 500);
  }
});

router.post('/properties', async (req, res) => {
  try {
    const {
      name,
      address,
      city,
      state,
      pincode,
      monthly_rent,
      maintenance_charges,
      water_charges,
      security_deposit_amount,
      status,
    } = req.body;
    if (!name || !address) {
      return fail(res, 'Name and address are required.', 422);
    }

    const propertyCode = await generatePropertyCode();

    const [result] = await pool.query(
      `INSERT INTO properties
        (owner_id, property_code, name, address, city, state, pincode,
         monthly_rent, maintenance_charges, water_charges, security_deposit_amount,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        req.user.id,
        propertyCode,
        name,
        address,
        city ?? null,
        state ?? null,
        pincode ?? null,
        monthly_rent ?? 0,
        maintenance_charges ?? 0,
        water_charges ?? 0,
        security_deposit_amount ?? 0,
        status ?? 'active',
      ]
    );

    const [rows] = await pool.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [
      result.insertId,
    ]);

    return ok(
      res,
      rows[0],
      'Property created successfully. Share the property code with your tenant.',
      201
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to create property.', 500);
  }
});

router.get('/properties/:property', async (req, res) => {
  try {
    const property = await loadOwnerProperty(req.params.property, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const [tenants] = await pool.query(
      `SELECT pt.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.property_id = ? AND pt.status = 'active'
       ORDER BY pt.id DESC`,
      [property.id]
    );

    const [meters] = await pool.query(
      'SELECT * FROM electricity_meters WHERE property_id = ? ORDER BY id DESC',
      [property.id]
    );

    const activeTenants = tenants.map((t) => ({
      ...t,
      tenant: {
        id: t.tenant_user_id,
        name: t.tenant_name,
        mobile: t.tenant_mobile,
        email: t.tenant_email,
      },
    }));

    return ok(res, {
      ...property,
      active_tenants: activeTenants,
      electricity_meters: meters,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load property.', 500);
  }
});

router.put('/properties/:property', async (req, res) => {
  try {
    const property = await loadOwnerProperty(req.params.property, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const fields = [
      'name',
      'address',
      'city',
      'state',
      'pincode',
      'monthly_rent',
      'maintenance_charges',
      'water_charges',
      'security_deposit_amount',
      'status',
    ];

    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      values.push(property.id);
      await pool.query(`UPDATE properties SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    const [rows] = await pool.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [
      property.id,
    ]);

    return ok(res, rows[0], 'Property updated successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update property.', 500);
  }
});

router.post('/properties/:property/regenerate-code', async (req, res) => {
  try {
    const property = await loadOwnerProperty(req.params.property, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const newCode = await generatePropertyCode();
    await pool.query(
      'UPDATE properties SET property_code = ?, updated_at = NOW() WHERE id = ?',
      [newCode, property.id]
    );

    return ok(res, { property_code: newCode }, 'Property code regenerated successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to regenerate property code.', 500);
  }
});

router.get('/properties/:property/tenants', async (req, res) => {
  try {
    const property = await loadOwnerProperty(req.params.property, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const [tenants] = await pool.query(
      `SELECT pt.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.property_id = ?
       ORDER BY pt.id DESC`,
      [property.id]
    );

    const data = tenants.map((t) => ({
      ...t,
      tenant: {
        id: t.tenant_user_id,
        name: t.tenant_name,
        mobile: t.tenant_mobile,
        email: t.tenant_email,
      },
    }));

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load property tenants.', 500);
  }
});

// ── Electricity Meters ────────────────────────────────────────────────────────

router.get('/properties/:property/meters', async (req, res) => {
  try {
    const property = await loadOwnerProperty(req.params.property, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const [meters] = await pool.query(
      'SELECT * FROM electricity_meters WHERE property_id = ? ORDER BY id DESC',
      [property.id]
    );

    return ok(res, meters);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load meters.', 500);
  }
});

router.post('/properties/:property/meters', async (req, res) => {
  try {
    const property = await loadOwnerProperty(req.params.property, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const {
      meter_name,
      meter_number,
      model_number,
      series_number,
      meter_type,
      initial_balance,
      current_balance,
      tariff_per_unit,
      last_reading,
      status,
      bluetooth_mac,
      smart_meter_id,
    } = req.body;

    if (!meter_name || !meter_number || !model_number || !series_number || !meter_type) {
      return fail(
        res,
        'meter_name, meter_number, model_number, series_number, and meter_type are required.',
        422
      );
    }

    const [dupNumber] = await pool.query(
      'SELECT id FROM electricity_meters WHERE meter_number = ? LIMIT 1',
      [meter_number]
    );
    if (dupNumber.length) {
      return fail(res, 'Meter number already exists.', 422);
    }

    const [dupSeries] = await pool.query(
      'SELECT id FROM electricity_meters WHERE series_number = ? LIMIT 1',
      [series_number]
    );
    if (dupSeries.length) {
      return fail(res, 'Series number already exists.', 422);
    }

    const balance = current_balance ?? initial_balance ?? 0;

    const [result] = await pool.query(
      `INSERT INTO electricity_meters
        (property_id, meter_name, meter_number, model_number, series_number, meter_type,
         initial_balance, current_balance, tariff_per_unit, last_reading, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        property.id,
        meter_name,
        meter_number,
        model_number,
        series_number,
        meter_type,
        initial_balance ?? balance,
        balance,
        tariff_per_unit ?? 8,
        last_reading ?? 0,
        status ?? 'active',
      ]
    );

    const meterId = result.insertId;

    if (smart_meter_id) {
      const [smartRows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [
        smart_meter_id,
      ]);
      if (smartRows.length && smartRows[0].meter_number !== meter_number) {
        await pool.query('UPDATE meters SET meter_number = ?, updated_at = NOW() WHERE id = ?', [
          meter_number,
          smart_meter_id,
        ]);
      }
    } else if (bluetooth_mac) {
      const [existingSmart] = await pool.query(
        'SELECT id FROM meters WHERE meter_number = ? LIMIT 1',
        [meter_number]
      );

      if (existingSmart.length) {
        await pool.query(
          `UPDATE meters SET bluetooth_mac = ?, tariff = ?, relay_status = 'ON', status = 'active', updated_at = NOW()
           WHERE id = ?`,
          [smartMeterService.formatMacForStorage(bluetooth_mac), tariff_per_unit ?? 8, existingSmart[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO meters (meter_number, bluetooth_mac, tariff, relay_status, status, created_at, updated_at)
           VALUES (?, ?, ?, 'ON', 'active', NOW(), NOW())`,
          [
            meter_number,
            smartMeterService.formatMacForStorage(bluetooth_mac),
            tariff_per_unit ?? 8,
          ]
        );
      }
    }

    const [rows] = await pool.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [
      meterId,
    ]);

    return ok(res, rows[0], 'Electricity meter added successfully.', 201);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to add meter.', 500);
  }
});

router.get('/meters/:meter', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.meter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const [propertyRows] = await pool.query(
      'SELECT id, name, property_code FROM properties WHERE id = ? LIMIT 1',
      [meter.property_id]
    );

    return ok(res, { ...meter, property: propertyRows[0] ?? null });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load meter.', 500);
  }
});

router.put('/meters/:meter', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.meter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const fields = [
      'meter_name',
      'meter_number',
      'model_number',
      'series_number',
      'meter_type',
      'initial_balance',
      'current_balance',
      'tariff_per_unit',
      'last_reading',
      'status',
    ];

    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        if (field === 'meter_number' && req.body[field] !== meter.meter_number) {
          const [dup] = await pool.query(
            'SELECT id FROM electricity_meters WHERE meter_number = ? AND id != ? LIMIT 1',
            [req.body[field], meter.id]
          );
          if (dup.length) {
            return fail(res, 'Meter number already exists.', 422);
          }
        }
        if (field === 'series_number' && req.body[field] !== meter.series_number) {
          const [dup] = await pool.query(
            'SELECT id FROM electricity_meters WHERE series_number = ? AND id != ? LIMIT 1',
            [req.body[field], meter.id]
          );
          if (dup.length) {
            return fail(res, 'Series number already exists.', 422);
          }
        }
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      values.push(meter.id);
      await pool.query(`UPDATE electricity_meters SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    const [rows] = await pool.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [
      meter.id,
    ]);
    const updated = rows[0];

    const [smartRows] = await pool.query(
      'SELECT * FROM meters WHERE meter_number = ? LIMIT 1',
      [updated.meter_number]
    );

    let relayActionRequired = null;
    let pendingRelayAction = null;

    if (smartRows.length) {
      relayActionRequired = await prepaidRelayService.syncPendingRelayFromBalance(
        smartRows[0],
        updated
      );
      const [freshSmart] = await pool.query('SELECT pending_relay_action FROM meters WHERE id = ?', [
        smartRows[0].id,
      ]);
      pendingRelayAction = freshSmart[0]?.pending_relay_action ?? null;
    }

    return res.status(200).json({
      success: true,
      message: 'Electricity meter updated successfully.',
      data: updated,
      relay_action_required: relayActionRequired,
      pending_relay_action: pendingRelayAction,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update meter.', 500);
  }
});

router.delete('/meters/:meter', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.meter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    await pool.query('DELETE FROM electricity_meters WHERE id = ?', [meter.id]);
    return ok(res, null, 'Electricity meter deleted successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to delete meter.', 500);
  }
});

// ── Smart Meter (simplified) ──────────────────────────────────────────────────

router.get('/meters/:electricityMeter/smart-status', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const smartMeter = await resolveSmartMeter(meter);

    if (!smartMeter) {
      return ok(res, {
        linked: false,
        electricity_meter: meter,
        message: 'Connect via Bluetooth to register this meter number on the smart meter table.',
      });
    }

    const [schedules] = await pool.query(
      `SELECT * FROM meter_relay_schedules
       WHERE meter_id = ?
       ORDER BY schedule_time ASC`,
      [smartMeter.id]
    );

    return ok(res, {
      linked: true,
      electricity_meter: meter,
      smart_meter: smartMeter,
      schedules,
      pending_relay_action: smartMeter.pending_relay_action,
      dlt645_relay_control_di: '04008001',
      dlt645_trip_command: '1A',
      dlt645_close_command: '1B',
      sim_enabled: Boolean(smartMeter.sim_enabled),
      mqtt_online: Boolean(smartMeter.mqtt_online),
      last_mqtt_at: smartMeter.last_mqtt_at
        ? new Date(smartMeter.last_mqtt_at).toISOString()
        : null,
      mqtt_configured: mqttConfigured(),
      connectivity: {
        bluetooth: smartMeter.bluetooth_mac !== null,
        sim_4g: Boolean(smartMeter.sim_enabled),
      },
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load smart meter status.', 500);
  }
});

router.patch('/meters/:electricityMeter/sim', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const { sim_enabled, mqtt_device_id } = req.body;
    if (sim_enabled === undefined) {
      return fail(res, 'sim_enabled is required.', 422);
    }

    const smartMeter = await resolveOrCreateSmartMeter(meter);

    await pool.query(
      `UPDATE meters SET sim_enabled = ?, mqtt_device_id = COALESCE(?, mqtt_device_id), updated_at = NOW()
       WHERE id = ?`,
      [sim_enabled ? 1 : 0, mqtt_device_id ?? null, smartMeter.id]
    );

    const [rows] = await pool.query('SELECT * FROM meters WHERE id = ? LIMIT 1', [smartMeter.id]);

    return ok(
      res,
      rows[0],
      sim_enabled
        ? 'SIM/4G mode enabled. Relay commands will use MQTT when broker is configured.'
        : 'SIM/4G mode disabled.'
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update SIM settings.', 500);
  }
});

router.post('/meters/:electricityMeter/remote-relay', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const { action } = req.body;
    if (!action || !['ON', 'OFF'].includes(action)) {
      return fail(res, 'Action must be ON or OFF.', 422);
    }

    if (!mqttConfigured()) {
      return fail(
        res,
        'MQTT broker not configured on server. Add SAVING_MQTT_HOST to .env',
        503
      );
    }

    const smartMeter = await resolveOrCreateSmartMeter(meter);

    await pool.query(
      `UPDATE meters SET relay_status = ?, sim_enabled = 1, pending_relay_action = NULL, updated_at = NOW()
       WHERE id = ?`,
      [action, smartMeter.id]
    );

    const [rows] = await pool.query('SELECT relay_status FROM meters WHERE id = ?', [smartMeter.id]);

    return res.status(200).json({
      success: true,
      message: `Relay ${action} command sent via 4G/MQTT`,
      relay_status: rows[0].relay_status,
      channel: 'mqtt',
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Remote relay command failed.', 502);
  }
});

router.post('/meters/:electricityMeter/relay-schedules', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const { action, schedule_time, days_of_week } = req.body;
    if (!action || !['ON', 'OFF'].includes(action)) {
      return fail(res, 'Action must be ON or OFF.', 422);
    }
    if (!schedule_time || !/^\d{2}:\d{2}$/.test(schedule_time)) {
      return fail(res, 'schedule_time must be in H:i format.', 422);
    }

    const smartMeter = await resolveOrCreateSmartMeter(meter);
    const timeValue = `${schedule_time}:00`;

    const [result] = await pool.query(
      `INSERT INTO meter_relay_schedules (meter_id, action, schedule_time, days_of_week, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, NOW(), NOW())`,
      [smartMeter.id, action, timeValue, days_of_week ?? null]
    );

    const [rows] = await pool.query(
      'SELECT * FROM meter_relay_schedules WHERE id = ? LIMIT 1',
      [result.insertId]
    );

    return ok(
      res,
      rows[0],
      'Relay schedule saved. With SIM: server sends via 4G/MQTT at scheduled time. Without SIM: connect Bluetooth to execute.',
      201
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to save relay schedule.', 500);
  }
});

router.delete('/meters/:electricityMeter/relay-schedules/:schedule', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const smartMeter = await resolveSmartMeter(meter);
    if (!smartMeter) {
      return fail(res, 'Schedule not found for this meter.', 404);
    }

    const scheduleId = parseInt(req.params.schedule, 10);
    const [scheduleRows] = await pool.query(
      'SELECT * FROM meter_relay_schedules WHERE id = ? AND meter_id = ? LIMIT 1',
      [scheduleId, smartMeter.id]
    );

    if (!scheduleRows.length) {
      return fail(res, 'Schedule not found for this meter.', 404);
    }

    await pool.query('DELETE FROM meter_relay_schedules WHERE id = ?', [scheduleId]);
    return ok(res, null, 'Schedule deleted.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to delete schedule.', 500);
  }
});

router.post('/meters/:electricityMeter/relay-sync', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const { relay_status } = req.body;
    if (!relay_status || !['ON', 'OFF'].includes(relay_status)) {
      return fail(res, 'relay_status must be ON or OFF.', 422);
    }

    const smartMeter = await resolveSmartMeter(meter);
    if (!smartMeter) {
      return fail(res, 'Smart meter not linked. Connect via Bluetooth first.', 404);
    }

    const updated = await smartMeterService.syncRelay(smartMeter, relay_status);
    await pool.query(
      'UPDATE meters SET pending_relay_action = NULL, updated_at = NOW() WHERE id = ?',
      [updated.id]
    );

    return res.status(200).json({
      success: true,
      relay_status: updated.relay_status,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to sync relay.', 500);
  }
});

router.post('/meters/:electricityMeter/relay-pending-clear', async (req, res) => {
  try {
    const meter = await loadOwnerMeter(req.params.electricityMeter, req.user.id);
    if (!meter) {
      return fail(res, 'Meter not found.', 404);
    }
    if (meter.forbidden) {
      return fail(res, 'You do not have access to this meter.', 403);
    }

    const smartMeter = await resolveSmartMeter(meter);
    if (!smartMeter) {
      return fail(res, 'Smart meter not linked.', 404);
    }

    await pool.query(
      'UPDATE meters SET pending_relay_action = NULL, updated_at = NOW() WHERE id = ?',
      [smartMeter.id]
    );

    return ok(res, null);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to clear pending relay.', 500);
  }
});

// ── Electricity Consumptions ──────────────────────────────────────────────────

router.get('/electricity-consumptions', async (req, res) => {
  try {
    const ownerId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;

    const conditions = ['p.owner_id = ?'];
    const params = [ownerId];

    if (req.query.property_id) {
      conditions.push('ec.property_id = ?');
      params.push(req.query.property_id);
    }
    if (req.query.meter_id) {
      conditions.push('ec.meter_id = ?');
      params.push(req.query.meter_id);
    }

    const where = conditions.join(' AND ');

    const { rows, total } = await paginatedQuery(
      `SELECT ec.*,
         p.id AS prop_id, p.name AS prop_name, p.property_code,
         em.id AS meter_id_ref, em.meter_name, em.meter_number
       FROM electricity_consumptions ec
       INNER JOIN properties p ON p.id = ec.property_id
       LEFT JOIN electricity_meters em ON em.id = ec.meter_id
       WHERE ${where}
       ORDER BY ec.calculation_date DESC, ec.id DESC`,
      `SELECT COUNT(*) AS total FROM electricity_consumptions ec
       INNER JOIN properties p ON p.id = ec.property_id
       WHERE ${where}`,
      params,
      page,
      perPage
    );

    const data = rows.map((row) => ({
      ...row,
      property: row.prop_id
        ? { id: row.prop_id, name: row.prop_name, property_code: row.property_code }
        : null,
      meter: row.meter_id_ref
        ? { id: row.meter_id_ref, meter_name: row.meter_name, meter_number: row.meter_number }
        : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load electricity consumptions.', 500);
  }
});

router.post('/electricity-consumptions', async (req, res) => {
  try {
    const { property_id, meter_id, total_consumed_units, calculation_date } = req.body;

    if (!property_id || !meter_id || !total_consumed_units || !calculation_date) {
      return fail(
        res,
        'property_id, meter_id, total_consumed_units, and calculation_date are required.',
        422
      );
    }
    if (Number(total_consumed_units) < 0.01) {
      return fail(res, 'total_consumed_units must be at least 0.01.', 422);
    }

    const property = await loadOwnerProperty(property_id, req.user.id);
    if (!property) {
      return fail(res, 'You do not have access to this property.', 403);
    }

    const consumption = await electricityConsumptionService.record(
      { property_id, meter_id, total_consumed_units, calculation_date },
      req.user
    );

    return ok(res, consumption, 'Electricity consumption recorded successfully.', 201);
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to record consumption.', 500);
  }
});

router.get('/electricity-consumptions/:electricityConsumption', async (req, res) => {
  try {
    const consumptionId = parseInt(req.params.electricityConsumption, 10);
    const [rows] = await pool.query(
      `SELECT ec.*, p.owner_id
       FROM electricity_consumptions ec
       INNER JOIN properties p ON p.id = ec.property_id
       WHERE ec.id = ?
       LIMIT 1`,
      [consumptionId]
    );

    if (!rows.length) {
      return fail(res, 'Record not found.', 404);
    }
    if (rows[0].owner_id !== req.user.id) {
      return fail(res, 'You do not have access to this record.', 403);
    }

    const consumption = rows[0];
    const [propertyRows] = await pool.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [
      consumption.property_id,
    ]);
    const [meterRows] = await pool.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [
      consumption.meter_id,
    ]);

    let creator = null;
    if (consumption.created_by) {
      const [creatorRows] = await pool.query(
        'SELECT id, name FROM users WHERE id = ? LIMIT 1',
        [consumption.created_by]
      );
      creator = creatorRows[0] ?? null;
    }

    const [unbilledCharges] = await pool.query(
      'SELECT * FROM tenant_unbilled_charges WHERE electricity_consumption_id = ?',
      [consumptionId]
    );

    return ok(res, {
      ...consumption,
      property: propertyRows[0] ?? null,
      meter: meterRows[0] ?? null,
      creator,
      unbilled_charges: unbilledCharges,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load consumption record.', 500);
  }
});

// ── Bill Configurations (apiResource) ─────────────────────────────────────────

router.get('/bill-configurations', async (req, res) => {
  try {
    const tenantIds = await ownerTenantIds(req.user.id);
    if (!tenantIds.length) {
      return ok(res, paginate([], 0, 1, 20));
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;
    const placeholders = tenantIds.map(() => '?').join(',');
    const params = [...tenantIds];

    let extra = '';
    if (req.query.tenant_id) {
      extra = ' AND tbc.tenant_id = ?';
      params.push(req.query.tenant_id);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT tbc.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile,
         c.id AS creator_id, c.name AS creator_name
       FROM tenant_bill_configurations tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       LEFT JOIN users c ON c.id = tbc.created_by
       WHERE tbc.tenant_id IN (${placeholders})${extra}
       ORDER BY tbc.id DESC`,
      `SELECT COUNT(*) AS total FROM tenant_bill_configurations tbc
       WHERE tbc.tenant_id IN (${placeholders})${extra}`,
      params,
      page,
      perPage
    );

    const data = rows.map((row) => ({
      ...row,
      tenant: row.tenant_user_id
        ? { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile }
        : null,
      creator: row.creator_id ? { id: row.creator_id, name: row.creator_name } : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load bill configurations.', 500);
  }
});

router.post('/bill-configurations', async (req, res) => {
  try {
    const { tenant_id, bill_cycle_day, billing_status } = req.body;

    if (!tenant_id || !bill_cycle_day || !billing_status) {
      return fail(res, 'tenant_id, bill_cycle_day, and billing_status are required.', 422);
    }

    if (!(await ownerHasTenant(req.user.id, tenant_id))) {
      return fail(res, 'Tenant not linked to your property.', 403);
    }

    const [tenantRows] = await pool.query(
      "SELECT id, role FROM users WHERE id = ? LIMIT 1",
      [tenant_id]
    );
    if (!tenantRows.length || tenantRows[0].role !== 'tenant') {
      return fail(res, 'Selected user is not a tenant.', 422);
    }

    const [existing] = await pool.query(
      'SELECT id FROM tenant_bill_configurations WHERE tenant_id = ? LIMIT 1',
      [tenant_id]
    );

    if (existing.length) {
      await pool.query(
        `UPDATE tenant_bill_configurations
         SET bill_cycle_day = ?, billing_status = ?, created_by = ?, updated_at = NOW()
         WHERE tenant_id = ?`,
        [bill_cycle_day, billing_status, req.user.id, tenant_id]
      );
    } else {
      await pool.query(
        `INSERT INTO tenant_bill_configurations
          (tenant_id, bill_cycle_day, billing_status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [tenant_id, bill_cycle_day, billing_status, req.user.id]
      );
    }

    const [rows] = await pool.query(
      `SELECT tbc.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_bill_configurations tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       WHERE tbc.tenant_id = ? LIMIT 1`,
      [tenant_id]
    );

    const row = rows[0];
    return ok(
      res,
      {
        ...row,
        tenant: { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile },
      },
      'Tenant bill configuration saved successfully.',
      201
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to save bill configuration.', 500);
  }
});

router.get('/bill-configurations/:billConfiguration', async (req, res) => {
  try {
    const configId = parseInt(req.params.billConfiguration, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_bill_configurations WHERE id = ? LIMIT 1',
      [configId]
    );

    if (!rows.length) {
      return fail(res, 'Bill configuration not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    const [tenantRows] = await pool.query(
      'SELECT id, name, mobile FROM users WHERE id = ? LIMIT 1',
      [rows[0].tenant_id]
    );
    const [creatorRows] = rows[0].created_by
      ? await pool.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [rows[0].created_by])
      : [[]];

    return ok(res, {
      ...rows[0],
      tenant: tenantRows[0] ?? null,
      creator: creatorRows[0] ?? null,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load bill configuration.', 500);
  }
});

router.put('/bill-configurations/:billConfiguration', async (req, res) => {
  try {
    const configId = parseInt(req.params.billConfiguration, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_bill_configurations WHERE id = ? LIMIT 1',
      [configId]
    );

    if (!rows.length) {
      return fail(res, 'Bill configuration not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    const updates = [];
    const values = [];

    if (req.body.bill_cycle_day !== undefined) {
      updates.push('bill_cycle_day = ?');
      values.push(req.body.bill_cycle_day);
    }
    if (req.body.billing_status !== undefined) {
      updates.push('billing_status = ?');
      values.push(req.body.billing_status);
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      values.push(configId);
      await pool.query(
        `UPDATE tenant_bill_configurations SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    const [updated] = await pool.query(
      `SELECT tbc.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_bill_configurations tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       WHERE tbc.id = ? LIMIT 1`,
      [configId]
    );

    const row = updated[0];
    return ok(
      res,
      {
        ...row,
        tenant: { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile },
      },
      'Bill configuration updated successfully.'
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update bill configuration.', 500);
  }
});

router.delete('/bill-configurations/:billConfiguration', async (req, res) => {
  try {
    const configId = parseInt(req.params.billConfiguration, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_bill_configurations WHERE id = ? LIMIT 1',
      [configId]
    );

    if (!rows.length) {
      return fail(res, 'Bill configuration not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    await pool.query('DELETE FROM tenant_bill_configurations WHERE id = ?', [configId]);
    return ok(res, null, 'Bill configuration deleted successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to delete bill configuration.', 500);
  }
});

// ── Unbilled Charges (apiResource) ────────────────────────────────────────────

router.get('/unbilled-charges', async (req, res) => {
  try {
    const tenantIds = await ownerTenantIds(req.user.id);
    if (!tenantIds.length) {
      return ok(res, paginate([], 0, 1, 20));
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;
    const placeholders = tenantIds.map(() => '?').join(',');
    const params = [...tenantIds];

    let extra = '';
    if (req.query.tenant_id) {
      extra += ' AND tuc.tenant_id = ?';
      params.push(req.query.tenant_id);
    }
    if (req.query.status) {
      extra += ' AND tuc.status = ?';
      params.push(req.query.status);
    }
    if (req.query.activity_type) {
      extra += ' AND tuc.activity_type = ?';
      params.push(req.query.activity_type);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT tuc.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile,
         ec.id AS ec_id, ec.total_consumed_units, ec.calculation_date,
         c.id AS creator_id, c.name AS creator_name
       FROM tenant_unbilled_charges tuc
       LEFT JOIN users u ON u.id = tuc.tenant_id
       LEFT JOIN electricity_consumptions ec ON ec.id = tuc.electricity_consumption_id
       LEFT JOIN users c ON c.id = tuc.created_by
       WHERE tuc.tenant_id IN (${placeholders})${extra}
       ORDER BY tuc.id DESC`,
      `SELECT COUNT(*) AS total FROM tenant_unbilled_charges tuc
       WHERE tuc.tenant_id IN (${placeholders})${extra}`,
      params,
      page,
      perPage
    );

    const data = rows.map((row) => ({
      ...row,
      tenant: row.tenant_user_id
        ? { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile }
        : null,
      electricity_consumption: row.ec_id
        ? {
            id: row.ec_id,
            total_consumed_units: row.total_consumed_units,
            calculation_date: row.calculation_date,
          }
        : null,
      creator: row.creator_id ? { id: row.creator_id, name: row.creator_name } : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load unbilled charges.', 500);
  }
});

router.post('/unbilled-charges', async (req, res) => {
  try {
    const {
      tenant_id,
      electricity_consumption_id,
      activity_type,
      amount,
      status,
    } = req.body;

    if (!tenant_id || !activity_type || amount === undefined) {
      return fail(res, 'tenant_id, activity_type, and amount are required.', 422);
    }

    if (!(await ownerHasTenant(req.user.id, tenant_id))) {
      return fail(res, 'Tenant not linked to your property.', 403);
    }

    const [result] = await pool.query(
      `INSERT INTO tenant_unbilled_charges
        (tenant_id, electricity_consumption_id, activity_type, amount, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        tenant_id,
        electricity_consumption_id ?? null,
        activity_type,
        amount,
        status ?? 'active',
        req.user.id,
      ]
    );

    const [rows] = await pool.query(
      `SELECT tuc.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_unbilled_charges tuc
       LEFT JOIN users u ON u.id = tuc.tenant_id
       WHERE tuc.id = ? LIMIT 1`,
      [result.insertId]
    );

    let electricityConsumption = null;
    if (electricity_consumption_id) {
      const [ecRows] = await pool.query(
        'SELECT * FROM electricity_consumptions WHERE id = ? LIMIT 1',
        [electricity_consumption_id]
      );
      electricityConsumption = ecRows[0] ?? null;
    }

    const row = rows[0];
    return ok(
      res,
      {
        ...row,
        tenant: { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile },
        electricity_consumption: electricityConsumption,
      },
      'Unbilled charge added successfully.',
      201
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to add unbilled charge.', 500);
  }
});

router.get('/unbilled-charges/:unbilledCharge', async (req, res) => {
  try {
    const chargeId = parseInt(req.params.unbilledCharge, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_unbilled_charges WHERE id = ? LIMIT 1',
      [chargeId]
    );

    if (!rows.length) {
      return fail(res, 'Unbilled charge not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    const charge = rows[0];
    const [tenantRows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [
      charge.tenant_id,
    ]);

    let electricityConsumption = null;
    if (charge.electricity_consumption_id) {
      const [ecRows] = await pool.query(
        'SELECT * FROM electricity_consumptions WHERE id = ? LIMIT 1',
        [charge.electricity_consumption_id]
      );
      electricityConsumption = ecRows[0] ?? null;
    }

    const [creatorRows] = charge.created_by
      ? await pool.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [charge.created_by])
      : [[]];

    return ok(res, {
      ...charge,
      tenant: tenantRows[0] ?? null,
      electricity_consumption: electricityConsumption,
      creator: creatorRows[0] ?? null,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load unbilled charge.', 500);
  }
});

router.put('/unbilled-charges/:unbilledCharge', async (req, res) => {
  try {
    const chargeId = parseInt(req.params.unbilledCharge, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_unbilled_charges WHERE id = ? LIMIT 1',
      [chargeId]
    );

    if (!rows.length) {
      return fail(res, 'Unbilled charge not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    const updates = [];
    const values = [];

    for (const field of ['activity_type', 'amount', 'status']) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      values.push(chargeId);
      await pool.query(`UPDATE tenant_unbilled_charges SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    const [updated] = await pool.query(
      `SELECT tuc.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_unbilled_charges tuc
       LEFT JOIN users u ON u.id = tuc.tenant_id
       WHERE tuc.id = ? LIMIT 1`,
      [chargeId]
    );

    const row = updated[0];
    return ok(
      res,
      {
        ...row,
        tenant: { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile },
      },
      'Unbilled charge updated successfully.'
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update unbilled charge.', 500);
  }
});

router.delete('/unbilled-charges/:unbilledCharge', async (req, res) => {
  try {
    const chargeId = parseInt(req.params.unbilledCharge, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_unbilled_charges WHERE id = ? LIMIT 1',
      [chargeId]
    );

    if (!rows.length) {
      return fail(res, 'Unbilled charge not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    await pool.query('DELETE FROM tenant_unbilled_charges WHERE id = ?', [chargeId]);
    return ok(res, null, 'Unbilled charge deleted successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to delete unbilled charge.', 500);
  }
});

// ── Other Active Charges (apiResource) ────────────────────────────────────────

router.get('/other-active-charges', async (req, res) => {
  try {
    const tenantIds = await ownerTenantIds(req.user.id);
    if (!tenantIds.length) {
      return ok(res, paginate([], 0, 1, 20));
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;
    const placeholders = tenantIds.map(() => '?').join(',');
    const params = [...tenantIds];

    let extra = '';
    if (req.query.tenant_id) {
      extra += ' AND toac.tenant_id = ?';
      params.push(req.query.tenant_id);
    }
    if (req.query.status) {
      extra += ' AND toac.status = ?';
      params.push(req.query.status);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT toac.*,
         u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile,
         c.id AS creator_id, c.name AS creator_name
       FROM tenant_other_active_charges toac
       LEFT JOIN users u ON u.id = toac.tenant_id
       LEFT JOIN users c ON c.id = toac.created_by
       WHERE toac.tenant_id IN (${placeholders})${extra}
       ORDER BY toac.id DESC`,
      `SELECT COUNT(*) AS total FROM tenant_other_active_charges toac
       WHERE toac.tenant_id IN (${placeholders})${extra}`,
      params,
      page,
      perPage
    );

    const data = rows.map((row) => ({
      ...row,
      tenant: row.tenant_user_id
        ? { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile }
        : null,
      creator: row.creator_id ? { id: row.creator_id, name: row.creator_name } : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load other active charges.', 500);
  }
});

router.post('/other-active-charges', async (req, res) => {
  try {
    const { tenant_id, charge_type, amount, status } = req.body;

    if (!tenant_id || !charge_type || amount === undefined) {
      return fail(res, 'tenant_id, charge_type, and amount are required.', 422);
    }

    if (!(await ownerHasTenant(req.user.id, tenant_id))) {
      return fail(res, 'Tenant not linked to your property.', 403);
    }

    const [result] = await pool.query(
      `INSERT INTO tenant_other_active_charges
        (tenant_id, charge_type, amount, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [tenant_id, charge_type, amount, status ?? 'active', req.user.id]
    );

    const [rows] = await pool.query(
      `SELECT toac.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_other_active_charges toac
       LEFT JOIN users u ON u.id = toac.tenant_id
       WHERE toac.id = ? LIMIT 1`,
      [result.insertId]
    );

    const row = rows[0];
    return ok(
      res,
      {
        ...row,
        tenant: { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile },
      },
      'Other active charge added successfully.',
      201
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to add other active charge.', 500);
  }
});

router.get('/other-active-charges/:otherActiveCharge', async (req, res) => {
  try {
    const chargeId = parseInt(req.params.otherActiveCharge, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_other_active_charges WHERE id = ? LIMIT 1',
      [chargeId]
    );

    if (!rows.length) {
      return fail(res, 'Charge not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    const charge = rows[0];
    const [tenantRows] = await pool.query(
      'SELECT id, name, mobile FROM users WHERE id = ? LIMIT 1',
      [charge.tenant_id]
    );
    const [creatorRows] = charge.created_by
      ? await pool.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [charge.created_by])
      : [[]];

    return ok(res, {
      ...charge,
      tenant: tenantRows[0] ?? null,
      creator: creatorRows[0] ?? null,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load other active charge.', 500);
  }
});

router.put('/other-active-charges/:otherActiveCharge', async (req, res) => {
  try {
    const chargeId = parseInt(req.params.otherActiveCharge, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_other_active_charges WHERE id = ? LIMIT 1',
      [chargeId]
    );

    if (!rows.length) {
      return fail(res, 'Charge not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    const updates = [];
    const values = [];

    for (const field of ['charge_type', 'amount', 'status']) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      values.push(chargeId);
      await pool.query(
        `UPDATE tenant_other_active_charges SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    const [updated] = await pool.query(
      `SELECT toac.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_other_active_charges toac
       LEFT JOIN users u ON u.id = toac.tenant_id
       WHERE toac.id = ? LIMIT 1`,
      [chargeId]
    );

    const row = updated[0];
    return ok(
      res,
      {
        ...row,
        tenant: { id: row.tenant_user_id, name: row.tenant_name, mobile: row.tenant_mobile },
      },
      'Other active charge updated successfully.'
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to update other active charge.', 500);
  }
});

router.delete('/other-active-charges/:otherActiveCharge', async (req, res) => {
  try {
    const chargeId = parseInt(req.params.otherActiveCharge, 10);
    const [rows] = await pool.query(
      'SELECT * FROM tenant_other_active_charges WHERE id = ? LIMIT 1',
      [chargeId]
    );

    if (!rows.length) {
      return fail(res, 'Charge not found.', 404);
    }
    if (!(await ownerHasTenant(req.user.id, rows[0].tenant_id))) {
      return fail(res, 'Forbidden.', 403);
    }

    await pool.query('DELETE FROM tenant_other_active_charges WHERE id = ?', [chargeId]);
    return ok(res, null, 'Other active charge deleted successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to delete other active charge.', 500);
  }
});
router.get('/pending-payments', async (req, res) => {
  try {
    const ownerId = req.user.id;
    const [payments] = await pool.query(
      `SELECT tp.*, u.name as tenant_name, p.name as property_name, p.id as property_id
       FROM tenant_payments tp
       INNER JOIN property_tenants pt ON pt.tenant_id = tp.tenant_id AND pt.status = 'active'
       INNER JOIN properties p ON p.id = pt.property_id
       INNER JOIN users u ON u.id = tp.tenant_id
       WHERE tp.status = 'pending' AND p.owner_id = ?
       ORDER BY tp.created_at DESC`,
      [ownerId]
    );

    return ok(res, payments);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to fetch pending payments.', 500);
  }
});

router.post('/approve-payment/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const paymentId = req.params.id;
    const ownerId = req.user.id;

    // Verify payment belongs to owner's property
    const [payments] = await conn.query(
      `SELECT tp.*, p.id as property_id, pt.id as assignment_id
       FROM tenant_payments tp
       INNER JOIN property_tenants pt ON pt.tenant_id = tp.tenant_id AND pt.status = 'active'
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE tp.id = ? AND p.owner_id = ? AND tp.status = 'pending'`,
      [paymentId, ownerId]
    );

    if (payments.length === 0) {
      return fail(res, 'Payment not found or already processed.', 404);
    }

    const payment = payments[0];
    const payAmount = Number(payment.amount);
    const tenantId = payment.tenant_id;

    await conn.beginTransaction();

    await conn.query('UPDATE tenant_payments SET status = "success", updated_at = NOW() WHERE id = ?', [paymentId]);

    // Update meter balance and trigger Relay ON
    const [meterRows] = await conn.query(
      `SELECT * FROM electricity_meters
       WHERE property_id = ? AND status = 'active' AND meter_type = 'prepaid'
       LIMIT 1`,
      [payment.property_id]
    );

    if (meterRows.length) {
      const meter = meterRows[0];
      const newBalance = Number(meter.current_balance) + payAmount;
      await conn.query(
        'UPDATE electricity_meters SET current_balance = ?, updated_at = NOW() WHERE id = ?',
        [newBalance, meter.id]
      );

      const [smartRows] = await conn.query('SELECT id FROM meters WHERE meter_number = ? LIMIT 1', [meter.meter_number]);
      if (smartRows.length) {
        await conn.query('UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?', ['ON', smartRows[0].id]);
      }
    }

    // Deduct unbilled charges
    let remaining = payAmount;
    const [charges] = await conn.query(
      `SELECT * FROM tenant_unbilled_charges WHERE tenant_id = ? AND status = 'active' ORDER BY id ASC`,
      [tenantId]
    );

    for (const charge of charges) {
      if (remaining <= 0) break;
      const chargeAmount = Number(charge.amount);
      if (remaining >= chargeAmount) {
        await conn.query(
          "UPDATE tenant_unbilled_charges SET status = 'used', updated_at = NOW() WHERE id = ?",
          [charge.id]
        );
        
        if (charge.description === 'Security Deposit (Advance)') {
          await conn.query(
            "UPDATE property_tenants SET deposit_paid = TRUE, updated_at = NOW() WHERE tenant_id = ? AND status = 'active'",
            [tenantId]
          );
        }
        
        remaining -= chargeAmount;
      }
    }

    await conn.commit();
    return ok(res, { success: true }, 'Payment approved and meter activated.');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Failed to approve payment.', 500);
  } finally {
    conn.release();
  }
});

router.post('/reject-payment/:id', async (req, res) => {
  try {
    const paymentId = req.params.id;
    const ownerId = req.user.id;

    const [payments] = await pool.query(
      `SELECT tp.* FROM tenant_payments tp
       INNER JOIN property_tenants pt ON pt.tenant_id = tp.tenant_id AND pt.status = 'active'
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE tp.id = ? AND p.owner_id = ? AND tp.status = 'pending'`,
      [paymentId, ownerId]
    );

    if (payments.length === 0) {
      return fail(res, 'Payment not found or already processed.', 404);
    }

    await pool.query('UPDATE tenant_payments SET status = "rejected", updated_at = NOW() WHERE id = ?', [paymentId]);

    return ok(res, { success: true }, 'Payment rejected.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to reject payment.', 500);
  }
});

module.exports = router;
