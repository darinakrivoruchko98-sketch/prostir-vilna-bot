const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const { appendStatisticsReportRow, getStatisticsReportTarget } = require('../src/utils/statistics-report');

test('appendStatisticsReportRow uses the personal-data spreadsheet and creates the report sheet only when it is missing', async () => {
    const originalSheetsClient = state.sheetsClient;
    const originalSpreadsheetId = config.PERSONAL_DATA_SPREADSHEET_ID;
    const calls = [];

    state.sheetsClient = {
        spreadsheets: {
            get: async () => ({ data: { sheets: [] } }),
            batchUpdate: async (args) => {
                calls.push({ type: 'batchUpdate', args });
            },
            values: {
                append: async (args) => {
                    calls.push({ type: 'append', args });
                }
            }
        }
    };
    config.PERSONAL_DATA_SPREADSHEET_ID = 'spreadsheet-123';

    try {
        const target = getStatisticsReportTarget();
        assert.equal(target.spreadsheetId, 'spreadsheet-123');
        assert.equal(target.sheetName, 'Звіт');

        const ok = await appendStatisticsReportRow(
            { key: 'current-week', displayLabel: 'Поточний тиждень' },
            { totalUniquePeople: 2, status: {}, ageGroups: {}, specialNeeds: 0, eventRegistrationTotals: {} }
        );

        assert.equal(ok, true);
        assert.equal(calls[0].type, 'batchUpdate');
        assert.equal(calls[1].type, 'append');
        assert.equal(calls[1].args.spreadsheetId, 'spreadsheet-123');
        assert.equal(calls[1].args.range, 'Звіт!A:M');
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
    }
});
