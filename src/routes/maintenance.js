const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { todayIn, roomSort, MAINT_STATUSES } = require('../util');

const router = express.Router();
const hotel = [auth.requireUser, auth.loadProperty];

const VIEWS = {
  active: { label: 'Open', where: `m.status IN ('open','in_progress')` },
  flagged: { label: 'Cannot fix', where: `m.status = 'cannot_fix'` },
  done: { label: 'Fixed and closed', where: `m.status IN ('fixed','closed')` },
  all: { label: 'All', where: 'TRUE' },
};

async function getRequest(pid, id) {
  return db.one(
    `SELECT m.*, r.number AS room, u.name AS reporter
       FROM maintenance_requests m
       LEFT JOIN rooms r ON r.id = m.room_id
       LEFT JOIN users u ON u.id = m.reported_by
      WHERE m.id = $1 AND m.property_id = $2`,
    [id, pid]
  );
}

const addNote = (q, requestId, userId, body) =>
  q('INSERT INTO maintenance_notes (request_id, user_id, body) VALUES ($1,$2,$3)', [requestId, userId, body]);

// ---- Log ----

router.get('/p/:pid/maintenance', hotel, auth.allow('maintView'), async (req, res) => {
  const pid = req.property.id;
  const show = VIEWS[req.query.show] ? req.query.show : 'active';
  const requests = await db.query(
    `SELECT m.id, m.description, m.status, m.priority, m.location, m.created_at, m.updated_at, m.room_out_of_order,
            m.gm_decided_at, r.number AS room, u.name AS reporter
       FROM maintenance_requests m
       LEFT JOIN rooms r ON r.id = m.room_id
       LEFT JOIN users u ON u.id = m.reported_by
      WHERE m.property_id = $1 AND ${VIEWS[show].where}
      ORDER BY (m.priority='urgent' AND m.status IN ('open','in_progress')) DESC, m.created_at DESC
      LIMIT 300`,
    [pid]
  );
  const counts = await db.one(
    `SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS active,
            count(*) FILTER (WHERE status='cannot_fix')::int AS flagged,
            count(*) FILTER (WHERE status IN ('fixed','closed'))::int AS done,
            count(*)::int AS all
       FROM maintenance_requests WHERE property_id=$1`,
    [pid]
  );
  res.render('maintenance', { title: 'Maintenance', show, views: VIEWS, requests, counts, statuses: MAINT_STATUSES });
});

router.get('/p/:pid/maintenance/new', hotel, auth.allow('maintView'), async (req, res) => {
  const rooms = await db.query('SELECT id, number FROM rooms WHERE property_id=$1 AND active', [req.property.id]);
  rooms.sort((a, b) => roomSort(a.number, b.number));
  res.render('maintenance_new', { title: 'New maintenance request', rooms, roomId: Number(req.query.room) || null });
});

