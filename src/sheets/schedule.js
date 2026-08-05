const state = require('../state');
const config = require('../config');
const { parseEventFromRow } = require('../events/parser');
const { normalizeTitle } = require('../utils/text');
const logger = require('../utils/logging');
const { invalidateCache } = require('./cache');

// Simple retry/backoff helper for Sheets calls
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
async function retryRequest(fn, opts = {}) {
    const attempts = Number.isInteger(opts.attempts) ? opts.attempts : 5;
    const base = Number.isFinite(opts.base) ? opts.base : 200;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const msg = (err && err.message) ? String(err.message).toLowerCase() : '';
            // Non-retriable errors
            if (msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('notFound')) {
                throw err;
            }
            if (attempt === attempts - 1) {
                throw err;
            }
            const jitter = Math.floor(Math.random() * 100);
            const wait = base * Math.pow(2, attempt) + jitter;
            logger.warn('Sheets request failed, retrying', attempt + 1, 'wait', wait, 'ms', err && err.message ? err.message : err);
            await sleep(wait);
        }
    }
}

// Recent actions for undo (keyed by actor chatId)
const recentActions = new Map();
function recordRecentAction(actorId, action) {
    if (!actorId) return;
    recentActions.set(String(actorId), { action, ts: Date.now() });
}

async function undoLastAction(actorId) {
    if (!actorId) return false;
    const entry = recentActions.get(String(actorId));
    if (!entry || !entry.action) return false;
    const a = entry.action;
    try {
        if (a.type === 'register') {
            // reverse registration: decrement counts and remove registrant from note
            const event = a.event;
            const registrant = a.registrant;
            if (!event) throw new Error('No event in action');
            // find row
            let match = await findScheduleRowByEventByNoteTag(event);
            if (!match) {
                // fallback search by title/time
                match = await (async function() {
                    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
                        try {
                            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                                spreadsheetId: config.SPREADSHEET_ID,
                                range: `${scheduleSheet}!A:E`
                            }));
                            const rows = resp.data.values || [];
                            for (let i = 0; i < rows.length; i++) {
                                const parsedEvent = parseEventFromRow(rows[i], null).event;
                                if (!parsedEvent) continue;
                                const sameTitle = normalizeTitle(parsedEvent.name) === normalizeTitle(event.name);
                                const sameMinute = Math.abs(parsedEvent.date.getTime() - event.date.getTime()) < 60 * 1000;
                                if (sameTitle && sameMinute) return { scheduleSheet, rowIndex: i };
                            }
                        } catch (e) { continue; }
                    }
                    return null;
                })();
            }
            if (!match) throw new Error('Row not found for undo');
            const scheduleSheet = match.scheduleSheet;
            const rowIndex = match.rowIndex;
            // read current D/E
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`
            }));
            const vals = (resp.data && resp.data.values && resp.data.values[0]) || [];
            const currD = parseInt(vals[0] || '0', 10);
            const currE = parseInt(vals[1] || '0', 10);
            const newE = Math.max(0, currE - 1);
            const newD = currD + 1;
            if (newE !== currE || newD !== currD) {
                await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[String(newD), String(newE)]] }
                }));
            }
            // remove registrant from note
            await updateScheduleRegistrationNote({ scheduleSheet, rowIndex, registrationsCount: newE, removeRegistrant: registrant, eventId: event.id });
            recentActions.delete(String(actorId));
            return true;
        }
        if (a.type === 'unregister') {
            // reverse unregister: increment counts and re-add registrant
            const event = a.event;
            const registrant = a.registrant;
            if (!event) throw new Error('No event in action');
            let match = await findScheduleRowByEventByNoteTag(event);
            if (!match) {
                // fallback search
                match = await (async function() {
                    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
                        try {
                            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                                spreadsheetId: config.SPREADSHEET_ID,
                                range: `${scheduleSheet}!A:E`
                            }));
                            const rows = resp.data.values || [];
                            for (let i = 0; i < rows.length; i++) {
                                const parsedEvent = parseEventFromRow(rows[i], null).event;
                                if (!parsedEvent) continue;
                                const sameTitle = normalizeTitle(parsedEvent.name) === normalizeTitle(event.name);
                                const sameMinute = Math.abs(parsedEvent.date.getTime() - event.date.getTime()) < 60 * 1000;
                                if (sameTitle && sameMinute) return { scheduleSheet, rowIndex: i };
                            }
                        } catch (e) { continue; }
                    }
                    return null;
                })();
            }
            if (!match) throw new Error('Row not found for undo');
            const scheduleSheet = match.scheduleSheet;
            const rowIndex = match.rowIndex;
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`
            }));
            const vals = (resp.data && resp.data.values && resp.data.values[0]) || [];
            const currD = parseInt(vals[0] || '0', 10);
            const currE = parseInt(vals[1] || '0', 10);
            const newE = currE + 1;
            const newD = Math.max(0, currD - 1);
            if (newE !== currE || newD !== currD) {
                await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[String(newD), String(newE)]] }
                }));
            }
            await updateScheduleRegistrationNote({ scheduleSheet, rowIndex, registrationsCount: newE, fallbackRegistrant: registrant, eventId: event.id });
            recentActions.delete(String(actorId));
            return true;
        }
    } catch (err) {
        logger.error('Undo failed for actor', actorId, err && err.message ? err.message : err);
        return false;
    }
    return false;
}

