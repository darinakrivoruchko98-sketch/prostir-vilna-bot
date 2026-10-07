const state = require('../state');
const config = require('../config');
const { parseEventFromRow } = require('../events/parser');
const { normalizeTitle } = require('../utils/text');
const logger = require('../utils/logging');
const { invalidateCache } = require('./cache');

// Simple retry/backoff helper for Sheets calls
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
async function retryRequest(fn, opts = {}) {
    const attempts = Number.isInteger(opts.attempts) ? opts.attempts : 3;
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
            // 429/quota: повтори лише множать навантаження — одразу віддаємо помилку наверх.
            const status = Number(err && (err.code || err.status || (err.response && err.response.status)));
            if (status === 429 || msg.includes('quota') || msg.includes('rate limit') || msg.includes('too many requests')) {
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
const registrationLocks = new Map();

async function withRegistrationLock(eventId, operation) {
    const key = String(eventId || '');
    const previous = registrationLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    registrationLocks.set(key, current);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (registrationLocks.get(key) === current) registrationLocks.delete(key);
    }
}

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

function normalizeRegistrantUserId(value) {
    return String(value || '').replace(/\D/g, '');
}

function formatRegistrantLine(item, index) {
    const name = item.name || `user ${item.userId}`;
    const phone = item.phone || 'без номера';
    return `${index + 1}. ${name}${phone ? ` | ${phone}` : ''}`;
}

function registrantIdentityKey(item) {
    const userId = String((item && item.userId) || '').trim();
    const name = normalizeRegistrantName(item && item.name);
    const phone = normalizeRegistrantPhone(item && item.phone);

    if (userId) return `u:${userId}`;
    if (name && phone) return `np:${name}|${phone}`;
    if (phone) return `p:${phone}`;
    if (name) return `n:${name}`;
    return '';
}

function isServiceLikeRegistrant(item) {
    const name = String((item && item.name) || '').trim();
    return /^EVENT_ID\s*:/i.test(name);
}

// Знаходить індекс ЄДИНОГО запису, що точно відповідає ідентичності користувача.
// Якщо однозначно визначити запис неможливо, повертає -1, щоб ніколи не видалити чужий запис.
function findSingleRegistrantIndex(list, target) {
    const safeList = Array.isArray(list) ? list : [];
    const targetUserId = normalizeRegistrantUserId(target && target.userId);
    const targetName = normalizeRegistrantName(target && target.name);
    const targetPhone = normalizeRegistrantPhone(target && target.phone);

    if (targetUserId) {
        const idx = safeList.findIndex((item) => normalizeRegistrantUserId(item && item.userId) === targetUserId);
        if (idx !== -1) return idx;
    }

    if (targetName && targetPhone) {
        const idx = safeList.findIndex((item) => normalizeRegistrantName(item && item.name) === targetName
            && normalizeRegistrantPhone(item && item.phone) === targetPhone);
        if (idx !== -1) return idx;
    }

    if (targetPhone) {
        const matches = [];
        safeList.forEach((item, index) => {
            if (normalizeRegistrantPhone(item && item.phone) === targetPhone) matches.push(index);
        });
        if (matches.length === 1) return matches[0];
    }

    if (targetName) {
        const matches = [];
        safeList.forEach((item, index) => {
            if (normalizeRegistrantName(item && item.name) === targetName) matches.push(index);
        });
        if (matches.length === 1) return matches[0];
    }

    return -1;
}

function sanitizeAndDedupeRegistrants(list) {
    const result = [];
    const seen = new Set();

    for (const raw of Array.isArray(list) ? list : []) {
        const item = {
            userId: String((raw && raw.userId) || '').trim(),
            name: String((raw && raw.name) || '').trim(),
            phone: String((raw && raw.phone) || '').trim()
        };

        if (!(item.userId || item.name || item.phone)) continue;
        if (isServiceLikeRegistrant(item)) continue;

        const key = registrantIdentityKey(item);
        if (key && seen.has(key)) continue;

        if (key) seen.add(key);
        result.push(item);
    }

    return result;
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
        if (/^\d+\.\s*EVENT_ID\s*:/i.test(line)) continue;
        if (/^Зареєстровано\s*:/i.test(line)) {
            currentSection = 'registered';
            continue;
        }
        if (/^Резерв\s*:/i.test(line)) {
            currentSection = 'reserve';
            continue;
        }
        if (/^Список порожній$/i.test(line)) continue;

        const match = line.match(/^\s*\d+\.\s*(.*?)\s*(?:\||[—-])\s*(.*?)\s*$/);
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
    const cleanRegistered = sanitizeAndDedupeRegistrants(registered);
    const registeredKeys = new Set(cleanRegistered.map((item) => registrantIdentityKey(item)).filter(Boolean));
    const cleanReserve = sanitizeAndDedupeRegistrants(reserve).filter((item) => {
        const key = registrantIdentityKey(item);
        return !(key && registeredKeys.has(key));
    });

    const registeredLines = cleanRegistered.map((item, index) => formatRegistrantLine(item, index));
    const reserveLines = cleanReserve.map((item, index) => formatRegistrantLine(item, index));
    const effectiveRegisteredCount = registeredLines.length > 0 ? registeredLines.length : Math.max(safeRegisteredCount, 0);

    const parts = [];
    if (registeredLines.length === 0) {
        parts.push(`Зареєстровано: ${effectiveRegisteredCount}\n\nСписок порожній`);
    } else {
        parts.push(`Зареєстровано: ${effectiveRegisteredCount}\n\n${registeredLines.join('\n')}`);
    }

    if (reserveLines.length > 0) {
        parts.push(`Резерв: ${reserveLines.length}\n\n${reserveLines.join('\n')}`);
    }

    const noteText = parts.join('\n\n').trim();
    return ensureScheduleNoteEventIdTag(noteText, eventId);
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

const SHEET_METADATA_TTL_MS = 10 * 60 * 1000;
const sheetMetadataCache = new Map();

async function getSheetMetadata(spreadsheetId) {
    const cached = sheetMetadataCache.get(spreadsheetId);
    if (cached && cached.client === state.sheetsClient && cached.expiresAt > Date.now()) {
        return cached.sheets;
    }
    const meta = await retryRequest(() => state.sheetsClient.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title))'
    }));
    const sheets = new Map();
    for (const sheetItem of ((meta.data && meta.data.sheets) || [])) {
        const props = sheetItem && sheetItem.properties;
        if (props && props.title) sheets.set(props.title, props.sheetId);
    }
    sheetMetadataCache.set(spreadsheetId, { sheets, client: state.sheetsClient, expiresAt: Date.now() + SHEET_METADATA_TTL_MS });
    return sheets;
}