router.post('/p/:pid/maintenance', hotel, auth.allow('maintView'), async (req, res) => {
  const pid = req.property.id;
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const location = String(req.body.location || '').trim().slice(0, 120);
  const priority = ['low', 'normal', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal';
  let roomId = Number(req.body.room_id) || null;
  const ooo = req.body.room_out_of_order === 'on';
  if (!description) {
    req.flash('error', 'Describe the problem.');
    return res.redirect(`/p/${pid}/maintenance/new`);
  }
  if (roomId) {
    const room = await db.one('SELECT id FROM rooms WHERE id=$1 AND property_id=$2', [roomId, pid]);
    if (!room) roomId = null;
  }
  if (!roomId && !location) {
    req.flash('error', 'Pick a room or say where the problem is.');
    return res.redirect(`/p/${pid}/maintenance/new`);
  }
  const day = todayIn(req.property.timezone);
  const created = await db.tx(async (q) => {
    const rows = await q(
      `INSERT INTO maintenance_requests (property_id, room_id, location, description, priority, room_out_of_order, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [pid, roomId, location, description, priority, ooo && !!roomId, req.user.id]
    );
    if (ooo && roomId) {
      // Take the room off today's housekeeping board.
      await q(
        `INSERT INTO room_days (property_id, room_id, day, status) VALUES ($1,$2,$3,'ooo')
         ON CONFLICT (room_id, day) DO UPDATE SET status='ooo', employee_id=NULL, done=FALSE, updated_at=now()`,
        [pid, roomId, day]
      );
    }
    return rows[0];
  });
  req.flash('ok', `Request #${created.id} logged.${ooo && roomId ? ' The room is marked out of order on today\'s board.' : ''}`);
  res.redirect(`/p/${pid}/maintenance`);
});

router.get('/p/:pid/maintenance/:id', hotel, auth.allow('maintView'), async (req, res) => {
  const request = await getRequest(req.property.id, Number(req.params.id));
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That request does not exist at this hotel.' });
  const notes = await db.query(
    `SELECT n.body, n.created_at, u.name FROM maintenance_notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.request_id = $1 ORDER BY n.created_at`,
    [request.id]
  );
  res.render('maintenance_detail', { title: `Request #${request.id}`, request, notes, statuses: MAINT_STATUSES });
});

router.post('/p/:pid/maintenance/:id/note', hotel, auth.allow('maintView'), async (req, res) => {
  const pid = req.property.id;
  const request = await getRequest(pid, Number(req.params.id));
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That request does not exist at this hotel.' });
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (body) {
    await db.tx(async (q) => {
      await addNote(q, request.id, req.user.id, body);
      await q('UPDATE maintenance_requests SET updated_at=now() WHERE id=$1', [request.id]);
    });
  }
  res.redirect(`/p/${pid}/maintenance/${request.id}`);
});

// Maintenance moves a request along: start, fixed, or cannot fix (which sends it to the GM).
router.post('/p/:pid/maintenance/:id/status', hotel, auth.allow('maintWork'), async (req, res) => {
  const pid = req.property.id;
  const request = await getRequest(pid, Number(req.params.id));
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That request does not exist at this hotel.' });
  const action = req.body.action;
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  const back = `/p/${pid}/maintenance/${request.id}`;

  if (action === 'cannot_fix') {
    if (!reason) {
      req.flash('error', 'Say why it cannot be fixed. The GM needs this to decide what to do.');
      return res.redirect(back);
    }
    await db.tx(async (q) => {
      await q(
        `UPDATE maintenance_requests SET status='cannot_fix', flagged_at=now(), flag_reason=$2,
                gm_decided_at=NULL, gm_decision='', updated_at=now() WHERE id=$1`,
        [request.id, reason]
      );
      await addNote(q, request.id, req.user.id, `Cannot fix, sent to the GM: ${reason}`);
    });
    req.flash('ok', 'Sent to the GM.');
    return res.redirect(back);
  }

  const moves = {
    start: { status: 'in_progress', note: 'Started work.' },
    fixed: { status: 'fixed', note: reason ? `Fixed: ${reason}` : 'Marked fixed.' },
    reopen: { status: 'open', note: reason ? `Reopened: ${reason}` : 'Reopened.' },
  };
  const move = moves[action];
  if (!move) return res.redirect(back);
  await db.tx(async (q) => {
    await q(
      `UPDATE maintenance_requests SET status=$2, updated_at=now(),
              resolved_at = CASE WHEN $2='fixed' THEN now() ELSE NULL END WHERE id=$1`,
      [request.id, move.status]
    );
    await addNote(q, request.id, req.user.id, move.note);
  });
  res.redirect(back);
});

// ---- GM queue: everything maintenance could not fix ----

router.get('/p/:pid/gm', hotel, auth.allow('gmQueue'), async (req, res) => {
  const pid = req.property.id;
  const base = `SELECT m.*, r.number AS room, u.name AS reporter
                  FROM maintenance_requests m
                  LEFT JOIN rooms r ON r.id = m.room_id
                  LEFT JOIN users u ON u.id = m.reported_by
                 WHERE m.property_id = $1 AND m.status = 'cannot_fix'`;
  const waiting = await db.query(`${base} AND m.gm_decided_at IS NULL ORDER BY (m.priority='urgent') DESC, m.flagged_at`, [pid]);
  const vendor = await db.query(`${base} AND m.gm_decided_at IS NOT NULL ORDER BY m.gm_decided_at DESC`, [pid]);
  res.render('gm', { title: 'Needs GM', waiting, vendor });
});

router.post('/p/:pid/gm/:id', hotel, auth.allow('gmQueue'), async (req, res) => {
  const pid = req.property.id;
  const request = await getRequest(pid, Number(req.params.id));
  if (!request || request.status !== 'cannot_fix') {
    req.flash('error', 'That request is no longer waiting on a decision.');
    return res.redirect(`/p/${pid}/gm`);
  }
  const note = String(req.body.note || '').trim().slice(0, 2000);
  const decision = req.body.decision;
  const options = {
    vendor: { status: 'cannot_fix', label: 'Outside vendor needed' },
    reopen: { status: 'open', label: 'Sent back to maintenance' },
    close: { status: 'closed', label: 'Closed without repair' },
    fixed: { status: 'fixed', label: 'Repair completed' },
  };
  const opt = options[decision];
  if (!opt) return res.redirect(`/p/${pid}/gm`);
  if (!note && decision !== 'fixed') {
    req.flash('error', 'Add a short note so the team knows what was decided.');
    return res.redirect(`/p/${pid}/gm`);
  }
  const text = note ? `${opt.label}: ${note}` : opt.label;
  await db.tx(async (q) => {
    await q(
      `UPDATE maintenance_requests SET status=$2, gm_decided_at=now(), gm_decision=$3, updated_at=now(),
              resolved_at = CASE WHEN $2 IN ('fixed','closed') THEN now() ELSE NULL END WHERE id=$1`,
      [request.id, opt.status, text]
    );
    await addNote(q, request.id, req.user.id, `GM decision. ${text}`);
  });
  req.flash('ok', `Request #${request.id}: ${opt.label.toLowerCase()}.`);
  res.redirect(`/p/${pid}/gm`);
});

module.exports = router;
