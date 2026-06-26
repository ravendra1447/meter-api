const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { ok, fail, paginate } = require('../utils/response');
const { authenticate, requireRole } = require('../middleware/auth');
const { paginatedQuery, mobileRegex, generatePropertyCode } = require('../helpers/userHelpers');
const billingStatementService = require('../services/billingStatementService');
const electricityConsumptionService = require('../services/electricityConsumptionService');
const paymentMethods = require('../utils/paymentMethods');

const router = express.Router();

router.use(authenticate, requireRole('master'));

function parsePage(req) {
  return Math.max(1, parseInt(req.query.page || '1', 10));
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function findOwner(id) {
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE id = ? AND role = 'owner' LIMIT 1",
    [id]
  );
  return rows[0] ?? null;
}

async function findProperty(id) {
  const [rows] = await pool.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [id]);
  return rows[0] ?? null;
}

async function findPropertyTenant(id) {
  const [rows] = await pool.query('SELECT * FROM property_tenants WHERE id = ? LIMIT 1', [id]);
  return rows[0] ?? null;
}

async function findElectricityMeter(id) {
  const [rows] = await pool.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [id]);
  return rows[0] ?? null;
}

async function loadOwnerDetail(ownerId) {
  const owner = await findOwner(ownerId);
  if (!owner) return null;

  const [properties] = await pool.query(
    'SELECT * FROM properties WHERE owner_id = ? ORDER BY id DESC',
    [ownerId]
  );

  for (const property of properties) {
    const [meters] = await pool.query(
      'SELECT * FROM electricity_meters WHERE property_id = ?',
      [property.id]
    );
    property.electricity_meters = meters;

    const [tenants] = await pool.query(
      `SELECT pt.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.property_id = ? AND pt.status = 'active'`,
      [property.id]
    );
    property.active_tenants = tenants.map((t) => ({
      ...t,
      tenant: {
        id: t.tenant_user_id,
        name: t.tenant_name,
        mobile: t.tenant_mobile,
        email: t.tenant_email,
      },
    }));
  }

  owner.owned_properties = properties;
  delete owner.password;
  return owner;
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const report = await billingStatementService.listStatements(null);
    const stats = report.stats;
    const billed = stats.billed ?? 0;
    const paid = stats.paid ?? 0;

    const [[ownersCount]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM users WHERE role = 'owner'"
    );
    const [[tenantsCount]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM users WHERE role = 'tenant'"
    );
    const [[propertiesCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM properties');
    const [[metersCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM electricity_meters');
    const [[activeTenants]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM property_tenants WHERE status = 'active'"
    );

    return ok(res, {
      owners_count: Number(ownersCount.cnt),
      tenants_count: Number(tenantsCount.cnt),
      properties_count: Number(propertiesCount.cnt),
      meters_count: Number(metersCount.cnt),
      active_tenants: Number(activeTenants.cnt),
      total_billed: billed,
      total_collected: paid,
      outstanding: stats.outstanding ?? 0,
      collection_rate_pct: billed > 0 ? Math.round((paid / billed) * 1000) / 10 : 0,
      period: report.period,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/reports', async (req, res, next) => {
  try {
    const data = await billingStatementService.listStatements(null);
    const billed = data.stats.billed ?? 0;
    const paid = data.stats.paid ?? 0;
    const rate = billed > 0 ? Math.round((paid / billed) * 1000) / 10 : 0;

    const propertyWise = data.statements.map((s) => ({
      property: s.property?.name ?? '—',
      tenant: s.tenant?.name ?? '—',
      total: s.total,
      status: s.status,
      collection_pct: s.status === 'paid' ? 100 : s.status === 'due' ? 50 : 25,
    }));

    return ok(res, {
      period: data.period,
      stats: { ...data.stats, collection_rate_pct: rate },
      statements: data.statements,
      property_wise: propertyWise,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/owners', async (req, res, next) => {
  try {
    const page = parsePage(req);
    const perPage = 20;
    const { rows, total } = await paginatedQuery(
      `SELECT u.*, (SELECT COUNT(*) FROM properties p WHERE p.owner_id = u.id) AS owned_properties_count
       FROM users u
       WHERE u.role = 'owner'
       ORDER BY u.created_at DESC`,
      "SELECT COUNT(*) AS total FROM users WHERE role = 'owner'",
      [],
      page,
      perPage
    );

    rows.forEach((r) => {
      delete r.password;
      r.owned_properties_count = Number(r.owned_properties_count);
    });

    return ok(res, paginate(rows, total, page, perPage));
  } catch (e) {
    next(e);
  }
});

router.post('/owners', async (req, res, next) => {
  try {
    const { name, mobile, email, password, is_active: isActive } = req.body;

    if (!name || !mobile || !password) {
      return fail(res, 'name, mobile, and password are required.', 422);
    }
    if (!mobileRegex(mobile)) {
      return fail(res, 'Invalid mobile number.', 422);
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE mobile = ? LIMIT 1', [mobile]);
    if (existing.length) return fail(res, 'The mobile has already been taken.', 422);

    if (email) {
      const [emailExists] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
      if (emailExists.length) return fail(res, 'The email has already been taken.', 422);
    }

    const hashed = await hashPassword(password);
    const [result] = await pool.query(
      `INSERT INTO users (name, mobile, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'owner', ?, NOW(), NOW())`,
      [name, mobile, email ?? null, hashed, isActive !== false ? 1 : 0]
    );

    const owner = await loadOwnerDetail(result.insertId);
    return ok(res, owner, 'Owner created successfully.', 201);
  } catch (e) {
    next(e);
  }
});

router.get('/owners/:owner', async (req, res, next) => {
  try {
    const owner = await loadOwnerDetail(req.params.owner);
    if (!owner) return fail(res, 'Owner not found.', 404);
    return ok(res, owner);
  } catch (e) {
    next(e);
  }
});

router.put('/owners/:owner', async (req, res, next) => {
  try {
    const owner = await findOwner(req.params.owner);
    if (!owner) return fail(res, 'Owner not found.', 404);

    const { name, mobile, email, password, is_active: isActive } = req.body;
    const updates = [];
    const params = [];

    if (name != null) {
      updates.push('name = ?');
      params.push(name);
    }
    if (mobile != null) {
      if (!mobileRegex(mobile)) return fail(res, 'Invalid mobile number.', 422);
      const [dup] = await pool.query('SELECT id FROM users WHERE mobile = ? AND id != ? LIMIT 1', [
        mobile,
        owner.id,
      ]);
      if (dup.length) return fail(res, 'The mobile has already been taken.', 422);
      updates.push('mobile = ?');
      params.push(mobile);
    }
    if (email !== undefined) {
      if (email) {
        const [dup] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1', [
          email,
          owner.id,
        ]);
        if (dup.length) return fail(res, 'The email has already been taken.', 422);
      }
      updates.push('email = ?');
      params.push(email || null);
    }
    if (password) {
      updates.push('password = ?');
      params.push(await hashPassword(password));
    }
    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(owner.id);
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const fresh = await loadOwnerDetail(owner.id);
    return ok(res, fresh, 'Owner updated successfully.');
  } catch (e) {
    next(e);
  }
});

router.delete('/owners/:owner', async (req, res, next) => {
  try {
    const owner = await findOwner(req.params.owner);
    if (!owner) return fail(res, 'Owner not found.', 404);
    await pool.query('DELETE FROM users WHERE id = ?', [owner.id]);
    return ok(res, null, 'Owner deleted successfully.');
  } catch (e) {
    next(e);
  }
});

router.get('/properties', async (req, res, next) => {
  try {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';

    if (req.query.owner_id) {
      where += ' AND p.owner_id = ?';
      params.push(req.query.owner_id);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT p.*, u.name AS owner_name, u.mobile AS owner_mobile,
        (SELECT COUNT(*) FROM property_tenants pt WHERE pt.property_id = p.id AND pt.status = 'active') AS active_tenants_count,
        (SELECT COUNT(*) FROM electricity_meters em WHERE em.property_id = p.id) AS electricity_meters_count
       FROM properties p
       LEFT JOIN users u ON u.id = p.owner_id
       WHERE ${where}
       ORDER BY p.created_at DESC`,
      `SELECT COUNT(*) AS total FROM properties p WHERE ${where}`,
      params,
      page,
      perPage
    );

    const data = rows.map((p) => ({
      ...p,
      owner: p.owner_id ? { id: p.owner_id, name: p.owner_name, mobile: p.owner_mobile } : null,
      active_tenants_count: Number(p.active_tenants_count),
      electricity_meters_count: Number(p.electricity_meters_count),
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (e) {
    next(e);
  }
});

router.post('/properties', async (req, res, next) => {
  try {
    const {
      owner_id: ownerId,
      name,
      address,
      city,
      state,
      pincode,
      monthly_rent: monthlyRent,
      maintenance_charges: maintenanceCharges,
      water_charges: waterCharges,
      security_deposit_amount: securityDepositAmount,
      status,
    } = req.body;

    if (!ownerId || !name || !address) {
      return fail(res, 'owner_id, name, and address are required.', 422);
    }

    const owner = await findOwner(ownerId);
    if (!owner) return fail(res, 'Selected user is not an owner.', 422);

    const propertyCode = await generatePropertyCode();
    const [result] = await pool.query(
      `INSERT INTO properties (
        owner_id, property_code, name, address, city, state, pincode,
        monthly_rent, maintenance_charges, water_charges, security_deposit_amount,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        ownerId,
        propertyCode,
        name,
        address,
        city ?? null,
        state ?? null,
        pincode ?? null,
        monthlyRent ?? 0,
        maintenanceCharges ?? 0,
        waterCharges ?? 0,
        securityDepositAmount ?? 0,
        status ?? 'active',
      ]
    );

    const property = await findProperty(result.insertId);
    return ok(res, property, 'Property created successfully.', 201);
  } catch (e) {
    next(e);
  }
});

router.get('/properties/:property', async (req, res, next) => {
  try {
    const property = await findProperty(req.params.property);
    if (!property) return fail(res, 'Property not found.', 404);

    const [ownerRows] = await pool.query(
      'SELECT id, name, mobile, email FROM users WHERE id = ? LIMIT 1',
      [property.owner_id]
    );
    property.owner = ownerRows[0] ?? null;

    const [meters] = await pool.query('SELECT * FROM electricity_meters WHERE property_id = ?', [
      property.id,
    ]);
    property.electricity_meters = meters;

    const [tenants] = await pool.query(
      `SELECT pt.*, u.id AS tenant_user_id, u.name, u.mobile
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       WHERE pt.property_id = ?`,
      [property.id]
    );
    property.tenants = tenants.map((t) => ({
      ...t,
      tenant: { id: t.tenant_user_id, name: t.name, mobile: t.mobile },
    }));

    return ok(res, property);
  } catch (e) {
    next(e);
  }
});

router.put('/properties/:property', async (req, res, next) => {
  try {
    const property = await findProperty(req.params.property);
    if (!property) return fail(res, 'Property not found.', 404);

    const fields = [
      'owner_id',
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
    const params = [];

    for (const field of fields) {
      const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const value = req.body[field] ?? req.body[camel];
      if (value !== undefined) {
        if (field === 'owner_id') {
          const owner = await findOwner(value);
          if (!owner) return fail(res, 'Selected user is not an owner.', 422);
        }
        updates.push(`${field} = ?`);
        params.push(value);
      }
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(property.id);
      await pool.query(`UPDATE properties SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const fresh = await findProperty(property.id);
    const [ownerRows] = await pool.query(
      'SELECT id, name, mobile FROM users WHERE id = ? LIMIT 1',
      [fresh.owner_id]
    );
    fresh.owner = ownerRows[0] ?? null;

    return ok(res, fresh, 'Property updated successfully.');
  } catch (e) {
    next(e);
  }
});

router.delete('/properties/:property', async (req, res, next) => {
  try {
    const property = await findProperty(req.params.property);
    if (!property) return fail(res, 'Property not found.', 404);
    await pool.query('DELETE FROM properties WHERE id = ?', [property.id]);
    return ok(res, null, 'Property deleted successfully.');
  } catch (e) {
    next(e);
  }
});

router.post('/properties/:property/regenerate-code', async (req, res, next) => {
  try {
    const property = await findProperty(req.params.property);
    if (!property) return fail(res, 'Property not found.', 404);

    const code = await generatePropertyCode();
    await pool.query('UPDATE properties SET property_code = ?, updated_at = NOW() WHERE id = ?', [
      code,
      property.id,
    ]);

    return ok(res, { property_code: code }, 'Property code regenerated.');
  } catch (e) {
    next(e);
  }
});

router.get('/tenants', async (req, res, next) => {
  try {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';

    if (req.query.property_id) {
      where += ' AND pt.property_id = ?';
      params.push(req.query.property_id);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT pt.*, u.id AS tenant_user_id, u.name AS tenant_name, u.mobile AS tenant_mobile, u.email AS tenant_email,
        p.id AS prop_id, p.name AS property_name, p.property_code
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE ${where}
       ORDER BY pt.created_at DESC`,
      `SELECT COUNT(*) AS total FROM property_tenants pt WHERE ${where}`,
      params,
      page,
      perPage
    );

    const data = rows.map((r) => ({
      id: r.id,
      property_id: r.property_id,
      tenant_id: r.tenant_id,
      move_in_date: r.move_in_date,
      move_out_date: r.move_out_date,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tenant: {
        id: r.tenant_user_id,
        name: r.tenant_name,
        mobile: r.tenant_mobile,
        email: r.tenant_email,
      },
      property: {
        id: r.prop_id,
        name: r.property_name,
        property_code: r.property_code,
      },
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (e) {
    next(e);
  }
});

router.post('/tenants', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      name,
      mobile,
      email,
      password,
      property_id: propertyId,
      move_in_date: moveInDate,
      status,
      accepted_payment_methods,
    } = req.body;

    const normalizedPayments =
      paymentMethods.normalize(accepted_payment_methods) || paymentMethods.DEFAULT;

    if (!name || !mobile || !password || !propertyId) {
      return fail(res, 'name, mobile, password, and property_id are required.', 422);
    }
    if (!mobileRegex(mobile)) return fail(res, 'Invalid mobile number.', 422);

    const property = await findProperty(propertyId);
    if (!property) return fail(res, 'Property not found.', 404);

    const [mobileExists] = await conn.query('SELECT id FROM users WHERE mobile = ? LIMIT 1', [mobile]);
    if (mobileExists.length) return fail(res, 'The mobile has already been taken.', 422);

    await conn.beginTransaction();

    const hashed = await hashPassword(password);
    const [userResult] = await conn.query(
      `INSERT INTO users (name, mobile, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'tenant', 1, NOW(), NOW())`,
      [name, mobile, email ?? null, hashed]
    );

    const today = new Date().toISOString().slice(0, 10);
    const [ptResult] = await conn.query(
      `INSERT INTO property_tenants (property_id, tenant_id, move_in_date, status, accepted_payment_methods, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [propertyId, userResult.insertId, moveInDate ?? today, status ?? 'active', paymentMethods.toJson(normalizedPayments)]
    );

    await conn.commit();

    const [rows] = await pool.query(
      `SELECT pt.*, u.name AS tenant_name, u.mobile AS tenant_mobile, p.name AS property_name, p.property_code
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE pt.id = ? LIMIT 1`,
      [ptResult.insertId]
    );

    const assignment = {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
      property: { id: rows[0].property_id, name: rows[0].property_name, property_code: rows[0].property_code },
    };

    return ok(res, assignment, 'Tenant created and linked to property.', 201);
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

router.put('/tenants/:propertyTenant', async (req, res, next) => {
  try {
    const assignment = await findPropertyTenant(req.params.propertyTenant);
    if (!assignment) return fail(res, 'Tenant assignment not found.', 404);

    const {
      move_in_date: moveInDate,
      move_out_date: moveOutDate,
      status,
      accepted_payment_methods,
    } = req.body;
    const updates = [];
    const params = [];

    if (accepted_payment_methods !== undefined) {
      const normalizedPayments = paymentMethods.normalize(accepted_payment_methods);
      if (!normalizedPayments) {
        return fail(res, 'Select at least one accepted payment method.', 422);
      }
      updates.push('accepted_payment_methods = ?');
      params.push(paymentMethods.toJson(normalizedPayments));
    }

    if (moveInDate !== undefined) {
      updates.push('move_in_date = ?');
      params.push(moveInDate);
    }
    if (moveOutDate !== undefined) {
      updates.push('move_out_date = ?');
      params.push(moveOutDate);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(assignment.id);
      await pool.query(`UPDATE property_tenants SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await pool.query(
      `SELECT pt.*, u.name AS tenant_name, u.mobile AS tenant_mobile, p.name AS property_name, p.property_code
       FROM property_tenants pt
       INNER JOIN users u ON u.id = pt.tenant_id
       INNER JOIN properties p ON p.id = pt.property_id
       WHERE pt.id = ? LIMIT 1`,
      [assignment.id]
    );

    const fresh = {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
      property: { id: rows[0].property_id, name: rows[0].property_name, property_code: rows[0].property_code },
    };

    return ok(res, fresh, 'Tenant assignment updated.');
  } catch (e) {
    next(e);
  }
});

router.delete('/tenants/:propertyTenant', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const assignment = await findPropertyTenant(req.params.propertyTenant);
    if (!assignment) return fail(res, 'Tenant assignment not found.', 404);

    await conn.beginTransaction();
    await conn.query('DELETE FROM property_tenants WHERE id = ?', [assignment.id]);
    await conn.query('DELETE FROM users WHERE id = ?', [assignment.tenant_id]);
    await conn.commit();

    return ok(res, null, 'Tenant removed successfully.');
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

router.get('/meters', async (req, res, next) => {
  try {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';

    if (req.query.property_id) {
      where += ' AND em.property_id = ?';
      params.push(req.query.property_id);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT em.*, p.name AS property_name, p.property_code
       FROM electricity_meters em
       LEFT JOIN properties p ON p.id = em.property_id
       WHERE ${where}
       ORDER BY em.created_at DESC`,
      `SELECT COUNT(*) AS total FROM electricity_meters em WHERE ${where}`,
      params,
      page,
      perPage
    );

    const data = rows.map((m) => ({
      ...m,
      property: m.property_id
        ? { id: m.property_id, name: m.property_name, property_code: m.property_code }
        : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (e) {
    next(e);
  }
});

router.post('/meters', async (req, res, next) => {
  try {
    const {
      property_id: propertyId,
      meter_name: meterName,
      meter_number: meterNumber,
      model_number: modelNumber,
      series_number: seriesNumber,
      meter_type: meterType,
      initial_balance: initialBalance,
      current_balance: currentBalance,
      tariff_per_unit: tariffPerUnit,
      last_reading: lastReading,
      status,
    } = req.body;

    if (!propertyId || !meterName || !meterNumber || !modelNumber || !seriesNumber || !meterType) {
      return fail(res, 'Required meter fields are missing.', 422);
    }

    const [prop] = await pool.query('SELECT id FROM properties WHERE id = ? LIMIT 1', [propertyId]);
    if (!prop.length) return fail(res, 'Property not found.', 404);

    const [numDup] = await pool.query(
      'SELECT id FROM electricity_meters WHERE meter_number = ? LIMIT 1',
      [meterNumber]
    );
    if (numDup.length) return fail(res, 'The meter number has already been taken.', 422);

    const [seriesDup] = await pool.query(
      'SELECT id FROM electricity_meters WHERE series_number = ? LIMIT 1',
      [seriesNumber]
    );
    if (seriesDup.length) return fail(res, 'The series number has already been taken.', 422);

    const balance = currentBalance ?? initialBalance ?? 0;

    const [result] = await pool.query(
      `INSERT INTO electricity_meters (
        property_id, meter_name, meter_number, model_number, series_number,
        meter_type, initial_balance, current_balance, tariff_per_unit, last_reading,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        propertyId,
        meterName,
        meterNumber,
        modelNumber,
        seriesNumber,
        meterType,
        initialBalance ?? balance,
        balance,
        tariffPerUnit ?? 0,
        lastReading ?? 0,
        status ?? 'active',
      ]
    );

    const meter = await findElectricityMeter(result.insertId);
    const [propRows] = await pool.query(
      'SELECT id, name, property_code FROM properties WHERE id = ? LIMIT 1',
      [meter.property_id]
    );
    meter.property = propRows[0] ?? null;

    return ok(res, meter, 'Meter created successfully.', 201);
  } catch (e) {
    next(e);
  }
});

router.put('/meters/:meter', async (req, res, next) => {
  try {
    const meter = await findElectricityMeter(req.params.meter);
    if (!meter) return fail(res, 'Meter not found.', 404);

    const allowed = [
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
    const params = [];

    for (const field of allowed) {
      const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const value = req.body[field] ?? req.body[camel];
      if (value !== undefined) {
        if (field === 'meter_number') {
          const [dup] = await pool.query(
            'SELECT id FROM electricity_meters WHERE meter_number = ? AND id != ? LIMIT 1',
            [value, meter.id]
          );
          if (dup.length) return fail(res, 'The meter number has already been taken.', 422);
        }
        if (field === 'series_number') {
          const [dup] = await pool.query(
            'SELECT id FROM electricity_meters WHERE series_number = ? AND id != ? LIMIT 1',
            [value, meter.id]
          );
          if (dup.length) return fail(res, 'The series number has already been taken.', 422);
        }
        updates.push(`${field} = ?`);
        params.push(value);
      }
    }

    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(meter.id);
      await pool.query(`UPDATE electricity_meters SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const fresh = await findElectricityMeter(meter.id);
    const [propRows] = await pool.query(
      'SELECT id, name, property_code FROM properties WHERE id = ? LIMIT 1',
      [fresh.property_id]
    );
    fresh.property = propRows[0] ?? null;

    return ok(res, fresh, 'Meter updated successfully.');
  } catch (e) {
    next(e);
  }
});

router.delete('/meters/:meter', async (req, res, next) => {
  try {
    const meter = await findElectricityMeter(req.params.meter);
    if (!meter) return fail(res, 'Meter not found.', 404);
    await pool.query('DELETE FROM electricity_meters WHERE id = ?', [meter.id]);
    return ok(res, null, 'Meter deleted successfully.');
  } catch (e) {
    next(e);
  }
});

router.get('/electricity-consumptions', async (req, res, next) => {
  try {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';

    if (req.query.property_id) {
      where += ' AND ec.property_id = ?';
      params.push(req.query.property_id);
    }
    if (req.query.meter_id) {
      where += ' AND ec.meter_id = ?';
      params.push(req.query.meter_id);
    }

    const { rows, total } = await paginatedQuery(
      `SELECT ec.*, p.name AS property_name, p.property_code,
        em.meter_name, em.meter_number
       FROM electricity_consumptions ec
       LEFT JOIN properties p ON p.id = ec.property_id
       LEFT JOIN electricity_meters em ON em.id = ec.meter_id
       WHERE ${where}
       ORDER BY ec.calculation_date DESC`,
      `SELECT COUNT(*) AS total FROM electricity_consumptions ec WHERE ${where}`,
      params,
      page,
      perPage
    );

    const data = rows.map((r) => ({
      ...r,
      property: r.property_id
        ? { id: r.property_id, name: r.property_name, property_code: r.property_code }
        : null,
      meter: r.meter_id
        ? { id: r.meter_id, meter_name: r.meter_name, meter_number: r.meter_number }
        : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (e) {
    next(e);
  }
});

router.post('/electricity-consumptions', async (req, res, next) => {
  try {
    const { property_id: propertyId, meter_id: meterId, total_consumed_units: units, calculation_date: calcDate } =
      req.body;

    if (!propertyId || !meterId || units == null || !calcDate) {
      return fail(res, 'property_id, meter_id, total_consumed_units, and calculation_date are required.', 422);
    }

    const consumption = await electricityConsumptionService.record(
      {
        property_id: propertyId,
        meter_id: meterId,
        total_consumed_units: units,
        calculation_date: calcDate,
      },
      req.user
    );

    return ok(res, consumption, 'Electricity consumption recorded successfully.', 201);
  } catch (e) {
    if (e.status) return fail(res, e.message, e.status);
    next(e);
  }
});

router.get('/electricity-consumptions/:electricityConsumption', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM electricity_consumptions WHERE id = ? LIMIT 1',
      [req.params.electricityConsumption]
    );
    if (!rows.length) return fail(res, 'Consumption record not found.', 404);

    const consumption = rows[0];
    const [propertyRows] = await pool.query('SELECT * FROM properties WHERE id = ? LIMIT 1', [
      consumption.property_id,
    ]);
    const [meterRows] = await pool.query('SELECT * FROM electricity_meters WHERE id = ? LIMIT 1', [
      consumption.meter_id,
    ]);
    let creator = null;
    if (consumption.created_by) {
      const [creatorRows] = await pool.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [
        consumption.created_by,
      ]);
      creator = creatorRows[0] ?? null;
    }
    const [charges] = await pool.query(
      'SELECT * FROM tenant_unbilled_charges WHERE electricity_consumption_id = ?',
      [consumption.id]
    );

    consumption.property = propertyRows[0] ?? null;
    consumption.meter = meterRows[0] ?? null;
    consumption.creator = creator;
    consumption.unbilled_charges = charges;

    return ok(res, consumption);
  } catch (e) {
    next(e);
  }
});

async function billConfigRoutes(method, req, res, next, id = null) {
  const table = 'tenant_bill_configurations';

  if (method === 'index') {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';
    if (req.query.tenant_id) {
      where += ' AND tbc.tenant_id = ?';
      params.push(req.query.tenant_id);
    }
    const { rows, total } = await paginatedQuery(
      `SELECT tbc.*, u.name AS tenant_name, u.mobile AS tenant_mobile, c.name AS creator_name
       FROM ${table} tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       LEFT JOIN users c ON c.id = tbc.created_by
       WHERE ${where}
       ORDER BY tbc.created_at DESC`,
      `SELECT COUNT(*) AS total FROM ${table} tbc WHERE ${where}`,
      params,
      page,
      perPage
    );
    const data = rows.map((r) => ({
      ...r,
      tenant: { id: r.tenant_id, name: r.tenant_name, mobile: r.tenant_mobile },
      creator: r.created_by ? { id: r.created_by, name: r.creator_name } : null,
    }));
    return ok(res, paginate(data, total, page, perPage));
  }

  if (method === 'store') {
    const { tenant_id: tenantId, bill_cycle_day: billCycleDay, billing_status: billingStatus } = req.body;
    if (!tenantId || !billCycleDay || !billingStatus) {
      return fail(res, 'tenant_id, bill_cycle_day, and billing_status are required.', 422);
    }
    const [tenantRows] = await pool.query(
      "SELECT id FROM users WHERE id = ? AND role = 'tenant' LIMIT 1",
      [tenantId]
    );
    if (!tenantRows.length) return fail(res, 'Selected user is not a tenant.', 422);

    const [existing] = await pool.query('SELECT id FROM tenant_bill_configurations WHERE tenant_id = ? LIMIT 1', [
      tenantId,
    ]);

    if (existing.length) {
      await pool.query(
        `UPDATE tenant_bill_configurations
         SET bill_cycle_day = ?, billing_status = ?, created_by = ?, updated_at = NOW()
         WHERE tenant_id = ?`,
        [billCycleDay, billingStatus, req.user.id, tenantId]
      );
    } else {
      await pool.query(
        `INSERT INTO tenant_bill_configurations (tenant_id, bill_cycle_day, billing_status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [tenantId, billCycleDay, billingStatus, req.user.id]
      );
    }

    const [rows] = await pool.query(
      `SELECT tbc.*, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_bill_configurations tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       WHERE tbc.tenant_id = ? LIMIT 1`,
      [tenantId]
    );
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
    }, 'Tenant bill configuration saved successfully.', 201);
  }

  if (method === 'show') {
    const [rows] = await pool.query(
      `SELECT tbc.*, u.name AS tenant_name, u.mobile AS tenant_mobile, c.name AS creator_name
       FROM tenant_bill_configurations tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       LEFT JOIN users c ON c.id = tbc.created_by
       WHERE tbc.id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) return fail(res, 'Bill configuration not found.', 404);
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
      creator: rows[0].created_by ? { id: rows[0].created_by, name: rows[0].creator_name } : null,
    });
  }

  if (method === 'update') {
    const [existing] = await pool.query('SELECT * FROM tenant_bill_configurations WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return fail(res, 'Bill configuration not found.', 404);

    const { bill_cycle_day: billCycleDay, billing_status: billingStatus } = req.body;
    const updates = [];
    const params = [];
    if (billCycleDay !== undefined) {
      updates.push('bill_cycle_day = ?');
      params.push(billCycleDay);
    }
    if (billingStatus !== undefined) {
      updates.push('billing_status = ?');
      params.push(billingStatus);
    }
    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(id);
      await pool.query(`UPDATE tenant_bill_configurations SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await pool.query(
      `SELECT tbc.*, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_bill_configurations tbc
       LEFT JOIN users u ON u.id = tbc.tenant_id
       WHERE tbc.id = ? LIMIT 1`,
      [id]
    );
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
    }, 'Bill configuration updated successfully.');
  }

  if (method === 'destroy') {
    const [existing] = await pool.query('SELECT id FROM tenant_bill_configurations WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return fail(res, 'Bill configuration not found.', 404);
    await pool.query('DELETE FROM tenant_bill_configurations WHERE id = ?', [id]);
    return ok(res, null, 'Bill configuration deleted successfully.');
  }
}

router.get('/bill-configurations', (req, res, next) => billConfigRoutes('index', req, res, next).catch(next));
router.post('/bill-configurations', (req, res, next) => billConfigRoutes('store', req, res, next).catch(next));
router.get('/bill-configurations/:billConfiguration', (req, res, next) =>
  billConfigRoutes('show', req, res, next, req.params.billConfiguration).catch(next)
);
router.put('/bill-configurations/:billConfiguration', (req, res, next) =>
  billConfigRoutes('update', req, res, next, req.params.billConfiguration).catch(next)
);
router.delete('/bill-configurations/:billConfiguration', (req, res, next) =>
  billConfigRoutes('destroy', req, res, next, req.params.billConfiguration).catch(next)
);

async function unbilledChargeRoutes(method, req, res, next, id = null) {
  if (method === 'index') {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';
    if (req.query.tenant_id) {
      where += ' AND uc.tenant_id = ?';
      params.push(req.query.tenant_id);
    }
    if (req.query.status) {
      where += ' AND uc.status = ?';
      params.push(req.query.status);
    }
    const { rows, total } = await paginatedQuery(
      `SELECT uc.*, u.name AS tenant_name, u.mobile AS tenant_mobile,
        ec.total_consumed_units, ec.calculation_date, c.name AS creator_name
       FROM tenant_unbilled_charges uc
       LEFT JOIN users u ON u.id = uc.tenant_id
       LEFT JOIN electricity_consumptions ec ON ec.id = uc.electricity_consumption_id
       LEFT JOIN users c ON c.id = uc.created_by
       WHERE ${where}
       ORDER BY uc.created_at DESC`,
      `SELECT COUNT(*) AS total FROM tenant_unbilled_charges uc WHERE ${where}`,
      params,
      page,
      perPage
    );
    const data = rows.map((r) => ({
      ...r,
      tenant: { id: r.tenant_id, name: r.tenant_name, mobile: r.tenant_mobile },
      electricity_consumption: r.electricity_consumption_id
        ? { id: r.electricity_consumption_id, total_consumed_units: r.total_consumed_units, calculation_date: r.calculation_date }
        : null,
      creator: r.created_by ? { id: r.created_by, name: r.creator_name } : null,
    }));
    return ok(res, paginate(data, total, page, perPage));
  }

  if (method === 'store') {
    const {
      tenant_id: tenantId,
      electricity_consumption_id: consumptionId,
      activity_type: activityType,
      amount,
      status,
    } = req.body;
    if (!tenantId || !activityType || amount == null) {
      return fail(res, 'tenant_id, activity_type, and amount are required.', 422);
    }
    const [result] = await pool.query(
      `INSERT INTO tenant_unbilled_charges (
        tenant_id, electricity_consumption_id, activity_type, amount, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [tenantId, consumptionId ?? null, activityType, amount, status ?? 'active', req.user.id]
    );
    const [rows] = await pool.query(
      `SELECT uc.*, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_unbilled_charges uc
       LEFT JOIN users u ON u.id = uc.tenant_id
       WHERE uc.id = ? LIMIT 1`,
      [result.insertId]
    );
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
    }, 'Unbilled charge added successfully.', 201);
  }

  if (method === 'show') {
    const [rows] = await pool.query('SELECT * FROM tenant_unbilled_charges WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return fail(res, 'Unbilled charge not found.', 404);
    const charge = rows[0];
    const [tenantRows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [charge.tenant_id]);
    let consumption = null;
    if (charge.electricity_consumption_id) {
      const [ecRows] = await pool.query('SELECT * FROM electricity_consumptions WHERE id = ? LIMIT 1', [
        charge.electricity_consumption_id,
      ]);
      consumption = ecRows[0] ?? null;
    }
    let creator = null;
    if (charge.created_by) {
      const [cRows] = await pool.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [charge.created_by]);
      creator = cRows[0] ?? null;
    }
    charge.tenant = tenantRows[0] ?? null;
    charge.electricity_consumption = consumption;
    charge.creator = creator;
    return ok(res, charge);
  }

  if (method === 'update') {
    const [existing] = await pool.query('SELECT * FROM tenant_unbilled_charges WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return fail(res, 'Unbilled charge not found.', 404);

    const { activity_type: activityType, amount, status } = req.body;
    const updates = [];
    const params = [];
    if (activityType !== undefined) {
      updates.push('activity_type = ?');
      params.push(activityType);
    }
    if (amount !== undefined) {
      updates.push('amount = ?');
      params.push(amount);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }
    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(id);
      await pool.query(`UPDATE tenant_unbilled_charges SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await pool.query(
      `SELECT uc.*, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_unbilled_charges uc
       LEFT JOIN users u ON u.id = uc.tenant_id
       WHERE uc.id = ? LIMIT 1`,
      [id]
    );
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
    }, 'Unbilled charge updated successfully.');
  }

  if (method === 'destroy') {
    const [existing] = await pool.query('SELECT id FROM tenant_unbilled_charges WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return fail(res, 'Unbilled charge not found.', 404);
    await pool.query('DELETE FROM tenant_unbilled_charges WHERE id = ?', [id]);
    return ok(res, null, 'Unbilled charge deleted successfully.');
  }
}

router.get('/unbilled-charges', (req, res, next) => unbilledChargeRoutes('index', req, res, next).catch(next));
router.post('/unbilled-charges', (req, res, next) => unbilledChargeRoutes('store', req, res, next).catch(next));
router.get('/unbilled-charges/:unbilledCharge', (req, res, next) =>
  unbilledChargeRoutes('show', req, res, next, req.params.unbilledCharge).catch(next)
);
router.put('/unbilled-charges/:unbilledCharge', (req, res, next) =>
  unbilledChargeRoutes('update', req, res, next, req.params.unbilledCharge).catch(next)
);
router.delete('/unbilled-charges/:unbilledCharge', (req, res, next) =>
  unbilledChargeRoutes('destroy', req, res, next, req.params.unbilledCharge).catch(next)
);

async function otherActiveChargeRoutes(method, req, res, next, id = null) {
  if (method === 'index') {
    const page = parsePage(req);
    const perPage = 20;
    const params = [];
    let where = '1=1';
    if (req.query.tenant_id) {
      where += ' AND oac.tenant_id = ?';
      params.push(req.query.tenant_id);
    }
    const { rows, total } = await paginatedQuery(
      `SELECT oac.*, u.name AS tenant_name, u.mobile AS tenant_mobile, c.name AS creator_name
       FROM tenant_other_active_charges oac
       LEFT JOIN users u ON u.id = oac.tenant_id
       LEFT JOIN users c ON c.id = oac.created_by
       WHERE ${where}
       ORDER BY oac.created_at DESC`,
      `SELECT COUNT(*) AS total FROM tenant_other_active_charges oac WHERE ${where}`,
      params,
      page,
      perPage
    );
    const data = rows.map((r) => ({
      ...r,
      tenant: { id: r.tenant_id, name: r.tenant_name, mobile: r.tenant_mobile },
      creator: r.created_by ? { id: r.created_by, name: r.creator_name } : null,
    }));
    return ok(res, paginate(data, total, page, perPage));
  }

  if (method === 'store') {
    const { tenant_id: tenantId, charge_type: chargeType, amount, status } = req.body;
    if (!tenantId || !chargeType || amount == null) {
      return fail(res, 'tenant_id, charge_type, and amount are required.', 422);
    }
    const [result] = await pool.query(
      `INSERT INTO tenant_other_active_charges (tenant_id, charge_type, amount, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [tenantId, chargeType, amount, status ?? 'active', req.user.id]
    );
    const [rows] = await pool.query(
      `SELECT oac.*, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_other_active_charges oac
       LEFT JOIN users u ON u.id = oac.tenant_id
       WHERE oac.id = ? LIMIT 1`,
      [result.insertId]
    );
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
    }, 'Other active charge added successfully.', 201);
  }

  if (method === 'show') {
    const [rows] = await pool.query('SELECT * FROM tenant_other_active_charges WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return fail(res, 'Other active charge not found.', 404);
    const charge = rows[0];
    const [tenantRows] = await pool.query('SELECT id, name, mobile FROM users WHERE id = ? LIMIT 1', [
      charge.tenant_id,
    ]);
    let creator = null;
    if (charge.created_by) {
      const [cRows] = await pool.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [charge.created_by]);
      creator = cRows[0] ?? null;
    }
    charge.tenant = tenantRows[0] ?? null;
    charge.creator = creator;
    return ok(res, charge);
  }

  if (method === 'update') {
    const [existing] = await pool.query('SELECT * FROM tenant_other_active_charges WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return fail(res, 'Other active charge not found.', 404);

    const { charge_type: chargeType, amount, status } = req.body;
    const updates = [];
    const params = [];
    if (chargeType !== undefined) {
      updates.push('charge_type = ?');
      params.push(chargeType);
    }
    if (amount !== undefined) {
      updates.push('amount = ?');
      params.push(amount);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }
    if (updates.length) {
      updates.push('updated_at = NOW()');
      params.push(id);
      await pool.query(`UPDATE tenant_other_active_charges SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await pool.query(
      `SELECT oac.*, u.name AS tenant_name, u.mobile AS tenant_mobile
       FROM tenant_other_active_charges oac
       LEFT JOIN users u ON u.id = oac.tenant_id
       WHERE oac.id = ? LIMIT 1`,
      [id]
    );
    return ok(res, {
      ...rows[0],
      tenant: { id: rows[0].tenant_id, name: rows[0].tenant_name, mobile: rows[0].tenant_mobile },
    }, 'Other active charge updated successfully.');
  }

  if (method === 'destroy') {
    const [existing] = await pool.query('SELECT id FROM tenant_other_active_charges WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return fail(res, 'Other active charge not found.', 404);
    await pool.query('DELETE FROM tenant_other_active_charges WHERE id = ?', [id]);
    return ok(res, null, 'Other active charge deleted successfully.');
  }
}

router.get('/other-active-charges', (req, res, next) =>
  otherActiveChargeRoutes('index', req, res, next).catch(next)
);
router.post('/other-active-charges', (req, res, next) =>
  otherActiveChargeRoutes('store', req, res, next).catch(next)
);
router.get('/other-active-charges/:otherActiveCharge', (req, res, next) =>
  otherActiveChargeRoutes('show', req, res, next, req.params.otherActiveCharge).catch(next)
);
router.put('/other-active-charges/:otherActiveCharge', (req, res, next) =>
  otherActiveChargeRoutes('update', req, res, next, req.params.otherActiveCharge).catch(next)
);
router.delete('/other-active-charges/:otherActiveCharge', (req, res, next) =>
  otherActiveChargeRoutes('destroy', req, res, next, req.params.otherActiveCharge).catch(next)
);

module.exports = router;
