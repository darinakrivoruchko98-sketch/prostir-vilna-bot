const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const schedule = require('../src/sheets/schedule');
const sheets = require('../src/sheets/init');
const { parseEventFromRow } = require('../src/events/parser');

function createReserveNote(reservists) {
  return [
    `Резерв: ${reservists.length}`,
    '',
    ...reservists.map((person, index) => `${index + 1}. ${person.name} | ${person.phone} | ${person.userId}`),
    '',
    'EVENT_ID:event-1'
  ].join('\n');
}

function createRegisteredNote(registrants) {
  return schedule.buildScheduleNoteText({
    registered: registrants,
    registrationsCount: registrants.length,
    eventId: 'event-1'
  });
}

async function withScheduleSheet({ remaining, registrations, registered, reservists, failBatchUpdate = false }, run) {
  const originalClient = state.sheetsClient;
  const originalSpreadsheetId = config.SPREADSHEET_ID;
  const originalCandidates = config.SCHEDULE_SHEET_CANDIDATES;
  const originalEvents = state.events;
  const values = { remaining, registrations, reserveCount: reservists.length };
  const notes = {
    registered: createRegisteredNote(registered),
    reserve: createReserveNote(reservists)
  };
  const batchRequests = [];
  const event = {
    id: 'event-1',
    name: 'Test Event',
    date: new Date('2026-10-20T18:00:00Z'),
    seats: remaining + registrations,
    registrations,
    reserveCount: reservists.length
  };

  state.sheetsClient = {
    spreadsheets: {
      get: async (args) => {
        if (args && args.fields && args.fields.includes('sheets(properties(sheetId,title))')) {
          return { data: { sheets: [{ properties: { sheetId: 7, title: 'Розклад' } }] } };
        }
        const range = args && args.ranges && args.ranges[0] || '';
        if (range === 'Розклад!E:E') {
          return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: notes.registered }] }] }] }] } };
        }
        if (range === 'Розклад!E1') {
          return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: notes.registered }] }] }] }] } };
        }
        if (range === 'Розклад!F1') {
          return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: notes.reserve }] }] }] }] } };
        }
        return { data: { sheets: [] } };
      },
      values: {
        get: async (args) => {
        if (args && args.range === 'Розклад!A:E') {
          return { data: { values: [['2026-10-20', '18:00', 'Test Event', String(values.remaining), String(values.registrations)]] } };
        }
        if (args && args.range === 'Розклад!D1:E1') {
          return { data: { values: [[String(values.remaining), String(values.registrations)]] } };
          }
          return { data: { values: [] } };
        },
        update: async (args) => {
          const range = args.range || '';
          const row = args.requestBody.values[0];
          if (range.includes('!D1:E1')) {
            values.remaining = Number(row[0]);
            values.registrations = Number(row[1]);
          } else if (range.includes('!F1:F1')) {
            values.reserveCount = Number(row[0]);
          }
        }
      },
      batchUpdate: async (args) => {
        batchRequests.push(args.requestBody.requests);
        if (failBatchUpdate) throw new Error('not found: simulated Sheets write failure');

        for (const request of args.requestBody.requests) {
          if (request.updateCells) {
            const column = request.updateCells.range.startColumnIndex;
            const cells = request.updateCells.rows[0].values;
            if (column === 3) {
              values.remaining = cells[0].userEnteredValue.numberValue;
              values.registrations = cells[1].userEnteredValue.numberValue;
            } else if (column === 5) {
              values.reserveCount = cells[0].userEnteredValue.numberValue;
            }
          }
          if (request.repeatCell) {
            const column = request.repeatCell.range.startColumnIndex;
            if (column === 4) notes.registered = request.repeatCell.cell.note;
            if (column === 5) notes.reserve = request.repeatCell.cell.note;
          }
        }
      }
    }
  };
  config.SPREADSHEET_ID = 'schedule-sheet-test';
  config.SCHEDULE_SHEET_CANDIDATES = ['Розклад'];

  try {
    await run({ event, values, notes, batchRequests });
  } finally {
    state.sheetsClient = originalClient;
    config.SPREADSHEET_ID = originalSpreadsheetId;
    config.SCHEDULE_SHEET_CANDIDATES = originalCandidates;
    state.events = originalEvents;
  }
}

function makeRegistered(name, phone, userId) {
  return { name, phone, userId };
}

function makeReserveQueue(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `Reserve ${index + 1}`,
    phone: `3800000000${String(index + 1).padStart(2, '0')}`,
    userId: String(100 + index)
  }));
}

