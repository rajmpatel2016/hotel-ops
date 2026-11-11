const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { CATEGORIES, todayIn, isDate, addDays, weekStartOf, shiftMinutes } = require('../util');

const router = express.Router();
const hotel = [auth.requireUser, auth.loadProperty];

const OVERTIME_MINUTES = 40 * 60;
const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

// A housekeeping manager schedules housekeeping only. GMs and admins schedule everyone.
const categoriesFor = (user) => (user.role === 'housekeeping' ? ['Housekeeping'] : CATEGORIES);

const pickWeek = (req) => {
  const day = isDate(req.query.week) ? req.query.week : isDate(req.body && req.body.week) ? req.body.week : todayIn(req.property.timezone);
  return weekStartOf(day, req.property.week_start);
};

router.get('/p/:pid/schedule', hotel, auth.allow('schedule'), async (req, res) => {
  const pid = req.property.id;
  const week = pickWeek(req);
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(week, n));
  const cats = categoriesFor(req.user);

  const shifts = await db.query(
    `SELECT s.employee_id, s.day, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time,
            s.break_minutes, s.note
       FROM shifts s WHERE s.property_id = $1 AND s.day BETWEEN $2 AND $3`,
    [pid, days[0], days[6]]
  );
  const withShifts = [...new Set(shifts.map((s) => s.employee_id))];
  // Current staff, plus anyone who already has a shift this week (so removing someone never hides their shifts).
  const people = await db.query(
    `SELECT id, name, job_title, category, removed, (source='manual' OR in_latest_report) AS current
       FROM employees
      WHERE property_id = $1 AND category = ANY($2::text[])
        AND ((NOT removed AND (source='manual' OR in_latest_report)) OR id = ANY($3::int[]))
      ORDER BY name`,
    [pid, cats, withShifts]
  );
  const byKey = new Map(shifts.map((s) => [`${s.employee_id}|${s.day}`, s]));
  const dayTotals = days.map(() => 0);
  let weekTotal = 0;
  let overtimeCount = 0;
  const groups = cats.map((category) => {
    const totals = days.map(() => 0);
    const rows = people.filter((p) => p.category === category).map((p) => {
      let minutes = 0;
      const cells = days.map((d, i) => {
        const s = byKey.get(`${p.id}|${d}`) || null;
        if (s) {
          s.minutes = shiftMinutes(s.start_time, s.end_time, s.break_minutes);
          minutes += s.minutes;
          totals[i] += s.minutes;
          dayTotals[i] += s.minutes;
        }
        return s;
      });
      weekTotal += minutes;
      const overtime = minutes > OVERTIME_MINUTES;
      if (overtime) overtimeCount++;
      return { ...p, cells, minutes, overtime };
    });
    return { category, rows, totals, minutes: totals.reduce((a, b) => a + b, 0) };
  }).filter((g) => g.rows.length);

  res.render('schedule', {
    title: 'Schedule', week, days, groups, dayTotals, weekTotal, overtimeCount,
    today: todayIn(req.property.timezone), thisWeek: weekStartOf(todayIn(req.property.timezone), req.property.week_start),
  });
});

// Save or clear one person's shift on one or more days of a week.
router.post('/p/:pid/schedule/shift', hotel, auth.allow('schedule'), async (req, res) => {
  const pid = req.property.id;
  const week = pickWeek(req);
  const back = `/p/${pid}/schedule?week=${week}`;
  const emp = await db.one('SELECT id, name, category FROM employees WHERE id=$1 AND property_id=$2', [Number(req.body.employee_id), pid]);
  if (!emp || !categoriesFor(req.user).includes(emp.category)) {
    req.flash('error', 'That person is not on the list you schedule.');
    return res.redirect(back);
  }
  const last = addDays(week, 6);
  const days = [...new Set([].concat(req.body.days || []))].filter((d) => isDate(d) && d >= week && d <= last);
  if (!days.length) {
    req.flash('error', 'Tick at least one day.');
    return res.redirect(back);
  }
  if (req.body.action === 'clear') {
    await db.query('DELETE FROM shifts WHERE property_id=$1 AND employee_id=$2 AND day = ANY($3::date[])', [pid, emp.id, days]);
    req.flash('ok', `Cleared ${emp.name} on ${days.length} ${days.length === 1 ? 'day' : 'days'}.`);
    return res.redirect(back);
  }
  const start = req.body.start_time;
  const end = req.body.end_time;
  const brk = Number(req.body.break_minutes);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!isTime(start) || !isTime(end)) {
    req.flash('error', 'Enter a start and an end time.');
    return res.redirect(back);
  }
  if (!Number.isInteger(brk) || brk < 0 || brk > 240) {
    req.flash('error', 'Unpaid break must be between 0 and 240 minutes.');
    return res.redirect(back);
  }
  if (shiftMinutes(start, end, 0) > 16 * 60) {
    req.flash('error', 'That shift is longer than 16 hours. Check the start and end times.');
    return res.redirect(back);
  }
  await db.tx(async (q) => {
    for (const d of days) {
      await q(
        `INSERT INTO shifts (property_id, employee_id, day, start_time, end_time, break_minutes, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id, day) DO UPDATE
           SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, break_minutes=EXCLUDED.break_minutes,
               note=EXCLUDED.note, updated_at=now()`,
        [pid, emp.id, d, start, end, brk, note]
      );
    }
  });
  req.flash('ok', `Saved ${emp.name} on ${days.length} ${days.length === 1 ? 'day' : 'days'}.`);
  res.redirect(back);
});

// Copy last week's shifts into empty slots of this week, for people still on the staff list.
router.post('/p/:pid/schedule/copy', hotel, auth.allow('schedule'), async (req, res) => {
  const pid = req.property.id;
  const week = pickWeek(req);
  const rows = await db.query(
    `INSERT INTO shifts (property_id, employee_id, day, start_time, end_time, break_minutes, note)
     SELECT s.property_id, s.employee_id, s.day + 7, s.start_time, s.end_time, s.break_minutes, s.note
       FROM shifts s JOIN employees e ON e.id = s.employee_id
      WHERE s.property_id = $1 AND s.day BETWEEN $2::date - 7 AND $2::date - 1
        AND NOT e.removed AND (e.source='manual' OR e.in_latest_report)
        AND e.category = ANY($3::text[])
     ON CONFLICT (employee_id, day) DO NOTHING
     RETURNING id`,
    [pid, week, categoriesFor(req.user)]
  );
  req.flash(rows.length ? 'ok' : 'warn', rows.length
    ? `Copied ${rows.length} shifts from last week. Shifts already entered this week were kept.`
    : 'Nothing to copy: last week has no shifts that are not already on this week.');
  res.redirect(`/p/${pid}/schedule?week=${week}`);
});

module.exports = router;
