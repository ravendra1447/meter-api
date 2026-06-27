const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { ok, fail } = require('../utils/response');
const { createToken, revokeAllTokens, revokeToken } = require('../utils/sanctum');
const { authenticate } = require('../middleware/auth');
const { formatUser, enrichUser, mobileRegex } = require('../helpers/userHelpers');

const router = express.Router();

const SALT_ROUNDS = 10;

function validateEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function passwordConfirmed(body) {
  return body.password === body.password_confirmation;
}

async function uniqueMobile(mobile, excludeId = null) {
  const sql = excludeId
    ? 'SELECT id FROM users WHERE mobile = ? AND id != ? LIMIT 1'
    : 'SELECT id FROM users WHERE mobile = ? LIMIT 1';
  const params = excludeId ? [mobile, excludeId] : [mobile];
  const [rows] = await pool.query(sql, params);
  return !rows.length;
}

async function uniqueEmail(email, excludeId = null) {
  if (!email) return true;
  const sql = excludeId
    ? 'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1'
    : 'SELECT id FROM users WHERE email = ? LIMIT 1';
  const params = excludeId ? [email, excludeId] : [email];
  const [rows] = await pool.query(sql, params);
  return !rows.length;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

router.post('/owner/register', async (req, res) => {
  try {
    const { name, mobile, email, password, password_confirmation } = req.body;

    if (!name || !mobile || !password) {
      return fail(res, 'Name, mobile, and password are required.', 422);
    }
    if (!mobileRegex(mobile)) {
      return fail(res, 'Invalid mobile number format.', 422);
    }
    if (password.length < 6) {
      return fail(res, 'Password must be at least 6 characters.', 422);
    }
    if (!passwordConfirmed(req.body)) {
      return fail(res, 'Password confirmation does not match.', 422);
    }
    if (email && !validateEmail(email)) {
      return fail(res, 'Invalid email address.', 422);
    }
    if (!(await uniqueMobile(mobile))) {
      const [existingRows] = await pool.query('SELECT * FROM users WHERE mobile = ? LIMIT 1', [mobile]);
      const existing = existingRows[0];
      if (existing.role === 'owner' || existing.is_property_owner) {
        return fail(res, 'This mobile number is already registered as a property owner.', 422);
      }

      const hashed = await hashPassword(password);
      await pool.query(
        `UPDATE users SET name = ?, email = ?, password = ?, is_property_owner = 1, updated_at = NOW() WHERE id = ?`,
        [name, email ?? existing.email, hashed, existing.id]
      );
      await revokeAllTokens(existing.id);
      const [userRows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [existing.id]);
      const user = userRows[0];
      const token = await createToken(user.id);

      return ok(
        res,
        { user: await enrichUser(user), token },
        'Owner access enabled on your existing account.'
      );
    }
    if (email && !(await uniqueEmail(email))) {
      return fail(res, 'Email already registered.', 422);
    }

    const hashed = await hashPassword(password);
    const [result] = await pool.query(
      `INSERT INTO users (name, mobile, email, password, role, is_property_owner, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'owner', 1, 1, NOW(), NOW())`,
      [name, mobile, email ?? null, hashed]
    );

    const [userRows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [result.insertId]);
    const user = userRows[0];
    const token = await createToken(user.id);

    return ok(
      res,
      { user: await enrichUser(user), token },
      'Owner registered successfully.',
      201
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Registration failed.', 500);
  }
});

router.post('/tenant/register', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { name, mobile, email, password, password_confirmation, property_code, move_in_date } =
      req.body;

    if (!name || !mobile || !password || !property_code) {
      return fail(res, 'Name, mobile, password, and property_code are required.', 422);
    }
    if (!mobileRegex(mobile)) {
      return fail(res, 'Invalid mobile number format.', 422);
    }
    if (password.length < 6) {
      return fail(res, 'Password must be at least 6 characters.', 422);
    }
    if (!passwordConfirmed(req.body)) {
      return fail(res, 'Password confirmation does not match.', 422);
    }
    if (email && !validateEmail(email)) {
      return fail(res, 'Invalid email address.', 422);
    }
    if (!(await uniqueMobile(mobile))) {
      return fail(res, 'Mobile number already registered.', 422);
    }
    if (email && !(await uniqueEmail(email))) {
      return fail(res, 'Email already registered.', 422);
    }

    const [propertyRows] = await conn.query(
      'SELECT * FROM properties WHERE property_code = ? AND status = ? LIMIT 1',
      [property_code, 'active']
    );

    if (!propertyRows.length) {
      return fail(res, 'Invalid or inactive property code.', 422);
    }

    const property = propertyRows[0];
    const hashed = await hashPassword(password);
    const moveIn = move_in_date ?? new Date().toISOString().slice(0, 10);

    await conn.beginTransaction();

    const [userResult] = await conn.query(
      `INSERT INTO users (name, mobile, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'tenant', 1, NOW(), NOW())`,
      [name, mobile, email ?? null, hashed]
    );

    await conn.query(
      `INSERT INTO property_tenants (property_id, tenant_id, move_in_date, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', NOW(), NOW())`,
      [property.id, userResult.insertId, moveIn]
    );

    await conn.commit();

    const [userRows] = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [
      userResult.insertId,
    ]);
    const user = userRows[0];
    const token = await createToken(user.id);

    return ok(
      res,
      {
        user: formatUser(user),
        property: {
          id: property.id,
          property_code: property.property_code,
          name: property.name,
        },
        token,
      },
      'Tenant registered and linked to property successfully.',
      201
    );
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Registration failed.', 500);
  } finally {
    conn.release();
  }
});

