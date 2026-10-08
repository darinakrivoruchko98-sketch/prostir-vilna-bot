const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withCache, invalidateCache } = require('../src/sheets/cache');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `missing ${start}`);
  return source.slice(from, to);
}

test('afisha "❌ Відмінити реєстрацію" button reaches the real unregister handler instead of the generic state reset', () => {
  const generic = extract('const isAfishaUndoButton', 'clearPendingRegistrationSelection(user);');
  assert.match(generic, /text === '❌ Відмінити реєстрацію'/);
  assert.match(generic, /isRegistrationCancelText\(text\) && !isAfishaUndoButton/);
  assert.match(source, /if \(text === '❌ Відмінити реєстрацію'\) \{\s*const result = await cancelAfishaRegistrationButton\(/);
});

test('register → undo → note entry removed → repeated sync does not restore the registration', async () => {
  const state = { note: 'Іра | 380501112233', noteReads: 0 };
  const event = { id: 'e1', name: 'Захід', date: new Date(Date.now() + 86400000), registrations: 1 };
  const ctx = {
    SPREADSHEET_ID: 'x',
    SCHEDULE_SHEET_CANDIDATES: ['s'],
    sheetsClient: {
      spreadsheets: { values: {
        get: async () => ({ data: { values: [['5', '1']] } }),
        update: async () => ({})
      } }
    },
    withCache, invalidateCache,
    buildScheduleEventNoteIndexUncached: async () => { state.noteReads += 1; return new Map([['key', state.note]]); },
    userEventRegistrations: {},
    getAllEvents: () => [event],
    getEventIdentityKey: () => 'key',
    parseRegistrantsFromNote: (note) => (note ? [{ name: 'Іра', phone: '380501112233' }] : []),
    normalizeRegistrantPhone: (p) => String(p || '').replace(/\D/g, ''),
    resolveChatIdByPhone: async () => '555',
    recordFeedbackCandidate: () => {},
    saveReminderStateToDisk: () => {},
    findScheduleRowByEvent: async () => ({ scheduleSheet: 's', rowIndex: 0 }),
    getScheduleCellNote: async () => state.note,
    updateScheduleRegistrationNote: async () => { state.note = ''; },
    restoreScheduleRegistrationState: async () => {},
    console: { log() {}, error() {}, warn() {} }
  };
  const code = [
    extract('async function buildScheduleEventNoteIndex(', 'async function buildScheduleEventNoteIndexUncached()'),
    extract('async function syncManualRegistrationsFromScheduleNotes(', 'async function notifyRegistrantAboutRegistration('),
    extract('async function decrementSheetRegistrationUnlocked(', 'async function decrementSheetRegistration('),
    'return { sync: syncManualRegistrationsFromScheduleNotes, decrement: decrementSheetRegistrationUnlocked };'
  ].join('\n');
  const { sync, decrement } = new Function(...Object.keys(ctx), code)(...Object.values(ctx));

  invalidateCache('schedule-note-index');
  await sync();
  assert.equal(ctx.userEventRegistrations['555'].length, 1);

  // «Відмінити»: запис прибирається з пам'яті та з нотатки E.
  delete ctx.userEventRegistrations['555'];
  await decrement(event, { name: 'Іра', phone: '380501112233' });
  assert.equal(state.note, '');

  await sync();
  await sync({ forceRefresh: true });
  assert.equal(ctx.userEventRegistrations['555'], undefined);
});
