// routes/tenant.js

const express = require('express');
const pool = require('../config/database');
const { ok, fail, paginate } = require('../utils/response');
const { authenticate, requireRole } = require('../middleware/auth');
const { activeTenantAssignment, paginatedQuery } = require('../helpers/userHelpers');
const billingStatementService = require('../services/billingStatementService');
const tenantPropertyRequestService = require('../services/tenantPropertyRequestService');
const paymentMethods = require('../utils/paymentMethods');

const router = express.Router();

router.use(authenticate, requireRole('tenant'));

function serviceError(res, err) {
  return fail(res, err.message, err.status || 500);
}

// ========== CHECK SCHEDULE STATUS HELPER ==========
function checkScheduleStatus(schedule, billing) {
  const now = new Date();
  const tz = schedule?.timezone || 'Asia/Kolkata';
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  
  const currentTime = `${String(tzDate.getHours()).padStart(2, '0')}:${String(tzDate.getMinutes()).padStart(2, '0')}`;
  const currentDayOfWeek = tzDate.getDay() === 0 ? 7 : tzDate.getDay();
  const currentDateOfMonth = tzDate.getDate();

  const scheduleType = billing?.relay_schedule_type || 'daily';
  const scheduleDay = parseInt(billing?.relay_schedule_day || '1', 10);
  const offTime = billing?.relay_off_time || billing?.daily_off_time || null;
  const onTime = billing?.relay_on_time || billing?.daily_on_time || null;

  let isOffDay = false;
  let isOnDay = false;

  switch (scheduleType) {
    case 'daily':
      isOffDay = true;
      isOnDay = true;
      break;
    case 'weekly':
      isOffDay = (currentDayOfWeek === scheduleDay);
      let expectedOnDay = scheduleDay;
      if (offTime && onTime && offTime > onTime) {
        expectedOnDay = (scheduleDay % 7) + 1;
      }
      isOnDay = (currentDayOfWeek === expectedOnDay);
      break;
    case 'monthly':
      isOffDay = (currentDateOfMonth === scheduleDay);
      let expectedOnMonthDay = scheduleDay;
      if (offTime && onTime && offTime > onTime) {
        const tempDate = new Date(tzDate);
        tempDate.setDate(scheduleDay + 1);
        expectedOnMonthDay = tempDate.getDate();
      }
      isOnDay = (currentDateOfMonth === expectedOnMonthDay);
      break;
    case 'once':
      const dateStr = `${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}-${String(tzDate.getDate()).padStart(2, '0')}`;
      if (billing?.relay_off_date && billing.relay_off_date === dateStr) isOffDay = true;
      if (billing?.relay_on_date && billing.relay_on_date === dateStr) isOnDay = true;
      break;
  }

  const isOffTime = offTime && isOffDay && Math.abs(timeDiff(currentTime, offTime)) <= 2;
  const isOnTime = onTime && isOnDay && Math.abs(timeDiff(currentTime, onTime)) <= 2;

  return {
    is_off_day: isOffDay,
    is_on_day: isOnDay,
    is_off_time: isOffTime,
    is_on_time: isOnTime,
    off_time: offTime,
    on_time: onTime,
    schedule_type: scheduleType,
    schedule_day: scheduleDay,
    current_time: currentTime
  };
}

function timeDiff(current, scheduled) {
  const [cH, cM] = current.split(':').map(Number);
  const [sH, sM] = scheduled.split(':').map(Number);
  return (cH * 60 + cM) - (sH * 60 + sM);
}

