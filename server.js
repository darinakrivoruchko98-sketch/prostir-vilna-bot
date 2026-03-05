const config = require('./src/config');
require('dotenv').config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

const TOKEN = process.env.TOKEN || process.env.TELEGRAM_BOT_TOKEN || config.TOKEN;
const PORT = process.env.PORT || 8080;
const GROUP_ID = process.env.GROUP_ID || config.GROUP_ID;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;
const APPEALS_GROUP_ID = Number(process.env.APPEALS_GROUP_ID || '-1003802751255'); // Група "Відгуки чат-бот Вільна"
// Таблиця для розкладу та реєстрацій на заходи
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || config.SPREADSHEET_ID;
const SCHEDULE_SHEET_NAME = process.env.SCHEDULE_SHEET_NAME || config.SCHEDULE_SHEET_NAME;
// Таблиця для персональних даних (ПІБ, телефон тощо)
const PERSONAL_DATA_SPREADSHEET_ID = process.env.PERSONAL_DATA_SPREADSHEET_ID || config.PERSONAL_DATA_SPREADSHEET_ID;
const PERSONAL_DATA_SHEET_NAME = process.env.PERSONAL_DATA_SHEET_NAME || config.PERSONAL_DATA_SHEET_NAME;
const SCHEDULE_SHEET_CANDIDATES = [SCHEDULE_SHEET_NAME, "Заходи"];

// Таблиця розкладу: https://docs.google.com/spreadsheets/d/1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8/edit
// Таблиця персональних даних: https://docs.google.com/spreadsheets/d/1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE/edit


if (!SPREADSHEET_ID) {
    console.log("SPREADSHEET_ID не встановлений");
}
console.log("📋 Таблиця розкладу:", SPREADSHEET_ID);
console.log("📄 Аркуш розкладу:", SCHEDULE_SHEET_NAME);
console.log("👤 Таблиця персональних даних:", PERSONAL_DATA_SPREADSHEET_ID);
console.log("📄 Аркуш персональних даних:", PERSONAL_DATA_SHEET_NAME);

if (!TOKEN) {
    console.error("TOKEN не встановлено");
    process.exit(1);
}

// Express сервер для webhook
const app = express();
app.use(express.json());

// Telegram бот з polling режимом
const bot = new TelegramBot(TOKEN, { polling: true });

// Health check endpoints
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        mode: 'polling',
        timestamp: new Date().toISOString() 
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        events: events.length,
        mode: 'polling'
    });
});