function normalizeRegistrantName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeRegistrantPhone(value) {
    return String(value || '').replace(/\D+/g, '');
}

function formatRegistrantLine(item, index) {
    const name = item.name || `user ${item.userId}`;
    const phone = item.phone || 'без номера';
    return `${index + 1}. ${name} — ${phone}`;
}

function parseScheduleNoteSections(noteText) {
    const sections = {
        registered: [],
        reserve: []
    };

    let currentSection = 'registered';
    const lines = String(noteText || '').split(/\r?\n/);

    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        if (/^EVENT_ID\s*:/i.test(line)) continue;
        if (/^Зареєстровано\s*:/i.test(line)) {
            currentSection = 'registered';
            continue;
        }
        if (/^Резерв\s*:/i.test(line)) {
            currentSection = 'reserve';
            continue;
        }
        if (/^Список порожній$/i.test(line)) continue;

        const match = line.match(/^\s*\d+\.\s*(.*?)\s*—\s*(.*?)\s*$/);
        if (!match) continue;

        const rawName = String(match[1] || '').trim();
        const rawPhone = String(match[2] || '').trim();
        const userMatch = rawName.match(/^user\s+(\d+)$/i);
        const entry = {
            userId: userMatch ? String(userMatch[1] || '').trim() : '',
            name: userMatch ? '' : rawName,
            phone: /^без\s+номера$/i.test(rawPhone) ? '' : rawPhone
        };

        if (currentSection === 'reserve') {
            sections.reserve.push(entry);
        } else {
            sections.registered.push(entry);
        }
    }

    return sections;
}

function buildScheduleNoteText({ registered = [], reserve = [], registrationsCount = 0, eventId = '' } = {}) {
    const safeRegisteredCount = Number.isFinite(Number(registrationsCount)) ? Number(registrationsCount) : 0;
    const registeredLines = registered.map((item, index) => formatRegistrantLine(item, index));
    const reserveLines = reserve.map((item, index) => formatRegistrantLine(item, index));

    const parts = [];
    if (registeredLines.length === 0) {
        parts.push(`Зареєстровано: ${safeRegisteredCount}\n\nСписок порожній`);
    } else {
        parts.push(`Зареєстровано: ${Math.max(safeRegisteredCount, registeredLines.length)}\n\n${registeredLines.join('\n')}`);
    }

    if (reserveLines.length > 0) {
        parts.push(`Резерв: ${reserveLines.length}\n\n${reserveLines.join('\n')}`);
    }

    return ensureScheduleNoteEventIdTag(parts.join('\n\n'), eventId);
}

const SCHEDULE_NOTE_EVENT_ID_TAG = 'EVENT_ID:';

function extractScheduleNoteEventId(noteText) {
    if (!noteText) return '';
    const lines = String(noteText).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
        const match = line.match(/^EVENT_ID\s*:\s*(.+)$/i);
        if (match) {
            return String(match[1] || '').trim();
        }
    }
    return '';
}

