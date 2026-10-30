// End-to-end test for /api/integrations/bill-scanner against a running server.
// Run: start the server with BILL_SCANNER_API_KEY=test-key-123, then
// BASE=http://localhost:3000 DATABASE_URL=... node e2e-test-integration.js
const BASE = process.env.BASE || 'http://localhost:3077';
const KEY = 'test-key-123';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

async function push(event, body, key = KEY) {
  const r = await fetch(BASE + '/api/integrations/bill-scanner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'X-Event': event },
    body: JSON.stringify({ event, source_app: 'bill-scanner', ...body })
  });
  return { status: r.status, data: await r.json() };
}

const { Client } = require('pg');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const v = (await db.query("SELECT id, code FROM verticals ORDER BY id LIMIT 1")).rows[0];
  const asset = (await db.query('SELECT barcode, scan_count FROM assets WHERE vertical_id = $1 AND deleted_at IS NULL LIMIT 1', [v.id])).rows[0];

  const bill = { id: 'b-uuid-1', vertical_id: v.code, invoice_number: 'INV-3785', invoice_date: '2026-08-18',
    vendor_name: 'Sample Traders Pvt Ltd', vendor_gstin: '29AAAAA0000A1Z5', currency: 'INR',
    confidence_overall: 0.79, needs_review: true, image_url: '/api/v1/bills/b-uuid-1/original' };
  const items = [
    { idempotency_key: 'b-uuid-1:0', line_no: 1, product_name: 'Office Stationery Bundle', hsn_sac: '4820', barcode: null, quantity: 10, unit_price: 300, amount: 3000, confidence: 0.79, needs_review: true },
    { idempotency_key: 'b-uuid-1:1', line_no: 2, product_name: 'Known Item', barcode: asset ? asset.barcode : null, quantity: 1, unit_price: 1500, amount: 1500, confidence: 0.95, needs_review: false }
  ];

  let r = await push('bill.items.extracted', { sent_at: '2026-08-18T11:32:15.000Z', bill, items }, 'wrong');
  ok(r.status === 401, 'wrong API key -> 401');

  r = await push('bill.items.extracted', { sent_at: '2026-08-18T11:32:15.000Z', bill, items });
  ok(r.status === 200 && r.data.items.length === 2 && r.data.items.every((i) => i.inserted), 'first delivery inserts 2 lines');
  ok(!asset || r.data.items[1].asset_id, 'line with known barcode linked to existing product');

  r = await push('bill.items.extracted', { sent_at: '2026-08-18T11:32:15.000Z', bill, items });
  ok(r.status === 200 && r.data.items.every((i) => !i.inserted), 'redelivery updates, does not insert');
  let rows = (await db.query("SELECT * FROM bills WHERE external_bill_id = 'b-uuid-1' AND deleted_at IS NULL ORDER BY external_key")).rows;
  ok(rows.length === 2, 'still exactly 2 bill rows after redelivery');
  ok(rows[0].needs_review === true && rows[0].source === 'bill-scanner' && rows[0].invoice_number === 'INV-3785', 'needs_review/source/invoice stored');

  // Human reviews line 0, then bill is edited upstream: line 1 removed, line 0 price changed
  await db.query("UPDATE bills SET reviewed_at = now(), needs_review = false WHERE external_key = 'b-uuid-1:0'");
  r = await push('bill.items.extracted', { sent_at: '2026-08-19T09:00:00.000Z', bill, items: [{ ...items[0], unit_price: 320, amount: 3200 }] });
  ok(r.status === 200 && r.data.removed === 1, 'edited bill soft-deletes the dropped line');
  rows = (await db.query("SELECT * FROM bills WHERE external_key = 'b-uuid-1:0'")).rows;
  ok(Number(rows[0].amount) === 3200 && rows[0].needs_review === false, 'edit applied, reviewed line stays reviewed');

  r = await push('bill.items.extracted', { bill: { ...bill, id: 'b2', vertical_id: 'no-such-vertical' }, items });
  ok(r.status === 422, 'unknown vertical -> 422');

  const cap = { id: 'cap-1', vertical_id: String(v.id), captured_by: 'u1', barcode: asset ? asset.barcode : '8901234567890', barcode_format: 'EAN_13', confidence: 0.99, captured_at: '2026-08-18T11:32:15.000Z' };
  r = await push('capture.barcode', { capture: cap });
  ok(r.status === 200 && r.data.scan_id && !r.data.duplicate, 'capture.barcode creates a scan');
  r = await push('capture.barcode', { capture: cap });
  ok(r.status === 200 && r.data.duplicate === true, 'redelivered capture is a no-op');
  if (asset) {
    const sc = (await db.query('SELECT scan_count FROM assets WHERE barcode = $1', [asset.barcode])).rows[0].scan_count;
    ok(sc === asset.scan_count + 1, 'scan_count incremented exactly once');
  }
  r = await push('capture.barcode', { capture: { ...cap, id: 'cap-2', barcode: '0000000000000' } });
  ok(r.status === 200 && r.data.known_product === false, 'unknown barcode recorded as unregistered scan');

  r = await push('bill.processed', { sent_at: 'x', bill });
  ok(r.status === 200 && r.data.stored_only, 'bill.processed acknowledged');
  r = await push('weird.event', {});
  ok(r.status === 400, 'unsupported event -> 400');

  const ev = (await db.query("SELECT status, count(*)::int n FROM integration_events GROUP BY status")).rows;
  console.log('integration_events:', JSON.stringify(ev));
  await db.end();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
