const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { todayIn, isDate, roomSort, parseRoomList, ROOM_STATUSES } = require('../util');

const router = express.Router();
const hotel = [auth.requireUser, auth.loadProperty];

const STATUS_KEYS = ROOM_STATUSES.map((s) => s.key);
// How much work each kind of room counts for when balancing loads.
const CREDITS = { checkout: 1, stayover: 0.5 };

const pickDay = (req) => (isDate(req.query.day) ? req.query.day : isDate(req.body && req.body.day) ? req.body.day : todayIn(req.property.timezone));

const floorOf = (number) => {
  const digits = String(number).replace(/\D/g, '');
  return digits.length >= 3 ? digits.slice(0, -2) : '';
};

async function loadBoard(pid, day) {
  const rooms = await db.query(
    `SELECT r.id, r.number, r.floor, r.room_type,
            COALESCE(d.status, 'vacant') AS status, d.employee_id, COALESCE(d.note, '') AS note, COALESCE(d.done, FALSE) AS done
       FROM rooms r LEFT JOIN room_days d ON d.room_id = r.id AND d.day = $2
      WHERE r.property_id = $1 AND r.active`,
    [pid, day]
  );
  rooms.sort((a, b) => roomSort(a.number, b.number));
  const assignedIds = [...new Set(rooms.map((r) => r.employee_id).filter(Boolean))];
  // Housekeepers who can be assigned: current housekeeping staff, plus anyone already on today's board.
  const housekeepers = await db.query(
    `SELECT id, name, removed, (source='manual' OR in_latest_report) AS current
       FROM employees
      WHERE property_id = $1
        AND ((category = 'Housekeeping' AND NOT removed AND (source='manual' OR in_latest_report)) OR id = ANY($2::int[]))
      ORDER BY name`,
    [pid, assignedIds]
  );
  return { rooms, housekeepers };
}

async function saveRoomDay(q, pid, roomId, day, patch) {
  const cur = (await q('SELECT status, employee_id, note, done FROM room_days WHERE room_id=$1 AND day=$2', [roomId, day]))[0]
    || { status: 'vacant', employee_id: null, note: '', done: false };
  const next = { ...cur, ...patch };
  // Only rooms that need cleaning keep a housekeeper.
  if (next.status !== 'checkout' && next.status !== 'stayover') { next.employee_id = null; next.done = false; }
  await q(
    `INSERT INTO room_days (property_id, room_id, day, status, employee_id, note, done)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (room_id, day) DO UPDATE
       SET status=EXCLUDED.status, employee_id=EXCLUDED.employee_id, note=EXCLUDED.note, done=EXCLUDED.done, updated_at=now()`,
    [pid, roomId, day, next.status, next.employee_id, next.note, next.done]
  );
  return next;
}

// ---- Hotel home: today at a glance ----

router.get('/p/:pid', hotel, async (req, res) => {
  const pid = req.property.id;
  const day = todayIn(req.property.timezone);
  const s = await db.one(
    `SELECT
       (SELECT count(*)::int FROM rooms WHERE property_id=$1 AND active) AS rooms,
       (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status='checkout') AS checkouts,
       (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status='stayover') AS stayovers,
       (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status='ooo') AS ooo,
       (SELECT count(*)::int FROM room_days WHERE property_id=$1 AND day=$2 AND status IN ('checkout','stayover') AND employee_id IS NULL) AS unassigned,
       (SELECT count(*)::int FROM maintenance_requests WHERE property_id=$1 AND status IN ('open','in_progress')) AS open_maint,
       (SELECT count(*)::int FROM maintenance_requests WHERE property_id=$1 AND status='open' AND priority='urgent') AS urgent,
       (SELECT count(*)::int FROM employees WHERE property_id=$1 AND NOT removed AND (source='manual' OR in_latest_report)) AS staff`,
    [pid, day]
  );
  const recent = await db.query(
    `SELECT m.id, m.description, m.status, m.priority, m.location, m.created_at, r.number AS room
       FROM maintenance_requests m LEFT JOIN rooms r ON r.id = m.room_id
      WHERE m.property_id=$1 AND m.status IN ('open','in_progress','cannot_fix')
      ORDER BY (m.status='cannot_fix') DESC, (m.priority='urgent') DESC, m.created_at DESC LIMIT 8`,
    [pid]
  );
  res.render('property', { title: req.property.name, day, s, recent });
});

