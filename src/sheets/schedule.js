const state = require('../state');
const config = require('../config');
const { parseEventFromRow } = require('../events/parser');
const { normalizeTitle } = require('../utils/text');

async function appendEventToSheet(date, time, title, capacity) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return;
    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            await state.sheetsClient.spreadsheets.values.append({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:D`,
                valueInputOption: "USER_ENTERED",
                requestBody: {
                    values: [[date, time, title, capacity]]
                }
            });
            console.log(`   ✅ Захід записано у Sheets (${scheduleSheet})`);
            return;
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            console.error('   ❌ Помилка запису у Sheets:', e.message);
            return;
        }
    }
    console.error(`   ❌ Не знайдено аркуш для запису розкладу (${config.SCHEDULE_SHEET_CANDIDATES.join(', ')})`);
}

async function incrementSheetRegistration(event) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return;
    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            });
            const rows = resp.data.values || [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const parsed = parseEventFromRow(row, null);
                const parsedEvent = parsed.event;
                if (!parsedEvent) continue;

                const sameTitle = normalizeTitle(parsedEvent.name) === normalizeTitle(event.name);
                const sameMinute = Math.abs(parsedEvent.date.getTime() - event.date.getTime()) < 60 * 1000;

                if (sameTitle && sameMinute) {
                const currReg = parseInt(row[4] || '0', 10);
                const newReg = currReg + 1;
                const currCap = parseInt(row[3] || '0', 10);
                const newCap = Math.max(0, currCap - 1);
                const range = `${scheduleSheet}!D${i+1}:E${i+1}`;
                console.log(`📈 Оновлюю лічильник реєстрацій: eventId=${event.id}, sheet=${scheduleSheet}, row=${i + 1}, seats ${currCap}->${newCap}, registrations ${currReg}->${newReg}`);
                await state.sheetsClient.spreadsheets.values.update({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[newCap, newReg]] }
                });
                console.log(`✅ Лічильник реєстрацій оновлено: eventId=${event.id}, range=${range}`);
                return;
            }
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            console.error('Error incrementing registration count', e);
            return;
        }
    }
    console.warn(`Не вдалося оновити лічильник у розкладі для eventId=${event.id}. Спробовано аркуші: ${config.SCHEDULE_SHEET_CANDIDATES.join(', ')}`);
}

module.exports = {
    appendEventToSheet,
    incrementSheetRegistration,
};
