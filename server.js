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
console.log("📋 Таблиця розкладу (тільки читання):", SPREADSHEET_ID);
console.log("📄 Аркуш розкладу:", SCHEDULE_SHEET_NAME);
console.log("👤 Таблиця персональних даних (запис ПІБ + всі реєстрації):", PERSONAL_DATA_SPREADSHEET_ID);
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
let stoppingBecauseOfPollingConflict = false;

let pollingErrorCount = 0;
const pollingErrorThreshold = 5; // Після 5 помилок на хвилину - перезавантажити

bot.on('polling_error', async (error) => {
    const message = String((error && error.message) || '');
    const isConflict = message.includes('409 Conflict') || (error && error.code === 'ETELEGRAM' && message.includes('getUpdates'));
    const isFatalNetwork = message.includes('EFATAL') || message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT');

    // Конфлікт - інший інстанс працює
    if (isConflict) {
        console.error('❌ ETELEGRAM 409 Conflict: знайдено інший активний інстанс бота з тим самим токеном.');

        if (stoppingBecauseOfPollingConflict) {
            return;
        }

        stoppingBecauseOfPollingConflict = true;
        try {
            await bot.stopPolling();
            console.error('🛑 Поточний інстанс зупинено, щоб уникнути дублювання/хаотичних кроків.');
        } catch (stopErr) {
            console.error('⚠️ Не вдалося коректно зупинити polling:', stopErr);
        }

        process.exit(1);
        return;
    }

    // Тимчасові мережеві ошибки - логуємо але не зупиняємо
    if (isFatalNetwork) {
        pollingErrorCount++;
        console.error(`⚠️ Мережева ошибка polling (${pollingErrorCount}/${pollingErrorThreshold}):`, message);
        
        if (pollingErrorCount >= pollingErrorThreshold) {
            console.error('🔴 Занадто багато мережевих помилок, перезапускаємо polling...');
            pollingErrorCount = 0;
            try {
                await bot.stopPolling();
                // Чекаємо 2 секунди перед перезапуском
                await new Promise(resolve => setTimeout(resolve, 2000));
                await bot.startPolling();
                console.log('✅ Polling перезапущено');
            } catch (e) {
                console.error('❌ Не вдалося перезапустити polling:', e.message);
            }
        }
        return;
    }

    // Інші помилки - просто логуємо
    console.error('⚠️ polling_error:', error);
});

// Скидаємо лічильник помилок кожну хвилину
setInterval(() => {
    if (pollingErrorCount > 0) {
        console.log(`📊 Лічильник помилок polling скинуто (було ${pollingErrorCount})`);
    }
    pollingErrorCount = 0;
}, 60000);

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
    console.log(`\n📋 КОНФІГУРАЦІЯ ГРУП:`);
    console.log(`   GROUP_ID: ${GROUP_ID}`);
    console.log(`   CHAT_ID: ${CHAT_ID}`);
    console.log(`   APPEALS_GROUP_ID: ${APPEALS_GROUP_ID} (type: ${typeof APPEALS_GROUP_ID})`);
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
let knownUsers = {}; // Кеш з персональними даними користувачів (ім'я, телефон)
let appealMessagesMap = {}; // Мапа: message_id звернення в групі → chatId користувача
let events = []; // масив для зберігання заходів
let userEventRegistrations = {}; // Мапа: chatId → [{eventId, eventName, eventDate, reminded24h: false, reminded1h: false}]
const REMINDERS_STATE_PATH = process.env.REMINDERS_STATE_PATH || path.join(__dirname, 'data', 'reminders-state.json');

function normalizeReminderRegistration(raw) {
    if (!raw || !raw.eventId || !raw.eventDate) {
        return null;
    }

    const parsedDate = new Date(raw.eventDate);
    if (Number.isNaN(parsedDate.getTime())) {
        return null;
    }

    return {
        eventId: String(raw.eventId),
        eventName: String(raw.eventName || '').trim(),
        eventDate: parsedDate,
        registrantName: String(raw.registrantName || '').trim(),
        registrantPhone: String(raw.registrantPhone || '').trim(),
        reminded24h: raw.reminded24h === true,
        reminded1h: raw.reminded1h === true
    };
}