// Запускаємо Express сервер ПЕРШИМ
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущено на порті ${PORT}`);
    console.log(`📡 Режим: Polling (Надійний для Railway)`);
    console.log(`🤖 Бот прослуховує оновлення у режимі polling...`);
});

// Логування налаштованих груп для налагодження
if (typeof GROUP_ID !== 'undefined') {
    if (GROUP_ID) {
        console.log(`✅ GROUP_ID встановлено: ${GROUP_ID}`);
    } else {
        console.log("⚠️ GROUP_ID не встановлено (встановіть: export GROUP_ID=-100xxxxx)");
    }
} else {
    console.log("⚠️ GROUP_ID змінна не визначена (можна додати у .env або через export)");
}

if (typeof CHAT_ID !== 'undefined') {
    if (CHAT_ID) {
        console.log(`✅ CHAT_ID встановлено: ${CHAT_ID}`);
    } else {
        console.log("⚠️ CHAT_ID не встановлено (встановіть: export CHAT_ID=-1003282996506)");
    }
} else {
    console.log("⚠️ CHAT_ID змінна не визначена (можна додати у .env або через export)");
}

if (APPEALS_GROUP_ID) {
    console.log(`📬 APPEALS_GROUP_ID встановлено: ${APPEALS_GROUP_ID} (група "Відгуки")`);
} else {
    console.log("⚠️ APPEALS_GROUP_ID не встановлено");
}

let users = {};
let events = []; // масив для зберігання заходів
// reminders feature removed per request

/* ===== HELPER FUNCTIONS ===== */

// Правильна граматика для множини заходів
function pluralizeEvents(count) {
    if (count === 1) return "захід";
    if (count % 10 === 2 || count % 10 === 3 || count % 10 === 4) {
        if (count % 100 === 12 || count % 100 === 13 || count % 100 === 14) {
            return "заходів";
        }
        return "заходи";
    }
    return "заходів";
}

// Видаляти минулі заходи
function cleanupPastEvents() {
    const now = new Date();
    const initialCount = events.length;
    events = events.filter(e => e.date > now);
    
    if (events.length < initialCount) {
        console.log(`🧹 Видалено ${initialCount - events.length} минулих заходів`);
    }
}

// Повертає масив майбутніх заходів (сер.–нд.)
function getAllEvents() {
    cleanupPastEvents();
    const now = new Date();
    return events.filter(e => e.date > now);
}

// Фільтрує заходи за номером дня (0-6)
function getEventsForDay(dayNum) {
    return getAllEvents().filter(e => e.date.getDay() === dayNum);
}

function formatSeatsCount(count) {
    const normalizedCount = Math.abs(Number(count));
    const lastTwoDigits = normalizedCount % 100;
    const lastDigit = normalizedCount % 10;

    let seatWord = 'місць';
    if (lastTwoDigits < 11 || lastTwoDigits > 14) {
        if (lastDigit === 1) {
            seatWord = 'місце';
        } else if (lastDigit >= 2 && lastDigit <= 4) {
            seatWord = 'місця';
        }
    }

    return `${count} ${seatWord}`;
}

// Форматує блок інформації про захід для повідомлення
function formatEventDetails(event) {
    const time = String(event.date.getHours()).padStart(2,'0')+":"+
                 String(event.date.getMinutes()).padStart(2,'0');
    const seatsLeft = event.seats - (event.registrations || 0);
    const seatsLabel = seatsLeft > 0 ? formatSeatsCount(seatsLeft) : "❌ закрито";
    return `Назва: ${event.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}`;
}

function getAfishaDaysKeyboard() {
    return [
        [{ text: "Середа" }],
        [{ text: "Четвер" }],
        [{ text: "П'ятниця" }],
        [{ text: "Субота" }],
        [{ text: "Неділя" }],
        [{ text: "Повернутися в меню" }],
        [{ text: "Назад" }]
    ];
}

function showAfishaDaysMenu(chatId) {
    if (!users[chatId]) {
        users[chatId] = { step: 0 };
    }
    users[chatId].context = 'afisha';
    return bot.sendMessage(chatId, "Оберіть день:", {
        reply_markup: {
            keyboard: getAfishaDaysKeyboard(),
            resize_keyboard: true
        }
    });
}

// Відображає афішу для конкретного дня
async function showDayAgenda(chatId, dayName) {
    if (!users[chatId]) {
        users[chatId] = { step: 0 };
    }
    users[chatId].context = 'afisha';

    const weekdays = { 'Неділя':0, 'Середа':3, 'Четвер':4, 'П’ятниця':5, 'Субота':6 };
    const dayNum = weekdays[dayName];
    const dayEvents = getEventsForDay(dayNum);
    dayEvents.sort((a,b)=>a.date-b.date);
    
    const dayForms = {
        'Середа': { lower: 'середу', upper: 'Середу' },
        'Четвер': { lower: 'четвер', upper: 'Четвер' },
        'П’ятниця': { lower: 'п’ятницю', upper: 'П’ятницю' },
        'Субота': { lower: 'суботу', upper: 'Суботу' },
        'Неділя': { lower: 'неділю', upper: 'Неділю' }
    };

    if (dayEvents.length === 0) {
        bot.sendMessage(chatId, `На ${dayForms[dayName]?.lower || dayName} немає заходів.`, {
            reply_markup: {
                keyboard: [
                    [{ text: "Назад до вибору днів" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }
    let msg = `📅 Заходи у ${dayForms[dayName]?.upper || dayName}:\n\n`;
    const buttons = [];
    const eventButtonMap = {};
    for (const ev of dayEvents) {
        const seatsLeft = await getSeatsLeft(ev.id);
        const time = String(ev.date.getHours()).padStart(2,'0')+":"+String(ev.date.getMinutes()).padStart(2,'0');
        const seatsLabel = seatsLeft > 0 ? `💺 ${formatSeatsCount(seatsLeft)}` : `❌ закрито`;
        msg += `Назва: ${ev.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}\n\n`;
        const buttonText = `${ev.name} | ${time} | ${seatsLabel}`;
        buttons.push([{ text: buttonText }]);
        eventButtonMap[buttonText] = ev.id;
    }
    buttons.push([{ text: "Назад до вибору днів" }]);
    buttons.push([{ text: "Повернутися в меню" }]);

    if (!users[chatId]) {
        users[chatId] = { step: 0 };
    }
    users[chatId].eventButtonMap = eventButtonMap;

    bot.sendMessage(chatId, msg, {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: true
        }
    });
}

// reminders feature removed

// Українські назви місяців
const monthsUa = {
    'січня': 0, 'лютого': 1, 'березня': 2, 'квітня': 3,
    'травня': 4, 'червня': 5, 'липня': 6, 'серпня': 7,
    'вересня': 8, 'жовтня': 9, 'листопада': 10, 'грудня': 11
};

// Парсити дату з формату "01 березня 2026" + "15:00"
function parseEventDate(dateStr, timeStr) {
    try {
        // "01 березня 2026" -> parse
        const parts = dateStr.trim().split(/\s+/);
        if (parts.length !== 3) return null;
        
        const day = parseInt(parts[0]);
        const monthName = parts[1].toLowerCase();
        const year = parseInt(parts[2]);
        
        const month = monthsUa[monthName];
        if (month === undefined) return null;
        
        const timeParts = timeStr.trim().split(':');
        const hour = parseInt(timeParts[0]);
        const minute = parseInt(timeParts[1] || 0);
        
        return new Date(year, month, day, hour, minute, 0);
    } catch (e) {
        console.error('Parse date error:', e);
        return null;
    }
}

// Отримати денЯ тижня (0=неділя, 1=пн, 2=вт, ..., 6=сб)
function getDayOfWeek(date) {
    return date.getDay();
}

// формат DD.MM.YYYY
function formatSheetDate(date) {
    const d = String(date.getDate()).padStart(2,'0');
    const m = String(date.getMonth()+1).padStart(2,'0');
    const y = date.getFullYear();
    return `${d}.${m}.${y}`;
}

function formatSheetTime(date) {
    const h = String(date.getHours()).padStart(2,'0');
    const mi = String(date.getMinutes()).padStart(2,'0');
    return `${h}:${mi}`;
}

function normalizeTimeValue(rawTime) {
    const value = String(rawTime || '').trim().replace('.', ':');
    const match = value.match(/^(\d{1,2})[:](\d{1,2})$/);
    if (!match) return null;
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }
    return { hour, minute, text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function parseDateValue(rawDate, yearHint) {
    const source = String(rawDate || '').trim();
    if (!source) return null;

    const uaDate = source.match(/^(\d{1,2})\s+([А-Яа-яІіЇїЄєґҐ'’]+)\s+(\d{4})$/);
    if (uaDate) {
        const parsed = parseEventDate(source, '00:00');
        if (parsed && !Number.isNaN(parsed.getTime())) {
            parsed.setHours(0, 0, 0, 0);
            return parsed;
        }
    }

    const dmy = source.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/);
    if (dmy) {
        const day = parseInt(dmy[1], 10);
        const month = parseInt(dmy[2], 10) - 1;
        const explicitYear = dmy[3] ? parseInt(dmy[3], 10) : null;
        const year = explicitYear
            ? (explicitYear < 100 ? 2000 + explicitYear : explicitYear)
            : (yearHint || new Date().getFullYear());
        const date = new Date(year, month, day, 0, 0, 0, 0);
        if (!Number.isNaN(date.getTime())) return date;
    }

    const ymd = source.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ymd) {
        const year = parseInt(ymd[1], 10);
        const month = parseInt(ymd[2], 10) - 1;
        const day = parseInt(ymd[3], 10);
        const date = new Date(year, month, day, 0, 0, 0, 0);
        if (!Number.isNaN(date.getTime())) return date;
    }

    const asNumber = Number(source.replace(',', '.'));
    if (Number.isFinite(asNumber) && asNumber > 20000 && asNumber < 60000) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + asNumber * 86400000);
        if (!Number.isNaN(date.getTime())) {
            return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
        }
    }

    return null;
}

function normalizeTitle(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseEventFromRow(row, currentDateContext) {
    if (!row || row.length === 0) {
        return { event: null, nextDateContext: currentDateContext };
    }

    const cells = row.map((cell) => String(cell || '').trim());
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 0) {
        return { event: null, nextDateContext: currentDateContext };
    }

    const yearHint = currentDateContext ? currentDateContext.getFullYear() : new Date().getFullYear();
    const dateIndex = cells.findIndex((cell) => parseDateValue(cell, yearHint));
    const timeIndex = cells.findIndex((cell) => normalizeTimeValue(cell));

    if (nonEmpty.length === 1 && dateIndex >= 0 && timeIndex === -1) {
        return {
            event: null,
            nextDateContext: parseDateValue(cells[dateIndex], yearHint) || currentDateContext
        };
    }

    const dateBase = dateIndex >= 0
        ? parseDateValue(cells[dateIndex], yearHint)
        : currentDateContext;

    let time = timeIndex >= 0 ? normalizeTimeValue(cells[timeIndex]) : null;
    let title = cells[2] ? String(cells[2]).trim() : '';
    let seats = parseInt(cells[3], 10);
    let registrations = parseInt(cells[4], 10);

    if (!time) {
        const line = nonEmpty.join(' ');
        const lineTime = line.match(/(\d{1,2})[:.](\d{2})/);
        if (lineTime) {
            time = normalizeTimeValue(`${lineTime[1]}:${lineTime[2]}`);
        }

        if (!title) {
            const pieces = line.split(/\s*[–-]\s*/).map((v) => v.trim()).filter(Boolean);
            if (pieces.length >= 2) {
                const start = pieces[0].match(/\d{1,2}[:.]\d{2}/) ? 1 : 0;
                title = pieces.slice(start, pieces.length - 1).join(' – ').trim() || pieces[start] || '';
                const seatFromTail = pieces[pieces.length - 1].match(/\d+/);
                if (seatFromTail) seats = parseInt(seatFromTail[0], 10);
            }
        }
    }

    if (!title) {
        title = cells.find((cell, idx) => {
            if (!cell) return false;
            if (idx === dateIndex || idx === timeIndex) return false;
            if (/^\d+$/.test(cell)) return false;
            if (parseDateValue(cell, yearHint)) return false;
            if (normalizeTimeValue(cell)) return false;
            return true;
        }) || '';
    }

    if (!Number.isFinite(seats)) {
        const seatCell = cells.find((cell, idx) => idx !== dateIndex && idx !== timeIndex && /\d+/.test(cell));
        seats = seatCell ? parseInt((seatCell.match(/\d+/) || [0])[0], 10) : 0;
    }

    if (!Number.isFinite(registrations)) {
        registrations = 0;
    }

    if (!dateBase || !time || !title) {
        return { event: null, nextDateContext: dateBase || currentDateContext };
    }

    const eventDate = new Date(
        dateBase.getFullYear(),
        dateBase.getMonth(),
        dateBase.getDate(),
        time.hour,
        time.minute,
        0,
        0
    );

    if (Number.isNaN(eventDate.getTime())) {
        return { event: null, nextDateContext: dateBase || currentDateContext };
    }

    return {
        event: {
            id: `${title.replace(/\s+/g,'_')}_${formatSheetDate(eventDate)}_${formatSheetTime(eventDate)}`,
            name: title,
            date: eventDate,
            seats: Number.isFinite(seats) ? seats : 0,
            registrations: Number.isFinite(registrations) ? registrations : 0
        },
        nextDateContext: dateBase
    };
}

async function incrementSheetRegistration(event, fallbackRegistrant) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
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
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
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
    console.warn(`Не вдалося оновити лічильник у розкладі. Спробовано аркуші: ${SCHEDULE_SHEET_CANDIDATES.join(', ')}`);
}

async function getSheetIdByTitle(spreadsheetId, sheetTitle) {
    const meta = await sheetsClient.spreadsheets.get({
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

function normalizeRegistrantName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeRegistrantPhone(value) {
    return String(value || '').replace(/\D+/g, '');
}

async function isRegistrantAlreadyInEventNote(event, registrantProfile) {
    if (!event || !registrantProfile || !sheetsClient || !SPREADSHEET_ID) return false;

    const profileName = normalizeRegistrantName(registrantProfile.name);
    const profilePhone = normalizeRegistrantPhone(registrantProfile.phone);
    if (!profileName || !profilePhone) return false;

    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
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

async function getScheduleCellNote(scheduleSheet, rowIndex) {
    const resp = await sheetsClient.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        ranges: [`${scheduleSheet}!E${rowIndex + 1}`],
        includeGridData: true,
        fields: 'sheets.data.rowData.values.note'
    });

    const sheets = (resp.data && resp.data.sheets) || [];
    const rowData = sheets[0] && sheets[0].data && sheets[0].data[0] && sheets[0].data[0].rowData;
    const cell = rowData && rowData[0] && rowData[0].values && rowData[0].values[0];
    return (cell && typeof cell.note === 'string') ? cell.note : '';
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
    if (!sheetsClient || !SPREADSHEET_ID) return;
    const sheetId = await getSheetIdByTitle(SPREADSHEET_ID, scheduleSheet);
    if (sheetId === null || sheetId === undefined) return;

    let existingNote = '';
    try {
        existingNote = await getScheduleCellNote(scheduleSheet, rowIndex);
    } catch (e) {
        existingNote = '';
    }
    const noteText = await buildRegistrantsNote(registrationsCount, fallbackRegistrant, existingNote);

    await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
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

// Фільтрувати та сортувати заходи
function getUpcomingEvents() {
    const now = new Date();
    const filtered = events.filter(e => {
        if (e.date < now) return false; // майбутні тільки
        const dayOfWeek = getDayOfWeek(e.date);
        // сер=3, чтв=4, птн=5, сб=6, нд=0 (скипимо пн=1, вт=2)
        return dayOfWeek !== 1 && dayOfWeek !== 2;
    });
    
    // Сортуємо за датою та часом
    filtered.sort((a, b) => a.date - b.date);
    return filtered;
}

// Отримати заходи на наступний тиждень
function getWeekEvents() {
    const now = new Date();
    const weekLater = new Date(now);
    weekLater.setDate(weekLater.getDate() + 7);
    
    const filtered = events.filter(e => {
        if (e.date < now) return false; // майбутні тільки
        if (e.date > weekLater) return false; // тільки на 7 днів
        const dayOfWeek = getDayOfWeek(e.date);
        // сер=3, чтв=4, птн=5, сб=6, нд=0 (скипимо пн=1, вт=2)
        return dayOfWeek !== 1 && dayOfWeek !== 2;
    });
    
    // Сортуємо за датою та часом
    filtered.sort((a, b) => a.date - b.date);
    return filtered;
}

// Форматувати дату для показу
function formatEventDate(date) {
    const days = ['Неділя', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const months = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 
                    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
    
    const d = date.getDate();
    const m = months[date.getMonth()];
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    
    return `${d} ${m} | ${h}:${min}`;
}

/* ===== GOOGLE SHEETS ===== */

let sheetsClient = null;
let sheetsRefreshInterval = null;

function normalizeCredentials(credentials) {
    if (credentials && typeof credentials.private_key === "string") {
        credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }
    return credentials;
}

function parseCredentialsFromEnv() {
    const sources = [];
    const sheetsScopes = ["https://www.googleapis.com/auth/spreadsheets"];

    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
            const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            sources.push({
                label: "GOOGLE_SERVICE_ACCOUNT_JSON",
                authOptions: {
                    credentials: normalizeCredentials(parsed),
                    scopes: sheetsScopes
                }
            });
        } catch (error) {
            console.error(`Невалідний GOOGLE_SERVICE_ACCOUNT_JSON: ${error.message}`);
        }
    }

    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
        try {
            const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8");
            const parsed = JSON.parse(decoded);
            sources.push({
                label: "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
                authOptions: {
                    credentials: normalizeCredentials(parsed),
                    scopes: sheetsScopes
                }
            });
        } catch (error) {
            console.error(`Невалідний GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: ${error.message}`);
        }
    }

    // Backward-compatible alias used in older deployments/docs.
    // Accept both raw JSON and base64 payloads to support legacy env setups.
    if (process.env.GOOGLE_CREDENTIALS) {
        try {
            let parsed = null;
            try {
                parsed = JSON.parse(process.env.GOOGLE_CREDENTIALS);
            } catch {
                const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString("utf8");
                parsed = JSON.parse(decoded);
            }
            sources.push({
                label: "GOOGLE_CREDENTIALS",
                authOptions: {
                    credentials: normalizeCredentials(parsed),
                    scopes: sheetsScopes
                }
            });
        } catch (error) {
            console.error(`Невалідний GOOGLE_CREDENTIALS: ${error.message}`);
        }
    }

    // Env-only service account fields (common on Railway)
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        sources.push({
            label: "GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY",
            authOptions: {
                credentials: normalizeCredentials({
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: process.env.GOOGLE_PRIVATE_KEY,
                }),
                scopes: sheetsScopes
            }
        });
    }

    return sources;
}

function startPollingIfNeeded() {
    // Webhook режим - polling не використовується
    console.log("🤖 Telegram webhook режим активовано ✅");
}

function resolveGoogleAuthCandidates() {
    const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
    const candidates = [];

    const envCandidates = parseCredentialsFromEnv();
    if (envCandidates.length > 0) {
        candidates.push(...envCandidates);
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        candidates.push({
            label: `GOOGLE_APPLICATION_CREDENTIALS (${process.env.GOOGLE_APPLICATION_CREDENTIALS})`,
            authOptions: {
                keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
                scopes
            }
        });
    }

    const cwd = process.cwd();
    const preferredFile = path.join(cwd, "vilna-bot-8e7e5cb23ce2.json");
    if (fs.existsSync(preferredFile)) {
        candidates.push({
            label: "local file vilna-bot-8e7e5cb23ce2.json",
            authOptions: {
                keyFile: preferredFile,
                scopes
            }
        });
    }

    const anyLocalCredentials = fs.readdirSync(cwd).filter((fileName) => /^vilna-bot-.*\.json$/.test(fileName));
    for (const fileName of anyLocalCredentials) {
        const filePath = path.join(cwd, fileName);
        if (filePath === preferredFile) continue;
        candidates.push({
            label: `local file ${fileName}`,
            authOptions: {
                keyFile: filePath,
                scopes
            }
        });
    }

    if (candidates.length === 0) {
        throw new Error("Не знайдено Google credentials. Додайте GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, GOOGLE_CREDENTIALS, GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS або файл vilna-bot-*.json");
    }

    return candidates;
}

async function createAuthorizedSheetsClient() {
    const candidates = resolveGoogleAuthCandidates();
    const errors = [];

    for (const candidate of candidates) {
        try {
            console.log(`🔑 Перевіряю credentials: ${candidate.label}`);
            const auth = new google.auth.GoogleAuth(candidate.authOptions);
            const client = await auth.getClient();
            await client.getAccessToken();

            console.log(`🔐 Credentials валідні: ${candidate.label}`);
            return google.sheets({
                version: "v4",
                auth: client
            });
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            errors.push(`${candidate.label}: ${msg}`);
            console.error(`❌ Credentials невалидні (${candidate.label}): ${msg}`);
        }
    }

    throw new Error(`Жодне джерело credentials не підійшло. ${errors.join(" | ")}`);
}

async function initSheets() {
    try {
        sheetsClient = await createAuthorizedSheetsClient();

        console.log("Google Sheets підключено ✅");

        // Початкове завантаження розкладу та періодичне оновлення
        try {
            await loadEventsFromSheet();
        } catch (e) {
            console.error('Initial loadEventsFromSheet failed', e);
        }

        if (sheetsRefreshInterval) {
            clearInterval(sheetsRefreshInterval);
        }
        sheetsRefreshInterval = setInterval(() => {
            loadEventsFromSheet();
        }, 60000);

    } catch (err) {
        console.error("❌ Google Sheets не підключено:", err && err.message ? err.message : err);
        console.error("⚠️ Бот працює без Google Sheets. Перевірте credentials!");
        // Не падаємо - сервер має працювати навіть без Sheets
    }
}

// Викликаємо асинхронно - не блокує старт сервера
initSheets().catch(err => {
    console.error("Google Sheets initialization error:", err);
});

// Обробка необроблених помилок - не падаємо
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

/* ===== TEST EVENTS (for demo) ===== */
// Приклади заходів для тестування
const testDate1 = new Date();
testDate1.setDate(testDate1.getDate() + 1); // завтра
testDate1.setHours(14, 30);

const testDate2 = new Date();
testDate2.setDate(testDate2.getDate() + 3);
testDate2.setHours(10, 0);

// events.push({ name: "Йога", date: testDate1, seats: 5, registrations: 0 });
// events.push({ name: "Кіно-клуб", date: testDate2, seats: 0, registrations: 10 });

/* ===== MAINTENANCE TIMERS ===== */
// Очищати минулі заходи кожну хвилину
setInterval(() => {
    cleanupPastEvents();
}, 60000); // 1 хвилина

// reminders interval removed

// (Завантаження розкладу буде ініційовано після підключення Sheets у initSheets)

/* ===== LOAD EVENTS FROM SHEET ===== */
async function loadEventsFromSheet() {
    if (!sheetsClient || !SPREADSHEET_ID) return;

    try {
        let rows = [];
        const readErrors = [];
        for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
            try {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${scheduleSheet}!A:E`
                });
                rows = resp.data.values || [];
                if (rows && rows.length) {
                    console.log(`   Використано лист ${scheduleSheet}`);
                    break;
                }
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
                if (msg.includes('unable to parse range') || msg.includes('not found')) {
                    continue;
                }
                readErrors.push({ sheet: scheduleSheet, message: e && e.message ? e.message : String(e) });
            }
        }

        // Если всё ещё пусто, попробуем ещё общий диапазон
        if (!rows || rows.length === 0) {
            try {
                const alt2 = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: "A:E"
                });
                rows = alt2.data.values || [];
                if (rows && rows.length) console.log('   Використано діапазон A:E');
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                readErrors.push({ sheet: 'A:E', message: msg });
            }
        }

        if ((!rows || rows.length === 0) && readErrors.length > 0) {
            const details = readErrors.map((entry) => `${entry.sheet}: ${entry.message}`).join(' | ');
            throw new Error(`Не вдалося зчитати розклад із таблиці ${SPREADSHEET_ID}. ${details}`);
        }

        // Очистити поточні заходи перед завантаженням
        events = [];
        const seen = new Set();
        let dateContext = null;

        for (const [i, row] of rows.entries()) {
            const parsed = parseEventFromRow(row, dateContext);
            dateContext = parsed.nextDateContext;

            if (!parsed.event) {
                continue;
            }

            const ev = parsed.event;

            if (i === 0 && /дата|час|назва|захід/i.test(String((row || []).join(' ')))) {
                continue;
            }

            if (seen.has(ev.id)) {
                continue;
            }

            seen.add(ev.id);
            events.push(ev);
        }

        if (events.length === 0) {
            console.warn(`⚠️ Розклад прочитано, але заходів не знайдено. Перевірте дані у листі ${SCHEDULE_SHEET_NAME}.`);
        }
        console.log(`✅ Розклад завантажено з Sheets (${events.length} заходів)`);

    } catch (e) {
        console.error('Error loading schedule from Sheets', e);
    }
}