// ========== DASHBOARD ==========
router.get('/dashboard', async (req, res) => {
  try {
    const user = req.user;
    const assignment = await activeTenantAssignment(user.id);

    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const property = assignment.property;
    const statement = await billingStatementService.getStatementForTenantUser(user.id);

    const [meterRows] = await pool.query(
      `SELECT * FROM electricity_meters
       WHERE property_id = ? AND status = 'active'
       LIMIT 1`,
      [property.id]
    );
    const meter = meterRows[0] ?? null;

    const balance = meter ? Number(meter.current_balance) : 0;
    const tariff = meter ? Number(meter.tariff_per_unit) : 8.5;
    const unitsRemaining = tariff > 0 ? Math.round((balance / tariff) * 10) / 10 : 0;

    const [consumptionRows] = await pool.query(
      `SELECT * FROM electricity_consumptions
       WHERE property_id = ?
       ORDER BY calculation_date DESC
       LIMIT 1`,
      [property.id]
    );
    const latestConsumption = consumptionRows[0] ?? null;

    const monthUsage = latestConsumption ? Number(latestConsumption.total_consumed_units) : 0;
    const monthLimit = Math.max(monthUsage, 70);
    const usagePercent = Math.min(100, Math.round((monthUsage / monthLimit) * 100));

    let relayStatus = balance > 50 ? 'ON' : 'OFF';
    let smartMeterId = null;
    let relaySchedule = null;
    let scheduleStatus = null;

    if (meter) {
      const [smartRows] = await pool.query(
        'SELECT * FROM meters WHERE meter_number = ? LIMIT 1',
        [meter.meter_number]
      );
      if (smartRows.length) {
        relayStatus = smartRows[0].relay_status;
        smartMeterId = smartRows[0].id;
      }

      // Get schedule
      const [scheduleRows] = await pool.query(
        `SELECT mbs.* FROM meter_billing_schedules mbs
         WHERE mbs.electricity_meter_id = ? 
           AND mbs.status = 'active'
           AND mbs.billing IS NOT NULL
         ORDER BY mbs.created_at DESC
         LIMIT 1`,
        [meter.id]
      );

      if (scheduleRows.length) {
        const schedule = scheduleRows[0];
        let billing = schedule.billing;
        try {
          billing = typeof billing === 'string' ? JSON.parse(billing) : billing;
        } catch (e) {
          billing = null;
        }

        if (billing) {
          relaySchedule = {
            type: billing.relay_schedule_type || 'daily',
            day: billing.relay_schedule_day || 1,
            off_time: billing.relay_off_time || billing.daily_off_time || null,
            on_time: billing.relay_on_time || billing.daily_on_time || null,
            off_date: billing.relay_off_date || null,
            on_date: billing.relay_on_date || null,
            grace_days: billing.grace_days || 5,
          };

          scheduleStatus = checkScheduleStatus(schedule, billing);
        }
      }
    }

    let currentReading = 0;
    if (smartMeterId) {
      const [lastR] = await pool.query(
        'SELECT total_reading FROM meter_readings WHERE meter_id = ? ORDER BY reading_date DESC, id DESC LIMIT 1',
        [smartMeterId]
      );
      if (lastR.length) currentReading = Number(lastR[0].total_reading);
    }
    if (currentReading === 0 && latestConsumption) {
      currentReading = Number(latestConsumption.current_reading);
    }

    const [pendingPaymentRows] = await pool.query(
      `SELECT id, status FROM tenant_payments 
       WHERE tenant_id = ? AND status IN ('pending', 'approved_pending_sync', 'cash_pending_sync') 
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const hasPendingPayment = pendingPaymentRows.length > 0 && pendingPaymentRows[0].status === 'pending';
    const pendingSyncPayment = pendingPaymentRows.length > 0 && pendingPaymentRows[0].status !== 'pending' ? pendingPaymentRows[0] : null;

    return ok(res, {
      user: { name: user.name, mobile: user.mobile },
      property: {
        id: property.id,
        name: property.name,
        property_code: property.property_code,
        address: property.address,
      },
      balance,
      units_remaining: unitsRemaining,
      tariff,
      month_usage_kwh: monthUsage,
      month_usage_percent: usagePercent,
      month_usage_cost: Math.round(monthUsage * tariff * 100) / 100,
      current_reading: currentReading,
      relay_status: relayStatus,
      relay_schedule: relaySchedule,
      schedule_status: scheduleStatus,
      pre_trip_alarm: balance > 0 && balance < 100,
      meter,
      smart_meter_id: smartMeterId,
      bill: statement
        ? {
            total: statement.total,
            due_date: statement.due_date,
            status: statement.status,
            status_label: statement.status_label,
            invoice_no: statement.invoice_no,
            period: statement.period,
            grace_days: statement.grace_days || 5,
          }
        : null,
      agreement: {
        duration_months: assignment.agreement_period_months || 11,
        move_in_date: assignment.move_in_date,
        deposit_paid: !!assignment.deposit_paid,
        deposit_amount: assignment.security_deposit_amount || property.security_deposit_amount || 0,
      },
      has_pending_payment: hasPendingPayment,
      pending_sync_payment: pendingSyncPayment
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load dashboard.', 500);
  }
});

// ========== STATEMENT ==========
router.get('/statement', async (req, res) => {
  try {
    const statement = await billingStatementService.getStatementForTenantUser(req.user.id);
    if (!statement) {
      return fail(res, 'Billing statement not available.', 404);
    }
    return ok(res, statement);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load statement.', 500);
  }
});

// ========== USAGE ==========
router.get('/usage', async (req, res) => {
  try {
    const assignment = await activeTenantAssignment(req.user.id);
    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const [consumptions] = await pool.query(
      `SELECT * FROM electricity_consumptions
       WHERE property_id = ?
       ORDER BY calculation_date DESC
       LIMIT 6`,
      [assignment.property_id]
    );

    const [meterRows] = await pool.query(
      `SELECT * FROM electricity_meters
       WHERE property_id = ? AND status = 'active'
       LIMIT 1`,
      [assignment.property_id]
    );
    let meter = meterRows[0] ?? null;

    let smartMeter = null;
    if (meter) {
      const [smartRows] = await pool.query(
        'SELECT * FROM meters WHERE meter_number = ? LIMIT 1',
        [meter.meter_number]
      );
      smartMeter = smartRows[0] ?? null;
    } else {
      const [firstSmart] = await pool.query('SELECT * FROM meters LIMIT 1');
      smartMeter = firstSmart[0] ?? null;
    }

    let daily = [];

    if (smartMeter) {
      const [readings] = await pool.query(
        `SELECT * FROM meter_readings
         WHERE meter_id = ?
         ORDER BY reading_date DESC, id DESC
         LIMIT 30`,
        [smartMeter.id]
      );

      daily = readings
        .map((r) => ({
          date: typeof r.reading_date === 'string' ? r.reading_date.slice(0, 10) : r.reading_date,
          kwh: Number(r.daily_consumption),
          cost: Math.round(Number(r.daily_consumption) * (meter?.tariff_per_unit ?? 8.5) * 100) / 100,
        }))
        .reverse();
    }

    if (!daily.length && consumptions.length) {
      const latest = consumptions[0];
      const total = Number(latest.total_consumed_units);
      const rate = Number(latest.tariff_per_unit);
      const now = new Date();
      const days = now.getDate();
      const perDay = days > 0 ? total / days : total;

      for (let d = 1; d <= days; d++) {
        const date = new Date(now.getFullYear(), now.getMonth(), d);
        const dateStr = date.toISOString().slice(0, 10);
        daily.push({
          date: dateStr,
          kwh: Math.round(perDay * 100) / 100,
          cost: Math.round(perDay * rate * 100) / 100,
        });
      }
    }

    const totalUsage = daily.reduce((sum, d) => sum + d.kwh, 0);
    const totalCost = daily.reduce((sum, d) => sum + d.cost, 0);
    const avgDaily = daily.length ? Math.round((totalUsage / daily.length) * 100) / 100 : 0;

    return ok(res, {
      daily,
      summary: {
        total_usage_kwh: Math.round(totalUsage * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        avg_daily_kwh: avgDaily,
        comparison_pct: 12.4,
      },
      consumptions,
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load usage.', 500);
  }
});

// ========== PAYMENTS ==========
router.post('/payments', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { amount, method } = req.body;

    if (!amount || Number(amount) < 1) {
      return fail(res, 'Amount must be at least 1.', 422);
    }
    const validMethods = paymentMethods.ALLOWED;
    if (method && !validMethods.includes(method)) {
      return fail(res, 'Invalid payment method.', 422);
    }

    const user = req.user;
    const assignment = await activeTenantAssignment(user.id, conn);

    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const payAmount = Number(amount);
    const payMethod = method ?? 'upi';

    if (!paymentMethods.tenantMayPayWith(assignment.accepted_payment_methods, payMethod)) {
      return fail(res, 'This payment method is not accepted for your tenancy.', 422);
    }
    const now = new Date();
    const receiptNo = `RCP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO tenant_payments (tenant_id, amount, method, receipt_no, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'success', NOW(), NOW())`,
      [user.id, payAmount, payMethod, receiptNo]
    );

    const [meterRows] = await conn.query(
      `SELECT * FROM electricity_meters
       WHERE property_id = ? AND status = 'active' AND meter_type = 'prepaid'
       LIMIT 1`,
      [assignment.property_id]
    );

    if (meterRows.length) {
      const meter = meterRows[0];
      const newBalance = Number(meter.current_balance) + payAmount;
      await conn.query(
        'UPDATE electricity_meters SET current_balance = ?, updated_at = NOW() WHERE id = ?',
        [newBalance, meter.id]
      );
      
      // AUTO ON - Payment ke baad light ON
      const [smartRows] = await conn.query(
        'SELECT id, relay_status FROM meters WHERE meter_number = ? LIMIT 1',
        [meter.meter_number]
      );
      
      if (smartRows.length && newBalance > 0) {
        await conn.query(
          'UPDATE meters SET pending_relay_action = "ON", relay_status = "ON", updated_at = NOW() WHERE id = ?',
          [smartRows[0].id]
        );
        console.log(`[Payment] Auto ON for meter ${meter.meter_number} - Balance: ₹${newBalance}`);
      }
    }

    let remaining = payAmount;
    const [charges] = await conn.query(
      `SELECT * FROM tenant_unbilled_charges
       WHERE tenant_id = ? AND status = 'active'
       ORDER BY id ASC`,
      [user.id]
    );

    for (const charge of charges) {
      if (remaining <= 0) break;
      const chargeAmount = Number(charge.amount);
      if (remaining >= chargeAmount) {
        await conn.query(
          "UPDATE tenant_unbilled_charges SET status = 'used', updated_at = NOW() WHERE id = ?",
          [charge.id]
        );
        remaining -= chargeAmount;
      }
    }

    await conn.commit();

    return ok(res, {
      receipt_no: receiptNo,
      amount: payAmount,
      method: payMethod,
      paid_at: now.toISOString(),
      status: 'success',
      relay_action: 'ON',
      message: 'Payment successful. Light will turn ON automatically.'
    }, 'Payment successful.');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Payment failed.', 500);
  } finally {
    conn.release();
  }
});

// ========== PAYMENT HISTORY ==========
router.get('/payments', async (req, res) => {
  try {
    const [payments] = await pool.query(
      `SELECT * FROM tenant_payments
       WHERE tenant_id = ?
       ORDER BY id DESC
       LIMIT 50`,
      [req.user.id]
    );
    return ok(res, payments);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load payment history.', 500);
  }
});

// ========== PAST BILLS ==========
router.get('/past-bills', async (req, res) => {
  try {
    const [charges] = await pool.query(
      `SELECT * FROM tenant_unbilled_charges
       WHERE tenant_id = ? AND status = 'used'
       ORDER BY updated_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const data = charges.map((c) => ({
      id: c.id,
      type: c.activity_type,
      amount: c.amount,
      paid_at: c.updated_at ? String(c.updated_at).slice(0, 10) : null,
      status: 'paid',
      status_label: 'Paid',
    }));

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load past bills.', 500);
  }
});

// ========== NOTIFICATIONS ==========
router.get('/notifications', async (req, res) => {
  try {
    const statement = await billingStatementService.getStatementForTenantUser(req.user.id);
    const items = [];
    const now = new Date();

    if (statement && ['due', 'overdue'].includes(statement.status)) {
      items.push({
        id: 1,
        type: 'bill_due',
        title: 'Bill Due Reminder',
        message: `Your bill of ₹${statement.total} is ${statement.status_label}. Due: ${statement.due_date}`,
        time: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        read: false,
      });
    }

    items.push({
      id: 2,
      type: 'usage',
      title: 'Usage Report',
      message: 'Your monthly electricity usage report is ready.',
      time: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      read: true,
    });

    return ok(res, items);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load notifications.', 500);
  }
});

// ========== PROPERTY REQUESTS ==========
router.get('/properties/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 2 || q.length > 100) {
      return fail(res, 'Search query must be between 2 and 100 characters.', 422);
    }

    const property = await tenantPropertyRequestService.searchProperty(q);
    if (!property) {
      return fail(res, 'No property found for this search.', 404);
    }

    return ok(res, property);
  } catch (err) {
    console.error(err);
    return fail(res, 'Search failed.', 500);
  }
});