function loadReminderStateFromDisk() {
    if (!fs.existsSync(REMINDERS_STATE_PATH)) {
        return;
    }

    try {
        const raw = fs.readFileSync(REMINDERS_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        const restored = {};
        const now = new Date();

        for (const chatId of Object.keys(parsed || {})) {
            const rawRegistrations = Array.isArray(parsed[chatId]) ? parsed[chatId] : [];
            const normalized = rawRegistrations
                .map(normalizeReminderRegistration)
                .filter((item) => item && item.eventDate > now);

            if (normalized.length > 0) {
                restored[String(chatId)] = normalized;
            }
        }

        userEventRegistrations = restored;
        const restoredCount = Object.values(userEventRegistrations).reduce((sum, items) => sum + items.length, 0);
        console.log(`♻️ Відновлено ${restoredCount} реєстрацій нагадувань з ${REMINDERS_STATE_PATH}`);
    } catch (error) {
        console.error(`❌ Не вдалося відновити стан нагадувань (${REMINDERS_STATE_PATH}):`, error && error.message ? error.message : error);
    }
}

function saveReminderStateToDisk() {
    try {
        const payload = {};

        for (const [chatId, registrations] of Object.entries(userEventRegistrations || {})) {
            if (!Array.isArray(registrations) || registrations.length === 0) {
                continue;
            }

            payload[chatId] = registrations
                .map((registration) => {
                    if (!registration || !registration.eventDate) {
                        return null;
                    }

                    const date = registration.eventDate instanceof Date
                        ? registration.eventDate
                        : new Date(registration.eventDate);

                    if (Number.isNaN(date.getTime())) {
                        return null;
                    }

                    return {
                        eventId: String(registration.eventId || ''),
                        eventName: String(registration.eventName || ''),
                        eventDate: date.toISOString(),
                        registrantName: String(registration.registrantName || ''),
                        registrantPhone: String(registration.registrantPhone || ''),
                        reminded24h: registration.reminded24h === true,
                        reminded1h: registration.reminded1h === true
                    };
                })
                .filter(Boolean);
        }

        fs.mkdirSync(path.dirname(REMINDERS_STATE_PATH), { recursive: true });
        fs.writeFileSync(REMINDERS_STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error(`❌ Не вдалося зберегти стан нагадувань (${REMINDERS_STATE_PATH}):`, error && error.message ? error.message : error);
    }
}

loadReminderStateFromDisk();

/* ===== HELPER FUNCTIONS ===== */

// Повертає всі заходи з памяті
function getAllEvents() {
    return events || [];
}

// Нормалізація тексту - замінюємо різні апострофи на один стандартний
function normalizeText(text) {
    if (!text) return text;
    // Замінюємо всі варіанти апострофів (кирилічний ', латинський ', правий одинарний ') на стандартний '
    return text.replace(/[''ʼ]/g, "'");
}

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
    let hasReminderChanges = false;
    events = events.filter(e => e.date > now);
    
    if (events.length < initialCount) {
        console.log(`🧹 Видалено ${initialCount - events.length} минулих заходів`);
    }
    
    // Також видаляємо минулі реєстрації
    for (const chatId in userEventRegistrations) {
        const before = userEventRegistrations[chatId].length;
        userEventRegistrations[chatId] = userEventRegistrations[chatId].filter(reg => reg.eventDate > now);
        if (userEventRegistrations[chatId].length !== before) {
            hasReminderChanges = true;
        }
        if (userEventRegistrations[chatId].length === 0) {
            delete userEventRegistrations[chatId];
            hasReminderChanges = true;
        }
    }

    if (hasReminderChanges) {
        saveReminderStateToDisk();
    }
}

// Перевірка та відправка нагадувань про заходи
async function checkAndSendReminders() {
    const now = new Date();
    let hasReminderChanges = false;
    
    for (const chatId in userEventRegistrations) {
        // Перевіряємо чи користувач не вимкнув нагадування
        if (users[chatId] && users[chatId].remindersEnabled === false) {
            console.log(`ℹ️ Нагадування вимкнені для ${chatId}, пропускаємо`);
            continue;
        }
        
        const registrations = userEventRegistrations[chatId];
        
        for (const reg of registrations) {
            const timeUntilEvent = reg.eventDate - now;
            const hoursUntilEvent = timeUntilEvent / (1000 * 60 * 60);
            const minutesUntilEvent = Math.round(timeUntilEvent / (1000 * 60));
            
            // Нагадування за 24 години (вікно: 23-25 годин до заходу)
            // Це гарантує, що якщо користувач заходить в час X, а захід в час X+24, він отримає нагадування
            if (!reg.reminded24h && hoursUntilEvent >= 23 && hoursUntilEvent <= 25) {
                try {
                    const dateStr = reg.eventDate.toLocaleDateString('uk-UA', { 
                        weekday: 'long', 
                        day: 'numeric', 
                        month: 'long' 
                    });
                    const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    
                    await bot.sendMessage(chatId, 
                        `⏰ <b>Нагадування за 24 години</b>\n\n` +
                        `Завтра у вас захід:\n` +
                        `📅 ${reg.eventName}\n` +
                        `🕐 ${dateStr} о ${timeStr}\n\n` +
                        `До початку залишилось: 24 години\n\n` +
                        `Чекаємо на вас у Просторі «Вільна»! 🩵`,
                        { parse_mode: 'HTML' }
                    );
                    
                    reg.reminded24h = true;
                    hasReminderChanges = true;
                    console.log(`⏰ Відправлено нагадування (24 год) для ${chatId} про "${reg.eventName}"`);
                } catch (error) {
                    console.error(`❌ Помилка відправки нагадування (24 год) для ${chatId}:`, error);
                }
            }
            
            // Нагадування за 1 годину (вікно: 0-2 години до заходу)
            // Це гарантує, що нагадування прийде для всіх, хто зареєструвався на будь-якому етапі
            if (!reg.reminded1h && hoursUntilEvent >= 0 && hoursUntilEvent <= 2) {
                try {
                    const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    
                    // Розраховуємо релевантну інформацію про залишений час
                    let timeLeftMsg = '';
                    if (hoursUntilEvent >= 1) {
                        const remainingHours = Math.floor(hoursUntilEvent);
                        const remainingMins = Math.round((hoursUntilEvent - remainingHours) * 60);
                        timeLeftMsg = `залишилось ${remainingHours} ${remainingHours === 1 ? 'година' : 'години'} ${remainingMins} хвилин`;
                    } else {
                        timeLeftMsg = `залишилось ${minutesUntilEvent} хвилин`;
                    }
                    
                    await bot.sendMessage(chatId, 
                        `⏰ <b>Нагадування за 1 годину</b>\n\n` +
                        `Скоро починається захід:\n` +
                        `📅 ${reg.eventName}\n` +
                        `🕐 Сьогодні о ${timeStr}\n\n` +
                        `До початку ${timeLeftMsg}\n\n` +
                        `Не забудьте! Чекаємо на вас 🩵\n\n` +
                        `📍 м. Дніпро, вул. Дмитра Донцова, 4`,
                        { parse_mode: 'HTML' }
                    );
                    
                    reg.reminded1h = true;
                    hasReminderChanges = true;
                    console.log(`⏰ Відправлено нагадування (1 год) для ${chatId} про "${reg.eventName}"`);
                } catch (error) {
                    console.error(`❌ Помилка відправки нагадування (1 год) для ${chatId}:`, error);
                }
            }
        }
    }

    if (hasReminderChanges) {
        saveReminderStateToDisk();
    }
}

// Фільтрує заходи за номером дня (0-6)
function getEventsForDay(dayNum) {
    const allEvents = getAllEvents();
    const dayEvents = allEvents.filter(e => e.date.getUTCDay() === dayNum);
    console.log(`📊 getEventsForDay(${dayNum}): знайдено ${dayEvents.length} заходів з ${allEvents.length}`);
    if (dayEvents.length > 0) {
        dayEvents.forEach(e => console.log(`   - ${e.name} на ${e.date}`));
    }
    return dayEvents;
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

function normalizeWeekdayKey(value) {
    const normalized = normalizeText(String(value || ''))
        .toLowerCase()
        .replace(/[’`]/g, "'");

    const aliases = {
        "пятниця": "п'ятниця",
        "пятницю": "п'ятницю"
    };

    return aliases[normalized] || normalized;
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

    const normalizedDay = normalizeWeekdayKey(dayName);
    const weekdays = { "неділя":0, "понеділок":1, "вівторок":2, "середа":3, "четвер":4, "п'ятниця":5, "субота":6 };
    const dayNum = weekdays[normalizedDay];
    if (dayNum === undefined) {
        await bot.sendMessage(chatId, "Не вдалося розпізнати день. Оберіть день з кнопок нижче.", {
            reply_markup: {
                keyboard: getAfishaDaysKeyboard(),
                resize_keyboard: true
            }
        });
        return;
    }
    // ДІАГНОСТИКА
    console.log(`\n🔍 showDayAgenda("${dayName}"): normalized="${normalizedDay}", dayNum=${dayNum}`);
    const allEvents = getAllEvents();
    console.log(`   Всього майбутніх заходів: ${allEvents.length}`);
    allEvents.forEach(e => console.log(`   - ${e.name}: ${e.date.toISOString()} (getUTCDay=${e.date.getUTCDay()})`));
    
    const dayEvents = getEventsForDay(dayNum);
    console.log(`   ✅ Знайдено на день ${dayNum}: ${dayEvents.length} заходів`);
    
    dayEvents.sort((a,b)=>a.date-b.date);
    
    const dayForms = {
        "неділя": { lower: "неділю", upper: "Неділю" },
        "понеділок": { lower: "понеділок", upper: "Понеділок" },
        "вівторок": { lower: "вівторок", upper: "Вівторок" },
        "середа": { lower: "середу", upper: "Середу" },
        "четвер": { lower: "четвер", upper: "Четвер" },
        "п'ятниця": { lower: "п'ятницю", upper: "П'ятницю" },
        "субота": { lower: "суботу", upper: "Суботу" }
    };

    if (dayEvents.length === 0) {
        bot.sendMessage(chatId, `На ${dayForms[normalizedDay]?.lower || dayName} немає заходів.`, {
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
    let msg = `📅 Заходи у ${dayForms[normalizedDay]?.upper || dayName}:\n\n`;
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
    if (!event || !sheetsClient || !SPREADSHEET_ID) {
        return;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        console.warn(`⚠️ Не знайдено рядок у розкладі для оновлення нотатки: ${event.name}`);
        return;
    }

    const registrationsCount = Number.isFinite(event.registrations) ? event.registrations : 0;
    const seatsCount = Number.isFinite(event.seats) ? Math.max(0, event.seats) : 0;

    try {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[seatsCount, registrationsCount]]
            }
        });
    } catch (error) {
        console.error('❌ Не вдалося оновити місця/реєстрації у розкладі:', error && error.message ? error.message : error);
    }

    try {
        await updateScheduleRegistrationNote({
            scheduleSheet: match.scheduleSheet,
            rowIndex: match.rowIndex,
            registrationsCount,
            fallbackRegistrant
        });
    } catch (error) {
        console.error('❌ Не вдалося оновити нотатку реєстрації у розкладі:', error && error.message ? error.message : error);
    }
}

async function decrementSheetRegistration(event, registrantProfile) {
    if (!event || !sheetsClient || !SPREADSHEET_ID) {
        return;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        console.warn(`⚠️ Не знайдено рядок у розкладі для відписки: ${event.name}`);
        return;
    }

    const registrationsCount = Number.isFinite(event.registrations) ? event.registrations : 0;
    const seatsCount = Number.isFinite(event.seats) ? Math.max(0, event.seats) : 0;

    try {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[seatsCount, registrationsCount]]
            }
        });
    } catch (error) {
        console.error('❌ Не вдалося оновити місця/реєстрації після відписки:', error && error.message ? error.message : error);
    }

    try {
        await updateScheduleRegistrationNote({
            scheduleSheet: match.scheduleSheet,
            rowIndex: match.rowIndex,
            registrationsCount,
            removeRegistrant: registrantProfile
        });
    } catch (error) {
        console.error('❌ Не вдалося оновити нотатку після відписки:', error && error.message ? error.message : error);
    }
}

async function getSheetIdByTitle(spreadsheetId, sheetTitle) {
    if (!spreadsheetId || !sheetTitle || !sheetsClient) {
        return null;
    }

    try {
        const metadata = await sheetsClient.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets(properties(sheetId,title))'
        });
        const sheet = (metadata.data.sheets || []).find((item) => item && item.properties && item.properties.title === sheetTitle);
        return sheet && sheet.properties ? sheet.properties.sheetId : null;
    } catch (error) {
        console.error(`❌ Не вдалося отримати sheetId для листа "${sheetTitle}":`, error && error.message ? error.message : error);
        return null;
    }
}

function parseRegistrantsFromNote(noteText) {
    const text = String(noteText || '').trim();
    if (!text) return [];

    const registrants = [];
    const seen = new Set();
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        if (/^зареєстровано\s*:/i.test(line)) {
            continue;
        }

        const cleaned = line
            .replace(/^[-*•]\s*/, '')
            .replace(/^\d+[.)-]?\s*/, '')
            .trim();

        if (!cleaned) continue;

        let name = '';
        let phone = '';

        if (cleaned.includes('|')) {
            const [left, right] = cleaned.split('|');
            name = String(left || '').trim();
            phone = String(right || '').trim();
        } else {
            const phoneMatch = cleaned.match(/(\+?\d[\d\s()\-]{6,})$/);
            if (phoneMatch) {
                phone = String(phoneMatch[1] || '').trim();
                name = cleaned.slice(0, cleaned.length - phone.length).replace(/[,:;\-\s]+$/, '').trim();
            }
        }

        if (!name && !phone) {
            continue;
        }

        const key = `${normalizeRegistrantName(name)}|${normalizeRegistrantPhone(phone)}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        registrants.push({ name, phone });
    }

    return registrants;
}

async function findScheduleRowByEvent(event) {
    if (!event || !event.date || !SPREADSHEET_ID || !sheetsClient) {
        return null;
    }

    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${scheduleSheet}!A:E`
            });
            const rows = resp.data.values || [];
            let dateContext = null;

            for (const [rowIndex, row] of rows.entries()) {
                const parsed = parseEventFromRow(row, dateContext);
                dateContext = parsed.nextDateContext;

                if (!parsed.event) {
                    continue;
                }

                const parsedEvent = parsed.event;
                const sameTitle = normalizeTitle(parsedEvent.name) === normalizeTitle(event.name);
                const sameTime = parsedEvent.date.getTime() === event.date.getTime();
                if (sameTitle && sameTime) {
                    return { scheduleSheet, rowIndex };
                }
            }
        } catch (error) {
            const message = (error && error.message ? String(error.message) : '').toLowerCase();
            if (message.includes('unable to parse range') || message.includes('not found')) {
                continue;
            }
            console.error(`❌ Помилка пошуку рядка події у листі ${scheduleSheet}:`, error && error.message ? error.message : error);
        }
    }

    return null;
}

function normalizeRegistrantName(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeRegistrantPhone(value) {
    return String(value || '').replace(/\D+/g, '');
}

function isSameRegistrant(item, candidateNameKey, candidatePhoneKey) {
    const sameName = normalizeRegistrantName(item.name) === candidateNameKey;
    const samePhone = normalizeRegistrantPhone(item.phone) === candidatePhoneKey;
    return (candidateNameKey && candidatePhoneKey && sameName && samePhone)
        || (!candidatePhoneKey && candidateNameKey && sameName)
        || (!candidateNameKey && candidatePhoneKey && samePhone);
}

function buildRegistrantsNoteFromList(registrationsCount, registrants) {
    const safeCount = Number.isFinite(registrationsCount) ? registrationsCount : registrants.length;
    const header = `Зареєстровано: ${safeCount}`;

    if (registrants.length === 0) {
        return header;
    }

    const people = registrants.map((item, index) => {
        const name = String(item.name || '').trim() || 'Без імені';
        const phone = String(item.phone || '').trim();
        return `${index + 1}. ${name}${phone ? ` | ${phone}` : ''}`;
    });

    return `${header}\n\n${people.join('\n')}`;
}

async function isRegistrantAlreadyInEventNote(event, registrantProfile) {
    if (!event || !registrantProfile || !SPREADSHEET_ID || !sheetsClient) {
        return false;
    }

    const normalizedName = normalizeRegistrantName(registrantProfile.name);
    const normalizedPhone = normalizeRegistrantPhone(registrantProfile.phone);
    if (!normalizedName && !normalizedPhone) {
        return false;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        return false;
    }

    const existingNote = await getScheduleCellNote(match.scheduleSheet, match.rowIndex);
    const registrants = parseRegistrantsFromNote(existingNote);
    return registrants.some((item) => isSameRegistrant(item, normalizedName, normalizedPhone));
}

async function getScheduleCellNote(scheduleSheet, rowIndex) {
    if (!scheduleSheet || rowIndex < 0 || !SPREADSHEET_ID || !sheetsClient) {
        return '';
    }

    try {
        const resp = await sheetsClient.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            ranges: [`${scheduleSheet}!E${rowIndex + 1}`],
            includeGridData: true,
            fields: 'sheets(data(rowData(values(note))))'
        });

        const note = resp && resp.data && resp.data.sheets && resp.data.sheets[0]
            && resp.data.sheets[0].data && resp.data.sheets[0].data[0]
            && resp.data.sheets[0].data[0].rowData && resp.data.sheets[0].data[0].rowData[0]
            && resp.data.sheets[0].data[0].rowData[0].values && resp.data.sheets[0].data[0].rowData[0].values[0]
            ? resp.data.sheets[0].data[0].rowData[0].values[0].note
            : '';

        return String(note || '');
    } catch (error) {
        console.error(`❌ Помилка читання нотатки з ${scheduleSheet}!E${rowIndex + 1}:`, error && error.message ? error.message : error);
        return '';
    }
}

async function buildRegistrantsNote(registrationsCount, fallbackRegistrant, existingNote) {
    const registrants = parseRegistrantsFromNote(existingNote);

    const candidateName = String((fallbackRegistrant && fallbackRegistrant.name) || '').trim();
    const candidatePhone = String((fallbackRegistrant && fallbackRegistrant.phone) || '').trim();
    if (candidateName || candidatePhone) {
        const candidateNameKey = normalizeRegistrantName(candidateName);
        const candidatePhoneKey = normalizeRegistrantPhone(candidatePhone);
        const exists = registrants.some((item) => isSameRegistrant(item, candidateNameKey, candidatePhoneKey));
        if (!exists) {
            registrants.push({ name: candidateName, phone: candidatePhone });
        }
    }

    return buildRegistrantsNoteFromList(registrationsCount, registrants);
}

async function updateScheduleRegistrationNote({ scheduleSheet, rowIndex, registrationsCount, fallbackRegistrant, removeRegistrant }) {
    if (!scheduleSheet || rowIndex < 0 || !SPREADSHEET_ID || !sheetsClient) {
        return;
    }

    const sheetId = await getSheetIdByTitle(SPREADSHEET_ID, scheduleSheet);
    if (sheetId === null || typeof sheetId === 'undefined') {
        return;
    }

    const existingNote = await getScheduleCellNote(scheduleSheet, rowIndex);
    let registrants = parseRegistrantsFromNote(existingNote);

    if (removeRegistrant) {
        const removeNameKey = normalizeRegistrantName(removeRegistrant.name);
        const removePhoneKey = normalizeRegistrantPhone(removeRegistrant.phone);
        if (removeNameKey || removePhoneKey) {
            registrants = registrants.filter((item) => !isSameRegistrant(item, removeNameKey, removePhoneKey));
        }
    }

    let nextNote = buildRegistrantsNoteFromList(registrationsCount, registrants);
    if (fallbackRegistrant) {
        nextNote = await buildRegistrantsNote(registrationsCount, fallbackRegistrant, nextNote);
    }

    await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: rowIndex,
                            endRowIndex: rowIndex + 1,
                            startColumnIndex: 4,
                            endColumnIndex: 5
                        },
                        cell: {
                            note: nextNote
                        },
                        fields: 'note'
                    }
                }
            ]
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

function stripWrappingQuotes(value) {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1).trim();
    }
    return raw;
}

function tryParseServiceAccountValue(rawValue, { allowBase64 = true } = {}) {
    const candidate = stripWrappingQuotes(rawValue);
    if (!candidate) return null;

    // 1) Direct JSON
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && parsed.client_email && parsed.private_key) {
            return normalizeCredentials(parsed);
        }
    } catch (e) {
        // console.debug(`Не вдалось парсити як JSON: ${e.message}`);
    }

    // 2) Base64 JSON
    if (allowBase64) {
        try {
            const compact = candidate.replace(/\s+/g, '');
            const decoded = Buffer.from(compact, 'base64').toString('utf8');
            const parsed = JSON.parse(decoded);
            if (parsed && parsed.client_email && parsed.private_key) {
                return normalizeCredentials(parsed);
            }
        } catch (e) {
            // console.debug(`Не вдалось парсити як Base64 JSON: ${e.message}`);
        }
    }

    return null;
}

function parseCredentialsFromEnv() {
    const sources = [];
    const sheetsScopes = ["https://www.googleapis.com/auth/spreadsheets"];

    const jsonEnvAliases = [
        'GOOGLE_SERVICE_ACCOUNT_JSON',
        'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
        'GOOGLE_CREDENTIALS',
        'GOOGLE_CREDENTIALS_JSON',
        'GOOGLE_APPLICATION_CREDENTIALS_JSON',
        'GCP_SERVICE_ACCOUNT_JSON'
    ];

    for (const envName of jsonEnvAliases) {
        const raw = process.env[envName];
        if (!raw) continue;
        const parsed = tryParseServiceAccountValue(raw, { allowBase64: true });
        if (parsed) {
            sources.push({
                label: envName,
                authOptions: {
                    credentials: parsed,
                    scopes: sheetsScopes
                }
            });
        } else {
            console.error(`Невалідний ${envName}: не вдалося розпарсити як JSON/Base64 service_account`);
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
        console.log(`📋 parseCredentialsFromEnv знайшло ${envCandidates.length} кандидатів: ${envCandidates.map(c => c.label).join(', ')}`);
        candidates.push(...envCandidates);
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const gac = String(process.env.GOOGLE_APPLICATION_CREDENTIALS).trim();
        // Railway misconfiguration guard: some deployments put raw JSON into GOOGLE_APPLICATION_CREDENTIALS.
        if (gac.startsWith('{')) {
            try {
                const parsed = JSON.parse(gac);
                if (parsed && typeof parsed === 'object') {
                    // Завжди додаємо, навіть якщо недостатньо інформації - хай GoogleAuth розбірається
                    candidates.push({
                        label: 'GOOGLE_APPLICATION_CREDENTIALS (inline JSON)',
                        authOptions: {
                            credentials: normalizeCredentials(parsed),
                            scopes
                        }
                    });
                    console.log(`✅ GOOGLE_APPLICATION_CREDENTIALS (inline JSON) додано до candidates`);
                } else {
                    console.error(`⚠️ GOOGLE_APPLICATION_CREDENTIALS (inline JSON) невалідний: не є об'єктом`);
                }
            } catch (error) {
                console.error(`❌ Невалідний GOOGLE_APPLICATION_CREDENTIALS (inline JSON): ${error.message}`);
            }
        } else {
            candidates.push({
                label: `GOOGLE_APPLICATION_CREDENTIALS (${gac})`,
                authOptions: {
                    keyFile: gac,
                    scopes
                }
            });
            console.log(`✅ GOOGLE_APPLICATION_CREDENTIALS (file path) додано до candidates: ${gac}`);
        }
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
        console.log(`✅ vilna-bot-8e7e5cb23ce2.json знайдено`);
    } else {
        console.log(`ℹ️ vilna-bot-8e7e5cb23ce2.json не знайдено`);
    }

    const anyLocalCredentials = fs.readdirSync(cwd).filter((fileName) => /^vilna-bot-.*\.json$/.test(fileName));
    console.log(`🔍 Локальні vilna-bot-*.json файли: ${anyLocalCredentials.length > 0 ? anyLocalCredentials.join(', ') : 'не знайдено'}`);
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
        console.log(`✅ ${fileName} додано до candidates`);
    }

    if (candidates.length === 0) {
        const knownVars = [
            'GOOGLE_SERVICE_ACCOUNT_JSON',
            'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
            'GOOGLE_CREDENTIALS',
            'GOOGLE_CREDENTIALS_JSON',
            'GOOGLE_APPLICATION_CREDENTIALS_JSON',
            'GCP_SERVICE_ACCOUNT_JSON',
            'GOOGLE_CLIENT_EMAIL',
            'GOOGLE_PRIVATE_KEY',
            'GOOGLE_APPLICATION_CREDENTIALS'
        ];
        const present = knownVars.filter((name) => !!process.env[name]);
        console.log(`🔴 Нічого не знайдено. Наявні env ключі: ${present.length ? present.join(', ') : 'жодного'}`);
        throw new Error(
            "Не знайдено Google credentials. Додайте GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, GOOGLE_CREDENTIALS, " +
            "GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS або файл vilna-bot-*.json. " +
            `Наявні env ключі: ${present.length ? present.join(', ') : 'жодного'}`
        );
    }

    console.log(`✨ Всього candidates: ${candidates.length}`);
    return candidates;
}