// ---- Housekeeping board ----

router.get('/p/:pid/board', hotel, auth.allow('board'), async (req, res) => {
  const day = pickDay(req);
  const { rooms, housekeepers } = await loadBoard(req.property.id, day);
  // Who the schedule says is working today, so the split starts with the right people ticked.
  const shifts = await db.query(
    `SELECT employee_id, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM shifts WHERE property_id = $1 AND day = $2`,
    [req.property.id, day]
  );
  const scheduled = new Map(shifts.map((s) => [s.employee_id, s]));
  res.render('board', { title: 'Housekeeping board', day, rooms, housekeepers, scheduled, statuses: ROOM_STATUSES, credits: CREDITS });
});

// One room changed (status, housekeeper or note). Called by the board as you click.
router.post('/p/:pid/board/room', hotel, auth.allow('board'), async (req, res) => {
  const pid = req.property.id;
  const day = req.body.day;
  const roomId = Number(req.body.room_id);
  if (!isDate(day) || !Number.isInteger(roomId)) return res.status(400).json({ ok: false, error: 'Bad request.' });
  const room = await db.one('SELECT id FROM rooms WHERE id=$1 AND property_id=$2 AND active', [roomId, pid]);
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found at this hotel.' });

  const patch = {};
  if (req.body.status !== undefined) {
    if (!STATUS_KEYS.includes(req.body.status)) return res.status(400).json({ ok: false, error: 'Unknown status.' });
    patch.status = req.body.status;
  }
  if (req.body.employee_id !== undefined) {
    const eid = req.body.employee_id === null || req.body.employee_id === '' ? null : Number(req.body.employee_id);
    if (eid !== null) {
      const emp = await db.one('SELECT id FROM employees WHERE id=$1 AND property_id=$2', [eid, pid]);
      if (!emp) return res.status(404).json({ ok: false, error: 'That person is not on this hotel\'s staff list.' });
    }
    patch.employee_id = eid;
  }
  if (req.body.note !== undefined) patch.note = String(req.body.note).slice(0, 300);
  if (req.body.done !== undefined) patch.done = !!req.body.done;

  const saved = await db.tx((q) => saveRoomDay(q, pid, roomId, day, patch));
  res.json({ ok: true, room: saved });
});

// Paste the checkout and stayover room numbers from the PMS report.
router.post('/p/:pid/board/paste', hotel, auth.allow('board'), async (req, res) => {
  const pid = req.property.id;
  const day = pickDay(req);
  const checkouts = parseRoomList(req.body.checkouts);
  const stayovers = parseRoomList(req.body.stayovers);
  const reset = req.body.reset === 'on';
  if (!checkouts.length && !stayovers.length) {
    req.flash('error', 'Paste at least one room number.');
    return res.redirect(`/p/${pid}/board?day=${day}`);
  }
  const rooms = await db.query('SELECT id, number FROM rooms WHERE property_id=$1 AND active', [pid]);
  const byNumber = new Map(rooms.map((r) => [r.number.toLowerCase(), r.id]));
  const want = new Map();
  const unknown = [];
  const both = [];
  for (const n of checkouts) {
    const id = byNumber.get(n.toLowerCase());
    if (id) want.set(id, 'checkout'); else unknown.push(n);
  }
  for (const n of stayovers) {
    const id = byNumber.get(n.toLowerCase());
    if (!id) { unknown.push(n); continue; }
    if (want.get(id) === 'checkout') both.push(n); else want.set(id, 'stayover');
  }
  await db.tx(async (q) => {
    for (const [roomId, status] of want) await saveRoomDay(q, pid, roomId, day, { status });
    if (reset) {
      // Everything not in the lists becomes vacant, except rooms marked out of order.
      const cur = await q(`SELECT room_id, status FROM room_days WHERE property_id=$1 AND day=$2`, [pid, day]);
      for (const c of cur) {
        if (!want.has(c.room_id) && (c.status === 'checkout' || c.status === 'stayover')) {
          await saveRoomDay(q, pid, c.room_id, day, { status: 'vacant' });
        }
      }
    }
  });
  const parts = [`Set ${[...want.values()].filter((s) => s === 'checkout').length} checkouts and ${[...want.values()].filter((s) => s === 'stayover').length} stayovers.`];
  if (unknown.length) parts.push(`Not on the room list, skipped: ${[...new Set(unknown)].join(', ')}.`);
  if (both.length) parts.push(`In both lists, kept as checkout: ${both.join(', ')}.`);
  req.flash(unknown.length ? 'warn' : 'ok', parts.join(' '));
  res.redirect(`/p/${pid}/board?day=${day}`);
});

