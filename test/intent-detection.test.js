const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSkipAiIntentDetection } = require('../src/utils/intent-detection');

test('skips AI intent detection for emoji-only input', () => {
  assert.equal(shouldSkipAiIntentDetection('🧮'), true);
});

test('does not skip AI intent detection for real words', () => {
  assert.equal(shouldSkipAiIntentDetection('Афіша'), false);
  assert.equal(shouldSkipAiIntentDetection('привіт'), false);
});
