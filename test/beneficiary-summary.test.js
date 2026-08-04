const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegistrantsFromNoteText } = require('../src/utils/beneficiary-summary');

test('parses registrants from a note with a registered section', () => {
  const noteText = `Зареєстровано: 2

1. Іванова Марія | +380501234567
2. Петренко Оксана | 0671234567`;

  const result = parseRegistrantsFromNoteText(noteText);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { name: 'Іванова Марія', phone: '+380501234567' });
  assert.deepEqual(result[1], { name: 'Петренко Оксана', phone: '0671234567' });
});

test('parses registrants from a bullet list with separators', () => {
  const noteText = `• Іванова Марія — +380501234567
• Петренко Оксана 0671234567`;

  const result = parseRegistrantsFromNoteText(noteText);

  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Іванова Марія');
  assert.equal(result[0].phone, '+380501234567');
  assert.equal(result[1].phone, '0671234567');
});

test('keeps numeric identifiers separate from phone numbers', () => {
  const noteText = `Зареєстровано: 2

1. Іванова Марія | +380501234567
2. 375328037`;

  const result = parseRegistrantsFromNoteText(noteText);

  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Іванова Марія');
  assert.equal(result[0].phone, '+380501234567');
  assert.equal(result[1].identifier, '375328037');
  assert.equal(result[1].phone, '');
});