/* ===== SAVE TO SHEET ===== */

async function appendRegistrationRow(chatId, user) {

    if (!PERSONAL_DATA_SPREADSHEET_ID) {
        throw new Error('PERSONAL_DATA_SPREADSHEET_ID not set');
    }

    const values = [
        new Date().toISOString(),
        user.name || "",
        user.phone || "",
        user.birth || "",
        user.visited || "",
        user.status || "",
        user.health || ""
    ];

    const findFirstFreeRow = (rows) => {
        const searchStartIndex = 1;
        let targetRow = Math.max(2, rows.length + 1);

        for (let i = searchStartIndex; i < rows.length; i++) {
            const row = rows[i] || [];
            const personalDataHasValues = [1, 2, 3, 4, 5, 6].some((idx) => String(row[idx] || '').trim() !== '');
            if (!personalDataHasValues) {
                targetRow = i + 1;
                break;
            }
        }

        return targetRow;
    };

    console.log(`appendRegistrationRow -> writing to ${PERSONAL_DATA_SHEET_NAME}:`, values);

    // If sheetsClient not ready, retry a few times
    const maxTries = 3;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
        if (!sheetsClient) {
            console.warn(`sheetsClient not ready, attempt ${attempt}/${maxTries}`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
        }

        try {
            const existingResp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${PERSONAL_DATA_SHEET_NAME}!A:G`,
            });
            const rows = existingResp.data.values || [];
            const targetRow = findFirstFreeRow(rows);

            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${PERSONAL_DATA_SHEET_NAME}!A${targetRow}:G${targetRow}`,
                valueInputOption: "RAW",
                requestBody: { values: [values] }
            });
            console.log(`Записано в таблицю ${PERSONAL_DATA_SHEET_NAME} (рядок ${targetRow}) ✅`);
            return;
        } catch (e) {
            lastErr = e;
            // Более подробное логирование ошибки от Google API (если есть)
            try {
                const apiInfo = e && e.response && e.response.data ? JSON.stringify(e.response.data) : null;
                console.error(`appendRegistrationRow attempt ${attempt} failed:`, e && e.message ? e.message : e, apiInfo ? `| api: ${apiInfo}` : '');
            } catch (logErr) {
                console.error(`appendRegistrationRow attempt ${attempt} failed (unable to stringify error):`, e);
            }

            // Если ошибка связана с неверным range (напр., листа "Березень" нет), пробуем fallback на общий диапазон листа
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if ((msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('sheet') ) && attempt === 1) {
                try {
                    console.warn('appendRegistrationRow: попробую fallback-діапазон A:G (перший аркуш)');

                    const existingResp = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                        range: "A:G",
                    });
                    const rows = existingResp.data.values || [];
                    const targetRow = findFirstFreeRow(rows);

                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A${targetRow}:G${targetRow}`,
                        valueInputOption: "RAW",
                        requestBody: { values: [values] }
                    });
                    console.log(`Записано в таблицю (fallback A:G, рядок ${targetRow}) ✅`);
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('Fallback append to A:G failed:', e2 && e2.message ? e2.message : e2);
                }
            }

            // Если ошибка связана с правами — дать подсказку в лог
            if (msg.includes('permission') || (e && e.code === 403)) {
                console.error('appendRegistrationRow: можливі проблеми з дозволами. Перевірте, чи додано service account як редактор до Google Sheet.');
            }

            await new Promise(r => setTimeout(r, 500 * attempt));
        }
    }

    // якщо всі спроби не вдались — кинути помилку вгору
    throw lastErr || new Error('Unknown error writing to sheet');
}

async function resolveRegistrantProfile(chatId, user, providedName, providedPhone) {
    const resolved = {
        userId: String(chatId || ''),
        name: String(providedName || '').trim(),
        phone: String(providedPhone || '').trim()
    };

    if (!resolved.name) {
        resolved.name = String((user && user.name) || '').trim();
    }
    if (!resolved.phone) {
        resolved.phone = String((user && user.phone) || '').trim();
    }

    return resolved;
}

async function resolveRegistrantFormData(chatId, user) {
    const resolved = {
        userId: String(chatId || ''),
        name: String((user && user.name) || '').trim(),
        phone: String((user && user.phone) || '').trim(),
        birth: String((user && user.birth) || '').trim(),
        visited: String((user && user.visited) || '').trim(),
        status: String((user && user.status) || '').trim(),
        health: String((user && user.health) || '').trim()
    };

    const hasAll = resolved.name && resolved.phone && resolved.birth && resolved.visited && resolved.status && resolved.health;
    if (hasAll || !sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return resolved;
    }

    const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
    const inputPhone = normalizePhone(resolved.phone);
    const inputName = String(resolved.name || '').trim().toLowerCase();

    const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:G`, 'A:G'];
    for (const range of rangesToTry) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range
            });
            const rows = resp.data.values || [];
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i] || [];
                const rowName = String(row[1] || '').trim();
                const rowPhone = String(row[2] || '').trim();
                const rowPhoneNormalized = normalizePhone(rowPhone);
                const rowNameLower = rowName.toLowerCase();

                const phoneMatch = inputPhone && rowPhoneNormalized && inputPhone === rowPhoneNormalized;
                const nameMatch = !inputPhone && inputName && rowNameLower === inputName;
                if (!phoneMatch && !nameMatch) continue;

                if (!resolved.name) resolved.name = String(row[1] || '').trim();
                if (!resolved.phone) resolved.phone = String(row[2] || '').trim();
                if (!resolved.birth) resolved.birth = String(row[3] || '').trim();
                if (!resolved.visited) resolved.visited = String(row[4] || '').trim();
                if (!resolved.status) resolved.status = String(row[5] || '').trim();
                if (!resolved.health) resolved.health = String(row[6] || '').trim();

                return resolved;
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            break;
        }
    }

    return resolved;
}