router.get('/property-requests', async (req, res) => {
  try {
    const [requests] = await pool.query(
      `SELECT
         tpr.*,
         p.id AS prop_id, p.name AS prop_name, p.property_code AS prop_code, p.address AS prop_address
       FROM tenant_property_requests tpr
       INNER JOIN properties p ON p.id = tpr.property_id
       WHERE tpr.tenant_id = ?
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
      property: {
        id: row.prop_id,
        name: row.prop_name,
        property_code: row.prop_code,
        address: row.prop_address,
      },
    }));

    return ok(res, data);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load property requests.', 500);
  }
});

router.post('/property-requests', async (req, res) => {
  try {
    const { property_code, message } = req.body;

    if (!property_code) {
      return fail(res, 'Property code is required.', 422);
    }
    if (message && message.length > 500) {
      return fail(res, 'Message must not exceed 500 characters.', 422);
    }

    const propertyRequest = await tenantPropertyRequestService.createRequest(
      req.user,
      property_code,
      message ?? null
    );

    return ok(res, propertyRequest, 'Join request sent to property owner.', 201);
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to create property request.', 500);
  }
});

// ========== PROPERTY ==========
router.get('/property', async (req, res) => {
  try {
    const assignment = await activeTenantAssignment(req.user.id);
    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const formatted = await tenantPropertyRequestService.formatAssignment({
      id: assignment.id,
    });
    return ok(res, formatted);
  } catch (err) {
    if (err.status) return serviceError(res, err);
    console.error(err);
    return fail(res, 'Failed to load property.', 500);
  }
});

// ========== METERS ==========
router.get('/meters', async (req, res) => {
  try {
    const assignment = await activeTenantAssignment(req.user.id);
    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const [meters] = await pool.query(
      'SELECT * FROM electricity_meters WHERE property_id = ? ORDER BY id DESC',
      [assignment.property_id]
    );

    return ok(res, meters);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load meters.', 500);
  }
});

// ========== BILL CONFIGURATION ==========
router.get('/bill-configuration', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM tenant_bill_configurations WHERE tenant_id = ? LIMIT 1',
      [req.user.id]
    );

    if (!rows.length) {
      return fail(res, 'Bill configuration not found for your account.', 404);
    }

    return ok(res, rows[0]);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load bill configuration.', 500);
  }
});

// ========== UNBILLED CHARGES ==========
router.get('/unbilled-charges', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;

    const { rows, total } = await paginatedQuery(
      `SELECT tuc.*,
         ec.id AS ec_id, ec.total_consumed_units, ec.calculation_date
       FROM tenant_unbilled_charges tuc
       LEFT JOIN electricity_consumptions ec ON ec.id = tuc.electricity_consumption_id
       WHERE tuc.tenant_id = ?
       ORDER BY tuc.id DESC`,
      'SELECT COUNT(*) AS total FROM tenant_unbilled_charges WHERE tenant_id = ?',
      [req.user.id],
      page,
      perPage
    );

    const data = rows.map((row) => ({
      ...row,
      electricity_consumption: row.ec_id
        ? {
            id: row.ec_id,
            total_consumed_units: row.total_consumed_units,
            calculation_date: row.calculation_date,
          }
        : null,
    }));

    return ok(res, paginate(data, total, page, perPage));
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load unbilled charges.', 500);
  }
});

// ========== OTHER ACTIVE CHARGES ==========
router.get('/other-active-charges', async (req, res) => {
  try {
    const [charges] = await pool.query(
      `SELECT * FROM tenant_other_active_charges
       WHERE tenant_id = ? AND status = 'active'
       ORDER BY id DESC`,
      [req.user.id]
    );
    return ok(res, charges);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load other active charges.', 500);
  }
});

// ========== ELECTRICITY CONSUMPTIONS ==========
router.get('/electricity-consumptions', async (req, res) => {
  try {
    const assignment = await activeTenantAssignment(req.user.id);
    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 20;

    const { rows, total } = await paginatedQuery(
      `SELECT ec.*,
         em.id AS meter_id_ref, em.meter_name, em.meter_number
       FROM electricity_consumptions ec
       LEFT JOIN electricity_meters em ON em.id = ec.meter_id
       WHERE ec.property_id = ?
       ORDER BY ec.calculation_date DESC, ec.id DESC`,
      'SELECT COUNT(*) AS total FROM electricity_consumptions WHERE property_id = ?',
      [assignment.property_id],
      page,
      perPage
    );

    const data = rows.map((row) => ({
      ...row,
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

// ========== SCHEDULE ROUTES ==========

/**
 * Get tenant's schedule status
 * GET /api/tenant/schedule
 */
router.get('/schedule', async (req, res) => {
  try {
    const user = req.user;
    const assignment = await activeTenantAssignment(user.id);

    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const property = assignment.property;

    const [meterRows] = await pool.query(
      `SELECT * FROM electricity_meters
       WHERE property_id = ? AND status = 'active'
       LIMIT 1`,
      [property.id]
    );
    const meter = meterRows[0] ?? null;

    if (!meter) {
      return ok(res, { schedule: null, message: 'No meter found for this property.' });
    }

    const [scheduleRows] = await pool.query(
      `SELECT mbs.*, em.meter_number, em.meter_name
       FROM meter_billing_schedules mbs
       INNER JOIN electricity_meters em ON em.id = mbs.electricity_meter_id
       WHERE mbs.electricity_meter_id = ? 
         AND mbs.status = 'active'
         AND mbs.billing IS NOT NULL
       ORDER BY mbs.created_at DESC
       LIMIT 1`,
      [meter.id]
    );

    if (!scheduleRows.length) {
      return ok(res, { schedule: null, message: 'No schedule configured for this meter.' });
    }

    const schedule = scheduleRows[0];
    let billing = schedule.billing;
    try {
      billing = typeof billing === 'string' ? JSON.parse(billing) : billing;
    } catch (e) {
      billing = null;
    }

    const scheduleStatus = checkScheduleStatus(schedule, billing);

    return ok(res, {
      schedule: {
        id: schedule.id,
        schedule_name: schedule.schedule_name,
        schedule_type: schedule.schedule_type,
        run_time: schedule.run_time,
        run_day: schedule.run_day,
        timezone: schedule.timezone,
        billing: billing,
        status: schedule.status,
        meter_number: schedule.meter_number,
        meter_name: schedule.meter_name,
        created_at: schedule.created_at,
        updated_at: schedule.updated_at,
        ...scheduleStatus
      }
    });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load schedule.', 500);
  }
});

/**
 * Get schedule execution history
 * GET /api/tenant/schedule/history
 */
router.get('/schedule/history', async (req, res) => {
  try {
    const user = req.user;
    const assignment = await activeTenantAssignment(user.id);

    if (!assignment) {
      return fail(res, 'No active property linked to your account.', 404);
    }

    const property = assignment.property;

    const [meterRows] = await pool.query(
      `SELECT * FROM electricity_meters
       WHERE property_id = ? AND status = 'active'
       LIMIT 1`,
      [property.id]
    );
    const meter = meterRows[0] ?? null;

    if (!meter) {
      return ok(res, { history: [] });
    }

    const limit = parseInt(req.query.limit || '20', 10);

    const [logs] = await pool.query(
      `SELECT sel.*, em.meter_number, em.meter_name
       FROM schedule_execution_logs sel
       INNER JOIN electricity_meters em ON em.id = sel.meter_id
       WHERE sel.meter_id = ?
       ORDER BY sel.executed_at DESC
       LIMIT ?`,
      [meter.id, limit]
    );

    return ok(res, { history: logs });
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load schedule history.', 500);
  }
});

// ========== SYNC COMPLETE ==========
router.post('/payments/:id/sync-complete', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const paymentId = req.params.id;
    const tenantId = req.user.id;

    const [payments] = await conn.query(
      `SELECT * FROM tenant_payments WHERE id = ? AND tenant_id = ? AND status IN ('cash_pending_sync', 'approved_pending_sync') LIMIT 1`,
      [paymentId, tenantId]
    );

    if (!payments.length) {
      return fail(res, 'Pending sync payment not found.', 404);
    }

    const payment = payments[0];
    const isCash = payment.status === 'cash_pending_sync';

    await conn.beginTransaction();

    await conn.query('UPDATE tenant_payments SET status = "success", updated_at = NOW() WHERE id = ?', [paymentId]);

    const [assignments] = await conn.query(
      `SELECT property_id FROM property_tenants WHERE tenant_id = ? AND status = 'active' LIMIT 1`,
      [tenantId]
    );

    if (assignments.length) {
      const propertyId = assignments[0].property_id;
      const [meterRows] = await conn.query(
        `SELECT * FROM electricity_meters WHERE property_id = ? AND status = 'active' AND meter_type = 'prepaid' LIMIT 1`,
        [propertyId]
      );

      if (meterRows.length) {
        const meter = meterRows[0];
        
        if (isCash) {
          const newBalance = Number(meter.current_balance) + Number(payment.amount);
          await conn.query(
            'UPDATE electricity_meters SET current_balance = ?, updated_at = NOW() WHERE id = ?',
            [newBalance, meter.id]
          );

          let remaining = Number(payment.amount);
          const [charges] = await conn.query(
            `SELECT * FROM tenant_unbilled_charges WHERE tenant_id = ? AND status = 'active' ORDER BY id ASC`,
            [tenantId]
          );

          for (const charge of charges) {
            if (remaining <= 0) break;
            const chargeAmount = Number(charge.amount);
            if (remaining >= chargeAmount) {
              await conn.query("UPDATE tenant_unbilled_charges SET status = 'used', updated_at = NOW() WHERE id = ?", [charge.id]);
              if (charge.description === 'Security Deposit (Advance)') {
                await conn.query("UPDATE property_tenants SET deposit_paid = TRUE, updated_at = NOW() WHERE tenant_id = ? AND status = 'active'", [tenantId]);
              }
              remaining -= chargeAmount;
            }
          }
        }

        // AUTO ON after sync
        const [smartRows] = await conn.query('SELECT id FROM meters WHERE meter_number = ? LIMIT 1', [meter.meter_number]);
        if (smartRows.length) {
          const balance = Number(meter.current_balance) + (isCash ? Number(payment.amount) : 0);
          if (balance > 0) {
            await conn.query('UPDATE meters SET pending_relay_action = "ON", relay_status = "ON", updated_at = NOW() WHERE id = ?', [smartRows[0].id]);
            console.log(`[Sync] Auto ON for meter ${meter.meter_number} - Balance: ₹${balance}`);
          }
        }
      }
    }

    await conn.commit();
    return ok(res, { success: true }, 'Sync complete and meter activated.');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Failed to complete sync.', 500);
  } finally {
    conn.release();
  }
});

module.exports = router;