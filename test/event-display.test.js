const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgendaEventSummary } = require('../src/utils/event-display');

test('buildAgendaEventSummary formats agenda details and button text', () => {
  const event = {
    id: 'evt-1',
    name: 'Йога',
    date: new Date('2026-01-01T10:30:00'),
    registrations: 2,
    reserveCount: 1,
    seats: 10
  };

  const summary = buildAgendaEventSummary(event, 8);

  assert.equal(summary.time, '10:30');
  assert.equal(summary.seatsLabel, '💺 8 місць');
  assert.match(summary.buttonText, /Йога \| 10:30/);
  assert.match(summary.messageLines.join('\n'), /Місць залишилось: 💺 8 місць/);
});
