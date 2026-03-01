require('dotenv').config();

const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

const TOKEN = process.env.TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const CHAT_ID = process.env.CHAT_ID;
// Таблиця для розкладу та реєстрацій на заходи
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8";
// Таблиця для персональних даних (ПІБ, телефон тощо)
const PERSONAL_DATA_SPREADSHEET_ID = process.env.PERSONAL_DATA_SPREADSHEET_ID || "1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE";

// Таблиця розкладу: https://docs.google.com/spreadsheets/d/1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8/edit
// Таблиця персональних даних: https://docs.google.com/spreadsheets/d/1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE/edit


if (!SPREADSHEET_ID) {
    console.log("SPREADSHEET_ID не встановлений");
}
console.log("📋 Таблиця розкладу:", SPREADSHEET_ID);
console.log("👤 Таблиця персональних даних:", PERSONAL_DATA_SPREADSHEET_ID);

if (!TOKEN) {
    console.error("TOKEN не встановлено");
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

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

// Форматує блок інформації про захід для повідомлення
function formatEventDetails(event) {
    const time = String(event.date.getHours()).padStart(2,'0')+":"+
                 String(event.date.getMinutes()).padStart(2,'0');
    const seatsLeft = event.seats - (event.registrations || 0);
    const seatsLabel = seatsLeft > 0 ? `${seatsLeft} місць` : "❌ закрито";
    return `Назва: ${event.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}`;
}

// Відображає афішу для конкретного дня
async function showDayAgenda(chatId, dayName) {
    const weekdays = { 'Неділя':0, 'Середа':3, 'Четвер':4, 'П’ятниця':5, 'Субота':6 };
    const dayNum = weekdays[dayName];
    const dayEvents = getEventsForDay(dayNum);
    dayEvents.sort((a,b)=>a.date-b.date);
    
    if (dayEvents.length === 0) {
        const dayForms = {
            'Середа': 'середу',
            'Четвер': 'четвер',
            'П’ятниця': 'п’ятницю',
            'Субота': 'суботу',
            'Неділя': 'неділю'
        };

        bot.sendMessage(chatId, `На ${dayForms[dayName] || dayName} немає заходів.`, {
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
        return;
    }
    let msg = `📅 Заходи в ${dayName}:\n\n`;
    const buttons = [];
    for (const ev of dayEvents) {
        const seatsLeft = await getSeatsLeft(ev.id);
        const time = String(ev.date.getHours()).padStart(2,'0')+":"+String(ev.date.getMinutes()).padStart(2,'0');
        const seatsLabel = seatsLeft > 0 ? `💺 ${seatsLeft} місць` : `❌ закрито`;
        msg += `Назва: ${ev.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}\n\n`;
        buttons.push([{ text: `${ev.name} | ${time} | ${seatsLabel}` }]);
    }
    buttons.push([{ text: "Повернутися в меню" }]);

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

async function incrementSheetRegistration(event) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    try {
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "Розклад!A:E"
        });
        const rows = resp.data.values || [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const dateStr = (row[0] || '').toString().trim();
            const timeStr = (row[1] || '').toString().trim();
            const title = (row[2] || '').toString().trim();
            if (dateStr === formatSheetDate(event.date) && timeStr === formatSheetTime(event.date) && title === event.name) {
                const currReg = parseInt(row[4] || '0', 10);
                const newReg = currReg + 1;
                const currCap = parseInt(row[3] || '0', 10);
                const newCap = Math.max(0, currCap - 1);
                const range = `Розклад!D${i+1}:E${i+1}`;
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[newCap, newReg]] }
                });
                break;
            }
        }
    } catch (e) {
        console.error('Error incrementing registration count', e);
    }
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

async function initSheets() {
    try {
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON не встановлено");
        }

        console.log("🔑 Використовую Google credentials зі змінної середовища");
        const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });

        const client = await auth.getClient();

        sheetsClient = google.sheets({
            version: "v4",
            auth: client
        });

        console.log("Google Sheets підключено ✅");

        // Початкове завантаження розкладу та періодичне оновлення
        try {
            await loadEventsFromSheet();
        } catch (e) {
            console.error('Initial loadEventsFromSheet failed', e);
        }
        setInterval(() => {
            loadEventsFromSheet();
        }, 60000);

    } catch (err) {
        console.error("Sheets error", err);
    }
}

