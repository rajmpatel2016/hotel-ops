// First-run setup: creates the hotels listed in data/setup.json when the database has none.
// Rooms can be listed there too as [{ "number": "101", "type": "King" }], or added in the app.
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function firstRunSetup() {
  const row = await db.one('SELECT count(*)::int AS n FROM properties');
  if (row.n > 0) return;
  const file = path.join(__dirname, '..', 'data', 'setup.json');
  if (!fs.existsSync(file)) return;
  let setup;
  try {
    setup = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('data/setup.json could not be read; skipping first-run setup.');
    return;
  }
  for (const h of setup.hotels || []) {
    if (!h.name) continue;
    await db.tx(async (q) => {
      const p = (await q('INSERT INTO properties (name, code, timezone) VALUES ($1,$2,$3) RETURNING id', [
        h.name, h.code || '', h.timezone || 'America/New_York',
      ]))[0];
      for (const r of h.rooms || []) {
        const number = String(r.number || '').trim();
        if (!number) continue;
        const digits = number.replace(/\D/g, '');
        await q(
          `INSERT INTO rooms (property_id, number, floor, room_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [p.id, number, digits.length >= 3 ? digits.slice(0, -2) : '', String(r.type || '')]
        );
      }
      console.log(`Set up ${h.name} with ${(h.rooms || []).length} rooms.`);
    });
  }
}

module.exports = { firstRunSetup };
