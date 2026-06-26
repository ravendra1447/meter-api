// routes/locationRoutes.js

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { ok, fail } = require('../utils/response');
const { authenticate, requireRole } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

/**
 * Save meter location
 * POST /api/meters/location
 */
router.post('/meters/location', async (req, res) => {
  try {
    const { meter_id, electricity_meter_id, latitude, longitude, accuracy } = req.body;

    if (!meter_id || !electricity_meter_id || latitude == null || longitude == null) {
      return fail(res, 'meter_id, electricity_meter_id, latitude, and longitude are required.', 422);
    }

    await pool.query(
      `UPDATE meters 
       SET latitude = ?, longitude = ?, last_scan_date = NOW(), scan_count = scan_count + 1, updated_at = NOW()
       WHERE id = ?`,
      [latitude, longitude, meter_id]
    );

    await pool.query(
      `UPDATE electricity_meters 
       SET latitude = ?, longitude = ?, last_scan_date = NOW(), scan_count = scan_count + 1, updated_at = NOW()
       WHERE id = ?`,
      [latitude, longitude, electricity_meter_id]
    );

    await pool.query(
      `INSERT INTO location_logs (meter_id, electricity_meter_id, latitude, longitude, accuracy, scan_date)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [meter_id, electricity_meter_id, latitude, longitude, accuracy || 0]
    );

    return ok(res, null, 'Location saved successfully.');
  } catch (err) {
    console.error('[Location] Error saving location:', err);
    return fail(res, 'Failed to save location.', 500);
  }
});

/**
 * Save installation date
 * POST /api/meters/installation
 */
router.post('/meters/installation', async (req, res) => {
  try {
    const { meter_id, electricity_meter_id, installation_date, notes } = req.body;

    if (!meter_id || !electricity_meter_id || !installation_date) {
      return fail(res, 'meter_id, electricity_meter_id, and installation_date are required.', 422);
    }

    const installDate = new Date(installation_date);

    await pool.query(
      `UPDATE meters 
       SET installation_date = ?, first_scan_date = ?, updated_at = NOW()
       WHERE id = ?`,
      [installDate, installDate, meter_id]
    );

    await pool.query(
      `UPDATE electricity_meters 
       SET installation_date = ?, first_scan_date = ?, updated_at = NOW()
       WHERE id = ?`,
      [installDate, installDate, electricity_meter_id]
    );

    await pool.query(
      `INSERT INTO installation_logs (meter_id, electricity_meter_id, installed_by, installation_date, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [meter_id, electricity_meter_id, req.user.id, installDate, notes || '']
    );

    return ok(res, null, 'Installation date saved successfully.');
  } catch (err) {
    console.error('[Location] Error saving installation date:', err);
    return fail(res, 'Failed to save installation date.', 500);
  }
});

/**
 * Get scan info for a meter
 * GET /api/meters/:meterId/scan-info
 */
router.get('/meters/:meterId/scan-info', async (req, res) => {
  try {
    const meterId = parseInt(req.params.meterId, 10);

    const [rows] = await pool.query(
      `SELECT scan_count, first_scan_date, last_scan_date, installation_date, latitude, longitude
       FROM meters
       WHERE id = ?`,
      [meterId]
    );

    if (!rows.length) {
      return fail(res, 'Meter not found.', 404);
    }

    const data = rows[0];
    return ok(res, {
      scan_count: data.scan_count || 0,
      is_first_scan: (data.scan_count || 0) === 0,
      first_scan_date: data.first_scan_date,
      last_scan_date: data.last_scan_date,
      installation_date: data.installation_date,
      latitude: data.latitude,
      longitude: data.longitude,
    });
  } catch (err) {
    console.error('[Location] Error getting scan info:', err);
    return fail(res, 'Failed to get scan info.', 500);
  }
});

/**
 * Get location history
 * GET /api/meters/location-history/:meterId
 */
router.get('/meters/location-history/:meterId', async (req, res) => {
  try {
    const meterId = parseInt(req.params.meterId, 10);

    const [rows] = await pool.query(
      `SELECT * FROM location_logs
       WHERE meter_id = ?
       ORDER BY scan_date DESC
       LIMIT 50`,
      [meterId]
    );

    return ok(res, rows);
  } catch (err) {
    console.error('[Location] Error getting location history:', err);
    return fail(res, 'Failed to get location history.', 500);
  }
});

/**
 * Get installation logs
 * GET /api/meters/installation-logs/:meterId
 */
router.get('/meters/installation-logs/:meterId', async (req, res) => {
  try {
    const meterId = parseInt(req.params.meterId, 10);

    const [rows] = await pool.query(
      `SELECT il.*, u.name as installed_by_name
       FROM installation_logs il
       LEFT JOIN users u ON u.id = il.installed_by
       WHERE il.meter_id = ?
       ORDER BY il.installation_date DESC
       LIMIT 20`,
      [meterId]
    );

    return ok(res, rows);
  } catch (err) {
    console.error('[Location] Error getting installation logs:', err);
    return fail(res, 'Failed to get installation logs.', 500);
  }
});

/**
 * Get all meters with location (owner only)
 * GET /api/owner/meters-with-location
 */
router.get('/owner/meters-with-location', requireRole('owner'), async (req, res) => {
  try {
    const ownerId = req.user.id;

    const [rows] = await pool.query(
      `SELECT 
         em.id as electricity_meter_id,
         em.meter_number,
         em.meter_name,
         em.latitude,
         em.longitude,
         em.installation_date,
         em.first_scan_date,
         em.last_scan_date,
         em.scan_count,
         p.name as property_name,
         p.property_code
       FROM electricity_meters em
       INNER JOIN properties p ON p.id = em.property_id
       WHERE p.owner_id = ?
       ORDER BY em.id DESC`,
      [ownerId]
    );

    return ok(res, rows);
  } catch (err) {
    console.error('[Location] Error getting meters with location:', err);
    return fail(res, 'Failed to get meters with location.', 500);
  }
});

module.exports = router;