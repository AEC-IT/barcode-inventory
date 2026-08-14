const express = require('express');
const { query } = require('./db-init');
const { requireLogin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

router.use(requireLogin);

const LOW_STOCK_THRESHOLD = 5;

function todayIST() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Proactive alerts, computed live (not stored) each time this is called:
//   - warranty expiring within 2 days -> "urgent" tier (danger/red)
//   - warranty expiring within 30 days (but more than 2 days away) -> normal
//     "warn" tier (amber), same as before
//   - stock at/below the low-stock threshold
// Plus recent (last 24h) blocked-duplicate events pulled straight from the
// audit log (duplicate serial number, duplicate barcode, an asset that was
// already assigned) - those are the same events already logged by
// asset-routes.js/scan-routes.js at the moment they're blocked, surfaced
// here as a second, persistent channel beyond the one-off error toast.
//
// This whole list is always computed fresh from current data (never stored
// state), so it's automatically correct every time it's called - the
// frontend re-calls this every 30 minutes while the dashboard is open (see
// admin.html) to keep nagging about an urgent item until whatever made it
// urgent is no longer true (warranty date updated, asset removed, etc).
router.get('/', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const today = todayIST();
    const in2 = addDays(today, 2);
    const in30 = addDays(today, 30);

    const assetParams = [];
    let assetVerticalClause = '';
    if (myVertical !== null) {
      assetParams.push(myVertical);
      assetVerticalClause = `AND a.vertical_id = $${assetParams.length}`;
    }

    const { rows: warrantyUrgentAssets } = await query(
      `SELECT a.*, ve.name AS vertical_name FROM assets a JOIN verticals ve ON a.vertical_id = ve.id
       WHERE a.deleted_at IS NULL AND a.warranty_expiry IS NOT NULL
         AND a.warranty_expiry >= $${assetParams.length + 1} AND a.warranty_expiry <= $${assetParams.length + 2}
         ${assetVerticalClause}
       ORDER BY a.warranty_expiry ASC`,
      [...assetParams, today, in2]
    );

    const { rows: warrantyAssets } = await query(
      `SELECT a.*, ve.name AS vertical_name FROM assets a JOIN verticals ve ON a.vertical_id = ve.id
       WHERE a.deleted_at IS NULL AND a.warranty_expiry IS NOT NULL
         AND a.warranty_expiry > $${assetParams.length + 1} AND a.warranty_expiry <= $${assetParams.length + 2}
         ${assetVerticalClause}
       ORDER BY a.warranty_expiry ASC`,
      [...assetParams, in2, in30]
    );

    const { rows: lowStockAssets } = await query(
      `SELECT a.*, ve.name AS vertical_name FROM assets a JOIN verticals ve ON a.vertical_id = ve.id
       WHERE a.deleted_at IS NULL AND a.quantity > 0 AND a.quantity <= COALESCE(a.low_stock_threshold, ${LOW_STOCK_THRESHOLD})
       ${assetVerticalClause}
       ORDER BY a.quantity ASC`,
      assetParams
    );

    // (Using explicit IN (...) placeholders rather than = ANY($1::text[])
    // for broader SQL-engine compatibility.)
    const logParams = ['Duplicate Serial Number Blocked', 'Duplicate Barcode Blocked', 'Duplicate Assignment Blocked'];
    let logVerticalClause = '';
    if (myVertical !== null) {
      logParams.push(myVertical);
      logVerticalClause = `AND vertical_id = $${logParams.length}`;
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    logParams.push(since);
    const { rows: dupEvents } = await query(
      `SELECT * FROM audit_logs WHERE action IN ($1, $2, $3) ${logVerticalClause} AND ts >= $${logParams.length} ORDER BY ts DESC LIMIT 30`,
      logParams
    );

    const notifications = [
      ...warrantyUrgentAssets.map((a) => ({
        type: 'warranty_urgent', severity: 'danger',
        message: `URGENT: ${a.asset_name} (${a.barcode}) warranty expires ${a.warranty_expiry === today ? 'TODAY' : a.warranty_expiry}${myVertical === null ? ' — ' + a.vertical_name : ''}`,
        created_at: a.warranty_expiry, vertical_id: a.vertical_id
      })),
      ...warrantyAssets.map((a) => ({
        type: 'warranty_expiring', severity: 'warn',
        message: `${a.asset_name} (${a.barcode}) warranty expires ${a.warranty_expiry}${myVertical === null ? ' — ' + a.vertical_name : ''}`,
        created_at: a.warranty_expiry, vertical_id: a.vertical_id
      })),
      ...lowStockAssets.map((a) => ({
        type: 'low_stock', severity: 'warn',
        message: `${a.asset_name} is low on stock (${a.quantity} left)${myVertical === null ? ' — ' + a.vertical_name : ''}`,
        created_at: a.updated_at, vertical_id: a.vertical_id
      })),
      ...dupEvents.map((e) => ({
        type: 'duplicate_blocked', severity: 'danger',
        message: `${e.action.replace(' Blocked', '')} blocked (by ${e.username || 'unknown user'})`,
        created_at: e.ts, vertical_id: e.vertical_id
      }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const urgentCount = notifications.filter((n) => n.severity === 'danger').length;
    res.json({ notifications, count: notifications.length, urgentCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
