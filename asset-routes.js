const express = require('express');
const { query, logAudit } = require('./db-init');
const { requireLogin, requireVerticalAdmin, requireSuperAdmin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

router.use(requireLogin);

// Same IST "today" helpers used in stats-routes.js/notification-routes.js -
// duplicated locally (rather than imported) since this file has no other
// dependency on those route files and it's a tiny, self-contained bit of
// date math.
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

// Serves one photo stored as a data URL in `table`.image_path, as a real
// image the browser can cache. Lists only carry a link to this (see
// createLiteViews in db-init.js), so a photo leaves the database only when
// it's actually displayed - and, thanks to the cache header, usually only
// once per device. The ?v=<updated_at> query on the link busts the cache
// when a photo is replaced.
async function sendStoredPhoto(req, res, next, table) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).end();
    const myVertical = scopeVerticalId(req);
    const params = [id];
    let scope = '';
    if (myVertical !== null) {
      params.push(myVertical);
      scope = 'AND vertical_id = $2';
    }
    const { rows } = await query(`SELECT image_path FROM ${table} WHERE id = $1 ${scope}`, params);
    const dataUrl = rows[0] && rows[0].image_path;
    const m = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) return res.status(404).end();
    const body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'private, max-age=2592000'); // 30 days, per-user only
    res.send(body);
  } catch (err) {
    next(err);
  }
}

router.get('/:id/photo', (req, res, next) => sendStoredPhoto(req, res, next, 'assets'));

const SELECT_BASE = `
  SELECT a.*, v.name AS vendor_name,
         ve.code AS vertical_code, ve.name AS vertical_name, ve.icon AS vertical_icon
  FROM assets_lite a
  LEFT JOIN vendors v ON a.vendor_id = v.id
  JOIN verticals ve ON a.vertical_id = ve.id
`;