test('manual increase by two seats promotes exactly the first two of seven reservists', async () => {
  const registered = Array.from({ length: 10 }, (_, index) => makeRegistered(`Registered ${index + 1}`, `3801111111${String(index).padStart(2, '0')}`, String(index + 1)));
  const reservists = makeReserveQueue(7);

  await withScheduleSheet({ remaining: 2, registrations: 10, registered, reservists }, async ({ event, values, notes }) => {
    const result = await schedule.promoteReserveRegistrantsIfNeeded(event, 0);

    assert.equal(result.promoted, 2);
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 12);
    assert.match(notes.registered, /Reserve 1/);
    assert.match(notes.registered, /Reserve 2/);
    assert.doesNotMatch(notes.registered, /Reserve 3/);
    assert.match(notes.reserve, /Резерв: 5/);
    assert.match(notes.reserve, /Reserve 3/);
    assert.match(notes.reserve, /Reserve 7/);
    assert.doesNotMatch(notes.reserve, /Reserve 1/);
    assert.equal(event.seats, 12);
    assert.equal(event.registrations, 12);
  });
});

test('schedule rows use total capacity while D remains the available-seat count', () => {
  const parsed = parseEventFromRow(['2026-10-20', '18:00', 'Test Event', '2', '10'], null).event;

  assert.equal(parsed.seats, 12);
  assert.equal(parsed.registrations, 10);
});

test('a failed Sheets promotion preserves the open seat and FIFO reserve', async () => {
  const registered = [makeRegistered('Registered 1', '380111111111', '1')];
  const reservists = makeReserveQueue(2);

  await withScheduleSheet({ remaining: 1, registrations: 1, registered, reservists, failBatchUpdate: true }, async ({ event, values, notes }) => {
    await assert.rejects(schedule.promoteReserveRegistrantsIfNeeded(event, 0), /simulated Sheets write failure/);

    assert.equal(values.remaining, 1);
    assert.equal(values.registrations, 1);
    assert.equal(values.reserveCount, 2);
    assert.match(notes.reserve, /Reserve 1/);
    assert.match(notes.reserve, /Reserve 2/);
    assert.doesNotMatch(notes.registered, /Reserve 1/);
    assert.equal(event.registrations, 1);
  });
});

test('an unregistration-created seat promotes the first reservist', async () => {
  const registered = [makeRegistered('Registered 1', '380111111111', '1')];
  const reservists = makeReserveQueue(3);

  await withScheduleSheet({ remaining: 0, registrations: 1, registered, reservists }, async ({ event, values, notes }) => {
    await schedule.decrementSheetRegistration(event, registered[0]);
    const result = await schedule.promoteFirstReserveRegistrantToRegistration(event);

    assert.equal(result.promoted.name, 'Reserve 1');
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 1);
    assert.match(notes.registered, /Reserve 1/);
    assert.doesNotMatch(notes.registered, /Registered 1/);
    assert.match(notes.reserve, /Резерв: 2/);
    assert.doesNotMatch(notes.reserve, /Reserve 1/);
  });
});

test('already registered reserve entries are skipped without duplicating their registration', async () => {
  const registered = [makeRegistered('Reserve 1', '380000000001', '100')];
  const reservists = [registered[0], ...makeReserveQueue(3).slice(1)];

  await withScheduleSheet({ remaining: 1, registrations: 1, registered, reservists }, async ({ event, values, notes }) => {
    const result = await schedule.promoteFirstReserveRegistrantToRegistration(event);

    assert.equal(result.promoted.name, 'Reserve 2');
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 2);
    assert.equal((notes.registered.match(/Reserve 1/g) || []).length, 1);
    assert.doesNotMatch(notes.reserve, /Reserve 1/);
    assert.doesNotMatch(notes.registered, /Reserve 3/);
  });
});
function makeRegisteredList(count) {
  return Array.from({ length: count }, (_, index) => makeRegistered(`Registered ${index + 1}`, `3801111111${String(index).padStart(2, '0')}`, String(index + 1)));
}

test('regression: column D 0 -> 1 with one reservist promotes that person', async () => {
  const reservists = makeReserveQueue(1);

  await withScheduleSheet({ remaining: 1, registrations: 8, registered: makeRegisteredList(8), reservists }, async ({ event, values, notes }) => {
    const result = await schedule.promoteReserveRegistrantsIfNeeded(event, 0);

    assert.equal(result.promoted, 1);
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 9);
    assert.equal(values.reserveCount, 0);
    assert.match(notes.registered, /Reserve 1/);
  });
});