router.post('/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return fail(res, 'Mobile and password are required.', 422);
    }
    if (!mobileRegex(mobile)) {
      return fail(res, 'Invalid mobile number format.', 422);
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE mobile = ? LIMIT 1', [mobile]);
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return fail(res, 'Invalid mobile number or password.', 401);
    }

    if (!user.is_active) {
      return fail(res, 'Your account is inactive. Please contact support.', 403);
    }

    await revokeAllTokens(user.id);
    const token = await createToken(user.id);

    return ok(res, { user: await enrichUser(user), token }, 'Login successful.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Login failed.', 500);
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { mobile, password, password_confirmation } = req.body;

    if (!mobile || !password) {
      return fail(res, 'Mobile and password are required.', 422);
    }
    if (!mobileRegex(mobile)) {
      return fail(res, 'Invalid mobile number format.', 422);
    }
    if (password.length < 6) {
      return fail(res, 'Password must be at least 6 characters.', 422);
    }
    if (!passwordConfirmed(req.body)) {
      return fail(res, 'Password confirmation does not match.', 422);
    }

    const [rows] = await pool.query('SELECT id FROM users WHERE mobile = ? LIMIT 1', [mobile]);
    if (!rows.length) {
      return fail(res, 'Mobile number not registered.', 404);
    }

    const hashed = await hashPassword(password);
    await pool.query('UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?', [
      hashed,
      rows[0].id,
    ]);

    return ok(res, null, 'Password reset successfully. You can login now.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Password reset failed.', 500);
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = req.user;
    const data = { user: await enrichUser(user) };

    if (data.user.can_access_tenant) {
      const [assignmentRows] = await pool.query(
        `SELECT pt.property_id,
           p.id, p.owner_id, p.property_code, p.name, p.address, p.city, p.state,
           p.pincode, p.monthly_rent, p.maintenance_charges, p.water_charges,
           p.security_deposit_amount, p.status
         FROM property_tenants pt
         INNER JOIN properties p ON p.id = pt.property_id
         WHERE pt.tenant_id = ? AND pt.status = 'active'
         ORDER BY pt.id DESC LIMIT 1`,
        [user.id]
      );

      if (assignmentRows.length) {
        const row = assignmentRows[0];
        data.property = {
          id: row.id,
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
        };

        const [meters] = await pool.query(
          'SELECT * FROM electricity_meters WHERE property_id = ? ORDER BY id DESC',
          [row.id]
        );
        data.meters = meters;
      }
    }

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load profile.', 500);
  }
});

router.post('/become-owner', authenticate, async (req, res) => {
  try {
    const user = req.user;
    if (user.role === 'master') {
      return fail(res, 'Master accounts cannot use owner mode in the app.', 422);
    }
    if (user.role === 'owner' || user.is_property_owner) {
      return ok(res, { user: await enrichUser(user) }, 'You already have owner access.');
    }

    await pool.query('UPDATE users SET is_property_owner = 1, updated_at = NOW() WHERE id = ?', [
      user.id,
    ]);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [user.id]);

    return ok(
      res,
      { user: await enrichUser(rows[0]) },
      'Owner access enabled. You can add meters and properties now.'
    );
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to enable owner access.', 500);
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    if (req.user.token_id) {
      await revokeToken(req.user.token_id);
    }
    return ok(res, null, 'Logged out successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Logout failed.', 500);
  }
});

router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name) {
      return fail(res, 'Name is required.', 422);
    }
    if (email && !validateEmail(email)) {
      return fail(res, 'Invalid email address.', 422);
    }

    await pool.query('UPDATE users SET name = ?, email = ?, updated_at = NOW() WHERE id = ?', [
      name,
      email ?? null,
      req.user.id,
    ]);

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    return ok(res, { user: formatUser(rows[0]) }, 'Profile updated.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Profile update failed.', 500);
  }
});

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, password, password_confirmation } = req.body;

    if (!current_password || !password) {
      return fail(res, 'Current password and new password are required.', 422);
    }
    if (password.length < 6) {
      return fail(res, 'Password must be at least 6 characters.', 422);
    }
    if (!passwordConfirmed(req.body)) {
      return fail(res, 'Password confirmation does not match.', 422);
    }

    const [rows] = await pool.query('SELECT password FROM users WHERE id = ? LIMIT 1', [
      req.user.id,
    ]);

    if (!(await bcrypt.compare(current_password, rows[0].password))) {
      return fail(res, 'Current password is incorrect.', 422);
    }

    const hashed = await hashPassword(password);
    await pool.query('UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?', [
      hashed,
      req.user.id,
    ]);

    return ok(res, null, 'Password changed successfully.');
  } catch (err) {
    console.error(err);
    return fail(res, 'Password change failed.', 500);
  }
});

module.exports = router;
