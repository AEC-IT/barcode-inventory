const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { query } = require('./db-init');
const { requireLogin, requireVerticalAdmin, scopeVerticalId } = require('./auth-middleware');
const router = express.Router();

router.use(requireLogin);

async function fetchAssets(req) {
  const myVertical = scopeVerticalId(req);
  const params = [];
  let where = 'WHERE a.deleted_at IS NULL';
  if (myVertical !== null) {
    params.push(myVertical);
    where += ` AND a.vertical_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT a.*, v.name AS vendor_name, ve.name AS vertical_name
     FROM assets_lite a LEFT JOIN vendors v ON a.vendor_id = v.id JOIN verticals ve ON a.vertical_id = ve.id
     ${where} ORDER BY a.id ASC`,
    params
  );
  return rows;
}

async function fetchScans(req) {
  const myVertical = scopeVerticalId(req);
  const params = [];
  let where = '';
  if (myVertical !== null) {
    params.push(myVertical);
    where = `WHERE vertical_id = $${params.length}`;
  }
  const { rows } = await query(`SELECT * FROM scans ${where} ORDER BY id ASC`, params);
  return rows;
}

async function fetchBills(req) {
  const myVertical = scopeVerticalId(req);
  const params = [];
  let where = 'WHERE b.deleted_at IS NULL';
  if (myVertical !== null) {
    params.push(myVertical);
    where += ` AND b.vertical_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT b.*, ve.name AS vertical_name FROM bills_lite b JOIN verticals ve ON b.vertical_id = ve.id
     ${where} ORDER BY b.bill_date ASC, b.id ASC`,
    params
  );
  return rows;
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCSV(headers, keys, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((row) => lines.push(keys.map((k) => csvEscape(row[k])).join(',')));
  return lines.join('\n');
}

const ASSET_COLUMNS = [
  { header: 'Barcode', key: 'barcode', width: 18 },
  { header: 'Asset Name', key: 'asset_name', width: 28 },
  { header: 'Business', key: 'vertical_name', width: 16 },
  { header: 'Category', key: 'category', width: 16 },
  { header: 'Vendor', key: 'vendor_name', width: 14 },
  { header: 'Brand', key: 'brand', width: 12 },
  { header: 'Model', key: 'model', width: 14 },
  { header: 'Serial Number', key: 'serial_number', width: 18 },
  { header: 'Quantity', key: 'quantity', width: 10 },
  { header: 'Location', key: 'location', width: 16 },
  { header: 'Department', key: 'department', width: 16 },
  { header: 'Assigned Employee', key: 'assigned_employee', width: 18 },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'Warranty Expiry', key: 'warranty_expiry', width: 16 },
  { header: 'Remarks', key: 'remarks', width: 22 }
];
const SCAN_COLUMNS = [
  { header: 'Date', key: 'scan_date', width: 14 },
  { header: 'Time', key: 'scan_time', width: 12 },
  { header: 'Barcode', key: 'barcode', width: 18 },
  { header: 'Asset Name', key: 'asset_name', width: 28 },
  { header: 'Location', key: 'location', width: 16 },
  { header: 'Assigned Employee', key: 'assigned_employee', width: 18 },
  { header: 'Scanned By', key: 'scanned_by', width: 14 },
  { header: 'Device', key: 'device_name', width: 22 },
  { header: 'Remarks', key: 'remarks', width: 22 }
];
const BILL_COLUMNS = [
  { header: 'Bill Date', key: 'bill_date', width: 14 },
  { header: 'Product / Asset', key: 'asset_name', width: 26 },
  { header: 'Business', key: 'vertical_name', width: 16 },
  { header: 'Vendor', key: 'vendor_name', width: 16 },
  { header: 'Qty', key: 'quantity', width: 8 },
  { header: 'Unit Price', key: 'unit_price', width: 12 },
  { header: 'Amount', key: 'amount', width: 12 },
  { header: 'Expiry', key: 'expiry_date', width: 14 },
  { header: 'Remarks', key: 'remarks', width: 22 }
];