async function registerForSelectedEvent(chatId, user, providedName, providedPhone) {
    const eventId = user.selectedEventId;
    const eventName = user.selectedEventName;
    if (!eventId || !eventName) {
        return { status: 'no-selection' };
    }

    const seatsLeft = await getSeatsLeft(eventId);
    if (seatsLeft <= 0) {
        return { status: 'no-seats' };
    }

    const registrantProfile = await resolveRegistrantProfile(chatId, user, providedName || '', providedPhone || '');

    const evObj = events.find(e => e.id === eventId);
    if (evObj) {
        const alreadyRegistered = await isRegistrantAlreadyInEventNote(evObj, registrantProfile);
        if (alreadyRegistered) {
            return { status: 'already-registered' };
        }
    }

    await appendEventRegistration(eventId, chatId, {
        name: registrantProfile.name,
        phone: registrantProfile.phone
    });

    if (evObj) {
        await incrementSheetRegistration(evObj, {
            userId: registrantProfile.userId,
            name: registrantProfile.name,
            phone: registrantProfile.phone
        });
        evObj.registrations = (evObj.registrations || 0) + 1;
        if (typeof evObj.seats === 'number') evObj.seats = Math.max(0, evObj.seats - 1);
    }

    if (user.step === 7) {
        if (!user.selectedEvents) user.selectedEvents = [];
        user.selectedEvents.push({ id: eventId, name: eventName });
    }

    delete user.selectedEventName;
    delete user.selectedEventId;
    delete user.afishaFullRegistration;
    delete user.afishaPendingEventId;
    delete user.afishaPendingEventName;

    return { status: 'ok' };
}

