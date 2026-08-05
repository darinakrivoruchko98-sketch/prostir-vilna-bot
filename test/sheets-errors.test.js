const test = require('node:test');
const assert = require('node:assert/strict');
const { getUserFacingSheetsMessage, isTemporarySheetsError } = require('../src/utils/sheets-errors');

test('detects quota errors and returns friendly message', () => {
  const error = new Error('Quota exceeded for quota metric Read requests');
  assert.equal(isTemporarySheetsError(error), true);
  assert.match(getUserFacingSheetsMessage(error), /@DarynaVilna/i);
});

test('does not treat unrelated errors as temporary', () => {
  const error = new Error('Permission denied');
  assert.equal(isTemporarySheetsError(error), false);
  assert.match(getUserFacingSheetsMessage(error), /Помилка при збереженні/i);
});
