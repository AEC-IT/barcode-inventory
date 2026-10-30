const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, logAudit, getIST } = require('./db-init');
const router = express.Router();

// Receiving side of the Bill Scanner -> Barcode Scanner contract
// (see claude/bill-scanner-to-barcode-scanner-contract.md in the project).
//
// The bill scanner is an independent app. It pushes to us over HTTP from a
// durable outbox with retries, so EVERY handler here must be idempotent: the
// same message can arrive more than once, and a re-processed/edited bill
// re-sends the same items with the same idempotency keys.
//
// One URL handles all three events (dispatch on X-Event / body.event), so
// the bill scanner can point SUPER_APP_ITEMS_URL, SUPER_APP_BARCODE_URL and
// SUPER_APP_WEBHOOK_URL at the same place - or just set SUPER_APP_WEBHOOK_URL
// and let the others fall back to it.
//
// Auth is a shared API key (X-API-Key), not a login session. Machine calls
// carry no session, so requireCsrf passes them through untouched.

const SOURCE = 'bill-scanner';

// Bill scanner retries with backoff and can flush a backlog in a burst, so
// it gets its own ceiling instead of sharing the 180/min interactive one.
const integrationLimiter = process.env.DISABLE_RATE_LIMIT === '1'
  ? (req, res, next) => next()
  : rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireApiKey(req, res, next) {
  const expected = process.env.BILL_SCANNER_API_KEY;
  // Unset key = integration switched off. 503 (not 401) so the bill
  // scanner's outbox keeps the message and retries once it's configured.
  if (!expected) return res.status(503).json({ error: 'Bill scanner integration is not configured' });
  const given = req.get('x-api-key');
  if (!given || !safeEqual(given, expected)) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

// The bill scanner sends its own vertical_id. We accept either our numeric
// id or our vertical code (e.g. "aec-studies"), so the two apps don't need
// to share ID sequences. An optional JSON map in BILL_SCANNER_VERTICAL_MAP
// ({"<their id>": "<our id or code>"}) covers anything else.
async function resolveVertical(externalId) {
  if (externalId === undefined || externalId === null || externalId === '') return null;
  let key = String(externalId);
  try {
    const map = JSON.parse(process.env.BILL_SCANNER_VERTICAL_MAP || '{}');
    if (map[key] !== undefined) key = String(map[key]);
  } catch (e) {
    console.error('BILL_SCANNER_VERTICAL_MAP is not valid JSON');
  }
  const { rows } = /^\d+$/.test(key)
    ? await query('SELECT id FROM verticals WHERE id = $1', [Number(key)])
    : await query('SELECT id FROM verticals WHERE code = $1', [key]);
  return rows[0] ? rows[0].id : null;
}

// The bill scanner's image_url is a path on ITS server. Store an absolute
// link when we know its base URL, otherwise keep the path as-is.
function absoluteImageUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = (process.env.BILL_SCANNER_BASE_URL || '').replace(/\/+$/, '');
  return base ? base + path : path;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

// Every message is recorded once in integration_events. The dedupe key is
// event + message identity, so a retried delivery of an already-applied
// message is answered 200 without touching data twice.
async function recordEvent(event, dedupeKey, payload) {
  const { rows } = await query(
    `INSERT INTO integration_events (source, event, dedupe_key, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, dedupe_key) DO UPDATE SET received_count = integration_events.received_count + 1, last_received_at = now()
     RETURNING id, received_count`,
    [SOURCE, event, dedupeKey, JSON.stringify(payload)]
  );
  return rows[0];
}

async function handleItemsExtracted(body, req) {
  const bill = body.bill || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!bill.id) return { status: 400, body: { error: 'bill.id is required' } };

  const verticalId = await resolveVertical(bill.vertical_id);
  if (!verticalId) return { status: 422, body: { error: `Unknown vertical_id "${bill.vertical_id}"` } };

  const billDate = isoDate(bill.invoice_date) || getIST().date;
  const imageUrl = absoluteImageUrl(bill.image_url);
  const results = [];

  for (const [i, item] of items.entries()) {
    const key = item.idempotency_key || `${bill.id}:${i}`;
    const name = (item.product_name || '').trim() || `Line ${item.line_no || i + 1}`;
    const barcode = item.barcode ? String(item.barcode).trim() : null;
    const needsReview = item.needs_review === true || bill.needs_review === true;

    // Link to an existing product in the same vertical when the bill
    // printed a barcode. Never create products from OCR output - a person
    // confirms new products; we only flag the match.
    let assetId = null;
    if (barcode) {
      const { rows } = await query(
        'SELECT id FROM assets WHERE barcode = $1 AND vertical_id = $2 AND deleted_at IS NULL',
        [barcode, verticalId]
      );
      if (rows[0]) assetId = rows[0].id;
    }

    // UPSERT on the idempotency key - re-processing or editing a bill on
    // the bill scanner side updates these rows instead of duplicating them.
    // A row a user has already reviewed here keeps its needs_review=false.
    const { rows } = await query(
      `INSERT INTO bills (vertical_id, asset_name, vendor_name, quantity, bill_date, unit_price, amount,
                          remarks, created_by, source, external_key, external_bill_id, invoice_number,
                          vendor_gstin, hsn_sac, barcode, tax_amount, confidence, needs_review,
                          source_image_url, asset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (external_key) WHERE external_key IS NOT NULL DO UPDATE SET
         vertical_id = EXCLUDED.vertical_id, asset_name = EXCLUDED.asset_name, vendor_name = EXCLUDED.vendor_name,
         quantity = EXCLUDED.quantity, bill_date = EXCLUDED.bill_date, unit_price = EXCLUDED.unit_price,
         amount = EXCLUDED.amount, invoice_number = EXCLUDED.invoice_number, vendor_gstin = EXCLUDED.vendor_gstin,
         hsn_sac = EXCLUDED.hsn_sac, barcode = EXCLUDED.barcode, tax_amount = EXCLUDED.tax_amount,
         confidence = EXCLUDED.confidence, source_image_url = EXCLUDED.source_image_url,
         asset_id = COALESCE(EXCLUDED.asset_id, bills.asset_id),
         needs_review = CASE WHEN bills.reviewed_at IS NOT NULL THEN false ELSE EXCLUDED.needs_review END,
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        verticalId, name, bill.vendor_name || '', num(item.quantity) ?? 1, billDate,
        num(item.unit_price), num(item.amount) ?? 0, SOURCE, key, String(bill.id),
        bill.invoice_number || null, bill.vendor_gstin || null, item.hsn_sac || null, barcode,
        num(item.tax_amount), num(item.confidence ?? bill.confidence_overall), needsReview, imageUrl, assetId
      ]
    );
    results.push({ idempotency_key: key, bill_row_id: rows[0].id, inserted: rows[0].inserted, asset_id: assetId });
  }

  // Lines that disappeared from an edited bill are soft-deleted (Recycle
  // Bin), not hard-deleted, matching how bills are removed everywhere else.
  const keys = results.map((r) => r.idempotency_key);
  const { rowCount: removed } = await query(
    `UPDATE bills SET deleted_at = now(), updated_at = now()
     WHERE source = $1 AND external_bill_id = $2 AND deleted_at IS NULL AND NOT (external_key = ANY($3::text[]))`,
    [SOURCE, String(bill.id), keys]
  );

  await logAudit({
    username: SOURCE, vertical_id: verticalId, action: 'Bill Items Received', ip_address: req.ip,
    new_value: { bill_id: bill.id, invoice_number: bill.invoice_number, items: results.length,
                 inserted: results.filter((r) => r.inserted).length, removed, needs_review: !!bill.needs_review }
  });
  return { status: 200, body: { ok: true, vertical_id: verticalId, items: results, removed } };
}

async function handleCaptureBarcode(body, req) {
  const cap = body.capture || {};
  if (!cap.id || !cap.barcode) return { status: 400, body: { error: 'capture.id and capture.barcode are required' } };

  const verticalId = await resolveVertical(cap.vertical_id);
  if (!verticalId) return { status: 422, body: { error: `Unknown vertical_id "${cap.vertical_id}"` } };

  const barcode = String(cap.barcode).trim();
  const { rows: assets } = await query(
    'SELECT id, asset_name, location, department, assigned_employee FROM assets WHERE barcode = $1 AND vertical_id = $2 AND deleted_at IS NULL',
    [barcode, verticalId]
  );
  const asset = assets[0] || null;
  const when = cap.captured_at ? new Date(cap.captured_at) : new Date();
  const ist = getIST(Number.isNaN(when.getTime()) ? new Date() : when);

  // external_key makes a redelivered capture a no-op instead of a second scan.
  const { rows } = await query(
    `INSERT INTO scans (asset_id, vertical_id, barcode, asset_name, scanned_by, device_name, scan_date, scan_time,
                        location, department, assigned_employee, remarks, source, external_key)
     VALUES ($1,$2,$3,$4,$5,'Bill Scanner',$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (external_key) WHERE external_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      asset ? asset.id : null, verticalId, barcode, asset ? asset.asset_name : null,
      cap.captured_by ? String(cap.captured_by) : SOURCE, ist.date, ist.time,
      asset ? asset.location : null, asset ? asset.department : null, asset ? asset.assigned_employee : null,
      asset ? `Captured via bill scanner (${cap.barcode_format || 'barcode'})`
            : `Unknown barcode captured via bill scanner (${cap.barcode_format || 'barcode'}) - not yet registered`,
      SOURCE, `capture:${cap.id}`
    ]
  );
  const created = rows.length > 0;
  if (created && asset) {
    await query('UPDATE assets SET scan_count = scan_count + 1, last_scanned_at = now() WHERE id = $1', [asset.id]);
  }
  if (created) {
    await logAudit({
      username: SOURCE, vertical_id: verticalId, action: 'Barcode Capture Received', ip_address: req.ip,
      new_value: { capture_id: cap.id, barcode, asset_id: asset ? asset.id : null, image_url: absoluteImageUrl(cap.image_url) }
    });
  }
  return { status: 200, body: { ok: true, scan_id: created ? rows[0].id : null, duplicate: !created, asset_id: asset ? asset.id : null, known_product: !!asset } };
}

router.post('/bill-scanner', integrationLimiter, requireApiKey, async (req, res, next) => {
  try {
    const body = req.body || {};
    const event = req.get('x-event') || body.event;

    let dedupeKey;
    if (event === 'bill.items.extracted') dedupeKey = `bill:${body.bill && body.bill.id}:${body.sent_at || ''}`;
    else if (event === 'capture.barcode') dedupeKey = `capture:${body.capture && body.capture.id}`;
    else if (event === 'bill.processed') dedupeKey = `processed:${(body.bill && body.bill.id) || body.id}:${body.sent_at || ''}`;
    else return res.status(400).json({ error: `Unsupported event "${event}"` });

    const logged = await recordEvent(event, dedupeKey, body);

    let result;
    if (event === 'bill.items.extracted') result = await handleItemsExtracted(body, req);
    else if (event === 'capture.barcode') result = await handleCaptureBarcode(body, req);
    // bill.processed duplicates what bill.items.extracted already applied;
    // it's kept in integration_events for reference and acknowledged.
    else result = { status: 200, body: { ok: true, stored_only: true } };

    await query('UPDATE integration_events SET status = $1, error = $2 WHERE id = $3', [
      result.status < 300 ? 'applied' : 'rejected',
      result.status < 300 ? null : result.body.error,
      logged.id
    ]);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err); // 500 -> bill scanner outbox retries with backoff
  }
});

module.exports = router;
