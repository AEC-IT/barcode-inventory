const express = require('express');
const { query } = require('./db-init');
const { requireLogin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

router.use(requireLogin);

// Simple, fixed low-stock threshold for Phase 1 (flagged in the PRD as
// "Low Stock" without a specific number). Worth making this configurable
// per category/asset in a later phase.
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

async function computeVerticalStats(verticalId) {
  const { rows: assets } = await query(
    `SELECT a.*, v.name AS vendor_name FROM assets_lite a LEFT JOIN vendors v ON a.vendor_id = v.id
     WHERE a.vertical_id = $1 AND a.deleted_at IS NULL`,
    [verticalId]
  );

  const today = todayIST();
  const in30 = addDays(today, 30);

  const totalAssets = assets.length;
  const assignedAssets = assets.filter((a) => a.status === 'Assigned').length;
  const availableAssets = assets.filter((a) => a.status === 'Available').length;
  const maintenanceAssets = assets.filter((a) => a.status === 'Maintenance' || a.status === 'Repair').length;
  const lostAssets = assets.filter((a) => a.status === 'Lost').length;
  const scrappedAssets = assets.filter((a) => a.status === 'Scrapped' || a.status === 'Disposed').length;
  const lowStockAssets = assets.filter((a) => a.quantity > 0 && a.quantity <= LOW_STOCK_THRESHOLD);
  const warrantyExpiringAssets = assets.filter((a) => a.warranty_expiry && a.warranty_expiry >= today && a.warranty_expiry <= in30);
  const totalQuantity = assets.reduce((sum, a) => sum + (a.quantity || 0), 0);

  const byVendor = {};
  const byDepartment = {};
  assets.forEach((a) => {
    const vendor = a.vendor_name || 'Unspecified';
    byVendor[vendor] = (byVendor[vendor] || 0) + 1;
    const dept = a.department || 'Unspecified';
    byDepartment[dept] = (byDepartment[dept] || 0) + 1;
  });

  const { rows: scans } = await query('SELECT * FROM scans WHERE vertical_id = $1 ORDER BY id DESC LIMIT 10', [verticalId]);

  return {
    totalAssets, assignedAssets, availableAssets, maintenanceAssets, lostAssets, scrappedAssets,
    lowStockAssets: lowStockAssets.length,
    lowStockList: lowStockAssets.slice(0, 20),
    warrantyExpiringAssets: warrantyExpiringAssets.length,
    warrantyExpiringList: warrantyExpiringAssets.slice(0, 20),
    totalQuantity,
    byVendor, byDepartment,
    recentScans: scans
  };
}

router.get('/', async (req, res, next) => {
  try {
    const user = req.session.user;
    const myVertical = scopeVerticalId(req);

    if (myVertical !== null) {
      const stats = await computeVerticalStats(myVertical);
      return res.json({ scope: 'vertical', vertical: user.vertical, ...stats });
    }

    // Super Admin: overall totals + a business-wise breakdown per vertical.
    const { rows: verticals } = await query('SELECT * FROM verticals WHERE active = true ORDER BY id ASC');
    const businessWise = [];
    for (const v of verticals) {
      const stats = await computeVerticalStats(v.id);
      businessWise.push({ vertical: v, ...stats });
    }

    const totalAssets = businessWise.reduce((s, b) => s + b.totalAssets, 0);
    const assignedAssets = businessWise.reduce((s, b) => s + b.assignedAssets, 0);
    const availableAssets = businessWise.reduce((s, b) => s + b.availableAssets, 0);
    const lowStockAssets = businessWise.reduce((s, b) => s + b.lowStockAssets, 0);
    const warrantyExpiringAssets = businessWise.reduce((s, b) => s + b.warrantyExpiringAssets, 0);

    const byVendor = {};
    const byDepartment = {};
    businessWise.forEach((b) => {
      Object.entries(b.byVendor).forEach(([k, v]) => { byVendor[k] = (byVendor[k] || 0) + v; });
      Object.entries(b.byDepartment).forEach(([k, v]) => { byDepartment[k] = (byDepartment[k] || 0) + v; });
    });

    const { rows: userCountRows } = await query("SELECT COUNT(*)::int AS count FROM users WHERE role != 'super_admin'");
    const { rows: recentScans } = await query(
      `SELECT s.*, ve.name AS vertical_name, ve.icon AS vertical_icon FROM scans s
       JOIN verticals ve ON s.vertical_id = ve.id ORDER BY s.id DESC LIMIT 10`
    );
    const { rows: topUsed } = await query(
      `SELECT a.*, ve.name AS vertical_name FROM assets_lite a JOIN verticals ve ON a.vertical_id = ve.id
       WHERE a.deleted_at IS NULL ORDER BY a.scan_count DESC LIMIT 5`
    );

    res.json({
      scope: 'global',
      totalAssets, assignedAssets, availableAssets, lowStockAssets, warrantyExpiringAssets,
      byVendor, byDepartment,
      totalEmployees: userCountRows[0].count,
      businessWise,
      recentScans,
      topUsedAssets: topUsed
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
