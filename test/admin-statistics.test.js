const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const config = require('../src/config');
const { handleStatistics } = require('../src/handlers/admin');
const statistics = require('../src/utils/statistics');
const statisticsReport = require('../src/utils/statistics-report');

test('handleStatistics generates a snapshot and appends it to the report sheet', async () => {
    const originalSheetsClient = state.sheetsClient;
    const originalSpreadsheetId = config.PERSONAL_DATA_SPREADSHEET_ID;
    const originalBuild = statistics.buildStatisticsSnapshotForSelection;
    const originalAppend = statisticsReport.appendStatisticsReportRow;

    state.sheetsClient = { spreadsheets: { values: { get: async () => ({ data: { values: [] } }) } } };
    config.PERSONAL_DATA_SPREADSHEET_ID = 'spreadsheet-123';

    const sentMessages = [];
    const appended = [];
    const fakeBot = {
        sendMessage: async (chatId, text, options) => {
            sentMessages.push({ chatId, text, options });
        }
    };

    statistics.buildStatisticsSnapshotForSelection = async () => ({
        period: { displayLabel: '📊 Поточний тиждень' },
        totalUniquePeople: 3,
        totalRegistered: 5,
        status: {},
        ageGroups: {},
        specialNeeds: 1,
        eventRegistrationTotals: {}
    });
    statisticsReport.appendStatisticsReportRow = async (period, snapshot) => {
        appended.push({ period, snapshot });
        return true;
    };

    try {
        await handleStatistics(fakeBot, 42);

        assert.equal(appended.length, 1);
        assert.ok(sentMessages.some((message) => message.text.includes('🧮 Статистика')));
    } finally {
        state.sheetsClient = originalSheetsClient;
        config.PERSONAL_DATA_SPREADSHEET_ID = originalSpreadsheetId;
        statistics.buildStatisticsSnapshotForSelection = originalBuild;
        statisticsReport.appendStatisticsReportRow = originalAppend;
    }
});