async function createAuthorizedSheetsClient() {
    let candidates;
    try {
        candidates = resolveGoogleAuthCandidates();
    } catch (error) {
        console.error(`🔴 resolveGoogleAuthCandidates помилка: ${error.message}`);
        throw error;
    }

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

    const errorMsg = `Жодне джерело credentials не підійшло. ${errors.join(" | ")}`;
    console.error(`🔴 ПОМИЛКА AUTHENTICATION: ${errorMsg}`);
    throw new Error(errorMsg);
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
        
        // Разова перевірка одразу після ініціалізації
        checkAndSendReminders().catch((error) => {
            console.error('❌ Помилка першої перевірки нагадувань:', error);
        });

        // Запускаємо перевірку нагадувань щохвилини
        setInterval(() => {
            checkAndSendReminders().catch((error) => {
                console.error('❌ Помилка перевірки нагадувань:', error);
            });
        }, 60 * 1000); // 1 хвилина
        
        console.log('⏰ Система нагадувань активована (перевірка щохвилини)');

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

        // ДІАГНОСТИКА: логуємо перші рядки таблиці
        console.log(`\n🔍 ДІАГНОСТИКА ЗАВАНТАЖЕННЯ Розкладу (перші 5 рядків):`);
        for (let i = 0; i < Math.min(5, rows.length); i++) {
            console.log(`   Рядок ${i}: ${JSON.stringify(rows[i])}`);
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
            console.log(`   📅 Завантажено: ${ev.name} | ${ev.date.toLocaleDateString('uk-UA')} ${ev.date.toLocaleTimeString('uk-UA', {hour: '2-digit', minute: '2-digit'})} | ${ev.seats} місць`);
        }

        if (events.length === 0) {
            console.warn(`⚠️ Розклад прочитано, але заходів не знайдено. Перевірте дані у листі ${SCHEDULE_SHEET_NAME}.`);
        }
        console.log(`✅ Розклад завантажено з Sheets (${events.length} заходів)`);
        
        // Додаткова діагностика
        const now = new Date();
        const futureCount = events.filter(e => e.date > now).length;
        console.log(`   📊 Поточний час: ${now.toLocaleString('uk-UA')}`);
        console.log(`   📊 Майбутніх заходів: ${futureCount} з ${events.length}`);

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
        String((user && user.username) || ''),
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
            const personalDataHasValues = [0, 1, 2, 3, 4, 5, 6].some((idx) => String(row[idx] || '').trim() !== '');
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
            try {
                sheetsClient = await createAuthorizedSheetsClient();
                console.log('✅ sheetsClient ініціалізовано повторно перед записом');
            } catch (reinitErr) {
                lastErr = reinitErr;
            }
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
        }

        try {
            console.log(`\n📝 Спроба ${attempt}/${maxTries} запису в таблицю`);
            console.log(`Spreadsheet ID: ${PERSONAL_DATA_SPREADSHEET_ID}`);
            console.log(`Sheet Name: ${PERSONAL_DATA_SHEET_NAME}`);
            console.log(`Range: ${PERSONAL_DATA_SHEET_NAME}!A:G`);
            
            const existingResp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${PERSONAL_DATA_SHEET_NAME}!A:G`,
            });
            const rows = existingResp.data.values || [];
            const targetRow = findFirstFreeRow(rows);
            
            console.log(`Знайдено рядок для запису: ${targetRow}`);
            console.log(`Дані для запису:`, values);

            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${PERSONAL_DATA_SHEET_NAME}!A${targetRow}:G${targetRow}`,
                valueInputOption: "RAW",
                requestBody: { values: [values] }
            });
            console.log(`✅ Записано в таблицю ${PERSONAL_DATA_SHEET_NAME} (рядок ${targetRow})`);
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
    console.error(`\n❌ === КРИТИЧНА ПОМИЛКА ЗАПИСУ В ТАБЛИЦЮ ===`);
    console.error(`Всі ${maxTries} спроби запису не вдались`);
    console.error(`PERSONAL_DATA_SPREADSHEET_ID: ${PERSONAL_DATA_SPREADSHEET_ID}`);
    console.error(`PERSONAL_DATA_SHEET_NAME: ${PERSONAL_DATA_SHEET_NAME}`);
    console.error(`Останя помилка:`, lastErr);
    if (lastErr && lastErr.response) {
        console.error(`API Response:`, lastErr.response.data);
        console.error(`API Status:`, lastErr.response.status);
    }
    console.error(`Дані які намагались записати:`, values);
    console.error(`===============================\n`);

    if (!lastErr && !sheetsClient) {
        throw new Error('Google Sheets client not initialized. Перевірте credentials у Railway та зробіть redeploy.');
    }
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

async function restoreUserRegistrationsFromSheet(chatId, user) {
    if (!chatId || !sheetsClient || !SPREADSHEET_ID) {
        return 0;
    }

    const profile = await resolveRegistrantProfile(chatId, user, user && user.name, user && user.phone);
    const normalizedName = normalizeRegistrantName(profile.name);
    const normalizedPhone = normalizeRegistrantPhone(profile.phone);
    if (!normalizedName && !normalizedPhone) {
        return 0;
    }

    if (!userEventRegistrations[chatId]) {
        userEventRegistrations[chatId] = [];
    }

    const existingIds = new Set(userEventRegistrations[chatId].map((item) => item.eventId));
    let restoredCount = 0;

    for (const event of getAllEvents()) {
        if (!event || !event.date || event.date <= new Date() || existingIds.has(event.id)) {
            continue;
        }

        const inNote = await isRegistrantAlreadyInEventNote(event, profile);
        if (!inNote) {
            continue;
        }

        userEventRegistrations[chatId].push({
            eventId: event.id,
            eventName: event.name,
            eventDate: event.date,
            registrantName: profile.name,
            registrantPhone: profile.phone,
            reminded24h: false,
            reminded1h: false
        });
        existingIds.add(event.id);
        restoredCount += 1;
    }

    if (userEventRegistrations[chatId].length === 0) {
        delete userEventRegistrations[chatId];
    }

    if (restoredCount > 0) {
        console.log(`♻️ Відновлено ${restoredCount} реєстрацій з нотаток для chatId=${chatId}`);
        saveReminderStateToDisk();
    }

    return restoredCount;
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

async function loadKnownUserByChatId(chatId) {
    const chatIdStr = String(chatId || '').trim();
    if (!chatIdStr) return null;

    if (knownUsers[chatId]) {
        return knownUsers[chatId];
    }

    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return null;
    }

    // У новій схемі таблиці chatId не зберігається окремою колонкою.
    // Пошук виконується по username/phone у відповідних функціях.
    return null;
}

