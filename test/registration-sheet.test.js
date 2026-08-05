const assert = require('assert');
const { parseScheduleNoteSections, buildScheduleNoteText } = require('../src/sheets/schedule');

function testScheduleNoteFormatting() {
  const note = 'Зареєстровано: 1\n\n1. Іван — 380123456789\n\nРезерв: 1\n\n1. Петро — 380987654321\n\nEVENT_ID:test-event';
  const sections = parseScheduleNoteSections(note);
  assert.strictEqual(sections.registered.length, 1);
  assert.strictEqual(sections.reserve.length, 1);
  const rebuilt = buildScheduleNoteText({ registered: sections.registered, reserve: sections.reserve, registrationsCount: 1, eventId: 'test-event' });
  assert.ok(rebuilt.includes('Зареєстровано: 1'));
  assert.ok(rebuilt.includes('EVENT_ID:test-event'));
  console.log('registration-sheet.test.js: ok');
}

testScheduleNoteFormatting();