function removeScheduleNoteEventIdTag(noteText) {
    if (!noteText) return '';
    return String(noteText).split(/\r?\n/)
        .filter((line) => !/^EVENT_ID\s*:/i.test(String(line).trim()))
        .join('\n')
        .trim();
}

function ensureScheduleNoteEventIdTag(noteText, eventId) {
    const cleaned = removeScheduleNoteEventIdTag(noteText || '');
    if (!eventId) {
        return cleaned;
    }
    if (!cleaned) {
        return `${SCHEDULE_NOTE_EVENT_ID_TAG}${eventId}`;
    }
    return `${cleaned}\n\n${SCHEDULE_NOTE_EVENT_ID_TAG}${eventId}`;
}

async function getSheetIdByTitle(spreadsheetId, sheetTitle) {
    const meta = await retryRequest(() => state.sheetsClient.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties'
    }));
    const sheets = (meta.data && meta.data.sheets) || [];
    const found = sheets.find((sheetItem) => {
        const title = sheetItem && sheetItem.properties && sheetItem.properties.title;
        return title === sheetTitle;
    });
    return found && found.properties ? found.properties.sheetId : null;
}

async function getScheduleCellNote(scheduleSheet, rowIndex) {
    const resp = await retryRequest(() => state.sheetsClient.spreadsheets.get({
        spreadsheetId: config.SPREADSHEET_ID,
        ranges: [`${scheduleSheet}!E${rowIndex + 1}`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values.note'
    }));

    const sheets = (resp.data && resp.data.sheets) || [];
    const rowData = sheets[0] && sheets[0].data && sheets[0].data[0] && sheets[0].data[0].rowData;
    const cell = rowData && rowData[0] && rowData[0].values && rowData[0].values[0];
    return (cell && typeof cell.note === 'string') ? cell.note : '';
}

function parseRegistrantsFromNote(noteText) {
    const sections = parseScheduleNoteSections(noteText);
    return [...sections.registered, ...sections.reserve];
}

async function findScheduleRowByEventByNoteTag(event) {
    if (!event || !event.id || !state.sheetsClient || !config.SPREADSHEET_ID) return null;

    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.get({
                spreadsheetId: config.SPREADSHEET_ID,
                ranges: [`${scheduleSheet}!E:E`],
                includeGridData: true,
                fields: 'sheets(data(rowData(values(note))))'
            }));

            const noteRows = resp
                && resp.data
                && resp.data.sheets
                && resp.data.sheets[0]
                && resp.data.sheets[0].data
                && resp.data.sheets[0].data[0]
                && Array.isArray(resp.data.sheets[0].data[0].rowData)
                ? resp.data.sheets[0].data[0].rowData
                : [];

            for (const [rowIndex, rowDataRow] of noteRows.entries()) {
                const cell = rowDataRow && rowDataRow.values && rowDataRow.values[0];
                const note = cell && typeof cell.note === 'string' ? cell.note : '';
                if (!note) continue;
                const noteEventId = extractScheduleNoteEventId(note);
                if (noteEventId && noteEventId === event.id) {
                    return { scheduleSheet, rowIndex };
                }
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            logger.error(`Error finding event row by note marker in sheet ${scheduleSheet}:`, e && e.message ? e.message : e);
        }
    }

    return null;
}

async function findScheduleRowForEvent(event) {
    const byTag = await findScheduleRowByEventByNoteTag(event);
    if (byTag) return byTag;

    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            }));
            const rows = resp.data.values || [];
            for (let i = 0; i < rows.length; i++) {
                const parsedEvent = parseEventFromRow(rows[i], null).event;
                if (!parsedEvent) continue;

                const sameTitle = normalizeTitle(parsedEvent.name) === normalizeTitle(event.name);
                const sameMinute = Math.abs(parsedEvent.date.getTime() - event.date.getTime()) < 60 * 1000;
                if (sameTitle && sameMinute) {
                    return { scheduleSheet, rowIndex: i };
                }
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
        }
    }

    return null;
}

