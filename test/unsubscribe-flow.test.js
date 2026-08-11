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