// Generates a scanner-friendly numeric/alpha barcode unique across every
// vertical (barcodes are never reused, even between businesses).
async function generateUniqueBarcode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ts = Date.now().toString().slice(-9);
    const rand = Math.floor(100 + Math.random() * 900);
    const candidate = 'AEC' + ts + rand;
    const { rows } = await query('SELECT id FROM assets WHERE barcode = $1', [candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error('Could not generate a unique barcode, please try again');
}

// auditContext (optional): { username, vertical_id, ip_address } - when
// given, a blocked duplicate attempt is recorded to the audit log so it can
// surface as a notification, in addition to the 409 the caller sees
// immediately.
async function assertSerialNumberFree(serial_number, excludeId, auditContext) {
  if (!serial_number) return;
  const params = [serial_number];
  let sql = 'SELECT id FROM assets WHERE serial_number = $1';
  if (excludeId) {
    params.push(excludeId);
    sql += ' AND id != $2';
  }
  const { rows } = await query(sql, params);
  if (rows.length) {
    if (auditContext) {
      await logAudit({ ...auditContext, action: 'Duplicate Serial Number Blocked', new_value: { serial_number } });
    }
    const err = new Error('This Serial Number is already registered to another asset');
    err.status = 409;
    throw err;
  }
}

// List / search assets. THIS IS WHERE MULTI-TENANT ISOLATION IS ENFORCED:
// a vertical_admin or employee's vertical_id (taken from their SERVER-SIDE
// session, never from the request) is always applied as a hard WHERE
// filter. Only super_admin can see across verticals, and even then only
// via this same query - there is no separate "see everything" code path
// a lower role could reach.
router.get('/', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const { q, status, category, department, vertical_id, assigned_employee, low_stock, warranty_expiring } = req.query;
    const clauses = ['a.deleted_at IS NULL'];
    const params = [];

    if (myVertical !== null) {
      params.push(myVertical);
      clauses.push(`a.vertical_id = $${params.length}`);
    } else if (vertical_id) {
      // Super admin narrowing to one vertical in the UI
      params.push(Number(vertical_id));
      clauses.push(`a.vertical_id = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      clauses.push(
        `(a.barcode ILIKE ${p} OR a.asset_name ILIKE ${p} OR a.serial_number ILIKE ${p} OR a.brand ILIKE ${p} OR a.model ILIKE ${p} OR a.category ILIKE ${p} OR a.location ILIKE ${p} OR a.department ILIKE ${p} OR a.assigned_employee ILIKE ${p} OR v.name ILIKE ${p} OR ve.name ILIKE ${p})`
      );
    }
    if (status) {
      // Accepts either one status ("Assigned") or a comma-separated list
      // ("Maintenance,Repair") - the dashboard's Maintenance/Scrapped cards
      // count two statuses together, so clicking them needs to filter on
      // both at once rather than just the first one.
      const statusList = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      const placeholders = statusList.map((s) => { params.push(s); return `$${params.length}`; });
      clauses.push(`a.status IN (${placeholders.join(',')})`);
    }
    if (category) {
      params.push(category);
      clauses.push(`a.category = $${params.length}`);
    }
    if (department) {
      params.push(department);
      clauses.push(`a.department = $${params.length}`);
    }
    if (assigned_employee) {
      params.push(assigned_employee);
      clauses.push(`a.assigned_employee = $${params.length}`);
    }
    if (low_stock === 'true' || low_stock === '1') {
      // Each asset can set its own reorder point (low_stock_threshold) from
      // the New Asset / Edit Asset forms; anything left unset falls back to
      // the global default of 5 - same COALESCE used in
      // notification-routes.js so the dashboard card, this filter, and the
      // notification feed always agree on which assets count as "low".
      clauses.push(`a.quantity > 0 AND a.quantity <= COALESCE(a.low_stock_threshold, 5)`);
    }
    if (warranty_expiring === 'true' || warranty_expiring === '1') {
      // Same 30-day IST window as the dashboard's "Warranty Expiring" card
      // and stats-routes.js - computed in JS rather than CURRENT_DATE so it
      // lines up with the same IST "today" the rest of the app uses.
      const today = todayIST();
      const in30 = addDays(today, 30);
      params.push(today);
      const p1 = `$${params.length}`;
      params.push(in30);
      const p2 = `$${params.length}`;
      clauses.push(`a.warranty_expiry IS NOT NULL AND a.warranty_expiry >= ${p1} AND a.warranty_expiry <= ${p2}`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(`${SELECT_BASE} ${where} ORDER BY a.id DESC`, params);
    res.json({ assets: rows });
  } catch (err) {
    next(err);
  }
});

// Recycle Bin - Super Admin only. Placed ABOVE the GET /:barcode route
// below so the literal path "recycle-bin" is never swallowed by that
// wildcard param route.
router.get('/recycle-bin', requireSuperAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT_BASE} WHERE a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC`);
    res.json({ assets: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/restore', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NOT NULL', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found in Recycle Bin' });

    const { rows } = await query('UPDATE assets SET deleted_at = NULL WHERE id = $1 RETURNING *', [id]);
    await logAudit({
      username: req.session.user.username, vertical_id: existing[0].vertical_id, action: 'Asset Restored',
      ip_address: req.ip, old_value: { deleted_at: existing[0].deleted_at }, new_value: rows[0]
    });
    res.json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Generate a brand-new barcode for an asset that doesn't have one printed
// on it yet ("Create Barcode" flow).
router.post('/generate-barcode', async (req, res, next) => {
  try {
    const user = req.session.user;
    const {
      asset_name, category, vendor_id, brand, model, serial_number, quantity, low_stock_threshold,
      purchase_date, warranty_expiry, location, department, assigned_employee, remarks,
      vertical_id: requestedVerticalId
    } = req.body || {};

    if (!asset_name) {
      return res.status(400).json({ error: 'Asset Name is required' });
    }

    let vertical_id = user.vertical_id;
    if (user.role === 'super_admin') {
      if (!requestedVerticalId) return res.status(400).json({ error: 'Business Vertical is required' });
      vertical_id = Number(requestedVerticalId);
    }

    await assertSerialNumberFree(serial_number, undefined, { username: user.username, vertical_id, ip_address: req.ip });

    const barcode = await generateUniqueBarcode();
    const { rows } = await query(
      `INSERT INTO assets (barcode, asset_name, vertical_id, category, vendor_id, brand, model, serial_number, quantity, low_stock_threshold, purchase_date, warranty_expiry, location, department, assigned_employee, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        barcode, asset_name, vertical_id, category || '', vendor_id || null, brand || '', model || '',
        serial_number || null, quantity || 1, low_stock_threshold || null, purchase_date || null, warranty_expiry || null,
        location || '', department || '', assigned_employee || '', remarks || ''
      ]
    );
    await logAudit({ username: user.username, vertical_id, action: 'Barcode Generated', ip_address: req.ip, new_value: rows[0] });
    await logAudit({ username: user.username, vertical_id, action: 'Asset Created', ip_address: req.ip, new_value: rows[0] });
    res.status(201).json({ asset: rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/regenerate-barcode', requireVerticalAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existing[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }

    const barcode = await generateUniqueBarcode();
    const { rows } = await query(`UPDATE assets SET barcode = $1, updated_at = now() WHERE id = $2 RETURNING *`, [barcode, id]);
    await logAudit({ username: req.session.user.username, vertical_id: existing[0].vertical_id, action: 'Barcode Generated', ip_address: req.ip, old_value: { barcode: existing[0].barcode }, new_value: { barcode } });
    res.json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Look up by barcode (used by the scanner). A vertical_admin/employee can
// only ever resolve a barcode that belongs to THEIR vertical - if the
// barcode exists but belongs to another business, we deliberately respond
// 404 (not 403) so we don't reveal that a matching barcode exists
// elsewhere.
router.get('/:barcode', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const { rows } = await query(`${SELECT_BASE} WHERE a.barcode = $1 AND a.deleted_at IS NULL`, [req.params.barcode]);
    const asset = rows[0];
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && asset.vertical_id !== myVertical) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const { rows: scanRows } = await query('SELECT * FROM scans WHERE barcode = $1 ORDER BY id DESC LIMIT 1', [asset.barcode]);
    const { rows: assignRows } = await query('SELECT * FROM asset_assignments WHERE asset_id = $1 AND returned_at IS NULL', [asset.id]);
    res.json({ asset, lastScan: scanRows[0] || null, activeAssignment: assignRows[0] || null });
  } catch (err) {
    next(err);
  }
});

// Direct create (admin panel "Add Asset" when the barcode is already known
// / already printed on the item).
router.post('/', async (req, res, next) => {
  try {
    const user = req.session.user;
    const {
      barcode, asset_name, category, vendor_id, brand, model, serial_number, quantity, low_stock_threshold,
      purchase_date, warranty_expiry, location, department, assigned_employee, remarks, image_path,
      vertical_id: requestedVerticalId
    } = req.body || {};

    if (!barcode || !asset_name) {
      return res.status(400).json({ error: 'Barcode and Asset Name are required' });
    }

    let vertical_id = user.vertical_id;
    if (user.role === 'super_admin') {
      if (!requestedVerticalId) return res.status(400).json({ error: 'Business Vertical is required' });
      vertical_id = Number(requestedVerticalId);
    }

    const { rows: existingBarcode } = await query('SELECT id FROM assets WHERE barcode = $1', [barcode]);
    if (existingBarcode.length) {
      await logAudit({ username: user.username, vertical_id, action: 'Duplicate Barcode Blocked', ip_address: req.ip, new_value: { barcode } });
      return res.status(409).json({ error: 'An asset with this barcode already exists' });
    }
    await assertSerialNumberFree(serial_number, undefined, { username: user.username, vertical_id, ip_address: req.ip });

    const { rows } = await query(
      `INSERT INTO assets (barcode, asset_name, vertical_id, category, vendor_id, brand, model, serial_number, quantity, low_stock_threshold, purchase_date, warranty_expiry, location, department, assigned_employee, remarks, image_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        barcode, asset_name, vertical_id, category || '', vendor_id || null, brand || '', model || '',
        serial_number || null, quantity || 1, low_stock_threshold || null, purchase_date || null, warranty_expiry || null,
        location || '', department || '', assigned_employee || '', remarks || '', image_path || null
      ]
    );
    await logAudit({ username: user.username, vertical_id, action: 'Asset Created', ip_address: req.ip, new_value: rows[0] });
    res.status(201).json({ asset: rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Update an asset. vertical_id is intentionally NOT editable here - an
// asset can't be silently moved between business units through the edit
// form, which would be an easy way to defeat isolation.
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existingRows } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existingRows[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }

    const {
      asset_name, category, vendor_id, brand, model, serial_number, quantity, low_stock_threshold,
      purchase_date, warranty_expiry, location, department, assigned_employee, remarks, image_path, status
    } = req.body || {};

    if (serial_number !== undefined && (serial_number || null) !== existingRows[0].serial_number) {
      await assertSerialNumberFree(serial_number, id, { username: req.session.user.username, vertical_id: existingRows[0].vertical_id, ip_address: req.ip });
    }

    const fields = [];
    const params = [];
    function set(col, val) {
      params.push(val);
      fields.push(`${col} = $${params.length}`);
    }
    if (asset_name !== undefined) set('asset_name', asset_name);
    if (category !== undefined) set('category', category);
    if (vendor_id !== undefined) set('vendor_id', vendor_id || null);
    if (brand !== undefined) set('brand', brand);
    if (model !== undefined) set('model', model);
    if (serial_number !== undefined) set('serial_number', serial_number || null);
    if (quantity !== undefined) set('quantity', quantity);
    if (low_stock_threshold !== undefined) set('low_stock_threshold', low_stock_threshold === '' ? null : low_stock_threshold);
    if (purchase_date !== undefined) set('purchase_date', purchase_date || null);
    if (warranty_expiry !== undefined) set('warranty_expiry', warranty_expiry || null);
    if (location !== undefined) set('location', location);
    if (department !== undefined) set('department', department);
    if (assigned_employee !== undefined) set('assigned_employee', assigned_employee);
    if (remarks !== undefined) set('remarks', remarks);
    // Lists hand out image_path as a /photo link, not the photo itself; a
    // client echoing that link back must never overwrite the stored image.
    if (image_path !== undefined && (image_path === null || String(image_path).startsWith('data:'))) set('image_path', image_path);
    if (status !== undefined) set('status', status);
    fields.push('updated_at = now()');

    params.push(id);
    const { rows } = await query(`UPDATE assets SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    await logAudit({
      username: req.session.user.username, vertical_id: existingRows[0].vertical_id, action: 'Asset Updated',
      ip_address: req.ip, old_value: existingRows[0], new_value: rows[0]
    });
    res.json({ asset: rows[0] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Soft delete only - Super Admin only. Nothing is ever hard-deleted;
// restoring from the Recycle Bin is a Phase 3 UI on top of this same
// deleted_at column.
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });

    const { rows } = await query('UPDATE assets SET deleted_at = now() WHERE id = $1 RETURNING *', [id]);
    await logAudit({
      username: req.session.user.username, vertical_id: existing[0].vertical_id, action: 'Asset Deleted (soft)',
      ip_address: req.ip, old_value: existing[0]
    });
    res.json({ ok: true, asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---- Quantity movement (+/-) ----
router.post('/:id/quantity', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { delta, reason } = req.body || {};
    const change = Number(delta);
    if (!change) return res.status(400).json({ error: 'A non-zero quantity change is required' });

    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existing[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }

    const newQuantity = existing[0].quantity + change;
    if (newQuantity < 0) return res.status(400).json({ error: 'Quantity cannot go below zero' });

    const { rows } = await query('UPDATE assets SET quantity = $1, updated_at = now() WHERE id = $2 RETURNING *', [newQuantity, id]);
    await query(
      `INSERT INTO quantity_movements (asset_id, change_amount, new_quantity, reason, changed_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, change, newQuantity, reason || '', req.session.user.username]
    );
    await logAudit({
      username: req.session.user.username, vertical_id: existing[0].vertical_id,
      action: change > 0 ? 'Quantity Increased' : 'Quantity Decreased', ip_address: req.ip,
      old_value: { quantity: existing[0].quantity }, new_value: { quantity: newQuantity, reason: reason || '' }
    });
    res.json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/quantity-movements', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existing[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }
    const { rows } = await query('SELECT * FROM quantity_movements WHERE asset_id = $1 ORDER BY id DESC', [id]);
    res.json({ movements: rows });
  } catch (err) {
    next(err);
  }
});

// ---- Assignment (assign / return) ----
router.post('/:id/assign', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { employee_name, department } = req.body || {};
    if (!employee_name) return res.status(400).json({ error: 'Employee name required' });

    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existing[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }

    const { rows: activeAssignments } = await query('SELECT * FROM asset_assignments WHERE asset_id = $1 AND returned_at IS NULL', [id]);
    if (activeAssignments.length) {
      await logAudit({
        username: req.session.user.username, vertical_id: existing[0].vertical_id, action: 'Duplicate Assignment Blocked',
        ip_address: req.ip, new_value: { asset_id: id, attempted_employee: employee_name, currently_assigned_to: activeAssignments[0].employee_name }
      });
      return res.status(409).json({ error: `Asset already assigned to ${activeAssignments[0].employee_name}. Return it before reassigning.` });
    }

    await query(
      `INSERT INTO asset_assignments (asset_id, employee_name, department, assigned_by) VALUES ($1,$2,$3,$4)`,
      [id, employee_name, department || '', req.session.user.username]
    );
    // Computed in JS rather than SQL COALESCE/NULLIF (kept portable/simple):
    // only overwrite department if the caller actually supplied one.
    const nextDepartment = department && department.trim() ? department.trim() : existing[0].department;
    const { rows } = await query(
      `UPDATE assets SET assigned_employee = $1, department = $2, status = 'Assigned', updated_at = now() WHERE id = $3 RETURNING *`,
      [employee_name, nextDepartment, id]
    );
    await logAudit({
      username: req.session.user.username, vertical_id: existing[0].vertical_id, action: 'Asset Assigned',
      ip_address: req.ip, new_value: { employee_name, department: department || '' }
    });
    res.json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/return', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existing[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }

    const { rows: activeAssignments } = await query('SELECT * FROM asset_assignments WHERE asset_id = $1 AND returned_at IS NULL', [id]);
    if (!activeAssignments.length) return res.status(400).json({ error: 'This asset has no active assignment' });

    await query('UPDATE asset_assignments SET returned_at = now() WHERE id = $1', [activeAssignments[0].id]);
    const { rows } = await query(
      `UPDATE assets SET assigned_employee = '', status = 'Available', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    await logAudit({
      username: req.session.user.username, vertical_id: existing[0].vertical_id, action: 'Asset Returned',
      ip_address: req.ip, old_value: { employee_name: activeAssignments[0].employee_name }
    });
    res.json({ asset: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/assignments', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existing } = await query('SELECT * FROM assets WHERE id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Asset not found' });
    if (myVertical !== null && existing[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This asset belongs to a different business vertical' });
    }
    const { rows } = await query('SELECT * FROM asset_assignments WHERE asset_id = $1 ORDER BY id DESC', [id]);
    res.json({ assignments: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.sendStoredPhoto = sendStoredPhoto;
