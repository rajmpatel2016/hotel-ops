const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');

const db = require('./db');
const auth = require('./auth');
const util = require('./util');

const app = express();
const PROD = process.env.NODE_ENV === 'production';

if (PROD && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Set it to a long random value and start again.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '1h' : 0 }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use(
  cookieSession({
    name: 'hotelops',
    keys: [process.env.SESSION_SECRET || 'dev-only-secret'],
    maxAge: 14 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: PROD,
  })
);

// Helpers available in every page.
app.use((req, res, next) => {
  res.locals.util = util;
  res.locals.can = (what) => auth.can(req.user, what);
  res.locals.roleLabels = auth.ROLE_LABELS;
  res.locals.path = req.path;
  res.locals.property = null;
  res.locals.flagCount = 0;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  next();
});

app.use(auth.loadUser);
app.use(auth.csrfGuard);

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(require('./routes/core'));
app.use(require('./routes/board'));
app.use(require('./routes/maintenance'));
app.use(require('./routes/staff'));
app.use(require('./routes/schedule'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  const wantsJson = (req.get('accept') || '').includes('application/json');
  if (wantsJson) return res.status(500).json({ ok: false, error: 'Something went wrong. Reload and try again.' });
  res.status(500).render('error', { title: 'Something went wrong', message: 'The change was not saved. Go back and try again.' });
});

async function start() {
  await db.migrate();
  await require('./setup').firstRunSetup();
  await auth.bootstrapAdmin();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Hotel Ops listening on port ${port}`));
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
