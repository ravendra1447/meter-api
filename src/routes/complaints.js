const express = require('express');
const pool = require('../config/database');
const { ok, fail } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { activeTenantAssignment } = require('../helpers/userHelpers');

const router = express.Router();
router.use(authenticate);

// Tenant: Get my complaints
router.get('/my', async (req, res) => {
  if (req.user.role !== 'tenant') return fail(res, 'Unauthorized', 403);
  try {
    const [rows] = await pool.query(
      `SELECT * FROM tenant_complaints WHERE tenant_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Tenant: Create complaint
router.post('/', async (req, res) => {
  if (req.user.role !== 'tenant') return fail(res, 'Unauthorized', 403);
  const { title, description, category } = req.body;
  if (!title || !description || !category) return fail(res, 'Missing fields', 400);

  try {
    const assignment = await activeTenantAssignment(req.user.id);
    if (!assignment) return fail(res, 'No active property linked', 404);

    await pool.query(
      `INSERT INTO tenant_complaints (tenant_id, property_id, category, title, description, status, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, 'open', NOW(), NOW())`,
      [req.user.id, assignment.property_id, category, title, description]
    );
    return ok(res, null, 'Complaint submitted successfully');
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Owner: Get complaints for my properties
router.get('/owner', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, p.name as property_name, u.name as tenant_name 
       FROM tenant_complaints c
       JOIN properties p ON c.property_id = p.id
       JOIN users u ON c.tenant_id = u.id
       WHERE p.owner_id = ? 
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Owner: Update complaint status
router.put('/:id/status', async (req, res) => {
  const { status } = req.body;
  try {
    const [result] = await pool.query(
      `UPDATE tenant_complaints c
       JOIN properties p ON c.property_id = p.id
       SET c.status = ?, c.resolved_at = IF(? = 'resolved', NOW(), c.resolved_at), c.updated_at = NOW()
       WHERE c.id = ? AND p.owner_id = ?`,
      [status, status, req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return fail(res, 'Complaint not found or unauthorized', 404);
    return ok(res, null, 'Status updated');
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

module.exports = router;