async function getSheetIdByTitle(spreadsheetId, sheetTitle) {
    const sheets = await getSheetMetadata(spreadsheetId);
    return sheets.has(sheetTitle) ? sheets.get(sheetTitle) : null;
}

// Лише існуючі листи-кандидати; при невизначеності повертає всіх кандидатів.
async function getExistingScheduleSheets() {
    try {
        const sheets = await getSheetMetadata(config.SPREADSHEET_ID);
        const existing = config.SCHEDULE_SHEET_CANDIDATES.filter((title) => sheets.has(title));
        return existing.length > 0 ? existing : config.SCHEDULE_SHEET_CANDIDATES;
    } catch (error) {
        return config.SCHEDULE_SHEET_CANDIDATES;
    }
}

async function getScheduleCellNote(scheduleSheet, rowIndex, columnLetter = 'E') {
    const resp = await retryRequest(() => state.sheetsClient.spreadsheets.get({
        spreadsheetId: config.SPREADSHEET_ID,
        ranges: [`${scheduleSheet}!${columnLetter}${rowIndex + 1}`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values.note'
    }));

    const sheets = (resp.data && resp.data.sheets) || [];
    const rowData = sheets[0] && sheets[0].data && sheets[0].data[0] && sheets[0].data[0].rowData;
    const cell = rowData && rowData[0] && rowData[0].values && rowData[0].values[0];
    return (cell && typeof cell.note === 'string') ? cell.note : '';
}

function parseReserveRegistrantsFromNote(noteText) {
    const text = String(noteText || '').trim();
    if (!text) return [];

    const reservists = [];
    const seen = new Set();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (/^резерв\s*:/i.test(line)) continue;
        if (/^зареєстровано\s*:/i.test(line)) continue;
        if (/^список\s+порожній$/i.test(line)) continue;
        if (/^EVENT_ID\s*:/i.test(line)) continue;
        if (/^\d+[.)-]?\s*EVENT_ID\s*:/i.test(line)) continue;

        const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)-]?\s*/, '').trim();
        if (!cleaned) continue;
        if (/^EVENT_ID\s*:/i.test(cleaned)) continue;

        const parts = cleaned.split('|').map((part) => String(part || '').trim());
        const name = String(parts[0] || '').trim();
        const phone = String(parts[1] || '').trim();
        const userId = String(parts[2] || '').trim();

        if (!name && !phone && !userId) continue;

        const key = `${normalizeRegistrantName(name)}|${normalizeRegistrantPhone(phone)}|${normalizeRegistrantUserId(userId)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        reservists.push({ name, phone, userId });
    }

    return reservists;
}

async function getEffectiveReserveRegistrants(scheduleSheet, rowIndex) {
    const reserveNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'F');
    const reserveFromF = parseReserveRegistrantsFromNote(reserveNote);
    if (reserveFromF.length > 0) {
        return reserveFromF;
    }

    // Legacy fallback: резерв може бути збережений у нотатці реєстрацій (колонка E)
    const registrationNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'E');
    return parseScheduleNoteSections(registrationNote).reserve;
}

function buildReserveNoteFromList(reserveCount, reservists, eventId = '') {
    const safeCount = Number.isFinite(reserveCount) ? reserveCount : reservists.length;
    const header = `Резерв: ${safeCount}`;
    const people = reservists.map((item, index) => {
        const name = String(item.name || '').trim() || 'Без імені';
        const phone = String(item.phone || '').trim();
        const userId = String(item.userId || '').trim();
        const identityTail = [phone, userId].filter(Boolean).join(' | ');
        return `${index + 1}. ${name}${identityTail ? ` | ${identityTail}` : ''}`;
    });

    const content = people.length === 0 ? header : `${header}\n\n${people.join('\n')}`;
    return ensureScheduleNoteEventIdTag(content, eventId);
}

async function updateSheetReserveCount(event) {
    if (!event || !state.sheetsClient || !config.SPREADSHEET_ID) {
        return;
    }

    const match = await findScheduleRowForEvent(event);
    if (!match) {
        return;
    }

    const reserveCount = Number.isFinite(event.reserveCount) ? Math.max(0, event.reserveCount) : 0;
    await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${match.scheduleSheet}!F${match.rowIndex + 1}:F${match.rowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: {
            values: [[reserveCount]]
        }
    }));
}

async function updateScheduleReserveNote({ scheduleSheet, rowIndex, reserveCount, addRegistrant, removeRegistrant, eventId }) {
    if (!scheduleSheet || rowIndex < 0 || !config.SPREADSHEET_ID || !state.sheetsClient) {
        return;
    }

    const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, scheduleSheet);
    if (sheetId === null || typeof sheetId === 'undefined') {
        return;
    }

    const existingNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'F');
    let existingEventId = extractScheduleNoteEventId(existingNote) || eventId;
    let reservists = parseReserveRegistrantsFromNote(existingNote);

    if (reservists.length === 0) {
        const legacyRegistrationNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'E');
        const legacyReservists = parseScheduleNoteSections(legacyRegistrationNote).reserve;
        if (legacyReservists.length > 0) {
            reservists = legacyReservists;
            if (!existingEventId) {
                existingEventId = extractScheduleNoteEventId(legacyRegistrationNote) || eventId;
            }
        }
    }

    if (removeRegistrant) {
        const removeNameKey = String(removeRegistrant.name || '').trim();
        const removePhoneKey = String(removeRegistrant.phone || '').trim();
        const removeUserIdKey = String(removeRegistrant.userId || '').trim();
        if (removeNameKey || removePhoneKey || removeUserIdKey) {
            const idx = findSingleRegistrantIndex(reservists, { name: removeNameKey, phone: removePhoneKey, userId: removeUserIdKey });
            if (idx !== -1) {
                reservists.splice(idx, 1);
            } else {
                logger.warn('[reserve-note] cannot uniquely identify reservist to remove; note left unchanged', {
                    name: removeNameKey, phone: removePhoneKey, userId: removeUserIdKey
                });
            }
        }
    }

    if (addRegistrant) {
        const candidateName = String(addRegistrant.name || '').trim();
        const candidatePhone = String(addRegistrant.phone || '').trim();
        const candidateUserId = String(addRegistrant.userId || '').trim();
        const candidateNameKey = normalizeRegistrantName(candidateName);
        const candidatePhoneKey = normalizeRegistrantPhone(candidatePhone);
        const candidateUserIdKey = normalizeRegistrantUserId(candidateUserId);

        const alreadyExists = reservists.some((item) => {
            const sameName = normalizeRegistrantName(item.name) === candidateNameKey;
            const samePhone = normalizeRegistrantPhone(item.phone) === candidatePhoneKey;
            const sameUserId = normalizeRegistrantUserId(item.userId) === candidateUserIdKey;

            return (candidateNameKey && candidatePhoneKey && sameName && samePhone)
                || (candidateUserIdKey && sameUserId);
        });

        if (!alreadyExists) {
            reservists.push({
                name: candidateName,
                phone: candidatePhone,
                userId: candidateUserId
            });
        }
    }

    const noteText = buildReserveNoteFromList(reserveCount, reservists, existingEventId);

    await retryRequest(() => state.sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: rowIndex,
                            endRowIndex: rowIndex + 1,
                            startColumnIndex: 5,
                            endColumnIndex: 6
                        },
                        cell: {
                            note: noteText
                        },
                        fields: 'note'
                    }
                }
            ]
        }
    }));
}

function parseRegistrantsFromNote(noteText) {
    const sections = parseScheduleNoteSections(noteText);
    return [...sections.registered, ...sections.reserve];
}

async function findScheduleRowByEventByNoteTag(event) {
    if (!event || !event.id || !state.sheetsClient || !config.SPREADSHEET_ID) return null;

    for (const scheduleSheet of await getExistingScheduleSheets()) {
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

    for (const scheduleSheet of await getExistingScheduleSheets()) {
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            }));
            const rows = resp.data.values || [];
            let dateContext = null;
            for (let i = 0; i < rows.length; i++) {
                const parsed = parseEventFromRow(rows[i], dateContext);
                dateContext = parsed.nextDateContext;
                const parsedEvent = parsed.event;
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

async function promoteReserveRegistrantsIfNeeded(event) {
    if (!event || !state.sheetsClient || !config.SPREADSHEET_ID) {
        logger.warn('[reserve-promotion] skipped: Sheets client is not initialised in shared state',
            JSON.stringify({ event: event && event.id, hasClient: Boolean(state.sheetsClient), hasSpreadsheetId: Boolean(config.SPREADSHEET_ID) }));
        return { promoted: 0, reserveLeft: 0 };
    }

    return withRegistrationLock(event.id, async () => {
        const match = await findScheduleRowForEvent(event);
        if (!match) {
            logger.warn('[reserve-promotion] no schedule row match', event.id, event.name);
            return { promoted: 0, reserveLeft: 0 };
        }

        const response = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
            spreadsheetId: config.SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`
        }));
        const values = (response.data && response.data.values && response.data.values[0]) || [];
        const currentRemainingSeats = Math.max(0, parseInt(values[0] || '0', 10) || 0);
        logger.info('[reserve-promotion] match', event.id, `${match.scheduleSheet}!row${match.rowIndex + 1}`, 'D=', currentRemainingSeats);

        let promotedCount = 0;
        while (promotedCount < currentRemainingSeats) {
            const result = await promoteFirstReserveRegistrantToRegistrationUnlocked(event);
            if (!result || !result.promoted) break;
            promotedCount += 1;
        }

        logger.info('[reserve-promotion] result', event.id, 'D=', currentRemainingSeats, 'promoted=', promotedCount, 'reserveLeft=', Math.max(0, Number(event.reserveCount) || 0));
        return { promoted: promotedCount, reserveLeft: Math.max(0, Number(event.reserveCount) || 0) };
    });
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
        const displayCount = filtered.length > 0 ? filtered.length : Math.max(safeCount, 0);
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