initSheets();

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
        // Попробуем сначала лист 'Розклад'
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: "Розклад!A:E"
            });
            rows = resp.data.values || [];
            if (rows && rows.length) console.log('   Використано лист Розклад');
        } catch (err) {
            // не критично — попробуем альтернативы
        }

        // Если нет строк в "Розклад", попробуем альтернативные листы
        if (!rows || rows.length === 0) {
            try {
                const alt = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: "Заходи!A:E"
                });
                rows = alt.data.values || [];
                if (rows && rows.length) console.log('   Використано лист Заходи');
            } catch (e) {
                // игнорировать
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
                // игнорировать
            }
        }

        // Очистити поточні заходи перед завантаженням
        events = [];
        const seen = new Set();

        for (const [i, row] of rows.entries()) {
            // Пропускаємо заголовок
            if (i === 0) continue;
            if (!row || row.length < 5) continue;
            const dateStr = row[0].trim();
            const timeStr = row[1].trim();
            const title = row[2].trim();
            const seats = parseInt(row[3], 10) || 0;
            const registrations = parseInt(row[4], 10) || 0;

            // Парсимо дату і час
            const dateParts = dateStr.split('.');
            if (dateParts.length !== 3) continue;
            const day = parseInt(dateParts[0], 10);
            const month = parseInt(dateParts[1], 10) - 1;
            const year = parseInt(dateParts[2], 10);
            const timeParts = timeStr.split(':');
            if (timeParts.length !== 2) continue;
            const hour = parseInt(timeParts[0], 10);
            const minute = parseInt(timeParts[1], 10);
            const eventDate = new Date(year, month, day, hour, minute, 0);
            if (isNaN(eventDate.getTime())) continue;

            const id = `${title.replace(/\s+/g,'_')}_${dateStr}_${timeStr}`;
            events.push({
                id,
                name: title,
                date: eventDate,
                seats,
                registrations
            });
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

    console.log('appendRegistrationRow -> writing to Березень:', values);

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
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: "Березень!A:G",
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [values] }
            });
            console.log("Записано в таблицю Березень ✅");
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
                    await sheetsClient.spreadsheets.values.append({
                        spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                        range: "A:G",
                        valueInputOption: "USER_ENTERED",
                        requestBody: { values: [values] }
                    });
                    console.log("Записано в таблицю (fallback A:G) ✅");
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

// додаткові допоміжні функції для реєстрацій на заходи
async function getSeatRegistrations(eventId) {
    if (!sheetsClient || !SPREADSHEET_ID) return 0;
    try {
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "Реєстрація!A:E"
        });
        const rows = resp.data.values || [];
        return rows.filter(r => r[0] === eventId).length;
    } catch (e) {
        console.error('Error reading registrations sheet', e);
        return 0;
    }
}

// повертає перелік eventId, на які userId зареєстрований
async function getUserRegisteredEventIds(userId) {
    if (!sheetsClient || !SPREADSHEET_ID) return [];
    try {
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "Реєстрація!A:C"
        });
        const rows = resp.data.values || [];
        return rows.filter(r=>r[1] === String(userId)).map(r=>r[0]);
    } catch (e) {
        console.error('Error reading registrations sheet', e);
        return [];
    }
}

async function getSeatsLeft(eventId) {
    const event = events.find(e => e.id === eventId);
    if (!event) return 0;
    const used = await getSeatRegistrations(eventId);
    return event.seats - used;
}

async function appendEventToSheet(date, time, title, capacity) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    try {
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "Заходи!A:D",
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [[date, time, title, capacity]]
            }
        });
        console.log('   ✅ Захід записано у Sheets');
    } catch (e) {
        console.error('   ❌ Помилка запису у Sheets:', e.message);
    }
}

