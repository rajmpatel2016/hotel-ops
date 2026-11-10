// Reads an employee roster report (CSV) and works out what to change.
// Only name, payroll ID, department, job title and status are ever read.
// Pay, Social Security numbers and anything else in the file are ignored and never stored.

const { parse } = require('csv-parse/sync');
const { categorize, normName, displayName } = require('./util');

const HEADERS = {
  name: ['employee name', 'name', 'employee', 'associate name', 'payroll name', 'legal name', 'full name', 'worker name'],
  first: ['first name', 'legal first name', 'firstname', 'first'],
  last: ['last name', 'legal last name', 'lastname', 'last'],
  id: ['file number', 'file #', 'file no', 'employee id', 'associate id', 'position id', 'emp id', 'employee number', 'employee #', 'emp #', 'id'],
  department: ['home department', 'home department description', 'department', 'department description', 'dept', 'home dept'],
  title: ['job title', 'job title description', 'title', 'position', 'job', 'job description', 'position title'],
  status: ['status', 'employment status', 'position status', 'employee status', 'status description'],
};

const clean = (h) => String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');

function findColumn(header, names) {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
}

// Reports often start with a title or date line, so look for the header in the first rows.
function locateHeader(records) {
  for (let r = 0; r < Math.min(records.length, 15); r++) {
    const header = records[r].map(clean);
    const cols = {};
    for (const key of Object.keys(HEADERS)) cols[key] = findColumn(header, HEADERS[key]);
    if (cols.name !== -1 || (cols.first !== -1 && cols.last !== -1)) return { row: r, cols, header: records[r] };
  }
  return null;
}

function parseRoster(buffer) {
  let text = buffer.toString('utf8');
  if (text.includes('\u0000')) {
    throw new Error('This looks like an Excel file. In ADP, export the report as CSV (or open it in Excel and use Save As > CSV), then upload that.');
  }
  let records;
  try {
    records = parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true, relax_quotes: true });
  } catch (e) {
    throw new Error('Could not read this file as CSV. Export the roster report as CSV and try again.');
  }
  if (!records.length) throw new Error('The file is empty.');
  const found = locateHeader(records);
  if (!found) {
    const seen = records[0].map((h) => String(h).trim()).filter(Boolean).slice(0, 12).join(', ');
    throw new Error(`Could not find an employee name column. The first row has: ${seen || 'nothing readable'}. The report needs a column called "Employee Name" or "First Name" and "Last Name".`);
  }
  const { row, cols } = found;
  const get = (rec, i) => (i === -1 ? '' : String(rec[i] ?? '').trim());
  const out = [];
  const seen = new Set();
  for (const rec of records.slice(row + 1)) {
    let name = cols.name !== -1 ? get(rec, cols.name) : `${get(rec, cols.first)} ${get(rec, cols.last)}`.trim();
    name = displayName(name);
    if (!name || /^(total|totals|grand total|count)\b/i.test(name)) continue;
    const payrollId = get(rec, cols.id);
    const key = payrollId ? `id:${payrollId}` : `n:${normName(name)}`;
    if (seen.has(key)) continue; // same person listed twice (two positions)
    seen.add(key);
    const status = get(rec, cols.status);
    out.push({
      name,
      payrollId,
      department: get(rec, cols.department),
      jobTitle: get(rec, cols.title),
      terminated: /term|inactive|separated|deceased/i.test(status),
    });
  }
  if (!out.length) throw new Error('No employees were found under the header row.');
  return out;
}