// Завантажує профіль користувача по телефону
async function loadKnownUserByPhone(phone) {
    const phoneStr = String(phone || '').trim();
    if (!phoneStr) return null;

    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return null;
    }

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
                const rowPhone = String(row[2] || '').trim(); // Column C (index 2)
                if (!rowPhone.includes(phoneStr) && phoneStr !== rowPhone) continue;

                const restored = {
                    name: String(row[1] || '').trim(),
                    phone: String(row[2] || '').trim(),
                    birth: String(row[3] || '').trim(),
                    visited: String(row[4] || '').trim(),
                    status: String(row[5] || '').trim(),
                    health: String(row[6] || '').trim(),
                    username: String(row[0] || '').trim()
                };

                return restored;
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            break;
        }
    }

    return null;
}

// Завантажує профіль користувача по username
async function loadKnownUserByUsername(username) {
    const usernameStr = String(username || '').trim().toLowerCase();
    if (!usernameStr) return null;

    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return null;
    }

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
                const rowUsername = String(row[0] || '').trim().toLowerCase(); // Column A (index 0)
                if (rowUsername !== usernameStr && !rowUsername.endsWith(usernameStr.replace('@', ''))) continue;

                const restored = {
                    name: String(row[1] || '').trim(),
                    phone: String(row[2] || '').trim(),
                    birth: String(row[3] || '').trim(),
                    visited: String(row[4] || '').trim(),
                    status: String(row[5] || '').trim(),
                    health: String(row[6] || '').trim(),
                    username: String(row[0] || '').trim()
                };

                return restored;
            }
        } catch (e) {
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found')) {
                continue;
            }
            break;
        }
    }

    return null;
}