router.get('/assets.xlsx', async (req, res, next) => {
  try {
    const rows = await fetchAssets(req);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Assets');
    sheet.columns = ASSET_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    rows.forEach((p) => sheet.addRow(p));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/assets.csv', async (req, res, next) => {
  try {
    const rows = await fetchAssets(req);
    const csv = toCSV(ASSET_COLUMNS.map((c) => c.header), ASSET_COLUMNS.map((c) => c.key), rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/scans.xlsx', async (req, res, next) => {
  try {
    const rows = await fetchScans(req);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Scan History');
    sheet.columns = SCAN_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    rows.forEach((s) => sheet.addRow(s));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="scan-history.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/scans.csv', async (req, res, next) => {
  try {
    const rows = await fetchScans(req);
    const csv = toCSV(SCAN_COLUMNS.map((c) => c.header), SCAN_COLUMNS.map((c) => c.key), rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="scan-history.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// Bills exports are Super Admin + Vertical Admin only (requireVerticalAdmin
// added on top of the router-wide requireLogin), unlike the asset/scan
// exports above which any logged-in role can use - matches the same access
// rule as the Bills tab itself and its API routes (bill-routes.js).
router.get('/bills.xlsx', requireVerticalAdmin, async (req, res, next) => {
  try {
    const rows = await fetchBills(req);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Bills');
    sheet.columns = BILL_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    rows.forEach((b) => sheet.addRow(b));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bills.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/bills.csv', requireVerticalAdmin, async (req, res, next) => {
  try {
    const rows = await fetchBills(req);
    const csv = toCSV(BILL_COLUMNS.map((c) => c.header), BILL_COLUMNS.map((c) => c.key), rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bills.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/bills.pdf', requireVerticalAdmin, async (req, res, next) => {
  try {
    const rows = await fetchBills(req);
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="bills.pdf"');
    doc.pipe(res);

    const colX = [30, 105, 290, 405, 500, 545, 610, 675];
    const colW = [70, 180, 110, 90, 40, 60, 60, 90];
    let total = 0;
    rows.forEach((b) => { total += Number(b.amount); });
    drawTable(
      doc,
      `AEC Group - Purchase Bills Ledger (Total: ${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})})`,
      ['Bill Date', 'Product', 'Business', 'Vendor', 'Qty', 'Unit Price', 'Amount', 'Expiry'],
      colX,
      colW,
      rows,
      (b) => [b.bill_date, b.asset_name, b.vertical_name, b.vendor_name, b.quantity, b.unit_price ?? '-', b.amount, b.expiry_date || '-']
    );

    doc.end();
  } catch (err) {
    next(err);
  }
});

function drawTable(doc, title, headers, colX, colW, rows, rowMapper) {
  doc.fontSize(16).text(title, { align: 'center' });
  doc.moveDown();
  doc.fontSize(9);

  doc.font('Helvetica-Bold');
  let y = doc.y;
  headers.forEach((h, i) => doc.text(h, colX[i], y, { width: colW[i] }));
  doc.moveDown(1.2);
  doc.font('Helvetica');

  rows.forEach((row) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
    }
    const rowY = doc.y;
    const cells = rowMapper(row);
    cells.forEach((val, i) => doc.text(String(val ?? '-'), colX[i], rowY, { width: colW[i] }));
    doc.moveDown(1);
  });
}

router.get('/assets.pdf', async (req, res, next) => {
  try {
    const rows = await fetchAssets(req);
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.pdf"');
    doc.pipe(res);

    const colX = [30, 130, 300, 400, 490, 590, 690];
    const colW = [95, 165, 95, 85, 95, 95, 100];
    drawTable(
      doc,
      'AEC Group - Asset Register',
      ['Barcode', 'Asset Name', 'Business', 'Serial No.', 'Status', 'Employee', 'Updated'],
      colX,
      colW,
      rows,
      (a) => [a.barcode, a.asset_name, a.vertical_name, a.serial_number, a.status, a.assigned_employee, new Date(a.updated_at).toLocaleString()]
    );

    doc.end();
  } catch (err) {
    next(err);
  }
});

router.get('/scans.pdf', async (req, res, next) => {
  try {
    const rows = await fetchScans(req);
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="scan-history.pdf"');
    doc.pipe(res);

    const colX = [30, 100, 200, 400, 520, 650];
    const colW = [65, 95, 195, 115, 125, 115];
    drawTable(
      doc,
      'AEC Group - Scan History Report',
      ['Date/Time', 'Barcode', 'Asset Name', 'Scanned By', 'Device', 'Location'],
      colX,
      colW,
      rows,
      (s) => [`${s.scan_date} ${s.scan_time}`, s.barcode, s.asset_name, s.scanned_by, s.device_name, s.location]
    );

    doc.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
