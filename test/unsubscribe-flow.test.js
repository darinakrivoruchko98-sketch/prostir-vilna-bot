const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const { decrementSheetRegistration } = require('../src/sheets/schedule');

test('decrementSheetRegistration removes a registrant from the schedule note and updates counts', async () => {
    const originalSheetsClient = state.sheetsClient;
    const originalSpreadsheetId = config.SPREADSHEET_ID;
    const updates = [];
    const batchUpdates = [];

    state.sheetsClient = {
        spreadsheets: {
            get: async (args) => {
                if (args && args.ranges && args.ranges[0] && args.ranges[0].includes('!E:')) {
                    return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: 'EVENT_ID:event-1' }] }] }] }] } };
                }
                if (args && args.ranges && args.ranges[0] && args.ranges[0].includes('!E1')) {
                    return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: 'Зареєстровано: 1\n\n1. Alice | 380123' }] }] }] }] } };
                }
                if (args && args.fields && args.fields.includes('sheets(properties(sheetId,title))')) {
                    return { data: { sheets: [{ properties: { sheetId: 7, title: 'Розклад' } }] } };
                }
                return { data: { values: [] } };
            },
            values: {
                get: async (args) => {
                    if (args && args.range && args.range.includes('D1:E1')) {
                        return { data: { values: [['5', '10']] } };
                    }
                    return { data: { values: [] } };
                },
                update: async (args) => {
                    updates.push(args);
                }
            },
            batchUpdate: async (args) => {
                batchUpdates.push(args);
            }
        }
    };
    config.SPREADSHEET_ID = 'spreadsheet-123';

    try {
        const result = await decrementSheetRegistration(
            { id: 'event-1', name: 'Test Event', date: new Date('2026-08-11T18:00:00Z') },
            { userId: '42', name: 'Alice', phone: '380123' }
        );

        assert.equal(result && result.status, 'ok');
        assert.equal(updates.length, 1);
        assert.equal(updates[0].requestBody.values[0][0], '6');
        assert.equal(updates[0].requestBody.values[0][1], '9');
        assert.equal(batchUpdates.length, 1);
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.SPREADSHEET_ID = originalSpreadsheetId;
    }
});

test('buildScheduleNoteText uses the actual number of registered names instead of stale sheet counts', () => {
    const noteText = require('../src/sheets/schedule').buildScheduleNoteText({
        registered: [
            { name: 'Alice', phone: '380111111111' },
            { name: 'Bob', phone: '380222222222' }
        ],
        reserve: [],
        registrationsCount: 6,
        eventId: 'event-1'
    });

    assert.match(noteText, /Зареєстровано:\s*2/);
    assert.doesNotMatch(noteText, /Зареєстровано:\s*6/);
});

test('decrementSheetRegistration keeps the remaining registrants in the note when one person unsubscribes', async () => {
    const originalSheetsClient = state.sheetsClient;
    const originalSpreadsheetId = config.SPREADSHEET_ID;
    const updates = [];
    const batchUpdates = [];

    state.sheetsClient = {
        spreadsheets: {
            get: async (args) => {
                if (args && args.ranges && args.ranges[0] && args.ranges[0].includes('!E:')) {
                    return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: 'EVENT_ID:event-1' }] }] }] }] } };
                }
                if (args && args.ranges && args.ranges[0] && args.ranges[0].includes('!E1')) {
                    return { data: { sheets: [{ data: [{ rowData: [{ values: [{ note: 'Зареєстровано: 6\n\n1. Alice — 380111\n2. Bob — 380222\n3. Carol — 380333' }] }] }] }] } };
                }
                if (args && args.fields && args.fields.includes('sheets(properties(sheetId,title))')) {
                    return { data: { sheets: [{ properties: { sheetId: 7, title: 'Розклад' } }] } };
                }
                return { data: { values: [] } };
            },
            values: {
                get: async (args) => {
                    if (args && args.range && args.range.includes('D1:E1')) {
                        return { data: { values: [['5', '6']] } };
                    }
                    return { data: { values: [] } };
                },
                update: async (args) => {
                    updates.push(args);
                }
            },
            batchUpdate: async (args) => {
                batchUpdates.push(args);
            }
        }
    };
    config.SPREADSHEET_ID = 'spreadsheet-123';

    try {
        const result = await decrementSheetRegistration(
            { id: 'event-1', name: 'Test Event', date: new Date('2026-08-11T18:00:00Z') },
            { userId: '42', name: 'Alice', phone: '380111' }
        );

        assert.equal(result && result.status, 'ok');
        assert.equal(updates.length, 1);
        assert.equal(batchUpdates.length, 1);
        const note = batchUpdates[0].requestBody.requests[0].repeatCell.cell.note;
        assert.match(note, /Зареєстровано:\s*2/);
        assert.match(note, /Bob/);
        assert.match(note, /Carol/);
        assert.doesNotMatch(note, /Alice/);
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.SPREADSHEET_ID = originalSpreadsheetId;
    }
});

test('unsubscribe confirmation flow includes handlers for self and friend unregistration', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

    assert.match(source, /if \(text === "✅ Так, відписатись" && user\.pendingUnregEventId\)\s*\{[\s\S]*?result = await unregisterFromEvent\(chatId, eventId\);/);
    assert.match(source, /if \(text === '✅ Так, відписати подругу' && user\.pendingFriendUnregKey\)\s*\{[\s\S]*?const result = await unregisterFriendFromEvent\(chatId, user\.pendingFriendUnregKey\);/);
    assert.match(source, /unregisterFromReserve\(chatId, eventId\)/);
});

test('reserve promotion does not increment registrations a second time after the sheet update', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
    const helperStart = source.indexOf('async function promoteFirstReserveRegistrantToRegistrationUnlocked(event) {');
    const helperEnd = source.indexOf('\nasync function promoteReserveRegistrantsForAvailableSeatsUnlocked', helperStart);
    const helper = source.slice(helperStart, helperEnd);

    assert.notEqual(helperStart, -1);
    assert.notEqual(helperEnd, -1);
    assert.match(helper, /scheduleSheetUtils\.promoteFirstReserveRegistrantToRegistration\(event\)/);
    assert.doesNotMatch(helper, /^\s*event\.registrations\s*=/m);

    const scheduleLoaderStart = source.indexOf('async function loadEventsFromSheet');
    const scheduleLoadStart = source.indexOf('for (const event of events) {', scheduleLoaderStart);
    const scheduleLoadEnd = source.indexOf('\n        console.log(`✅ Розклад завантажено з Sheets', scheduleLoadStart);
    const scheduleLoad = source.slice(scheduleLoadStart, scheduleLoadEnd);
    assert.notEqual(scheduleLoaderStart, -1);
    assert.notEqual(scheduleLoadStart, -1);
    assert.notEqual(scheduleLoadEnd, -1);
    assert.match(scheduleLoad, /previousRemaining === null \? currentRemaining : currentRemaining - previousRemaining/);
});