// Split rooms across the housekeepers working today, in room order so each gets a section.
router.post('/p/:pid/board/auto', hotel, auth.allow('board'), async (req, res) => {
  const pid = req.property.id;
  const day = pickDay(req);
  const ids = [].concat(req.body.employee_ids || []).map(Number).filter(Number.isInteger);
  const redo = req.body.scope === 'all';
  if (!ids.length) {
    req.flash('error', 'Tick the housekeepers who are working, then assign.');
    return res.redirect(`/p/${pid}/board?day=${day}`);
  }
  const staff = await db.query('SELECT id FROM employees WHERE property_id=$1 AND id = ANY($2::int[]) ORDER BY name', [pid, ids]);
  if (!staff.length) {
    req.flash('error', 'Those people are not on this hotel\'s staff list.');
    return res.redirect(`/p/${pid}/board?day=${day}`);
  }
  const { rooms } = await loadBoard(pid, day);
  const service = rooms.filter((r) => CREDITS[r.status]);
  const load = new Map(staff.map((s) => [s.id, 0]));
  const todo = [];
  for (const r of service) {
    if (!redo && r.employee_id) {
      if (load.has(r.employee_id)) load.set(r.employee_id, load.get(r.employee_id) + CREDITS[r.status]);
    } else {
      todo.push(r);
    }
  }
  if (!todo.length) {
    req.flash('ok', 'Every checkout and stayover already has a housekeeper.');
    return res.redirect(`/p/${pid}/board?day=${day}`);
  }
  const total = [...load.values()].reduce((a, b) => a + b, 0) + todo.reduce((a, r) => a + CREDITS[r.status], 0);
  const target = total / staff.length;
  const order = staff.map((s) => s.id);
  let i = 0;
  const picks = [];
  for (const r of todo) {
    const c = CREDITS[r.status];
    // Move to the next person once this one has a full share.
    while (i < order.length - 1 && load.get(order[i]) + c / 2 > target) i++;
    let who = order[i];
    if (load.get(who) + c / 2 > target) {
      // Everyone has a share: give the remainder to whoever has least.
      who = order.reduce((best, id) => (load.get(id) < load.get(best) ? id : best), order[0]);
    }
    load.set(who, load.get(who) + c);
    picks.push([r.id, who]);
  }
  await db.tx(async (q) => {
    for (const [roomId, who] of picks) await saveRoomDay(q, pid, roomId, day, { employee_id: who });
  });
  req.flash('ok', `Assigned ${picks.length} rooms across ${staff.length} housekeepers.`);
  res.redirect(`/p/${pid}/board?day=${day}`);
});

router.post('/p/:pid/board/clear', hotel, auth.allow('board'), async (req, res) => {
  const pid = req.property.id;
  const day = pickDay(req);
  await db.query(`UPDATE room_days SET employee_id=NULL, done=FALSE, updated_at=now() WHERE property_id=$1 AND day=$2`, [pid, day]);
  req.flash('ok', 'Assignments cleared. Room statuses were kept.');
  res.redirect(`/p/${pid}/board?day=${day}`);
});

// ---- Printable room sheets ----

