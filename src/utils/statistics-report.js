const state = require('../state');
const config = require('../config');

function getReportSheetName() {
    return process.env.STATISTICS_REPORT_SHEET_NAME || 'Звіт';
}

function getStatisticsReportTarget() {
    return {
        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
        sheetName: getReportSheetName()
    };
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

async function ensureStatisticsReportSheet(spreadsheetId, sheetName) {
    if (!state.sheetsClient || !spreadsheetId || !sheetName) {
        return false;
    }

    try {
        const response = await state.sheetsClient.spreadsheets.get({ spreadsheetId });
        const existingSheets = response && response.data && Array.isArray(response.data.sheets) ? response.data.sheets : [];
        const sheetExists = existingSheets.some((sheet) => {
            const title = sheet && sheet.properties && sheet.properties.title;
            return title === sheetName;
        });

        if (sheetExists) {
            return true;
        }

        await state.sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [{
                    addSheet: {
                        properties: {
                            title: sheetName,
                            gridProperties: {
                                rowCount: 1000,
                                columnCount: 13
                            }
                        }
                    }
                }]
            }
        });

        return true;
    } catch (error) {
        return false;
    }
}

async function appendStatisticsReportRow(period, snapshot) {
    const target = getStatisticsReportTarget();
    if (!state.sheetsClient || !target.spreadsheetId || !target.sheetName) {
        return false;
    }

    const sheetName = target.sheetName;
    try {
        const sheetReady = await ensureStatisticsReportSheet(target.spreadsheetId, sheetName);
        if (!sheetReady) {
            return false;
        }

        await state.sheetsClient.spreadsheets.values.append({
            spreadsheetId: target.spreadsheetId,
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
    ensureStatisticsReportSheet,
    getReportSheetName,
    getStatisticsReportTarget
};
