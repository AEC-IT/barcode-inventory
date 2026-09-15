const express = require('express');
const multer = require('multer');
const { query, logAudit, getIST } = require('./db-init');
const { requireLogin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }
});

function fileToDataUrl(file) {
  if (!file) return undefined;
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

router.use(requireLogin);

// Record a scan (camera barcode/QR or manual entry).
//
// Vertical isolation: an employee/vertical_admin can only ever create or
// update an asset inside their OWN vertical (taken from req.session.user,
// never from the client). A super_admin scanning must specify which
// vertical the new asset belongs to.
//
// One record per barcode, always: first scan of a barcode INSERTs; every
// later scan of that SAME barcode UPDATEs the one existing row and bumps
// scan_count - see asset-routes.js and db-init.js for the same rule
// applied elsewhere. Every individual scan event is still logged as a
// separate row in `scans` (the audit trail), even though `assets` never
// grows a duplicate row for a repeat scan.
router.post('/', upload.single('photo'), async (req, res, next) => {
  try {
    const user = req.session.user;
    const {
      barcode, asset_name, serial_number, category, vendor_id, brand, model, quantity, low_stock_threshold,
      purchase_date, warranty_expiry, location, department, assigned_employee, remarks,
      vertical_id: requestedVerticalId
    } = req.body || {};
    if (!barcode) return res.status(400).json({ error: 'Barcode required' });

    const image_path = fileToDataUrl(req.file);
    const myVertical = scopeVerticalId(req);

    const { rows: existingRows } = await query(
      'SELECT * FROM assets WHERE barcode = $1 AND deleted_at IS NULL',
      [barcode]
    );
    let asset = existingRows[0];

    if (asset && myVertical !== null && asset.vertical_id !== myVertical) {
      // Exists, but belongs to a different business vertical - never
      // expose or update it from here.
      return res.status(404).json({ error: 'Asset not found' });
    }

    const isNewAsset = !asset;

    if (isNewAsset) {
      // Only Asset Name is required to log a brand-new item from the
      // scanner - everything else (Serial Number, Category, Vendor, Brand,
      // Model, Quantity, Low Stock Alert At, Purchase Date, Warranty
      // Expiry, Location, Position, Assigned User, Photo, Remarks) is
      // optional.
      if (!asset_name) {
        return res.status(400).json({ error: 'Asset Name is required for a new asset' });
      }
      let vertical_id = user.vertical_id;
      if (user.role === 'super_admin') {
        if (!requestedVerticalId) return res.status(400).json({ error: 'Business Vertical is required' });
        vertical_id = Number(requestedVerticalId);
      }

      if (serial_number) {
        const { rows: dupSerial } = await query('SELECT id FROM assets WHERE serial_number = $1', [serial_number]);
        if (dupSerial.length) {
          await logAudit({ username: user.username, vertical_id, action: 'Duplicate Serial Number Blocked', ip_address: req.ip, new_value: { serial_number, barcode } });
          return res.status(409).json({ error: 'This Serial Number is already registered to another asset' });
        }
      }

      const { rows } = await query(
        `INSERT INTO assets (barcode, asset_name, vertical_id, category, vendor_id, brand, model, serial_number, quantity, low_stock_threshold, purchase_date, warranty_expiry, location, department, assigned_employee, remarks, image_path, scan_count, last_scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, 1, now()) RETURNING *`,
        [
          barcode, asset_name, vertical_id, category || '', vendor_id || null, brand || '', model || '',
          serial_number || null, quantity || 1, low_stock_threshold || null, purchase_date || null, warranty_expiry || null,
          location || '', department || '', assigned_employee || '', remarks || '', image_path || null
        ]
      );
      asset = rows[0];
      await logAudit({ username: user.username, vertical_id, action: 'Asset Created', ip_address: req.ip, new_value: asset });
    } else {
      const fields = [];
      const params = [];
      function set(col, val) {
        params.push(val);
        fields.push(`${col} = $${params.length}`);
      }
      if (location !== undefined) set('location', location);
      if (department !== undefined) set('department', department);
      if (assigned_employee !== undefined) set('assigned_employee', assigned_employee);
      if (image_path) set('image_path', image_path);
      fields.push('scan_count = scan_count + 1');
      fields.push('last_scanned_at = now()');
      fields.push('updated_at = now()');

      params.push(asset.id);
      const { rows } = await query(`UPDATE assets SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      asset = rows[0];
    }

    const ist = getIST(new Date());
    const { rows: scanRows } = await query(
      `INSERT INTO scans (asset_id, vertical_id, barcode, asset_name, scanned_by, device_name, device_id, scan_date, scan_time, location, department, assigned_employee, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        asset.id, asset.vertical_id, barcode, asset.asset_name,
        user.username,
        req.body.device_name || 'Unknown device',
        req.body.device_id || 'unknown',
        ist.date, ist.time,
        asset.location, asset.department, asset.assigned_employee,
        remarks || ''
      ]
    );
    await logAudit({ username: user.username, vertical_id: asset.vertical_id, action: 'Barcode Scanned', ip_address: req.ip, new_value: { barcode } });

    res.status(201).json({ asset, scan: scanRows[0], isNewAsset });
  } catch (err) {
    next(err);
  }
});

// Scan history with optional filters - scoped by vertical.
router.get('/', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const { user, barcode, from, to, vertical_id } = req.query;
    const clauses = [];
    const params = [];

    if (myVertical !== null) {
      params.push(myVertical);
      clauses.push(`vertical_id = $${params.length}`);
    } else if (vertical_id) {
      params.push(Number(vertical_id));
      clauses.push(`vertical_id = $${params.length}`);
    }
    if (user) {
      params.push(user);
      clauses.push(`scanned_by = $${params.length}`);
    }
    if (barcode) {
      params.push(`%${barcode}%`);
      clauses.push(`barcode ILIKE $${params.length}`);
    }
    if (from) {
      params.push(from);
      clauses.push(`scan_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      clauses.push(`scan_date <= $${params.length}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM scans ${where} ORDER BY id DESC`, params);
    res.json({ scans: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
