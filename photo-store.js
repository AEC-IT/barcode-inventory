// Where photos live.
//
// With SharePoint configured (the four MS_/SHAREPOINT_ env vars below), every
// new asset/bill photo is uploaded to a SharePoint document library and the
// database keeps only a short reference: "sp:<driveItemId>". Without it,
// photos fall back to the original behaviour (a data URL stored in the row),
// so the app keeps working before the Microsoft setup is done.
//
// Photos are always read back through our own /api/.../photo endpoints
// (see sendStoredPhoto in asset-routes.js), never by linking straight to
// SharePoint. That keeps the per-business access rules in one place and
// means staff don't need SharePoint accounts to see pictures.
//
// Auth is Microsoft Graph "app-only" (client credentials): an app
// registration in Entra ID with the Sites.Selected (or Files.ReadWrite.All)
// application permission, admin-consented. No user ever signs in.

const { query } = require('./db-init');

const GRAPH = (process.env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
const LOGIN = (process.env.MS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const ROOT_FOLDER = (process.env.SHAREPOINT_FOLDER || 'Barcode Inventory').replace(/^\/+|\/+$/g, '');

function isConfigured() {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.SHAREPOINT_SITE);
}

let tokenCache = { token: null, expiresAt: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const res = await fetch(`${LOGIN}/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function graph(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(GRAPH + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  if (!res.ok && !opts.allowError) {
    const body = await res.text().catch(() => '');
    throw new Error(`SharePoint request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res;
}

// SHAREPOINT_SITE accepts the site's normal browser URL, e.g.
//   https://aecgroup.sharepoint.com/sites/AssetPhotos
// (or the bare "aecgroup.sharepoint.com:/sites/AssetPhotos" Graph form).
// The site and its default document library are looked up once and cached.
let driveCache = null;
async function getDriveId() {
  if (driveCache) return driveCache;
  if (process.env.SHAREPOINT_DRIVE_ID) return (driveCache = process.env.SHAREPOINT_DRIVE_ID);
  let site = process.env.SHAREPOINT_SITE.trim().replace(/\/+$/, '');
  const m = site.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
  const siteRef = m ? `${m[1]}:${m[2] || '/'}` : site;
  const siteRes = await graph(`/sites/${siteRef}`);
  const { id: siteId } = await siteRes.json();
  const driveRes = await graph(`/sites/${siteId}/drive`);
  const { id } = await driveRes.json();
  return (driveCache = id);
}

function safeSegment(s) {
  return String(s || 'unknown').replace(/["*:<>?/\\|#%]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}

const verticalCodeCache = new Map();
async function verticalCode(verticalId) {
  if (!verticalId) return 'shared';
  if (verticalCodeCache.has(verticalId)) return verticalCodeCache.get(verticalId);
  const { rows } = await query('SELECT code FROM verticals WHERE id = $1', [verticalId]);
  const code = rows[0] ? rows[0].code : `vertical-${verticalId}`;
  verticalCodeCache.set(verticalId, code);
  return code;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf' };

// Uploads one file and returns "sp:<itemId>". Folder layout, so people can
// also browse the library directly:
//   Barcode Inventory/<business>/<Assets|Bills>/<YYYY-MM>/<label>-<time>.jpg
// Graph's simple upload creates missing folders automatically. Photos are
// compressed in the browser and capped at 3 MB by multer, well under the
// 4 MB simple-upload limit.
async function uploadToSharePoint({ buffer, mimetype, kind, verticalId, label }) {
  const driveId = await getDriveId();
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const ext = EXT[mimetype] || 'bin';
  const name = `${safeSegment(label)}-${now.toISOString().replace(/[:.]/g, '-')}.${ext}`;
  const path = [ROOT_FOLDER, safeSegment(await verticalCode(verticalId)), kind === 'bill' ? 'Bills' : 'Assets', month, name]
    .map(encodeURIComponent).join('/');
  const res = await graph(`/drives/${driveId}/root:/${path}:/content?@microsoft.graph.conflictBehavior=rename`, {
    method: 'PUT',
    headers: { 'Content-Type': mimetype || 'application/octet-stream' },
    body: buffer
  });
  const item = await res.json();
  return { ref: `sp:${item.id}`, webUrl: item.webUrl || null };
}

// Main entry point for routes. Takes either a multer file or a data URL
// string. Returns { image_path, sharepoint_url } to store, or null if there
// is no photo. If SharePoint is configured but the upload fails, the photo
// is NOT silently dropped: it's kept in the database as before, and the
// background migration picks it up later.
async function savePhoto(input, { kind, verticalId, label }) {
  let buffer, mimetype;
  if (!input) return null;
  if (typeof input === 'string') {
    const m = input.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) return null;
    mimetype = m[1];
    buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  } else {
    buffer = input.buffer;
    mimetype = input.mimetype;
  }
  if (!buffer || !buffer.length) return null;
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
  if (!isConfigured()) return { image_path: dataUrl, sharepoint_url: null };
  try {
    const { ref, webUrl } = await uploadToSharePoint({ buffer, mimetype, kind, verticalId, label });
    return { image_path: ref, sharepoint_url: webUrl };
  } catch (err) {
    console.error('SharePoint upload failed, keeping photo in database for now:', err.message);
    return { image_path: dataUrl, sharepoint_url: null };
  }
}

// Reads a stored photo back. Returns { buffer, contentType } or null.
async function readPhoto(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath) return null;
  if (imagePath.startsWith('data:')) {
    const m = imagePath.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) return null;
    return { contentType: m[1], buffer: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) };
  }
  if (imagePath.startsWith('sp:')) {
    if (!isConfigured()) return null;
    const driveId = await getDriveId();
    const res = await graph(`/drives/${driveId}/items/${encodeURIComponent(imagePath.slice(3))}/content`, { allowError: true });
    if (!res.ok) return null;
    return { contentType: res.headers.get('content-type') || 'application/octet-stream', buffer: Buffer.from(await res.arrayBuffer()) };
  }
  return null;
}

// One-off background move of photos already sitting in the database. Runs
// shortly after startup when SharePoint is configured, a few photos at a
// time so it never competes with real users, and is safe to interrupt: a
// row only changes after its upload succeeded, and only if the photo
// wasn't replaced meanwhile. Rows that keep failing are skipped this run
// and retried on the next restart.
let migrating = false;
async function migrateExistingPhotos({ batchSize = 5, pauseMs = 1500 } = {}) {
  if (!isConfigured() || migrating || process.env.SHAREPOINT_MIGRATE_EXISTING === '0') return;
  migrating = true;
  const tables = [
    { table: 'assets', kind: 'asset', label: "COALESCE(NULLIF(barcode, ''), 'asset-' || id)" },
    { table: 'bills', kind: 'bill', label: "'bill-' || id || '-' || COALESCE(asset_name, '')" }
  ];
  let moved = 0;
  const failed = new Set();
  try {
    for (const { table, kind, label } of tables) {
      for (;;) {
        const { rows } = await query(
          `SELECT id, vertical_id, ${label} AS label FROM ${table}
           WHERE image_path LIKE 'data:%' AND NOT (id = ANY($1::int[])) ORDER BY id LIMIT $2`,
          [[...failed].filter((k) => k.startsWith(table + ':')).map((k) => Number(k.split(':')[1])), batchSize]
        );
        if (!rows.length) break;
        for (const row of rows) {
          // Fetch one photo at a time rather than a whole batch of them.
          const { rows: [full] } = await query(`SELECT image_path FROM ${table} WHERE id = $1`, [row.id]);
          if (!full || !String(full.image_path).startsWith('data:')) continue;
          try {
            const m = full.image_path.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
            const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
            const { ref, webUrl } = await uploadToSharePoint({ buffer, mimetype: m[1], kind, verticalId: row.vertical_id, label: row.label });
            await query(
              `UPDATE ${table} SET image_path = $1, photo_sharepoint_url = $2 WHERE id = $3 AND image_path = $4`,
              [ref, webUrl, row.id, full.image_path]
            );
            moved++;
          } catch (err) {
            failed.add(`${table}:${row.id}`);
            console.error(`Photo migration: ${table} #${row.id} failed: ${err.message}`);
          }
        }
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
    if (moved || failed.size) console.log(`Photo migration to SharePoint: ${moved} moved, ${failed.size} failed (will retry next restart).`);
  } catch (err) {
    console.error('Photo migration stopped:', err.message);
  } finally {
    migrating = false;
  }
}

module.exports = { isConfigured, savePhoto, readPhoto, migrateExistingPhotos };
