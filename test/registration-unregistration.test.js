const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const registrationSheet = require('../src/sheets/registration');

function withMockedSheets(run) {
    const originalSheetsClient = state.sheetsClient;
    const originalSpreadsheetId = config.PERSONAL_DATA_SPREADSHEET_ID;
    const originalRegistrationsSheet = config.REGISTRATIONS_SHEET_NAME;

    const batchUpdates = [];
    const valuesUpdates = [];
    const valuesAppends = [];

    state.sheetsClient = {
        spreadsheets: {
            get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: 'Зареєстровані' } }] } }),
            values: {
                get: async () => ({ data: { values: [['ts', 'Alice', '380123', 'Event One', '2026-08-11']] } }),
                append: async (args) => valuesAppends.push(args),
                update: async (args) => valuesUpdates.push(args)
            },
            batchUpdate: async (args) => batchUpdates.push(args)
        }
    };
    config.PERSONAL_DATA_SPREADSHEET_ID = 'personal-sheet-123';
    config.REGISTRATIONS_SHEET_NAME = 'Зареєстровані';

    return Promise.resolve(run({ batchUpdates, valuesUpdates, valuesAppends })).finally(() => {
        state.sheetsClient = originalSheetsClient;
        config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
        config.REGISTRATIONS_SHEET_NAME = originalRegistrationsSheet;
    });
}

test('removeRegistrationEntry removes only the matching event registration for the current user', () => {
    const registrations = [
        { eventId: 'event-1', registrantName: 'Alice', registrantPhone: '380123' },
        { eventId: 'event-1', registrantName: 'Bob', registrantPhone: '380456' },
        { eventId: 'event-2', registrantName: 'Alice', registrantPhone: '380123' }
    ];

    const result = registrationSheet.removeRegistrationEntry(registrations, 'event-1', { name: 'Alice', phone: '380123' });

    assert.equal(result.removed, true);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].registrantName, 'Bob');
    assert.equal(result.entries[1].eventId, 'event-2');
});

test('removeEventRegistration removes the matching registration row from the registrations sheet', async () => {
    await withMockedSheets(async ({ batchUpdates }) => {
        const result = await registrationSheet.removeEventRegistration(
            { name: 'Alice', phone: '380123' },
            { id: 'event-1', name: 'Event One', date: new Date('2026-08-11T18:00:00Z') },
            { name: 'Alice', phone: '380123' }
        );

        assert.equal(result, true);
        assert.equal(batchUpdates.length, 1);
        assert.equal(batchUpdates[0].requestBody.requests[0].deleteDimension.range.dimension, 'ROWS');
    });
});

test('appendEventRegistration writes a single registration row for a new registration', async () => {
    await withMockedSheets(async ({ valuesAppends }) => {
        await registrationSheet.appendEventRegistration(
            { name: 'Alice', phone: '380123' },
            { id: 'event-1', name: 'Event One', date: new Date('2026-08-11T18:00:00Z') },
            { name: 'Alice', phone: '380123' }
        );

        assert.equal(valuesAppends.length, 1);
        assert.equal(valuesAppends[0].requestBody.values[0][3], 'Event One');
    });
});
