const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const { CATEGORIES, categorize, displayName, normName, daysSince } = require('../util');
const { parseRoster, planImport, applyImport } = require('../roster');

const router = express.Router();
const hotel = [auth.requireUser, auth.loadProperty];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

// How long a hand-added person can go without showing up on a payroll report before we flag it.
const UNMATCHED_DAYS = 14;

router.get('/p/:pid/staff', hotel, auth.allow('staff'), async (req, res) => {
  const pid = req.property.id;
  const all = await db.query('SELECT * FROM employees WHERE property_id=$1 ORDER BY name', [pid]);
  const active = all.filter((e) => !e.removed && (e.source === 'manual' || e.in_latest_report));
  const dropped = all.filter((e) => !e.removed && e.source === 'adp' && !e.in_latest_report);
  const removed = all.filter((e) => e.removed);
  for (const e of active) {
    e.unmatchedDays = e.source === 'manual' ? daysSince(e.created_at) : 0;
    e.flagUnmatched = e.source === 'manual' && e.unmatchedDays >= UNMATCHED_DAYS;
  }
  const groups = CATEGORIES.map((c) => ({ category: c, people: active.filter((e) => e.category === c) })).filter((g) => g.people.length);
  const imports = await db.query(
    `SELECT i.*, u.name AS by_name FROM roster_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.property_id=$1 ORDER BY i.imported_at DESC LIMIT 5`,
    [pid]
  );
  res.render('staff', {
    title: 'Staff', groups, dropped, removed, imports, categories: CATEGORIES,
    activeCount: active.length, unmatched: active.filter((e) => e.flagUnmatched), UNMATCHED_DAYS,
  });
});

// Add someone by hand: a new hire not in payroll yet, a temp, someone borrowed from another hotel.
router.post('/p/:pid/staff', hotel, auth.allow('staff'), async (req, res) => {
  const pid = req.property.id;
  const name = displayName(String(req.body.name || '')).slice(0, 120);
  const jobTitle = String(req.body.job_title || '').trim().slice(0, 120);
  const note = String(req.body.note || '').trim().slice(0, 300);
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : categorize('', jobTitle);
  if (!name) {
    req.flash('error', 'Enter the person\'s name.');
    return res.redirect(`/p/${pid}/staff`);
  }
  const existing = await db.query('SELECT id, name, removed FROM employees WHERE property_id=$1', [pid]);
  const dup = existing.find((e) => normName(e.name) === normName(name));
  if (dup) {
    req.flash('error', dup.removed
      ? `${dup.name} is on the removed list. Restore them instead of adding again.`
      : `${dup.name} is already on the staff list.`);
    return res.redirect(`/p/${pid}/staff`);
  }
  await db.query(
    `INSERT INTO employees (property_id, name, job_title, category, category_locked, source, note)
     VALUES ($1,$2,$3,$4,TRUE,'manual',$5)`,
    [pid, name, jobTitle, category, note]
  );
  req.flash('ok', `${name} added to ${category}.`);
  res.redirect(`/p/${pid}/staff`);
});

router.post('/p/:pid/staff/:id', hotel, auth.allow('staff'), async (req, res) => {
  const pid = req.property.id;
  const id = Number(req.params.id);
  const emp = await db.one('SELECT id, name FROM employees WHERE id=$1 AND property_id=$2', [id, pid]);
  if (!emp) {
    req.flash('error', 'That person is not on this hotel\'s staff list.');
    return res.redirect(`/p/${pid}/staff`);
  }
  const action = req.body.action;
  if (action === 'remove') {
    // Hidden from schedules and assignment lists. Past assignments stay on record.
    await db.query('UPDATE employees SET removed=TRUE, removed_at=now() WHERE id=$1', [id]);
    req.flash('ok', `${emp.name} removed. Their history is kept, and you can restore them below.`);
  } else if (action === 'restore') {
    await db.query('UPDATE employees SET removed=FALSE, removed_at=NULL WHERE id=$1', [id]);
    req.flash('ok', `${emp.name} restored.`);
  } else if (action === 'category' && CATEGORIES.includes(req.body.category)) {
    // Set by hand, so later payroll reports will not change it back.
    await db.query('UPDATE employees SET category=$2, category_locked=TRUE WHERE id=$1', [id, req.body.category]);
    req.flash('ok', `${emp.name} moved to ${req.body.category}.`);
  }
  res.redirect(`/p/${pid}/staff`);
});

router.post('/p/:pid/staff-import', hotel, auth.allow('staffImport'), (req, res, next) => {
  upload.single('roster')(req, res, async (err) => {
    try {
      const pid = req.property.id;
      const back = `/p/${pid}/staff`;
      if (err) {
        req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 2 MB. Export just the employee roster.' : 'The upload failed. Try again.');
        return res.redirect(back);
      }
      if (!auth.csrfOk(req)) {
        return res.status(403).render('error', { title: 'Session expired', message: 'Go back, reload the page and try again.' });
      }
      if (!req.file) {
        req.flash('error', 'Choose the roster file first.');
        return res.redirect(back);
      }
      let rows;
      try {
        rows = parseRoster(req.file.buffer);
      } catch (e) {
        req.flash('error', e.message);
        return res.redirect(back);
      }
      const counts = await db.tx(async (q) => {
        const existing = await q('SELECT * FROM employees WHERE property_id=$1', [pid]);
        const plan = planImport(existing, rows);
        await applyImport(q, pid, plan);
        await q(
          `INSERT INTO roster_imports (property_id, filename, imported_by, rows_read, added, updated, matched, dropped)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [pid, String(req.file.originalname || '').slice(0, 200), req.user.id, rows.length,
            plan.counts.added, plan.counts.updated, plan.counts.matched, plan.counts.dropped]
        );
        return plan.counts;
      });
      const bits = [`Read ${rows.length} employees.`, `${counts.added} added`, `${counts.updated} updated`];
      if (counts.matched) bits.push(`${counts.matched} hand-added matched to payroll`);
      if (counts.dropped) bits.push(`${counts.dropped} no longer on the report`);
      req.flash('ok', `${bits[0]} ${bits.slice(1).join(', ')}.`);
      res.redirect(back);
    } catch (e) {
      next(e);
    }
  });
});

module.exports = router;
