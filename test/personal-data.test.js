const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const { invalidateCache } = require('../src/sheets/cache');
const { appendRegistrationRow, resolveKnownUser } = require('../src/sheets/personal-data');
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
    health: 'Ні, немає істотних проблем зі здоров\'ям',
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

test('friend profile without chatId writes to the registered-users sheet without overwriting the registrant', async () => {
  const originalClient = state.sheetsClient;
  const originalSpreadsheetId = config.PERSONAL_DATA_SPREADSHEET_ID;
  const originalSheetName = config.PERSONAL_DATA_SHEET_NAME;
  const updates = [];
  const rows = [
    ['username', 'name', 'phone', 'birth', 'status', 'children', 'health', 'evacuation', 'impact', 'employment', 'category', 'gzn', 'chatId'],
    ['', 'Іваненко Марія Олександрівна', '380111111111', '01.01.1980', 'ВПО', '0', 'Ні', '', '', 'Працюю', '', 'Ні', '5198527486']
  ];

  state.sheetsClient = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { title: 'Зареєстровані' } }] } }),
      values: {
        get: async () => ({ data: { values: rows } }),
        update: async (request) => updates.push(request)
      }
    }
  };
  config.PERSONAL_DATA_SPREADSHEET_ID = 'friend-personal-sheet';
  config.PERSONAL_DATA_SHEET_NAME = 'Зареєстровані';
  invalidateCache('personal-data');

  try {
    await appendRegistrationRow('', {
      name: 'Іваненко Марія Олександрівна',
      phone: '380990635980',
      birth: '02.02.1990',
      status: 'ВПО'
    }, { matchByPhoneOrChatIdOnly: true });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].spreadsheetId, 'friend-personal-sheet');
    assert.equal(updates[0].range, 'Зареєстровані!A3:M3');
    assert.equal(updates[0].requestBody.values[0][1], 'Іваненко Марія Олександрівна');
    assert.equal(updates[0].requestBody.values[0][2], '380990635980');
    assert.equal(updates[0].requestBody.values[0][12], '');
  } finally {
    state.sheetsClient = originalClient;
    config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
    config.PERSONAL_DATA_SHEET_NAME = originalSheetName;
    invalidateCache('personal-data');
  }
});
