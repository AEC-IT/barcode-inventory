const express = require('express');
const { query } = require('./db-init');
const { requireLogin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

router.use(requireLogin);

// Global dashboard search across assets and scan history. Vertical
// isolation applies here too - a vertical_admin/employee only ever
// searches within their own business; only super_admin searches everyone.
router.get('/', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ assets: [], scans: [], query: '' });

    const like = `%${q}%`;
    const assetParams = [like];
    let assetVerticalClause = '';
    if (myVertical !== null) {
      assetParams.push(myVertical);
      assetVerticalClause = `AND a.vertical_id = $${assetParams.length}`;
    }

    const { rows: assets } = await query(
      `SELECT a.*, v.name AS vendor_name, ve.name AS vertical_name, ve.icon AS vertical_icon
       FROM assets_lite a
       LEFT JOIN vendors v ON a.vendor_id = v.id
       JOIN verticals ve ON a.vertical_id = ve.id
       WHERE a.deleted_at IS NULL ${assetVerticalClause}
         AND (a.barcode ILIKE $1 OR a.asset_name ILIKE $1 OR a.serial_number ILIKE $1
              OR a.brand ILIKE $1 OR a.model ILIKE $1 OR a.category ILIKE $1
              OR a.location ILIKE $1 OR a.department ILIKE $1 OR a.assigned_employee ILIKE $1
              OR a.remarks ILIKE $1 OR v.name ILIKE $1 OR ve.name ILIKE $1)
       ORDER BY a.id DESC
       LIMIT 50`,
      assetParams
    );

    const scanParams = [like];
    let scanVerticalClause = '';
    if (myVertical !== null) {
      scanParams.push(myVertical);
      scanVerticalClause = `AND vertical_id = $${scanParams.length}`;
    }

    const { rows: scans } = await query(
      `SELECT * FROM scans
       WHERE (barcode ILIKE $1 OR asset_name ILIKE $1 OR scanned_by ILIKE $1 OR device_name ILIKE $1
              OR location ILIKE $1 OR department ILIKE $1 OR assigned_employee ILIKE $1
              OR remarks ILIKE $1 OR scan_date ILIKE $1 OR scan_time ILIKE $1)
         ${scanVerticalClause}
       ORDER BY id DESC
       LIMIT 50`,
      scanParams
    );

    res.json({ assets, scans, query: q });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
