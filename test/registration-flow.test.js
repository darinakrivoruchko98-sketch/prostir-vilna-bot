const test = require('node:test');
const assert = require('node:assert/strict');
const { isRegistrationCancelText } = require('../src/utils/registration-flow');

test('detects registration cancel buttons', () => {
  assert.equal(isRegistrationCancelText('❌ Скасувати реєстрацію'), true);
  assert.equal(isRegistrationCancelText('❌ Відмінити реєстрацію'), true);
  assert.equal(isRegistrationCancelText('❌ Відмінити'), true);
});

test('does not treat regular text as registration cancellation', () => {
  assert.equal(isRegistrationCancelText('Привіт'), false);
  assert.equal(isRegistrationCancelText(''), false);
});
