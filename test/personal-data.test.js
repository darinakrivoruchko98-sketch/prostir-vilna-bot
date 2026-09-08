c:\Users\LENOVO\AppData\Local\Packages\MicrosoftWindows.Client.Core_cw5n1h2txyewy\TempState\ScreenClip\{5A59E724-654A-445B-954C-EAF9FBAC8598}.pngconst test = require('node:test');
const assert = require('node:assert/strict');
const { resolveKnownUser } = require('../src/sheets/personal-data');
const { applyKnownUserProfile } = require('../src/handlers/registration');
const { buildScheduleNoteText, extractScheduleNoteEventId } = require('../src/sheets/schedule');

test('resolveKnownUser returns cached user without calling lookup', async () => {
  const knownUsers = { '123': { name: 'Олена', phone: '380501234567' } };
  let lookupCalled = false;

  const user = await resolveKnownUser('123', knownUsers, async () => {
    lookupCalled = true;
    return { name: 'Інша' };
  });

  assert.equal(lookupCalled, false);
  assert.deepEqual(user, knownUsers['123']);
});

test('resolveKnownUser fetches and caches a missing user', async () => {
  const knownUsers = {};
  const fetchedUser = { name: 'Марія', phone: '380671234567' };

  const user = await resolveKnownUser('456', knownUsers, async () => fetchedUser);

  assert.equal(user, fetchedUser);
  assert.deepEqual(knownUsers['456'], fetchedUser);
});

test('applyKnownUserProfile imports existing profile data into the session', () => {
  const user = { step: 1 };
  const knownUser = {
    name: 'Марія',
    phone: '380671234567',
    birth: '01.01.1990',
    status: 'ВПО',
    childrenCount: '1',
    health: 'Ні, немає істотних проблем зі здоров'ям',
    evacuationStatus: 'Нічого з зазначеного',
    shellingImpact: 'Ні, не постраждала',
    employment: 'Працюю',
    gzn: 'Ні',
    beneficiaryCategory: 'Нічого із вищезазначеного'
  };

  const applied = applyKnownUserProfile(user, knownUser);

  assert.equal(applied, true);
  assert.equal(user.name, knownUser.name);
  assert.equal(user.phone, knownUser.phone);
  assert.equal(user.status, knownUser.status);
  assert.equal(user.gzn, knownUser.gzn);
});

test('buildScheduleNoteText keeps event id metadata so registrations are matched to the correct event', () => {
  const noteText = buildScheduleNoteText({
    registered: [{ name: 'Анна', phone: '380501234567' }],
    reserve: [],
    registrationsCount: 1,
    eventId: 'event_123'
  });

  assert.match(noteText, /EVENT_ID:\s*event_123/i);
  assert.equal(extractScheduleNoteEventId(noteText), 'event_123');
});
