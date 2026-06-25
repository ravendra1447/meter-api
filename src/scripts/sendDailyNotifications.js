const pool = require('../config/database');
const NotificationService = require('../services/notificationService');
const billingStatementService = require('../services/billingStatementService');

async function run() {
  console.log('====================================================');
  console.log('[CRON] Starting Daily Bill Due Notification Check');
  console.log('====================================================');

  try {
    // We need to fetch all active tenants and their current statements.
    const [tenants] = await pool.query(\`
      SELECT pt.tenant_id, u.name, u.mobile 
      FROM property_tenants pt
      INNER JOIN users u ON u.id = pt.tenant_id
      WHERE pt.status = 'active'
    \`);

    let sentCount = 0;

    for (const tenantRow of tenants) {
      const statement = await billingStatementService.getStatementForTenantUser(tenantRow.tenant_id);
      
      // If there's an active due statement, send a notification
      if (statement && ['due', 'overdue'].includes(statement.status) && statement.total > 0) {
        // You might want to check if you already sent a notification today, 
        // but for simplicity, we just trigger it.
        const success = await NotificationService.sendBillDueNotification(
          { id: tenantRow.tenant_id, name: tenantRow.name, mobile: tenantRow.mobile },
          statement
        );
        if (success) sentCount++;
      }
    }

    console.log(\`[CRON] Processed \${tenants.length} tenants. Sent \${sentCount} notifications.\`);
  } catch (err) {
    console.error('[CRON] Error:', err);
  } finally {
    process.exit(0);
  }
}

run();
