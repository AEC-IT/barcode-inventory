const express = require('express');
const multer = require('multer');
const { query, logAudit } = require('./db-init');
const { requireLogin, requireVerticalAdmin, scopeVerticalId } = require('./auth-middleware');
const { analyzeBillImage, isConfigured: aiConfigured } = require('./azure-invoice');
const router = express.Router();
const { sendStoredPhoto } = require('./asset-routes');
const { savePhoto } = require('./photo-store');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }
});

function fileToDataUrl(file) {
  if (!file) return undefined;
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// Purchase Bills ledger. Same access rule as everywhere else: a Vertical
// Admin only ever sees/touches their OWN business's bills, taken from their
// session (never the client); Super Admin can see every business, or one
// at a time via ?vertical_id=. Employees never reach this router at all
// (requireVerticalAdmin blocks them below).
router.use(requireLogin, requireVerticalAdmin);

// List bills, oldest first, so the frontend can group them into months in
// order and keep a running per-month total as it walks the list.
router.get('/', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const { vertical_id } = req.query;
    const clauses = ['b.deleted_at IS NULL'];
    const params = [];

    if (myVertical !== null) {
      params.push(myVertical);
      clauses.push(`b.vertical_id = $${params.length}`);
    } else if (vertical_id) {
      params.push(Number(vertical_id));
      clauses.push(`b.vertical_id = $${params.length}`);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const { rows } = await query(
      `SELECT b.*, ve.name AS vertical_name, ve.icon AS vertical_icon FROM bills_lite b
       JOIN verticals ve ON b.vertical_id = ve.id
       ${where} ORDER BY b.bill_date ASC, b.id ASC`,
      params
    );
    res.json({ bills: rows });
  } catch (err) {
    next(err);
  }
});

// Recycle Bin for bills - same soft-delete pattern as assets: nothing here
// is ever hard-deleted, just hidden from the normal list above until
// restored (or left here indefinitely).
// Bill photo, served on demand instead of inside every list (see
// createLiteViews in db-init.js).
router.get('/:id/photo', (req, res, next) => sendStoredPhoto(req, res, next, 'bills'));

router.get('/recycle-bin', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const clauses = ['b.deleted_at IS NOT NULL'];
    const params = [];
    if (myVertical !== null) {
      params.push(myVertical);
      clauses.push(`b.vertical_id = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT b.*, ve.name AS vertical_name, ve.icon AS vertical_icon FROM bills_lite b
       JOIN verticals ve ON b.vertical_id = ve.id
       WHERE ${clauses.join(' AND ')} ORDER BY b.deleted_at DESC`,
      params
    );
    res.json({ bills: rows });
  } catch (err) {
    next(err);
  }
});

// Lets the frontend know whether the "Scan Bill (AI)" button should even
// be shown - true only once AZURE_DOCINTEL_ENDPOINT/KEY are set on the
// server, so nobody sees a button that would just error out.
router.get('/ai-status', (req, res) => {
  res.json({ configured: aiConfigured() });
});

// Reads a bill photo/PDF with Azure AI Document Intelligence and returns a
// DRAFT (not saved to the database yet) - one entry per product line item
// found on the bill, each with a confidence score per field so the review
// screen can flag anything uncertain instead of silently trusting it. The
// user reviews/corrects this draft in the UI, then each line gets POSTed
// to the normal POST / route below exactly like a manually typed bill.
router.post('/scan-ai', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No bill image/PDF uploaded' });
    const draft = await analyzeBillImage(req.file.buffer, req.file.mimetype);
    await logAudit({
      username: req.session.user.username,
      vertical_id: req.session.user.vertical_id,
      action: 'Bill Scanned (AI)',
      ip_address: req.ip,
      new_value: { vendor_name: draft.vendor_name, line_item_count: draft.line_items.length }
    });
    res.json({ draft });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message });
    next(err);
  }
});

