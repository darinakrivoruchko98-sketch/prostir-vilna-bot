const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAfishaDaySelection } = require('../src/utils/afisha-day-selection');

test('parses friday day buttons with different apostrophes and emoji', () => {
  assert.deepEqual(parseAfishaDaySelection("💚 П'ятниця (11.09.2026)"), {
    weekdayKey: "п'ятниця",
    dayNum: 5
  });

  assert.deepEqual(parseAfishaDaySelection("💚 П’ятниця (11.09.2026)"), {
    weekdayKey: "п'ятниця",
    dayNum: 5
  });

  assert.deepEqual(parseAfishaDaySelection("💚 п'ятниця (11.09.2026)"), {
    weekdayKey: "п'ятниця",
    dayNum: 5
  });

  assert.deepEqual(parseAfishaDaySelection("💚 пятниця (11.09.2026)"), {
    weekdayKey: "п'ятниця",
    dayNum: 5
  });
});