async function getScheduleEventSeatState(event) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID || !event) {
        return null;
    }

    for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            }));
            const rows = resp.data.values || [];
            for (let i = 0; i < rows.length; i++) {
                const parsed = parseEventFromRow(rows[i], null).event;
                if (!parsed) continue;

                const sameTitle = normalizeTitle(parsed.name) === normalizeTitle(event.name || '');
                const sameMinute = Math.abs(parsed.date.getTime() - (event.date ? event.date.getTime() : 0)) < 60 * 1000;
                if (sameTitle && sameMinute) {
                    const row = rows[i] || [];
                    // Колонка D = ЗАЛИШОК місць, E = кількість реєстрацій; місткість = D + E
                    const remaining = parseInt(row[3] || row[0] || '0', 10);
                    const currReg = parseInt(row[4] || row[1] || '0', 10);
                    const seatsLeft = Math.max(0, remaining);
                    return { seatsLeft, capacity: remaining + currReg, registrations: currReg, sheet: scheduleSheet, rowIndex: i };
                }
            }
        } catch (error) {
            const msg = (error && error.message) ? String(error.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
        }
    }

    return null;
}

async function incrementSheetRegistrationUnlocked(event, fallbackRegistrant) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID || !event) return false;

    const match = await findScheduleRowForEvent(event);
    if (!match) {
        logger.warn(`Не вдалося знайти рядок у розкладі для реєстрації: ${event.name}`);
        return false;
    }

    const { scheduleSheet, rowIndex } = match;
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

        event.registrations = newReg;
        try {
            recordRecentAction((fallbackRegistrant && fallbackRegistrant.userId) || '', {
                type: 'register', event, registrant: { name: fallbackRegistrant && fallbackRegistrant.name, phone: fallbackRegistrant && fallbackRegistrant.phone }
            });
        } catch (recErr) { logger.warn('Failed to record recent action', recErr && recErr.message ? recErr.message : recErr); }
        return true;
    } catch (error) {
        logger.error('Error incrementing registration count', error && error.message ? error.message : error);
        return false;
    }
}