// Add one bill line item. Accepts multipart/form-data so the bill photo
// (field name "photo") can ride along - stored as a data URL in image_path,
// same pattern as asset/scan photos. A Super Admin must say which business
// the bill belongs to; a Vertical Admin's own vertical is used
// automatically and can't be overridden from the request.
router.post('/', upload.single('photo'), async (req, res, next) => {
  try {
    const user = req.session.user;
    const {
      asset_name, vendor_name, quantity, bill_date, expiry_date, unit_price, amount, remarks,
      vertical_id: requestedVerticalId
    } = req.body || {};

    if (!asset_name || !String(asset_name).trim()) return res.status(400).json({ error: 'Product/Asset name is required' });
    if (!bill_date) return res.status(400).json({ error: 'Bill date is required' });
    if (amount === undefined || amount === '' || Number.isNaN(Number(amount))) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    let vertical_id = user.vertical_id;
    if (user.role === 'super_admin') {
      if (!requestedVerticalId) return res.status(400).json({ error: 'Business Vertical is required' });
      vertical_id = Number(requestedVerticalId);
    }

    const photo = await savePhoto(req.file, { kind: 'bill', verticalId: vertical_id, label: `bill-${String(asset_name).trim()}` });
    const unitPriceVal = unit_price !== undefined && unit_price !== '' && !Number.isNaN(Number(unit_price))
      ? Number(unit_price) : null;
    const { rows } = await query(
      `INSERT INTO bills (vertical_id, asset_name, vendor_name, quantity, bill_date, expiry_date, unit_price, amount, image_path, remarks, created_by, photo_sharepoint_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        vertical_id, String(asset_name).trim(), vendor_name || '', Number(quantity) || 1,
        bill_date, expiry_date || null, unitPriceVal, Number(amount), photo ? photo.image_path : null, remarks || '', user.username,
        photo ? photo.sharepoint_url : null
      ]
    );
    await logAudit({
      username: user.username, vertical_id, action: 'Bill Added', ip_address: req.ip, new_value: rows[0]
    });
    res.status(201).json({ bill: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Inline-edit autosave: any single field (or several at once) can be
// updated from the ledger table without a form. Also accepts a replacement
// photo the same way. Ownership is re-checked here so a Vertical Admin
// still can't touch another business's bill even by guessing an id.
router.put('/:id', upload.single('photo'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existingRows } = await query('SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Bill not found' });
    if (myVertical !== null && existingRows[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This bill belongs to a different business vertical' });
    }

    const { asset_name, vendor_name, quantity, bill_date, expiry_date, unit_price, amount, remarks } = req.body || {};
    const uploadedPhoto = await savePhoto(req.file, { kind: 'bill', verticalId: existingRows[0].vertical_id, label: `bill-${id}-${existingRows[0].asset_name}` });
    const fields = [];
    const params = [];
    function set(col, val) {
      params.push(val);
      fields.push(`${col} = $${params.length}`);
    }
    if (asset_name !== undefined) set('asset_name', asset_name);
    if (vendor_name !== undefined) set('vendor_name', vendor_name);
    if (quantity !== undefined) set('quantity', quantity === '' || Number.isNaN(Number(quantity)) ? 1 : Number(quantity));
    if (bill_date !== undefined) set('bill_date', bill_date);
    if (expiry_date !== undefined) set('expiry_date', expiry_date || null);
    if (unit_price !== undefined) set('unit_price', unit_price === '' || Number.isNaN(Number(unit_price)) ? null : Number(unit_price));
    if (amount !== undefined) set('amount', amount === '' || Number.isNaN(Number(amount)) ? 0 : Number(amount));
    if (remarks !== undefined) set('remarks', remarks);
    if (uploadedPhoto) { set('image_path', uploadedPhoto.image_path); set('photo_sharepoint_url', uploadedPhoto.sharepoint_url); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = now()');

    params.push(id);
    const { rows } = await query(`UPDATE bills SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    await logAudit({
      username: req.session.user.username, vertical_id: rows[0].vertical_id, action: 'Bill Updated',
      ip_address: req.ip, old_value: existingRows[0], new_value: rows[0]
    });
    res.json({ bill: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Soft delete - moves the bill to the Recycle Bin above rather than
// erasing it, same as assets elsewhere in the app.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existingRows } = await query('SELECT * FROM bills WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Bill not found' });
    if (myVertical !== null && existingRows[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This bill belongs to a different business vertical' });
    }

    const { rows } = await query('UPDATE bills SET deleted_at = now() WHERE id = $1 RETURNING *', [id]);
    await logAudit({
      username: req.session.user.username, vertical_id: existingRows[0].vertical_id,
      action: 'Bill Moved to Recycle Bin', ip_address: req.ip, old_value: existingRows[0]
    });
    res.json({ ok: true, bill: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/restore', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const myVertical = scopeVerticalId(req);
    const { rows: existingRows } = await query('SELECT * FROM bills WHERE id = $1 AND deleted_at IS NOT NULL', [id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Bill not found in Recycle Bin' });
    if (myVertical !== null && existingRows[0].vertical_id !== myVertical) {
      return res.status(403).json({ error: 'This bill belongs to a different business vertical' });
    }

    const { rows } = await query('UPDATE bills SET deleted_at = NULL WHERE id = $1 RETURNING *', [id]);
    await logAudit({
      username: req.session.user.username, vertical_id: rows[0].vertical_id,
      action: 'Bill Restored', ip_address: req.ip, new_value: rows[0]
    });
    res.json({ ok: true, bill: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