test('schedule refresh promotes the first reservist after column D is manually changed from 0 to 1', async () => {
  const reservists = makeReserveQueue(2);

  await withScheduleSheet({ remaining: 0, registrations: 8, registered: makeRegisteredList(8), reservists }, async ({ values, notes }) => {
    state.events = [parseEventFromRow(['2026-10-20', '18:00', 'Test Event', '0', '8'], null).event];
    await sheets.loadEventsFromSheet();
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 8);

    values.remaining = 1;
    await sheets.loadEventsFromSheet();

    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 9);
    assert.equal(values.reserveCount, 1);
    assert.match(notes.registered, /Reserve 1/);
    assert.doesNotMatch(notes.reserve, /Reserve 1/);
    assert.match(notes.reserve, /Reserve 2/);
  });
});

test('production Sheets refresh polls every minute and promotes from the refreshed available-seat count', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const initStart = source.indexOf('async function initSheets() {');
  const initEnd = source.indexOf('\n// Викликаємо асинхронно', initStart);
  const initSheets = source.slice(initStart, initEnd);
  const loaderStart = source.indexOf('async function loadEventsFromSheet() {');
  const loaderEnd = source.indexOf('\n/* ===== SAVE TO SHEET ===== */', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);

  assert.notEqual(initStart, -1);
  assert.notEqual(initEnd, -1);
  assert.notEqual(loaderStart, -1);
  assert.notEqual(loaderEnd, -1);
  assert.match(initSheets, /sheetsRefreshInterval = setInterval\(\(\) => \{[\s\S]*?loadEventsFromSheet\(\)/);
  assert.match(initSheets, /}, 60000\)/);
  assert.match(loader, /const availableSeats = await getSeatsLeft\(event\.id\)/);
  assert.match(loader, /promoteReserveRegistrantsForAvailableSeats\(event, availableSeats\)/);
});

test('regression: production server publishes the Sheets client and bot to the shared state used by schedule promotion', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(source, /const sharedState = require\('\.\/src\/state'\)/);
  assert.match(source, /sharedState\.bot = bot;/);
  assert.match(source, /sheetsClient = await createAuthorizedSheetsClient\(\);\s*(?:\/\/[^\n]*\n\s*)?sharedState\.sheetsClient = sheetsClient;/);
});

test('regression: promoteReserveRegistrantsIfNeeded does nothing without a shared Sheets client', async () => {
  const originalClient = state.sheetsClient;
  state.sheetsClient = null;
  try {
    const result = await schedule.promoteReserveRegistrantsIfNeeded({ id: 'event-1', name: 'Test Event', date: new Date() });
    assert.deepEqual(result, { promoted: 0, reserveLeft: 0 });
  } finally {
    state.sheetsClient = originalClient;
  }
});

test('regression: column D 0 -> 3 with five reservists promotes the first three in FIFO order', async () => {
  const reservists = makeReserveQueue(5);

  await withScheduleSheet({ remaining: 3, registrations: 10, registered: makeRegisteredList(10), reservists }, async ({ event, values, notes }) => {
    const result = await schedule.promoteReserveRegistrantsIfNeeded(event, 0);

    assert.equal(result.promoted, 3);
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 13);
    assert.equal(values.reserveCount, 2);
    for (const name of ['Reserve 1', 'Reserve 2', 'Reserve 3']) assert.match(notes.registered, new RegExp(name));
    assert.doesNotMatch(notes.registered, /Reserve 4/);
    assert.match(notes.reserve, /Reserve 4/);
    assert.match(notes.reserve, /Reserve 5/);
  });
});

test('regression: column D 0 -> 3 with one reservist promotes one and keeps two seats free', async () => {
  const reservists = makeReserveQueue(1);

  await withScheduleSheet({ remaining: 3, registrations: 10, registered: makeRegisteredList(10), reservists }, async ({ event, values }) => {
    const result = await schedule.promoteReserveRegistrantsIfNeeded(event, 0);

    assert.equal(result.promoted, 1);
    assert.equal(values.remaining, 2);
    assert.equal(values.registrations, 11);
    assert.equal(values.reserveCount, 0);
  });
});

test('regression: unsubscribing adds one free seat and triggers reserve promotion', async () => {
  const registered = makeRegisteredList(10);
  const reservists = makeReserveQueue(3);

  await withScheduleSheet({ remaining: 0, registrations: 10, registered, reservists }, async ({ event, values, notes }) => {
    await schedule.decrementSheetRegistration(event, registered[0]);
    assert.equal(values.remaining, 1);
    assert.equal(values.registrations, 9);

    const result = await schedule.promoteReserveRegistrantsIfNeeded(event, 0);

    assert.equal(result.promoted, 1);
    assert.equal(values.remaining, 0);
    assert.equal(values.registrations, 10);
    assert.match(notes.registered, /Reserve 1/);
    assert.doesNotMatch(notes.registered, /Registered 1\b/);
    assert.match(notes.reserve, /Резерв: 2/);
  });
});
