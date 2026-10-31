// Load DATABASE_URL / SESSION_SECRET from a local .env file if one exists
// (used only when running on your own computer - Render and other hosts
// provide these as real environment variables instead, so this is a no-op
// there).
require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');

const { initDB } = require('./db-init');

const authRoutes = require('./auth-routes');
const assetRoutes = require('./asset-routes');
const scanRoutes = require('./scan-routes');
const userRoutes = require('./user-routes');
const statsRoutes = require('./stats-routes');
const exportRoutes = require('./export-routes');
const searchRoutes = require('./search-routes');
const verticalRoutes = require('./vertical-routes');
const vendorRoutes = require('./vendor-routes');
const auditRoutes = require('./audit-routes');
const notificationRoutes = require('./notification-routes');
const billRoutes = require('./bill-routes');
const { requireCsrf } = require('./csrf-middleware');
const { generalLimiter } = require('./rate-limit-config');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) put the app behind a reverse proxy. Without this,
// req.ip would always resolve to the proxy's internal address instead of
// the real visitor IP, which the audit log records for every action.
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Logins are kept in Postgres rather than in server memory. Render's free
// plan puts the server to sleep after 15 idle minutes; with the default
// in-memory store every sleep/restart/redeploy silently logged everyone
// out, and the open dashboard then showed "Request failed" on every call.
// The table is created automatically and expired logins are cleaned up
// every few hours, so it stays a few KB.
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./db-init');

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
      pruneSessionInterval: 6 * 60 * 60 // seconds
    }),
    secret: process.env.SESSION_SECRET || 'aec-eams-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true, // idle timeout: each request refreshes the countdown
    cookie: { maxAge: 1000 * 60 * 60 * 2 } // 2 hour idle session timeout
  })
);

// Front-end pages/assets are whitelisted explicitly (rather than a blanket
// static folder) so the source code is never served. Asset photos are
// stored as data URLs inside the database (see scan-routes.js), so there's
// no /uploads route.
const publicFiles = {
  '/index.html': 'index.html',
  '/login.html': 'login.html',
  '/scan.html': 'scan.html',
  '/admin.html': 'admin.html',
  '/manifest.json': 'manifest.json',
  '/service-worker.js': 'service-worker.js',
  '/icon.svg': 'icon.svg'
};

// "/" is the AEC Group portal: if you're already logged in it sends you
// straight to your dashboard, otherwise it shows the landing page with the
// business-vertical cards.
app.get('/', (req, res) => {
  if (req.session.user) {
    const role = req.session.user.role;
    return res.redirect(role === 'employee' ? '/scan.html' : '/admin.html');
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});

Object.entries(publicFiles).forEach(([route, file]) => {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
});

// Business vertical logos are static branding assets checked into the repo
// (not user-uploaded content), so they're served directly - no database
// storage needed, and unlike product photos they don't need to survive an
// ephemeral disk since they're redeployed with the code every time.
app.use('/logos', express.static(path.join(__dirname, 'logos')));

// General abuse-throttling on the whole API (login gets its own tighter
// limiter inside auth-routes.js), then CSRF verification on every
// state-changing request from an already-logged-in session. requireCsrf is
// mounted with no path prefix (rather than under '/api') so req.path
// inside it is still the full original path like '/api/auth/login' -
// that's what its EXEMPT_PATHS check compares against.
// Machine-to-machine pushes from the independent Bill Scanner app. Mounted
// before the interactive rate limiter (it has its own, looser one) and
// authenticated by API key rather than a login session.
app.use('/api/integrations', require('./integration-routes'));

app.use('/api', generalLimiter);
app.use(requireCsrf);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/scans', scanRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/verticals', verticalRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/bills', billRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error', detail: err.message });
});

initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('=================================================');
      console.log('  AEC Group Enterprise Asset Management System');
      console.log('=================================================');
      console.log(`  On this computer:  http://localhost:${PORT}`);
      console.log(`  On your phone:     http://<this-computer-IP>:${PORT}`);
      console.log('  Database: connected to Postgres (DATABASE_URL)');
      console.log('=================================================');
      console.log('');
      // Move photos still stored in the database over to SharePoint, in the
      // background (no-op unless SharePoint is configured). See photo-store.js.
      setTimeout(() => require('./photo-store').migrateExistingPhotos(), 15000);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to the database. Check your DATABASE_URL.');
    console.error(err);
    process.exit(1);
  });
