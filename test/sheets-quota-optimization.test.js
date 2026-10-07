const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const schedule = require('../src/sheets/schedule');
const scheduleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sheets', 'schedule.js'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `${start} .. ${end}`);
  return source.slice(from, to);
}

test('server retry helper does not multiply 429 requests and sets a cooldown', () => {
  const helper = between('let sheetsQuotaCooldownUntil = 0;', 'function createDefaultReminderSettings');
  assert.match(helper, /attempts = 2/);
  assert.match(helper, /noteSheetsQuotaError\(error\)/);
  assert.match(helper, /sheetsQuotaCooldownUntil = Date\.now\(\) \+ SHEETS_QUOTA_COOLDOWN_MS/);
  assert.match(source, /if \(Date\.now\(\) < sheetsQuotaCooldownUntil\) return;/);
});

test('loader stops reading further ranges after a quota error', () => {
  const loader = between('async function loadEventsFromSheetOnce()', '/* ===== SAVE TO SHEET ===== */');
  assert.match(loader, /if \(noteSheetsQuotaError\(e\)\) \{\s*break;/);
  assert.match(loader, /sharedScheduleRows\.set\(scheduleSheet/);
});

test('index, note index and reconcile share A:F rows, note reads and skip missing sheets', () => {
  assert.match(between('async function getCachedScheduleIndex', 'async function findScheduleRowByEventByNoteTag'), /getExistingScheduleSheets\(\)[\s\S]*getSharedScheduleRows[\s\S]*fetchScheduleNoteRows/);
  assert.match(between('async function buildScheduleEventNoteIndexUncached', 'async function reconcileScheduleNotesWithEvents'), /getSharedScheduleRows[\s\S]*fetchScheduleNoteRows\(scheduleSheet\)/);
  assert.match(between('async function reconcileScheduleNotesWithEvents', 'async function isRegistrantAlreadyInEventNote'), /fetchScheduleNoteRows\(scheduleSheet, 0\)/);
});

test('retryRequest does not retry quota errors and promotion reuses the known row', async () => {
  const state = require('../src/state');
  const config = require('../src/config');
  const originalClient = state.sheetsClient;
  let calls = 0;
  state.sheetsClient = {
    spreadsheets: {
      get: async () => { calls += 1; const e = new Error('Quota exceeded for quota metric \'Read requests\''); e.code = 429; throw e; },
      values: { get: async () => { calls += 1; const e = new Error('Quota exceeded'); e.code = 429; throw e; } }
    }
  };
  const previousId = config.SPREADSHEET_ID;
  config.SPREADSHEET_ID = 'quota-test-sheet';
  try {
    await assert.rejects(() => schedule.promoteFirstReserveRegistrantToRegistration({ id: 'e', name: 'E', date: new Date() }, {
      match: { scheduleSheet: 'Розклад', rowIndex: 0 }
    }), /Quota/);
    assert.equal(calls, 1, 'one D:E read, no retries and no row search');
  } finally {
    state.sheetsClient = originalClient;
    config.SPREADSHEET_ID = previousId;
  }
  assert.match(scheduleSource, /options && options\.match/);
});
