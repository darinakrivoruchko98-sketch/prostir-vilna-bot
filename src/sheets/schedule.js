const state = require('../state');
const config = require('../config');
const { parseEventFromRow } = require('../events/parser');
const { normalizeTitle } = require('../utils/text');

function normalizeRegistrantName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeRegistrantPhone(value) {
    return String(value || '').replace(/\D+/g, '');
}

async function getSheetIdByTitle(spreadsheetId, sheetTitle) {
    const meta = await state.sheetsClient.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties'
    });
    const sheets = (meta.data && meta.data.sheets) || [];
    const found = sheets.find((sheetItem) => {
        const title = sheetItem && sheetItem.properties && sheetItem.properties.title;
        return title === sheetTitle;
    });
    return found && found.properties ? found.properties.sheetId : null;
}

async function getScheduleCellNote(scheduleSheet, rowIndex) {
    const resp = await state.sheetsClient.spreadsheets.get({
        spreadsheetId: config.SPREADSHEET_ID,
        ranges: [`${scheduleSheet}!E${rowIndex + 1}`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values.note'
    });

    const sheets = (resp.data && resp.data.sheets) || [];
    const rowData = sheets[0] && sheets[0].data && sheets[0].data[0] && sheets[0].data[0].rowData;
    const cell = rowData && rowData[0] && rowData[0].values && rowData[0].values[0];
    return (cell && typeof cell.note === 'string') ? cell.note : '';
}

function parseRegistrantsFromNote(noteText) {
    if (!noteText) return [];
    const lines = String(noteText).split('\n');
    const parsed = [];
    for (const line of lines) {
        const match = line.match(/^\s*\d+\.\s*(.*?)\s*—\s*(.*?)\s*$/);
        if (!match) continue;
        const rawName = String(match[1] || '').trim();
        const rawPhone = String(match[2] || '').trim();
        const userMatch = rawName.match(/^user\s+(\d+)$/i);
        parsed.push({
            userId: userMatch ? String(userMatch[1] || '').trim() : '',
            name: userMatch ? '' : rawName,
            phone: /^без\s+номера$/i.test(rawPhone) ? '' : rawPhone
        });
    }
    return parsed;
}

async function isRegistrantAlreadyInEventNote(event, registrantProfile) {
    if (!event || !registrantProfile || !state.sheetsClient || !config.SPREADSHEET_ID) return false;

    const profileName = normalizeRegistrantName(registrantProfile.name);
    const profilePhone = normalizeRegistrantPhone(registrantProfile.phone);
    if (!profileName || !profilePhone) return false;

    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            });
            const rows = resp.data.values || [];
            for (let i = 0; i < rows.length; i++) {
                const parsedEvent = parseEventFromRow(rows[i], null).event;
                if (!parsedEvent) continue;

                const sameTitle = normalizeTitle(parsedEvent.name) === normalizeTitle(event.name);
                const sameMinute = Math.abs(parsedEvent.date.getTime() - event.date.getTime()) < 60 * 1000;
                if (!sameTitle || !sameMinute) continue;

                const noteText = await getScheduleCellNote(scheduleSheet, i);
                const registrants = parseRegistrantsFromNote(noteText);
                return registrants.some((item) => {
                    const itemName = normalizeRegistrantName(item.name);
                    const itemPhone = normalizeRegistrantPhone(item.phone);
                    return itemName === profileName && itemPhone === profilePhone;
                });
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            return false;
        }
    }

    return false;
}

async function buildRegistrantsNote(registrationsCount, fallbackRegistrant, existingNote) {
    const registrants = parseRegistrantsFromNote(existingNote);
    if (fallbackRegistrant) {
        const fallbackUserId = String(fallbackRegistrant.userId || '').trim();
        const fallbackName = String(fallbackRegistrant.name || '').trim();
        const fallbackPhone = String(fallbackRegistrant.phone || '').trim();

        if (fallbackName || fallbackPhone || fallbackUserId) {
            registrants.push({
                userId: fallbackUserId,
                name: fallbackName,
                phone: fallbackPhone
            });
        }
    }

    if (registrants.length === 0) {
        const safeCount = Number.isFinite(Number(registrationsCount)) ? Number(registrationsCount) : 0;
        return `Зареєстровано: ${safeCount}\n\nСписок порожній`;
    }

    const safeCount = Number.isFinite(Number(registrationsCount)) ? Number(registrationsCount) : 0;
    const displayCount = Math.max(safeCount, registrants.length);

    const lines = registrants.map((item, index) => {
        const name = item.name || `user ${item.userId}`;
        const phone = item.phone || 'без номера';
        return `${index + 1}. ${name} — ${phone}`;
    });

    return `Зареєстровано: ${displayCount}\n\n${lines.join('\n')}`;
}

async function updateScheduleRegistrationNote({ scheduleSheet, rowIndex, registrationsCount, fallbackRegistrant }) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return;
    const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, scheduleSheet);
    if (sheetId === null || sheetId === undefined) return;

    let existingNote = '';
    try {
        existingNote = await getScheduleCellNote(scheduleSheet, rowIndex);
    } catch (e) {
        existingNote = '';
    }
    const noteText = await buildRegistrantsNote(registrationsCount, fallbackRegistrant, existingNote);

    await state.sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: {
            requests: [{
                repeatCell: {
                    range: {
                        sheetId,
                        startRowIndex: rowIndex,
                        endRowIndex: rowIndex + 1,
                        startColumnIndex: 4,
                        endColumnIndex: 5
                    },
                    cell: {
                        note: noteText
                    },
                    fields: 'note'
                }
            }]
        }
    });
}

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

async function incrementSheetRegistration(event, fallbackRegistrant) {
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

                try {
                    await updateScheduleRegistrationNote({
                        scheduleSheet,
                        rowIndex: i,
                        registrationsCount: newReg,
                        fallbackRegistrant
                    });
                } catch (noteErr) {
                    console.error('Не вдалося оновити нотатку реєстрацій', noteErr && noteErr.message ? noteErr.message : noteErr);
                }

                event.seats = newCap;
                event.registrations = newReg;
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
    isRegistrantAlreadyInEventNote,
};
