const state = require('../state');
const config = require('../config');
const { formatEventDate } = require('../utils/date');

async function getSeatsLeft(eventId) {
    const event = state.events.find(e => e.id === eventId);
    if (!event) return 0;
    return event.seats;
}

async function appendEventRegistration(user, event) {
    if (!state.sheetsClient) {
        console.warn('appendEventRegistration: sheetsClient not ready');
        return;
    }
    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        console.warn('appendEventRegistration: PERSONAL_DATA_SPREADSHEET_ID not set');
        return;
    }

    const values = [
        new Date().toISOString(),
        user.name || '',
        user.phone || '',
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
        console.log(`✅ Реєстрацію записано в "${config.REGISTRATIONS_SHEET_NAME}": ${user.name} -> ${event.name}`);
    } catch (e) {
        console.error('appendEventRegistration error:', e && e.message ? e.message : e);
    }
}

module.exports = {
    appendEventRegistration,
    getSeatsLeft,
};