async function isRegistrantAlreadyInEventNote(event, registrantProfile) {
    if (!event || !registrantProfile || !state.sheetsClient || !config.SPREADSHEET_ID) return false;

    const profileName = normalizeRegistrantName(registrantProfile.name);
    const profilePhone = normalizeRegistrantPhone(registrantProfile.phone);
    if (!profileName || !profilePhone) return false;

    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            }));
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

async function buildRegistrantsNote(registrationsCount, fallbackRegistrant, existingNote, eventId = '') {
    const sections = parseScheduleNoteSections(existingNote);
    const registrants = sections.registered.slice();
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

    return buildScheduleNoteText({
        registered: registrants,
        reserve: sections.reserve,
        registrationsCount,
        eventId: eventId || extractScheduleNoteEventId(existingNote)
    });
}

async function appendEventReservation(event, fallbackRegistrant) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return { status: 'no-client' };

    const match = await findScheduleRowForEvent(event);
    if (!match) return { status: 'not-found' };

    const { scheduleSheet, rowIndex } = match;
    const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`
    }));
    const vals = (resp.data && resp.data.values && resp.data.values[0]) || [];
    const currRegistrations = parseInt(vals[1] || '0', 10);
    const existingNote = await getScheduleCellNote(scheduleSheet, rowIndex);
    const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, scheduleSheet);
    const sections = parseScheduleNoteSections(existingNote);

    const profile = {
        userId: String((fallbackRegistrant && fallbackRegistrant.userId) || '').trim(),
        name: String((fallbackRegistrant && fallbackRegistrant.name) || '').trim(),
        phone: String((fallbackRegistrant && fallbackRegistrant.phone) || '').trim()
    };

    const profileName = normalizeRegistrantName(profile.name);
    const profilePhone = normalizeRegistrantPhone(profile.phone);
    const profileUserId = String(profile.userId || '').trim();

    const allEntries = [...sections.registered, ...sections.reserve];
    const alreadyExists = allEntries.some((item) => {
        const itemName = normalizeRegistrantName(item.name || '');
        const itemPhone = normalizeRegistrantPhone(item.phone || '');
        const itemUserId = String(item.userId || '').trim();
        return (profileUserId && itemUserId && profileUserId === itemUserId) ||
            (profileName && itemName && profileName === itemName && profilePhone && itemPhone && profilePhone === itemPhone);
    });

    if (alreadyExists) {
        return { status: 'already-registered' };
    }

    sections.reserve.push(profile);
    const noteText = buildScheduleNoteText({
        registered: sections.registered,
        reserve: sections.reserve,
        registrationsCount: currRegistrations,
        eventId: event.id
    });

    if (String(existingNote || '').trim() !== String(noteText || '').trim()) {
        await retryRequest(() => state.sheetsClient.spreadsheets.batchUpdate({
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
                        cell: { note: noteText },
                        fields: 'note'
                    }
                }]
            }
        }));
    }

    return { status: 'ok' };
}

async function promoteReserveRegistrantsIfNeeded(event, previousSeats) {
    if (!event || !state.sheetsClient || !config.SPREADSHEET_ID) return { promoted: 0, reserveLeft: 0 };

    const match = await findScheduleRowForEvent(event);
    if (!match) return { promoted: 0, reserveLeft: 0 };

    const { scheduleSheet, rowIndex } = match;
    const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`
    }));
    const vals = (resp.data && resp.data.values && resp.data.values[0]) || [];
    const currSeats = parseInt(vals[0] || '0', 10);
    const currRegistrations = parseInt(vals[1] || '0', 10);
    const increase = Math.max(0, currSeats - Math.max(0, parseInt(previousSeats || '0', 10)));
    if (increase <= 0) return { promoted: 0, reserveLeft: 0 };

    const existingNote = await getScheduleCellNote(scheduleSheet, rowIndex);
    const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, scheduleSheet);
    const sections = parseScheduleNoteSections(existingNote);
    if (sections.reserve.length === 0) return { promoted: 0, reserveLeft: 0 };

    const promoted = sections.reserve.splice(0, Math.min(increase, sections.reserve.length));
    if (promoted.length === 0) return { promoted: 0, reserveLeft: sections.reserve.length };

    const newSeats = Math.max(0, currSeats - promoted.length);
    const newRegistrations = currRegistrations + promoted.length;

    await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[String(newSeats), String(newRegistrations)]] }
    }));
    invalidateCache('schedule');

    const noteText = buildScheduleNoteText({
        registered: [...sections.registered, ...promoted],
        reserve: sections.reserve,
        registrationsCount: newRegistrations,
        eventId: event.id
    });

    if (String(existingNote || '').trim() !== String(noteText || '').trim()) {
        await retryRequest(() => state.sheetsClient.spreadsheets.batchUpdate({
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
                        cell: { note: noteText },
                        fields: 'note'
                    }
                }]
            }
        }));
    }

    event.seats = newSeats;
    event.registrations = newRegistrations;

    if (state.bot && typeof state.bot.sendMessage === 'function') {
        for (const person of promoted) {
            const userId = String(person.userId || '').trim();
            if (!userId) continue;
            try {
                await state.bot.sendMessage(userId, `✅ Вас перенесли з резерву до реєстрації на захід «${event.name}».`);
            } catch (notifyErr) {
                logger.warn('Failed to notify promoted reserve user', userId, notifyErr && notifyErr.message ? notifyErr.message : notifyErr);
            }
        }
    }

    return { promoted: promoted.length, reserveLeft: sections.reserve.length };
}

