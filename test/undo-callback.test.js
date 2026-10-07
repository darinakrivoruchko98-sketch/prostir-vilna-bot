const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildUndoCallbackData, resolveUndoEventId, isUndoCallbackData } = require('../src/utils/undo-callback');

const longId = 'Консультація_психолога_для_внутрішньо_переміщених_осіб_20.10.2026_18:00';
const otherId = 'Консультація_психолога_для_внутрішньо_переміщених_осіб_21.10.2026_18:00';

test('long Cyrillic event id produces callback_data within 64 bytes', () => {
  const data = buildUndoCallbackData(longId);
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `${Buffer.byteLength(data, 'utf8')} bytes`);
  assert.ok(isUndoCallbackData(data));
});

test('short token resolves to the correct event and is stable', () => {
  const data = buildUndoCallbackData(longId);
  assert.equal(data, buildUndoCallbackData(longId));
  assert.notEqual(data, buildUndoCallbackData(otherId));
  assert.equal(resolveUndoEventId(data, [otherId, longId]), longId);
  assert.equal(resolveUndoEventId(data, [otherId]), '');
});

test('legacy UNDO_REGISTER:<eventId> buttons keep working and short ids keep the legacy format', () => {
  assert.equal(resolveUndoEventId('UNDO_REGISTER:Test_20.10.2026_18:00', []), 'Test_20.10.2026_18:00');
  assert.equal(buildUndoCallbackData('Test_20.10.2026_18:00'), 'UNDO_REGISTER:Test_20.10.2026_18:00');
  assert.equal(resolveUndoEventId('SOMETHING_ELSE', [longId]), '');
});

test('server uses the shared helper for both buttons and handles BUTTON_DATA_INVALID / EFATAL safely', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((source.match(/buildUndoCallbackData\(/g) || []).length, 2);
  assert.doesNotMatch(source, /callback_data: `UNDO_REGISTER:/);
  assert.match(source, /BUTTON_DATA_INVALID[\s\S]*?withoutButton: true[\s\S]*?manualRegistrationConfirmed = true/);
  assert.match(source, /manualConfirmationNetworkAttempts[\s\S]*?MANUAL_CONFIRMATION_MAX_NETWORK_ATTEMPTS/);
  assert.match(source, /error\.cause|error && error\.cause/);
});
