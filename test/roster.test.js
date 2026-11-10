const test = require('node:test');
const assert = require('node:assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@localhost/unused';
const { parseRoster, planImport } = require('../src/roster');
const { categorize, parseRoomList, roomSort } = require('../src/util');

const emp = (o) => ({ id: 1, name: '', payroll_id: null, department: '', job_title: '', category: 'Other', category_locked: false, source: 'adp', in_latest_report: true, removed: false, ...o });

test('reads a report with title lines, ignores pay columns and total rows', () => {
  const csv = 'Roster Report\nRun 11/10\nEmployee Name,File Number,Home Department,Job Title,Status,Rate\n"Lopez, Maria",10,Housekeeping,Room Attendant,Active,18\n"Chen, Wei",11,Front Office,GSA,Terminated,19\nTotal,2,,,,\n';
  const rows = parseRoster(Buffer.from(csv));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Maria Lopez', payrollId: '10', department: 'Housekeeping', jobTitle: 'Room Attendant', terminated: false });
  assert.equal(rows[1].terminated, true);
  assert.ok(!JSON.stringify(rows).includes('18'));
});

test('reads first and last name columns', () => {
  const rows = parseRoster(Buffer.from('First Name,Last Name,Department\nMaria,Lopez,Housekeeping\n'));
  assert.equal(rows[0].name, 'Maria Lopez');
});

test('rejects Excel files and files with no name column', () => {
  assert.throws(() => parseRoster(Buffer.from('PK\u0003\u0004\u0000\u0000')), /Excel/);
  assert.throws(() => parseRoster(Buffer.from('A,B\n1,2\n')), /name column/);
});

test('new people are added, terminated new people are not', () => {
  const plan = planImport([], [
    { name: 'Maria Lopez', payrollId: '10', department: 'Housekeeping', jobTitle: 'Room Attendant', terminated: false },
    { name: 'Gone Person', payrollId: '11', department: 'Housekeeping', jobTitle: '', terminated: true },
  ]);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.add[0].category, 'Housekeeping');
});

test('hand-set category survives an import', () => {
  const existing = [emp({ id: 5, name: 'Maria Lopez', payroll_id: '10', department: 'Front Office', job_title: 'GSA', category: 'Breakfast', category_locked: true })];
  const plan = planImport(existing, [{ name: 'Maria Lopez', payrollId: '10', department: 'Front Office', jobTitle: 'GSA Lead', terminated: false }]);
  assert.equal(plan.update[0].category, 'Breakfast');
});

test('hand-added person is linked, not duplicated, even with a longer payroll name', () => {
  const existing = [emp({ id: 7, name: 'Maria Lopez', source: 'manual', category: 'Housekeeping', category_locked: true })];
  const plan = planImport(existing, [{ name: 'Maria E Lopez Garcia', payrollId: '22', department: 'Housekeeping', jobTitle: 'Room Attendant', terminated: false }]);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.update[0].id, 7);
  assert.equal(plan.update[0].newlyMatched, true);
  assert.equal(plan.counts.matched, 1);
});

test('name order does not matter when matching', () => {
  const existing = [emp({ id: 8, name: 'Lopez Maria', source: 'manual' })];
  const plan = planImport(existing, [{ name: 'Maria Lopez', payrollId: '', department: '', jobTitle: '', terminated: false }]);
  assert.equal(plan.add.length, 0);
});

test('people missing from the report drop off; hand-added people do not', () => {
  const existing = [
    emp({ id: 1, name: 'Stays Here', payroll_id: '1' }),
    emp({ id: 2, name: 'Left Company', payroll_id: '2' }),
    emp({ id: 3, name: 'Agency Temp', source: 'manual' }),
  ];
  const plan = planImport(existing, [{ name: 'Stays Here', payrollId: '1', department: '', jobTitle: '', terminated: false }]);
  assert.deepEqual(plan.drop, [2]);
  assert.equal(plan.counts.unchanged, 1);
});

test('categories from department and title', () => {
  assert.equal(categorize('Housekeeping', 'Room Attendant'), 'Housekeeping');
  assert.equal(categorize('Rooms', 'Laundry Attendant'), 'Housekeeping');
  assert.equal(categorize('Engineering', 'Maintenance Tech'), 'Maintenance');
  assert.equal(categorize('Front Office', 'Night Auditor'), 'Front Desk');
  assert.equal(categorize('F&B', 'Breakfast Attendant'), 'Breakfast');
  assert.equal(categorize('Admin', 'General Manager'), 'Management');
  assert.equal(categorize('', ''), 'Other');
});

test('room list parsing and ordering', () => {
  assert.deepEqual(parseRoomList('101, 102\n#204;305'), ['101', '102', '204', '305']);
  assert.deepEqual(['1001', '99', '101A', '101'].sort(roomSort), ['99', '101', '101A', '1001']);
});