async function decrementSheetRegistration(event, registrantProfile) {
    if (!state.sheetsClient || !config.SPREADSHEET_ID || !event) {
        return false;
    }

    const match = await findScheduleRowForEvent(event);
    if (!match) {
        logger.warn(`Не вдалося знайти рядок у розкладі для відписки: ${event.name}`);
        return false;
    }

    try {
        const resp = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
            spreadsheetId: config.SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`
        }));
        const row = (resp.data.values || [])[0] || [];
        // Колонка D = ЗАЛИШОК місць — при відписці збільшується на 1
        const currentRemaining = parseInt(row[0] || '0', 10);
        const currentRegistrations = parseInt(row[1] || '0', 10);
        const nextRegistrations = Math.max(0, currentRegistrations - 1);
        const nextRemaining = currentRemaining + 1;

        const existingNote = await getScheduleCellNote(match.scheduleSheet, match.rowIndex);
        const sections = parseScheduleNoteSections(existingNote);
        const filteredRegistered = (sections.registered || []).filter((item) => {
            const itemName = normalizeRegistrantName(item.name || '');
            const itemPhone = normalizeRegistrantPhone(item.phone || '');
            const itemUser = String(item.userId || '').trim();
            const targetName = normalizeRegistrantName(registrantProfile && registrantProfile.name ? registrantProfile.name : '');
            const targetPhone = normalizeRegistrantPhone(registrantProfile && registrantProfile.phone ? registrantProfile.phone : '');
            const targetUser = String((registrantProfile && registrantProfile.userId) || '').trim();

            if (targetUser && itemUser && targetUser === itemUser) return false;
            if (targetPhone && itemPhone && targetPhone === itemPhone) return false;
            if (targetName && itemName && targetName === itemName) return false;
            return true;
        });

        const noteText = buildScheduleNoteText({
            registered: filteredRegistered,
            reserve: sections.reserve,
            registrationsCount: nextRegistrations,
            eventId: event.id
        });

        await retryRequest(() => state.sheetsClient.spreadsheets.values.update({
            spreadsheetId: config.SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[String(nextRemaining), String(nextRegistrations)]] }
        }));

        const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, match.scheduleSheet);
        if (sheetId !== null && sheetId !== undefined && String(existingNote || '').trim() !== String(noteText || '').trim()) {
            await retryRequest(() => state.sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: config.SPREADSHEET_ID,
                requestBody: {
                    requests: [{
                        repeatCell: {
                            range: {
                                sheetId,
                                startRowIndex: match.rowIndex,
                                endRowIndex: match.rowIndex + 1,
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

        invalidateCache('schedule');
        event.registrations = nextRegistrations;
        return { status: 'ok' };
    } catch (error) {
        logger.error('Failed to decrement registration count for event', event && event.id, error && error.message ? error.message : error);
        return { status: 'failed' };
    }
}

async function removeRegistrantFromReserve(event, registrantProfile) {
    if (!event || !registrantProfile || !state.sheetsClient || !config.SPREADSHEET_ID) {
        return false;
    }

    const match = await findScheduleRowForEvent(event);
    if (!match) {
        return false;
    }


    const reservists = await getEffectiveReserveRegistrants(match.scheduleSheet, match.rowIndex);
    const targetName = String(registrantProfile.name || '').trim();
    const targetPhone = String(registrantProfile.phone || '').trim();
    const targetUserId = String(registrantProfile.userId || registrantProfile.chatId || '').trim();

    const targetIdx = findSingleRegistrantIndex(reservists, { name: targetName, phone: targetPhone, userId: targetUserId });
    if (targetIdx === -1) {
        return false;
    }
    const remaining = reservists.slice(0, targetIdx).concat(reservists.slice(targetIdx + 1));

    if (remaining.length === reservists.length) {
        return false;
    }

    event.reserveCount = remaining.length;
    await updateSheetReserveCount(event);
    await updateScheduleReserveNote({
        scheduleSheet: match.scheduleSheet,
        rowIndex: match.rowIndex,
        reserveCount: event.reserveCount,
        removeRegistrant: {
            name: registrantProfile.name,
            phone: registrantProfile.phone,
            userId: registrantProfile.userId || registrantProfile.chatId
        },
        eventId: event.id
    });

    return true;
}

async function promoteFirstReserveRegistrantToRegistrationUnlocked(event, options = {}) {
    if (!event || !state.sheetsClient || !config.SPREADSHEET_ID) {
        return false;
    }

    // Рядок уже знайдено викликачем — не шукаємо повторно. D/E/нотатки нижче читаються свіжими.
    const hint = options && options.match;
    const match = hint && hint.scheduleSheet && Number.isInteger(hint.rowIndex) && hint.rowIndex >= 0
        ? hint
        : await findScheduleRowForEvent(event);
    if (!match) {
        return false;
    }

    const valuesResponse = await retryRequest(() => state.sheetsClient.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`
    }));
    const values = (valuesResponse.data && valuesResponse.data.values && valuesResponse.data.values[0]) || [];
    const currentRemainingSeats = Math.max(0, parseInt(values[0] || '0', 10) || 0);
    if (currentRemainingSeats <= 0) return false;

    const registeredNote = await getScheduleCellNote(match.scheduleSheet, match.rowIndex, 'E');
    const registeredSection = parseScheduleNoteSections(registeredNote);
    const reservists = await getEffectiveReserveRegistrants(match.scheduleSheet, match.rowIndex);
    logger.info('[reserve-promotion] D=', currentRemainingSeats, 'reserve list=', reservists.map((r) => `${r.name}|${r.userId}`).join(', ') || '(empty)');
    if (reservists.length === 0) {
        return false;
    }

    const isAlreadyRegistered = (candidate) => registeredSection.registered.some((registered) => {
        const candidateUserId = normalizeRegistrantUserId(candidate.userId);
        const registeredUserId = normalizeRegistrantUserId(registered.userId);
        if (candidateUserId && registeredUserId && candidateUserId === registeredUserId) return true;

        const candidateName = normalizeRegistrantName(candidate.name);
        const candidatePhone = normalizeRegistrantPhone(candidate.phone);
        return Boolean(candidateName && candidatePhone
            && candidateName === normalizeRegistrantName(registered.name)
            && candidatePhone === normalizeRegistrantPhone(registered.phone));
    });
    const promotedIndex = reservists.findIndex((candidate) => !isAlreadyRegistered(candidate));
    if (promotedIndex === -1) return false;

    const promoted = reservists[promotedIndex];
    const remainingReserve = reservists.filter((candidate, index) => index !== promotedIndex && !isAlreadyRegistered(candidate));
    const currentRegistrations = Math.max(0, parseInt(values[1] || '0', 10) || 0);
    const nextRemainingSeats = currentRemainingSeats - 1;
    const nextRegistrations = currentRegistrations + 1;
    const nextRegisteredNote = buildScheduleNoteText({
        registered: [...registeredSection.registered, promoted],
        registrationsCount: nextRegistrations,
        eventId: event.id
    });
    const nextReserveNote = buildReserveNoteFromList(remainingReserve.length, remainingReserve, event.id);
    const sheetId = await getSheetIdByTitle(config.SPREADSHEET_ID, match.scheduleSheet);
    if (sheetId === null || sheetId === undefined) {
        throw new Error(`Cannot find sheet id for ${match.scheduleSheet}`);
    }

    await retryRequest(() => state.sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: {
            requests: [
                {
                    updateCells: {
                        range: {
                            sheetId,
                            startRowIndex: match.rowIndex,
                            endRowIndex: match.rowIndex + 1,
                            startColumnIndex: 3,
                            endColumnIndex: 5
                        },
                        rows: [{ values: [
                            { userEnteredValue: { numberValue: nextRemainingSeats } },
                            { userEnteredValue: { numberValue: nextRegistrations } }
                        ] }],
                        fields: 'userEnteredValue'
                    }
                },
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: match.rowIndex,
                            endRowIndex: match.rowIndex + 1,
                            startColumnIndex: 4,
                            endColumnIndex: 5
                        },
                        cell: { note: nextRegisteredNote },
                        fields: 'note'
                    }
                },
                {
                    updateCells: {
                        range: {
                            sheetId,
                            startRowIndex: match.rowIndex,
                            endRowIndex: match.rowIndex + 1,
                            startColumnIndex: 5,
                            endColumnIndex: 6
                        },
                        rows: [{ values: [{ userEnteredValue: { numberValue: remainingReserve.length } }] }],
                        fields: 'userEnteredValue'
                    }
                },
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: match.rowIndex,
                            endRowIndex: match.rowIndex + 1,
                            startColumnIndex: 5,
                            endColumnIndex: 6
                        },
                        cell: { note: nextReserveNote },
                        fields: 'note'
                    }
                }
            ]
        }
    }));
    invalidateCache('schedule');

    event.registrations = nextRegistrations;
    event.reserveCount = remainingReserve.length;
    event.seats = currentRemainingSeats + currentRegistrations;

    if (state.bot && typeof state.bot.sendMessage === 'function') {
        const userId = String(promoted.userId || '').trim();
        if (userId) {
            try {
                await state.bot.sendMessage(userId, `✅ Для вас звільнилося місце, ви успішно зареєстровані на захід «${event.name}».`);
            } catch (notifyError) {
                logger.warn('Failed to notify promoted reserve user', userId, notifyError && notifyError.message ? notifyError.message : notifyError);
            }
        }
    }

    // Повертаємо саме того реєстранта, якого реально видалено з резерву в таблиці,
    // щоб виклик у server.js не робив другий незалежний запит і не міг розсинхронізуватися
    // з тим, кого фактично перенесено (гонка при паралельних відписках).
    return { promoted };
}

async function promoteFirstReserveRegistrantToRegistration(event, options = {}) {
    return withRegistrationLock(event && event.id, () => promoteFirstReserveRegistrantToRegistrationUnlocked(event, options));
}

async function incrementSheetRegistration(event, fallbackRegistrant) {
    return withRegistrationLock(event && event.id, () => incrementSheetRegistrationUnlocked(event, fallbackRegistrant));
}

module.exports = {
    appendEventToSheet,
    appendEventReservation,
    buildScheduleNoteText,
    decrementSheetRegistration,
    extractScheduleNoteEventId,
    incrementSheetRegistration,
    isRegistrantAlreadyInEventNote,
    parseScheduleNoteSections,
    promoteFirstReserveRegistrantToRegistration,
    promoteReserveRegistrantsIfNeeded,
    removeRegistrantFromReserve,
    undoLastSheetsAction: undoLastAction
};
