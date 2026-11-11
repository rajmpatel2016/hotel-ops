const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const ROLE_LABELS = {
  admin: 'Corporate admin',
  gm: 'General manager',
  housekeeping: 'Housekeeping manager',
  maintenance: 'Maintenance',
};

// What each role may do. Admin and GM can do everything at a hotel.
const CAN = {
  board: ['admin', 'gm', 'housekeeping'],
  staff: ['admin', 'gm', 'housekeeping'],
  schedule: ['admin', 'gm', 'housekeeping'],
  staffImport: ['admin', 'gm'],
  rooms: ['admin', 'gm'],
  maintView: ['admin', 'gm', 'housekeeping', 'maintenance'],
  maintWork: ['admin', 'gm', 'maintenance'],
  gmQueue: ['admin', 'gm'],
};

const can = (user, what) => !!user && (CAN[what] || []).includes(user.role);

async function hashPassword(pw) {
  return bcrypt.hash(pw, 12);
}

async function checkPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

// Loads the signed-in user on every request and sets up the form-protection token.
async function loadUser(req, res, next) {
  res.locals.user = null;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.session.uid) {
    const user = await db.one(
      `SELECT u.id, u.name, u.email, u.role, u.property_id, p.name AS property_name
         FROM users u LEFT JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1 AND u.active`,
      [req.session.uid]
    );
    if (user) {
      req.user = user;
      res.locals.user = user;
    } else {
      req.session.uid = null;
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only corporate admins can open this page.' });
  next();
}

// Every hotel page goes through here. A user tied to one hotel can never load another's.
async function loadProperty(req, res, next) {
  const pid = Number(req.params.pid);
  if (!Number.isInteger(pid)) return res.status(404).render('error', { title: 'Not found', message: 'That hotel does not exist.' });
  if (req.user.role !== 'admin' && req.user.property_id !== pid) {
    return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to that hotel.' });
  }
  const property = await db.one('SELECT * FROM properties WHERE id = $1', [pid]);
  if (!property) return res.status(404).render('error', { title: 'Not found', message: 'That hotel does not exist.' });
  req.property = property;
  res.locals.property = property;
  res.locals.flagCount = 0;
  if (can(req.user, 'gmQueue')) {
    const row = await db.one(
      `SELECT count(*)::int AS n FROM maintenance_requests WHERE property_id=$1 AND status='cannot_fix' AND gm_decided_at IS NULL`,
      [pid]
    );
    res.locals.flagCount = row.n;
  }
  next();
}

const allow = (what) => (req, res, next) => {
  if (!can(req.user, what)) {
    return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not include this page.' });
  }
  next();
};

function csrfOk(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  return !!sent && !!req.session.csrf && sent === req.session.csrf;
}

// Blocks form posts that did not come from our own pages.
// File uploads are checked inside their own route, after the upload is parsed.
function csrfGuard(req, res, next) {
  if (req.method !== 'POST') return next();
  if ((req.get('content-type') || '').startsWith('multipart/form-data')) return next();
  if (!csrfOk(req)) return res.status(403).render('error', { title: 'Session expired', message: 'Go back, reload the page and try again.' });
  next();
}

// Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when no users exist yet.
async function bootstrapAdmin() {
  const row = await db.one('SELECT count(*)::int AS n FROM users');
  if (row.n > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) {
    console.warn('No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart to create the first admin.');
    return;
  }
  const problem = passwordProblem(pw);
  if (problem) {
    console.warn(`ADMIN_PASSWORD rejected: ${problem}`);
    return;
  }
  await db.query(`INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'admin')`, [
    process.env.ADMIN_NAME || 'Admin', email, await hashPassword(pw),
  ]);
  console.log(`Created first admin: ${email}`);
}

module.exports = {
  ROLE_LABELS, can, hashPassword, checkPassword, passwordProblem,
  loadUser, requireUser, requireAdmin, loadProperty, allow, csrfOk, csrfGuard, bootstrapAdmin,
};