async function updateScheduleRegistrationNote({ scheduleSheet, rowIndex, registrationsCount, fallbackRegistrant, eventId, removeRegistrant }) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return;
    const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, scheduleSheet);
    if (sheetId === null || sheetId === undefined) return;

    let existingNote = '';
    try {
        existingNote = await getScheduleCellNote(scheduleSheet, rowIndex);
    } catch (e) {
        existingNote = '';
    }
    let noteText = '';
    if (removeRegistrant) {
        // remove matching registrant from existing note
        const sections = parseScheduleNoteSections(existingNote);
        const parsed = sections.registered;
        const remName = normalizeRegistrantName(removeRegistrant.name || '');
        const remPhone = normalizeRegistrantPhone(removeRegistrant.phone || '');
        const filtered = parsed.filter((it) => {
            const itName = normalizeRegistrantName(it.name || '');
            const itPhone = normalizeRegistrantPhone(it.phone || '');
            const itUser = String(it.userId || '').trim();
            const remUser = String(removeRegistrant.userId || '').trim();
            if (remUser && itUser && remUser === itUser) return false;
            if (remPhone && itPhone && remPhone === itPhone) return false;
            if (remName && itName && remName === itName) return false;
            return true;
        });

        const safeCount = Number.isFinite(Number(registrationsCount)) ? Number(registrationsCount) : 0;
        const displayCount = Math.max(safeCount, filtered.length);
        noteText = buildScheduleNoteText({
            registered: filtered,
            reserve: sections.reserve,
            registrationsCount: displayCount,
            eventId: eventId || extractScheduleNoteEventId(existingNote)
        });
    } else {
        const sections = parseScheduleNoteSections(existingNote);
        const fallbackToAdd = fallbackRegistrant ? {
            userId: String(fallbackRegistrant.userId || '').trim(),
            name: String(fallbackRegistrant.name || '').trim(),
            phone: String(fallbackRegistrant.phone || '').trim()
        } : null;

        if (fallbackToAdd && (fallbackToAdd.name || fallbackToAdd.phone || fallbackToAdd.userId)) {
            sections.registered.push(fallbackToAdd);
        }

        noteText = buildScheduleNoteText({
            registered: sections.registered,
            reserve: sections.reserve,
            registrationsCount,
            eventId
        });
    }

    if (String(existingNote || '').trim() === String(noteText || '').trim()) {
        logger.info('No change to schedule note, skipping batchUpdate', scheduleSheet, rowIndex);
        return;
    }

    await retryRequest(() => state.sheetsClient.spreadsheets.batchUpdate({
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
    }));
    invalidateCache('schedule');
}

