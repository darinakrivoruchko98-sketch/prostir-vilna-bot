const state = require('../state');
const config = require('../config');
const { formatEventDate } = require('../utils/date');
const { incrementSheetRegistration, getScheduleEventSeatState } = require('./schedule');

function normalizeRegistrationName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeRegistrationPhone(value) {
    return String(value || '').replace(/\D+/g, '');
}

function normalizeRegistrationUserId(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeRegistrationDateValue(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    const digits = text.match(/\d+/g) || [];
    if (digits.length >= 3) {
        const [first, second, third] = digits.map(Number);
        if (third >= 1000) {
            const year = third;
            const month = first > 12 && second <= 12 ? second : first;
            const day = first > 12 && second <= 12 ? first : second;
            return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }

    return text.toLowerCase();
}

function buildRegistrationIdentity(registrantInfo = {}, fallbackUser = {}) {
    const resolved = registrantInfo || {};
    return {
        userId: normalizeRegistrationUserId(resolved.userId || fallbackUser.userId || fallbackUser.chatId || ''),
        name: String(resolved.name || fallbackUser.name || '').trim(),
        phone: normalizeRegistrationPhone(resolved.phone || fallbackUser.phone || '')
    };
}

function matchesRegistrationEntry(entry, eventId, registrantInfo = {}, fallbackUser = {}) {
    const target = buildRegistrationIdentity(registrantInfo, fallbackUser);
    const targetName = normalizeRegistrationName(target.name);
    const targetPhone = normalizeRegistrationPhone(target.phone);
    const targetUserId = normalizeRegistrationUserId(target.userId);

    const entryEventId = String(entry && entry.eventId || '').trim();
    const entryName = normalizeRegistrationName(entry && entry.registrantName || '');
    const entryPhone = normalizeRegistrationPhone(entry && entry.registrantPhone || '');
    const entryUserId = normalizeRegistrationUserId(entry && entry.userId || entry && entry.chatId || '');

    const sameEvent = !eventId || !entryEventId || entryEventId === String(eventId || '');
    if (!sameEvent) return false;

    if (targetUserId && entryUserId && targetUserId === entryUserId) return true;
    if (targetPhone && entryPhone && targetPhone === entryPhone) return true;
    if (targetName && entryName && targetName === entryName) return true;
    return false;
}

function removeRegistrationEntry(registrations = [], eventId, registrantInfo = {}, fallbackUser = {}) {
    if (!Array.isArray(registrations)) {
        return { removed: false, entries: [] };
    }

    const remaining = [];
    let removed = false;

    for (const entry of registrations) {
        if (!entry) {
            remaining.push(entry);
            continue;
        }

        const matches = matchesRegistrationEntry(entry, eventId, registrantInfo, fallbackUser);
        if (matches) {
            removed = true;
            continue;
        }

        remaining.push(entry);
    }

    return { removed, entries: remaining };
}

async function getSheetIdByTitle(spreadsheetId, sheetTitle) {
    if (!state.sheetsClient || !spreadsheetId || !sheetTitle) return null;
    if (!state.sheetsClient.spreadsheets || typeof state.sheetsClient.spreadsheets.get !== 'function') {
        return 0;
    }

    try {
        const metaResp = await state.sheetsClient.spreadsheets.get({
            spreadsheetId: spreadsheetId,
            fields: 'sheets(properties(sheetId,title))'
        });
        const sheets = (metaResp.data && metaResp.data.sheets) || [];
        const target = sheets.find((sheet) => {
            const title = sheet && sheet.properties && sheet.properties.title ? sheet.properties.title : '';
            return title === sheetTitle;
        });
        return target && target.properties ? target.properties.sheetId : null;
    } catch (error) {
        console.warn('getSheetIdByTitle failed', error && error.message ? error.message : error);
        return null;
    }
}

async function removeEventRegistration(user, event, registrantInfo = {}) {
    if (!state.sheetsClient) {
        console.warn('removeEventRegistration: sheetsClient not ready');
        return false;
    }
    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        console.warn('removeEventRegistration: PERSONAL_DATA_SPREADSHEET_ID not set');
        return false;
    }

    const profile = buildRegistrationIdentity(registrantInfo, user || {});
    const targetName = normalizeRegistrationName(profile.name);
    const targetPhone = normalizeRegistrationPhone(profile.phone);
    const targetEventName = String(event && event.name ? event.name : '').trim();
    const targetEventDate = event && event.date ? formatEventDate(event.date) : '';

    try {
        const resp = await state.sheetsClient.spreadsheets.values.get({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            range: `${config.REGISTRATIONS_SHEET_NAME}!A:E`
        });
        const rows = resp.data.values || [];
        const rowsToDelete = [];

        for (let index = 0; index < rows.length; index++) {
            const row = rows[index] || [];
            const rowName = String(row[1] || '').trim();
            const rowPhone = normalizeRegistrationPhone(row[2] || '');
            const rowEventName = String(row[3] || '').trim();
            const rowEventDate = String(row[4] || '').trim();
            const nameMatches = targetName && normalizeRegistrationName(rowName) === targetName;
            const phoneMatches = targetPhone && rowPhone === targetPhone;
            const eventNameMatches = !targetEventName || !rowEventName || normalizeRegistrationName(rowEventName) === normalizeRegistrationName(targetEventName);
            const dateMatches = !targetEventDate || !rowEventDate || normalizeRegistrationDateValue(rowEventDate) === normalizeRegistrationDateValue(targetEventDate) || normalizeRegistrationDateValue(rowEventDate) === normalizeRegistrationDateValue(formatEventDate(event.date));
            const eventMatches = eventNameMatches || dateMatches;
            if ((nameMatches || phoneMatches) && eventMatches) {
                rowsToDelete.push(index);
            }
        }

        if (rowsToDelete.length === 0) {
            return false;
        }

        const sheetId = await getSheetIdByTitle(config.PERSONAL_DATA_SPREADSHEET_ID, config.REGISTRATIONS_SHEET_NAME);
        if (sheetId === null || sheetId === undefined) {
            return false;
        }

        const requests = rowsToDelete.sort((a, b) => b - a).map((rowIndex) => ({
            deleteDimension: {
                range: {
                    sheetId,
                    startIndex: rowIndex,
                    endIndex: rowIndex + 1,
                    dimension: 'ROWS'
                }
            }
        }));

        await state.sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            requestBody: {
                requests
            }
        });

        return true;
    } catch (e) {
        console.error('removeEventRegistration error:', e && e.message ? e.message : e);
        return false;
    }
}

async function getSeatsLeft(eventId) {
    const event = state.events.find(e => e.id === eventId);
    if (!event) return 0;

    try {
        const seatState = await getScheduleEventSeatState(event);
        if (seatState && Number.isFinite(seatState.seatsLeft)) {
            return Math.max(0, seatState.seatsLeft);
        }
    } catch (error) {
        console.warn('getSeatsLeft: failed to read seat state from schedule', error && error.message ? error.message : error);
    }

    return Math.max(0, Number(event.seats) || 0);
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

    const profile = buildRegistrationIdentity(registrantInfo, user || {});
    const name = profile.name || '';
    const phone = profile.phone || '';

    const values = [
        new Date().toISOString(),
        name,
        phone,
        (event && event.name) || '',
        formatEventDate(event && event.date),
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
        console.log(`✅ Реєстрацію записано в "${config.REGISTRATIONS_SHEET_NAME}": ${name} -> ${(event && event.name) || ''}`);
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
    removeEventRegistration,
    removeRegistrationEntry,
};