router.get('/p/:pid/sheets', hotel, auth.allow('board'), async (req, res) => {
  const day = pickDay(req);
  const show = ['checkout', 'stayover'].includes(req.query.show) ? req.query.show : 'all';
  const { rooms, housekeepers } = await loadBoard(req.property.id, day);
  const service = rooms.filter((r) => (show === 'all' ? CREDITS[r.status] : r.status === show));
  const names = new Map(housekeepers.map((h) => [h.id, h.name]));
  const sheets = [];
  for (const h of housekeepers) {
    const mine = service.filter((r) => r.employee_id === h.id);
    if (mine.length) sheets.push({ name: h.name, rooms: mine });
  }
  const unassigned = service.filter((r) => !r.employee_id || !names.has(r.employee_id));
  res.render('sheets', { title: 'Room sheets', day, show, sheets, unassigned });
});

// ---- Room list setup ----

router.get('/p/:pid/rooms', hotel, auth.allow('rooms'), async (req, res) => {
  const rooms = await db.query('SELECT * FROM rooms WHERE property_id=$1', [req.property.id]);
  rooms.sort((a, b) => roomSort(a.number, b.number));
  res.render('rooms', { title: 'Rooms', rooms });
});

async function addRooms(pid, list) {
  let added = 0;
  let existing = 0;
  await db.tx(async (q) => {
    for (const r of list) {
      const rows = await q(
        `INSERT INTO rooms (property_id, number, floor, room_type) VALUES ($1,$2,$3,$4)
         ON CONFLICT (property_id, number) DO NOTHING RETURNING id`,
        [pid, r.number, floorOf(r.number), r.type || '']
      );
      if (rows.length) added++; else existing++;
    }
  });
  return { added, existing };
}

router.post('/p/:pid/rooms/range', hotel, auth.allow('rooms'), async (req, res) => {
  const pid = req.property.id;
  const from = parseInt(req.body.from, 10);
  const to = parseInt(req.body.to, 10);
  const type = String(req.body.type || '').trim().slice(0, 40);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || to - from > 400) {
    req.flash('error', 'Enter a first and last room number, for example 101 to 124.');
    return res.redirect(`/p/${pid}/rooms`);
  }
  const list = [];
  for (let n = from; n <= to; n++) list.push({ number: String(n), type });
  const out = await addRooms(pid, list);
  req.flash('ok', `Added ${out.added} rooms.${out.existing ? ` ${out.existing} were already on the list.` : ''}`);
  res.redirect(`/p/${pid}/rooms`);
});

// One room per line: "101" or "101, King" or "101 King Suite".
router.post('/p/:pid/rooms/paste', hotel, auth.allow('rooms'), async (req, res) => {
  const pid = req.property.id;
  const list = [];
  for (const line of String(req.body.text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^#?([A-Za-z0-9-]+)[\s,;\t]*(.*)$/);
    if (!m || !/\d/.test(m[1])) continue;
    list.push({ number: m[1], type: m[2].replace(/^[,;\s]+/, '').trim().slice(0, 40) });
  }
  if (!list.length) {
    req.flash('error', 'No room numbers found. Put one room per line, for example "101, King".');
    return res.redirect(`/p/${pid}/rooms`);
  }
  if (list.length > 1000) {
    req.flash('error', 'That is more than 1,000 rooms. Paste a smaller list.');
    return res.redirect(`/p/${pid}/rooms`);
  }
  const out = await addRooms(pid, list);
  req.flash('ok', `Added ${out.added} rooms.${out.existing ? ` ${out.existing} were already on the list.` : ''}`);
  res.redirect(`/p/${pid}/rooms`);
});

router.post('/p/:pid/rooms/:id', hotel, auth.allow('rooms'), async (req, res) => {
  const pid = req.property.id;
  const id = Number(req.params.id);
  if (req.body.action === 'toggle') {
    await db.query('UPDATE rooms SET active = NOT active WHERE id=$1 AND property_id=$2', [id, pid]);
  } else {
    await db.query('UPDATE rooms SET room_type=$3 WHERE id=$1 AND property_id=$2', [id, pid, String(req.body.room_type || '').trim().slice(0, 40)]);
  }
  res.redirect(`/p/${pid}/rooms`);
});

module.exports = router;
