const state = require('../state');
const config = require('../config');
const { formatEventDate } = require('../utils/date');
const { incrementSheetRegistration } = require('./schedule');

async function getSeatsLeft(eventId) {
    const event = state.events.find(e => e.id === eventId);
    if (!event) return 0;
    return event.seats;
}

async function appendEventRegistration(user, event, registrantInfo) {
    if (!state.sheetsClient) {
        console.warn('appendEventRegistration: sheetsClient not ready');
        return;
    }
    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        console.warn('appendEventRegistration: PERSONAL_DATA_SPREADSHEET_ID not set');
        return;
    }

    const name = (registrantInfo && registrantInfo.name) || user.name || '';
    const phone = (registrantInfo && registrantInfo.phone) || user.phone || '';

    const values = [
        new Date().toISOString(),
        name,
        phone,
        event.name || '',
        formatEventDate(event.date),
    ];

    try {
        await state.sheetsClient.spreadsheets.values.append({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            range: `${config.REGISTRATIONS_SHEET_NAME}!A:E`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [values],
            },
        });
        console.log(`✅ Реєстрацію записано в "${config.REGISTRATIONS_SHEET_NAME}": ${name} -> ${event.name}`);
    } catch (e) {
        console.error('appendEventRegistration error:', e && e.message ? e.message : e);
    }
}

async function registerAndSyncToSheets(user, event, registrantInfo) {
    await appendEventRegistration(user, event, registrantInfo);
    if (event && state.sheetsClient) {
        await incrementSheetRegistration(event, registrantInfo || { name: user.name, phone: user.phone });
    }
}

module.exports = {
    appendEventRegistration,
    registerAndSyncToSheets,
    getSeatsLeft,
};
