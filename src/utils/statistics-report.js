const state = require('../state');
const config = require('../config');
const { retryRequest } = require('../sheets/schedule');

function getReportSheetName() {
    return process.env.STATISTICS_REPORT_SHEET_NAME || 'Звіт';
}

function buildReportRow(period, snapshot) {
    return [
        period && period.displayLabel ? period.displayLabel : '',
        period && period.key ? period.key : '',
        snapshot && Number.isFinite(snapshot.totalUniquePeople) ? snapshot.totalUniquePeople : 0,
        snapshot && snapshot.status ? snapshot.status['ВПО'] || 0 : 0,
        snapshot && snapshot.status ? snapshot.status['Не ВПО, постраждали від війни'] || 0 : 0,
        snapshot && snapshot.status ? snapshot.status['Не ВПО, не постраждали від війни'] || 0 : 0,
        snapshot && snapshot.ageGroups ? snapshot.ageGroups['до 18 років'] || 0 : 0,
        snapshot && snapshot.ageGroups ? snapshot.ageGroups['18–59 років'] || 0 : 0,
        snapshot && snapshot.ageGroups ? snapshot.ageGroups['60+ років'] || 0 : 0,
        snapshot && Number.isFinite(snapshot.specialNeeds) ? snapshot.specialNeeds : 0,
        snapshot && snapshot.eventRegistrationTotals ? Object.values(snapshot.eventRegistrationTotals).reduce((sum, entry) => sum + (Number(entry && entry.registrationCount) || 0), 0) : 0,
        new Date().toISOString()
    ];
}

async function appendStatisticsReportRow(period, snapshot) {
    if (!state.sheetsClient || !config.PERSONAL_DATA_SPREADSHEET_ID) {
        return false;
    }

    const sheetName = getReportSheetName();
    try {
        await state.sheetsClient.spreadsheets.values.append({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            range: `${sheetName}!A:M`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [buildReportRow(period, snapshot)] }
        });
        return true;
    } catch (error) {
        return false;
    }
}

module.exports = {
    appendStatisticsReportRow,
    buildReportRow,
    getReportSheetName
};
