const express = require('express');
const { query, logAudit } = require('./db-init');
const { requireLogin, requireSuperAdmin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

router.use(requireLogin);

// A vendor with vertical_id = NULL is "authorised" for every business
// (shared master list, e.g. Dell/HP). A vendor with a real vertical_id is
// only authorised for that one business. Super Admin sees the whole list
// (used both by the Vendor Master tab and its own "authorised vendors per
// business" filter); a Vertical Admin/Employee only ever sees their own
// business's vendors plus the shared ones - never another business's.
router.get('/', async (req, res, next) => {
  try {
    const myVertical = scopeVerticalId(req);
    const params = [];
    let where = '';
    if (myVertical !== null) {
      params.push(myVertical);
      where = `WHERE vendors.vertical_id IS NULL OR vendors.vertical_id = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT vendors.*, ve.name AS vertical_name, ve.icon AS vertical_icon
       FROM vendors LEFT JOIN verticals ve ON vendors.vertical_id = ve.id
       ${where} ORDER BY vendors.name ASC`,
      params
    );
    res.json({ vendors: rows });
  } catch (err) {
    next(err);
  }
});

// Adding a vendor is allowed from the registration form ("+ Add Vendor" if
// it's not in the list yet). A Super Admin chooses which business the
// vendor is authorised for (or leaves it shared/all); a Vertical
// Admin/Employee can only ever create a vendor for their OWN business -
// whatever vertical_id they send is ignored and their session's vertical is
// used instead, so nobody can plant a vendor into another business.
// Duplicates are rejected, but scoped per business: "ABC Traders" can exist
// once shared AND once more per individual business without colliding.
router.post('/', async (req, res, next) => {
  try {
    const user = req.session.user;
    const { name, vertical_id: requestedVerticalId } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Vendor name required' });
    }
    const clean = name.trim();

    let vertical_id = null;
    if (user.role === 'super_admin') {
      vertical_id = requestedVerticalId ? Number(requestedVerticalId) : null;
    } else {
      vertical_id = user.vertical_id;
    }

    const { rows: existing } = await query(
      'SELECT * FROM vendors WHERE LOWER(name) = LOWER($1) AND vertical_id IS NOT DISTINCT FROM $2',
      [clean, vertical_id]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'This vendor already exists for that business', vendor: existing[0] });
    }
    const { rows } = await query('INSERT INTO vendors (name, vertical_id) VALUES ($1,$2) RETURNING *', [clean, vertical_id]);
    await logAudit({
      username: user.username,
      vertical_id: vertical_id || user.vertical_id,
      action: 'Vendor Created',
      ip_address: req.ip,
      new_value: rows[0]
    });
    res.status(201).json({ vendor: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Removing a vendor is Super Admin only, since the vendor master list is
// shared across every business - a Vertical Admin deleting one could break
// other businesses' asset records. Blocked outright if any non-deleted
// asset still references this vendor, so nothing ever ends up pointing at
// a vendor that no longer exists.
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: existing } = await query('SELECT * FROM vendors WHERE id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Vendor not found' });

    const { rows: inUse } = await query(
      'SELECT COUNT(*)::int AS count FROM assets WHERE vendor_id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (inUse[0].count > 0) {
      return res.status(409).json({
        error: `Cannot remove "${existing[0].name}" - it's still used by ${inUse[0].count} asset(s). Change their vendor first, then try again.`
      });
    }

    await query('DELETE FROM vendors WHERE id = $1', [id]);
    await logAudit({
      username: req.session.user.username,
      action: 'Vendor Deleted',
      ip_address: req.ip,
      old_value: existing[0]
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
