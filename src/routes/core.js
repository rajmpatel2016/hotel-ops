const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const auth = require('../auth');
const { todayIn } = require('../util');

const router = express.Router();

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'];

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many sign-in attempts. Wait 15 minutes and try again.',
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, email: '' });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.one('SELECT id, password_hash, active FROM users WHERE email = $1', [email]);
  const ok = user && user.active && (await auth.checkPassword(password, user.password_hash));
  if (!ok) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Email or password is incorrect.', email });
  }
  req.session.uid = user.id;
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/', auth.requireUser, async (req, res) => {
  if (req.user.role !== 'admin') return res.redirect(`/p/${req.user.property_id}`);
  const properties = await db.query('SELECT * FROM properties ORDER BY name');
  const rows = [];
  for (const p of properties) {
    const day = todayIn(p.timezone);
    const s = await db.one(
      `SELECT
         (SELECT count(*)::int FROM rooms WHERE property_id=$1 AND active) AS rooms,
         (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status='checkout') AS checkouts,
         (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status='stayover') AS stayovers,
         (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status IN ('checkout','stayover') AND employee_id IS NULL) AS unassigned,
         (SELECT count(*)::int FROM maintenance_requests WHERE property_id=$1 AND status IN ('open','in_progress')) AS open_maint,
         (SELECT count(*)::int FROM maintenance_requests WHERE property_id=$1 AND status='cannot_fix' AND gm_decided_at IS NULL) AS flagged`,
      [p.id, day]
    );
    rows.push({ ...p, ...s });
  }
  res.render('home', { title: 'All hotels', rows });
});

// ---- Account ----

router.get('/account', auth.requireUser, (req, res) => {
  res.render('account', { title: 'Your account' });
});

router.post('/account/password', auth.requireUser, async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const row = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await auth.checkPassword(current, row.password_hash))) {
    req.flash('error', 'Current password is incorrect.');
    return res.redirect('/account');
  }
  const problem = auth.passwordProblem(next);
  if (problem) {
    req.flash('error', problem);
    return res.redirect('/account');
  }
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await auth.hashPassword(next)]);
  req.flash('ok', 'Password changed.');
  res.redirect('/account');
});

// ---- Corporate admin: hotels and sign-ins ----

router.get('/admin', auth.requireAdmin, async (req, res) => {
  const properties = await db.query(
    `SELECT p.*, (SELECT count(*)::int FROM rooms r WHERE r.property_id=p.id AND r.active) AS rooms,
            (SELECT count(*)::int FROM employees e WHERE e.property_id=p.id AND NOT e.removed) AS staff
       FROM properties p ORDER BY p.name`
  );
  const users = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.active, u.property_id, p.name AS property_name
       FROM users u LEFT JOIN properties p ON p.id=u.property_id ORDER BY u.active DESC, p.name NULLS FIRST, u.name`
  );
  res.render('admin', { title: 'Admin', properties, users, timezones: TIMEZONES });
});

router.post('/admin/properties', auth.requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const code = String(req.body.code || '').trim();
  const tz = TIMEZONES.includes(req.body.timezone) ? req.body.timezone : 'America/New_York';
  if (!name) {
    req.flash('error', 'Enter the hotel name.');
    return res.redirect('/admin');
  }
  const p = await db.one('INSERT INTO properties (name, code, timezone) VALUES ($1,$2,$3) RETURNING id', [name, code, tz]);
  req.flash('ok', `${name} added. Next, add its rooms.`);
  res.redirect(`/p/${p.id}/rooms`);
});

router.post('/admin/properties/:id', auth.requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const code = String(req.body.code || '').trim();
  const tz = TIMEZONES.includes(req.body.timezone) ? req.body.timezone : 'America/New_York';
  if (!name) {
    req.flash('error', 'Hotel name cannot be blank.');
    return res.redirect('/admin');
  }
  await db.query('UPDATE properties SET name=$2, code=$3, timezone=$4 WHERE id=$1', [Number(req.params.id), name, code, tz]);
  req.flash('ok', 'Hotel updated.');
  res.redirect('/admin');
});

router.post('/admin/users', auth.requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || '');
  const password = String(req.body.password || '');
  const propertyId = role === 'admin' ? null : Number(req.body.property_id) || null;
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    req.flash('error', 'Enter a name and a valid email.');
    return res.redirect('/admin');
  }
  if (!auth.ROLE_LABELS[role]) {
    req.flash('error', 'Choose a role.');
    return res.redirect('/admin');
  }
  if (role !== 'admin' && !propertyId) {
    req.flash('error', 'Choose which hotel this person works at.');
    return res.redirect('/admin');
  }
  const problem = auth.passwordProblem(password);
  if (problem) {
    req.flash('error', problem);
    return res.redirect('/admin');
  }
  if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) {
    req.flash('error', 'Someone already signs in with that email.');
    return res.redirect('/admin');
  }
  await db.query('INSERT INTO users (name, email, password_hash, role, property_id) VALUES ($1,$2,$3,$4,$5)', [
    name, email, await auth.hashPassword(password), role, propertyId,
  ]);
  req.flash('ok', `Sign-in created for ${name}. Give them the password; they can change it under Account.`);
  res.redirect('/admin');
});

router.post('/admin/users/:id/toggle', auth.requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    req.flash('error', 'You cannot turn off your own sign-in.');
    return res.redirect('/admin');
  }
  await db.query('UPDATE users SET active = NOT active WHERE id=$1', [id]);
  res.redirect('/admin');
});

router.post('/admin/users/:id/password', auth.requireAdmin, async (req, res) => {
  const password = String(req.body.password || '');
  const problem = auth.passwordProblem(password);
  if (problem) {
    req.flash('error', problem);
    return res.redirect('/admin');
  }
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [Number(req.params.id), await auth.hashPassword(password)]);
  req.flash('ok', 'Password reset.');
  res.redirect('/admin');
});

module.exports = router;
