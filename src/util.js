const CATEGORIES = ['Housekeeping', 'Front Desk', 'Maintenance', 'Breakfast', 'Management', 'Other'];

const ROOM_STATUSES = [
  { key: 'checkout', label: 'Checkout', short: 'C/O' },
  { key: 'stayover', label: 'Stayover', short: 'Stay' },
  { key: 'vacant', label: 'Vacant', short: 'Vac' },
  { key: 'ooo', label: 'Out of order', short: 'OOO' },
];

const MAINT_STATUSES = {
  open: 'Open',
  in_progress: 'In progress',
  fixed: 'Fixed',
  cannot_fix: 'Cannot fix',
  closed: 'Closed',
};

// Work out which scheduling category someone belongs in from the department
// and job title on the payroll report.
function categorize(department, jobTitle) {
  const s = `${department || ''} ${jobTitle || ''}`.toLowerCase();
  if (/house\s*keep|room attend|housem|house\s*person|laundry|inspect|hskp|\bhk\b|public area/.test(s)) return 'Housekeeping';
  if (/maint|engineer|\bmx\b|grounds/.test(s)) return 'Maintenance';
  if (/breakfast|food|f\s*&\s*b|kitchen|cook|bistro|server|bartend|barista|pantry/.test(s)) return 'Breakfast';
  if (/front|desk|guest serv|night audit|\bgsa\b|\bgsr\b|reception|shuttle|driver|bell/.test(s)) return 'Front Desk';
  if (/manager|\bgm\b|\bagm\b|director|sales|admin|account|supervisor|executive/.test(s)) return 'Management';
  return 'Other';
}

// Today's date (YYYY-MM-DD) in the hotel's own time zone.
function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'America/New_York' }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  }
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function longDate(day) {
  return new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function shortDateTime(ts, timezone) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone || 'America/New_York',
  });
}

function daysSince(ts) {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
}

// Sort room numbers the way people read them: 99 before 101, 101 before 101A.
function roomSort(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

// Pull room numbers out of whatever someone pastes: "101, 102 204\n305".
function parseRoomList(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean);
}

function normName(name) {
  let n = String(name || '').trim();
  // "Last, First" -> "First Last"
  const m = n.match(/^([^,]+),\s*(.+)$/);
  if (m) n = `${m[2]} ${m[1]}`;
  return n.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function displayName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  const m = n.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : n;
}

module.exports = {
  CATEGORIES, ROOM_STATUSES, MAINT_STATUSES,
  categorize, todayIn, isDate, addDays, longDate, shortDateTime, daysSince,
  roomSort, parseRoomList, normName, displayName,
};