async function appendEventRegistration(eventId, userId) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    try {
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "Реєстрація!A:C",
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [[eventId, userId.toString(), new Date().toISOString()]]
            }
        });
        console.log('Registration added for', userId, 'event', eventId);
    } catch (e) {
        console.error('Error appending registration', e);
    }
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
                    console.log(`   ✅ Захід: ${title} | ${timeStr} | ${capacity} місць`);
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

    if (text === "Реєстрація") {
        // Спочатку запитуємо особисті дані
        user.step = 1;
        bot.sendMessage(chatId, "Введіть ПІБ");
        return;
    }

    if (text === "Афіша заходів") {
        // покажемо меню днів тижня
        user.context = 'afisha';
        bot.sendMessage(chatId, "Оберіть день:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Середа" }],
                    [{ text: "Четвер" }],
                    [{ text: "П’ятниця" }],
                    [{ text: "Субота" }],
                    [{ text: "Неділя" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Контакти") {
        const contactsMessage = `
🤍 <b>Простір «Вільна»</b>

📍 <b>Де знаходиться:</b>
вул. Дмитра Донцова, 4

👩‍💼 <b>Менеджерка:</b>
<a href="https://t.me/devohka_bonda">@devohka_bonda</a>

👩‍💼 <b>Соціальна фахівчиня:</b>
<a href="https://t.me/DarynaVilna">@DarynaVilna</a>

👩‍⚕️ <b>Психологиня:</b>
<a href="https://t.me/luidmila_psi">@luidmila_psi</a>
        `;
        
        bot.sendMessage(chatId, contactsMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
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
    const selectedEvent = getAllEvents().find(e => 
        text.includes(e.name)
    );

    if (selectedEvent) {
        // compute seats left asynchronously before replying
        const seatsLeft = await getSeatsLeft(selectedEvent.id);
        const seatsInfo = seatsLeft > 0 
            ? `💺 Місць залишилось: ${seatsLeft}\n` 
            : `❌ Місця закінчилися\n`;
        
        // build keyboard options
        const buttons = [];
        if (user.context !== 'afisha') {
            if (seatsLeft > 0) {
                buttons.push([{ text: "Реєструватися" }]);
            } else {
                buttons.push([{ text: "Місць немає" }]);
            }
        }
        buttons.push([{ text: "Назад" }]);

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
        const eventId = user.selectedEventId;
        const eventName = user.selectedEventName;
        if (!eventId || !eventName) return;
        const seatsLeft = await getSeatsLeft(eventId);
        if (seatsLeft <= 0) {
            bot.sendMessage(chatId, "❌ Вибачте, місця закінчилися.");
            return;
        }
        await appendEventRegistration(eventId, chatId);
        // update count in schedule sheet
        const evObj = events.find(e => e.id === eventId);
        if (evObj) {
            await incrementSheetRegistration(evObj);
            evObj.registrations = (evObj.registrations || 0) + 1;
            // reduce local seats count as well
            if (typeof evObj.seats === 'number') evObj.seats = Math.max(0, evObj.seats - 1);
        }
        
        // Додати в selectedEvents для step 7
        if (user.step === 7) {
            if (!user.selectedEvents) user.selectedEvents = [];
            user.selectedEvents.push({ id: eventId, name: eventName });
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
        delete user.selectedEventName;
        delete user.selectedEventId;
        return;
    }

    if (text === "Обрати ще захід" && user.step === 7) {
        // Вернуться к списку доступних заходів (исключив те, на которые уже зарегистрировались)
        const allEvents = getAllEvents();
        const avail = [];
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
        const eventButtons = avail.map(event => [{ text: `☐ ${event.name} | ${formatEventDate(event.date)} | 💺 ${event.seatsLeft}` }]);
        eventButtons.push([{ text: "✅ Завершити" }]);
        bot.sendMessage(chatId, "Натисніть на захід, на який бажаєте зареєструватись:", {
            reply_markup: {
                keyboard: eventButtons,
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Назад") {
        delete user.selectedEventName;
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
        bot.sendMessage(chatId, "Ваш статус:", {
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
        bot.sendMessage(chatId, "Проблеми зі здоров’ям:", {
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
        const eventButtons = avail.map(event => [{ text: `☐ ${event.name} | ${formatEventDate(event.date)} | 💺 ${event.seatsLeft}` }]);
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

        const selectedEvent = avail.find(e => 
            text.includes(e.name)
        );

        if (selectedEvent) {
            // Показати деталі заходу з кнопкою реєстрації
            const seatsLeft = await getSeatsLeft(selectedEvent.id);
            const seatsInfo = seatsLeft > 0 
                ? `💺 Місць залишилось: ${seatsLeft}\n` 
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
            const eventButtons = availForList.map(event => [{ text: `${event.name} | ${formatEventDate(event.date)} | 💺 ${event.seatsLeft}` }]);
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

console.log("✅ Бот запущено!");
console.log("📋 Розклад:", SPREADSHEET_ID);
console.log("👤 Персональні дані:", PERSONAL_DATA_SPREADSHEET_ID);