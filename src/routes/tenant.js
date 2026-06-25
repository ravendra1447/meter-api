const express = require('express');
const pool = require('../config/database');
const { ok, fail, paginate } = require('../utils/response');
const { authenticate, requireRole } = require('../middleware/auth');
const { activeTenantAssignment, paginatedQuery } = require('../helpers/userHelpers');
const billingStatementService = require('../services/billingStatementService');
const tenantPropertyRequestService = require('../services/tenantPropertyRequestService');

const router = express.Router();

router.use(authenticate, requireRole('tenant'));

function serviceError(res, err) {
  return fail(res, err.message, err.status || 500);
}

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

    let relayStatus = balance > 50 ? 'ON' : 'OFF';
    let smartMeterId = null;
    let smartMeter = null;

    if (meter) {
      const [smartRows] = await pool.query(
        'SELECT * FROM meters WHERE meter_number = ? LIMIT 1',
        [meter.meter_number]
      );
      if (smartRows.length) {
        smartMeter = smartRows[0];
        relayStatus = smartMeter.relay_status;
        smartMeterId = smartMeter.id;
      }
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

      daily = readings.map((r) => ({
        kwh: Number(r.daily_consumption),
        cost: Math.round(Number(r.daily_consumption) * tariff * 100) / 100,
      }));
    }

    let totalUsageKwh = daily.reduce((sum, d) => sum + d.kwh, 0);
    let totalUsageCost = daily.reduce((sum, d) => sum + d.cost, 0);

    if (totalUsageKwh === 0 && latestConsumption) {
      totalUsageKwh = Number(latestConsumption.total_consumed_units);
      totalUsageCost = Math.round(totalUsageKwh * tariff * 100) / 100;
    }

    const monthLimit = Math.max(totalUsageKwh, 70);
    const usagePercent = Math.min(100, Math.round((totalUsageKwh / monthLimit) * 100));
    
    // Fetch latest reading correctly
    let currentReading = 0;
    if (smartMeter) {
        const [lastR] = await pool.query(
            'SELECT total_reading FROM meter_readings WHERE meter_id = ? ORDER BY reading_date DESC, id DESC LIMIT 1',
            [smartMeter.id]
        );
        if (lastR.length) currentReading = Number(lastR[0].total_reading);
    }
    if (currentReading === 0) {
        currentReading = latestConsumption ? Number(latestConsumption.current_reading) : (meter ? Number(meter.last_reading ?? 0) : 0);
    }

    let graceDays = 5;
    let relaySchedule = null;
    if (meter) {
      const [scheduleRows] = await pool.query(
        `SELECT billing FROM meter_billing_schedules WHERE electricity_meter_id = ? AND status = 'active' LIMIT 1`,
        [meter.id]
      );
      if (scheduleRows.length && scheduleRows[0].billing) {
        try {
          const billingObj = typeof scheduleRows[0].billing === 'string' 
            ? JSON.parse(scheduleRows[0].billing) 
            : scheduleRows[0].billing;
          if (billingObj) {
            if (billingObj.grace_days !== undefined) {
              graceDays = Number(billingObj.grace_days);
            }
            if (billingObj.relay_schedule_type && billingObj.relay_schedule_type !== 'none') {
              relaySchedule = {
                type: billingObj.relay_schedule_type,
                day: billingObj.relay_schedule_day || 1,
                off_time: billingObj.relay_off_time || billingObj.daily_off_time || null,
                on_time: billingObj.relay_on_time || billingObj.daily_on_time || null,
              };
            } else if (billingObj.daily_off_time || billingObj.daily_on_time) {
              relaySchedule = {
                type: 'daily',
                day: 1,
                off_time: billingObj.daily_off_time || null,
                on_time: billingObj.daily_on_time || null,
              };
            }
          }
        } catch(e) {}
      }
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
      month_usage_kwh: totalUsageKwh,
      month_usage_cost: totalUsageCost,
      month_usage_percent: usagePercent,
      current_reading: currentReading,
      relay_status: relayStatus,
      relay_schedule: relaySchedule,
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
            grace_days: graceDays,
          }
        : null,
      agreement: {
        duration_months: assignment.agreement_duration_months || 11,
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
          date:
            typeof r.reading_date === 'string'
              ? r.reading_date.slice(0, 10)
              : r.reading_date,
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

router.post('/payments', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { amount, method } = req.body;

    if (!amount || Number(amount) < 1) {
      return fail(res, 'Amount must be at least 1.', 422);
    }
    const validMethods = ['upi', 'card', 'netbanking', 'wallet'];
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
    const now = new Date();
    const receiptNo = `RCP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO tenant_payments (tenant_id, amount, method, receipt_no, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
      [user.id, payAmount, payMethod, receiptNo]
    );

    await conn.commit();

    return ok(res, {
      receipt_no: receiptNo,
      amount: payAmount,
      method: payMethod,
      paid_at: now.toISOString(),
      status: 'pending',
    }, 'Payment submitted. Pending owner approval.');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return fail(res, 'Payment failed.', 500);
  } finally {
    conn.release();
  }
});

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

    items.push({
      id: 3,
      type: 'relay',
      title: 'Relay Status',
      message: 'Meter relay is active. Supply is ON.',
      time: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      read: true,
    });

    return ok(res, items);
  } catch (err) {
    console.error(err);
    return fail(res, 'Failed to load notifications.', 500);
  }
});

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

    // Mark success
    await conn.query('UPDATE tenant_payments SET status = "success", updated_at = NOW() WHERE id = ?', [paymentId]);

    // Update meter balance and relay action
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
        
        // If it was cash, we update the balance NOW. (UPI balance was updated at approval)
        if (isCash) {
          const newBalance = Number(meter.current_balance) + Number(payment.amount);
          await conn.query(
            'UPDATE electricity_meters SET current_balance = ?, updated_at = NOW() WHERE id = ?',
            [newBalance, meter.id]
          );

          // Deduct unbilled charges for cash
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

        // Always trigger Relay ON
        const [smartRows] = await conn.query('SELECT id FROM meters WHERE meter_number = ? LIMIT 1', [meter.meter_number]);
        if (smartRows.length) {
          await conn.query('UPDATE meters SET pending_relay_action = ?, updated_at = NOW() WHERE id = ?', ['ON', smartRows[0].id]);
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
