const test = require('node:test');
const assert = require('node:assert/strict');
const { isRegistrationCancelText, cancelAfishaRegistrationButton } = require('../src/utils/registration-flow');

test('detects registration cancel buttons', () => {
  assert.equal(isRegistrationCancelText('❌ Скасувати реєстрацію'), true);
  assert.equal(isRegistrationCancelText('❌ Відмінити реєстрацію'), true);
  assert.equal(isRegistrationCancelText('❌ Відмінити'), true);
});

test('does not treat regular text as registration cancellation', () => {
  assert.equal(isRegistrationCancelText('Привіт'), false);
  assert.equal(isRegistrationCancelText(''), false);
});

test('cancelAfishaRegistrationButton removes the registration and clears the last-event state', async () => {
  const registrations = [{ eventId: 'event-1', eventName: 'Тестовий захід' }];
  const user = {
    lastAfishaRegisteredEventId: 'event-1',
    lastAfishaRegisteredEventName: 'Тестовий захід'
  };
  const messages = [];

  const result = await cancelAfishaRegistrationButton({
    text: '❌ Відмінити реєстрацію',
    chatId: 42,
    user,
    registrations,
    unregisterFromEvent: async () => {
      registrations.splice(0, registrations.length);
      return { status: 'ok', eventName: 'Тестовий захід', mode: 'registration' };
    },
    unregisterFromReserve: async () => ({ status: 'ok', eventName: 'Тестовий захід', mode: 'reserve' }),
    sendMessage: async (chatId, text, options) => {
      messages.push({ chatId, text, options });
    },
    getAfishaInstantRegistrationKeyboard: () => [[{ text: 'Back' }]]
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'ok');
  assert.equal(registrations.length, 0);
  assert.equal(user.lastAfishaRegisteredEventId, undefined);
  assert.equal(user.lastAfishaRegisteredEventName, undefined);
  assert.ok(messages.some((message) => message.text.includes('Реєстрацію скасовано')));
});
