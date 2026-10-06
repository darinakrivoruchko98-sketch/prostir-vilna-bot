const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFriendRegistrationRecord,
  registerFriendForEvent
} = require('../src/utils/friend-registration');

function createRecord(friendChatId = '') {
  return buildFriendRegistrationRecord({
    registrantChatId: '5198527486',
    friendChatId,
    friendName: 'Іваненко Марія Олександрівна',
    friendPhone: '380990635980',
    eventId: 'event-1'
  });
}

function createOperations(overrides = {}) {
  const calls = [];
  return {
    calls,
    operations: {
      hasAvailableSeat: async () => { calls.push('check-seat'); return true; },
      isDuplicate: async () => { calls.push('check-duplicate'); return false; },
      writeRegistrant: async (record) => { calls.push(['write-registrant', record]); },
      writeEventRegistration: async (record) => { calls.push(['write-event', record]); },
      ...overrides
    }
  };
}

test('registers a friend without friendChatId using her name, phone, and eventId', async () => {
  const record = createRecord();
  const { calls, operations } = createOperations();

  const result = await registerFriendForEvent(record, operations);

  assert.equal(result.status, 'success');
  assert.equal(result.record.friendChatId, '');
  assert.equal(result.record.registrantChatId, '5198527486');
  assert.equal(result.record.friendName, 'Іваненко Марія Олександрівна');
  assert.equal(result.record.friendPhone, '380990635980');
  assert.equal(result.record.eventId, 'event-1');
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'check-seat', 'check-duplicate', 'write-registrant', 'write-event'
  ]);
});

test('registers a friend with her own friendChatId', async () => {
  const record = createRecord('995177535');
  const { operations } = createOperations();

  const result = await registerFriendForEvent(record, operations);

  assert.equal(result.status, 'success');
  assert.equal(result.record.friendChatId, '995177535');
  assert.notEqual(result.record.friendChatId, result.record.registrantChatId);
});

test('does not commit a seat when writing the registered-user row fails', async () => {
  const { calls, operations } = createOperations({
    writeRegistrant: async () => { calls.push('write-registrant'); throw new Error('sheet unavailable'); }
  });

  const result = await registerFriendForEvent(createRecord(), operations);

  assert.equal(result.status, 'failed');
  assert.equal(calls.includes('write-event'), false);
});

test('invalid friend name does not write a row or commit a seat', async () => {
  for (const friendName of ['21 серпня на 11.00', '👭 Зареєструвати подругу']) {
    const { calls, operations } = createOperations();
    const result = await registerFriendForEvent({ ...createRecord(), friendName }, operations);

    assert.equal(result.status, 'invalid-registrant');
    assert.deepEqual(calls, []);
  }
});

test('duplicate friend registration does not write a row or commit a seat', async () => {
  const { calls, operations } = createOperations({
    isDuplicate: async () => { calls.push('check-duplicate'); return true; }
  });

  const result = await registerFriendForEvent(createRecord(), operations);

  assert.equal(result.status, 'already-registered');
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'write-event'), false);
});

test('no available seat does not write a row or commit a seat', async () => {
  const { calls, operations } = createOperations({
    hasAvailableSeat: async () => { calls.push('check-seat'); return false; }
  });

  const result = await registerFriendForEvent(createRecord(), operations);

  assert.equal(result.status, 'no-seats');
  assert.deepEqual(calls, ['check-seat']);
});

test('friend row identity never falls back to the person who registered her', async () => {
  const { operations } = createOperations({
    writeRegistrant: async (record) => {
      assert.equal(record.friendChatId, '');
      assert.equal(record.registrantChatId, '5198527486');
      assert.equal(record.friendName, 'Іваненко Марія Олександрівна');
      assert.equal(record.friendPhone, '380990635980');
    }
  });

  const result = await registerFriendForEvent(createRecord(), operations);

  assert.equal(result.status, 'success');
});