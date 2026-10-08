const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `missing ${start}`);
  return source.slice(from, to);
}

function createHarness() {
  const calls = [];
  const event = { id: 'e1', name: 'Захід', date: new Date(Date.now() + 86400000) };
  const ctx = {
    SPREADSHEET_ID: 'x',
    sheetsClient: {},
    userEventRegistrations: {},
    buildScheduleEventNoteIndex: async () => new Map([['key', 'note']]),
    getAllEvents: () => [event],
    getEventIdentityKey: () => 'key',
    parseRegistrantsFromNote: () => [{ name: 'Іра', phone: '+380501112233' }],
    normalizeRegistrantPhone: (p) => String(p || '').replace(/\D/g, ''),
    resolveChatIdByPhone: async () => '555',
    recordFeedbackCandidate: () => {},
    saveReminderStateToDisk: () => {},
    scheduleManualNoteConfirmation: (...a) => { calls.push(['schedule', a]); return true; },
    schedulePendingManualNoteConfirmations: (...a) => { calls.push(['pending', a]); },
    sendManualRegistrationConfirmation: async (...a) => { calls.push(['send', a]); },
    console: { log() {} }
  };
  const code = extract('async function syncManualRegistrationsFromScheduleNotes(', 'async function notifyRegistrantAboutRegistration(')
    + '\nreturn syncManualRegistrationsFromScheduleNotes;';
  const sync = new Function(...Object.keys(ctx), code)(...Object.values(ctx));
  return { sync, calls, ctx };
}

test('old note in column E after restart restores the registration but schedules no confirmation', async () => {
  const h = createHarness();
  await h.sync();
  await h.sync({ forceRefresh: true });
  assert.deepEqual(h.calls, []);
  const regs = h.ctx.userEventRegistrations['555'];
  assert.equal(regs.length, 1);
  assert.equal(regs[0].eventId, 'e1');
  assert.equal(regs[0].manualRegistrationConfirmed, true);
});

test('sync never references manual confirmation sending', () => {
  const sync = extract('async function syncManualRegistrationsFromScheduleNotes(', 'async function notifyRegistrantAboutRegistration(');
  assert.doesNotMatch(sync, /ManualNoteConfirmation|sendManualRegistrationConfirmation/);
});