// Decide what the import changes. Pure function so it can be tested without a database.
//   existing: employee rows for this hotel
//   rows: parsed roster rows
// Rules:
//   - Match on payroll ID first, then on name.
//   - A hand-added employee who now appears in the report is linked to it, not duplicated.
//   - Removals and hand-set categories made by a manager are never undone.
//   - Anyone from a past report who is missing or terminated is marked "not on latest report".
function planImport(existing, rows) {
  const byId = new Map();
  const byName = new Map();
  const byTokens = new Map(); // same words in any order: "Lopez Maria" = "Maria Lopez"
  const tokenKey = (name) => normName(name).split(' ').sort().join(' ');
  for (const e of existing) {
    if (e.payroll_id) byId.set(String(e.payroll_id), e);
    const k = normName(e.name);
    if (!byName.has(k)) byName.set(k, e);
    const t = tokenKey(e.name);
    if (!byTokens.has(t)) byTokens.set(t, e);
  }
  // A hand-added "Maria Lopez" should link to payroll's "Maria E Lopez Garcia",
  // but only when exactly one hand-added person fits.
  const manual = existing.filter((e) => e.source === 'manual' && !e.payroll_id);
  const looseMatch = (name) => {
    const words = new Set(normName(name).split(' '));
    const fits = manual.filter((e) => {
      const w = normName(e.name).split(' ');
      return w.length >= 2 && w.every((x) => words.has(x));
    });
    return fits.length === 1 ? fits[0] : null;
  };
  const plan = { add: [], update: [], drop: [], counts: { added: 0, updated: 0, matched: 0, dropped: 0, unchanged: 0 } };
  const touched = new Set();

  for (const r of rows) {
    const hit = (r.payrollId && byId.get(String(r.payrollId))) || byName.get(normName(r.name)) ||
      byTokens.get(tokenKey(r.name)) || looseMatch(r.name);
    const category = categorize(r.department, r.jobTitle);
    if (!hit) {
      if (r.terminated) continue;
      plan.add.push({ ...r, category });
      plan.counts.added++;
      continue;
    }
    if (touched.has(hit.id)) continue;
    touched.add(hit.id);
    const next = {
      id: hit.id,
      name: r.name,
      payroll_id: r.payrollId || hit.payroll_id || null,
      department: r.department,
      job_title: r.jobTitle,
      category: hit.category_locked ? hit.category : category,
      in_latest_report: !r.terminated,
      newlyMatched: hit.source === 'manual',
    };
    const changed =
      next.name !== hit.name || (next.payroll_id || null) !== (hit.payroll_id || null) ||
      next.department !== hit.department || next.job_title !== hit.job_title ||
      next.category !== hit.category || next.in_latest_report !== hit.in_latest_report || next.newlyMatched;
    if (!changed) { plan.counts.unchanged++; continue; }
    plan.update.push(next);
    if (next.newlyMatched) plan.counts.matched++;
    else if (hit.in_latest_report && !next.in_latest_report) plan.counts.dropped++;
    else plan.counts.updated++;
  }

  for (const e of existing) {
    if (e.source === 'adp' && e.in_latest_report && !touched.has(e.id)) {
      plan.drop.push(e.id);
      plan.counts.dropped++;
    }
  }
  return plan;
}

async function applyImport(q, propertyId, plan) {
  for (const a of plan.add) {
    await q(
      `INSERT INTO employees (property_id, name, payroll_id, department, job_title, category, source, in_latest_report)
       VALUES ($1,$2,$3,$4,$5,$6,'adp',TRUE)`,
      [propertyId, a.name, a.payrollId || null, a.department, a.jobTitle, a.category]
    );
  }
  for (const u of plan.update) {
    await q(
      `UPDATE employees SET name=$3, payroll_id=$4, department=$5, job_title=$6, category=$7,
              in_latest_report=$8, source='adp',
              matched_at = CASE WHEN $9 THEN now() ELSE matched_at END
        WHERE id=$1 AND property_id=$2`,
      [u.id, propertyId, u.name, u.payroll_id, u.department, u.job_title, u.category, u.in_latest_report, u.newlyMatched]
    );
  }
  if (plan.drop.length) {
    await q(`UPDATE employees SET in_latest_report=FALSE WHERE property_id=$1 AND id = ANY($2::int[])`, [propertyId, plan.drop]);
  }
}

module.exports = { parseRoster, planImport, applyImport };
