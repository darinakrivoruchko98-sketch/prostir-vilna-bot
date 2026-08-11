const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationDeduper } = require('../src/utils/notification-dedup');

test('suppresses duplicate notifications for the same event and recipient within cooldown', () => {
  const deduper = createNotificationDeduper(1000);

  assert.equal(
    deduper.shouldSend({ chatId: '123', eventId: 'event-1', kind: 'registration-confirmation' }),
    true
  );
  deduper.markSent({ chatId: '123', eventId: 'event-1', kind: 'registration-confirmation' });

  assert.equal(
    deduper.shouldSend({ chatId: '123', eventId: 'event-1', kind: 'registration-confirmation' }),
    false
  );
});

test('allows the same notification again after cooldown expires', () => {
  const deduper = createNotificationDeduper(10);

  deduper.markSent({ chatId: '456', eventId: 'event-2', kind: 'registration-confirmation' });

  setTimeout(() => {
    assert.equal(
      deduper.shouldSend({ chatId: '456', eventId: 'event-2', kind: 'registration-confirmation' }),
      true
    );
  }, 20);
});