async function appendEventToSheet(date, time, title, capacity) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return;
    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            await retryRequest(() => state.sheetsClient.spreadsheets.values.append({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:D`,
                valueInputOption: "USER_ENTERED",
                requestBody: {
                    values: [[date, time, title, capacity]]
                }
            }));
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

    const markerMatch = await findScheduleRowByEventByNoteTag(event);
    if (markerMatch) {
        const scheduleSheet = markerMatch.scheduleSheet;
        const rowIndex = markerMatch.rowIndex;
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`
            }));
            const row = (resp.data.values || [])[0] || [];
            const currReg = parseInt(row[1] || '0', 10);
            const currCap = parseInt(row[0] || '0', 10);
            const newReg = currReg + 1;
            const newCap = Math.max(0, currCap - 1);
            const range = `${scheduleSheet}!D${rowIndex + 1}:E${rowIndex + 1}`;
            logger.info(`Updating registration counts: eventId=${event.id}, sheet=${scheduleSheet}, row=${rowIndex + 1}`, `seats ${currCap}->${newCap}`, `registrations ${currReg}->${newReg}`);
            await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.SPREADSHEET_ID,
                range,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[newCap, newReg]] }
            }));
            invalidateCache('schedule');

            try {
                await updateScheduleRegistrationNote({
                    scheduleSheet,
                    rowIndex,
                    registrationsCount: newReg,
                    fallbackRegistrant,
                    eventId: event.id
                });
            } catch (noteErr) {
                logger.error('Failed to update registration note', noteErr && noteErr.message ? noteErr.message : noteErr);
            }

            event.seats = newCap;
            event.registrations = newReg;
            try {
                recordRecentAction((fallbackRegistrant && fallbackRegistrant.userId) || '', {
                    type: 'register', event, registrant: { name: fallbackRegistrant && fallbackRegistrant.name, phone: fallbackRegistrant && fallbackRegistrant.phone }
                });
            } catch (recErr) { logger.warn('Failed to record recent action', recErr && recErr.message ? recErr.message : recErr); }
            return;
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (!msg.includes('unable to parse range') && !msg.includes('not found')) {
                logger.error('Error incrementing registration count', e && e.message ? e.message : e);
                return;
            }
        }
    }

    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!D:E`
            }));
            const rows = resp.data.values || [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const currReg = parseInt(row[1] || '0', 10);
                const currCap = parseInt(row[0] || '0', 10);
                const newReg = currReg + 1;
                const newCap = Math.max(0, currCap - 1);
                const range = `${scheduleSheet}!D${i+1}:E${i+1}`;
                logger.info(`Updating registration counts: eventId=${event.id}, sheet=${scheduleSheet}, row=${i + 1}`, `seats ${currCap}->${newCap}`, `registrations ${currReg}->${newReg}`);
                await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[newCap, newReg]] }
                }));
                invalidateCache('schedule');

                try {
                    await updateScheduleRegistrationNote({
                        scheduleSheet,
                        rowIndex: i,
                        registrationsCount: newReg,
                        fallbackRegistrant,
                        eventId: event.id
                    });
                } catch (noteErr) {
                    logger.error('Failed to update registration note', noteErr && noteErr.message ? noteErr.message : noteErr);
                }

                event.seats = newCap;
                event.registrations = newReg;
                try {
                    recordRecentAction((fallbackRegistrant && fallbackRegistrant.userId) || '', {
                        type: 'register', event, registrant: { name: fallbackRegistrant && fallbackRegistrant.name, phone: fallbackRegistrant && fallbackRegistrant.phone }
                    });
                } catch (recErr) { logger.warn('Failed record recent action', recErr && recErr.message ? recErr.message : recErr); }
                return;
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            logger.error('Error incrementing registration count', e && e.message ? e.message : e);
            return;
        }
    }
    logger.warn(`Не вдалося оновити лічильник у розкладі для eventId=${event.id}. Спробовано аркуші: ${config.SCHEDULE_SHEET_CANDIDATES.join(', ')}`);
}

module.exports = {
    appendEventToSheet,
    appendEventReservation,
    buildScheduleNoteText,
    incrementSheetRegistration,
    isRegistrantAlreadyInEventNote,
    parseScheduleNoteSections,
    promoteReserveRegistrantsIfNeeded,
    undoLastSheetsAction: undoLastAction
};
