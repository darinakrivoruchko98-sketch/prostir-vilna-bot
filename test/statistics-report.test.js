const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const { appendStatisticsReportRow, getStatisticsReportTarget } = require('../src/utils/statistics-report');

test('appendStatisticsReportRow skips duplicate rows for the same period key', async () => {
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
                get: async () => ({ data: { values: [['label', 'current-week', '2', '1', '0', '0', '0', '0', '0', '0', '0', '2026-08-11T00:00:00.000Z']] } }),
                append: async (args) => {
                    calls.push({ type: 'append', args });
                }
            }
        }
    };
    config.PERSONAL_DATA_SPREADSHEET_ID = 'spreadsheet-123';

    try {
        const ok = await appendStatisticsReportRow(
            { key: 'current-week', displayLabel: 'Поточний тиждень' },
            { totalUniquePeople: 2, status: {}, ageGroups: {}, specialNeeds: 0, totalRegistered: 4 }
        );

        assert.equal(ok, true);
        assert.equal(calls.some((call) => call.type === 'append'), false);
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
    }
});

test('appendStatisticsReportRow updates the existing row for the active current period', async () => {
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
                get: async () => ({ data: { values: [['label', 'week:2026-08-10', '2', '1', '0', '0', '0', '0', '0', '0', '0', '2026-08-11T00:00:00.000Z']] } }),
                update: async (args) => {
                    calls.push({ type: 'update', args });
                },
                append: async (args) => {
                    calls.push({ type: 'append', args });
                }
            }
        }
    };
    config.PERSONAL_DATA_SPREADSHEET_ID = 'spreadsheet-123';

    try {
        const ok = await appendStatisticsReportRow(
            { key: 'week:2026-08-10', kind: 'current-week', startDate: '2026-08-10', endDate: '2026-08-16', displayLabel: '📊 Поточний тиждень' },
            { totalUniquePeople: 5, status: {}, ageGroups: {}, specialNeeds: 0, totalRegistered: 7 }
        );

        assert.equal(ok, true);
        assert.equal(calls.some((call) => call.type === 'append'), false);
        assert.equal(calls.some((call) => call.type === 'update'), true);
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
    }
});

test('appendStatisticsReportRow preserves closed periods as immutable history', async () => {
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
                get: async () => ({ data: { values: [['label', 'week:2026-08-03', '2', '1', '0', '0', '0', '0', '0', '0', '0', '2026-08-11T00:00:00.000Z']] } }),
                update: async (args) => {
                    calls.push({ type: 'update', args });
                },
                append: async (args) => {
                    calls.push({ type: 'append', args });
                }
            }
        }
    };
    config.PERSONAL_DATA_SPREADSHEET_ID = 'spreadsheet-123';

    try {
        const ok = await appendStatisticsReportRow(
            { key: 'week:2026-08-03', kind: 'previous-week', displayLabel: '📊 Попередній тиждень' },
            { totalUniquePeople: 5, status: {}, ageGroups: {}, specialNeeds: 0, totalRegistered: 7 }
        );

        assert.equal(ok, true);
        assert.equal(calls.some((call) => call.type === 'append'), false);
        assert.equal(calls.some((call) => call.type === 'update'), false);
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
    }
});

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
                get: async () => ({ data: { values: [] } }),
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
            { totalUniquePeople: 2, status: {}, ageGroups: {}, specialNeeds: 0, totalRegistered: 4 }
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
