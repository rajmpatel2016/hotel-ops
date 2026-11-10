const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings so no timezone shifts creep in.
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at a Postgres database and start again.');
  process.exit(1);
}

// Encrypt the connection unless the database is on the same private network
// (localhost, or a bare internal hostname like the one Render gives its own databases).
// Set PGSSL=on or PGSSL=off to force it either way.
function wantsSsl(url) {
  if (process.env.PGSSL === 'on') return true;
  if (process.env.PGSSL === 'off') return false;
  let host = '';
  try { host = new URL(url).hostname; } catch { return true; }
  return !(host === 'localhost' || host === '127.0.0.1' || !host.includes('.'));
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: wantsSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 10,
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// Run several statements as one unit: all succeed or none do.
async function tx(fn) {
  const client = await pool.connect();
  const q = async (text, params) => (await client.query(text, params)).rows;
  try {
    await client.query('BEGIN');
    const out = await fn(q);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, query, one, tx, migrate };