// Показує форму реєстрації для кількох заходів
function showAfishaRegistrationForm(chatId, user) {
    if (!user.afishaMultiRegistration || !user.selectedEventsList || user.selectedEventsList.length === 0) {
        bot.sendMessage(chatId, "❌ Помилка: немає вибраних заходів");
        return;
    }

    user.afishaFullRegistration = true;
    user.registrationMode = true;
    const step = user.step && user.step > 0 ? user.step : 1;
    user.step = step;

    let question = "<b>1. Прізвище Ім'я По-батькові</b>";
    if (step === 2) question = "<b>2. Телефон (380...)</b>";
    if (step === 3) question = "<b>3. Дата народження</b>";
    if (step === 4) question = "<b>4. Чи відвідували Простір раніше?</b>";
    if (step === 5) question = "<b>5. ВПО/МО</b>";
    if (step === 6) question = "<b>6. Інвалідність/суттєві проблеми</b>";

    let keyboard = [[{ text: "❌ Скасувати реєстрацію" }]];
    if (step === 4) {
        keyboard = [[{ text: "Так" }, { text: "Ні" }], [{ text: "❌ Скасувати реєстрацію" }]];
    } else if (step === 5) {
        keyboard = [[{ text: "ВПО" }, { text: "Місцева" }], [{ text: "❌ Скасувати реєстрацію" }]];
    } else if (step === 6) {
        keyboard = [
            [{ text: "Інвалідність" }],
            [{ text: "Суттєві проблеми" }],
            [{ text: "Немає" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    }

    bot.sendMessage(chatId, 
        `📝 <b>Реєстрація на ${user.selectedEventsList.length} заходи</b>\n\n` +
        `Заповніть лише відсутні дані:\n\n` +
        `${question}`, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard,
            resize_keyboard: true
        }
    });
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

    // Додаткова перевірка дублікату після рестарту бота: дивимось запис у нотатці таблиці
    if (evObj) {
        const duplicateInSheet = await isRegistrantAlreadyInEventNote(evObj, registrantProfile);
        if (duplicateInSheet) {
            return { status: 'already-registered' };
        }
    }
    
    // Перевіряємо дублікати в пам'яті (не в таблиці)
    if (evObj && userEventRegistrations[chatId]) {
        const alreadyAdded = userEventRegistrations[chatId].some(r => r.eventId === eventId);
        if (alreadyAdded) {
            return { status: 'already-registered' };
        }
    }

    // Оновлюємо лічильник тільки в пам'яті
    if (evObj) {
        evObj.registrations = (evObj.registrations || 0) + 1;
        if (typeof evObj.seats === 'number') evObj.seats = Math.max(0, evObj.seats - 1);
        await incrementSheetRegistration(evObj, registrantProfile);
    }

    if (user.step === 7) {
        if (!user.selectedEvents) user.selectedEvents = [];
        user.selectedEvents.push({ id: eventId, name: eventName });
    }
    
    // Зберігаємо реєстрацію для нагадувань
    if (evObj && evObj.date) {
        if (!userEventRegistrations[chatId]) {
            userEventRegistrations[chatId] = [];
        }
        
        // Перевіряємо чи вже не додано
        const alreadyAdded = userEventRegistrations[chatId].some(r => r.eventId === eventId);
        if (!alreadyAdded) {
            userEventRegistrations[chatId].push({
                eventId: eventId,
                eventName: eventName,
                eventDate: evObj.date,
                registrantName: registrantProfile.name,
                registrantPhone: registrantProfile.phone,
                reminded24h: false,
                reminded1h: false
            });
            saveReminderStateToDisk();
            console.log(`📝 Збережено реєстрацію для нагадувань: ${chatId} → ${eventName} (${evObj.date})`);
        }
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

// Функція для відписання від заходу
async function unregisterFromEvent(chatId, eventId) {
    if (!userEventRegistrations[chatId]) {
        return { status: 'not-registered' };
    }

    // Шукаємо реєстрацію
    const regIndex = userEventRegistrations[chatId].findIndex(r => r.eventId === eventId);
    if (regIndex === -1) {
        return { status: 'not-found' };
    }

    // Видаляємо з пам'яті користувача
    const registration = userEventRegistrations[chatId][regIndex];
    userEventRegistrations[chatId].splice(regIndex, 1);

    // Очищаємо пустий масив
    if (userEventRegistrations[chatId].length === 0) {
        delete userEventRegistrations[chatId];
    }
    saveReminderStateToDisk();

    // Оновлюємо коунтери в пам'яті (звільнюємо місце)
    const event = events.find(e => e.id === eventId);
    if (event) {
        event.registrations = Math.max(0, (event.registrations || 1) - 1);
        if (typeof event.seats === 'number') {
            event.seats = event.seats + 1;
        }

        const registrantProfile = await resolveRegistrantProfile(
            chatId,
            users[chatId],
            registration.registrantName,
            registration.registrantPhone
        );
        await decrementSheetRegistration(event, registrantProfile);
        console.log(`📝 Користувач ${chatId} відписаний від "${registration.eventName}" (місць +1)`);
    }

    return { status: 'ok', eventName: registration.eventName };
}

// Отримує заходи користувача на цьому тижні
async function getUserWeeklyEvents(chatId, userProfile) {
    const userRegistrations = userEventRegistrations[chatId] || [];
    
    if (!userRegistrations || userRegistrations.length === 0) {
        return [];
    }
    
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setUTCDate(now.getUTCDate() - now.getUTCDay()); // Неділя
    startOfWeek.setUTCHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6); // Субота
    endOfWeek.setUTCHours(23, 59, 59, 999);
    
    const weeklyEvents = userRegistrations
        .filter(reg => reg.eventDate >= startOfWeek && reg.eventDate <= endOfWeek)
        .sort((a, b) => a.eventDate - b.eventDate)
        .map(reg => ({
            name: reg.eventName,
            dateStr: reg.eventDate.toLocaleDateString('uk-UA', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
            })
        }));
    
    return weeklyEvents;
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
    
    // ДІАГНОСТИКА: логуємо всі групові повідомлення
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        console.log(`\n[GROUP MSG] ID: ${chatId}, Type: ${msg.chat.type}, Reply: ${!!msg.reply_to_message}`);
    }
    
    // ДІАГНОСТИКА: логуємо всі повідомлення з групи звернень
    if (chatId === APPEALS_GROUP_ID) {
        console.log(`\n🔔 ПОВІДОМЛЕННЯ З ГРУПИ ЗВЕРНЕНЬ`);
        console.log(`Chat ID: ${chatId} (type: ${typeof chatId})`);
        console.log(`APPEALS_GROUP_ID: ${APPEALS_GROUP_ID} (type: ${typeof APPEALS_GROUP_ID})`);
        console.log(`IDs match: ${chatId === APPEALS_GROUP_ID}`);
        console.log(`Chat type: ${msg.chat.type}`);
        console.log(`Has reply: ${!!msg.reply_to_message}`);
        console.log(`Message from: ${msg.from?.first_name || msg.from?.username || 'Unknown'} (${msg.from?.id})`);
        console.log(`Text: "${text.substring(0, 50)}"`);
        if (msg.reply_to_message) {
            console.log(`Reply to message_id: ${msg.reply_to_message.message_id}`);
            console.log(`Reply to text: "${(msg.reply_to_message.text || '').substring(0, 100)}"`);
            console.log(`Reply from bot: ${msg.reply_to_message.from?.is_bot}`);
            console.log(`Reply from username: ${msg.reply_to_message.from?.username}`);
        } else {
            console.log(`⚠️ Це НЕ відповідь (reply) на повідомлення!`);
        }
    }

    // ДІАГНОСТИКА: команда для перегляду всіх заходів
    if (text === '/debug_events' || text === '/debug') {
        const allEventsRaw = events || [];
        const now = new Date();
        const futureEvents = allEventsRaw.filter(e => e.date > now);
        
        let debugMsg = `🔍 <b>ДІАГНОСТИКА ЗАХОДІВ</b>\n\n`;
        debugMsg += `📊 Всього заходів: ${allEventsRaw.length}\n`;
        debugMsg += `📅 Майбутніх: ${futureEvents.length}\n`;
        debugMsg += `⏰ Поточний час: ${now.toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}\n\n`;
        
        if (allEventsRaw.length === 0) {
            debugMsg += `❌ Заходи не завантажені!\nПеревірте:\n• Підключення до Google Sheets\n• Формат таблиці Розклад`;
        } else {
            debugMsg += `<b>Всі заходи:</b>\n`;
            allEventsRaw.forEach((e, i) => {
                const dayNames = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П\'ятниця', 'Субота'];
                const dayName = dayNames[e.date.getDay()];
                const isPast = e.date <= now ? '(минулий)' : '';
                debugMsg += `${i+1}. ${e.name}\n`;
                debugMsg += `   ${dayName}, ${e.date.toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })} ${isPast}\n`;
                debugMsg += `   Місць: ${e.seats}\n\n`;
            });
        }
        
        bot.sendMessage(chatId, debugMsg, { parse_mode: 'HTML' });
        return;
    }

    // ДІАГНОСТИКА: тест зв'язку з групою звернень
    if (text === '/test_appeals' || text === '/test_group') {
        let testMsg = `🔍 <b>ТЕСТ ГРУПИ ЗВЕРНЕНЬ</b>\n\n`;
        testMsg += `📊 Поточний чат ID: ${chatId}\n`;
        testMsg += `📊 Тип чату: ${msg.chat.type}\n`;
        testMsg += `📊 APPEALS_GROUP_ID: ${APPEALS_GROUP_ID}\n`;
        testMsg += `📊 IDs match: ${chatId === APPEALS_GROUP_ID ? '✅' : '❌'}\n\n`;
        testMsg += `💾 Збережених звернень: ${Object.keys(appealMessagesMap).length}\n`;
        
        if (Object.keys(appealMessagesMap).length > 0) {
            testMsg += `\n<b>Останні 5 звернень:</b>\n`;
            const entries = Object.entries(appealMessagesMap).slice(-5);
            entries.forEach(([msgId, userId]) => {
                testMsg += `• msg_id: ${msgId} → user: ${userId}\n`;
            });
        }
        
        if (chatId === APPEALS_GROUP_ID) {
            testMsg += `\n✅ Це група звернень! Відповіді працюватимуть.`;
        } else {
            testMsg += `\n⚠️ Це НЕ група звернень!`;
        }
        
        bot.sendMessage(chatId, testMsg, { parse_mode: 'HTML' });
        return;
    }

    // ДІАГНОСТИКА: тест запису в таблицю персональних даних
    if (text === '/test_write' || text === '/test_table') {
        bot.sendMessage(chatId, '⏳ Тестую запис в таблицю "Березень"...');
        
        try {
            const testUser = {
                username: 'test_user',
                name: 'ТЕСТ Запис',
                phone: '380000000000',
                birth: '01.01.2000',
                visited: 'Ні',
                status: 'ВПО',
                health: 'Немає'
            };
            
            await appendRegistrationRow(chatId, testUser);
            
            bot.sendMessage(chatId, 
                `✅ <b>ТЕСТ УСПІШНИЙ!</b>\n\n` +
                `Запис в таблицю працює.\n` +
                `Перевірте таблицю "${PERSONAL_DATA_SHEET_NAME}" - там має з'явитись тестовий рядок.\n\n` +
                `<b>Важливо:</b> Видаліть тестовий рядок з таблиці вручну.`,
                { parse_mode: 'HTML' }
            );
        } catch (error) {
            let errorMsg = `❌ <b>ТЕСТ НЕ ПРОЙДЕНО!</b>\n\n`;
            errorMsg += `<b>Помилка:</b> ${error.message}\n\n`;
            
            if (error.message.includes('not found') || error.message.includes('Unable to parse')) {
                errorMsg += `❌ Лист "${PERSONAL_DATA_SHEET_NAME}" не знайдено в таблиці!\n\n`;
                errorMsg += `<b>Рішення:</b>\n`;
                errorMsg += `1. Перевірте, що в таблиці є лист з назвою "${PERSONAL_DATA_SHEET_NAME}"\n`;
                errorMsg += `2. Або змініть PERSONAL_DATA_SHEET_NAME в налаштуваннях`;
            } else if (error.code === 403 || error.message.includes('permission')) {
                errorMsg += `❌ Немає доступу до таблиці!\n\n`;
                errorMsg += `<b>Рішення:</b>\n`;
                errorMsg += `1. Відкрийте Google таблицю\n`;
                errorMsg += `2. Натисніть "Поділитися"\n`;
                errorMsg += `3. Додайте email service account як редактора`;
            } else {
                errorMsg += `<b>Детальна інформація:</b>\n`;
                errorMsg += `<code>${JSON.stringify(error, null, 2).substring(0, 500)}</code>`;
            }
            
            bot.sendMessage(chatId, errorMsg, { parse_mode: 'HTML' });
        }
        return;
    }

    // ДІАГНОСТИКА: команда для перезавантаження розкладу
    if (text === '/reload_schedule' || text === '/reload') {
        bot.sendMessage(chatId, '⏳ Перезавантажую розклад з Google Sheets...');
        try {
            await loadEventsFromSheet();
            bot.sendMessage(chatId, `✅ Розклад оновлено!\nЗавантажено ${events.length} заходів`);
        } catch (e) {
            bot.sendMessage(chatId, `❌ Помилка: ${e.message}`);
        }
        return;
    }

    // ДІАГНОСТИКА: команда для тестування з'єднання з Google Sheets
    if (text === '/test_sheets' || text === '/test') {
        let testMsg = `🔍 <b>ТЕСТ GOOGLE SHEETS З'ЄДНАННЯ</b>\n\n`;
        
        try {
            // Тест 1: Перевірка sheetsClient
            if (!sheetsClient) {
                testMsg += `❌ sheetsClient не ініціалізований\n`;
                bot.sendMessage(chatId, testMsg, { parse_mode: 'HTML' });
                return;
            }
            testMsg += `✅ sheetsClient ініціалізований\n\n`;
            
            // Тест 2: Тест читання таблиці розкладу
            try {
                const scheduleResp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${SCHEDULE_SHEET_NAME}!A1:C1`
                });
                testMsg += `✅ <b>Таблиця розкладу:</b>\n`;
                testMsg += `   ID: ${SPREADSHEET_ID.substring(0, 20)}...\n`;
                testMsg += `   Лист: "${SCHEDULE_SHEET_NAME}"\n`;
                testMsg += `   Статус: Доступна ✅\n\n`;
            } catch (e) {
                testMsg += `❌ <b>Таблиця розкладу:</b> ${e && e.message ? e.message : e}\n\n`;
            }
            
            // Тест 3: Тест читання таблиці особистих даних
            try {
                const personalResp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range: `${PERSONAL_DATA_SHEET_NAME}!A1:G1`
                });
                testMsg += `✅ <b>Таблиця персональних даних:</b>\n`;
                testMsg += `   ID: ${PERSONAL_DATA_SPREADSHEET_ID.substring(0, 20)}...\n`;
                testMsg += `   Лист: "${PERSONAL_DATA_SHEET_NAME}"\n`;
                testMsg += `   Статус: Доступна ✅\n`;
                testMsg += `   Рядків: ${(personalResp.data.values || []).length}\n\n`;
            } catch (e) {
                testMsg += `❌ <b>Таблиця персональних даних:</b> ${e && e.message ? e.message : e}\n\n`;
            }
            
            testMsg += `📝 Якщо є помилки, перевірте:\n`;
            testMsg += `• Дозволи service account\n`;
            testMsg += `• Назви листів у конфігурації\n`;
            testMsg += `• Активність Google Sheets API`;
            
        } catch (error) {
            testMsg = `❌ <b>ПОМИЛКА ТЕСТУ</b>\n\n${error && error.message ? error.message : error}`;
        }
        
        bot.sendMessage(chatId, testMsg, { parse_mode: 'HTML' });
        return;
    }

    // respond to /start command by auto-loading profile
    if (text === '/start') {
        if (!users[chatId]) users[chatId] = { step: 0 };
        const user = users[chatId];
        if (msg.from && msg.from.username) {
            user.username = String(msg.from.username).trim();
        }
        
        // Шукаємо профіль по chatId, а якщо не знайдено — по username
        let foundProfile = await loadKnownUserByChatId(chatId);
        if (!foundProfile && msg.from && msg.from.username) {
            foundProfile = await loadKnownUserByUsername(msg.from.username);
        }
        
        if (foundProfile && foundProfile.name && foundProfile.phone) {
            // Профіль знайдено — логінимо користувача
            Object.assign(user, foundProfile);
            user.profileHydrated = true;
            
            // Завантажуємо заходи з розпису для цього тижня
            const thisWeekEvents = await getUserWeeklyEvents(chatId, foundProfile);
            
            let greeting = `✅ Привіт, ${foundProfile.name.split(' ')[1]}! Рад(а) тебе бачити.\n\n`;
            
            if (thisWeekEvents && thisWeekEvents.length > 0) {
                greeting += `📅 <b>Ваші заходи на цьому тижні:</b>\n`;
                thisWeekEvents.forEach((evt, idx) => {
                    greeting += `${idx + 1}. ${evt.name}\n   🕐 ${evt.dateStr}\n`;
                });
                greeting += `\n🔔 Ми надішлемо нагадування за 24 години та за 1 годину\n\n`;
            } else {
                greeting += `📅 На цьому тижні у вас немає заходів\n\n`;
            }
            
            greeting += `Оберіть дію:`;
            
            await bot.sendMessage(chatId, greeting, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Афіша заходів" }],
                        [{ text: "Нагадування" }],
                        [{ text: "Контакти" }],
                        [{ text: "Назад" }]
                    ],
                    resize_keyboard: true
                }
            });
        } else {
            // Профіль не знайдено — запускаємо реєстрацію
            user.step = 1;
            user.registrationMode = true;
            user.registrationData = {
                chatId: String(chatId)
            };
            
            await bot.sendMessage(chatId, "Профіль не знайдено. 😔\n\nРозпочинаємо реєстрацію...\n\n📝 <b>Крок 1/6:</b> Будь ласка, введіть ваше <b>ПІБ</b> (Прізвище Ім'я По батькові):", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
        }
        return;
    }

    // === ОБРОБКА ВІДПОВІДЕЙ НА ЗВЕРНЕННЯ У ГРУПІ (ПЕРЕД ІНШИМИ ГРУПАМИ) ===
    if (chatId === APPEALS_GROUP_ID && msg.reply_to_message) {
        console.log(`\n🔍 ПЕРЕВІРКА REPLY У ГРУПІ ЗВЕРНЕНЬ`);
        console.log(`ChatID: ${chatId} (type: ${typeof chatId}) === APPEALS_GROUP_ID: ${APPEALS_GROUP_ID} (type: ${typeof APPEALS_GROUP_ID})`);
        console.log(`Comparison result: ${chatId === APPEALS_GROUP_ID}`);
        console.log(`Reply to message ID: ${msg.reply_to_message.message_id}`);
        console.log(`Reply to message from bot: ${msg.reply_to_message.from?.is_bot}`);
        console.log(`Reply to message from username: ${msg.reply_to_message.from?.username}`);
        
        // Шукаємо користувача через mapping
        const originalMessageId = msg.reply_to_message.message_id;
        const userChatId = appealMessagesMap[originalMessageId];
        
        console.log(`Mapping lookup: message_id ${originalMessageId} → user ${userChatId || 'НЕ ЗНАЙДЕНО'}`);
        console.log(`Total mappings available: ${Object.keys(appealMessagesMap).length}`);
        console.log(`Available message_ids:`, Object.keys(appealMessagesMap).join(', '));
        
        if (userChatId) {
            const replyText = text;
            
            console.log(`\n📨 ВІДПОВІДЬ НА ЗВЕРНЕННЯ`);
            console.log(`Від: ${msg.from.first_name || msg.from.username || 'Адміністратор'}`);
            console.log(`Кому: ${userChatId}`);
            console.log(`Текст: ${replyText.substring(0, 100)}`);
            
            try {
                // Відправляємо відповідь користувачу
                await bot.sendMessage(userChatId, `📬 <b>Відповідь від команди "Вільна":</b>\n\n${replyText}`, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Повернутися в меню" }]
                        ],
                        resize_keyboard: true
                    }
                });
                
                // Підтверджуємо успішну відправку в групі
                await bot.sendMessage(APPEALS_GROUP_ID, `✅ Відповідь надіслано користувачу`, {
                    reply_to_message_id: msg.message_id
                });
                
                console.log(`✅ Відповідь успішно надіслано користувачу ${userChatId}\n`);
            } catch (error) {
                console.error(`❌ Помилка при відправці відповіді:`, error);
                await bot.sendMessage(APPEALS_GROUP_ID, `❌ Не вдалося надіслати відповідь користувачу (можливо, заблокував бота)`, {
                    reply_to_message_id: msg.message_id
                });
            }
        } else {
            console.log(`⚠️ Не знайдено користувача для message_id ${originalMessageId} в mapping`);
            console.log(`⚠️ Спроба відповісти старим способом...`);
            
            // Спробуємо відповісти тому, хто відправив повідомлення (fallback)
            await bot.sendMessage(APPEALS_GROUP_ID, 
                `⚠️ Не знайдено користувача для цього звернення.\n\n` +
                `Це може статися якщо:\n` +
                `• Бот був перезапущений після отримання звернення\n` +
                `• Звернення старше ніж останній перезапуск\n\n` +
                `Використайте @username користувача для відповіді напряму.`, 
                {
                    reply_to_message_id: msg.message_id
                }
            );
        }
        return; // Не обробляємо інші повідомлення з групи
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
        
        // Додатково логуємо повідомлення з групи звернень
        if (msg.chat.id === APPEALS_GROUP_ID) {
            console.log(`   🔔 Це група звернень! ID: ${APPEALS_GROUP_ID}`);
            console.log(`   Reply: ${msg.reply_to_message ? 'ТАК' : 'НІ'}`);
            if (msg.reply_to_message) {
                console.log(`   Reply from bot: ${msg.reply_to_message.from?.is_bot ? 'ТАК' : 'НІ'}`);
            }
        }
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
    if (msg.from && msg.from.username) {
        user.username = String(msg.from.username).trim();
    }

    // (Старий код waitingForLogin видалено - тепер /start автоматично обробляє профіль)

    if (!user.profileHydrated) {
        let restoredProfile = await loadKnownUserByChatId(chatId);
        if (!restoredProfile && msg.from && msg.from.username) {
            restoredProfile = await loadKnownUserByUsername(msg.from.username);
        }
        if (restoredProfile) {
            Object.assign(user, restoredProfile);
        } else if (knownUsers[chatId]) {
            Object.assign(user, knownUsers[chatId]);
        }
        user.profileHydrated = true;
    }

    if (text === "❌ Скасувати реєстрацію") {
        delete user.afishaMultiRegistration;
        delete user.afishaFullRegistration;
        delete user.selectedEventsList;
        delete user.currentSelectedEventName;
        delete user.currentSelectedEventId;
        user.step = 0;
        user.registrationMode = false;

        await bot.sendMessage(chatId, "Реєстрацію скасовано. Оберіть дію в меню.", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Нагадування" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // === ОБРОБКА ЗВЕРНЕНЬ - ПЕРЕВІРЯЄМО ПЕРШИМ ===
    if (text === "Скасувати" && user.context === 'appeal') {
        console.log(`✅ Скасування звернення для ${chatId}`);
        user.context = null;
        user.step = 0;
        await bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Нагадування" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // === ОБРОБКА ЗВЕРНЕННЯ - ОДРАЗУ ТЕКСТ ===
    if (user.context === 'appeal' && user.step === 1) {
        console.log(`\n========== ЗВЕРНЕННЯ ==========`);
        console.log(`ChatID: ${chatId}`);
        console.log(`Text: "${text.substring(0, 100)}"`);
        
        // Автоматично беремо дані з реєстрації або Telegram профілю
        const userName = knownUsers[chatId]?.name || 
                        msg.from.first_name || 
                        (msg.from.username ? `@${msg.from.username}` : `користувач ${chatId}`);
        const userPhone = knownUsers[chatId]?.phone || 'не вказаний';
        
        console.log(`Auto Name: ${userName}`);
        console.log(`Auto Phone: ${userPhone}`);
        
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
        if (APPEALS_GROUP_ID) {
            try {
                console.log(`⏳ Надсилаю в групу ${APPEALS_GROUP_ID}...`);
                const result = await bot.sendMessage(APPEALS_GROUP_ID, appealMessage, {
                    parse_mode: 'HTML'
                });
                
                // Зберігаємо mapping між message_id та chatId користувача
                appealMessagesMap[result.message_id] = chatId;
                console.log(`💾 Збережено mapping: message_id ${result.message_id} → user chatId ${chatId}`);
                console.log(`💾 Всього mappings в пам'яті: ${Object.keys(appealMessagesMap).length}`);
                console.log(`💾 Список всіх message_ids:`, Object.keys(appealMessagesMap).join(', '));
                
                console.log(`✅ УСПІХ! Message ID: ${result.message_id}`);
                console.log(`ℹ️  Щоб відповісти користувачу, натисніть Reply на це повідомлення в групі`);
                console.log(`===============================\n`);
                bot.sendMessage(chatId, "✅ Дякуємо! Ваше звернення надіслано.\n\nНаша команда обов'язково його прочитає і зв'яжеться з вами якомога швидше. 🩵", {
                    reply_markup: {
                        keyboard: [[{ text: "Повернутися в меню" }]],
                        resize_keyboard: true
                    }
                });
                user.step = 0;
                user.context = null;
            } catch (error) {
                console.error(`❌ ПОМИЛКА при відправці:`);
                console.error(`Код: ${error.code}`);
                console.error(`Повідомлення: ${error.message}`);
                console.error(`Повний стек:`, error);
                console.log(`===============================\n`);
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
            console.error(`❌ APPEALS_GROUP_ID НЕ ВСТАНОВЛЕНО!`);
            console.log(`===============================\n`);
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

    // === ОБРОБКА РЕЄСТРАЦІЙНОЇ ФОРМИ (КРОКИ 1-6) ===
    // ВАЖЛИВО: цей блок повинен бути ПЕРЕД всіма іншими обробниками меню!
    const registrationStep = Number(user.step);
    if (user.registrationMode || (Number.isInteger(registrationStep) && registrationStep >= 1 && registrationStep <= 6)) {
        // Відновлюємо режим форми, якщо прапорець загубився, але крок лишився
        user.registrationMode = true;
        user.step = registrationStep;

        if (user.step === 1) {
            user.name = text;
            user.step = 2;

            await bot.sendMessage(chatId, "📝 <b>Крок 2/6:</b> Введіть ваш <b>номер телефону</b> (формат: 380...)", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 2) {
            user.phone = text;
            user.step = 3;

            await bot.sendMessage(chatId, "📝 <b>Крок 3/6:</b> Введіть вашу <b>дату народження</b> (формат: ДД.ММ.РРРР)", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 3) {
            user.birth = text;
            user.step = 4;

            await bot.sendMessage(chatId, "📝 <b>Крок 4/6:</b> Чи відвідували ви Простір раніше?", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Так" }, { text: "Ні" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 4) {
            user.visited = text;
            user.step = 5;

            await bot.sendMessage(chatId, "📝 <b>Крок 5/6:</b> Ваш статус:", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "ВПО" }, { text: "Місцева" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 5) {
            user.status = text;
            user.step = 6;

            await bot.sendMessage(chatId, "📝 <b>Крок 6/6:</b> Інвалідність/суттєві проблеми зі здоров'ям:", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Інвалідність" }],
                        [{ text: "Суттєві проблеми" }],
                        [{ text: "Немає" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 6) {
            user.health = text;

            try {
                console.log(`\n📝 === ЗБЕРЕЖЕННЯ РЕЄСТРАЦІЇ ===`);
                console.log(`ChatID: ${chatId}`);
                console.log(`Дані користувача:`, {
                    name: user.name,
                    phone: user.phone,
                    birth: user.birth,
                    visited: user.visited,
                    status: user.status,
                    health: user.health
                });
                
                // Записуємо дані прямо в таблицю без пункту username
                await appendRegistrationRow(chatId, user);

                console.log(`✅ Реєстрація успішно збережена для ${chatId}`);
                console.log(`===============================\n`);

                // Зберігаємо дані користувача для швидкого доступу 
                knownUsers[chatId] = {
                    name: user.name,
                    phone: user.phone,
                    birth: user.birth,
                    visited: user.visited,
                    status: user.status,
                    health: user.health,
                    username: user.username || ""
                };

                if (user.afishaMultiRegistration && user.selectedEventsList && user.selectedEventsList.length > 0) {
                    let successCount = 0;
                    let failureCount = 0;
                    const registrationResults = [];

                    for (const event of user.selectedEventsList) {
                        user.selectedEventId = event.id;
                        user.selectedEventName = event.name;

                        const result = await registerForSelectedEvent(chatId, user, user.name, user.phone);
                        if (result.status === 'success' || result.status === 'ok') {
                            successCount += 1;
                            registrationResults.push(`✅ ${event.name}`);
                        } else if (result.status === 'already-registered') {
                            failureCount += 1;
                            registrationResults.push(`ℹ️ ${event.name} - вже зареєстровані`);
                        } else if (result.status === 'no-seats') {
                            failureCount += 1;
                            registrationResults.push(`❌ ${event.name} - місця закінчилися`);
                        } else {
                            failureCount += 1;
                            registrationResults.push(`❌ ${event.name} - помилка`);
                        }
                    }

                    let message = `📝 <b>Результати реєстрації:</b>\n\n`;
                    registrationResults.forEach((item) => {
                        message += `${item}\n`;
                    });
                    message += `\n✅ Успішно: ${successCount}\n❌ Помилок: ${failureCount}`;

                    await bot.sendMessage(chatId, message, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            keyboard: [[{ text: "Повернутися в меню" }]],
                            resize_keyboard: true
                        }
                    });

                    delete user.afishaMultiRegistration;
                    delete user.afishaEventIndex;
                    delete user.currentMultiEventId;
                    delete user.currentMultiEventName;
                    delete user.selectedEventsList;
                    delete user.currentSelectedEventName;
                    delete user.currentSelectedEventId;
                    delete user.selectedEventId;
                    delete user.selectedEventName;
                    user.step = 0;
                    user.registrationMode = false;
                    return;
                }

                // Показуємо меню з кнопками
                await bot.sendMessage(chatId, "✅ <b>Реєстрація завершена!</b>\n\n👤 " + user.name + "\n📱 " + user.phone + "\n\nТепер вибери, що далі:", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Афіша заходів" }],
                            [{ text: "Контакти" }],
                            [{ text: "Назад в меню" }]
                        ],
                        resize_keyboard: true
                    }
                });
                
                user.step = 0;
                user.registrationMode = false;
                return;
            } catch (error) {
                console.error(`\n❌ === ПОМИЛКА ЗБЕРЕЖЕННЯ РЕЄСТРАЦІЇ ===`);
                console.error(`ChatID: ${chatId}`);
                console.error(`Дані які намагалась зберегти:`, {
                    name: user.name,
                    phone: user.phone,
                    birth: user.birth,
                    visited: user.visited,
                    status: user.status,
                    health: user.health
                });
                console.error(`Помилка:`, error);
                console.error(`Stack:`, error.stack);
                console.error(`===============================\n`);
                
                let errorMsg = error && error.message ? error.message : 'Невідома помилка';
                
                // Додаємо деталі про можливі причини
                let hint = '';
                if (errorMsg.toLowerCase().includes('permission') || errorMsg.toLowerCase().includes('403')) {
                    hint = '\n\n💡 Перевірте, чи добавлено service account як редактор до Google Sheet.';
                } else if (errorMsg.toLowerCase().includes('quota') || errorMsg.toLowerCase().includes('rate limit')) {
                    hint = '\n\n💡 Перевищено ліміт API. Спробуйте ще раз за 1-2 хвилини.';
                } else if (errorMsg.toLowerCase().includes('not found') || errorMsg.toLowerCase().includes('sheet')) {
                    hint = `\n\n💡 Перевірте PERSONAL_DATA_SPREADSHEET_ID, доступ service account та існування листа "${PERSONAL_DATA_SHEET_NAME}".`;
                }
                
                bot.sendMessage(chatId, `❌ Помилка при збереженні даних.\n\nДеталі: ${errorMsg}${hint}\n\nБудь ласка, спробуйте ще раз або зверніться до адміністратора.`, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                user.step = 6;
                return;
            }
        }
    }

    if (text === "Реєстрація") {
        // Запускаємо форму реєстрації одразу
        user.step = 1;
        user.registrationMode = true;
        
        await bot.sendMessage(chatId, "📝 <b>Крок 1/6:</b> Будь ласка, введіть ваше <b>ПІБ</b> (Прізвище Ім'я По батькові):", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "❌ Скасувати реєстрацію" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Афіша заходів") {
        // Перевіряємо чи у користувача вже є профіль
        const registrantData = await resolveRegistrantFormData(chatId, user);
        const hasAllData = registrantData.name && registrantData.phone && registrantData.birth && 
                          registrantData.visited && registrantData.status && registrantData.health;
        
        if (!hasAllData) {
            // Дані неповні — питаємо їх
            user.step = 1;
            user.registrationMode = true;
            await bot.sendMessage(chatId, "Спочатку заповніть дані.\n\n📝 <b>Крок 1/6:</b> Будь ласка, введіть ваше <b>ПІБ</b> (Прізвище Ім'я По батькові):", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }
        
        // Дані повні — показуємо меню днів тижня для вибору заходів
        user.context = 'afisha';
        Object.assign(user, registrantData);
        await showAfishaDaysMenu(chatId);
        return;
    }

    if (text === "Нагадування") {
        // Після рестарту відновлюємо реєстрації з нотаток таблиці для цього користувача.
        await restoreUserRegistrationsFromSheet(chatId, user);

        // Показуємо майбутні заходи користувача з нагадуваннями
        const userRegistrations = userEventRegistrations[chatId] || [];
        
        if (userRegistrations.length === 0) {
            bot.sendMessage(chatId, 
                "📅 У вас немає запланованих заходів.\n\n" +
                "Зареєструйтесь на захід через меню «Афіша заходів», і ми нагадаємо вам про нього! 🩵", {
                reply_markup: {
                    keyboard: [
                        [{ text: "Повернутися в меню" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }
        
        // Сортуємо за датою
        const sortedEvents = [...userRegistrations].sort((a, b) => a.eventDate - b.eventDate);
        
        let message = "📅 <b>Ваші майбутні заходи:</b>\n\n";
        
        sortedEvents.forEach((reg, index) => {
            const dateStr = reg.eventDate.toLocaleDateString('uk-UA', { 
                weekday: 'long', 
                day: 'numeric', 
                month: 'long' 
            });
            const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            
            const timeUntilEvent = reg.eventDate - new Date();
            const hoursUntilEvent = Math.floor(timeUntilEvent / (1000 * 60 * 60));
            const daysUntilEvent = Math.floor(hoursUntilEvent / 24);
            
            let timeLeftStr = '';
            if (daysUntilEvent > 0) {
                timeLeftStr = `через ${daysUntilEvent} ${daysUntilEvent === 1 ? 'день' : 'днів'}`;
            } else if (hoursUntilEvent > 0) {
                timeLeftStr = `через ${hoursUntilEvent} год`;
            } else {
                timeLeftStr = 'сьогодні';
            }
            
            message += `${index + 1}. <b>${reg.eventName}</b>\n`;
            message += `   🕐 ${dateStr} о ${timeStr}\n`;
            message += `   ⏱ ${timeLeftStr}\n`;
            
            if (reg.reminded24h) {
                message += `   ✅ Нагадування за 24 год надіслано\n`;
            }
            if (reg.reminded1h) {
                message += `   ✅ Нагадування за 1 год надіслано\n`;
            }
            message += '\n';
        });
        
        message += "\n🔔 <b>Автоматичні нагадування:</b>\n";
        message += "• За 24 години до заходу\n";
        message += "• За 1 годину до заходу\n\n";
        message += "Ми обов'язково нагадаємо вам! 🩵";
        
        // Отримуємо налаштування користувача
        if (!users[chatId]) users[chatId] = { step: 0 };
        const remindersEnabled = users[chatId].remindersEnabled !== false; // за замовчуванням вмикнено
        
        let settingsStatus = remindersEnabled ? "✅ Нагадування увімкнені" : "❌ Нагадування вимкнені";
        
        bot.sendMessage(chatId, message + `\n\n${settingsStatus}`, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "❌ Відписатись від заходу" }],
                    [{ text: "⚙️ Налаштування нагадувань" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
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
        
        const appealInstructions = `📝 <b>Написати звернення</b>

Ви можете написати нам про:
• Питання, що вас цікавлять
• Пропозиції та ідеї
• Проблеми, які потребують рішення
• Ваші враження від відвідування

Ваше звернення буде передане безпосередньо команді "Вільної", яка обов'язково його прочитає та зв'яжеться з вами якомога швидше. 🤝

⬇️ <b>Напишіть текст звернення нижче</b> (або натисніть "Скасувати")`;
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
    const normalizedText = normalizeWeekdayKey(text);
    const weekdays = { 'неділя':0, 'понеділок':1, 'вівторок':2, 'середа':3, 'четвер':4, "п'ятниця":5, 'субота':6 };
    
    console.log('🔍 Перевірка дня: text="' + text + '" → normalized="' + normalizedText + '"');
    if (weekdays[normalizedText] !== undefined) {
        console.log('✅ Знайдено день: ' + normalizedText + ' → ' + weekdays[normalizedText]);
        await showDayAgenda(chatId, text);
        return;
    }
    console.log('⚠️ День не знайдено. Доступні ключі:', Object.keys(weekdays));

    // === ПЕРЕВІРЯЄМО КОНТЕКСТ ВІДПИСАННЯ ДО ПОШУКУ ЗАХОДУ ===
    // Обробка вибору заходу для відписання
    if (user.context === 'unregister' && user.unregButtonMap && user.unregButtonMap[text]) {
        const eventId = user.unregButtonMap[text];
        
        // Знаходимо інформацію про захід
        const regIndex = (userEventRegistrations[chatId] || []).findIndex(r => r.eventId === eventId);
        if (regIndex === -1) {
            bot.sendMessage(chatId, "❌ Захід не знайдено.", {
                reply_markup: {
                    keyboard: [[{ text: "Нагадування" }], [{ text: "Повернутися в меню" }]],
                    resize_keyboard: true
                }
            });
            delete user.unregButtonMap;
            user.context = null;
            return;
        }
        
        const eventName = userEventRegistrations[chatId][regIndex].eventName;
        
        // Підтвердження
        user.pendingUnregEventId = eventId;
        user.pendingUnregEventName = eventName;
        
        const confirmMsg = `❓ <b>Ви впевнені, що хочете відписатись від цього заходу?</b>\n\n📌 <b>${eventName}</b>\n\nДані про вас залишаться в базі, але місце звільниться для інших учасників.`;
        
        bot.sendMessage(chatId, confirmMsg, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "✅ Так, відписатись" }],
                    [{ text: "❌ Скасувати" }]
                ],
                resize_keyboard: true
            }
        });
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
        
        // Отримуємо список вибраних заходів
        if (!user.selectedEventsList) {
            user.selectedEventsList = [];
        }
        
        // Перевіряємо чи цей захід вже в списку
        const alreadySelected = user.selectedEventsList.some(e => e.id === selectedEvent.id);
        
        // build keyboard options
        const buttons = [];
        if (seatsLeft > 0 && !alreadySelected) {
            buttons.push([{ text: "➕ Додати до реєстрації" }]);
        } else if (alreadySelected) {
            buttons.push([{ text: "✅ Вже додано" }]);
        } else {
            buttons.push([{ text: "❌ Місць немає" }]);
        }
        
        // Додаємо кнопку для переходу до реєстрації якщо щось вибрано
        if (user.selectedEventsList.length > 0) {
            buttons.push([{ text: "📝 Перейти до реєстрації" }]);
        }
        buttons.push([{ text: "Назад до вибору днів" }]);

        bot.sendMessage(chatId, `✅ Захід: ${selectedEvent.name}\n📅 ${formatEventDate(selectedEvent.date)}\n${seatsInfo}`, {
            reply_markup: {
                keyboard: buttons,
                resize_keyboard: true
            }
        });
        
        // Зберігаємо поточний захід для додавання
        user.currentSelectedEventName = selectedEvent.name;
        user.currentSelectedEventId = selectedEvent.id;
        return;
    }

    // Додаємо захід до кошика
    if (text === "➕ Додати до реєстрації") {
        if (!user.selectedEventsList) {
            user.selectedEventsList = [];
        }
        
        const eventName = user.currentSelectedEventName;
        const eventId = user.currentSelectedEventId;
        
        if (eventName && eventId && !user.selectedEventsList.some(e => e.id === eventId)) {
            user.selectedEventsList.push({ id: eventId, name: eventName });
            
            let message = `✅ <b>Захід добавлено!</b>\n\n`;
            message += `Вибрано заходів: ${user.selectedEventsList.length}\n\n`;
            message += `📝 <b>Вибрані заходи:</b>\n`;
            user.selectedEventsList.forEach((e, i) => {
                message += `${i + 1}. ${e.name}\n`;
            });
            message += `\n<b>Виберіть дію:</b>`;
            
            bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "➕ Додати ще один" }],
                        [{ text: "📝 Перейти до реєстрації" }],
                        [{ text: "Назад до вибору днів" }]
                    ],
                    resize_keyboard: true
                }
            });
        }
        return;
    }

    // Повертаємось до афіші для додавання ще одного заходу
    if (text === "➕ Додати ще один") {
        await showAfishaDaysMenu(chatId);
        return;
    }

    // Перейти до реєстрації на всі вибрані заходи
    if (text === "📝 Перейти до реєстрації") {
        // Якщо щойно обрали захід і ще не натиснули "Додати", не губимо його.
        if (user.currentSelectedEventId && user.currentSelectedEventName) {
            if (!user.selectedEventsList) {
                user.selectedEventsList = [];
            }
            const alreadyAddedCurrent = user.selectedEventsList.some((item) => item.id === user.currentSelectedEventId);
            if (!alreadyAddedCurrent) {
                user.selectedEventsList.push({
                    id: user.currentSelectedEventId,
                    name: user.currentSelectedEventName
                });
            }
        }

        if (!user.selectedEventsList || user.selectedEventsList.length === 0) {
            bot.sendMessage(chatId, "❌ Немає вибраних заходів. Оберіть захід з афіші.", {
                reply_markup: {
                    keyboard: [
                        [{ text: "Афіша заходів" }],
                        [{ text: "Повернутися в меню" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        // Показуємо що будемо реєструвати
        let message = `📝 <b>Реєстрація на заходи</b>\n\n`;
        message += `Ви реєструватиметесь на:\n`;
        user.selectedEventsList.forEach((e, i) => {
            message += `${i + 1}. ${e.name}\n`;
        });
        message += `\n<b>Заповніть форму один раз для всіх заходів:</b>`;

        bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "✅ Продовжити реєстрацію" }],
                    [{ text: "❌ Скасувати" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // Обробка реєстрації на всі вибрані заходи
    if (text === "✅ Продовжити реєстрацію") {
        // Страховка від втрати стану між кнопками.
        if (user.currentSelectedEventId && user.currentSelectedEventName) {
            if (!user.selectedEventsList) {
                user.selectedEventsList = [];
            }
            const alreadyAddedCurrent = user.selectedEventsList.some((item) => item.id === user.currentSelectedEventId);
            if (!alreadyAddedCurrent) {
                user.selectedEventsList.push({
                    id: user.currentSelectedEventId,
                    name: user.currentSelectedEventName
                });
            }
        }

        if (!user.selectedEventsList || user.selectedEventsList.length === 0) {
            bot.sendMessage(chatId, "❌ Немає вибраних заходів.", {
                reply_markup: {
                    keyboard: [[{ text: "Повернутися в меню" }]],
                    resize_keyboard: true
                }
            });
            return;
        }

        // Запускаємо реєстрацію: якщо дані вже є, реєструємо одразу без повторних питань
        user.afishaMultiRegistration = true;
        const registrantData = await resolveRegistrantFormData(chatId, user);

        user.name = registrantData.name;
        user.phone = registrantData.phone;
        user.birth = registrantData.birth;
        user.visited = registrantData.visited;
        user.status = registrantData.status;
        user.health = registrantData.health;

        const missingStep = !registrantData.name ? 1
            : !registrantData.phone ? 2
            : !registrantData.birth ? 3
            : !registrantData.visited ? 4
            : !registrantData.status ? 5
            : !registrantData.health ? 6
            : 0;

        if (missingStep > 0) {
            user.step = missingStep;
            user.registrationMode = true;
            showAfishaRegistrationForm(chatId, user);
            return;
        }

        // Повні дані вже є: реєструємо на всі заходи без форми
        let successCount = 0;
        let failureCount = 0;
        const registrationResults = [];

        for (const event of user.selectedEventsList) {
            user.selectedEventId = event.id;
            user.selectedEventName = event.name;

            const result = await registerForSelectedEvent(chatId, user, registrantData.name, registrantData.phone);
            if (result.status === 'success' || result.status === 'ok') {
                successCount += 1;
                registrationResults.push(`✅ ${event.name}`);
            } else if (result.status === 'already-registered') {
                failureCount += 1;
                registrationResults.push(`ℹ️ ${event.name} - вже зареєстровані`);
            } else if (result.status === 'no-seats') {
                failureCount += 1;
                registrationResults.push(`❌ ${event.name} - місця закінчилися`);
            } else {
                failureCount += 1;
                registrationResults.push(`❌ ${event.name} - помилка`);
            }
        }

        let message = `📝 <b>Результати реєстрації:</b>\n\n`;
        registrationResults.forEach((item) => {
            message += `${item}\n`;
        });
        message += `\n✅ Успішно: ${successCount}\n❌ Помилок: ${failureCount}`;

        bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });

        knownUsers[chatId] = {
            name: user.name,
            phone: user.phone,
            birth: user.birth,
            visited: user.visited,
            status: user.status,
            health: user.health,
            username: user.username || ""
        };

        delete user.afishaMultiRegistration;
        delete user.afishaEventIndex;
        delete user.currentMultiEventId;
        delete user.currentMultiEventName;
        delete user.selectedEventsList;
        delete user.currentSelectedEventName;
        delete user.currentSelectedEventId;
        delete user.selectedEventId;
        delete user.selectedEventName;
        user.step = 0;
        return;
    }

    // Скасування реєстрації
    if (text === "❌ Скасувати") {
        user.selectedEventsList = [];
        user.currentSelectedEventName = undefined;
        user.currentSelectedEventId = undefined;
        
        bot.sendMessage(chatId, "Реєстрацію скасовано. Оберіть захід з афіші.", {
            reply_markup: {
                keyboard: [
                    [{ text: "Афіша заходів" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // Старий обробник реєстрації (сумісність зі старими кнопками)
    if (text === "Реєструватися") {
        if (!user.selectedEventsList) {
            user.selectedEventsList = [];
        }

        if (user.selectedEventId && user.selectedEventName && !user.selectedEventsList.some((e) => e.id === user.selectedEventId)) {
            user.selectedEventsList.push({
                id: user.selectedEventId,
                name: user.selectedEventName
            });
        }

        if (user.selectedEventsList.length === 0) {
            bot.sendMessage(chatId, "❌ Немає вибраних заходів. Оберіть захід з афіші.");
            return;
        }

        user.afishaMultiRegistration = true;
        showAfishaRegistrationForm(chatId, user);
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
        bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Нагадування" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        user.step = 0;
        user.registrationMode = false;
        return;
    }

    // Кнопка відписання від заходу
    if (text === "❌ Відписатись від заходу") {
        const userRegistrations = userEventRegistrations[chatId] || [];
        
        if (userRegistrations.length === 0) {
            bot.sendMessage(chatId, "📅 У вас немає запланованих заходів для відписання.", {
                reply_markup: {
                    keyboard: [
                        [{ text: "Нагадування" }],
                        [{ text: "Повернутися в меню" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }
        
        // Показуємо список заходів для відписання
        const unregButtonMap = {};
        const buttons = userRegistrations.map((reg, index) => {
            const dateStr = reg.eventDate.toLocaleDateString('uk-UA', { 
                day: '2-digit', 
                month: '2-digit' 
            });
            const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            const buttonText = `${index + 1}. ${reg.eventName} (${dateStr} ${timeStr})`;
            unregButtonMap[buttonText] = reg.eventId;
            return [{ text: buttonText }];
        });
        
        user.unregButtonMap = unregButtonMap;
        user.context = 'unregister';
        
        buttons.push([{ text: "❌ Скасувати" }]);
        
        bot.sendMessage(chatId, "🔴 <b>Виберіть захід для відписання:</b>", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buttons,
                resize_keyboard: true
            }
        });
        return;
    }

    // Потвердження відписання
    if (text === "✅ Так, відписатись" && user.pendingUnregEventId) {
        const eventId = user.pendingUnregEventId;
        const eventName = user.pendingUnregEventName;
        
        const result = await unregisterFromEvent(chatId, eventId);
        
        if (result.status === 'ok') {
            bot.sendMessage(chatId, 
                `✅ <b>Ви успішно відписались від заходу!</b>\n\n📌 ${eventName}\n\nМісце звільнено для інших учасників. 🩵`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Нагадування" }],
                        [{ text: "Повернутися в меню" }]
                    ],
                    resize_keyboard: true
                }
            });
        } else {
            bot.sendMessage(chatId, "❌ Помилка при відписанні. Спробуйте ще раз.", {
                reply_markup: {
                    keyboard: [[{ text: "Нагадування" }], [{ text: "Повернутися в меню" }]],
                    resize_keyboard: true
                }
            });
        }
        
        delete user.pendingUnregEventId;
        delete user.pendingUnregEventName;
        delete user.unregButtonMap;
        user.context = null;
        return;
    }

    // Скасування під час вибору для відписання
    if ((text === "❌ Скасувати" && user.context === 'unregister') || 
        (text === "❌ Скасувати" && user.pendingUnregEventId)) {
        delete user.unregButtonMap;
        delete user.pendingUnregEventId;
        delete user.pendingUnregEventName;
        user.context = null;
        
        bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Нагадування" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // Налаштування нагадувань
    if (text === "⚙️ Налаштування нагадувань") {
        if (!users[chatId]) users[chatId] = { step: 0 };
        
        const remindersEnabled = users[chatId].remindersEnabled !== false;
        const statusText = remindersEnabled ? "✅ увімкнені" : "❌ вимкнені";
        
        const settingsMsg = `⚙️ <b>Налаштування нагадувань про заходи</b>\n\n` +
            `Поточний статус: ${statusText}\n\n` +
            `<b>Оберіть дію:</b>`;
        
        const buttons = remindersEnabled 
            ? [
                [{ text: "🔔 Вимкнути нагадування" }],
                [{ text: "Повернутися в меню" }]
            ]
            : [
                [{ text: "🔊 Увімкнути нагадування" }],
                [{ text: "Повернутися в меню" }]
            ];
        
        bot.sendMessage(chatId, settingsMsg, {
            parse_mode: 'HTML',
            reply_markup: { keyboard: buttons, resize_keyboard: true }
        });
        return;
    }

    // Вмикаємо нагадування
    if (text === "🔊 Увімкнути нагадування") {
        if (!users[chatId]) users[chatId] = { step: 0 };
        users[chatId].remindersEnabled = true;
        
        bot.sendMessage(chatId, 
            "✅ <b>Нагадування увімкнені!</b>\n\n" +
            "Ви будете отримувати сповіщення за 24 години та за 1 годину до кожного заходу.\n\n" +
            "Дякуємо! 🩵", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Нагадування" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // Вимикаємо нагадування
    if (text === "🔔 Вимкнути нагадування") {
        if (!users[chatId]) users[chatId] = { step: 0 };
        users[chatId].remindersEnabled = false;
        
        bot.sendMessage(chatId, 
            "❌ <b>Нагадування вимкнені</b>\n\n" +
            "Ви більше не будете отримувати сповіщення про заходи.\n\n" +
            "Ви можете увімкнути їх в будь-який час через меню «Нагадування». 🩵", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Нагадування" }],
                    [{ text: "Повернутися в меню" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === "Повернутися в меню") {
        if (users[chatId]) {
            delete users[chatId].eventButtonMap;
            delete users[chatId].afishaFullRegistration;
            delete users[chatId].afishaPendingEventId;
            delete users[chatId].afishaPendingEventName;
            delete users[chatId].afishaMultiRegistration;
            delete users[chatId].selectedEventsList;
            delete users[chatId].selectedEventId;
            delete users[chatId].selectedEventName;
            users[chatId].step = 0;
            users[chatId].registrationMode = false;
            users[chatId].context = null;
        }
        bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: [
                    [{ text: "Реєстрація" }],
                    [{ text: "Афіша заходів" }],
                    [{ text: "Нагадування" }],
                    [{ text: "Контакти" }],
                    [{ text: "Назад" }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // === ОБРОБКА ВВЕДЕННЯ USERNAME/ТЕЛЕФОНУ (при реєстрації - step 0) ===
    if (user.step === 0 && user.registrationStarted) {
        const inputText = text.toLowerCase().trim();
        let foundProfile = null;
        
        // Перевіряємо чи це телефон (380...)
        if (inputText.startsWith('380') || inputText.startsWith('+380')) {
            const cleanPhone = inputText.replace('+', '');
            foundProfile = await loadKnownUserByPhone(cleanPhone);
            
            if (foundProfile && foundProfile.name) {
                // Профіль знайдено по телефону — завантажуємо дані
                Object.assign(user, foundProfile);
                user.registeredViaPhone = cleanPhone;
                
                let message = `✅ <b>Профіль завантажено!</b>\n\n`;
                message += `👤 <b>Ім'я:</b> ${foundProfile.name}\n`;
                message += `📱 <b>Телефон:</b> ${foundProfile.phone}\n`;
                message += `🎂 <b>Дата народження:</b> ${foundProfile.birth}\n`;
                message += `🌍 <b>Статус:</b> ${foundProfile.status}\n\n`;
                message += `Тепер ви можете переходити до афіші для вибору заходів!`;
                
                user.step = 0;
                user.registrationStarted = false;
                user.context = 'afisha';
                
                bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Афіша заходів" }],
                            [{ text: "Назад в меню" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            } else {
                // Профіль не знайдено по телефону
                bot.sendMessage(chatId, `❌ Профіль з номером ${cleanPhone} не знайдено.\n\nЗаповніть форму для реєстрації:`, {
                    reply_markup: {
                        keyboard: [
                            [{ text: "Зареєструватись" }],
                            [{ text: "Назад" }]
                        ],
                        resize_keyboard: true
                    }
                });
                user.registeredViaPhone = cleanPhone;
                user.step = 0.5; // Спеціальний крок для введення телефону
                return;
            }
        } else {
            // Це username
            const inputUsername = inputText.replace('@', '');
            foundProfile = await loadKnownUserByUsername(inputUsername);
            
            if (foundProfile && foundProfile.name) {
                // Профіль знайдено по username — завантажуємо дані
                Object.assign(user, foundProfile);
                user.registeredViaUsername = inputUsername;
                
                let message = `✅ <b>Профіль завантажено!</b>\n\n`;
                message += `👤 <b>Ім'я:</b> ${foundProfile.name}\n`;
                message += `📱 <b>Телефон:</b> ${foundProfile.phone}\n`;
                message += `🎂 <b>Дата народження:</b> ${foundProfile.birth}\n`;
                message += `🌍 <b>Статус:</b> ${foundProfile.status}\n\n`;
                message += `Тепер ви можете переходити до афіші для вибору заходів!`;
                
                user.step = 0;
                user.registrationStarted = false;
                user.context = 'afisha';
                
                bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Афіша заходів" }],
                            [{ text: "Назад в меню" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            } else {
                // Username не зареєстрований — зберігаємо і переходимо до step 1 для нової реєстрації
                user.username = inputUsername;
                user.step = 1;
                
                bot.sendMessage(chatId, "✅ Гарно! Це передбачається для нової реєстрації.\n\nРозпочнемо заповнення форми:\n\nПрізвище Ім'я По-батькові");
                return;
            }
        }
    }

    // Обробка кроку 0.5 для нової реєстрації по телефону
    if (user.step === 0.5 && user.registrationStarted && user.registeredViaPhone) {
        if (text === "Зареєструватись") {
            user.phone = user.registeredViaPhone;
            user.step = 1;
            bot.sendMessage(chatId, "Прізвище Ім'я По-батькові");
            return;
        } else if (text === "Назад") {
            delete user.registeredViaPhone;
            user.step = 0;
            user.registrationStarted = false;
            bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
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
    }

    // Якщо натискає "Спробувати інший username"
    if (text === "Спробувати інший username" && user.registrationStarted) {
        user.step = 0;
        bot.sendMessage(chatId, "📱 Введіть ім'я акаунту або номер телефону");
        return;
    }

    // Step 7 больше не используется - регистрация завершается на step 6
    // Обработка "Афіша заходів" остается в основном меню

});

console.log("⏳ Бот ініціалізується. Telegram webhook автоматично встановлюється після підключення до Google Sheets.");
console.log("📋 Розклад:", config.SPREADSHEET_ID);
console.log("👤 Персональні дані:", config.PERSONAL_DATA_SPREADSHEET_ID);
