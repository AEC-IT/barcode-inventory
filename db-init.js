// db-init.js
// AEC Group Enterprise Asset Management System (EAMS) - Phase 1
//
// Persistent database backed by PostgreSQL (Neon free tier, or any Postgres
// connection string). Multi-tenant schema: every asset and every scan
// belongs to exactly one business "vertical" (AEC Studies, AEC Residency,
// AEC Pixcel, and any future ones added later through the app itself -
// verticals are DATA, not hardcoded, so adding a new AEC company never
// requires a code change).
//
// Set the connection string via the DATABASE_URL environment variable.
// Neon's connection strings need SSL, which is handled below automatically.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Set it to your Neon (or other Postgres) connection string before starting the server.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

async function query(text, params) {
  return pool.query(text, params);
}

const bcrypt = require('bcryptjs');

function getIST(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}

// Every mutating action across the app should call this. audit_logs is
// write-only from the app's point of view - there is no UPDATE or DELETE
// route anywhere against this table, which is what makes the log
// "immutable" in practice (nobody, including Super Admin, has a code path
// that can alter or erase a row once it's written).
async function logAudit({ username, vertical_id, action, ip_address, old_value, new_value }) {
  try {
    await query(
      `INSERT INTO audit_logs (username, vertical_id, action, ip_address, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        username || null,
        vertical_id || null,
        action,
        ip_address || null,
        old_value !== undefined ? JSON.stringify(old_value) : null,
        new_value !== undefined ? JSON.stringify(new_value) : null
      ]
    );
  } catch (err) {
    // Audit logging must never break the actual request it's attached to.
    console.error('Audit log write failed:', err.message);
  }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS verticals (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '',
      logo_path TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Real logo files (checked into the repo under /logos, served as static
  // assets - see server.js) replace the emoji placeholders for the three
  // launch verticals. This UPDATE runs every startup but only touches rows
  // that don't already have a logo set, so it's safe against an
  // already-deployed database and won't stomp a logo you change later.
  await query(`UPDATE verticals SET logo_path = '/logos/aec-studies.png' WHERE code = 'aec-studies' AND logo_path IS NULL`);
  await query(`UPDATE verticals SET logo_path = '/logos/aec-residency.png' WHERE code = 'aec-residency' AND logo_path IS NULL`);
  await query(`UPDATE verticals SET logo_path = '/logos/aec-pixcel.png' WHERE code = 'aec-pixcel' AND logo_path IS NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL,
      vertical_id INTEGER REFERENCES verticals(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Migration path for anyone upgrading from the old admin/scanner build.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vertical_id INTEGER REFERENCES verticals(id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      barcode TEXT UNIQUE NOT NULL,
      asset_name TEXT NOT NULL,
      vertical_id INTEGER NOT NULL REFERENCES verticals(id),
      category TEXT DEFAULT '',
      vendor_id INTEGER REFERENCES vendors(id),
      brand TEXT DEFAULT '',
      model TEXT DEFAULT '',
      serial_number TEXT UNIQUE NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      purchase_date DATE,
      warranty_expiry DATE,
      location TEXT DEFAULT '',
      department TEXT DEFAULT '',
      assigned_employee TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Available',
      remarks TEXT DEFAULT '',
      image_path TEXT,
      scan_count INTEGER NOT NULL DEFAULT 0,
      last_scanned_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS asset_assignments (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      employee_name TEXT NOT NULL,
      department TEXT DEFAULT '',
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      returned_at TIMESTAMPTZ,
      assigned_by TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS quantity_movements (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      change_amount INTEGER NOT NULL,
      new_quantity INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      changed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      vertical_id INTEGER REFERENCES verticals(id),
      barcode TEXT NOT NULL,
      asset_name TEXT,
      scanned_by TEXT,
      device_name TEXT,
      device_id TEXT,
      scan_date TEXT,
      scan_time TEXT,
      location TEXT,
      department TEXT,
      assigned_employee TEXT,
      remarks TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Same "already existed from before the EAMS migration" problem as the
  // users table above, but for `scans` this time: the original pre-EAMS
  // barcode app already had its own `scans` table with an older, narrower
  // set of columns, so CREATE TABLE IF NOT EXISTS silently did nothing on
  // any database upgrading from that version - it left the old columns in
  // place instead of adding the new EAMS ones (asset_name, vertical_id,
  // assigned_employee, etc.), which is exactly what caused the dashboard's
  // search and stats endpoints to fail with "column ... does not exist".
  // These ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements run on every
  // startup and are no-ops on a database that's already up to date, but
  // they heal any older/legacy `scans` table shape up to the full schema
  // above without touching or losing any existing rows.
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS vertical_id INTEGER REFERENCES verticals(id)`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS barcode TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS asset_name TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS scanned_by TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS device_name TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS device_id TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_date TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_time TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS location TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS department TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS assigned_employee TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS remarks TEXT`);
  await query(`ALTER TABLE scans ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);

  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      username TEXT,
      vertical_id INTEGER,
      action TEXT NOT NULL,
      ip_address TEXT,
      old_value TEXT,
      new_value TEXT
    )
  `);

  // Purchase bills/invoices ledger. One row per line item on a bill (so a
  // single vendor invoice with 5 products becomes 5 rows here, each still
  // tagged with the same bill_date so the dashboard/ledger can group and
  // total them together). Scoped per-vertical like assets - each business
  // only ever sees its own purchase spend. image_path holds the bill photo
  // as a data URL, same pattern used for asset/scan photos elsewhere.
  await query(`
    CREATE TABLE IF NOT EXISTS bills (
      id SERIAL PRIMARY KEY,
      vertical_id INTEGER NOT NULL REFERENCES verticals(id),
      asset_name TEXT NOT NULL,
      vendor_name TEXT DEFAULT '',
      quantity NUMERIC NOT NULL DEFAULT 1,
      bill_date DATE NOT NULL,
      expiry_date DATE,
      unit_price NUMERIC,
      amount NUMERIC NOT NULL DEFAULT 0,
      image_path TEXT,
      remarks TEXT DEFAULT '',
      created_by TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Safety net in case "bills" already existed on your database from an
  // earlier deploy of this feature, before the Recycle Bin support column
  // (and later, unit_price) was added - same pattern used for the legacy
  // scans/users tables.
  await query(`ALTER TABLE bills ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await query(`ALTER TABLE bills ADD COLUMN IF NOT EXISTS unit_price NUMERIC`);

  await seed();
  await ensureSuperAdmin();
}

// The full demo seed below only runs once, when the `users` table is
// completely empty - that's the right call for a brand-new database, but it
// means anyone upgrading from an older, pre-multi-tenant version of this app
// (which already had its own admin/scanner accounts sitting in `users`)
// would never get a working super_admin login at all, since that "table is
// empty" check would already be false. This runs on every startup,
// independently of the seed() check above, and guarantees a working
// super_admin account always exists - creating 'superadmin' / 'super123' if
// no super_admin exists yet, without touching any other existing users.
async function ensureSuperAdmin() {
  const { rows } = await query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'super_admin'`);
  if (rows[0].count > 0) return;
  await query(
    `INSERT INTO users (username, password_hash, full_name, role, vertical_id)
     VALUES ($1, $2, $3, 'super_admin', NULL)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'super_admin', vertical_id = NULL`,
    ['superadmin', bcrypt.hashSync('super123', 10), 'AEC Group Super Admin']
  );
  console.log('No super_admin account existed - created superadmin / super123');
}

async function seed() {
  const { rows: vertRows } = await query('SELECT COUNT(*)::int AS count FROM verticals');
  let verticals;
  if (vertRows[0].count === 0) {
    const { rows } = await query(
      `INSERT INTO verticals (code, name, icon, logo_path) VALUES
        ('aec-studies', 'AEC Studies', '🟦', '/logos/aec-studies.png'),
        ('aec-residency', 'AEC Residency', '🏨', '/logos/aec-residency.png'),
        ('aec-pixcel', 'AEC Pixcel', '🎬', '/logos/aec-pixcel.png')
       RETURNING *`
    );
    verticals = rows;
  } else {
    const { rows } = await query('SELECT * FROM verticals ORDER BY id ASC');
    verticals = rows;
  }
  const byCode = Object.fromEntries(verticals.map((v) => [v.code, v]));

  const { rows: vendorRows } = await query('SELECT COUNT(*)::int AS count FROM vendors');
  if (vendorRows[0].count === 0) {
    await query(
      `INSERT INTO vendors (name) VALUES ('Dell'), ('HP'), ('Lenovo'), ('Apple'), ('Canon'), ('Samsung')`
    );
  }
  const { rows: vendors } = await query('SELECT * FROM vendors');
  const vendorByName = Object.fromEntries(vendors.map((v) => [v.name, v]));

  const { rows: userRows } = await query('SELECT COUNT(*)::int AS count FROM users');
  if (userRows[0].count === 0) {
    const u = (username, password, full_name, role, vertical_id) => [
      username, bcrypt.hashSync(password, 10), full_name, role, vertical_id
    ];
    const demoUsers = [
      u('superadmin', 'super123', 'AEC Group Super Admin', 'super_admin', null),
      u('studies.admin', 'studies123', 'AEC Studies - Vertical Admin', 'vertical_admin', byCode['aec-studies'].id),
      u('studies.emp', 'emp123', 'AEC Studies - Employee', 'employee', byCode['aec-studies'].id),
      u('residency.admin', 'residency123', 'AEC Residency - Vertical Admin', 'vertical_admin', byCode['aec-residency'].id),
      u('residency.emp', 'emp123', 'AEC Residency - Employee', 'employee', byCode['aec-residency'].id),
      u('pixcel.admin', 'pixcel123', 'AEC Pixcel - Vertical Admin', 'vertical_admin', byCode['aec-pixcel'].id),
      u('pixcel.emp', 'emp123', 'AEC Pixcel - Employee', 'employee', byCode['aec-pixcel'].id)
    ];
    for (const row of demoUsers) {
      await query(
        `INSERT INTO users (username, password_hash, full_name, role, vertical_id) VALUES ($1,$2,$3,$4,$5)`,
        row
      );
    }
  }

  const { rows: assetRows } = await query('SELECT COUNT(*)::int AS count FROM assets');
  if (assetRows[0].count === 0) {
    const sampleAssets = [
      // barcode, asset_name, vertical code, category, vendor, brand, model, serial, qty, location, department, assigned_employee, status
      ['AEC1000001', 'Dell Latitude 5420 Laptop', 'aec-residency', 'Electronics', 'Dell', 'Dell', 'Latitude 5420', 'DL9837282', 1, 'Front Office', 'Administration', 'John Smith', 'Assigned'],
      ['AEC1000002', 'Bath Soap (Guest Amenity)', 'aec-residency', 'Consumable', '', '', '', 'RESI-SOAP-001', 250, 'Housekeeping Store', 'Housekeeping', '', 'Available'],
      ['AEC1000003', 'Epson Projector EB-X06', 'aec-studies', 'Electronics', 'Canon', 'Epson', 'EB-X06', 'ST-PROJ-9001', 1, 'Lecture Hall 1', 'Academics', '', 'Available'],
      ['AEC1000004', 'Canon EOS R6 Camera', 'aec-pixcel', 'Electronics', 'Canon', 'Canon', 'EOS R6', 'PX-CAM-4471', 1, 'Studio A', 'Production', 'Michael Rao', 'Assigned'],
      ['AEC1000005', 'Samsung 55" Studio Monitor', 'aec-pixcel', 'Electronics', 'Samsung', 'Samsung', 'QM55R', 'PX-MON-2210', 3, 'Studio B', 'Production', '', 'Available']
    ];

    for (const row of sampleAssets) {
      const [barcode, asset_name, vcode, category, vendorName, brand, model, serial_number, quantity, location, department, assigned_employee, status] = row;
      const vertical_id = byCode[vcode].id;
      const vendor_id = vendorName && vendorByName[vendorName] ? vendorByName[vendorName].id : null;
      const { rows } = await query(
        `INSERT INTO assets (barcode, asset_name, vertical_id, category, vendor_id, brand, model, serial_number, quantity, location, department, assigned_employee, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [barcode, asset_name, vertical_id, category, vendor_id, brand, model, serial_number, quantity, location, department, assigned_employee, status]
      );
      const assetId = rows[0].id;

      if (status === 'Assigned' && assigned_employee) {
        await query(
          `INSERT INTO asset_assignments (asset_id, employee_name, department, assigned_by) VALUES ($1,$2,$3,$4)`,
          [assetId, assigned_employee, department, 'superadmin']
        );
      }

      const ist = getIST(new Date());
      const scannedBy = vcode === 'aec-residency' ? 'residency.emp' : vcode === 'aec-studies' ? 'studies.emp' : 'pixcel.emp';
      await query(
        `INSERT INTO scans (asset_id, vertical_id, barcode, asset_name, scanned_by, device_name, device_id, scan_date, scan_time, location, department, assigned_employee, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [assetId, vertical_id, barcode, asset_name, scannedBy, 'Demo Device (Seed)', 'demo-device-seed', ist.date, ist.time, location, department, assigned_employee, 'Initial scan (demo data)']
      );
      await query('UPDATE assets SET scan_count = 1, last_scanned_at = now() WHERE id = $1', [assetId]);
    }
  }
}

module.exports = { pool, query, initDB, logAudit, getIST };