// додаткові допоміжні функції для реєстрацій на заходи
async function getSeatRegistrations(eventId) {
    const event = events.find(e => e.id === eventId);
    if (!event) return 0;
    return Number.isFinite(event.registrations) ? event.registrations : 0;
}

// повертає перелік eventId, на які userId зареєстрований
async function getUserRegisteredEventIds(userId) {
    return [];
}

async function getSeatsLeft(eventId) {
    const event = events.find(e => e.id === eventId);
    if (!event) return 0;
    return Math.max(0, Number(event.seats) || 0);
}

async function appendEventToSheet(date, time, title, capacity) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
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
    console.error(`   ❌ Не знайдено аркуш для запису розкладу (${SCHEDULE_SHEET_CANDIDATES.join(', ')})`);
}

async function appendEventRegistration(eventId, userId, registrantInfo) {
    return true;
}

/* === ОБРОБКА МАСИВУ РОЗПАРЕНИХ ЗАХОДІВ === */
async function processParsedEvents(parsedEvents) {
    for (const evt of parsedEvents) {
        const eventDate = new Date(
            parseInt(evt.date.split('.')[2]),
            parseInt(evt.date.split('.')[1]) - 1,
            parseInt(evt.date.split('.')[0]),
            parseInt(evt.time.split(':')[0]),
            parseInt(evt.time.split(':')[1]),
            0
        );

        const eventId = `${evt.title.replace(/\s+/g, '_')}_${evt.date}_${evt.time}`;

        const exists = events.some(e => e.id === eventId);

        if (!exists && eventDate > new Date()) {
            events.push({
                id: eventId,
                name: evt.title,
                date: eventDate,
                seats: evt.capacity,
                registrations: 0
            });

            await appendEventToSheet(evt.date, evt.time, evt.title, evt.capacity);
            console.log(`   💾 Записано в Sheets: ${evt.title}`);
        }
        }
    }


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";

    if (!text) return;

    // respond to /start command by showing main menu
    if (text === '/start') {
        bot.sendMessage(chatId, "Меню:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        delete users[chatId];
        return;
    }

    // === ОБРОБКА ПОВІДОМЛЕНЬ З ГРУПИ/КАНАЛУ ===
    // Только з офіційної групи (за ID)
    const chatIds = [];
    if (typeof CHAT_ID !== 'undefined' && CHAT_ID) chatIds.push(Number(CHAT_ID));
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) chatIds.push(Number(GROUP_ID));
    const authorizedChat = chatIds.includes(msg.chat.id);
    
    // Дебаг: показуємо кожне повідомлення з групи
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel') {
        const status = authorizedChat ? '✅' : '❌';
        console.log(`📌 Група (ID: ${msg.chat.id}, тип: ${msg.chat.type}) ${status}`);
    }

    if (authorizedChat &&
        (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || msg.chat.type === 'channel')) {
        console.log('   ✅ Парсинг розпочато...');

        // Візьмемо текст із повідомлення або підпису (caption)
        const fullText = msg.text || msg.caption || '';
        if (!fullText) {
            console.log('   ⚠️  Порожній текст');
            return;
        }

        // === ПЕРЕВІРКА ДАТИ = СЬОГОДНІ ===
        const today = new Date();
        const todayStr = `${today.getDate()}.${today.getMonth()+1}.${today.getFullYear()}`;
        
        if (!fullText.includes(todayStr)) {
            console.log(`   ⚠️  Дата в посте не сьогодні (сьогодні: ${todayStr})`);
            return;
        }

        // Розбиваємо на рядки
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l);
        console.log("   📩 Рядки для парсингу:", lines);

        // Регулярні вирази для нового формату
        const dateRegex = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;  // DD.MM.YYYY
        const timeRegex = /(\d{1,2}):(\d{2})/;              // HH:MM
        const dashSplit = /\s*–\s*/;                         // Розділювач –

        let currentDate = null;
        let parsedEvents = [];

        lines.forEach((line, lineNum) => {
            const dateMatch = line.match(dateRegex);
            const timeMatch = line.match(timeRegex);

            // Якщо рядок містить дату → зберегти як поточну дату
            if (dateMatch) {
                const day = dateMatch[1];
                const month = dateMatch[2];
                const year = dateMatch[3];
                currentDate = { day, month, year, dateStr: `${day}.${month}.${year}` };
                console.log(`   📅 Знайдена дата: ${currentDate.dateStr}`);
            }

            // Якщо рядок містить час → розпарсити як захід
            if (timeMatch && currentDate) {
                const hour = timeMatch[1];
                const minute = timeMatch[2];
                const timeStr = `${hour}:${minute}`;

                // Розділяти рядок по символу –
                const parts = line.split(dashSplit).map(p => p.trim());
                
                // Розташування: [HH:MM – назва – місця]
                let title = '';
                let capacityStr = '';

                if (parts.length >= 2) {
                    // Перший елемент містить час, знаходимо його і беремо решту
                    const timePartIndex = parts.findIndex(p => p.includes(':'));
                    if (timePartIndex >= 0) {
                        title = parts.slice(timePartIndex + 1, parts.length - 1).join(' – ');
                        capacityStr = parts[parts.length - 1];
                    }
                }

                // Обробляємо "немає місць"
                let capacity = 10;
                if (capacityStr.toLowerCase().includes('немає')) {
                    capacity = 0;
                } else {
                    const capMatch = capacityStr.match(/\d+/);
                    if (capMatch) capacity = parseInt(capMatch[0]);
                }

                if (title) {
                    parsedEvents.push({
                        date: currentDate.dateStr,
                        time: timeStr,
                        title: title,
                        capacity: capacity
                    });
                    console.log(`   ✅ Захід: ${title} | ${timeStr} | ${formatSeatsCount(capacity)}`);
                }
            }
        });

        // Додаємо до пам'яті та Google Sheets
        await processParsedEvents(parsedEvents);

        return; // Не обробляємо групові повідомлення як команди користувача
    }

    // === ОБРОБКА КОРИСТУВАЦЬКИХ ПОВІДОМЛЕНЬ ===
    if (!users[chatId]) {
        users[chatId] = { step: 0 };
    }

    let user = users[chatId];

    // === ОБРОБКА ЗВЕРНЕНЬ - ПЕРЕВІРЯЄМО ПЕРШИМ ===
    if (text === "Скасувати" && user.context === 'appeal') {
        user.context = null;
        user.step = 0;
        bot.sendMessage(chatId, "Меню:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // Якщо користувач в режимі звернень - обробляємо його текст ДО всього іншого
    if (user.context === 'appeal' && user.step === 1) {
        const userName = knownUsers[chatId]?.name || `користувач ${chatId}`;
        const userPhone = knownUsers[chatId]?.phone || 'не вказаний';
        
        // Форматуємо дату та час
        const now = new Date();
        const dateStr = now.toLocaleDateString('uk-UA');
        const timeStr = now.toLocaleTimeString('uk-UA');

        const appealMessage = `
📬 <b>Нове звернення</b>

👤 <b>Від кого:</b> ${userName}
📱 <b>Телефон:</b> ${userPhone}
🔗 <b>Telegram ID:</b> <code>${chatId}</code>

📅 <b>Дата і час:</b> ${dateStr} о ${timeStr}

📝 <b>Текст звернення:</b>
<code>${text}</code>

━━━━━━━━━━━━━━━━━━━━━
📲 Відповідь: натисніть на повідомлення → Reply
        `;

        // Відправляємо звернення в групу "Відгуки"
        console.log(`📬 Обробка звернення від ${chatId}: "${text.substring(0, 50)}..."`);
        if (APPEALS_GROUP_ID) {
            try {
                await bot.sendMessage(APPEALS_GROUP_ID, appealMessage, {
                    parse_mode: 'HTML'
                });
                console.log(`✅ Звернення відправлено в групу ${APPEALS_GROUP_ID}`);
                bot.sendMessage(chatId, "✅ Дякуємо! Ваше звернення надіслано.\n\nНаша команда обов'язково його прочитає і зв'яжеться з вами якомога швидше. 🩵", {
                    reply_markup: {
                        keyboard: [[{ text: "Повернутися в меню" }]],
                        resize_keyboard: true
                    }
                });
                user.step = 0;
                user.context = null;
            } catch (error) {
                console.error('❌ Помилка при відправці звернення:', error);
                bot.sendMessage(chatId, "❌ Виникла помилка. Спробуйте пізніше.", {
                    reply_markup: {
                        keyboard: [[{ text: "Повернутися в меню" }]],
                        resize_keyboard: true
                    }
                });
                user.step = 0;
                user.context = null;
            }
        } else {
            console.error('⚠️ APPEALS_GROUP_ID не встановлено!');
            bot.sendMessage(chatId, "⚠️ Групу не налаштовано. Спробуйте написати напряму фахівцям.", {
                reply_markup: {
                    keyboard: [[{ text: "Повернутися в меню" }]],
                    resize_keyboard: true
                }
            });
            user.step = 0;
            user.context = null;
        }
        return;
    }

    if (text === "Реєстрація") {
        // Спочатку запитуємо особисті дані
        user.step = 1;
        bot.sendMessage(chatId, "Прізвище Ім'я По-батькові");
        return;
    }

    if (text === "Афіша заходів") {
        // покажемо меню днів тижня
        user.context = 'afisha';
        await showAfishaDaysMenu(chatId);
        return;
    }

    if (text === "Контакти") {
        const contactsMessage = `
    🩵 <b>Простір «Вільна»</b>

«Вільна» — це безпечний жіночий простір підтримки, прийняття та відновлення.
Ми створили місце, де можна бути собою, говорити відкрито, отримувати фахову допомогу та відчувати опору.

🕐 <b>Графік роботи:</b> 11:00 – 20:00 (середа–неділя)

📍 <b>Адреса:</b>
м. Дніпро, вул. Дмитра Донцова, 4

💬 <b>Наша Telegram-група:</b>
<a href="https://t.me/vilna_dnipro">https://t.me/vilna_dnipro</a>

💌 <b>Наша команда:</b>

👩🏻 <b>Менеджерка Бондаренко Христина</b> 🪻
@devohka_bonda
допоможе з організаційними питаннями, записом на заходи, реєстрацією, розкладом та зорієнтує щодо можливостей простору.

👩🏻 <b>Соціальна фахівчиня Дарина Криворучко</b> 🌷
@DarynaVilna
надає соціальні консультації, здійснює супровід у складних життєвих обставинах та допомагає знайти необхідні ресурси й підтримку.

👩🏻 <b>Психологиня Людмила Вознюк</b> 🌹
@luidmila_psi
проводить індивідуальні консультації та групи підтримки, допомагає впоратися з тривогою, емоційним виснаженням, переживаннями та кризовими станами.

📩 Ви можете написати напряму фахівчині або залишити звернення через цей чат-бот — ми обов'язково зв'яжемося з вами.

Ми поруч. Ти не одна 🩵
        `;
        
        user.context = 'contacts';
        bot.sendMessage(chatId, contactsMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Написати звернення" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Написати звернення") {
        user.context = 'appeal';
        user.step = 1;
        const appealInstructions = `
📝 <b>Напишіть своє звернення</b>

Ви можете написати нам про:
• Питання, що вас цікавлять
• Пропозиції та ідеї
• Проблеми, які потребують рішення
• Ваші враження від відвідування

Ваше звернення буде передане безпосередньо команді "Вільної", яка обов'язково його прочитає та зв'яжеться з вами якомога швидше. 🤝

⬇️ <b>Напишіть текст звернення нижче</b> (або натисніть "Скасувати")
        `;
        bot.sendMessage(chatId, appealInstructions, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: "Скасувати" }]],
                resize_keyboard: true
            }
        });
        return;
    }

    // якщо натиснутий день тижня, делегуємо показ загального меню на відповідну функцію
    const weekdays = { 'Неділя':0, 'Середа':3, 'Четвер':4, 'П’ятниця':5, 'Субота':6 };
    if (weekdays[text] !== undefined) {
        await showDayAgenda(chatId, text);
        return;
    }

    // Перевіряємо чи натиснута кнопка з заходом
    let selectedEvent = null;
    if (user.eventButtonMap && user.eventButtonMap[text]) {
        selectedEvent = getAllEvents().find((eventItem) => eventItem.id === user.eventButtonMap[text]) || null;
    }
    if (!selectedEvent) {
        selectedEvent = getAllEvents().find((eventItem) => text.includes(eventItem.name));
    }

    if (selectedEvent) {
        // compute seats left asynchronously before replying
        const seatsLeft = await getSeatsLeft(selectedEvent.id);
        const seatsInfo = seatsLeft > 0 
            ? `💺 Місць залишилось: ${formatSeatsCount(seatsLeft)}\n` 
            : `❌ Місця закінчилися\n`;
        
        // build keyboard options
        const buttons = [];
        if (seatsLeft > 0) {
            buttons.push([{ text: "Реєструватися" }]);
        } else {
            buttons.push([{ text: "Місць немає" }]);
        }
        buttons.push([{ text: "Назад до вибору днів" }]);

        bot.sendMessage(chatId, `✅ Ви вибрали: ${selectedEvent.name}\n📅 ${formatEventDate(selectedEvent.date)}\n${seatsInfo}`, {
            reply_markup: {
                keyboard: buttons,
                resize_keyboard: true
            }
        });
        
        // Зберігаємо вибраний захід для наступного кроку
        user.selectedEventName = selectedEvent.name;
        user.selectedEventId = selectedEvent.id;
        return;
    }



    // Обробка реєстрації на захід
    if (text === "Реєструватися") {
        try {
            const registrantData = await resolveRegistrantFormData(chatId, user);

            const missingStep = !registrantData.name ? 1
                : !registrantData.phone ? 2
                : !registrantData.birth ? 3
                : !registrantData.visited ? 4
                : !registrantData.status ? 5
                : !registrantData.health ? 6
                : 0;

            if (missingStep > 0) {
                user.afishaFullRegistration = true;
                user.afishaPendingEventId = user.selectedEventId;
                user.afishaPendingEventName = user.selectedEventName;

                user.name = registrantData.name;
                user.phone = registrantData.phone;
                user.birth = registrantData.birth;
                user.visited = registrantData.visited;
                user.status = registrantData.status;
                user.health = registrantData.health;
                user.step = missingStep;

                if (missingStep === 1) {
                    bot.sendMessage(chatId, "Прізвище Ім'я По-батькові");
                } else if (missingStep === 2) {
                    bot.sendMessage(chatId, "Телефон (380...)");
                } else if (missingStep === 3) {
                    bot.sendMessage(chatId, "Дата народження");
                } else if (missingStep === 4) {
                    bot.sendMessage(chatId, "Чи відвідували Простір раніше?", {
                        reply_markup: {
                            keyboard: [[{ text: "Так" }, { text: "Ні" }]],
                            resize_keyboard: true
                        }
                    });
                } else if (missingStep === 5) {
                    bot.sendMessage(chatId, "ВПО/МО:", {
                        reply_markup: {
                            keyboard: [[{ text: "ВПО" }, { text: "Місцева" }]],
                            resize_keyboard: true
                        }
                    });
                } else if (missingStep === 6) {
                    bot.sendMessage(chatId, "Інвалідність/суттєві проблеми:", {
                        reply_markup: {
                            keyboard: [
                                [{ text: "Інвалідність" }],
                                [{ text: "Суттєві проблеми" }],
                                [{ text: "Немає" }]
                            ],
                            resize_keyboard: true
                        }
                    });
                }
                return;
            }

            if (user.context === 'afisha') {
                user.name = registrantData.name;
                user.phone = registrantData.phone;
                user.birth = registrantData.birth;
                user.visited = registrantData.visited;
                user.status = registrantData.status;
                user.health = registrantData.health;

                await appendRegistrationRow(chatId, user);
            }

            const result = await registerForSelectedEvent(chatId, user, registrantData.name, registrantData.phone);

            if (result.status === 'no-selection') {
                bot.sendMessage(chatId, "Спочатку оберіть захід.");
                return;
            }

            if (result.status === 'no-seats') {
                bot.sendMessage(chatId, "❌ Вибачте, місця закінчилися.");
                return;
            }

            if (result.status === 'already-registered') {
                bot.sendMessage(chatId, "ℹ️ Ви вже зареєстровані на цей захід.");
                return;
            }
        } catch (registrationError) {
            console.error('Error during event registration flow', registrationError && registrationError.message ? registrationError.message : registrationError);
            bot.sendMessage(chatId, "Помилка при записі реєстрації в таблицю. Спробуйте ще раз.");
            return;
        }

        bot.sendMessage(chatId, "✅ Ви успішно зареєстровані на захід!", {
            reply_markup: {
                keyboard: [
                    [{ text: "Обрати ще захід" }],
                    [{ text: "✅ Завершити" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Обрати ще захід" && user.step === 7) {
        // Вернуться к списку доступних заходів (исключив те, на которые уже зарегистрировались)
        const allEvents = getAllEvents();
        const avail = [];
        const eventButtonMap = {};
        const registeredIds = user.selectedEvents ? user.selectedEvents.map(e => e.id) : [];
        for (const ev of allEvents) {
            if (registeredIds.includes(ev.id)) continue; // пропустити вже вибрані
            const seatsLeft = await getSeatsLeft(ev.id);
            if (seatsLeft > 0) avail.push(Object.assign({}, ev, { seatsLeft }));
        }
        if (avail.length === 0) {
            bot.sendMessage(chatId, "Немає ще доступних заходів 🤍", {
                reply_markup: {
                    keyboard: [[{ text: "✅ Завершити" }]],
                    resize_keyboard: true
                }
            });
            return;
        }
        const eventButtons = avail.map(event => {
            const buttonText = `${event.name} | ${formatEventDate(event.date)} | 💺 ${formatSeatsCount(event.seatsLeft)}`;
            eventButtonMap[buttonText] = event.id;
            return [{ text: buttonText }];
        });
        user.eventButtonMap = eventButtonMap;
        eventButtons.push([{ text: "✅ Завершити" }]);
        bot.sendMessage(chatId, "Натисніть на захід, на який бажаєте зареєструватись:", {
            reply_markup: {
                keyboard: eventButtons,
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Назад до вибору днів") {
        delete user.selectedEventName;
        delete user.selectedEventId;
        delete user.eventButtonMap;
        user.context = 'afisha';
        await showAfishaDaysMenu(chatId);
        return;
    }

    if (text === "Назад") {
        delete user.afishaFullRegistration;
        delete user.afishaPendingEventId;
        delete user.afishaPendingEventName;

        if (user.context === 'afisha') {
            delete user.selectedEventName;
            delete user.selectedEventId;
            delete user.eventButtonMap;
            await showAfishaDaysMenu(chatId);
            return;
        }

        delete user.selectedEventName;
        delete user.eventButtonMap;
        user.context = null;
        bot.sendMessage(chatId, "Меню:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        delete users[chatId];
        return;
    }

    if (text === "Повернутися в меню") {
        if (users[chatId]) {
            delete users[chatId].eventButtonMap;
            delete users[chatId].afishaFullRegistration;
            delete users[chatId].afishaPendingEventId;
            delete users[chatId].afishaPendingEventName;
        }
        delete users[chatId];
        bot.sendMessage(chatId, "Меню:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.step === 1) {
        user.name = text;
        user.step = 2;

        bot.sendMessage(chatId, "Телефон (380...)");
        return;
    }

    if (user.step === 2) {
        user.phone = text;
        user.step = 3;

        bot.sendMessage(chatId, "Дата народження");
        return;
    }

    if (user.step === 3) {
        user.birth = text;
        user.step = 4;

        // step 4: ask visited with buttons
        bot.sendMessage(chatId, "Чи відвідували Простір раніше?", {
            reply_markup: {
                keyboard: [[{ text: "Так" }, { text: "Ні" }]],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.step === 4) {
        user.visited = text;
        user.step = 5;

        // step 5: status buttons
        bot.sendMessage(chatId, "ВПО/МО:", {
            reply_markup: {
                keyboard: [[{ text: "ВПО" }, { text: "Місцева" }]],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.step === 5) {
        user.status = text;
        user.step = 6;

        // step 6: health buttons
        bot.sendMessage(chatId, "Інвалідність/суттєві проблеми:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Інвалідність" }],
                    [{ text: "Суттєві проблеми" }],
                    [{ text: "Немає" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.step === 6) {

        user.health = text;

        try {
            await appendRegistrationRow(chatId, user);

            if (user.afishaFullRegistration) {
                user.selectedEventId = user.afishaPendingEventId;
                user.selectedEventName = user.afishaPendingEventName;

                const result = await registerForSelectedEvent(chatId, user, user.name || '', user.phone || '');
                if (result.status === 'no-selection') {
                    bot.sendMessage(chatId, "Спочатку оберіть захід.");
                    return;
                }
                if (result.status === 'no-seats') {
                    bot.sendMessage(chatId, "❌ Вибачте, місця закінчилися.");
                    return;
                }

                if (result.status === 'already-registered') {
                    bot.sendMessage(chatId, "ℹ️ Ви вже зареєстровані на цей захід.");
                    return;
                }

                bot.sendMessage(chatId, "✅ Ви успішно зареєстровані на захід!", {
                    reply_markup: {
                        keyboard: [
                            [{ text: "Назад" }],
                            [{ text: "Повернутися в меню" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            bot.sendMessage(chatId, "✅ Ваші дані збережено!", {
                reply_markup: {
                    keyboard: [[{ text: "Далі" }]],
                    resize_keyboard: true
                }
            });
        } catch (err) {
            console.error('Помилка запису в таблицю під час діалогу:', err);
            bot.sendMessage(chatId, "Помилка при збереженні даних у таблиці.", {
                reply_markup: {
                    keyboard: [[{ text: "Далі" }]],
                    resize_keyboard: true
                }
            });
        }

        // Перейти до обрання заходів
        user.step = 7;
        user.selectedEvents = [];
        return;
    }

    // Коли натиснули "Далі" після вводу особистих даних
    if (user.step === 7 && text === "Далі") {
        const allEvents = getAllEvents();
        const avail = [];
        const eventButtonMap = {};
        for (const ev of allEvents) {
            const seatsLeft = await getSeatsLeft(ev.id);
            if (seatsLeft > 0) avail.push(Object.assign({}, ev, { seatsLeft }));
        }
        if (avail.length === 0) {
            bot.sendMessage(chatId, "Наразі немає заходів з вільними місцями 🤍", {
                reply_markup: {
                    keyboard: [[{ text: "Повернутися в меню" }]],
                    resize_keyboard: true
                }
            });
            delete users[chatId];
            return;
        }
        const eventButtons = avail.map(event => {
            const buttonText = `${event.name} | ${formatEventDate(event.date)} | 💺 ${formatSeatsCount(event.seatsLeft)}`;
            eventButtonMap[buttonText] = event.id;
            return [{ text: buttonText }];
        });
        user.eventButtonMap = eventButtonMap;
        eventButtons.push([{ text: "✅ Завершити" }]);
        bot.sendMessage(chatId, "Натисніть на захід, на який бажаєте зареєструватись. Потім натисніть Завершити:", {
            reply_markup: {
                keyboard: eventButtons,
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.step === 7) {
        // Завершить реєстрацію
        if (text === "✅ Завершити") {
            const count = user.selectedEvents ? user.selectedEvents.length : 0;
            const eventWord = pluralizeEvents(count);
            
            let message = `Дякуємо за реєстрацію! Ви зареєстровані на ${count} ${eventWord}. 🤍\n\n`;
            
            // Додаємо список усіх вибраних заходів
            if (user.selectedEvents && user.selectedEvents.length > 0) {
                message += `📋 Ваші заходи:\n\n`;
                for (let i = 0; i < user.selectedEvents.length; i++) {
                    const ev = user.selectedEvents[i];
                    const event = events.find(e => e.id === ev.id);
                    if (event) {
                        const dateStr = formatEventDate(event.date);
                            message += `${i+1}. <b>${event.name}</b>\n   📅 ${dateStr}\n\n`;
                        }
                    }
                }
            
                bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [[{ text: "Повернутися в меню" }]],
                        resize_keyboard: true
                    }
                });
                delete users[chatId];
                return;
        }

        // Перевіряємо чи це натиск на захід (беремо актуальний список з вільними місцями)
        const allEvents = getAllEvents();
        const avail = [];
        const registeredIds = user.selectedEvents ? user.selectedEvents.map(e => e.id) : [];
        for (const ev of allEvents) {
            if (registeredIds.includes(ev.id)) continue; // пропустити вже вибрані
            const seatsLeft = await getSeatsLeft(ev.id);
            if (seatsLeft > 0) avail.push(Object.assign({}, ev, { seatsLeft }));
        }

        let selectedEvent = null;
        if (user.eventButtonMap && user.eventButtonMap[text]) {
            selectedEvent = avail.find((eventItem) => eventItem.id === user.eventButtonMap[text]) || null;
        }
        if (!selectedEvent) {
            selectedEvent = avail.find((eventItem) => text.includes(eventItem.name));
        }

        if (selectedEvent) {
            // Показати деталі заходу з кнопкою реєстрації
            const seatsLeft = await getSeatsLeft(selectedEvent.id);
            const seatsInfo = seatsLeft > 0 
                ? `💺 Місць залишилось: ${formatSeatsCount(seatsLeft)}\n` 
                : `❌ Місця закінчилися\n`;
            
            const buttons = [];
            if (seatsLeft > 0) {
                buttons.push([{ text: "Реєструватися" }]);
            }
            buttons.push([{ text: "Назад до списку" }]);

            bot.sendMessage(chatId, `✅ Ви вибрали: ${selectedEvent.name}\n📅 ${formatEventDate(selectedEvent.date)}\n${seatsInfo}`, {
                reply_markup: {
                    keyboard: buttons,
                    resize_keyboard: true
                }
            });
            
            // Зберігаємо вибраний захід для наступного кроку
            user.selectedEventName = selectedEvent.name;
            user.selectedEventId = selectedEvent.id;
            return;
        }

        // Обробка кнопки "Назад до списку" під час перегляду деталей
        if (text === "Назад до списку") {
            // Показати список знов
            const allEventsForList = getAllEvents();
            const availForList = [];
            const regIds = user.selectedEvents ? user.selectedEvents.map(e => e.id) : [];
            for (const ev of allEventsForList) {
                if (regIds.includes(ev.id)) continue;
                const sl = await getSeatsLeft(ev.id);
                if (sl > 0) availForList.push(Object.assign({}, ev, { seatsLeft: sl }));
            }
            if (availForList.length === 0) {
                bot.sendMessage(chatId, "Немає ще доступних заходів 🤍", {
                    reply_markup: {
                        keyboard: [[{ text: "✅ Завершити" }]],
                        resize_keyboard: true
                    }
                });
                return;
            }
            const eventButtonMap = {};
            const eventButtons = availForList.map(event => {
                const buttonText = `${event.name} | ${formatEventDate(event.date)} | 💺 ${formatSeatsCount(event.seatsLeft)}`;
                eventButtonMap[buttonText] = event.id;
                return [{ text: buttonText }];
            });
            user.eventButtonMap = eventButtonMap;
            eventButtons.push([{ text: "✅ Завершити" }]);
            bot.sendMessage(chatId, "Натисніть на захід, на який бажаєте зареєструватись:", {
                reply_markup: {
                    keyboard: eventButtons,
                    resize_keyboard: true
                }
            });
            delete user.selectedEventName;
            delete user.selectedEventId;
            return;
        }
    }

});

console.log("⏳ Бот ініціалізується. Telegram webhook автоматично встановлюється після підключення до Google Sheets.");
console.log("📋 Розклад:", config.SPREADSHEET_ID);
console.log("👤 Персональні дані:", config.PERSONAL_DATA_SPREADSHEET_ID);
