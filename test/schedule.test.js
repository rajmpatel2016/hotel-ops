const test = require('node:test');
const assert = require('node:assert');
const { weekStartOf, shiftMinutes, fmtTime, fmtHours } = require('../src/util');

test('week start for any weekday setting', () => {
  // 2026-11-10 is a Tuesday.
  assert.equal(weekStartOf('2026-11-10', 0), '2026-11-08'); // Sunday start
  assert.equal(weekStartOf('2026-11-10', 1), '2026-11-09'); // Monday start
  assert.equal(weekStartOf('2026-11-10', 2), '2026-11-10'); // Tuesday start
  assert.equal(weekStartOf('2026-11-10', 3), '2026-11-04'); // Wednesday start
  assert.equal(weekStartOf('2026-11-01', 1), '2026-10-26'); // crosses a month
});

test('paid hours: breaks, overnight shifts', () => {
  assert.equal(shiftMinutes('08:00', '16:30', 30), 480);
  assert.equal(shiftMinutes('23:00', '07:30', 30), 480); // night audit past midnight
  assert.equal(shiftMinutes('09:00', '13:00', 0), 240);
  assert.equal(shiftMinutes('09:00', '09:20', 30), 0); // never negative
});

test('time and hour formatting', () => {
  assert.equal(fmtTime('07:00'), '7a');
  assert.equal(fmtTime('15:30:00'), '3:30p');
  assert.equal(fmtTime('00:00'), '12a');
  assert.equal(fmtTime('12:15'), '12:15p');
  assert.equal(fmtHours(480), '8');
  assert.equal(fmtHours(465), '7.75');
});
