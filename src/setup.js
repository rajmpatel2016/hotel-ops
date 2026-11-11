// Start-up setup from data/setup.json.
//   - If the database has no hotels, the hotels listed there are created.
//   - On every start, rooms listed for a hotel are added if they are missing.
//     Existing rooms are never changed, so edits made in the app are kept.
// A hotel is matched by its code, then by its name.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const floorOf = (number) => {
  const digits = String(number).replace(/\D/g, '');
  return digits.length >= 3 ? digits.slice(0, -2) : '';
};

async function firstRunSetup() {
  const file = path.join(__dirname, '..', 'data', 'setup.json');
  if (!fs.existsSync(file)) return;
  let setup;
  try {
    setup = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('data/setup.json could not be read; skipping setup.');
    return;
  }
  const empty = (await db.one('SELECT count(*)::int AS n FROM properties')).n === 0;
  for (const h of setup.hotels || []) {
    if (!h.name) continue;
    await db.tx(async (q) => {
      let p = (await q(
        `SELECT id FROM properties WHERE ($1 <> '' AND code = $1) OR lower(name) = lower($2) ORDER BY id LIMIT 1`,
        [h.code || '', h.name]
      ))[0];
      if (!p) {
        if (!empty) {
          console.warn(`data/setup.json lists "${h.name}" but no hotel with that name or code exists; skipped.`);
          return;
        }
        p = (await q('INSERT INTO properties (name, code, timezone) VALUES ($1,$2,$3) RETURNING id', [
          h.name, h.code || '', h.timezone || 'America/New_York',
        ]))[0];
        console.log(`Created hotel ${h.name}.`);
      }
      let added = 0;
      for (const r of h.rooms || []) {
        const number = String(r.number || '').trim();
        if (!number) continue;
        const rows = await q(
          `INSERT INTO rooms (property_id, number, floor, room_type) VALUES ($1,$2,$3,$4)
           ON CONFLICT (property_id, number) DO NOTHING RETURNING id`,
          [p.id, number, floorOf(number), String(r.type || '').slice(0, 40)]
        );
        added += rows.length;
      }
      if (added) console.log(`Added ${added} rooms to ${h.name}.`);
    });
  }
}

module.exports = { firstRunSetup };
