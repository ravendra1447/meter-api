const express = require('express');
const pool = require('../config/database');
const { ok, fail } = require('../utils/response');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Middleware to ensure owner access
router.use((req, res, next) => {
  if (req.user.role !== 'owner' && !req.user.is_property_owner) {
    return fail(res, 'Unauthorized', 403);
  }
  next();
});

// Get all expenses for owner
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.*, p.name as property_name 
       FROM property_expenses e
       JOIN properties p ON e.property_id = p.id
       WHERE e.owner_id = ? 
       ORDER BY e.expense_date DESC`,
      [req.user.id]
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Add new expense
router.post('/', async (req, res) => {
  const { property_id, category, amount, expense_date, description } = req.body;
  if (!property_id || !category || !amount || !expense_date) return fail(res, 'Missing fields', 400);

  try {
    // Verify property ownership
    const [props] = await pool.query('SELECT id FROM properties WHERE id = ? AND owner_id = ?', [property_id, req.user.id]);
    if (!props.length) return fail(res, 'Invalid property', 400);

    await pool.query(
      `INSERT INTO property_expenses (property_id, owner_id, category, amount, expense_date, description, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [property_id, req.user.id, category, amount, expense_date, description || null]
    );
    return ok(res, null, 'Expense added successfully');
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Delete expense
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM property_expenses WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return fail(res, 'Expense not found', 404);
    return ok(res, null, 'Expense deleted');
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

module.exports = router;
