process.env.TZ = process.env.TZ || 'Europe/Kyiv';

const config = require('./src/config');
require('dotenv').config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { createAuthorizedSheetsClient } = require('./src/sheets/auth');
const { isRegistrationCancelText } = require('./src/utils/registration-flow');
const { buildBeneficiarySummary, parseRegistrantsFromNoteText } = require('./src/utils/beneficiary-summary');
const { hasCompleteRegistrationProfile } = require('./src/utils/profile');
const { shouldSkipAiIntentDetection } = require('./src/utils/intent-detection');
const { createNotificationDeduper } = require('./src/utils/notification-dedup');
const { clearFeedbackFlowState } = require('./src/utils/feedback-state');
const { normalizeSendOptions } = require('./src/utils/telegram-reply-markup');

const TOKEN = process.env.TOKEN || process.env.TELEGRAM_BOT_TOKEN || config.TOKEN;
const PORT = process.env.PORT || 8080;
const GROUP_ID = process.env.GROUP_ID || config.GROUP_ID;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;
const APPEALS_GROUP_ID = Number(process.env.APPEALS_GROUP_ID || config.APPEALS_GROUP_ID || '-1003802751255'); // Група "Відгуки чат-бот Вільна"
globalThis.APPEALS_GROUP_ID = APPEALS_GROUP_ID;
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_API_URL = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_HTTP_TIMEOUT_MS = Number(process.env.AI_HTTP_TIMEOUT_MS || 12000);
const AI_ENABLED = Boolean(AI_API_KEY);
const BROADCAST_OWNER_CHAT_ID = Number(String(process.env.BROADCAST_OWNER_CHAT_ID || process.env.DARYNA_CHAT_ID || config.DARYNA_CHAT_ID || '375328037').trim());
const BROADCAST_ALL_TRIGGER_REGEX = /❗️?|‼️/;
const BROADCAST_TARGETED_TRIGGER_REGEX = /❕/;
const APP_TIME_ZONE = process.env.TZ || 'Europe/Kyiv';
const BENEFICIARY_SUMMARY_STORAGE_PATH = path.join(__dirname, 'data', 'beneficiary-summary-cache.json');
// Захист ідентичності бота: якщо хтось змінить назву/опис через BotFather, бот відновить їх автоматично
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const BOT_DISPLAY_NAME = 'Бот простору Вільна🌷';
const BOT_DESCRIPTION = 'Бот простору «Вільна» — твій помічник для реєстрації на заходи, перегляду афіші та отримання актуальної інформації про події простору.';
const BOT_SHORT_DESCRIPTION = process.env.BOT_SHORT_DESCRIPTION || 'Анонси заходів, реєстрація та підтримка Простору Вільна';
const logger = require('./src/utils/logging');
// redirect console calls to logger for unified logging
console.log = (...args) => logger.info(...args);
console.info = (...args) => logger.info(...args);
console.warn = (...args) => logger.warn(...args);
console.error = (...args) => logger.error(...args);
console.debug = (...args) => logger.info(...args);
const REMINDER_DELIVERY_WINDOW_MINUTES = 10;
const REMINDER_SHORT_WINDOW_MINUTES = 1;
const REMINDER_24H_HOURS_MIN = 1;
const REMINDER_24H_HOURS_MAX = 24;
const REMINDER_1H_MINUTES_MIN = 1;
const REMINDER_1H_MINUTES_MAX = 60;
const PENDING_REGISTRATION_REMINDER_TIMEOUT_MS = 5 * 60 * 1000;
const REGISTRATION_NOTIFICATION_COOLDOWN_MS = Number(process.env.REGISTRATION_NOTIFICATION_COOLDOWN_MS || 30000);
// Таблиця для розкладу та реєстрацій на заходи
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || config.SPREADSHEET_ID;
const SCHEDULE_SHEET_NAME = process.env.SCHEDULE_SHEET_NAME || config.SCHEDULE_SHEET_NAME;
// Таблиця для персональних даних (ПІБ, телефон тощо)
const PERSONAL_DATA_SPREADSHEET_ID = process.env.PERSONAL_DATA_SPREADSHEET_ID || config.PERSONAL_DATA_SPREADSHEET_ID;
const PERSONAL_DATA_SHEET_NAME = process.env.PERSONAL_DATA_SHEET_NAME || config.PERSONAL_DATA_SHEET_NAME;
const REGISTRATIONS_SHEET_NAME = process.env.REGISTRATIONS_SHEET_NAME || config.REGISTRATIONS_SHEET_NAME || PERSONAL_DATA_SHEET_NAME;
const SOCIAL_CONSULTATIONS_SHEET_NAME = process.env.SOCIAL_CONSULTATIONS_SHEET_NAME || config.SOCIAL_CONSULTATIONS_SHEET_NAME || 'Соц';
const PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME = process.env.PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME || config.PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME || 'Псих';
const SOCIAL_SPECIALIST_CHAT_ID = process.env.SOCIAL_SPECIALIST_CHAT_ID || config.SOCIAL_SPECIALIST_CHAT_ID || '';
const DARYNA_CHAT_ID = process.env.DARYNA_CHAT_ID || config.DARYNA_CHAT_ID || '375328037';
const PSYCHOLOGIST_CHAT_ID = process.env.PSYCHOLOGIST_CHAT_ID || config.PSYCHOLOGIST_CHAT_ID || '';
const LIUDMYLA_CHAT_ID = process.env.LIUDMYLA_CHAT_ID || config.LIUDMYLA_CHAT_ID || '677175948';
const SCHEDULE_SHEET_CANDIDATES = [SCHEDULE_SHEET_NAME, "Заходи"];
const ADMIN_CHAT_IDS = Array.from(new Set([
    Number(String(BROADCAST_OWNER_CHAT_ID || '').trim()),
    Number(String(DARYNA_CHAT_ID || '').trim())
].filter((id) => Number.isFinite(id))));

// Таблиця розкладу: https://docs.google.com/spreadsheets/d/1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8/edit
// Таблиця персональних даних: https://docs.google.com/spreadsheets/d/1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE/edit


if (!SPREADSHEET_ID) {
    console.log("SPREADSHEET_ID не встановлений");
}
console.log("📋 Таблиця розкладу (тільки читання):", SPREADSHEET_ID);
console.log("📄 Аркуш розкладу:", SCHEDULE_SHEET_NAME);
console.log("👤 Таблиця персональних даних (запис ПІБ + всі реєстрації):", PERSONAL_DATA_SPREADSHEET_ID);
console.log("📄 Аркуш персональних даних:", PERSONAL_DATA_SHEET_NAME);
console.log("🗂️ Аркуш консультацій (Соц):", SOCIAL_CONSULTATIONS_SHEET_NAME);
console.log("🗂️ Аркуш консультацій (Псих):", PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME);
console.log("🕐 Часова зона бота:", APP_TIME_ZONE);
console.log(`🧠 AI режим: ${AI_ENABLED ? `увімкнено (${AI_MODEL})` : 'вимкнено (не задано AI_API_KEY)'}`);
console.log(`[BOOTCHECK] APPEALS_GROUP_ID=${APPEALS_GROUP_ID}`);

if (!TOKEN) {
    console.error("TOKEN не встановлено");
    process.exit(1);
}

// Express сервер для webhook
const app = express();
app.use(express.json());

// Telegram бот з polling режимом
const bot = new TelegramBot(TOKEN, { polling: true });
const originalSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = function (...args) {
    if (args.length === 0) {
        return originalSendMessage(...args);
    }

    const [chatId, text, options, ...rest] = args;
    if (args.length >= 2 && (options === undefined || options === null || typeof options === 'object')) {
        const normalizedOptions = normalizeSendOptions(options);
        return originalSendMessage(chatId, text, normalizedOptions, ...rest);
    }

    return originalSendMessage(...args);
};
let stoppingBecauseOfPollingConflict = false;

async function configureBotCommandMenus() {
    try {
        const userCommands = [
            { command: 'start', description: 'Почати роботу' }
        ];

        await bot.setMyCommands(userCommands);

        const adminCommands = [
            ...userCommands,
            { command: 'add_event', description: 'Додати захід у розклад' }
        ];

        for (const adminChatId of ADMIN_CHAT_IDS) {
            await bot.setMyCommands(adminCommands, {
                scope: {
                    type: 'chat',
                    chat_id: adminChatId
                }
            });
        }
    } catch (error) {
        console.warn('⚠️ Не вдалося налаштувати меню команд Telegram:', error && error.message ? error.message : error);
    }
}

configureBotCommandMenus();

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

// Recent actions for simple undo (keyed by chatId)
const recentActions = new Map();
function recordRecentAction(chatId, action) {
    try {
        if (!chatId) return;
        recentActions.set(String(chatId), { action, ts: Date.now() });
        logger.info('Recorded recent action for undo', chatId, action && action.type ? action.type : '');
    } catch (e) {
        logger.warn('Failed to record recent action', e && e.message ? e.message : e);
    }
}

async function performUndoForChat(chatId, fallbackEventId = '') {
    const entry = recentActions.get(String(chatId));
    const a = entry && entry.action ? entry.action : null;
    try {
        if (a && a.type === 'register') {
            // attempt to unregister the user from the event
            const evId = a.eventId;
            const res = await unregisterFromEvent(chatId, evId);
            if (res && res.status === 'ok') {
                recentActions.delete(String(chatId));
                return { ok: true };
            }
            return { ok: false, reason: 'unregister-failed' };
        }
        if (a && a.type === 'reserve') {
            const evId = a.eventId;
            const res = await unregisterFromReserve(chatId, evId);
            if (res && res.status === 'ok') {
                recentActions.delete(String(chatId));
                return { ok: true };
            }
            return { ok: false, reason: 'unreserve-failed' };
        }

        // Fallback for callback button: try by explicit eventId even without recent action.
        const explicitEventId = String(fallbackEventId || '').trim();
        if (explicitEventId) {
            let res = await unregisterFromEvent(chatId, explicitEventId);
            if (!res || res.status !== 'ok') {
                res = await unregisterFromReserve(chatId, explicitEventId);
            }
            if (res && res.status === 'ok') {
                recentActions.delete(String(chatId));
                return { ok: true };
            }
        }
    } catch (err) {
        logger.error('Undo action failed', err && err.message ? err.message : err);
        return { ok: false, reason: 'error' };
    }
    return { ok: false, reason: 'unsupported' };
}

bot.on('callback_query', async (callbackQuery) => {
    try {
        const data = String(callbackQuery.data || '');
        const chatId = callbackQuery.from && callbackQuery.from.id;
        if (data.startsWith('UNDO_REGISTER:')) {
            const eventId = data.split(':')[1];
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Виконується відміна...' });
            const undoRes = await performUndoForChat(chatId, eventId);
            if (undoRes.ok) {
                await bot.sendMessage(chatId, '✅ Реєстрацію скасовано.');
            } else {
                await bot.sendMessage(chatId, '❌ Не вдалося скасувати реєстрацію.');
            }
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Невідома дія' });
        }
    } catch (err) {
        logger.error('callback_query handler error', err && err.message ? err.message : err);
    }
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

if (SOCIAL_SPECIALIST_CHAT_ID) {
    console.log(`✅ SOCIAL_SPECIALIST_CHAT_ID встановлено: ${SOCIAL_SPECIALIST_CHAT_ID} (для таблиці)`);
} else {
    console.log('⚠️ SOCIAL_SPECIALIST_CHAT_ID не встановлено');
}

if (DARYNA_CHAT_ID) {
    console.log(`✅ DARYNA_CHAT_ID встановлено: ${DARYNA_CHAT_ID} (для DM сповіщень)`);
} else {
    console.log('⚠️ DARYNA_CHAT_ID не встановлено (сповіщення соцфахівчині вимкнені)');
}

if (PSYCHOLOGIST_CHAT_ID) {
    console.log(`✅ PSYCHOLOGIST_CHAT_ID встановлено: ${PSYCHOLOGIST_CHAT_ID} (для таблиці)`);
} else {
    console.log('⚠️ PSYCHOLOGIST_CHAT_ID не встановлено');
}

if (LIUDMYLA_CHAT_ID) {
    console.log(`✅ LIUDMYLA_CHAT_ID встановлено: ${LIUDMYLA_CHAT_ID} (для DM сповіщень психологині)`);
} else {
    console.log('⚠️ LIUDMYLA_CHAT_ID не встановлено (сповіщення психологині вимкнені)');
}

let users = {};
let knownUsers = {}; // Кеш з персональними даними користувачів (ім'я, телефон)
let appealMessagesMap = {}; // Мапа: message_id звернення в групі → chatId користувача
let events = []; // масив для зберігання заходів
let userEventRegistrations = {}; // Мапа: chatId → [{eventId, eventName, eventDate, reminded24h: false, reminded1h: false}]
let friendEventRegistrations = {}; // Мапа: chatId → [{registrationKey, eventId, eventName, eventDate, registrantName, registrantPhone}]
let userEventReserveRegistrations = {}; // Мапа: chatId → [{eventId, eventName, eventDate, registrantName, registrantPhone}]
let friendEventReserveRegistrations = {}; // Мапа: chatId → [{registrationKey, eventId, eventName, eventDate, registrantName, registrantPhone}]
let lastWeeklyScheduleNotesCleanupKey = null;
const REMINDER_RESTORE_CACHE_MS = 60 * 1000;
const reminderRestoreInFlight = new Map();
const REMINDERS_STATE_PATH = process.env.REMINDERS_STATE_PATH || path.join(__dirname, 'data', 'reminders-state.json');
const SEEN_USERS_PATH = process.env.SEEN_USERS_PATH || path.join(__dirname, 'data', 'seen-users.json');
const REMINDERS_STATE_META_KEY = '_meta';
const FEEDBACK_PROMPT_HOUR = 19;
const FEEDBACK_PROMPT_MINUTE = 0;
const FEEDBACK_HISTORY_DAYS_TO_KEEP = 30;
const MANUAL_NOTE_CONFIRMATION_DELAY_MS = Number(process.env.MANUAL_NOTE_CONFIRMATION_DELAY_MS || 15000);
const FEEDBACK_BUTTON_YES = '✅ Так, залишити відгук';
const FEEDBACK_BUTTON_NO = '❌ Ні, дякую';

let seenChatIds = new Set();
let dailyFeedbackCandidatesByDate = {};
let feedbackRequestStatusByDate = {};
const pendingManualNoteConfirmationTimers = new Map();

function createDefaultReminderSettings(enabled = true) {
    return {
        enabled,
        reminder24h: {
            enabled,
            hoursBefore: 24
        },
        reminder1h: {
            enabled,
            minutesBefore: 60
        }
    };
}

function normalizeReminderSettings(rawUser) {
    const defaults = createDefaultReminderSettings();
    const rawSettings = rawUser && rawUser.reminderSettings ? rawUser.reminderSettings : {};
    const globalEnabled = rawSettings.enabled !== undefined
        ? rawSettings.enabled !== false
        : rawUser && rawUser.remindersEnabled === false
            ? false
            : defaults.enabled;

    const reminder24hRaw = rawSettings.reminder24h || {};
    const reminder1hRaw = rawSettings.reminder1h || {};

    const reminder24hHours = Number.isInteger(reminder24hRaw.hoursBefore)
        ? reminder24hRaw.hoursBefore
        : Number.isInteger(rawSettings.reminder24hHoursBefore)
            ? rawSettings.reminder24hHoursBefore
            : defaults.reminder24h.hoursBefore;
    const reminder1hMinutes = Number.isInteger(reminder1hRaw.minutesBefore)
        ? reminder1hRaw.minutesBefore
        : Number.isInteger(rawSettings.reminder1hMinutesBefore)
            ? rawSettings.reminder1hMinutesBefore
            : Number.isInteger(reminder1hRaw.hoursBefore)
                ? reminder1hRaw.hoursBefore * 60
                : Number.isInteger(rawSettings.reminder1hHoursBefore)
                    ? rawSettings.reminder1hHoursBefore * 60
                    : defaults.reminder1h.minutesBefore;

    return {
        enabled: globalEnabled,
        reminder24h: {
            enabled: reminder24hRaw.enabled !== undefined
                ? reminder24hRaw.enabled !== false
                : rawSettings.reminder24hEnabled !== undefined
                    ? rawSettings.reminder24hEnabled !== false
                    : defaults.reminder24h.enabled,
            hoursBefore: Math.min(REMINDER_24H_HOURS_MAX, Math.max(REMINDER_24H_HOURS_MIN, reminder24hHours))
        },
        reminder1h: {
            enabled: reminder1hRaw.enabled !== undefined
                ? reminder1hRaw.enabled !== false
                : rawSettings.reminder1hEnabled !== undefined
                    ? rawSettings.reminder1hEnabled !== false
                    : defaults.reminder1h.enabled,
            minutesBefore: Math.min(REMINDER_1H_MINUTES_MAX, Math.max(REMINDER_1H_MINUTES_MIN, reminder1hMinutes))
        }
    };
}

function getReminderSettingsForChat(chatId) {
    if (!users[chatId]) {
        users[chatId] = { step: 0 };
    }

    const settings = normalizeReminderSettings(users[chatId]);
    users[chatId].reminderSettings = settings;
    users[chatId].remindersEnabled = settings.enabled;
    return settings;
}

function serializeReminderSettings(settings) {
    return {
        enabled: settings.enabled !== false,
        reminder24h: {
            enabled: settings.reminder24h.enabled !== false,
            hoursBefore: settings.reminder24h.hoursBefore
        },
        reminder1h: {
            enabled: settings.reminder1h.enabled !== false,
            minutesBefore: settings.reminder1h.minutesBefore
        }
    };
}

function hasCustomReminderSettings(settings) {
    const defaults = createDefaultReminderSettings();
    return settings.enabled !== defaults.enabled ||
        settings.reminder24h.enabled !== defaults.reminder24h.enabled ||
        settings.reminder24h.hoursBefore !== defaults.reminder24h.hoursBefore ||
        settings.reminder1h.enabled !== defaults.reminder1h.enabled ||
    settings.reminder1h.minutesBefore !== defaults.reminder1h.minutesBefore;
}

function pluralizeHoursUa(value) {
    const count = Math.abs(Number(value) || 0);
    const mod10 = count % 10;
    const mod100 = count % 100;

    if (mod10 === 1 && mod100 !== 11) {
        return 'годину';
    }
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
        return 'години';
    }
    return 'годин';
}

function formatHoursBeforeLabel(hours) {
    return `${hours} ${pluralizeHoursUa(hours)}`;
}

function pluralizeMinutesUa(value) {
    const count = Math.abs(Number(value) || 0);
    const mod10 = count % 10;
    const mod100 = count % 100;

    if (mod10 === 1 && mod100 !== 11) {
        return 'хвилину';
    }
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
        return 'хвилини';
    }
    return 'хвилин';
}

function formatMinutesBeforeLabel(minutes) {
    return `${minutes} ${pluralizeMinutesUa(minutes)}`;
}

function formatReminderLeadTime(slotKey, value) {
    if (slotKey === 'reminder24h') {
        return formatHoursBeforeLabel(value);
    }
    if (slotKey === 'reminder1h') {
        return formatMinutesBeforeLabel(value);
    }
    return String(value);
}

function getReminderLeadTimeMinutes(slotKey, slotSettings) {
    if (slotKey === 'reminder24h') {
        return slotSettings.hoursBefore * 60;
    }
    if (slotKey === 'reminder1h') {
        return slotSettings.minutesBefore;
    }
    return null;
}

function formatReminderSlotSummary(slotKey, label, slotSettings) {
    const status = slotSettings.enabled ? '✅' : '❌';
    const slotConfig = getReminderSlotConfig(slotKey);
    return `${status} ${label}: за ${formatReminderLeadTime(slotKey, slotSettings[slotConfig.valueKey])}`;
}

function setAllReminderSlotsEnabled(settings, enabled) {
    settings.enabled = enabled;
    settings.reminder24h.enabled = enabled;
    settings.reminder1h.enabled = enabled;
    return settings;
}

function shouldSendReminder(minutesUntilEvent, targetMinutes, deliveryWindowMinutes) {
    return minutesUntilEvent >= targetMinutes - deliveryWindowMinutes &&
        minutesUntilEvent <= targetMinutes + deliveryWindowMinutes;
}

// Deduplicate reminder registrations by event/person identity.
function mergeReminderDuplicates(registrations, isFriend = false) {
    if (!Array.isArray(registrations) || registrations.length === 0) {
        return [];
    }

    const merged = new Map();

    for (const raw of registrations) {
        if (!raw) continue;
        const eventId = String(raw.eventId || '').trim();
        const registrantName = String(raw.registrantName || '').trim();
        const registrantPhone = String(raw.registrantPhone || '').trim();
        const key = `${eventId}|${normalizeRegistrantName(registrantName)}|${normalizeRegistrantPhone(registrantPhone)}`;
        if (!eventId || !key) continue;

        const eventDate = raw.eventDate instanceof Date ? raw.eventDate : new Date(raw.eventDate);
        const current = merged.get(key);

        if (!current) {
            const next = {
                ...raw,
                eventId,
                registrantName,
                registrantPhone,
                eventDate: Number.isNaN(eventDate.getTime()) ? raw.eventDate : eventDate
            };
            if (isFriend) {
                next.registrationKey = String(raw.registrationKey || buildFriendRegistrationKey(eventId, registrantName, registrantPhone));
            } else {
                next.reminded24h = raw.reminded24h === true;
                next.reminded1h = raw.reminded1h === true;
            }
            merged.set(key, next);
            continue;
        }

        const currentDate = current.eventDate instanceof Date ? current.eventDate : new Date(current.eventDate);
        const nextDate = Number.isNaN(eventDate.getTime()) ? null : eventDate;
        const hasBetterDate = nextDate && (Number.isNaN(currentDate.getTime()) || nextDate.getTime() > currentDate.getTime());
        if (hasBetterDate) {
            current.eventDate = nextDate;
        }

        if (!String(current.eventName || '').trim() && String(raw.eventName || '').trim()) {
            current.eventName = String(raw.eventName || '').trim();
        }

        if (!isFriend) {
            current.reminded24h = current.reminded24h === true || raw.reminded24h === true;
            current.reminded1h = current.reminded1h === true || raw.reminded1h === true;
        }
    }

    return Array.from(merged.values());
}

function resolveCurrentEventForReminderRegistration(registration, eventsById, fallbackEvents) {
    if (!registration) {
        return null;
    }

    const directMatch = registration.eventId ? eventsById.get(String(registration.eventId)) : null;
    if (directMatch) {
        return directMatch;
    }

    const registrationName = normalizeTitle(registration.eventName || '');
    if (!registrationName) {
        return null;
    }

    const registrationDate = registration.eventDate instanceof Date
        ? registration.eventDate
        : new Date(registration.eventDate);
    const hasRegistrationDate = registrationDate instanceof Date && !Number.isNaN(registrationDate.getTime());

    let bestMatch = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const event of fallbackEvents) {
        if (!event || !event.date) {
            continue;
        }

        if (normalizeTitle(event.name) !== registrationName) {
            continue;
        }

        const score = hasRegistrationDate
            ? Math.abs(event.date.getTime() - registrationDate.getTime())
            : event.date.getTime();

        if (score < bestScore) {
            bestScore = score;
            bestMatch = event;
        }
    }

    if (!bestMatch) {
        return null;
    }

    // Підбираємо лише найближчий однойменний захід у межах 36 годин,
    // щоб не переприв'язати реєстрацію до іншої дати.
    if (hasRegistrationDate && bestScore > 36 * 60 * 60 * 1000) {
        return null;
    }

    return bestMatch;
}

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
        reminded1h: raw.reminded1h === true,
        manualRegistrationSource: String(raw.manualRegistrationSource || '').trim(),
        manualRegistrationDetectedAt: raw.manualRegistrationDetectedAt ? String(raw.manualRegistrationDetectedAt) : '',
        manualRegistrationConfirmed: raw.manualRegistrationConfirmed === true
    };
}

function normalizeFriendRegistration(raw) {
    if (!raw || !raw.eventId || !raw.eventDate) {
        return null;
    }

    const parsedDate = new Date(raw.eventDate);
    if (Number.isNaN(parsedDate.getTime())) {
        return null;
    }

    const registrantName = String(raw.registrantName || '').trim();
    const registrantPhone = String(raw.registrantPhone || '').trim();

    return {
        registrationKey: String(raw.registrationKey || buildFriendRegistrationKey(raw.eventId, registrantName, registrantPhone)),
        eventId: String(raw.eventId),
        eventName: String(raw.eventName || '').trim(),
        eventDate: parsedDate,
        registrantName,
        registrantPhone
    };
}

function loadSeenUsersFromDisk() {
    try {
        if (!fs.existsSync(SEEN_USERS_PATH)) return;
        const raw = fs.readFileSync(SEEN_USERS_PATH, 'utf8');
        const ids = JSON.parse(raw || '[]');
        if (Array.isArray(ids)) {
            seenChatIds = new Set(ids.map(Number).filter(Boolean));
            console.log(`♻️ Відновлено ${seenChatIds.size} відомих chatId з ${SEEN_USERS_PATH}`);
        }
    } catch (error) {
        console.error(`❌ Не вдалося відновити seen-users (${SEEN_USERS_PATH}):`, error && error.message ? error.message : error);
    }
}

function saveSeenUsersToDisk() {
    try {
        fs.mkdirSync(path.dirname(SEEN_USERS_PATH), { recursive: true });
        fs.writeFileSync(SEEN_USERS_PATH, JSON.stringify(Array.from(seenChatIds)), 'utf8');
    } catch (error) {
        console.error(`❌ Не вдалося зберегти seen-users (${SEEN_USERS_PATH}):`, error && error.message ? error.message : error);
    }
}

function recordSeenChatId(chatId) {
    const numId = parsePositiveChatId(chatId);
    if (!numId || seenChatIds.has(numId)) return;
    seenChatIds.add(numId);
    saveSeenUsersToDisk();
}

function formatDateKeyInAppTimeZone(dateInput) {
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: APP_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

function formatFeedbackDateLabel(dateKey) {
    const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return '';
    }
    return `${match[3]}.${match[2]}.${match[1]}`;
}

function ensureFeedbackDateBucket(dateKey) {
    if (!dateKey) return null;
    if (!dailyFeedbackCandidatesByDate[dateKey]) {
        dailyFeedbackCandidatesByDate[dateKey] = {};
    }
    return dailyFeedbackCandidatesByDate[dateKey];
}

function getFeedbackEventsForChatByDate(chatId, dateKey) {
    const chatKey = String(chatId || '').trim();
    if (!chatKey || !dateKey) return [];
    const dayBucket = dailyFeedbackCandidatesByDate[dateKey] || {};
    const events = dayBucket[chatKey];
    return Array.isArray(events) ? events.filter(Boolean) : [];
}

function recordFeedbackCandidate(chatId, eventDate, eventName) {
    const chatKey = String(chatId || '').trim();
    const dateKey = formatDateKeyInAppTimeZone(eventDate);
    const cleanName = String(eventName || '').trim();
    if (!chatKey || !dateKey || !cleanName) return;

    const dayBucket = ensureFeedbackDateBucket(dateKey);
    if (!dayBucket[chatKey]) {
        dayBucket[chatKey] = [];
    }

    if (!dayBucket[chatKey].includes(cleanName)) {
        dayBucket[chatKey].push(cleanName);
    }
}

function removeFeedbackCandidate(chatId, eventDate, eventName) {
    const chatKey = String(chatId || '').trim();
    const dateKey = formatDateKeyInAppTimeZone(eventDate);
    const cleanName = String(eventName || '').trim();
    if (!chatKey || !dateKey || !cleanName || !dailyFeedbackCandidatesByDate[dateKey]) {
        return;
    }

    const currentEvents = Array.isArray(dailyFeedbackCandidatesByDate[dateKey][chatKey])
        ? dailyFeedbackCandidatesByDate[dateKey][chatKey]
        : [];
    const nextEvents = currentEvents.filter((item) => item !== cleanName);

    if (nextEvents.length > 0) {
        dailyFeedbackCandidatesByDate[dateKey][chatKey] = nextEvents;
    } else {
        delete dailyFeedbackCandidatesByDate[dateKey][chatKey];
    }

    if (Object.keys(dailyFeedbackCandidatesByDate[dateKey]).length === 0) {
        delete dailyFeedbackCandidatesByDate[dateKey];
    }
}

function setFeedbackStatus(chatId, dateKey, status) {
    const chatKey = String(chatId || '').trim();
    if (!chatKey || !dateKey) return;
    if (!feedbackRequestStatusByDate[dateKey]) {
        feedbackRequestStatusByDate[dateKey] = {};
    }
    feedbackRequestStatusByDate[dateKey][chatKey] = status;
}

function getFeedbackStatus(chatId, dateKey) {
    const chatKey = String(chatId || '').trim();
    if (!chatKey || !dateKey) return '';
    return String((feedbackRequestStatusByDate[dateKey] || {})[chatKey] || '');
}

function getPendingFeedbackDateForChat(chatId) {
    const chatKey = String(chatId || '').trim();
    if (!chatKey) return '';

    const sortedDateKeys = Object.keys(feedbackRequestStatusByDate || {}).sort().reverse();
    for (const dateKey of sortedDateKeys) {
        if (feedbackRequestStatusByDate[dateKey] && feedbackRequestStatusByDate[dateKey][chatKey] === 'requested') {
            return dateKey;
        }
    }

    return '';
}

function normalizeFeedbackState() {
    const normalizeEventsByDate = (input) => {
        const result = {};
        for (const [dateKey, byChat] of Object.entries(input || {})) {
            const normalizedDateKey = String(dateKey || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateKey)) continue;
            if (!byChat || typeof byChat !== 'object') continue;

            const bucket = {};
            for (const [chatId, eventNames] of Object.entries(byChat)) {
                const chatKey = String(chatId || '').trim();
                if (!chatKey) continue;
                const names = Array.isArray(eventNames)
                    ? eventNames.map((item) => String(item || '').trim()).filter(Boolean)
                    : [];
                if (names.length > 0) {
                    bucket[chatKey] = Array.from(new Set(names));
                }
            }

            if (Object.keys(bucket).length > 0) {
                result[normalizedDateKey] = bucket;
            }
        }
        return result;
    };

    const normalizeStatusesByDate = (input) => {
        const allowed = new Set(['requested', 'declined', 'submitted']);
        const result = {};

        for (const [dateKey, byChat] of Object.entries(input || {})) {
            const normalizedDateKey = String(dateKey || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateKey)) continue;
            if (!byChat || typeof byChat !== 'object') continue;

            const bucket = {};
            for (const [chatId, status] of Object.entries(byChat)) {
                const chatKey = String(chatId || '').trim();
                const normalizedStatus = String(status || '').trim();
                if (!chatKey || !allowed.has(normalizedStatus)) continue;
                bucket[chatKey] = normalizedStatus;
            }

            if (Object.keys(bucket).length > 0) {
                result[normalizedDateKey] = bucket;
            }
        }

        return result;
    };

    dailyFeedbackCandidatesByDate = normalizeEventsByDate(dailyFeedbackCandidatesByDate);
    feedbackRequestStatusByDate = normalizeStatusesByDate(feedbackRequestStatusByDate);
}

function pruneFeedbackState(referenceDate = new Date()) {
    const startDate = new Date(referenceDate);
    startDate.setDate(startDate.getDate() - FEEDBACK_HISTORY_DAYS_TO_KEEP);
    const oldestAllowedKey = formatDateKeyInAppTimeZone(startDate);
    if (!oldestAllowedKey) return;

    for (const dateKey of Object.keys(dailyFeedbackCandidatesByDate || {})) {
        if (dateKey < oldestAllowedKey) {
            delete dailyFeedbackCandidatesByDate[dateKey];
        }
    }

    for (const dateKey of Object.keys(feedbackRequestStatusByDate || {})) {
        if (dateKey < oldestAllowedKey) {
            delete feedbackRequestStatusByDate[dateKey];
        }
    }
}

function rebuildFeedbackCandidatesFromActiveRegistrations() {
    for (const [chatId, registrations] of Object.entries(userEventRegistrations || {})) {
        for (const registration of registrations || []) {
            if (!registration || !registration.eventDate || !registration.eventName) continue;
            recordFeedbackCandidate(chatId, registration.eventDate, registration.eventName);
        }
    }
}

function getCurrentTimePartsInAppTimeZone(dateInput = new Date()) {
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TIME_ZONE,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    }).formatToParts(date);

    const hour = Number(parts.find((item) => item.type === 'hour')?.value || 0);
    const minute = Number(parts.find((item) => item.type === 'minute')?.value || 0);
    return { hour, minute };
}

function loadReminderStateFromDisk() {
    if (!fs.existsSync(REMINDERS_STATE_PATH)) {
        return;
    }

    try {
        const raw = fs.readFileSync(REMINDERS_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        const meta = parsed && typeof parsed === 'object' ? parsed[REMINDERS_STATE_META_KEY] : null;
        const restored = {};
        const restoredFriendRegistrations = {};
        const now = new Date();

        if (meta && typeof meta === 'object') {
            dailyFeedbackCandidatesByDate = meta.dailyFeedbackCandidatesByDate || {};
            feedbackRequestStatusByDate = meta.feedbackRequestStatusByDate || {};
        }

        normalizeFeedbackState();
        pruneFeedbackState(now);

        for (const chatId of Object.keys(parsed || {})) {
            if (chatId === REMINDERS_STATE_META_KEY) {
                continue;
            }
            const entry = parsed[chatId];
            const rawRegistrations = Array.isArray(entry)
                ? entry
                : Array.isArray(entry && entry.registrations)
                    ? entry.registrations
                    : [];
            const rawFriendRegistrations = Array.isArray(entry && entry.friendRegistrations)
                ? entry.friendRegistrations
                : [];
            const normalized = rawRegistrations
                .map(normalizeReminderRegistration)
                .filter((item) => item && item.eventDate > now);
            const normalizedFriendRegistrations = rawFriendRegistrations
                .map(normalizeFriendRegistration)
                .filter((item) => item && item.eventDate > now);

            if (!users[chatId]) {
                users[chatId] = { step: 0 };
            }

            if (entry && !Array.isArray(entry) && entry.settings) {
                users[chatId].reminderSettings = normalizeReminderSettings({
                    remindersEnabled: users[chatId].remindersEnabled,
                    reminderSettings: entry.settings
                });
                users[chatId].remindersEnabled = users[chatId].reminderSettings.enabled;
            }

            if (normalized.length > 0) {
                restored[String(chatId)] = normalized;
            }

            if (normalizedFriendRegistrations.length > 0) {
                restoredFriendRegistrations[String(chatId)] = normalizedFriendRegistrations;
            }
        }

        userEventRegistrations = restored;
        friendEventRegistrations = restoredFriendRegistrations;
        rebuildFeedbackCandidatesFromActiveRegistrations();
        schedulePendingManualNoteConfirmations();
        const restoredCount = Object.values(userEventRegistrations).reduce((sum, items) => sum + items.length, 0);
        const restoredFriendCount = Object.values(friendEventRegistrations).reduce((sum, items) => sum + items.length, 0);
        console.log(`♻️ Відновлено ${restoredCount} реєстрацій нагадувань та ${restoredFriendCount} реєстрацій подруг з ${REMINDERS_STATE_PATH}`);
    } catch (error) {
        console.error(`❌ Не вдалося відновити стан нагадувань (${REMINDERS_STATE_PATH}):`, error && error.message ? error.message : error);
    }
}

function buildReminderSettingsMessage(chatId, noticeText) {
    const settings = getReminderSettingsForChat(chatId);
    const lines = [];

    if (noticeText) {
        lines.push(noticeText.trim(), '');
    }

    lines.push('⚙️ <b>Налаштування нагадувань про заходи</b>', '');
    lines.push(`Загальний статус: ${settings.enabled ? '✅ увімкнено' : '❌ вимкнено'}`);
    lines.push(formatReminderSlotSummary('reminder24h', 'Нагадування 24 год', settings.reminder24h));
    lines.push(formatReminderSlotSummary('reminder1h', 'Нагадування 1 год', settings.reminder1h));
    lines.push('');
    lines.push(`Нагадування 24 год: від ${REMINDER_24H_HOURS_MIN} до ${REMINDER_24H_HOURS_MAX} годин.`);
    lines.push(`Нагадування 1 год: від ${REMINDER_1H_MINUTES_MIN} до ${REMINDER_1H_MINUTES_MAX} хвилин.`);

    return lines.join('\n');
}

function buildReminderSettingsKeyboard(chatId) {
    const settings = getReminderSettingsForChat(chatId);
    return [
        [{ text: settings.enabled ? '🔕 Вимкнути всі нагадування' : '🔔 Увімкнути всі нагадування' }],
        [
            { text: settings.reminder24h.enabled ? '🔕 Вимкнути 24 год' : '🔔 Увімкнути 24 год' },
            { text: '⏱ Змінити 24 год' }
        ],
        [
            { text: settings.reminder1h.enabled ? '🔕 Вимкнути 1 год' : '🔔 Увімкнути 1 год' },
            { text: '⏱ Змінити 1 год' }
        ],
        [{ text: '⬅️ До нагадувань' }]
    ];
}

async function showReminderSettingsMenu(chatId, noticeText = '') {
    await bot.sendMessage(chatId, buildReminderSettingsMessage(chatId, noticeText), {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: buildReminderSettingsKeyboard(chatId),
            resize_keyboard: true
        }
    });
}

async function showUserRemindersOverview(chatId, user) {
    await restoreUserRegistrationsFromSheet(chatId, user);
    const reminderSettings = getReminderSettingsForChat(chatId);
    const userRegistrations = userEventRegistrations[chatId] || [];

    if (userRegistrations.length === 0) {
        await bot.sendMessage(chatId,
            "📅 У вас немає запланованих заходів.\n\n" +
            "Зареєструйтесь на захід через меню «Афіша заходів», і ми нагадаємо вам про нього! 🩵\n\n" +
            `${reminderSettings.enabled ? '✅' : '❌'} Загальні нагадування\n` +
            `${formatReminderSlotSummary('reminder24h', 'Нагадування 24 год', reminderSettings.reminder24h)}\n` +
            `${formatReminderSlotSummary('reminder1h', 'Нагадування 1 год', reminderSettings.reminder1h)}`, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "⚙️ Налаштування нагадувань" }],
                    [{ text: NAVIGATION_BUTTONS.menu }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    const sortedEvents = [...userRegistrations].sort((a, b) => a.eventDate - b.eventDate);
    let message = "📅 <b>Ваші майбутні заходи:</b>\n\n";

    sortedEvents.forEach((reg, index) => {
        const dateStr = reg.eventDate.toLocaleDateString('uk-UA', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: APP_TIME_ZONE
        });
        const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: APP_TIME_ZONE
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
            message += `   ✅ Нагадування 24 год надіслано\n`;
        }
        if (reg.reminded1h) {
            message += `   ✅ Нагадування 1 год надіслано\n`;
        }
        message += '\n';
    });

    message += "\n🔔 <b>Автоматичні нагадування:</b>\n";
    message += `${reminderSettings.enabled ? '✅' : '❌'} Загальні нагадування\n`;
    message += `• ${formatReminderSlotSummary('reminder24h', 'Нагадування 24 год', reminderSettings.reminder24h)}\n`;
    message += `• ${formatReminderSlotSummary('reminder1h', 'Нагадування 1 год', reminderSettings.reminder1h)}\n\n`;
    message += "Ми обов'язково нагадаємо вам! 🩵";

    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [
                [{ text: "⚙️ Налаштування нагадувань" }],
                [{ text: NAVIGATION_BUTTONS.menu }]
            ],
            resize_keyboard: true
        }
    });
}

function getReminderSlotConfig(slotKey) {
    if (slotKey === 'reminder24h') {
        return {
            field: 'reminded24h',
            label: '24 год',
            valueKey: 'hoursBefore',
            minValue: REMINDER_24H_HOURS_MIN,
            maxValue: REMINDER_24H_HOURS_MAX,
            inputUnitLabel: 'годинах',
            deliveryWindowMinutes: REMINDER_DELIVERY_WINDOW_MINUTES
        };
    }
    if (slotKey === 'reminder1h') {
        return {
            field: 'reminded1h',
            label: '1 год',
            valueKey: 'minutesBefore',
            minValue: REMINDER_1H_MINUTES_MIN,
            maxValue: REMINDER_1H_MINUTES_MAX,
            inputUnitLabel: 'хвилинах',
            deliveryWindowMinutes: REMINDER_SHORT_WINDOW_MINUTES
        };
    }
    return null;
}

function saveReminderStateToDisk() {
    try {
        normalizeFeedbackState();
        pruneFeedbackState(new Date());

        const payload = {};
        const chatIds = new Set([
            ...Object.keys(userEventRegistrations || {}),
            ...Object.keys(friendEventRegistrations || {}),
            ...Object.keys(users || {})
        ]);

        for (const chatId of chatIds) {
            const registrations = Array.isArray(userEventRegistrations[chatId])
                ? userEventRegistrations[chatId]
                : [];
            const friendRegistrations = Array.isArray(friendEventRegistrations[chatId])
                ? friendEventRegistrations[chatId]
                : [];
            const serializedRegistrations = registrations
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
                        reminded1h: registration.reminded1h === true,
                        manualRegistrationSource: String(registration.manualRegistrationSource || ''),
                        manualRegistrationDetectedAt: registration.manualRegistrationDetectedAt
                            ? String(registration.manualRegistrationDetectedAt)
                            : '',
                        manualRegistrationConfirmed: registration.manualRegistrationConfirmed === true
                    };
                })
                .filter(Boolean);
            const serializedFriendRegistrations = friendRegistrations
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

                    const registrationKey = String(
                        registration.registrationKey || buildFriendRegistrationKey(
                            registration.eventId,
                            registration.registrantName,
                            registration.registrantPhone
                        )
                    );

                    return {
                        registrationKey,
                        eventId: String(registration.eventId || ''),
                        eventName: String(registration.eventName || ''),
                        eventDate: date.toISOString(),
                        registrantName: String(registration.registrantName || ''),
                        registrantPhone: String(registration.registrantPhone || '')
                    };
                })
                .filter(Boolean);

            const userSettings = users[chatId]
                ? normalizeReminderSettings(users[chatId])
                : createDefaultReminderSettings();
            const shouldPersistSettings = users[chatId] && hasCustomReminderSettings(userSettings);

            if (serializedRegistrations.length === 0 && serializedFriendRegistrations.length === 0 && !shouldPersistSettings) {
                continue;
            }

            payload[chatId] = {
                registrations: serializedRegistrations,
                friendRegistrations: serializedFriendRegistrations,
                settings: serializeReminderSettings(userSettings)
            };
        }

        const hasFeedbackCandidates = Object.keys(dailyFeedbackCandidatesByDate || {}).length > 0;
        const hasFeedbackStatuses = Object.keys(feedbackRequestStatusByDate || {}).length > 0;
        if (hasFeedbackCandidates || hasFeedbackStatuses) {
            payload[REMINDERS_STATE_META_KEY] = {
                dailyFeedbackCandidatesByDate,
                feedbackRequestStatusByDate
            };
        }

        fs.mkdirSync(path.dirname(REMINDERS_STATE_PATH), { recursive: true });
        fs.writeFileSync(REMINDERS_STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error(`❌ Не вдалося зберегти стан нагадувань (${REMINDERS_STATE_PATH}):`, error && error.message ? error.message : error);
    }
}

loadReminderStateFromDisk();
loadSeenUsersFromDisk();

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

function normalizeCommandText(text) {
    return normalizeText(String(text || ''))
        .replace(/[^ -\p{L}\p{N}'\s]/gu, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeUaPhoneForRegistration(input) {
    const digits = String(input || '').replace(/\D/g, '');
    if (!digits) return null;

    let normalized = digits;

    if (digits.startsWith('380') && digits.length === 12) {
        normalized = digits;
    } else if (digits.startsWith('0') && digits.length === 10) {
        normalized = `38${digits}`;
    } else if (digits.startsWith('80') && digits.length === 11) {
        normalized = `3${digits}`;
    } else if (digits.length === 10) {
        normalized = `38${digits}`;
    } else if (digits.length === 9) {
        normalized = `380${digits}`;
    }

    return /^380\d{9}$/.test(normalized) ? normalized : null;
}

function normalizeBirthDateStrict(input) {
    const raw = String(input || '').trim();
    const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(year, month - 1, day);

    const isValidDate = date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day;

    if (!isValidDate) return null;

    return `${match[1]}.${match[2]}.${match[3]}`;
}

function isLikelyInvalidRegistrantName(value) {
    const normalized = normalizeCommandText(String(value || ''));
    if (!normalized) return true;

    const blockedPhrases = [
        normalizeCommandText(MAIN_MENU_BUTTONS.afisha),
        normalizeCommandText(MAIN_MENU_BUTTONS.contacts),
        normalizeCommandText(MAIN_MENU_BUTTONS.reminders),
        normalizeCommandText(NAVIGATION_BUTTONS.menu),
        normalizeCommandText('афіша заходів'),
        normalizeCommandText('меню')
    ];

    if (blockedPhrases.includes(normalized)) {
        return true;
    }

    const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
    return tokens.length < 2;
}

function matchesCommand(text, ...variants) {
    const normalizedText = normalizeCommandText(text);
    return variants.some((variant) => normalizeCommandText(variant) === normalizedText);
}

const MAIN_MENU_BUTTONS = {
    afisha: '🎭 Афіша заходів',
    unsubscribe: '❌ Відписатись від заходів',
    friend: '👭 Зареєструвати подругу',
    unsubscribeFriend: '👭❌ Відписати подругу',
    editProfile: '✏️ Редагувати профіль',
    consultations: '🗨️ Індивідуальні консультації',
    violenceHelp: '🚨 Допомога при насильстві',
    reminders: '🔔 Нагадування',
    contacts: '📞 Контакти'
};

const NAVIGATION_BUTTONS = {
    menu: '🏠 Повернутися в меню',
    back: '⬅️ Назад',
    backToDays: '💞 Назад до вибору днів'
};

const UNSUBSCRIBE_MENU_BUTTONS = {
    self: '❌ Відписатись',
    friend: '👭❌ Відписати подругу',
    consultation: '🗨️❌ Відписатись від консультації'
};

const FRIEND_FLOW_BUTTONS = {
    addAnother: '👭 Зареєструвати ще подругу'
};

const PROFILE_EDIT_BUTTONS = {
    changeName: '✏️ Змінити ПІБ',
    changePhone: '📱 Змінити телефон'
};

const AFISHA_ACTION_BUTTONS = {
    reserve: '🕓 Записатись в резерв'
};

const AFISHA_DAY_BUTTONS = {
    monday: '🩵 Понеділок',
    tuesday: '🩷 Вівторок',
    wednesday: '💜 Середа',
    thursday: '💙 Четвер',
    friday: "💚 П'ятниця",
    saturday: '💛 Субота',
    sunday: '❤️ Неділя'
};

const WEEKDAY_INDEX_BY_NAME = {
    'неділя': 0,
    'понеділок': 1,
    'вівторок': 2,
    'середа': 3,
    'четвер': 4,
    "п'ятниця": 5,
    'субота': 6
};

const WEEKDAY_LABEL_FOR_INDEX = {
    0: AFISHA_DAY_BUTTONS.sunday,
    1: AFISHA_DAY_BUTTONS.monday,
    2: AFISHA_DAY_BUTTONS.tuesday,
    3: AFISHA_DAY_BUTTONS.wednesday,
    4: AFISHA_DAY_BUTTONS.thursday,
    5: AFISHA_DAY_BUTTONS.friday,
    6: AFISHA_DAY_BUTTONS.saturday
};

const CONSULTATION_SPECIALIST_BUTTONS = {
    social: '👩🏻🌷 Соціальна фахівчиня',
    psychologist: '👩🏻🌹 Психологиня'
};

const VIOLENCE_HELP_BUTTONS = {
    urgentNow: '⚡ Я в небезпеці зараз',
    hotlines: '☎️ Гарячі лінії та телефони довіри',
    police: '👮 Поліція',
    specializedServices: '🛑 Спеціалізовані служби',
    socialPsychologicalHelp: '💛 Соціально-психологічна допомога',
    coordinationAdministrativeHelp: '🧭 Координація та адміністративна допомога',
    legalHelp: '⚖️ Правова допомога',
    medicalHelp: '🏥 Медична допомога'
};

const VIOLENCE_HELP_DISTRICT_BUTTONS = {
    dnipro: '🏙 Дніпровський район',
    kryvyiRih: '🏭 Криворізький район',
    kamianske: '🏢 Кам\'янський район',
    samar: '🌾 Самарівський район',
    pavlohrad: '🏘 Павлоградський район',
    nikopol: '🌊 Нікопольський район',
    synelnykove: '🌻 Синельниківський район'
};

const VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS = {
    mobileBrigades: '🚗 Мобільні бригади',
    consultativeServices: '💬 Консультативні служби',
    dayCenters: '🏠 Денні центри та кризові кімнати',
    shelters: '🛏 Притулки'
};

const VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS = {
    regional: '🟡 Дніпропетровський обласний рівень',
    dnipro: VIOLENCE_HELP_DISTRICT_BUTTONS.dnipro,
    kamianske: VIOLENCE_HELP_DISTRICT_BUTTONS.kamianske,
    kryvyiRih: VIOLENCE_HELP_DISTRICT_BUTTONS.kryvyiRih,
    pavlohrad: VIOLENCE_HELP_DISTRICT_BUTTONS.pavlohrad
};

const CONSULTATION_WEEKDAY_LABELS = {
    0: 'неділя',
    1: 'понеділок',
    2: 'вівторок',
    3: 'середа',
    4: 'четвер',
    5: "п'ятниця",
    6: 'субота'
};

const CONSULTATION_WEEKDAY_EMOJI = {
    0: '❤️',
    1: '🩵',
    2: '🩷',
    3: '💜',
    4: '💙',
    5: '💚',
    6: '💛'
};

const CONSULTATION_ALLOWED_WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

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
    // Автоочищення вимкнено на запит: записи видаляються тільки вручну.
    return;
}

function syncReminderRegistrationsWithEvents() {
    const allEvents = getAllEvents();
    const eventsById = new Map(allEvents.map((event) => [event.id, event]));
    let hasReminderChanges = false;

    for (const chatId in userEventRegistrations) {
        const registrations = Array.isArray(userEventRegistrations[chatId]) ? userEventRegistrations[chatId] : [];
        if (!Array.isArray(registrations) || registrations.length === 0) {
            continue;
        }

        for (const registration of registrations) {
            const actualEvent = resolveCurrentEventForReminderRegistration(registration, eventsById, allEvents);
            if (!actualEvent || !actualEvent.date) {
                continue;
            }

            if (registration.eventId !== actualEvent.id) {
                registration.eventId = actualEvent.id;
                hasReminderChanges = true;
            }

            if (String(registration.eventName || '').trim() !== String(actualEvent.name || '').trim()) {
                registration.eventName = actualEvent.name;
                hasReminderChanges = true;
            }

            const registrationTime = registration.eventDate instanceof Date
                ? registration.eventDate.getTime()
                : new Date(registration.eventDate).getTime();
            const actualTime = actualEvent.date.getTime();

            if (!Number.isFinite(registrationTime) || registrationTime !== actualTime) {
                registration.eventDate = actualEvent.date;
                registration.reminded24h = false;
                registration.reminded1h = false;
                hasReminderChanges = true;
            }
        }

        const beforeLength = registrations.length;
        const deduped = mergeReminderDuplicates(registrations, false).filter((item) => {
            const dt = item && item.eventDate instanceof Date ? item.eventDate : new Date(item && item.eventDate);
            return dt instanceof Date && !Number.isNaN(dt.getTime());
        });

        if (deduped.length !== beforeLength) {
            hasReminderChanges = true;
        }

        if (deduped.length > 0) {
            userEventRegistrations[chatId] = deduped;
        } else {
            delete userEventRegistrations[chatId];
        }
    }

    for (const chatId in friendEventRegistrations) {
        const registrations = Array.isArray(friendEventRegistrations[chatId]) ? friendEventRegistrations[chatId] : [];
        if (registrations.length === 0) {
            continue;
        }

        for (const registration of registrations) {
            const actualEvent = resolveCurrentEventForReminderRegistration(registration, eventsById, allEvents);
            if (!actualEvent || !actualEvent.date) {
                continue;
            }

            if (registration.eventId !== actualEvent.id) {
                registration.eventId = actualEvent.id;
                hasReminderChanges = true;
            }

            if (String(registration.eventName || '').trim() !== String(actualEvent.name || '').trim()) {
                registration.eventName = actualEvent.name;
                hasReminderChanges = true;
            }

            const registrationTime = registration.eventDate instanceof Date
                ? registration.eventDate.getTime()
                : new Date(registration.eventDate).getTime();
            const actualTime = actualEvent.date.getTime();

            if (!Number.isFinite(registrationTime) || registrationTime !== actualTime) {
                registration.eventDate = actualEvent.date;
                hasReminderChanges = true;
            }

            registration.registrationKey = buildFriendRegistrationKey(registration.eventId, registration.registrantName, registration.registrantPhone);
        }

        const beforeLength = registrations.length;
        const deduped = mergeReminderDuplicates(registrations, true).filter((item) => {
            const dt = item && item.eventDate instanceof Date ? item.eventDate : new Date(item && item.eventDate);
            return dt instanceof Date && !Number.isNaN(dt.getTime());
        });

        if (deduped.length !== beforeLength) {
            hasReminderChanges = true;
        }

        if (deduped.length > 0) {
            friendEventRegistrations[chatId] = deduped;
        } else {
            delete friendEventRegistrations[chatId];
        }
    }

    if (hasReminderChanges) {
        saveReminderStateToDisk();
        console.log('♻️ Оновлено збережені нагадування відповідно до актуального розкладу');
    }
}

function normalizeEventTitleForScheduleDiff(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-zа-яіїєґ0-9\s]/giu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getScheduleEventSourceKey(event) {
    const sheetName = String(event && event.scheduleSheetName || '').trim();
    const rowNumber = Number(event && event.scheduleRowNumber);

    if (!sheetName || !Number.isInteger(rowNumber) || rowNumber <= 0) {
        return '';
    }

    return `${sheetName}:${rowNumber}`;
}

function buildLikelyEditedEventMap(previousEvents, currentEvents) {
    const mapping = new Map();
    const currentById = new Map((currentEvents || []).map((event) => [event.id, event]));
    const currentBySourceKey = new Map();
    const unmatchedCurrent = new Map();

    for (const event of currentEvents || []) {
        unmatchedCurrent.set(event.id, event);

        const sourceKey = getScheduleEventSourceKey(event);
        if (sourceKey) {
            currentBySourceKey.set(sourceKey, event);
        }
    }

    for (const prevEvent of previousEvents || []) {
        const sourceKey = getScheduleEventSourceKey(prevEvent);
        const sourceMatch = sourceKey ? currentBySourceKey.get(sourceKey) : null;
        if (sourceMatch) {
            mapping.set(prevEvent.id, sourceMatch);
            unmatchedCurrent.delete(sourceMatch.id);
            currentBySourceKey.delete(sourceKey);
            continue;
        }

        const exactMatch = currentById.get(prevEvent && prevEvent.id);
        if (!exactMatch) {
            continue;
        }
        mapping.set(prevEvent.id, exactMatch);
        unmatchedCurrent.delete(exactMatch.id);
    }

    const titleBuckets = new Map();
    for (const event of unmatchedCurrent.values()) {
        const titleKey = normalizeEventTitleForScheduleDiff(event && event.name);
        if (!titleKey) {
            continue;
        }
        if (!titleBuckets.has(titleKey)) {
            titleBuckets.set(titleKey, []);
        }
        titleBuckets.get(titleKey).push(event);
    }

    for (const prevEvent of previousEvents || []) {
        if (!prevEvent || mapping.has(prevEvent.id)) {
            continue;
        }

        const titleKey = normalizeEventTitleForScheduleDiff(prevEvent.name);
        if (!titleKey) {
            continue;
        }

        const candidates = titleBuckets.get(titleKey) || [];
        if (candidates.length === 0) {
            continue;
        }

        let bestIndex = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        const prevTime = prevEvent.date instanceof Date ? prevEvent.date.getTime() : Number.NaN;

        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            const candidateTime = candidate && candidate.date instanceof Date ? candidate.date.getTime() : Number.NaN;
            const score = Number.isFinite(prevTime) && Number.isFinite(candidateTime)
                ? Math.abs(candidateTime - prevTime)
                : 0;
            if (score < bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        const [matchedEvent] = candidates.splice(bestIndex, 1);
        if (matchedEvent) {
            mapping.set(prevEvent.id, matchedEvent);
            if (candidates.length === 0) {
                titleBuckets.delete(titleKey);
            }
            unmatchedCurrent.delete(matchedEvent.id);
        }
    }

    // Останній fallback: якщо адмін одночасно змінив рядок, назву та час,
    // пробуємо зіставити за найближчим часом у межах доби.
    for (const prevEvent of previousEvents || []) {
        if (!prevEvent || mapping.has(prevEvent.id) || !(prevEvent.date instanceof Date)) {
            continue;
        }

        let bestCandidate = null;
        let bestScore = Number.POSITIVE_INFINITY;
        const prevTime = prevEvent.date.getTime();

        for (const candidate of unmatchedCurrent.values()) {
            if (!candidate || !(candidate.date instanceof Date)) {
                continue;
            }

            const sameYear = candidate.date.getFullYear() === prevEvent.date.getFullYear();
            const sameMonth = candidate.date.getMonth() === prevEvent.date.getMonth();
            const sameDay = candidate.date.getDate() === prevEvent.date.getDate();
            if (!(sameYear && sameMonth && sameDay)) {
                continue;
            }

            const score = Math.abs(candidate.date.getTime() - prevTime);
            if (score < bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        if (bestCandidate && bestScore <= 12 * 60 * 60 * 1000) {
            mapping.set(prevEvent.id, bestCandidate);
            unmatchedCurrent.delete(bestCandidate.id);
        }
    }

    return mapping;
}

function remapReminderRegistrationsToUpdatedEvents(eventMap) {
    if (!eventMap || eventMap.size === 0) {
        return;
    }

    let hasReminderChanges = false;

    const applyMapping = (registrations) => {
        if (!Array.isArray(registrations) || registrations.length === 0) {
            return;
        }

        for (const registration of registrations) {
            if (!registration || !registration.eventId) {
                continue;
            }

            const mappedEvent = eventMap.get(registration.eventId);
            if (!mappedEvent || !mappedEvent.date) {
                continue;
            }

            if (registration.eventId !== mappedEvent.id) {
                registration.eventId = mappedEvent.id;
                hasReminderChanges = true;
            }

            if (String(registration.eventName || '').trim() !== String(mappedEvent.name || '').trim()) {
                registration.eventName = mappedEvent.name;
                hasReminderChanges = true;
            }

            const regDateTime = registration.eventDate instanceof Date
                ? registration.eventDate.getTime()
                : new Date(registration.eventDate).getTime();
            const mappedTime = mappedEvent.date.getTime();

            if (regDateTime !== mappedTime) {
                registration.eventDate = mappedEvent.date;
                if (Object.prototype.hasOwnProperty.call(registration, 'reminded24h')) {
                    registration.reminded24h = false;
                }
                if (Object.prototype.hasOwnProperty.call(registration, 'reminded1h')) {
                    registration.reminded1h = false;
                }
                hasReminderChanges = true;
            }
        }
    };

    for (const chatId in userEventRegistrations) {
        applyMapping(userEventRegistrations[chatId]);
        userEventRegistrations[chatId] = mergeReminderDuplicates(userEventRegistrations[chatId], false);
    }

    for (const chatId in friendEventRegistrations) {
        applyMapping(friendEventRegistrations[chatId]);
        for (const registration of friendEventRegistrations[chatId] || []) {
            registration.registrationKey = buildFriendRegistrationKey(registration.eventId, registration.registrantName, registration.registrantPhone);
        }
        friendEventRegistrations[chatId] = mergeReminderDuplicates(friendEventRegistrations[chatId], true);
    }

    if (hasReminderChanges) {
        saveReminderStateToDisk();
        console.log('♻️ Синхронізовано реєстрації після редагування розкладу');
    }
}

function formatEventTimeForUpdateNotice(eventDate) {
    return eventDate.toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: APP_TIME_ZONE
    });
}

async function resolveReminderRecipientChatId(defaultChatId, registration, cache = null) {
    const fallbackChatId = String(defaultChatId || '').trim();
    const normalizedPhone = normalizeRegistrantPhone(registration && registration.registrantPhone);
    if (!normalizedPhone) {
        return fallbackChatId;
    }

    if (cache && cache.has(normalizedPhone)) {
        return cache.get(normalizedPhone) || fallbackChatId;
    }

    let resolvedChatId = null;

    for (const [rawChatId, profile] of Object.entries(knownUsers || {})) {
        if (normalizeRegistrantPhone(profile && profile.phone) === normalizedPhone) {
            const parsed = parsePositiveChatId(rawChatId);
            if (parsed) {
                resolvedChatId = String(parsed);
                break;
            }
        }
    }

    if (!resolvedChatId) {
        for (const [rawChatId, profile] of Object.entries(users || {})) {
            if (normalizeRegistrantPhone(profile && profile.phone) === normalizedPhone) {
                const parsed = parsePositiveChatId(rawChatId);
                if (parsed) {
                    resolvedChatId = String(parsed);
                    break;
                }
            }
        }
    }

    if (!resolvedChatId) {
        try {
            const knownByPhone = await loadKnownUserByPhone(normalizedPhone);
            const parsed = parsePositiveChatId(knownByPhone && knownByPhone.chatId);
            if (parsed) {
                resolvedChatId = String(parsed);
            }
        } catch (e) {
            logger.warn('resolveReminderRecipientChatId: loadKnownUserByPhone failed', e && e.message ? e.message : e);
        }
    }

    const finalChatId = resolvedChatId || fallbackChatId;
    if (cache) {
        cache.set(normalizedPhone, finalChatId);
    }
    return finalChatId;
}

async function resolveChatIdByPhone(phone, cache = null) {
    const normalizedPhone = normalizeRegistrantPhone(phone);
    if (!normalizedPhone) {
        return '';
    }

    if (cache && cache.has(normalizedPhone)) {
        return cache.get(normalizedPhone) || '';
    }

    let resolvedChatId = '';

    for (const [rawChatId, profile] of Object.entries(knownUsers || {})) {
        if (normalizeRegistrantPhone(profile && profile.phone) === normalizedPhone) {
            const parsed = parsePositiveChatId(rawChatId);
            if (parsed) {
                resolvedChatId = String(parsed);
                break;
            }
        }
    }

    if (!resolvedChatId) {
        for (const [rawChatId, profile] of Object.entries(users || {})) {
            if (normalizeRegistrantPhone(profile && profile.phone) === normalizedPhone) {
                const parsed = parsePositiveChatId(rawChatId);
                if (parsed) {
                    resolvedChatId = String(parsed);
                    break;
                }
            }
        }
    }

    if (!resolvedChatId) {
        try {
            const knownByPhone = await loadKnownUserByPhone(normalizedPhone);
            const parsed = parsePositiveChatId(knownByPhone && knownByPhone.chatId);
            if (parsed) {
                resolvedChatId = String(parsed);
            }
        } catch (e) {
            logger.warn('resolveChatIdByPhone: loadKnownUserByPhone failed', e && e.message ? e.message : e);
        }
    }

    if (cache) {
        cache.set(normalizedPhone, resolvedChatId);
    }

    return resolvedChatId;
}

function buildManualNoteConfirmationKey(chatId, registration) {
    const normalizedChatId = String(chatId || '').trim();
    const eventId = String(registration && registration.eventId || '').trim();
    const phoneKey = normalizeRegistrantPhone(registration && registration.registrantPhone);
    return `${normalizedChatId}::${eventId}::${phoneKey}`;
}

function getRegistrationConfirmationDate(registration) {
    const parsed = registration && registration.eventDate instanceof Date
        ? registration.eventDate
        : new Date(registration && registration.eventDate);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isManualNoteRegistration(registration) {
    return String(registration && registration.manualRegistrationSource || '').trim() === 'sheet-note';
}

function getManualRegistrationDetectedAtMs(registration) {
    const raw = registration && registration.manualRegistrationDetectedAt
        ? String(registration.manualRegistrationDetectedAt)
        : '';
    if (!raw) {
        return Date.now();
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

async function sendManualRegistrationConfirmation(chatId, registration) {
    const eventDate = getRegistrationConfirmationDate(registration);
    const eventName = String(registration && registration.eventName || '').trim() || 'обраний захід';
    const eventId = String(registration && registration.eventId || '').trim();

    let details = `📌 ${eventName}`;
    if (eventDate) {
        const dateStr = eventDate.toLocaleDateString('uk-UA', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: APP_TIME_ZONE
        });
        const timeStr = eventDate.toLocaleTimeString('uk-UA', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: APP_TIME_ZONE
        });
        details += `\n🕐 ${dateStr} о ${timeStr}`;
    }

    const replyMarkup = eventId
        ? { inline_keyboard: [[{ text: 'Відмінити', callback_data: `UNDO_REGISTER:${eventId}` }]] }
        : undefined;

    await bot.sendMessage(String(chatId), `✅ <b>Вас зареєстровано на захід</b>\n\n${details}`, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    });
}

function scheduleManualNoteConfirmation(chatId, registration, delayMs = MANUAL_NOTE_CONFIRMATION_DELAY_MS) {
    const chatKey = String(chatId || '').trim();
    if (!chatKey || !registration || registration.manualRegistrationConfirmed === true) {
        return false;
    }

    const confirmationKey = buildManualNoteConfirmationKey(chatKey, registration);
    if (!confirmationKey || pendingManualNoteConfirmationTimers.has(confirmationKey)) {
        return false;
    }

    const timeoutMs = Math.max(0, Number(delayMs) || 0);
    const timer = setTimeout(async () => {
        pendingManualNoteConfirmationTimers.delete(confirmationKey);

        const registrations = Array.isArray(userEventRegistrations[chatKey])
            ? userEventRegistrations[chatKey]
            : [];
        const target = registrations.find((item) => buildManualNoteConfirmationKey(chatKey, item) === confirmationKey);
        if (!target || target.manualRegistrationConfirmed === true || !isManualNoteRegistration(target)) {
            return;
        }

        try {
            await sendManualRegistrationConfirmation(chatKey, target);
            target.manualRegistrationConfirmed = true;
            saveReminderStateToDisk();
        } catch (error) {
            console.error(`❌ Не вдалося надіслати підтвердження ручної реєстрації для ${chatKey}:`, error && error.message ? error.message : error);
        }
    }, timeoutMs);

    pendingManualNoteConfirmationTimers.set(confirmationKey, timer);
    return true;
}

function schedulePendingManualNoteConfirmations() {
    const nowMs = Date.now();

    for (const [chatId, registrations] of Object.entries(userEventRegistrations || {})) {
        for (const registration of registrations || []) {
            if (!registration || !isManualNoteRegistration(registration) || registration.manualRegistrationConfirmed === true) {
                continue;
            }

            const eventDate = getRegistrationConfirmationDate(registration);
            if (!eventDate || eventDate <= new Date()) {
                continue;
            }

            const detectedAtMs = getManualRegistrationDetectedAtMs(registration);
            const remainingDelay = MANUAL_NOTE_CONFIRMATION_DELAY_MS - (nowMs - detectedAtMs);
            scheduleManualNoteConfirmation(chatId, registration, remainingDelay);
        }
    }
}

async function syncManualRegistrationsFromScheduleNotes() {
    if (!SPREADSHEET_ID || !sheetsClient) {
        return;
    }

    const noteIndex = await buildScheduleEventNoteIndex();
    if (noteIndex.size === 0) {
        return;
    }

    const now = new Date();
    let hasReminderChanges = false;
    const resolveCache = new Map();

    for (const event of getAllEvents()) {
        if (!event || !event.date || event.date <= now) {
            continue;
        }

        const eventKey = getEventIdentityKey(event);
        const noteText = eventKey ? noteIndex.get(eventKey) : '';
        if (!noteText) {
            continue;
        }

        const registrants = parseRegistrantsFromNote(noteText);
        for (const registrant of registrants) {
            const phoneKey = normalizeRegistrantPhone(registrant && registrant.phone);
            if (!phoneKey) {
                continue;
            }

            const recipientChatId = await resolveChatIdByPhone(phoneKey, resolveCache);
            if (!recipientChatId) {
                continue;
            }

            if (!userEventRegistrations[recipientChatId]) {
                userEventRegistrations[recipientChatId] = [];
            }

            const alreadyAdded = userEventRegistrations[recipientChatId]
                .some((registration) => registration.eventId === event.id && normalizeRegistrantPhone(registration.registrantPhone) === phoneKey);
            if (alreadyAdded) {
                continue;
            }

            const registration = {
                eventId: event.id,
                eventName: event.name,
                eventDate: event.date,
                registrantName: String(registrant && registrant.name || '').trim(),
                registrantPhone: String(registrant && registrant.phone || '').trim(),
                reminded24h: false,
                reminded1h: false,
                manualRegistrationSource: 'sheet-note',
                manualRegistrationDetectedAt: new Date().toISOString(),
                manualRegistrationConfirmed: false
            };

            userEventRegistrations[recipientChatId].push(registration);
            recordFeedbackCandidate(recipientChatId, event.date, event.name);
            hasReminderChanges = true;
            scheduleManualNoteConfirmation(recipientChatId, registration, MANUAL_NOTE_CONFIRMATION_DELAY_MS);
        }
    }

    if (hasReminderChanges) {
        saveReminderStateToDisk();
    }

    schedulePendingManualNoteConfirmations();
}

async function notifyRegistrantAboutRegistration(registrarChatId, event, registrantProfile, options = {}) {
    const reserveMode = options.reserveMode === true;
    const fallbackChatId = String(registrarChatId || '').trim();
    const recipientChatId = await resolveReminderRecipientChatId(fallbackChatId, {
        registrantPhone: registrantProfile && registrantProfile.phone
    });

    const recipientChatIdStr = String(recipientChatId || '').trim();
    if (!recipientChatIdStr || recipientChatIdStr === fallbackChatId) {
        return;
    }

    const eventName = String((event && event.name) || '').trim() || 'обраний захід';
    const eventDate = event && event.date instanceof Date ? event.date : null;

    let details = `📌 ${eventName}`;
    if (eventDate) {
        const dateStr = eventDate.toLocaleDateString('uk-UA', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: APP_TIME_ZONE
        });
        const timeStr = eventDate.toLocaleTimeString('uk-UA', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: APP_TIME_ZONE
        });
        details += `\n🕐 ${dateStr} о ${timeStr}`;
    }

    const prefix = reserveMode
        ? '🕓 <b>Вас додано в резерв на захід</b>'
        : '✅ <b>Вас зареєстровано на захід</b>';

    const notification = {
        chatId: recipientChatIdStr,
        eventId: String(event && event.id || '').trim(),
        eventName: String(event && event.name || '').trim(),
        eventDate: event && event.date instanceof Date ? event.date : null,
        kind: reserveMode ? 'registration-reserve-confirmation' : 'registration-confirmation'
    };

    if (!registrationNotificationDeduper.shouldSend(notification)) {
        return;
    }

    try {
        await bot.sendMessage(recipientChatIdStr, `${prefix}\n\n${details}`, { parse_mode: 'HTML' });
        registrationNotificationDeduper.markSent(notification);
    } catch (error) {
        logger.warn('Failed to notify registrant about registration', error && error.message ? error.message : error);
    }
}

async function notifyUsersAboutEditedEvents(editedEvents) {
    const changes = Array.isArray(editedEvents)
        ? editedEvents.filter((item) => item && item.previous && item.current)
        : [];

    if (changes.length === 0) {
        return;
    }

    const changesByCurrentId = new Map();
    for (const change of changes) {
        changesByCurrentId.set(change.current.id, change);
    }

    const notificationsByChatId = new Map();
    const recipientCache = new Map();
    const pushNotification = (chatId, change) => {
        const normalizedChatId = String(chatId || '').trim();
        if (!normalizedChatId || !change) return;
        if (!notificationsByChatId.has(normalizedChatId)) {
            notificationsByChatId.set(normalizedChatId, new Map());
        }
        notificationsByChatId.get(normalizedChatId).set(change.current.id, change);
    };

    for (const chatId in userEventRegistrations) {
        for (const registration of userEventRegistrations[chatId] || []) {
            const change = registration && changesByCurrentId.get(registration.eventId);
            if (change) {
                const recipientChatId = await resolveReminderRecipientChatId(chatId, registration, recipientCache);
                pushNotification(recipientChatId, change);
            }
        }
    }

    for (const chatId in friendEventRegistrations) {
        for (const registration of friendEventRegistrations[chatId] || []) {
            const change = registration && changesByCurrentId.get(registration.eventId);
            if (change) {
                const recipientChatId = await resolveReminderRecipientChatId(chatId, registration, recipientCache);
                pushNotification(recipientChatId, change);
            }
        }
    }

    for (const [chatId, eventChanges] of notificationsByChatId.entries()) {
        for (const change of eventChanges.values()) {
            const previous = change.previous;
            const current = change.current;
            const prevTime = formatEventTimeForUpdateNotice(previous.date);
            const nextTime = formatEventTimeForUpdateNotice(current.date);
            const timeChanged = prevTime !== nextTime;
            const titleChanged = String(previous.name || '').trim() !== String(current.name || '').trim();

            if (!timeChanged && !titleChanged) {
                continue;
            }

            let message = 'ℹ️ Оновлення розкладу\n\n';
            if (timeChanged) {
                message += `Час заходу «${current.name}» змінено з ${prevTime} на ${nextTime}.`;
            } else {
                message += `Назву заходу оновлено: «${previous.name}» → «${current.name}».`;
            }

            try {
                await bot.sendMessage(chatId, message);
            } catch (error) {
                console.error(`❌ Не вдалося надіслати повідомлення про зміну розкладу chatId=${chatId}:`, error && error.message ? error.message : error);
            }
        }
    }
}

function formatCancelledEventDateTime(eventDate) {
    return {
        date: eventDate.toLocaleDateString('uk-UA', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: APP_TIME_ZONE
        }),
        time: eventDate.toLocaleTimeString('uk-UA', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: APP_TIME_ZONE
        })
    };
}

async function notifyUsersAboutCancelledEvents(cancelledEvents) {
    const upcomingCancelledEvents = Array.isArray(cancelledEvents)
        ? cancelledEvents.filter((event) => event && event.date instanceof Date && event.date > new Date())
        : [];

    if (upcomingCancelledEvents.length === 0) {
        return;
    }

    const cancelledEventsById = new Map(upcomingCancelledEvents.map((event) => [event.id, event]));
    const notificationsByChatId = new Map();
    const recipientCache = new Map();

    const queueNotification = (chatId, eventId) => {
        const cancelledEvent = cancelledEventsById.get(eventId);
        if (!cancelledEvent) {
            return;
        }

        const normalizedChatId = String(chatId || '').trim();
        if (!normalizedChatId) {
            return;
        }

        if (!notificationsByChatId.has(normalizedChatId)) {
            notificationsByChatId.set(normalizedChatId, new Map());
        }

        notificationsByChatId.get(normalizedChatId).set(cancelledEvent.id, cancelledEvent);
    };

    for (const chatId in userEventRegistrations) {
        const registrations = Array.isArray(userEventRegistrations[chatId]) ? userEventRegistrations[chatId] : [];
        for (const registration of registrations) {
            if (registration && cancelledEventsById.has(registration.eventId)) {
                const recipientChatId = await resolveReminderRecipientChatId(chatId, registration, recipientCache);
                queueNotification(recipientChatId, registration.eventId);
            }
        }
    }

    for (const chatId in friendEventRegistrations) {
        const registrations = Array.isArray(friendEventRegistrations[chatId]) ? friendEventRegistrations[chatId] : [];
        for (const registration of registrations) {
            if (registration && cancelledEventsById.has(registration.eventId)) {
                const recipientChatId = await resolveReminderRecipientChatId(chatId, registration, recipientCache);
                queueNotification(recipientChatId, registration.eventId);
            }
        }
    }

    let deliveredCount = 0;
    const deliveredEventsByChatId = new Map();
    for (const [chatId, chatEvents] of notificationsByChatId.entries()) {
        for (const cancelledEvent of chatEvents.values()) {
            const formattedDateTime = formatCancelledEventDateTime(cancelledEvent.date);

            try {
                await bot.sendMessage(
                    chatId,
                    `Заняття (${formattedDateTime.date}, ${formattedDateTime.time}) відмінено.`
                );
                deliveredCount += 1;
                if (!deliveredEventsByChatId.has(chatId)) {
                    deliveredEventsByChatId.set(chatId, new Set());
                }
                deliveredEventsByChatId.get(chatId).add(cancelledEvent.id);
            } catch (error) {
                console.error(
                    `❌ Не вдалося надіслати повідомлення про скасування chatId=${chatId}:`,
                    error && error.message ? error.message : error
                );
            }
        }
    }

    // Автоочищення вимкнено на запит: після повідомлення про скасування
    // записи лишаються у стані, поки їх не видалять вручну.

    console.log(`📣 Оброблено ${upcomingCancelledEvents.length} скасованих заходів, повідомлень надіслано: ${deliveredCount}`);
}

// Перевірка та відправка нагадувань про заходи
async function checkAndSendReminders() {
    const now = new Date();
    const allEvents = getAllEvents();
    const eventsById = new Map(allEvents.map((event) => [event.id, event]));
    const recipientCache = new Map();
    let hasReminderChanges = false;
    
    for (const chatId in userEventRegistrations) {
        const registrations = userEventRegistrations[chatId];
        
        for (const reg of registrations) {
            const recipientChatId = await resolveReminderRecipientChatId(chatId, reg, recipientCache);
            const reminderSettings = getReminderSettingsForChat(recipientChatId);
            if (reminderSettings.enabled === false) {
                console.log(`ℹ️ Нагадування вимкнені для ${recipientChatId}, пропускаємо`);
                continue;
            }

            const resolvedEvent = resolveCurrentEventForReminderRegistration(reg, eventsById, allEvents);
            if (!resolvedEvent || !resolvedEvent.date || resolvedEvent.date <= now) {
                continue;
            }

            if (reg.eventId !== resolvedEvent.id) {
                reg.eventId = resolvedEvent.id;
                hasReminderChanges = true;
            }

            if (String(reg.eventName || '').trim() !== String(resolvedEvent.name || '').trim()) {
                reg.eventName = resolvedEvent.name;
                hasReminderChanges = true;
            }

            const resolvedTime = resolvedEvent.date.getTime();
            const registrationTime = reg.eventDate instanceof Date
                ? reg.eventDate.getTime()
                : new Date(reg.eventDate).getTime();

            if (!Number.isFinite(registrationTime) || registrationTime !== resolvedTime) {
                reg.eventDate = resolvedEvent.date;
                reg.reminded24h = false;
                reg.reminded1h = false;
                hasReminderChanges = true;
            }

            const timeUntilEvent = reg.eventDate - now;
            const hoursUntilEvent = timeUntilEvent / (1000 * 60 * 60);
            const minutesUntilEvent = timeUntilEvent / (1000 * 60);
            const roundedMinutesUntilEvent = Math.round(minutesUntilEvent);
            
            // Нагадування за 24 години (вікно: 23-25 годин до заходу)
            // Це гарантує, що якщо користувач заходить в час X, а захід в час X+24, він отримає нагадування
            if (
                reminderSettings.reminder24h.enabled &&
                !reg.reminded24h &&
                shouldSendReminder(
                    minutesUntilEvent,
                    getReminderLeadTimeMinutes('reminder24h', reminderSettings.reminder24h),
                    getReminderSlotConfig('reminder24h').deliveryWindowMinutes
                )
            ) {
                try {
                    const dateStr = reg.eventDate.toLocaleDateString('uk-UA', { 
                        weekday: 'long', 
                        day: 'numeric', 
                        month: 'long',
                        timeZone: APP_TIME_ZONE
                    });
                    const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', { 
                        hour: '2-digit', 
                        minute: '2-digit',
                        timeZone: APP_TIME_ZONE
                    });
                    
                    const reminderNotification = {
                        chatId: recipientChatId,
                        eventId: String(reg.eventId || '').trim(),
                        eventName: String(reg.eventName || '').trim(),
                        eventDate: reg.eventDate instanceof Date ? reg.eventDate : null,
                        kind: 'reminder-24h'
                    };

                    if (registrationNotificationDeduper.shouldSend(reminderNotification)) {
                        await bot.sendMessage(recipientChatId, 
                            `⏰ <b>Нагадування про захід</b>\n\n` +
                            `Незабаром у вас захід:\n` +
                            `📅 ${reg.eventName}\n` +
                            `🕐 ${dateStr} о ${timeStr}\n\n` +
                            `До початку ${hoursUntilEvent >= 1 ? `залишилось приблизно ${Math.round(hoursUntilEvent)} ${pluralizeHoursUa(Math.round(hoursUntilEvent))}` : `залишилось ${roundedMinutesUntilEvent} хвилин`}\n` +
                            `Налаштовано: за ${formatReminderLeadTime('reminder24h', reminderSettings.reminder24h.hoursBefore)} до початку\n\n` +
                            `Чекаємо на вас у Просторі «Вільна»! 🩵`,
                            { parse_mode: 'HTML' }
                        );
                        registrationNotificationDeduper.markSent(reminderNotification);
                    }
                    
                    reg.reminded24h = true;
                    hasReminderChanges = true;
                    console.log(`⏰ Відправлено нагадування (24 год) для ${recipientChatId} про "${reg.eventName}"`);
                } catch (error) {
                    console.error(`❌ Помилка відправки нагадування (24 год) для ${recipientChatId}:`, error);
                }
            }
            
            // Нагадування за 1 годину: відправляємо лише поблизу позначки 60 хвилин,
            // а не в будь-який момент перед самим стартом заходу.
            if (
                reminderSettings.reminder1h.enabled &&
                !reg.reminded1h &&
                shouldSendReminder(
                    minutesUntilEvent,
                    getReminderLeadTimeMinutes('reminder1h', reminderSettings.reminder1h),
                    getReminderSlotConfig('reminder1h').deliveryWindowMinutes
                )
            ) {
                try {
                    const timeStr = reg.eventDate.toLocaleTimeString('uk-UA', { 
                        hour: '2-digit', 
                        minute: '2-digit',
                        timeZone: APP_TIME_ZONE
                    });
                    
                    // Розраховуємо релевантну інформацію про залишений час
                    let timeLeftMsg = '';
                    if (hoursUntilEvent >= 1) {
                        const remainingHours = Math.floor(hoursUntilEvent);
                        const remainingMins = Math.round((hoursUntilEvent - remainingHours) * 60);
                        timeLeftMsg = `залишилось ${remainingHours} ${remainingHours === 1 ? 'година' : 'години'} ${remainingMins} хвилин`;
                    } else {
                        timeLeftMsg = `залишилось ${roundedMinutesUntilEvent} хвилин`;
                    }
                    
                    const reminderNotification = {
                        chatId: recipientChatId,
                        eventId: String(reg.eventId || '').trim(),
                        eventName: String(reg.eventName || '').trim(),
                        eventDate: reg.eventDate instanceof Date ? reg.eventDate : null,
                        kind: 'reminder-1h'
                    };

                    if (registrationNotificationDeduper.shouldSend(reminderNotification)) {
                        await bot.sendMessage(recipientChatId, 
                            `⏰ <b>Нагадування про захід</b>\n\n` +
                            `Скоро починається захід:\n` +
                            `📅 ${reg.eventName}\n` +
                            `🕐 Сьогодні о ${timeStr}\n\n` +
                            `До початку ${timeLeftMsg}\n` +
                            `Налаштовано: за ${formatReminderLeadTime('reminder1h', reminderSettings.reminder1h.minutesBefore)} до початку\n\n` +
                            `Не забудьте! Чекаємо на вас 🩵\n\n` +
                            `📍 м. Дніпро, вул. Дмитра Донцова, 4`,
                            { parse_mode: 'HTML' }
                        );
                        registrationNotificationDeduper.markSent(reminderNotification);
                    }
                    
                    reg.reminded1h = true;
                    hasReminderChanges = true;
                    console.log(`⏰ Відправлено нагадування (1 год) для ${recipientChatId} про "${reg.eventName}"`);
                } catch (error) {
                    console.error(`❌ Помилка відправки нагадування (1 год) для ${recipientChatId}:`, error);
                }
            }
        }
    }

    if (hasReminderChanges) {
        saveReminderStateToDisk();
    }
}

function resolveFeedbackUserName(chatId, msgFrom = null) {
    const userProfile = users[chatId] || {};
    const knownProfile = knownUsers[chatId] || {};
    const fullName = String(userProfile.name || knownProfile.name || '').trim();
    if (fullName) {
        return fullName;
    }

    const firstName = String((msgFrom && msgFrom.first_name) || '').trim();
    const lastName = String((msgFrom && msgFrom.last_name) || '').trim();
    const username = String((msgFrom && msgFrom.username) || '').trim();

    const fallbackName = `${firstName} ${lastName}`.trim();
    if (fallbackName) {
        return fallbackName;
    }
    if (username) {
        return `@${username.replace(/^@+/, '')}`;
    }
    return String(chatId || 'Невідомо');
}

function resolveFeedbackUserPhone(chatId, msgFrom = null) {
    const userProfile = users[chatId] || {};
    const knownProfile = knownUsers[chatId] || {};

    const phoneFromProfile = String(userProfile.phone || knownProfile.phone || '').trim();
    if (phoneFromProfile) {
        return phoneFromProfile;
    }

    const phoneFromMessage = String((msgFrom && msgFrom.phone_number) || '').trim();
    if (phoneFromMessage) {
        return phoneFromMessage;
    }

    return 'не вказано';
}

async function sendDailyFeedbackPrompt(chatId, dateKey) {
    await bot.sendMessage(chatId,
        'Дякуємо, що сьогодні були з нами 💛\nНам дуже важлива ваша думка. Бажаєте залишити відгук про сьогоднішні заходи?', {
        reply_markup: {
            keyboard: [
                [{ text: FEEDBACK_BUTTON_YES }],
                [{ text: FEEDBACK_BUTTON_NO }]
            ],
            resize_keyboard: true
        }
    });

    setFeedbackStatus(chatId, dateKey, 'requested');
}

async function checkAndSendDailyFeedbackRequests() {
    const now = new Date();
    const { hour, minute } = getCurrentTimePartsInAppTimeZone(now);
    if (hour < FEEDBACK_PROMPT_HOUR || (hour === FEEDBACK_PROMPT_HOUR && minute < FEEDBACK_PROMPT_MINUTE)) {
        return;
    }

    const dateKey = formatDateKeyInAppTimeZone(now);
    if (!dailyFeedbackCandidatesByDate[dateKey]) {
        rebuildFeedbackCandidatesFromActiveRegistrations();
    }

    const todayCandidates = dailyFeedbackCandidatesByDate[dateKey] || {};
    const chatIds = Object.keys(todayCandidates);
    if (chatIds.length === 0) {
        return;
    }

    let sentCount = 0;
    let hasStateChanges = false;

    for (const chatId of chatIds) {
        const events = getFeedbackEventsForChatByDate(chatId, dateKey);
        if (events.length === 0) {
            continue;
        }

        const currentStatus = getFeedbackStatus(chatId, dateKey);
        if (currentStatus) {
            continue;
        }

        try {
            await sendDailyFeedbackPrompt(chatId, dateKey);
            sentCount += 1;
            hasStateChanges = true;
        } catch (error) {
            console.error(`❌ Не вдалося надіслати запит відгуку chatId=${chatId}:`, error && error.message ? error.message : error);
        }
    }

    if (hasStateChanges) {
        saveReminderStateToDisk();
        console.log(`📝 Надіслано ${sentCount} запитів на відгук за ${dateKey}`);
    }
}

// Фільтрує заходи за номером дня (0-6)
function getEventsForDay(dayNum) {
    const allEvents = getAllEvents();
    const dayEvents = allEvents.filter(e => e.date.getDay() === dayNum);
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

function formatPeopleCount(count) {
    const normalizedCount = Math.abs(Number(count));
    const lastTwoDigits = normalizedCount % 100;
    const lastDigit = normalizedCount % 10;

    let peopleWord = 'людей';
    if (lastTwoDigits < 11 || lastTwoDigits > 14) {
        if (lastDigit === 1) {
            peopleWord = 'людина';
        } else if (lastDigit >= 2 && lastDigit <= 4) {
            peopleWord = 'людини';
        }
    }

    return `${count} ${peopleWord}`;
}

// Форматує блок інформації про захід для повідомлення
function formatEventDetails(event) {
    const time = String(event.date.getHours()).padStart(2,'0')+":"+
                 String(event.date.getMinutes()).padStart(2,'0');
    const seatsLeft = event.seats - (event.registrations || 0);
    const registrationsCount = Math.max(0, Number(event.registrations) || 0);
    const reserveCount = Math.max(0, Number(event.reserveCount) || 0);
    const seatsLabel = seatsLeft > 0 ? formatSeatsCount(seatsLeft) : "❌ закрито";
    return `Назва: ${event.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}\nЗареєстровано: ${formatPeopleCount(registrationsCount)}\nРезерв: ${formatPeopleCount(reserveCount)}`;
}

function resolveAfishaEventIdFromButtonText(user, text) {
    if (!user || !user.eventButtonMap || !text) {
        return null;
    }

    if (user.eventButtonMap[text]) {
        return user.eventButtonMap[text];
    }

    const normalizedInput = normalizeCommandText(text);
    for (const [buttonText, eventId] of Object.entries(user.eventButtonMap)) {
        if (normalizeCommandText(buttonText) === normalizedInput) {
            return eventId;
        }
    }

    const parts = String(text).split('|').map((part) => String(part || '').trim());
    if (parts.length >= 2) {
        const titleKey = normalizeTitle(parts[0]);
        const parsedTime = normalizeTimeValue(parts[1]);
        if (titleKey && parsedTime) {
            const matchedEvent = getAllEvents().find((eventItem) => {
                return normalizeTitle(eventItem.name) === titleKey && formatSheetTime(eventItem.date) === parsedTime.text;
            });

            if (matchedEvent) {
                return matchedEvent.id;
            }
        }
    }

    const candidateEventIds = Object.values(user.eventButtonMap);
    const candidateEvents = candidateEventIds
        .map((eventId) => getAllEvents().find((eventItem) => eventItem.id === eventId))
        .filter(Boolean);

    const partialMatches = candidateEvents.filter((eventItem) => {
        const normalizedEventName = normalizeCommandText(eventItem.name);
        return normalizedInput.includes(normalizedEventName) || normalizedEventName.includes(normalizedInput);
    });

    if (partialMatches.length === 1) {
        return partialMatches[0].id;
    }

    return null;
}

function getAfishaDaysKeyboard() {
    return buildAfishaDaysKeyboardData().keyboard;
}

function getStartOfWeekMonday(inputDate) {
    const date = new Date(inputDate);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + mondayOffset);
    return date;
}

function getAfishaTwoWeekBounds(now = new Date()) {
    const thisWeekStart = getStartOfWeekMonday(now);
    const nextWeekStart = new Date(thisWeekStart);
    nextWeekStart.setDate(nextWeekStart.getDate() + 7);
    const afterNextWeekStart = new Date(nextWeekStart);
    afterNextWeekStart.setDate(afterNextWeekStart.getDate() + 7);
    return { thisWeekStart, nextWeekStart, afterNextWeekStart };
}

function parseDaySelectionDate(rawValue) {
    const dateMatch = String(rawValue || '').match(/(\d{2})[./-](\d{2})[./-](\d{4})/);
    if (!dateMatch) {
        return null;
    }

    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const year = Number(dateMatch[3]);
    const parsedDate = new Date(year, month - 1, day);

    if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.getFullYear() !== year ||
        parsedDate.getMonth() !== month - 1 ||
        parsedDate.getDate() !== day
    ) {
        return null;
    }

    parsedDate.setHours(0, 0, 0, 0);
    return parsedDate;
}

function formatDayMonthLabel(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return '';
    }
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}`;
}

function parseAfishaDaySelection(value) {
    const source = normalizeText(String(value || '')).trim();
    if (!source) {
        return null;
    }
    const normalizedWithoutDate = source.replace(/\(\s*\d{2}[./-]\d{2}[./-]\d{4}\s*\)/g, ' ').trim();
    const direct = normalizeWeekdayKey(normalizedWithoutDate);
    if (WEEKDAY_INDEX_BY_NAME[direct] !== undefined) {
        return {
            weekdayKey: direct,
            dayNum: WEEKDAY_INDEX_BY_NAME[direct]
        };
    }

    const tokens = normalizedWithoutDate
        .split(/\s+/)
        .map((token) => token.replace(/[()]/g, ''))
        .filter(Boolean);

    for (const token of tokens) {
        const normalizedToken = normalizeWeekdayKey(token);
        if (WEEKDAY_INDEX_BY_NAME[normalizedToken] !== undefined) {
            return {
                weekdayKey: normalizedToken,
                dayNum: WEEKDAY_INDEX_BY_NAME[normalizedToken]
            };
        }
    }

    return null;
}

function buildAfishaDaysKeyboardData() {
    const seenDates = new Set();
    const uniqueDates = [];

    for (const eventItem of getAllEvents()) {
        if (!eventItem || !(eventItem.date instanceof Date) || Number.isNaN(eventItem.date.getTime())) {
            continue;
        }
        const eventDateOnly = new Date(eventItem.date);
        eventDateOnly.setHours(0, 0, 0, 0);
        const day = String(eventDateOnly.getDate()).padStart(2, '0');
        const month = String(eventDateOnly.getMonth() + 1).padStart(2, '0');
        const year = eventDateOnly.getFullYear();
        const dateKey = `${year}-${month}-${day}`;
        if (seenDates.has(dateKey)) continue;
        seenDates.add(dateKey);
        uniqueDates.push({ dateKey, date: eventDateOnly, label: `${day}.${month}.${year}` });
    }

    uniqueDates.sort((a, b) => a.date - b.date);

    const keyboard = uniqueDates.map(({ date, label }) => {
        const weekday = date.getDay();
        const dayLabel = WEEKDAY_LABEL_FOR_INDEX[weekday] || '';
        return [{ text: dayLabel ? `${dayLabel} (${label})` : label }];
    });

    keyboard.push([{ text: NAVIGATION_BUTTONS.menu }]);

    return { keyboard };
}

function normalizeWeekdayKey(value) {
    const normalized = normalizeCommandText(String(value || ''))
        .replace(/[’`]/g, "'");

    const aliases = {
        "пн": "понеділок",
        "пон": "понеділок",
        "вів": "вівторок",
        "вт": "вівторок",
        "втр": "вівторок",
        "ср": "середа",
        "серед": "середа",
        "срд": "середа",
        "чет": "четвер",
        "чт": "четвер",
        "чтв": "четвер",
        "пт": "п'ятниця",
        "птн": "п'ятниця",
        "пят": "п'ятниця",
        "сб": "субота",
        "суб": "субота",
        "сбт": "субота",
        "нд": "неділя",
        "нед": "неділя",
        "пятниця": "п'ятниця",
        "пятницю": "п'ятниця",
        "п'ятницю": "п'ятниця"
    };

    return aliases[normalized] || normalized;
}

function showAfishaDaysMenu(chatId) {
    if (!users[chatId]) {
        users[chatId] = { step: 0 };
    }
    users[chatId].context = 'afisha';
    const keyboardData = buildAfishaDaysKeyboardData();
    const keyboard = keyboardData.keyboard;
    const hasAvailableDays = keyboard.some((row) => {
        return Array.isArray(row) && row.some((button) => button && button.text !== NAVIGATION_BUTTONS.menu);
    });

    const menuMessage = hasAvailableDays
        ? 'Оберіть день:'
        : "Наразі немає запланованих заходів.";

    return bot.sendMessage(chatId, menuMessage, {
        reply_markup: {
            keyboard,
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

    let dayEventsForDisplay;
    let dateHeaderLabel;

    // Спочатку пробуємо знайти конкретну дату (DD.MM.YYYY) у тексті кнопки
    const specificDate = parseDaySelectionDate(dayName);
    if (specificDate) {
        const nextDay = new Date(specificDate);
        nextDay.setDate(nextDay.getDate() + 1);
        dayEventsForDisplay = getAllEvents()
            .filter((e) => e.date >= specificDate && e.date < nextDay)
            .sort((a, b) => a.date - b.date);
        dateHeaderLabel = formatSheetDate(specificDate);
    } else {
        // Запасний варіант: назва дня тижня
        const parsedSelection = parseAfishaDaySelection(dayName);
        if (!parsedSelection) {
            await bot.sendMessage(chatId, "Не вдалося розпізнати день. Оберіть день з кнопок нижче.", {
                reply_markup: {
                    keyboard: getAfishaDaysKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }
        const { weekdayKey: normalizedDay, dayNum } = parsedSelection;
        dayEventsForDisplay = getEventsForDay(dayNum)
            .sort((a, b) => a.date - b.date);
        dateHeaderLabel = normalizedDay;
    }

    console.log(`\n🔍 showDayAgenda("${dayName}"): знайдено ${dayEventsForDisplay.length} заходів`);

    if (dayEventsForDisplay.length === 0) {
        bot.sendMessage(chatId, `На цей день немає заходів.`, {
            reply_markup: {
                keyboard: [[{ text: NAVIGATION_BUTTONS.backToDays }]],
                resize_keyboard: true
            }
        });
        return;
    }

    let msg = `📅 Заходи на ${dateHeaderLabel}:\n\n`;
    for (const ev of dayEventsForDisplay) {
        const seatsLeft = await getSeatsLeft(ev.id);
        const time = String(ev.date.getHours()).padStart(2,'0') + ":" + String(ev.date.getMinutes()).padStart(2,'0');
        const seatsLabel = seatsLeft > 0 ? `💺 ${formatSeatsCount(seatsLeft)}` : `❌ закрито`;
        const registrationsLabel = `👥 Зареєстровано: ${formatPeopleCount(Math.max(0, Number(ev.registrations) || 0))}`;
        const reserveLabel = `🕓 Резерв: ${formatPeopleCount(Math.max(0, Number(ev.reserveCount) || 0))}`;
        msg += `Назва: ${ev.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}\n${registrationsLabel}\n${reserveLabel}\n\n`;
    }

    const buttons = [];
    const eventButtonMap = {};
    for (const ev of dayEventsForDisplay) {
        const seatsLeft = await getSeatsLeft(ev.id);
        const time = String(ev.date.getHours()).padStart(2,'0') + ":" + String(ev.date.getMinutes()).padStart(2,'0');
        const seatsLabel = seatsLeft > 0 ? `💺 ${formatSeatsCount(seatsLeft)}` : `❌ закрито`;
        const registrationsLabel = `👥 ${formatPeopleCount(Math.max(0, Number(ev.registrations) || 0))}`;
        const reserveLabel = `🕓 ${formatPeopleCount(Math.max(0, Number(ev.reserveCount) || 0))}`;
        const buttonText = `${ev.name} | ${time} | ${seatsLabel} | ${registrationsLabel} | ${reserveLabel}`;
        buttons.push([{ text: buttonText }]);
        eventButtonMap[buttonText] = ev.id;
    }
    buttons.push([{ text: NAVIGATION_BUTTONS.backToDays }]);

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
    let reserveCount = parseInt(cells[5], 10);

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
        // Не підхоплюємо колонки E/F (registrations/reserve) як місткість.
        const registrationsIdx = 4;
        const reserveIdx = 5;
        const seatCell = cells.find((cell, idx) =>
            idx !== dateIndex && idx !== timeIndex && idx !== registrationsIdx && idx !== reserveIdx && /\d+/.test(cell)
        );
        seats = seatCell ? parseInt((seatCell.match(/\d+/) || [0])[0], 10) : 0;
    }

    if (!Number.isFinite(registrations)) {
        registrations = 0;
    }

    if (!Number.isFinite(reserveCount)) {
        reserveCount = 0;
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

    // Колонка D зберігає ЗАЛИШОК місць (не загальну місткість),
    // а колонка E — кількість реєстрацій. Тому загальна місткість = D + E.
    const safeRemaining = Number.isFinite(seats) ? Math.max(0, seats) : 0;
    const safeRegistrations = Number.isFinite(registrations) ? Math.max(0, registrations) : 0;
    const totalSeats = safeRemaining + safeRegistrations;

    return {
        event: {
            id: `${title.replace(/\s+/g,'_')}_${formatSheetDate(eventDate)}_${formatSheetTime(eventDate)}`,
            name: title,
            date: eventDate,
            seats: totalSeats,
            registrations: safeRegistrations,
            reserveCount: Math.max(0, reserveCount)
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

    try {
        const currentResp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`
        });
        const currentRow = (currentResp.data.values || [])[0] || [];
        const currentRemaining = parseInt(currentRow[0] || '0', 10);
        const currentRegistrations = parseInt(currentRow[1] || '0', 10);
        const nextRegistrations = currentRegistrations + 1;
        const nextRemaining = Math.max(0, currentRemaining - 1);
        const nextCapacity = nextRemaining + nextRegistrations;

        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[nextRemaining, nextRegistrations]]
            }
        });

        await updateScheduleRegistrationNote({
            scheduleSheet: match.scheduleSheet,
            rowIndex: match.rowIndex,
            registrationsCount: nextRegistrations,
            fallbackRegistrant,
            eventId: event.id
        });

        if (Number.isFinite(event.registrations)) {
            event.registrations = nextRegistrations;
        }
        if (Number.isFinite(event.seats)) {
            event.seats = nextCapacity;
        }
    } catch (error) {
        console.error('❌ Не вдалося оновити місця/реєстрації у розкладі:', error && error.message ? error.message : error);
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

    try {
        const currentResp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`
        });
        const currentRow = (currentResp.data.values || [])[0] || [];
        const currentRemaining = parseInt(currentRow[0] || '0', 10);
        const currentRegistrations = parseInt(currentRow[1] || '0', 10);
        const nextRegistrations = Math.max(0, currentRegistrations - 1);
        const nextRemaining = currentRemaining + 1;
        const nextCapacity = nextRemaining + nextRegistrations;

        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!D${match.rowIndex + 1}:E${match.rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[nextRemaining, nextRegistrations]]
            }
        });

        await updateScheduleRegistrationNote({
            scheduleSheet: match.scheduleSheet,
            rowIndex: match.rowIndex,
            registrationsCount: nextRegistrations,
            removeRegistrant: registrantProfile,
            eventId: event.id
        });

        if (Number.isFinite(event.registrations)) {
            event.registrations = nextRegistrations;
        }
        if (Number.isFinite(event.seats)) {
            event.seats = nextCapacity;
        }
    } catch (error) {
        console.error('❌ Не вдалося оновити місця/реєстрації після відписки:', error && error.message ? error.message : error);
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
    return parseRegistrantsFromNoteText(noteText);
}

async function findScheduleRowByEventByNoteTag(event) {
    if (!event || !event.id || !SPREADSHEET_ID || !sheetsClient) {
        return null;
    }

    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            const resp = await sheetsClient.spreadsheets.get({
                spreadsheetId: SPREADSHEET_ID,
                ranges: [`${scheduleSheet}!E:E`],
                includeGridData: true,
                fields: 'sheets(data(rowData(values(note))))'
            });

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
                const note = extractRowNote(rowDataRow, 0);
                if (!note) continue;
                const noteEventId = extractScheduleNoteEventId(note);
                if (noteEventId && noteEventId === event.id) {
                    return { scheduleSheet, rowIndex };
                }
            }
        } catch (error) {
            const message = (error && error.message ? String(error.message) : '').toLowerCase();
            if (message.includes('unable to parse range') || message.includes('not found')) {
                continue;
            }
            console.error(`❌ Помилка пошуку рядка події за міткою нотатки у листі ${scheduleSheet}:`, error && error.message ? error.message : error);
        }
    }

    return null;
}

async function findScheduleRowByEvent(event) {
    if (!event || !event.date || !SPREADSHEET_ID || !sheetsClient) {
        return null;
    }

    const markerMatch = await findScheduleRowByEventByNoteTag(event);
    if (markerMatch) {
        return markerMatch;
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

function normalizeRegistrantUserId(value) {
    return String(value || '').replace(/\D/g, '');
}

function buildFriendRegistrationKey(eventId, registrantName, registrantPhone) {
    const eventKey = String(eventId || '').trim();
    const nameKey = normalizeRegistrantName(registrantName);
    const phoneKey = normalizeRegistrantPhone(registrantPhone);
    return `${eventKey}::${nameKey}::${phoneKey}`;
}

function isSameRegistrant(item, candidateNameKey, candidatePhoneKey, candidateUserId) {
    const sameName = normalizeRegistrantName(item.name) === candidateNameKey;
    const samePhone = normalizeRegistrantPhone(item.phone) === candidatePhoneKey;
    const sameUserId = normalizeRegistrantUserId(item.userId) && normalizeRegistrantUserId(candidateUserId)
        && normalizeRegistrantUserId(item.userId) === normalizeRegistrantUserId(candidateUserId);

    return (candidateUserId && sameUserId)
        || (candidateNameKey && candidatePhoneKey && sameName && samePhone)
        || (!candidatePhoneKey && candidateNameKey && sameName)
        || (!candidateNameKey && candidatePhoneKey && samePhone);
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

function buildRegistrantsNoteFromList(registrationsCount, registrants, eventId = '') {
    const safeRegistrants = Array.isArray(registrants) ? registrants : [];
    const derivedCount = Math.max(safeRegistrants.length, 0);
    const safeCount = Number.isFinite(registrationsCount) && registrationsCount > derivedCount
        ? derivedCount
        : derivedCount;
    const header = `Зареєстровано: ${safeCount}`;
    const people = safeRegistrants.map((item, index) => {
        const name = String(item.name || '').trim() || 'Без імені';
        const phone = String(item.phone || '').trim();
        return `${index + 1}. ${name}${phone ? ` | ${phone}` : ''}`;
    });

    const content = people.length === 0 ? header : `${header}\n\n${people.join('\n')}`;
    return content;
}

function getEventIdentityKey(event) {
    if (!event || !event.date) {
        return '';
    }
    return `${normalizeTitle(event.name)}|${event.date.getTime()}`;
}

function extractRowNote(rowDataRow, cellIndex = 0) {
    if (!rowDataRow || !Array.isArray(rowDataRow.values)) {
        return '';
    }
    const cell = rowDataRow.values[cellIndex];
    return String((cell && cell.note) || '').trim();
}

async function buildScheduleEventNoteIndex() {
    const index = new Map();

    if (!SPREADSHEET_ID || !sheetsClient) {
        return index;
    }

    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            const [valuesResp, notesResp] = await Promise.all([
                sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${scheduleSheet}!A:E`
                }),
                sheetsClient.spreadsheets.get({
                    spreadsheetId: SPREADSHEET_ID,
                    ranges: [`${scheduleSheet}!E:E`],
                    includeGridData: true,
                    fields: 'sheets(data(rowData(values(note))))'
                })
            ]);

            const rows = valuesResp && valuesResp.data && Array.isArray(valuesResp.data.values)
                ? valuesResp.data.values
                : [];
            const noteRows = notesResp
                && notesResp.data
                && notesResp.data.sheets
                && notesResp.data.sheets[0]
                && notesResp.data.sheets[0].data
                && notesResp.data.sheets[0].data[0]
                && Array.isArray(notesResp.data.sheets[0].data[0].rowData)
                ? notesResp.data.sheets[0].data[0].rowData
                : [];

            let dateContext = null;
            for (const [rowIndex, row] of rows.entries()) {
                const parsed = parseEventFromRow(row, dateContext);
                dateContext = parsed.nextDateContext;

                if (!parsed.event) {
                    continue;
                }

                const eventKey = getEventIdentityKey(parsed.event);
                if (!eventKey) {
                    continue;
                }

                const note = extractRowNote(noteRows[rowIndex], 0);
                index.set(eventKey, note);
            }
        } catch (error) {
            const message = (error && error.message ? String(error.message) : '').toLowerCase();
            if (message.includes('unable to parse range') || message.includes('not found')) {
                continue;
            }
            console.error(`❌ Помилка побудови індексу нотаток у листі ${scheduleSheet}:`, error && error.message ? error.message : error);
        }
    }

    return index;
}

async function reconcileScheduleNotesWithEvents(loadedEvents) {
    if (!SPREADSHEET_ID || !sheetsClient || !Array.isArray(loadedEvents) || loadedEvents.length === 0) {
        return;
    }

    const eventsById = new Map(
        loadedEvents
            .filter((ev) => ev && ev.id && ev.scheduleSheetName && Number.isFinite(ev.scheduleRowNumber))
            .map((ev) => [ev.id, ev])
    );

    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            const sheetId = await getSheetIdByTitle(SPREADSHEET_ID, scheduleSheet);
            if (sheetId === null || typeof sheetId === 'undefined') {
                continue;
            }

            const notesResp = await sheetsClient.spreadsheets.get({
                spreadsheetId: SPREADSHEET_ID,
                ranges: [`${scheduleSheet}!E:E`],
                includeGridData: true,
                fields: 'sheets(data(rowData(values(note))))'
            });

            const noteRows = notesResp
                && notesResp.data
                && notesResp.data.sheets
                && notesResp.data.sheets[0]
                && notesResp.data.sheets[0].data
                && notesResp.data.sheets[0].data[0]
                && Array.isArray(notesResp.data.sheets[0].data[0].rowData)
                ? notesResp.data.sheets[0].data[0].rowData
                : [];

            const requests = [];
            for (const [rowIndex, rowDataRow] of noteRows.entries()) {
                const note = extractRowNote(rowDataRow, 0);
                const noteEventId = extractScheduleNoteEventId(note);
                if (!noteEventId) {
                    continue;
                }

                const targetEvent = eventsById.get(noteEventId);
                if (!targetEvent || targetEvent.scheduleSheetName !== scheduleSheet) {
                    continue;
                }

                const targetRowIndex = targetEvent.scheduleRowNumber - 1;
                if (targetRowIndex === rowIndex) {
                    continue;
                }

                const targetNoteRow = noteRows[targetRowIndex];
                const targetNote = extractRowNote(targetNoteRow, 0);
                const targetNoteEventId = extractScheduleNoteEventId(targetNote);
                if (targetNote.trim() && targetNoteEventId !== noteEventId) {
                    console.warn(`⚠️ Пропущено переміщення нотатки для події ${noteEventId}: цільовий рядок ${targetRowIndex + 1} містить іншу нотатку.`);
                    continue;
                }

                requests.push({
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: targetRowIndex,
                            endRowIndex: targetRowIndex + 1,
                            startColumnIndex: 4,
                            endColumnIndex: 5
                        },
                        cell: {
                            note
                        },
                        fields: 'note'
                    }
                });

                requests.push({
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: rowIndex,
                            endRowIndex: rowIndex + 1,
                            startColumnIndex: 4,
                            endColumnIndex: 5
                        },
                        cell: {
                            note: ''
                        },
                        fields: 'note'
                    }
                });

                console.log(`ℹ️ Переміщення нотатки для події ${noteEventId}: рядок ${rowIndex + 1} → ${targetRowIndex + 1} у листі ${scheduleSheet}`);
            }

            if (requests.length > 0) {
                await sheetsClient.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    requestBody: { requests }
                });
            }
        } catch (error) {
            const message = (error && error.message ? String(error.message) : '').toLowerCase();
            if (message.includes('unable to parse range') || message.includes('not found')) {
                continue;
            }
            console.error(`❌ Помилка узгодження нотаток розкладу у листі ${scheduleSheet}:`, error && error.message ? error.message : error);
        }
    }
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

    const existingNote = await getScheduleCellNote(match.scheduleSheet, match.rowIndex, 'E');
    const registrants = parseRegistrantsFromNote(existingNote);
    return registrants.some((item) => isSameRegistrant(item, normalizedName, normalizedPhone));
}

async function getScheduleCellNote(scheduleSheet, rowIndex, columnLetter = 'E') {
    if (!scheduleSheet || rowIndex < 0 || !SPREADSHEET_ID || !sheetsClient) {
        return '';
    }

    try {
        const resp = await sheetsClient.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            ranges: [`${scheduleSheet}!${columnLetter}${rowIndex + 1}`],
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
        console.error(`❌ Помилка читання нотатки з ${scheduleSheet}!${columnLetter}${rowIndex + 1}:`, error && error.message ? error.message : error);
        return '';
    }
}

function normalizeRegistrantUserId(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits || '';
}

function parseReserveRegistrantsFromNote(noteText) {
    const text = String(noteText || '').trim();
    if (!text) return [];

    const reservists = [];
    const seen = new Set();
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        if (/^резерв\s*:/i.test(line)
            || /^зареєстровано\s*:/i.test(line)
            || /^список\s+порожній$/i.test(line)
            || /^EVENT_ID\s*:/i.test(line)
            || /^\d+[.)-]?\s*EVENT_ID\s*:/i.test(line)) {
            continue;
        }

        const cleaned = line
            .replace(/^[-*•]\s*/, '')
            .replace(/^\d+[.)-]?\s*/, '')
            .trim();

        if (!cleaned) continue;
        if (/^EVENT_ID\s*:/i.test(cleaned)) continue;

        const parts = cleaned.split('|').map((part) => String(part || '').trim());
        const name = String(parts[0] || '').trim();
        const phone = String(parts[1] || '').trim();
        const userId = String(parts[2] || '').trim();

        if (!name && !phone && !userId) {
            continue;
        }

        const key = `${normalizeRegistrantName(name)}|${normalizeRegistrantPhone(phone)}|${normalizeRegistrantUserId(userId)}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        reservists.push({ name, phone, userId });
    }

    return reservists;
}

function parseReserveRegistrantsFromRegistrationNote(noteText) {
    const text = String(noteText || '').trim();
    if (!text) return [];

    const reservists = [];
    const seen = new Set();
    let currentSection = 'registered';
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        if (/^зареєстровано\s*:/i.test(line)) {
            currentSection = 'registered';
            continue;
        }
        if (/^резерв\s*:/i.test(line)) {
            currentSection = 'reserve';
            continue;
        }
        if (currentSection !== 'reserve') {
            continue;
        }

        if (/^список\s+порожній$/i.test(line)
            || /^EVENT_ID\s*:/i.test(line)
            || /^\d+[.)-]?\s*EVENT_ID\s*:/i.test(line)) {
            continue;
        }

        const cleaned = line
            .replace(/^[-*•]\s*/, '')
            .replace(/^\d+[.)-]?\s*/, '')
            .trim();
        if (!cleaned) continue;
        if (/^EVENT_ID\s*:/i.test(cleaned)) continue;

        const parts = cleaned.split('|').map((part) => String(part || '').trim());
        let name = String(parts[0] || '').trim();
        let phone = String(parts[1] || '').trim();
        let userId = String(parts[2] || '').trim();

        if (!phone && !userId) {
            const structuredMatch = cleaned.match(/^(.*?)\s*(?:\||[—-])\s*(.+)$/);
            if (structuredMatch) {
                name = String(structuredMatch[1] || '').trim();
                phone = String(structuredMatch[2] || '').trim();
            } else {
                const phoneMatch = cleaned.match(/(\+?\d[\d\s()\-]{6,})$/);
                if (phoneMatch) {
                    phone = String(phoneMatch[1] || '').trim();
                    name = cleaned.slice(0, cleaned.length - phone.length).replace(/[,:;\-\s]+$/, '').trim();
                }
            }
        }

        if (!name && !phone && !userId) {
            continue;
        }

        const key = `${normalizeRegistrantName(name)}|${normalizeRegistrantPhone(phone)}|${normalizeRegistrantUserId(userId)}`;
        if (seen.has(key)) {
            continue;
        }
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

    // Legacy fallback: reserve could be stored in registration note (column E)
    const registrationNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'E');
    return parseReserveRegistrantsFromRegistrationNote(registrationNote);
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
    return content;
}

async function updateSheetReserveCount(event) {
    if (!event || !sheetsClient || !SPREADSHEET_ID) {
        return;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        return;
    }

    const reserveCount = Number.isFinite(event.reserveCount) ? Math.max(0, event.reserveCount) : 0;
    try {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${match.scheduleSheet}!F${match.rowIndex + 1}:F${match.rowIndex + 1}`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[reserveCount]]
            }
        });
    } catch (error) {
        console.error('❌ Не вдалося оновити кількість резерву у розкладі:', error && error.message ? error.message : error);
    }
}

async function updateScheduleReserveNote({ scheduleSheet, rowIndex, reserveCount, addRegistrant, removeRegistrant, eventId }) {
    if (!scheduleSheet || rowIndex < 0 || !SPREADSHEET_ID || !sheetsClient) {
        return;
    }

    const sheetId = await getSheetIdByTitle(SPREADSHEET_ID, scheduleSheet);
    if (sheetId === null || typeof sheetId === 'undefined') {
        return;
    }

    const existingNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'F');
    let existingEventId = extractScheduleNoteEventId(existingNote) || eventId;
    let reservists = parseReserveRegistrantsFromNote(existingNote);

    if (reservists.length === 0) {
        const legacyRegistrationNote = await getScheduleCellNote(scheduleSheet, rowIndex, 'E');
        const legacyReservists = parseReserveRegistrantsFromRegistrationNote(legacyRegistrationNote);
        if (legacyReservists.length > 0) {
            reservists = legacyReservists;
            if (!existingEventId) {
                existingEventId = extractScheduleNoteEventId(legacyRegistrationNote) || eventId;
            }
        }
    }

    if (removeRegistrant) {
        const removeNameKey = normalizeRegistrantName(removeRegistrant.name);
        const removePhoneKey = normalizeRegistrantPhone(removeRegistrant.phone);
        const removeUserIdKey = normalizeRegistrantUserId(removeRegistrant.userId);
        reservists = reservists.filter((item) => {
            const sameName = normalizeRegistrantName(item.name) === removeNameKey;
            const samePhone = normalizeRegistrantPhone(item.phone) === removePhoneKey;
            const sameUserId = normalizeRegistrantUserId(item.userId) === removeUserIdKey;

            if (removeNameKey && removePhoneKey) {
                return !(sameName && samePhone);
            }
            if (removeUserIdKey) {
                return !sameUserId;
            }
            if (removeNameKey) {
                return !sameName;
            }
            if (removePhoneKey) {
                return !samePhone;
            }
            return true;
        });
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
    });
}

async function isRegistrantAlreadyInEventReserveNote(event, registrantProfile) {
    if (!event || !registrantProfile || !SPREADSHEET_ID || !sheetsClient) {
        return false;
    }

    const normalizedName = normalizeRegistrantName(registrantProfile.name);
    const normalizedPhone = normalizeRegistrantPhone(registrantProfile.phone);
    const normalizedUserId = normalizeRegistrantUserId(registrantProfile.userId || registrantProfile.chatId);
    if (!normalizedName && !normalizedPhone && !normalizedUserId) {
        return false;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        return false;
    }

    const reservists = await getEffectiveReserveRegistrants(match.scheduleSheet, match.rowIndex);
    return reservists.some((item) => {
        const sameName = normalizeRegistrantName(item.name) === normalizedName;
        const samePhone = normalizeRegistrantPhone(item.phone) === normalizedPhone;
        const sameUserId = normalizeRegistrantUserId(item.userId) === normalizedUserId;
        return (normalizedName && normalizedPhone && sameName && samePhone) || (normalizedUserId && sameUserId);
    });
}

async function addRegistrantToReserve(event, registrantProfile) {
    if (!event || !registrantProfile) {
        return false;
    }

    const duplicateInReserve = await isRegistrantAlreadyInEventReserveNote(event, registrantProfile);
    if (duplicateInReserve) {
        return false;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        return false;
    }

    event.reserveCount = Math.max(0, Number(event.reserveCount) || 0) + 1;
    await updateSheetReserveCount(event);
    await updateScheduleReserveNote({
        scheduleSheet: match.scheduleSheet,
        rowIndex: match.rowIndex,
        reserveCount: event.reserveCount,
        addRegistrant: {
            name: registrantProfile.name,
            phone: registrantProfile.phone,
            userId: registrantProfile.userId || registrantProfile.chatId
        },
        eventId: event.id
    });

    return true;
}

async function removeRegistrantFromReserve(event, registrantProfile) {
    if (!event || !registrantProfile) {
        return false;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        return false;
    }

    const reservists = await getEffectiveReserveRegistrants(match.scheduleSheet, match.rowIndex);

    const targetName = normalizeRegistrantName(registrantProfile.name || '');
    const targetPhone = normalizeRegistrantPhone(registrantProfile.phone || '');
    const targetUserId = normalizeRegistrantUserId(registrantProfile.userId || registrantProfile.chatId || '');

    const remaining = reservists.filter((item) => {
        const sameName = normalizeRegistrantName(item.name) === targetName;
        const samePhone = normalizeRegistrantPhone(item.phone) === targetPhone;
        const sameUserId = normalizeRegistrantUserId(item.userId) === targetUserId;

        if (targetName && targetPhone) {
            return !(sameName && samePhone);
        }
        if (targetUserId) {
            return !sameUserId;
        }
        if (targetName) {
            return !sameName;
        }
        if (targetPhone) {
            return !samePhone;
        }
        return true;
    });

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

async function promoteFirstReserveRegistrantToRegistration(event) {
    if (!event || !sheetsClient || !SPREADSHEET_ID) {
        return false;
    }

    // У runtime event.seats = загальна місткість, event.registrations = зайняті місця.
    // Автоперенос із резерву дозволений лише за фактичної наявності вільних місць.
    const seatsLeft = Math.max(0, (Number(event.seats) || 0) - (Number(event.registrations) || 0));
    if (seatsLeft <= 0) {
        return false;
    }

    const match = await findScheduleRowByEvent(event);
    if (!match) {
        return false;
    }

    const reservists = await getEffectiveReserveRegistrants(match.scheduleSheet, match.rowIndex);
    if (reservists.length === 0) {
        return false;
    }

    const promoted = reservists[0];
    const remainingReserve = reservists.slice(1);

    event.reserveCount = remainingReserve.length;
    await updateSheetReserveCount(event);
    await updateScheduleReserveNote({
        scheduleSheet: match.scheduleSheet,
        rowIndex: match.rowIndex,
        reserveCount: event.reserveCount,
        removeRegistrant: promoted,
        eventId: event.id
    });

    event.registrations = Math.max(0, Number(event.registrations) || 0) + 1;
    await incrementSheetRegistration(event, {
        name: promoted.name,
        phone: promoted.phone,
        userId: promoted.userId
    });

    const promotedChatId = Number(String(promoted.userId || '').trim());
    if (Number.isFinite(promotedChatId) && promotedChatId > 0) {
        if (!userEventRegistrations[promotedChatId]) {
            userEventRegistrations[promotedChatId] = [];
        }

        const exists = userEventRegistrations[promotedChatId].some((entry) => entry.eventId === event.id);
        if (!exists) {
            userEventRegistrations[promotedChatId].push({
                eventId: event.id,
                eventName: event.name,
                eventDate: event.date,
                registrantName: String(promoted.name || '').trim(),
                registrantPhone: String(promoted.phone || '').trim(),
                reminded24h: false,
                reminded1h: false
            });
            saveReminderStateToDisk();
        }

        const reserveForUser = userEventReserveRegistrations[promotedChatId] || [];
        userEventReserveRegistrations[promotedChatId] = reserveForUser.filter((entry) => entry.eventId !== event.id);
        if (userEventReserveRegistrations[promotedChatId].length === 0) {
            delete userEventReserveRegistrations[promotedChatId];
        }

        try {
            await bot.sendMessage(promotedChatId,
                `✅ Ви були в резерві на захід "${event.name}".\n\nЗвільнилося місце, вас додано до списку зареєстрованих.`, {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(promotedChatId),
                    resize_keyboard: true
                }
            });
        } catch (error) {
            console.error(`❌ Не вдалося надіслати повідомлення про переведення з резерву (chatId=${promotedChatId}):`, error && error.message ? error.message : error);
        }
    }

    return true;
}

async function promoteReserveRegistrantsForAvailableSeats(event) {
    if (!event) {
        return false;
    }

    let promotedAny = false;
    while (await promoteFirstReserveRegistrantToRegistration(event)) {
        promotedAny = true;
    }

    return promotedAny;
}

async function buildRegistrantsNote(registrationsCount, fallbackRegistrant, existingNote) {
    const registrants = parseRegistrantsFromNote(existingNote);

    const candidateName = String((fallbackRegistrant && fallbackRegistrant.name) || '').trim();
    const candidatePhone = String((fallbackRegistrant && fallbackRegistrant.phone) || '').trim();
    const candidateUserId = normalizeRegistrantUserId(fallbackRegistrant && fallbackRegistrant.userId);
    if (candidateName || candidatePhone || candidateUserId) {
        const candidateNameKey = normalizeRegistrantName(candidateName);
        const candidatePhoneKey = normalizeRegistrantPhone(candidatePhone);
        const exists = registrants.some((item) => isSameRegistrant(item, candidateNameKey, candidatePhoneKey, candidateUserId));
        if (!exists) {
            registrants.push({ name: candidateName, phone: candidatePhone, userId: candidateUserId });
        }
    }

    const eventId = extractScheduleNoteEventId(existingNote);
    return buildRegistrantsNoteFromList(registrationsCount, registrants, eventId);
}

async function updateScheduleRegistrationNote({ scheduleSheet, rowIndex, registrationsCount, fallbackRegistrant, removeRegistrant, eventId }) {
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
        // При відписці: парсимо, видаляємо, перебудовуємо
        const removeNameKey = normalizeRegistrantName(removeRegistrant.name);
        const removePhoneKey = normalizeRegistrantPhone(removeRegistrant.phone);
        const removeUserId = normalizeRegistrantUserId(removeRegistrant.userId);
        if (removeNameKey || removePhoneKey || removeUserId) {
            registrants = registrants.filter((item) => !isSameRegistrant(item, removeNameKey, removePhoneKey, removeUserId));
        }
    } else if (fallbackRegistrant) {
        // При реєстрації: додаємо у нормалізований список і перебудовуємо всю нотатку.
        // Це прибирає зайві порожні рядки й службові фрагменти.
        const candidateName = String((fallbackRegistrant && fallbackRegistrant.name) || '').trim();
        const candidatePhone = String((fallbackRegistrant && fallbackRegistrant.phone) || '').trim();
        if (!candidateName && !candidatePhone) {
            return;
        }
        const candidateUserId = normalizeRegistrantUserId(fallbackRegistrant && fallbackRegistrant.userId);
        const candidateNameKey = normalizeRegistrantName(candidateName);
        const candidatePhoneKey = normalizeRegistrantPhone(candidatePhone);
        const alreadyInNote = registrants.some((item) => isSameRegistrant(item, candidateNameKey, candidatePhoneKey, candidateUserId));
        if (!alreadyInNote) {
            registrants.push({
                name: candidateName,
                phone: candidatePhone,
                userId: candidateUserId
            });
        }
    } else {
        return; // Нічого робити
    }

    const normalizedRegistrants = registrants.filter((item) => {
        const hasName = String(item.name || '').trim();
        const hasPhone = String(item.phone || '').trim();
        return hasName || hasPhone;
    });

    const nextNote = buildRegistrantsNoteFromList(
        normalizedRegistrants.length,
        normalizedRegistrants,
        eventId
    );

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

function getLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isSameLocalDate(left, right) {
    return left.getFullYear() === right.getFullYear()
        && left.getMonth() === right.getMonth()
        && left.getDate() === right.getDate();
}

async function clearWeeklyScheduleRegistrationNotesIfNeeded() {
    // Автоматичне щотижневе очищення нотаток вимкнено,
    // щоб недільні нотатки в розкладі не скидалися.
    return;
}

// Фільтрувати та сортувати заходи
function getUpcomingEvents() {
    const now = new Date();
    const filtered = events.filter(e => {
        if (e.date < now) return false; // майбутні тільки
        return true;
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
        return true;
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

function formatSelectedEventLine(event) {
    if (!event) {
        return '';
    }

    if (event.date instanceof Date && !Number.isNaN(event.date.getTime())) {
        return `• ${formatEventDate(event.date)} — ${event.name}`;
    }

    return `• ${event.name}`;
}

function getSelectedEventsDetails(selectedEventsList) {
    return (selectedEventsList || []).map((selectedEvent) => {
        const currentEvent = getAllEvents().find((eventItem) => eventItem.id === selectedEvent.id);
        return {
            id: selectedEvent.id,
            name: currentEvent ? currentEvent.name : selectedEvent.name,
            date: currentEvent ? currentEvent.date : selectedEvent.date || null
        };
    });
}

function buildSelectedEventsMessage(selectedEventsList, headline) {
    const selectedEvents = getSelectedEventsDetails(selectedEventsList);
    let message = `${headline}\n\n`;

    selectedEvents.forEach((event) => {
        message += `${formatSelectedEventLine(event)}\n`;
    });

    return message.trim();
}

function getSelectedEventsKeyboard() {
    return [
        [{ text: '➕ Додати ще захід' }],
        [{ text: '📝 Зареєструватися' }],
        [{ text: '❌ Відмінити' }]
    ];
}

function createEmptyFriendRegistrationDraft() {
    return {
        username: '',
        name: '',
        phone: '',
        birth: '',
        status: '',
        childrenCount: '',
        health: '',
        evacuationStatus: '',
        shellingImpact: '',
        employment: '',
        gzn: '',
        beneficiaryCategory: ''
    };
}

function isFriendRegistrationMode(user) {
    return Boolean(user && user.friendRegistrationMode);
}

function getSelectedEventsKeyboardForUser(user) {
    const registerButtonText = isFriendRegistrationMode(user)
        ? '👭 Зареєструвати подругу'
        : '📝 Зареєструватися';

    return [
        [{ text: '➕ Додати ще захід' }],
        [{ text: registerButtonText }],
        [{ text: '❌ Відмінити' }]
    ];
}

function getAfishaInstantRegistrationKeyboard() {
    return [
        [{ text: '➕ Додати ще захід' }],
        [{ text: '❌ Відмінити реєстрацію' }],
        [{ text: NAVIGATION_BUTTONS.backToDays }],
        [{ text: NAVIGATION_BUTTONS.menu }]
    ];
}

function clearFriendRegistrationState(user) {
    if (!user) {
        return;
    }

    delete user.friendRegistrationMode;
    delete user.friendRegistrationDraft;
    delete user.friendTargetChatId;
}

async function startFriendRegistrationFlow(chatId, user) {
    resetSelectedEventsFlow(user);
    user.friendRegistrationMode = true;
    user.friendRegistrationDraft = createEmptyFriendRegistrationDraft();
    user.step = 1;
    user.registrationMode = true;
    user.context = null;

    await bot.sendMessage(chatId,
        "👭 <b>Реєстрація подруги</b>\n\nСпочатку внесіть її дані, а потім оберемо заходи.\n\n📝 <b>Крок 1/11:</b> Введіть ПІБ подруги (Прізвище Ім'я По батькові):", {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [[{ text: "❌ Скасувати реєстрацію" }]],
            resize_keyboard: true
        }
    });
}

function getActiveRegistrationDraft(user) {
    if (isFriendRegistrationMode(user)) {
        if (!user.friendRegistrationDraft) {
            user.friendRegistrationDraft = createEmptyFriendRegistrationDraft();
        }
        return user.friendRegistrationDraft;
    }

    return user;
}

function getMissingRegistrantStep(registrantData) {
    return !registrantData.name ? 1
        : !registrantData.phone ? 2
        : !registrantData.birth ? 3
        : !registrantData.status ? 4
        : !registrantData.childrenCount ? 5
        : !registrantData.health ? 6
    : !registrantData.evacuationStatus ? 7
    : !registrantData.shellingImpact ? 8
    : !registrantData.employment ? 9
    : !registrantData.beneficiaryCategory ? 10
    : !registrantData.gzn ? 11
        : 0;
}

function markPendingRegistrationSelection(user) {
    if (!user) {
        return;
    }

    user.pendingRegistrationReminderAt = Date.now() + PENDING_REGISTRATION_REMINDER_TIMEOUT_MS;
    user.pendingRegistrationReminderSent = false;
}

function clearPendingRegistrationSelection(user) {
    if (!user) {
        return;
    }

    delete user.pendingRegistrationReminderAt;
    delete user.pendingRegistrationReminderSent;
}

async function checkPendingRegistrationSelections() {
    const nowTs = Date.now();

    for (const [chatId, user] of Object.entries(users || {})) {
        if (!user || user.pendingRegistrationReminderSent) {
            continue;
        }

        const reminderAt = Number(user.pendingRegistrationReminderAt || 0);
        if (!Number.isFinite(reminderAt) || reminderAt <= 0 || nowTs < reminderAt) {
            continue;
        }

        const hasSelectedEvents = Array.isArray(user.selectedEventsList) && user.selectedEventsList.length > 0;
        const registrationStarted = user.afishaMultiRegistration === true;

        if (!hasSelectedEvents || registrationStarted) {
            clearPendingRegistrationSelection(user);
            continue;
        }

        try {
            await bot.sendMessage(chatId,
                '⚠️ Реєстрацію не завершено. Оберіть захід з афіші ще раз, щоб завершити запис.', {
                reply_markup: {
                    keyboard: getAfishaInstantRegistrationKeyboard(),
                    resize_keyboard: true
                }
            });
            user.pendingRegistrationReminderSent = true;
        } catch (error) {
            console.error(`❌ Не вдалося надіслати нагадування про незавершену реєстрацію для ${chatId}:`, error && error.message ? error.message : error);
        }
    }
}

function resetSelectedEventsFlow(user) {
    clearPendingRegistrationSelection(user);
    delete user.afishaMultiRegistration;
    delete user.afishaReserveMode;
    delete user.afishaEventIndex;
    delete user.currentMultiEventId;
    delete user.currentMultiEventName;
    delete user.selectedEventsList;
    delete user.currentSelectedEventName;
    delete user.currentSelectedEventId;
    delete user.selectedEventId;
    delete user.selectedEventName;
    delete user.pendingReserveEventId;
    delete user.pendingReserveEventName;
}

async function completeSelectedEventsRegistration(chatId, user, registrantName, registrantPhone, options = {}) {
    const selectedEvents = [...(user.selectedEventsList || [])];
    const successEvents = [];
    const alreadyRegisteredEvents = [];
    const reserveEvents = [];
    const failedEvents = [];

    for (const selectedEvent of selectedEvents) {
        user.selectedEventId = selectedEvent.id;
        user.selectedEventName = selectedEvent.name;

        const eventMeta = getAllEvents().find((eventItem) => eventItem.id === selectedEvent.id);
        const result = await registerForSelectedEvent(chatId, user, registrantName, registrantPhone, options);
        const details = {
            id: selectedEvent.id,
            name: eventMeta ? eventMeta.name : selectedEvent.name,
            date: eventMeta ? eventMeta.date : selectedEvent.date || null
        };

        if (result.status === 'success' || result.status === 'ok') {
            successEvents.push(details);
        } else if (result.status === 'already-registered') {
            alreadyRegisteredEvents.push(details);
            failedEvents.push(`${formatSelectedEventLine(details)} — ви вже зареєстровані`);
        } else if (result.status === 'already-reserved') {
            failedEvents.push(`${formatSelectedEventLine(details)} — ви вже в резерві`);
        } else if (result.status === 'reserved') {
            reserveEvents.push(details);
        } else if (result.status === 'no-seats') {
            failedEvents.push(`${formatSelectedEventLine(details)} — місця закінчилися`);
        } else {
            failedEvents.push(`${formatSelectedEventLine(details)} — не вдалося зареєструвати`);
        }
    }

    resetSelectedEventsFlow(user);
    user.step = 0;
    user.registrationMode = false;

    return { successEvents, alreadyRegisteredEvents, reserveEvents, failedEvents };
}

function buildRegistrationResultsMessage(successEvents, reserveEvents, failedEvents, successTitle = 'Ви успішно зареєстровані на') {
    let message = '';

    if (successEvents.length > 0) {
        message += `✅ <b>${successTitle}:</b>\n\n`;
        successEvents.forEach((event) => {
            message += `${formatSelectedEventLine(event)}\n`;
        });
    }

    if (reserveEvents.length > 0) {
        if (message) {
            message += '\n';
        }
        message += '🕓 <b>Додано в резерв:</b>\n\n';
        reserveEvents.forEach((event) => {
            message += `${formatSelectedEventLine(event)}\n`;
        });
    }

    if (failedEvents.length > 0) {
        if (message) {
            message += '\n';
        }
        message += 'ℹ️ <b>Не вдалося додати:</b>\n\n';
        failedEvents.forEach((line) => {
            message += `${line}\n`;
        });
    }

    return message.trim();
}

async function startSelectedEventsRegistration(chatId, user, options = {}) {
    const instantAfisha = options.instantAfisha === true || user.afishaInstantMode === true;
    user.afishaReserveMode = options.reserveMode === true;

    if (!user.selectedEventsList || user.selectedEventsList.length === 0) {
        await bot.sendMessage(chatId, '❌ Немає вибраних заходів. Оберіть захід з афіші.', {
            reply_markup: {
                keyboard: [
                    [{ text: 'Афіша заходів' }],
                    [{ text: 'Повернутися в меню' }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    clearPendingRegistrationSelection(user);
    user.afishaMultiRegistration = true;
    const isFriendMode = isFriendRegistrationMode(user);
    const registrantData = isFriendMode
        ? getActiveRegistrationDraft(user)
        : await resolveRegistrantFormData(chatId, user);

    if (isFriendMode && !String(user.friendTargetChatId || '').trim()) {
        user.friendTargetChatId = await resolveChatIdByPhone(registrantData.phone);
    }

    if (!isFriendMode) {
        user.name = registrantData.name;
        user.phone = registrantData.phone;
        user.birth = registrantData.birth;
        user.status = registrantData.status;
        user.childrenCount = registrantData.childrenCount;
        user.health = registrantData.health;
        user.evacuationStatus = registrantData.evacuationStatus;
        user.shellingImpact = registrantData.shellingImpact;
        user.employment = registrantData.employment;
        user.gzn = registrantData.gzn;
        user.beneficiaryCategory = registrantData.beneficiaryCategory;
    }

    const missingStep = getMissingRegistrantStep(registrantData);
    const hasExistingProfile = !isFriendMode && Boolean(user.name && user.phone);

    if (missingStep > 0 && !hasExistingProfile) {
        user.step = missingStep;
        user.registrationMode = true;
        showAfishaRegistrationForm(chatId, user);
        return;
    }

    if (isFriendMode) {
        let registrationOwnerChatId = String(user.friendTargetChatId || '').trim();
        if (!registrationOwnerChatId) {
            registrationOwnerChatId = String(chatId || '').trim();
        }

        try {
            await appendRegistrationRow(registrationOwnerChatId, registrantData);
        } catch (error) {
            console.error('❌ Не вдалося синхронізувати дані подруги у таблицю перед реєстрацією:', error && error.message ? error.message : error);
        }
    }

    const { successEvents, alreadyRegisteredEvents, reserveEvents, failedEvents } = await completeSelectedEventsRegistration(
        chatId,
        user,
        registrantData.name,
        registrantData.phone,
        {
            skipReminders: isFriendMode,
            reserveMode: user.afishaReserveMode === true,
            reminderOwnerChatId: isFriendMode
                ? String(user.friendTargetChatId || '').trim()
                : String(chatId)
        }
    );

    if (instantAfisha && !isFriendMode) {
        delete user.lastAfishaRegisteredEventId;
        delete user.lastAfishaRegisteredEventName;
    }

    const messageText = buildRegistrationResultsMessage(
        successEvents,
        reserveEvents,
        failedEvents,
        isFriendMode ? 'Подругу успішно зареєстровано на' : 'Ви успішно зареєстровані на'
    );

    // build reply markup with optional inline undo for last registered event
    let replyMarkup = {
        keyboard: isFriendMode
            ? [[{ text: FRIEND_FLOW_BUTTONS.addAnother }], [{ text: NAVIGATION_BUTTONS.menu }]]
            : instantAfisha
                ? getAfishaInstantRegistrationKeyboard()
                : [[{ text: NAVIGATION_BUTTONS.menu }]],
        resize_keyboard: true
    };

    if (!isFriendMode && successEvents && successEvents.length > 0) {
        const lastEvent = successEvents[successEvents.length - 1];
        if (lastEvent && lastEvent.id) {
            replyMarkup = Object.assign({}, replyMarkup, { inline_keyboard: [[{ text: 'Відмінити', callback_data: `UNDO_REGISTER:${lastEvent.id}` }]] });
        }
    }

    await bot.sendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    });

    if (instantAfisha && !isFriendMode) {
        const lastEvent = successEvents[successEvents.length - 1]
            || alreadyRegisteredEvents[alreadyRegisteredEvents.length - 1]
            || reserveEvents[reserveEvents.length - 1];
        if (lastEvent) {
            user.lastAfishaRegisteredEventId = lastEvent.id;
            user.lastAfishaRegisteredEventName = lastEvent.name;
        }
    }

    if (instantAfisha) {
        user.context = 'afisha';
    }

    if (isFriendMode) {
        clearFriendRegistrationState(user);
    }
}

/* ===== GOOGLE SHEETS ===== */

let sheetsClient = null;
let sheetsRefreshInterval = null;

async function restoreRegistrationNotesToSheet() {
    let restored = 0;
    let failed = 0;

    if (!sheetsClient || !SPREADSHEET_ID) {
        return { restored, failed };
    }

    const registrationsByEventId = new Map();
    const allUserRegs = Object.values(userEventRegistrations || {}).flat();
    const allFriendRegs = Object.values(friendEventRegistrations || {}).flat();

    for (const reg of [...allUserRegs, ...allFriendRegs]) {
        if (!reg || !reg.eventId) continue;
        if (!registrationsByEventId.has(reg.eventId)) {
            registrationsByEventId.set(reg.eventId, []);
        }
        const list = registrationsByEventId.get(reg.eventId);
        const nameKey = normalizeRegistrantName(reg.registrantName || '');
        const phoneKey = normalizeRegistrantPhone(reg.registrantPhone || '');
        if (!list.some(item => normalizeRegistrantName(item.name) === nameKey && normalizeRegistrantPhone(item.phone) === phoneKey)) {
            list.push({ name: reg.registrantName || '', phone: reg.registrantPhone || '' });
        }
    }

    for (const [eventId, registrants] of registrationsByEventId.entries()) {
        const evObj = events.find(e => e.id === eventId);
        if (!evObj) continue;

        const match = await findScheduleRowByEvent(evObj);
        if (!match) { failed++; continue; }

        const sheetId = await getSheetIdByTitle(SPREADSHEET_ID, match.scheduleSheet);
        if (sheetId === null || typeof sheetId === 'undefined') { failed++; continue; }

        const noteText = buildRegistrantsNoteFromList(registrants.length, registrants);

        try {
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
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
            });
            restored++;
        } catch (err) {
            failed++;
            console.error(`❌ restoreRegistrationNotesToSheet: "${evObj.name}":`, err && err.message ? err.message : err);
        }
    }

    console.log(`🔄 restoreRegistrationNotesToSheet: відновлено ${restored}, помилок ${failed}`);
    return { restored, failed };
}

async function initSheets() {
    try {
        sheetsClient = await createAuthorizedSheetsClient();

        console.log("Google Sheets підключено ✅");

        // Початкове завантаження розкладу та періодичне оновлення
        try {
            await loadEventsFromSheet();
            await restoreRegistrationNotesToSheet();
            await clearWeeklyScheduleRegistrationNotesIfNeeded();
        } catch (e) {
            console.error('Initial loadEventsFromSheet failed', e);
        }

        if (sheetsRefreshInterval) {
            clearInterval(sheetsRefreshInterval);
        }
        sheetsRefreshInterval = setInterval(() => {
            loadEventsFromSheet()
                .then(() => clearWeeklyScheduleRegistrationNotesIfNeeded())
                .catch((error) => {
                    console.error('❌ Помилка оновлення розкладу або очищення нотаток:', error && error.message ? error.message : error);
                });
        }, 60000);
        
        // Разова перевірка одразу після ініціалізації
        checkAndSendReminders().catch((error) => {
            console.error('❌ Помилка першої перевірки нагадувань:', error);
        });

        checkAndSendDailyFeedbackRequests().catch((error) => {
            console.error('❌ Помилка першої перевірки запитів на відгук:', error);
        });

        // Запускаємо перевірку нагадувань щохвилини
        setInterval(() => {
            checkAndSendReminders().catch((error) => {
                console.error('❌ Помилка перевірки нагадувань:', error);
            });
            checkAndSendDailyFeedbackRequests().catch((error) => {
                console.error('❌ Помилка перевірки запитів на відгук:', error);
            });
        }, 60 * 1000); // 1 хвилина

        setInterval(() => {
            syncManualRegistrationsFromScheduleNotes().catch((error) => {
                console.error('❌ Помилка синхронізації ручних реєстрацій з нотаток:', error && error.message ? error.message : error);
            });
        }, 15 * 1000);
        
        console.log('⏰ Система нагадувань активована (перевірка щохвилини, синхронізація нотаток кожні 15 сек)');

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

/* ===== BOT IDENTITY GUARD ===== */
// Відновлює назву та опис бота якщо хтось змінив їх через BotFather
async function guardBotIdentity() {
    if (!TOKEN) return;
    const base = `https://api.telegram.org/bot${TOKEN}`;

    async function callTelegramApi(method, body, maxTries = 3) {
        let lastError;
        for (let attempt = 1; attempt <= maxTries; attempt++) {
            try {
                const response = await fetch(`${base}/${method}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const result = await response.json();
                if (result.ok) {
                    return result;
                }

                lastError = result;
                const description = String(result.description || '').toLowerCase();
                const retryAfter = result.parameters && result.parameters.retry_after;
                const waitSeconds = retryAfter || (description.match(/retry after (\d+)/)?.[1] && Number(RegExp.$1));

                if (response.status === 429 || description.includes('too many requests')) {
                    const delay = Math.max(1, Number(waitSeconds) || 2);
                    console.warn(`⚠️ ${method} rate-limited, retrying in ${delay}s (attempt ${attempt}/${maxTries})`);
                    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
                    continue;
                }

                break;
            } catch (err) {
                lastError = err;
                console.warn(`⚠️ ${method} failed (attempt ${attempt}/${maxTries}):`, err && err.message ? err.message : err);
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }
        throw lastError;
    }

    try {
        const meResponse = await fetch(`${base}/getMe`);
        const meResult = await meResponse.json();
        if (meResult.ok && meResult.result) {
            const currentUsername = meResult.result.username || '';
            const currentName = meResult.result.first_name || '';
            console.log(`🔒 Bot token belongs to @${currentUsername}, name="${currentName}"`);
            if (BOT_USERNAME && currentUsername && currentUsername !== BOT_USERNAME) {
                console.warn(`⚠️ BOT_USERNAME mismatch: expected @${BOT_USERNAME}, got @${currentUsername}`);
            }
        } else {
            console.warn('⚠️ guardBotIdentity getMe failed:', meResult.description || meResult);
        }

        if (BOT_DISPLAY_NAME) {
            try {
                await callTelegramApi('setMyName', { name: BOT_DISPLAY_NAME });
                console.log('🔒 Bot name verified/restored:', BOT_DISPLAY_NAME);
            } catch (error) {
                console.warn('⚠️ guardBotIdentity setMyName failed:', error && error.description ? error.description : error);
            }
        }

        if (BOT_DESCRIPTION) {
            try {
                await callTelegramApi('setMyDescription', { description: BOT_DESCRIPTION });
                console.log('🔒 Bot description verified/restored');
            } catch (error) {
                console.warn('⚠️ guardBotIdentity setMyDescription failed:', error && error.description ? error.description : error);
            }
        }

        if (BOT_SHORT_DESCRIPTION) {
            try {
                await callTelegramApi('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
                console.log('🔒 Bot short description verified/restored');
            } catch (error) {
                console.warn('⚠️ guardBotIdentity setMyShortDescription failed:', error && error.description ? error.description : error);
            }
        }
    } catch (err) {
        console.error('❌ guardBotIdentity error:', err && err.message ? err.message : err);
    }
}

/* ===== MAINTENANCE TIMERS ===== */
// Очищати минулі заходи кожну хвилину
setInterval(() => {
    cleanupPastEvents();
}, 60000); // 1 хвилина

// Перевіряти незавершені реєстрації після вибору заходів щохвилини
setInterval(() => {
    checkPendingRegistrationSelections().catch((error) => {
        console.error('❌ Помилка перевірки незавершених реєстрацій:', error && error.message ? error.message : error);
    });
}, 60000);

// reminders interval removed

// Захист ідентичності бота: перевіряти і відновлювати назву/опис кожні 30 хвилин
guardBotIdentity();
setInterval(() => {
    guardBotIdentity().catch(err => console.error('❌ guardBotIdentity interval error:', err && err.message ? err.message : err));
}, 30 * 60 * 1000); // 30 хвилин

// (Завантаження розкладу буде ініційовано після підключення Sheets у initSheets)

/* ===== LOAD EVENTS FROM SHEET ===== */
async function loadEventsFromSheet() {
    if (!sheetsClient || !SPREADSHEET_ID) return;

    try {
        const previousEventsById = new Map(events.map((event) => [event.id, event]));
        let rows = [];
        let activeScheduleSheet = null;
        const readErrors = [];
        for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
            try {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${scheduleSheet}!A:F`
                });
                rows = resp.data.values || [];
                if (rows && rows.length) {
                    activeScheduleSheet = scheduleSheet;
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
                    range: "A:F"
                });
                rows = alt2.data.values || [];
                if (rows && rows.length) {
                    activeScheduleSheet = 'A:F';
                    console.log('   Використано діапазон A:F');
                }
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                readErrors.push({ sheet: 'A:F', message: msg });
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
            // Нормалізуємо назву аркуша: не зберігаємо діапазони на зразок 'A:F'
            const normalizedSheetName = (activeScheduleSheet && !/^[A-Z]+:[A-Z]+$/i.test(activeScheduleSheet))
                ? activeScheduleSheet
                : (SCHEDULE_SHEET_NAME || '');
            ev.scheduleSheetName = normalizedSheetName;
            ev.scheduleRowNumber = i + 1;

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

        await reconcileScheduleNotesWithEvents(events);

        const previousEvents = Array.from(previousEventsById.values());
        const eventRemap = buildLikelyEditedEventMap(previousEvents, events);
        const editedEvents = previousEvents
            .map((previousEvent) => {
                const currentEvent = eventRemap.get(previousEvent.id);
                if (!currentEvent || !previousEvent || !previousEvent.date || !currentEvent.date) {
                    return null;
                }

                const timeChanged = previousEvent.date.getTime() !== currentEvent.date.getTime();
                const nameChanged = String(previousEvent.name || '').trim() !== String(currentEvent.name || '').trim();
                if (!timeChanged && !nameChanged) {
                    return null;
                }

                return {
                    previous: previousEvent,
                    current: currentEvent,
                    timeChanged,
                    nameChanged
                };
            })
            .filter(Boolean);
        remapReminderRegistrationsToUpdatedEvents(eventRemap);
        await notifyUsersAboutEditedEvents(editedEvents);

        // Збираємо source-keys всіх НОВИХ заходів
        const newSourceKeys = new Set();
        for (const ev of events) {
            const sk = getScheduleEventSourceKey(ev);
            if (sk) newSourceKeys.add(sk);
        }

        const now = new Date();
        // Скасований захід — той, якого НЕМАЄ у маппінгу І чий рядок у таблиці тепер порожній
        // (якщо рядок зайнятий іншим заходом — це редагування, а не видалення)
        const cancelledEvents = previousEvents.filter((event) => {
            if (!event || !(event.date instanceof Date) || event.date <= now) return false;
            if (eventRemap.has(event.id)) return false;
            const sourceKey = getScheduleEventSourceKey(event);
            // Якщо рядок все ще має якийсь захід — адміністратор просто відредагував,
            // не видаляв; не надсилаємо сповіщення
            if (sourceKey && newSourceKeys.has(sourceKey)) return false;
            return true;
        });

        if (cancelledEvents.length > 0) {
            await notifyUsersAboutCancelledEvents(cancelledEvents);
        }

        for (const event of events) {
            await promoteReserveRegistrantsForAvailableSeats(event);
        }

        console.log(`✅ Розклад завантажено з Sheets (${events.length} заходів)`);
        
        // Додаткова діагностика
        const futureCount = events.filter(e => e.date > now).length;
        syncReminderRegistrationsWithEvents();
        await syncManualRegistrationsFromScheduleNotes();
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
        user.status || "",
        user.childrenCount || "",
        user.health || "",
        user.evacuationStatus || "",
        user.shellingImpact || "",
        user.employment || "",
        user.beneficiaryCategory || "",
        user.gzn || "",
        String(chatId || '')
    ];

    const normalizeUsername = (value) => String(value || '').trim().toLowerCase().replace(/^@+/, '');
    const normalizeName = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
    const normalizeChatId = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const phonesMatch = (left, right) => {
        if (!left || !right) {
            return false;
        }

        if (left === right) {
            return true;
        }

        if (left.length >= 10 && right.length >= 10) {
            return left.slice(-10) === right.slice(-10);
        }

        return false;
    };

    const findExistingRowByIdentity = (rows) => {
        const inputUsername = normalizeUsername(values[0]);
        const inputName = normalizeName(values[1]);
        const inputPhone = normalizePhone(values[2]);
        const inputChatId = normalizeChatId(values[12]);

        if (!inputUsername && !inputName && !inputPhone && !inputChatId) {
            return null;
        }

        for (let i = rows.length - 1; i >= 1; i--) {
            const row = rows[i] || [];
            const rowUsername = normalizeUsername(row[0]);
            const rowName = normalizeName(row[1]);
            const rowPhone = normalizePhone(row[2]);
            const rowChatId = normalizeChatId(row[12] || row[11] || row[10] || '');

            const hasData = rowUsername || rowName || rowPhone || rowChatId;
            if (!hasData) {
                continue;
            }

            const usernameMatch = inputUsername && rowUsername && inputUsername === rowUsername;
            const phoneMatch = phonesMatch(inputPhone, rowPhone);
            const nameMatch = inputName && rowName && inputName === rowName;
            const chatIdMatch = inputChatId && rowChatId && inputChatId === rowChatId;

            if (usernameMatch || phoneMatch || nameMatch || chatIdMatch) {
                return i + 1;
            }
        }

        return null;
    };

    const mergeWithExistingRow = (existingRow) => values.map((incomingValue, idx) => {
        const incomingText = String(incomingValue || '').trim();
        if (incomingText !== '') {
            return incomingValue;
        }
        return (existingRow && existingRow[idx]) ? existingRow[idx] : '';
    });

    const findFirstFreeRow = (rows) => {
        const searchStartIndex = 1;
        let targetRow = Math.max(2, rows.length + 1);

        for (let i = searchStartIndex; i < rows.length; i++) {
            const row = rows[i] || [];
            const personalDataHasValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].some((idx) => String(row[idx] || '').trim() !== '');
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
            console.log(`Range: ${PERSONAL_DATA_SHEET_NAME}!A:M`);
            
            const existingResp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${PERSONAL_DATA_SHEET_NAME}!A:M`,
            });
            const rows = existingResp.data.values || [];
            const existingRowNumber = findExistingRowByIdentity(rows);
            const targetRow = existingRowNumber || findFirstFreeRow(rows);
            const rowSnapshot = rows[targetRow - 1] || [];
            const valuesToWrite = mergeWithExistingRow(rowSnapshot);
            
            console.log(`${existingRowNumber ? '♻️ Оновлення існуючого' : '🆕 Новий'} рядка: ${targetRow}`);
            console.log(`Дані для запису:`, valuesToWrite);

            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${PERSONAL_DATA_SHEET_NAME}!A${targetRow}:M${targetRow}`,
                valueInputOption: "RAW",
                requestBody: { values: [valuesToWrite] }
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

            // Якщо помилка пов'язана з невірним range (напр., аркуша "Зареєстровані" немає), пробуємо fallback на загальний діапазон листа
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if ((msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('sheet') ) && attempt === 1) {
                try {
                    console.warn('appendRegistrationRow: попробую fallback-діапазон A:M (перший аркуш)');

                    const existingResp = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                        range: "A:M",
                    });
                    const rows = existingResp.data.values || [];
                    const existingRowNumber = findExistingRowByIdentity(rows);
                    const targetRow = existingRowNumber || findFirstFreeRow(rows);
                    const rowSnapshot = rows[targetRow - 1] || [];
                    const valuesToWrite = mergeWithExistingRow(rowSnapshot);

                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A${targetRow}:M${targetRow}`,
                        valueInputOption: "RAW",
                        requestBody: { values: [valuesToWrite] }
                    });
                    console.log(`Записано в таблицю (fallback A:M, рядок ${targetRow}) ✅`);
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('Fallback append to A:L failed:', e2 && e2.message ? e2.message : e2);
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

    const knownProfile = knownUsers[String(chatId)] || knownUsers[chatId];
    if (knownProfile) {
        if (!resolved.name) {
            resolved.name = String(knownProfile.name || '').trim();
        }
        if (!resolved.phone) {
            resolved.phone = String(knownProfile.phone || '').trim();
        }
    }

    return resolved;
}

function isExactRegistrantMatch(item, candidateNameKey, candidatePhoneKey) {
    const nameKey = normalizeRegistrantName(item.name);
    const phoneKey = normalizeRegistrantPhone(item.phone);

    if (candidateNameKey && candidatePhoneKey) {
        return nameKey === candidateNameKey && phoneKey === candidatePhoneKey;
    }

    return isSameRegistrant(item, candidateNameKey, candidatePhoneKey);
}

async function restoreUserRegistrationsFromSheet(chatId, user) {
    if (!chatId || !sheetsClient || !SPREADSHEET_ID) {
        return 0;
    }

    if (!user) {
        return 0;
    }

    const now = Date.now();
    if (user.lastReminderRestoreAt && now - user.lastReminderRestoreAt < REMINDER_RESTORE_CACHE_MS) {
        return 0;
    }

    if (reminderRestoreInFlight.has(chatId)) {
        return reminderRestoreInFlight.get(chatId);
    }

    const restorePromise = (async () => {
        const profile = await resolveRegistrantProfile(chatId, user, user && user.name, user && user.phone);
        const normalizedName = normalizeRegistrantName(profile.name);
        const normalizedPhone = normalizeRegistrantPhone(profile.phone);
        if (!normalizedName && !normalizedPhone) {
            user.lastReminderRestoreAt = Date.now();
            return 0;
        }

        if (!userEventRegistrations[chatId]) {
            userEventRegistrations[chatId] = [];
        }

        const existingIds = new Set(userEventRegistrations[chatId].map((item) => item.eventId));
        const candidateEvents = [];

        for (const event of getAllEvents()) {
            if (!event || !event.date || event.date <= new Date() || existingIds.has(event.id)) {
                continue;
            }
            const eventKey = getEventIdentityKey(event);
            if (!eventKey) {
                continue;
            }
            candidateEvents.push(event);
        }

        if (candidateEvents.length === 0) {
            user.lastReminderRestoreAt = Date.now();
            return 0;
        }

        const noteIndex = await buildScheduleEventNoteIndex();
        let restoredCount = 0;

        for (const event of candidateEvents) {
            const eventKey = getEventIdentityKey(event);
            const noteText = noteIndex.get(eventKey);
            if (!noteText) continue;

            const registrants = parseRegistrantsFromNote(noteText);
            const inNote = registrants.some((item) => isExactRegistrantMatch(item, normalizedName, normalizedPhone));
            if (!inNote) continue;

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

        user.lastReminderRestoreAt = Date.now();
        return restoredCount;
    })();

    reminderRestoreInFlight.set(chatId, restorePromise);

    try {
        return await restorePromise;
    } finally {
        reminderRestoreInFlight.delete(chatId);
    }
}

async function resolveRegistrantFormData(chatId, user) {
    const resolved = {
        userId: String(chatId || ''),
        name: String((user && user.name) || '').trim(),
        phone: String((user && user.phone) || '').trim(),
        birth: String((user && user.birth) || '').trim(),
        status: String((user && user.status) || '').trim(),
        childrenCount: String((user && user.childrenCount) || '').trim(),
        health: String((user && user.health) || '').trim(),
        evacuationStatus: String((user && user.evacuationStatus) || '').trim(),
        shellingImpact: String((user && user.shellingImpact) || '').trim(),
        employment: String((user && user.employment) || '').trim(),
        gzn: String((user && user.gzn) || '').trim(),
        beneficiaryCategory: String((user && user.beneficiaryCategory) || '').trim()
    };

    const hasAll = resolved.name && resolved.phone && resolved.birth && resolved.status && resolved.health &&
        resolved.childrenCount && resolved.evacuationStatus && resolved.shellingImpact && resolved.employment && resolved.gzn && resolved.beneficiaryCategory;
    if (hasAll || !sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return resolved;
    }

    const sheetProfile = await loadKnownUserByChatId(chatId);
    if (sheetProfile) {
        Object.assign(resolved, sheetProfile);
    } else if (!resolved.phone && user && user.phone) {
        const phoneProfile = await loadKnownUserByPhone(user.phone);
        if (phoneProfile) {
            Object.assign(resolved, phoneProfile);
        }
    } else if (!resolved.name && user && user.username) {
        const usernameProfile = await loadKnownUserByUsername(user.username);
        if (usernameProfile) {
            Object.assign(resolved, usernameProfile);
        }
    }

    const hasAllAfterSheet = resolved.name && resolved.phone && resolved.birth && resolved.status && resolved.health &&
        resolved.childrenCount && resolved.evacuationStatus && resolved.shellingImpact && resolved.employment && resolved.gzn && resolved.beneficiaryCategory;
    if (hasAllAfterSheet) {
        return resolved;
    }

    const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
    const inputPhone = normalizePhone(resolved.phone);
    const inputName = String(resolved.name || '').trim().toLowerCase();

    const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:M`, 'A:M'];
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
                if (!resolved.status) resolved.status = String(row[4] || '').trim();
                if (!resolved.childrenCount) resolved.childrenCount = String(row[5] || '').trim();
                if (!resolved.health) resolved.health = String(row[6] || '').trim();
                if (!resolved.evacuationStatus) resolved.evacuationStatus = String(row[7] || '').trim();
                if (!resolved.shellingImpact) resolved.shellingImpact = String(row[8] || '').trim();
                if (!resolved.employment) resolved.employment = String(row[9] || '').trim();
                if (!resolved.beneficiaryCategory) resolved.beneficiaryCategory = String(row[10] || '').trim();
                if (!resolved.gzn) resolved.gzn = String(row[11] || '').trim();

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

function parsePersonalDataRow(row) {
    const cells = (row || []).map((cell) => String(cell || '').trim());
    const current = {
        username: cells[0] || '',
        name: cells[1] || '',
        phone: cells[2] || '',
        birth: cells[3] || '',
        status: cells[4] || '',
        childrenCount: cells[5] || '',
        health: cells[6] || '',
        evacuationStatus: cells[7] || '',
        shellingImpact: cells[8] || '',
        employment: cells[9] || '',
        beneficiaryCategory: cells[10] || '',
        gzn: cells[11] || '',
        chatId: cells[12] || ''
    };
    const legacy = {
        username: cells[7] || cells[0] || '',
        name: cells[0] || cells[1] || '',
        phone: cells[1] || cells[2] || '',
        birth: cells[2] || cells[3] || '',
        status: cells[5] || cells[4] || '',
        childrenCount: '',
        health: cells[6] || cells[5] || '',
        evacuationStatus: '',
        shellingImpact: '',
        employment: cells[9] || cells[8] || '',
        gzn: '',
        beneficiaryCategory: '',
        chatId: cells[12] || cells[11] || cells[10] || cells[7] || cells[6] || ''
    };

    return {
        username: current.username || legacy.username,
        name: current.name || legacy.name,
        phone: current.phone || legacy.phone,
        birth: current.birth || legacy.birth,
        status: current.status || legacy.status,
        childrenCount: current.childrenCount || legacy.childrenCount,
        health: current.health || legacy.health,
        evacuationStatus: current.evacuationStatus || legacy.evacuationStatus,
        shellingImpact: current.shellingImpact || legacy.shellingImpact,
        chatId: current.chatId || legacy.chatId,
        employment: current.employment || legacy.employment,
        gzn: current.gzn || legacy.gzn,
        beneficiaryCategory: current.beneficiaryCategory || legacy.beneficiaryCategory
    };
}

async function loadKnownUserByChatId(chatId, options = {}) {
    const chatIdStr = String(chatId || '').trim();
    if (!chatIdStr) return null;

    const forceRefresh = options && options.forceRefresh === true;

    if (!forceRefresh && knownUsers[chatId]) {
        return knownUsers[chatId];
    }

    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return null;
    }

    try {
        const found = await findUserByChatIdInSheet(chatIdStr);
        if (found) {
            knownUsers[chatId] = found;
            return found;
        }
    } catch (e) {
        console.error('loadKnownUserByChatId error:', e && e.message ? e.message : e);
    }

    return null;
}

function getPeriodRange(referenceDate = new Date()) {
    const startOfDay = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    const endOfDay = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 23, 59, 59, 999);

    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - ((startOfDay.getDay() + 6) % 7));
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    const startOfMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
    const endOfMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0, 23, 59, 59, 999);

    return {
        day: { start: startOfDay, end: endOfDay },
        week: { start: startOfWeek, end: endOfWeek },
        month: { start: startOfMonth, end: endOfMonth }
    };
}

function getPeriodLabel(periodName, referenceDate = new Date()) {
    const dayNames = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота'];
    const monthNames = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

    if (periodName === 'day') {
        const dayName = dayNames[referenceDate.getDay()];
        return `${dayName}, ${referenceDate.getDate()} ${monthNames[referenceDate.getMonth()]} ${referenceDate.getFullYear()}`;
    }

    if (periodName === 'week') {
        const range = getPeriodRange(referenceDate).week;
        return `${range.start.getDate()} ${monthNames[range.start.getMonth()]} – ${range.end.getDate()} ${monthNames[range.end.getMonth()]} ${range.end.getFullYear()}`;
    }

    return `${monthNames[referenceDate.getMonth()]} ${referenceDate.getFullYear()}`;
}

async function findProfileByNameOrPhone(registrant) {
    if (!registrant) {
        return null;
    }

    const phone = String(registrant.phone || '').replace(/\D/g, '');
    const identifier = String(registrant.identifier || registrant.chatId || registrant.userId || '').replace(/\D/g, '');
    const name = String(registrant.name || '').trim();

    if (identifier && sheetsClient && PERSONAL_DATA_SPREADSHEET_ID) {
        const chatProfile = await loadKnownUserByChatId(identifier);
        if (chatProfile) {
            return chatProfile;
        }
    }

    if (phone && sheetsClient && PERSONAL_DATA_SPREADSHEET_ID) {
        const phoneProfile = await loadKnownUserByPhone(phone);
        if (phoneProfile) {
            return phoneProfile;
        }
    }

    if (identifier && sheetsClient && PERSONAL_DATA_SPREADSHEET_ID) {
        const phoneProfile = await loadKnownUserByPhone(identifier);
        if (phoneProfile) {
            return phoneProfile;
        }
    }

    if (name && sheetsClient && PERSONAL_DATA_SPREADSHEET_ID) {
        try {
            const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:M`, 'A:M'];
            for (const range of rangesToTry) {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range
                });
                const rows = resp.data.values || [];
                const normalizedName = name.toLowerCase();

                for (let i = rows.length - 1; i >= 0; i--) {
                    const row = rows[i] || [];
                    const rowName = String(row[1] || '').trim().toLowerCase();
                    if (!rowName) continue;
                    if (rowName === normalizedName || rowName.includes(normalizedName) || normalizedName.includes(rowName)) {
                        return parsePersonalDataRow(row);
                    }
                }
            }
        } catch (e) {
            console.warn('Не вдалося знайти профіль за імʼям:', e && e.message ? e.message : e);
        }
    }

    return {
        name,
        phone,
        birth: '',
        status: '',
        health: ''
    };
}

async function collectBeneficiaryRecordsForPeriod(startDate, endDate) {
    if (!Array.isArray(events) || events.length === 0) {
        try {
            await loadEventsFromSheet();
        } catch (error) {
            console.warn('⚠️ Не вдалося перезавантажити заходи для підсумку бенефіціарок:', error && error.message ? error.message : error);
        }
    }

    if (!Array.isArray(events) || events.length === 0) {
        return [];
    }

    const noteIndex = await buildScheduleEventNoteIndex();
    const records = [];
    const seen = new Set();

    for (const event of events) {
        const eventDate = event && event.date instanceof Date ? event.date : null;
        if (!eventDate) continue;
        if (eventDate < startDate || eventDate > endDate) continue;

        const eventKey = getEventIdentityKey(event);
        const noteText = noteIndex.get(eventKey) || '';
        const registrants = parseRegistrantsFromNote(noteText);

        if (!Array.isArray(registrants) || registrants.length === 0) {
            continue;
        }

        for (const registrant of registrants) {
            const profile = await findProfileByNameOrPhone(registrant);
            const name = String(profile && profile.name ? profile.name : registrant.name || '').trim();
            const phone = String(profile && profile.phone ? profile.phone : registrant.phone || '').trim();
            const identifier = String(registrant.identifier || '').trim();
            const key = `${name}|${phone}|${identifier}`.toLowerCase();
            if (!name && !phone && !identifier) continue;
            if (seen.has(key)) continue;
            seen.add(key);

            records.push({
                name,
                phone,
                identifier,
                birth: profile && profile.birth ? profile.birth : '',
                status: profile && profile.status ? profile.status : '',
                health: profile && profile.health ? profile.health : ''
            });
        }
    }

    return records;
}

function buildSummaryMessage(records, periodName, referenceDate = new Date()) {
    const summary = buildBeneficiarySummary(records, referenceDate);
    const sectionTitle = periodName === 'day'
        ? '📅 За день'
        : periodName === 'week'
            ? '📆 За тиждень'
            : '🗓️ За місяць';
    const periodLabel = getPeriodLabel(periodName, referenceDate);

    const lines = [];
    lines.push(`<b>${sectionTitle}</b>`);
    lines.push(`Період: ${periodLabel}`);
    lines.push(`• ВПО: ${summary.counts.vpo}`);
    lines.push(`• Не ВПО, що постраждали від війни: ${summary.counts.nonVpoDamaged}`);
    lines.push(`• Не ВПО, що не постраждали від війни: ${summary.counts.nonVpoSafe}`);
    lines.push(`• До 18 років: ${summary.counts.under18}`);
    lines.push(`• 18–59 років: ${summary.counts.age18to59}`);
    lines.push(`• 60+ років: ${summary.counts.age60plus}`);
    lines.push(`• Інвалідність / істотні проблеми зі здоровʼям: ${summary.counts.healthIssues}`);

    if (summary.items.length > 0) {
        lines.push('');
        lines.push('<b>Список бенефіціарок:</b>');
        summary.items.forEach((item) => {
            const ageText = Number.isFinite(item.age) ? `${item.age} р.` : 'н/д';
            const statusText = item.status || '—';
            const healthText = item.health || '—';
            lines.push(`• ${item.name || 'Без імені'} — ${ageText}; ${statusText}; ${healthText}`);
        });
    } else {
        lines.push('');
        lines.push('Нічого не знайдено у нотатках за цей період.');
    }

    return lines.join('\n');
}

function ensureBeneficiarySummaryStorageDir() {
    const dir = path.dirname(BENEFICIARY_SUMMARY_STORAGE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function deleteExpiredBeneficiarySummaryStorage(referenceDate = new Date()) {
    if (!fs.existsSync(BENEFICIARY_SUMMARY_STORAGE_PATH)) {
        return;
    }

    try {
        const raw = fs.readFileSync(BENEFICIARY_SUMMARY_STORAGE_PATH, 'utf8');
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || !parsed.generatedAt) {
            fs.unlinkSync(BENEFICIARY_SUMMARY_STORAGE_PATH);
            return;
        }

        const generated = new Date(parsed.generatedAt);
        if (Number.isNaN(generated.getTime())) {
            fs.unlinkSync(BENEFICIARY_SUMMARY_STORAGE_PATH);
            return;
        }

        const nextMonthEnd = new Date(generated.getFullYear(), generated.getMonth() + 2, 0, 23, 59, 59, 999);
        if (referenceDate > nextMonthEnd) {
            fs.unlinkSync(BENEFICIARY_SUMMARY_STORAGE_PATH);
        }
    } catch (error) {
        console.warn('Не вдалося очистити файл підсумків бенефіціарок:', error && error.message ? error.message : error);
    }
}

function saveBeneficiarySummaryToStorage(text, referenceDate = new Date()) {
    ensureBeneficiarySummaryStorageDir();
    const payload = {
        generatedAt: referenceDate.toISOString(),
        text
    };
    fs.writeFileSync(BENEFICIARY_SUMMARY_STORAGE_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

async function sendBeneficiarySummary(bot, chatId, referenceDate = new Date()) {
    const periods = getPeriodRange(referenceDate);
    const dayRecords = await collectBeneficiaryRecordsForPeriod(periods.day.start, periods.day.end);
    const weekRecords = await collectBeneficiaryRecordsForPeriod(periods.week.start, periods.week.end);
    const monthRecords = await collectBeneficiaryRecordsForPeriod(periods.month.start, periods.month.end);

    const message = [
        '🧮 <b>Підсумок бенефіціарок</b>',
        '',
        buildSummaryMessage(dayRecords, 'day', referenceDate),
        '',
        buildSummaryMessage(weekRecords, 'week', referenceDate),
        '',
        buildSummaryMessage(monthRecords, 'month', referenceDate),
        '',
        'ℹ️ Цей підсумок збережено локально до кінця наступного місяця.'
    ].join('\n');

    saveBeneficiarySummaryToStorage(message, referenceDate);
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
}

async function findUserByChatIdInSheet(chatIdStr) {
    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID || !chatIdStr) {
        return null;
    }

    const rangesToTry = [];
    if (PERSONAL_DATA_SHEET_NAME) {
        rangesToTry.push(`${PERSONAL_DATA_SHEET_NAME}!A:M`);
        rangesToTry.push(`'${PERSONAL_DATA_SHEET_NAME}'!A:M`);
    }
    rangesToTry.push('Зареєстровані!A:M');
    rangesToTry.push("'Зареєстровані'!A:M");
    rangesToTry.push('A:M');

    const normalizeChatIdValue = (value) => String(value || '')
        .trim()
        .replace(/^'/, '')
        .replace(/\.0+$/, '');
    const targetChatId = normalizeChatIdValue(chatIdStr);

    for (const range of rangesToTry) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range
            });

            const rows = resp.data.values || [];
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i] || [];
                const restored = parsePersonalDataRow(row);
                const directChatId = normalizeChatIdValue(restored.chatId || '');
                const fallbackChatId = normalizeChatIdValue(row[12] || row[11] || row[10] || '');
                const legacyChatId = normalizeChatIdValue(row[6] || '');

                if (directChatId === targetChatId || fallbackChatId === targetChatId || legacyChatId === targetChatId) {
                    return restored;
                }
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

// Завантажує профіль користувача по телефону
async function loadKnownUserByPhone(phone) {
    const phoneStr = String(phone || '').trim();
    if (!phoneStr) return null;

    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
        return null;
    }

    const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:L`, 'A:L'];
    for (const range of rangesToTry) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range
            });
            const rows = resp.data.values || [];
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i] || [];
                const restored = parsePersonalDataRow(row);
                if (!restored.phone) continue;
                if (!restored.phone.includes(phoneStr) && phoneStr !== restored.phone) continue;

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

    const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:L`, 'A:L'];
    for (const range of rangesToTry) {
        try {
            const resp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range
            });
            const rows = resp.data.values || [];
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i] || [];
                const restored = parsePersonalDataRow(row);
                const normalizedUsername = String(restored.username || '').toLowerCase().replace(/^@/, '');
                const fallbackUsername = String(row[0] || '').trim().toLowerCase().replace(/^@/, '');
                if (normalizedUsername !== usernameStr && fallbackUsername !== usernameStr) continue;

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

    let question = isFriendRegistrationMode(user)
        ? "📝 <b>Крок 1/11:</b> Введіть ПІБ подруги (Прізвище Ім'я По батькові):"
        : "📝 <b>Крок 1/11:</b> Будь ласка, введіть ваше <b>ПІБ</b> (Прізвище Ім'я По батькові):";
    if (step === 2) question = isFriendRegistrationMode(user)
        ? "📝 <b>Крок 2/11:</b> Введіть <b>номер телефону подруги</b> (формат: 380...)"
        : "📝 <b>Крок 2/11:</b> Введіть ваш <b>номер телефону</b> (формат: 380...)";
    if (step === 3) question = isFriendRegistrationMode(user)
        ? "📝 <b>Крок 3/11:</b> Введіть <b>дату народження подруги</b> (формат: ДД.ММ.РРРР)"
        : "📝 <b>Крок 3/11:</b> Введіть вашу <b>дату народження</b> (формат: ДД.ММ.РРРР)";
    if (step === 4) question = isFriendRegistrationMode(user)
        ? "📝 <b>Крок 4/11:</b> ВПО/МО статус подруги:\n\n<b>Не ВПО, що постраждали від війни:</b> Громадяни, які живуть у рідних містах, але їхнє житло було зруйноване/пошкоджене, або вони отримали фізичні чи психологічні травми, втратили майно або джерело доходу внаслідок бойових дій.\n\n<b>Не ВПО, що не постраждали від війни:</b> Люди, які проживають у відносно безпечних регіонах, чиє майно, здоров'я та фінансовий стан не зазнали прямого впливу бойових дій."
        : "📝 <b>Крок 4/11:</b> Ваш ВПО/МО статус:\n\n<b>Не ВПО, що постраждали від війни:</b> Громадяни, які живуть у рідних містах, але їхнє житло було зруйноване/пошкоджене, або вони отримали фізичні чи психологічні травми, втратили майно або джерело доходу внаслідок бойових дій.\n\n<b>Не ВПО, що не постраждали від війни:</b> Люди, які проживають у відносно безпечних регіонах, чиє майно, здоров'я та фінансовий стан не зазнали прямого впливу бойових дій.";
    if (step === 5) question = isFriendRegistrationMode(user)
        ? "📝 <b>Крок 5/11:</b> Кількість дітей подруги до 18 років:"
        : "📝 <b>Крок 5/11:</b> Кількість дітей до 18 років:";
    if (step === 6) question = isFriendRegistrationMode(user)
        ? "📝 <b>Крок 6/11:</b> Стан здоров'я подруги:"
        : "📝 <b>Крок 6/11:</b> Стан здоров'я:";
    if (step === 7) question = "📝 <b>Крок 7/11:</b> Евакуаційний статус особи:";
    if (step === 8) question = "📝 <b>Крок 8/11:</b> Чи вважаєте себе такою, що прямо або опосередковано постраждала від обстрілів протягом останніх 72 годин або останніх 3 місяців?\n\nПриклади опосередкованого впливу: перебої в електропостачанні, втрата роботи, зміна звичного способу життя та інше.";
    if (step === 9) question = "📝 <b>Крок 9/11:</b> Зайнятість:";
    if (step === 10) question = "📝 <b>Крок 10/11:</b> До яких категорій належите?";
    if (step === 11) question = "📝 <b>Крок 11/11:</b> Чи маєте ви досвід або потребу, пов'язану з ГЗН?\n\n<b>ГЗН (гендерно зумовлене насильство)</b> — це будь-які дії, завдані людині через її стать або гендер, які спричиняють фізичну, психологічну, сексуальну чи економічну шкоду.\n\n<b>Приклади:</b>\n- фізичне насильство — побиття, штовхання;\n- психологічне — образи, приниження, погрози, контроль;\n- сексуальне — примус до сексуальних дій без згоди;\n- економічне — заборона працювати, відбирання грошей, повний контроль фінансів;\n- переслідування, сексуальні домагання, примусовий шлюб.";

    let keyboard = [[{ text: "❌ Скасувати реєстрацію" }]];
    if (step === 4) {
        keyboard = [
            [{ text: "ВПО" }],
            [{ text: "Не ВПО, що постраждали від війни" }],
            [{ text: "Не ВПО, що не постраждали від війни" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 5) {
        keyboard = [
            [{ text: "0" }, { text: "1" }],
            [{ text: "2" }, { text: "3 і більше" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 6) {
        keyboard = [
            [{ text: "Ні, немає істотних проблем зі здоров'ям" }],
            [{ text: "Ні, але є істотні проблеми зі здоров'ям" }],
            [{ text: "Інвалідність" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 7) {
        keyboard = [
            [{ text: "Евакуація з попереднього місця проживання за останні 6 місяців" }],
            [{ text: "Перебування в транзитному центрі та/або в процесі евакуації" }],
            [{ text: "Готуюсь до евакуації" }],
            [{ text: "Нічого з зазначеного" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 8) {
        keyboard = [
            [{ text: "Так, постраждала протягом останніх 72 годин" }],
            [{ text: "Так, постраждала протягом останніх 3 місяців" }],
            [{ text: "Ні, не постраждала" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 9) {
        keyboard = [
            [{ text: "Працюю" }, { text: "Не працюю" }],
            [{ text: "Пенсіонерка" }, { text: "Студентка" }],
            [{ text: "Школярка" }, { text: "ФОП" }],
            [{ text: "Волонтерка" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 10) {
        keyboard = [
            [{ text: "Вагітна" }, { text: "Одинока мати" }],
            [{ text: "Багатодітна мати (3 і більше дітей)" }],
            [{ text: "Ветеранка" }],
            [{ text: "Представниця сім'ї загиблого воїна" }],
            [{ text: "Представниця сім'ї ветерана" }],
            [{ text: "Особа у складних життєвих обставинах (юридичне підтвердження статусу не потрібно)" }],
            [{ text: "Нічого із вищезазначеного" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    } else if (step === 11) {
        keyboard = [
            [{ text: "Так" }, { text: "Ні" }],
            [{ text: "Поки не хочу відповідати" }],
            [{ text: "❌ Скасувати реєстрацію" }]
        ];
    }

    const introText = isFriendRegistrationMode(user)
        ? `📝 <b>Реєстрація подруги на ${user.selectedEventsList.length} заходи</b>\n\nВнесіть дані подруги:\n\n`
        : `📝 <b>Реєстрація на ${user.selectedEventsList.length} заходи</b>\n\nЗаповніть лише відсутні дані:\n\n`;

    bot.sendMessage(chatId, 
        introText +
        `${question}`, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard,
            resize_keyboard: true
        }
    });
}

async function registerForSelectedEvent(chatId, user, providedName, providedPhone, options = {}) {
    const eventId = user.selectedEventId;
    const eventName = user.selectedEventName;
    if (!eventId || !eventName) {
        return { status: 'no-selection' };
    }

    const skipReminders = options.skipReminders === true;
    const reserveMode = options.reserveMode === true;
    const reminderOwnerChatId = skipReminders
        ? String(options.reminderOwnerChatId || '').trim()
        : String(options.reminderOwnerChatId || chatId || '').trim();

    const seatsLeft = await getSeatsLeft(eventId);
    if (seatsLeft <= 0) {
        if (reserveMode) {
            return await registerForSelectedEventReserve(chatId, user, providedName, providedPhone, options);
        }
        return { status: 'no-seats' };
    }

    const registrantProfile = await resolveRegistrantProfile(chatId, user, providedName || '', providedPhone || '');
    const friendRegistrationKey = buildFriendRegistrationKey(eventId, registrantProfile.name, registrantProfile.phone);

    const evObj = events.find(e => e.id === eventId);

    // Додаткова перевірка дублікату після рестарту бота: дивимось запис у нотатці таблиці
    if (evObj) {
        const duplicateInSheet = await isRegistrantAlreadyInEventNote(evObj, registrantProfile);
        if (duplicateInSheet) {
            return { status: 'already-registered' };
        }
    }
    
    // Перевіряємо дублікати в пам'яті (не в таблиці)
    if (!skipReminders && evObj && userEventRegistrations[chatId]) {
        const alreadyAdded = userEventRegistrations[chatId].some(r => r.eventId === eventId);
        if (alreadyAdded) {
            return { status: 'already-registered' };
        }
    }

    if (skipReminders && evObj && friendEventRegistrations[chatId]) {
        const alreadyAdded = friendEventRegistrations[chatId].some((registration) => registration.registrationKey === friendRegistrationKey);
        if (alreadyAdded) {
            return { status: 'already-registered' };
        }
    }

    // Оновлюємо лічильник у розкладі та зберігаємо реєстрацію у листі "Зареєстровані"
    if (evObj) {
        await appendEventRegistration(eventId, chatId, {
            name: registrantProfile.name,
            phone: registrantProfile.phone,
            eventName: evObj.name,
            eventDate: evObj.date
        });
        await incrementSheetRegistration(evObj, registrantProfile);
        evObj.registrations = (evObj.registrations || 0) + 1;
    }

    if (user.step === 7) {
        if (!user.selectedEvents) user.selectedEvents = [];
        user.selectedEvents.push({ id: eventId, name: eventName });
    }
    
    // Зберігаємо реєстрацію для нагадувань
    if (!skipReminders && evObj && evObj.date) {
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
            recordFeedbackCandidate(chatId, evObj.date, eventName);
            saveReminderStateToDisk();
            logger.info(`Saved reminder registration: ${chatId} → ${eventName}`);
            // record undo action for this chat
            try { recordRecentAction(chatId, { type: 'register', eventId }); } catch (e) { logger.warn('recordRecentAction failed', e && e.message ? e.message : e); }
        }
    }

    if (skipReminders && evObj && evObj.date) {
        if (!friendEventRegistrations[chatId]) {
            friendEventRegistrations[chatId] = [];
        }

        const alreadyAdded = friendEventRegistrations[chatId].some((registration) => registration.registrationKey === friendRegistrationKey);
        if (!alreadyAdded) {
            friendEventRegistrations[chatId].push({
                registrationKey: friendRegistrationKey,
                eventId,
                eventName,
                eventDate: evObj.date,
                registrantName: registrantProfile.name,
                registrantPhone: registrantProfile.phone
            });

            if (reminderOwnerChatId) {
                if (!userEventRegistrations[reminderOwnerChatId]) {
                    userEventRegistrations[reminderOwnerChatId] = [];
                }

                const ownerAlreadyAdded = userEventRegistrations[reminderOwnerChatId]
                    .some((registration) => registration.eventId === eventId);
                if (!ownerAlreadyAdded) {
                    userEventRegistrations[reminderOwnerChatId].push({
                        eventId,
                        eventName,
                        eventDate: evObj.date,
                        registrantName: registrantProfile.name,
                        registrantPhone: registrantProfile.phone,
                        reminded24h: false,
                        reminded1h: false
                    });
                    recordFeedbackCandidate(reminderOwnerChatId, evObj.date, eventName);
                    logger.info(`Saved friend reminder registration: ${reminderOwnerChatId} → ${eventName} (${registrantProfile.name || 'без name'})`);
                }
            }

            saveReminderStateToDisk();
            logger.info(`Saved friend registration: ${chatId} → ${eventName} (${registrantProfile.name || 'без name'})`);
        }
    }

    if (evObj) {
        await notifyRegistrantAboutRegistration(chatId, evObj, registrantProfile, { reserveMode: false });
    }

    delete user.selectedEventName;
    delete user.selectedEventId;
    delete user.afishaFullRegistration;
    delete user.afishaPendingEventId;
    delete user.afishaPendingEventName;
    delete user.pendingUnregEventId;
    delete user.pendingFriendUnregKey;
    delete user.pendingFeedbackDateKey;

    return { status: 'ok' };
}

async function registerForSelectedEventReserve(chatId, user, providedName, providedPhone, options = {}) {
    const eventId = user.selectedEventId;
    const eventName = user.selectedEventName;
    if (!eventId || !eventName) {
        return { status: 'no-selection' };
    }

    const skipReminders = options.skipReminders === true;
    const reminderOwnerChatId = skipReminders
        ? String(options.reminderOwnerChatId || '').trim()
        : String(options.reminderOwnerChatId || chatId || '').trim();
    const registrantProfile = await resolveRegistrantProfile(chatId, user, providedName || '', providedPhone || '');
    registrantProfile.userId = reminderOwnerChatId || String(chatId || '');

    const event = events.find((item) => item.id === eventId);
    if (!event) {
        return { status: 'not-found' };
    }

    const duplicateInRegistrations = await isRegistrantAlreadyInEventNote(event, registrantProfile);
    if (duplicateInRegistrations) {
        return { status: 'already-registered' };
    }

    const duplicateInReserve = await isRegistrantAlreadyInEventReserveNote(event, registrantProfile);
    if (duplicateInReserve) {
        return { status: 'already-reserved' };
    }

    const added = await addRegistrantToReserve(event, registrantProfile);
    if (!added) {
        return { status: 'already-reserved' };
    }

    if (!skipReminders) {
        if (!userEventReserveRegistrations[chatId]) {
            userEventReserveRegistrations[chatId] = [];
        }

        const exists = userEventReserveRegistrations[chatId].some((entry) => entry.eventId === eventId);
        if (!exists) {
            userEventReserveRegistrations[chatId].push({
                eventId,
                eventName,
                eventDate: event.date,
                registrantName: registrantProfile.name,
                registrantPhone: registrantProfile.phone
            });
            try { recordRecentAction(chatId, { type: 'reserve', eventId }); } catch (e) { logger.warn('recordRecentAction failed', e && e.message ? e.message : e); }
        }
    } else {
        const friendRegistrationKey = buildFriendRegistrationKey(eventId, registrantProfile.name, registrantProfile.phone);
        if (!friendEventReserveRegistrations[chatId]) {
            friendEventReserveRegistrations[chatId] = [];
        }

        const exists = friendEventReserveRegistrations[chatId].some((entry) => entry.registrationKey === friendRegistrationKey);
        if (!exists) {
            friendEventReserveRegistrations[chatId].push({
                registrationKey: friendRegistrationKey,
                eventId,
                eventName,
                eventDate: event.date,
                registrantName: registrantProfile.name,
                registrantPhone: registrantProfile.phone
            });
        }
    }

    await notifyRegistrantAboutRegistration(chatId, event, registrantProfile, { reserveMode: true });

    delete user.selectedEventName;
    delete user.selectedEventId;
    delete user.afishaFullRegistration;
    delete user.afishaPendingEventId;
    delete user.afishaPendingEventName;

    return { status: 'reserved' };
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

    // Видаляємо з пам'яті користувача (включно з можливими дублями того ж запису)
    const registration = userEventRegistrations[chatId][regIndex];
    const targetPhoneKey = normalizeRegistrantPhone(registration && registration.registrantPhone);
    const targetNameKey = normalizeRegistrantName(registration && registration.registrantName);
    const canMatchByIdentity = Boolean(targetPhoneKey || targetNameKey);
    let removedFallbackByIndex = false;
    userEventRegistrations[chatId] = userEventRegistrations[chatId].filter((entry, index) => {
        if (!entry || entry.eventId !== eventId) {
            return true;
        }

        if (!canMatchByIdentity) {
            if (!removedFallbackByIndex && index === regIndex) {
                removedFallbackByIndex = true;
                return false;
            }
            return true;
        }

        const entryPhoneKey = normalizeRegistrantPhone(entry.registrantPhone);
        const entryNameKey = normalizeRegistrantName(entry.registrantName);
        const samePhone = targetPhoneKey && entryPhoneKey && targetPhoneKey === entryPhoneKey;
        const sameName = targetNameKey && entryNameKey && targetNameKey === entryNameKey;

        return !(samePhone || sameName);
    });
    removeFeedbackCandidate(chatId, registration.eventDate, registration.eventName);

    // Очищаємо пустий масив
    if (userEventRegistrations[chatId].length === 0) {
        delete userEventRegistrations[chatId];
    }
    saveReminderStateToDisk();

    // Оновлюємо лічильник в пам'яті (seats = місткість, не чіпаємо)
    const event = events.find(e => e.id === eventId);
    if (event) {
        event.registrations = Math.max(0, (event.registrations || 1) - 1);

        const registrantProfile = await resolveRegistrantProfile(
            chatId,
            users[chatId],
            registration.registrantName,
            registration.registrantPhone
        );
        await decrementSheetRegistration(event, registrantProfile);
        await promoteFirstReserveRegistrantToRegistration(event);
        console.log(`📝 Користувач ${chatId} відписаний від "${registration.eventName}" (місць +1)`);
    }

    return { status: 'ok', eventName: registration.eventName, mode: 'registration' };
}

async function unregisterFromReserve(chatId, eventId) {
    if (!userEventReserveRegistrations[chatId]) {
        return { status: 'not-registered' };
    }

    const regIndex = userEventReserveRegistrations[chatId].findIndex((entry) => entry.eventId === eventId);
    if (regIndex === -1) {
        return { status: 'not-found' };
    }

    const registration = userEventReserveRegistrations[chatId][regIndex];
    userEventReserveRegistrations[chatId].splice(regIndex, 1);

    if (userEventReserveRegistrations[chatId].length === 0) {
        delete userEventReserveRegistrations[chatId];
    }
    saveReminderStateToDisk();

    const event = events.find((eventItem) => eventItem.id === eventId);
    if (event) {
        const removed = await removeRegistrantFromReserve(event, {
            userId: String(chatId || ''),
            name: String(registration.registrantName || '').trim(),
            phone: String(registration.registrantPhone || '').trim()
        });
        if (!removed) {
            return { status: 'not-found' };
        }
        console.log(`🕓 Користувач ${chatId} видалений з резерву "${registration.eventName}"`);
    }

    return { status: 'ok', eventName: registration.eventName, mode: 'reserve' };
}

async function unregisterFriendFromEvent(chatId, registrationKey) {
    if (!friendEventRegistrations[chatId]) {
        return { status: 'not-registered' };
    }

    const regIndex = friendEventRegistrations[chatId].findIndex((registration) => registration.registrationKey === registrationKey);
    if (regIndex === -1) {
        return { status: 'not-found' };
    }

    const registration = friendEventRegistrations[chatId][regIndex];
    friendEventRegistrations[chatId].splice(regIndex, 1);

    if (friendEventRegistrations[chatId].length === 0) {
        delete friendEventRegistrations[chatId];
    }
    saveReminderStateToDisk();

    const event = events.find((eventItem) => eventItem.id === registration.eventId);
    if (event) {
        event.registrations = Math.max(0, (event.registrations || 1) - 1);
        // event.seats = місткість (константа), не змінюємо

        await decrementSheetRegistration(event, {
            userId: String(chatId || ''),
            name: String(registration.registrantName || '').trim(),
            phone: String(registration.registrantPhone || '').trim()
        });
        await promoteFirstReserveRegistrantToRegistration(event);
        console.log(`👭 Подругу відписано від "${registration.eventName}" (chatId=${chatId})`);
    }

    return {
        status: 'ok',
        eventName: registration.eventName,
        registrantName: registration.registrantName
    };
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
    // seats = загальна місткість, реєстрації = зайняті місця
    return Math.max(0, (Number(event.seats) || 0) - (Number(event.registrations) || 0));
}

async function appendEventToSheet(date, time, title, capacity) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    for (const scheduleSheet of SCHEDULE_SHEET_CANDIDATES) {
        try {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${scheduleSheet}!A:F`,
                valueInputOption: "USER_ENTERED",
                requestBody: {
                    values: [[date, time, title, capacity, 0, 0]]
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

async function ensureRegistrationSheetExists() {
    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID || !REGISTRATIONS_SHEET_NAME) {
        return false;
    }

    try {
        const metaResp = await sheetsClient.spreadsheets.get({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            fields: 'sheets.properties.title'
        });
        const titles = (metaResp.data.sheets || []).map((sheet) => sheet && sheet.properties && sheet.properties.title ? sheet.properties.title : '');
        if (titles.includes(REGISTRATIONS_SHEET_NAME)) {
            return true;
        }

        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            requestBody: {
                requests: [{ addSheet: { properties: { title: REGISTRATIONS_SHEET_NAME } } }]
            }
        });

        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            range: `${REGISTRATIONS_SHEET_NAME}!A1:E1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['Дата реєстрації', 'ПІБ', 'Телефон', 'Назва заходу', 'Дата заходу']] }
        });
        return true;
    } catch (error) {
        console.error('❌ Не вдалося створити/перевірити лист реєстрацій:', error && error.message ? error.message : error);
        return false;
    }
}

async function appendEventRegistration(eventId, userId, registrantInfo) {
    if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID || !REGISTRATIONS_SHEET_NAME) {
        return false;
    }

    const resolvedName = String((registrantInfo && registrantInfo.name) || '').trim();
    const resolvedPhone = String((registrantInfo && registrantInfo.phone) || '').trim();
    const resolvedEventName = String((registrantInfo && registrantInfo.eventName) || (registrantInfo && registrantInfo.event && registrantInfo.event.name) || '').trim();
    const resolvedEventDate = registrantInfo && registrantInfo.eventDate
        ? formatSheetDate(registrantInfo.eventDate)
        : '';

    if (!resolvedName && !resolvedPhone && !resolvedEventName) {
        return false;
    }

    try {
        await ensureRegistrationSheetExists();
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            range: `${REGISTRATIONS_SHEET_NAME}!A:E`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[new Date().toISOString(), resolvedName, resolvedPhone, resolvedEventName, resolvedEventDate]]
            }
        });
        return true;
    } catch (error) {
        console.error('❌ Не вдалося додати реєстрацію в лист "Зареєстровані":', error && error.message ? error.message : error);
        return false;
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
                registrations: 0,
                reserveCount: 0
            });

            await appendEventToSheet(evt.date, evt.time, evt.title, evt.capacity);
            console.log(`   💾 Записано в Sheets: ${evt.title}`);
        }
        }
    }

    const AI_INTENT_TAGS = ['SHOW_DAY', 'REGISTER_EVENT', 'SHOW_AFFISHA', 'UNKNOWN'];

    function getMainMenuKeyboard() {
        return [
            [{ text: MAIN_MENU_BUTTONS.afisha }],
            [{ text: MAIN_MENU_BUTTONS.unsubscribe }],
            [{ text: MAIN_MENU_BUTTONS.friend }],
            [{ text: MAIN_MENU_BUTTONS.editProfile }],
            [{ text: MAIN_MENU_BUTTONS.consultations }],
            [{ text: MAIN_MENU_BUTTONS.violenceHelp }],
            [{ text: MAIN_MENU_BUTTONS.reminders }],
            [{ text: MAIN_MENU_BUTTONS.contacts }]
        ];
    }

    function isAdminChatId(chatId) {
        const normalizedChatId = Number(String(chatId || '').trim());
        if (!Number.isFinite(normalizedChatId)) {
            return false;
        }

        return ADMIN_CHAT_IDS.includes(normalizedChatId);
    }

    function buildViolenceHelpKeyboard(chatId) {
        const keyboard = [
            [{ text: VIOLENCE_HELP_BUTTONS.urgentNow }],
            [{ text: VIOLENCE_HELP_BUTTONS.hotlines }, { text: VIOLENCE_HELP_BUTTONS.police }],
            [{ text: VIOLENCE_HELP_BUTTONS.specializedServices }],
            [{ text: VIOLENCE_HELP_BUTTONS.socialPsychologicalHelp }],
            [{ text: VIOLENCE_HELP_BUTTONS.legalHelp }],
            [{ text: VIOLENCE_HELP_BUTTONS.medicalHelp }],
            [{ text: NAVIGATION_BUTTONS.back }],
            [{ text: NAVIGATION_BUTTONS.menu }]
        ];

        if (isAdminChatId(chatId)) {
            keyboard.splice(4, 0, [{ text: VIOLENCE_HELP_BUTTONS.coordinationAdministrativeHelp }]);
        }

        return keyboard;
    }

    function buildViolenceHelpDistrictKeyboard() {
        return [
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.dnipro }],
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.kryvyiRih }],
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.kamianske }],
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.samar }],
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.pavlohrad }],
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.nikopol }],
            [{ text: VIOLENCE_HELP_DISTRICT_BUTTONS.synelnykove }],
            [{ text: NAVIGATION_BUTTONS.back }],
            [{ text: NAVIGATION_BUTTONS.menu }]
        ];
    }

    function buildViolenceHelpSpecializedTypeKeyboard() {
        return [
            [{ text: VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades }],
            [{ text: VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices }],
            [{ text: VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.dayCenters }],
            [{ text: VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.shelters }],
            [{ text: NAVIGATION_BUTTONS.back }],
            [{ text: NAVIGATION_BUTTONS.menu }]
        ];
    }

    function buildViolenceHelpSocialDistrictKeyboard() {
        return [
            [{ text: VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.regional }],
            [{ text: VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.dnipro }],
            [{ text: VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.kamianske }],
            [{ text: VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.kryvyiRih }],
            [{ text: VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.pavlohrad }],
            [{ text: NAVIGATION_BUTTONS.back }],
            [{ text: NAVIGATION_BUTTONS.menu }]
        ];
    }

    function clearConsultationState(user) {
        if (!user) {
            return;
        }
        delete user.consultationDraft;
        if (String(user.context || '').startsWith('consultation-')) {
            user.context = null;
        }
    }

    function buildConsultationSpecialistMenuKeyboard() {
        return [
            [{ text: CONSULTATION_SPECIALIST_BUTTONS.social }],
            [{ text: CONSULTATION_SPECIALIST_BUTTONS.psychologist }],
            [{ text: NAVIGATION_BUTTONS.menu }]
        ];
    }

    function buildConsultationDatesKeyboard(dateButtons) {
        const dateRows = (dateButtons || []).map((buttonText) => [{ text: buttonText }]);
        dateRows.push([{ text: NAVIGATION_BUTTONS.back }]);
        dateRows.push([{ text: NAVIGATION_BUTTONS.menu }]);
        return dateRows;
    }

    function buildConsultationTimeKeyboard(timeOptions) {
        const rows = [];
        const options = Array.isArray(timeOptions) ? timeOptions : [];

        for (let index = 0; index < options.length; index += 3) {
            const chunk = options.slice(index, index + 3).map((timeText) => ({ text: timeText }));
            if (chunk.length > 0) {
                rows.push(chunk);
            }
        }

        rows.push([{ text: NAVIGATION_BUTTONS.back }]);
        rows.push([{ text: NAVIGATION_BUTTONS.menu }]);
        return rows;
    }

    function getConsultationSpecialistConfigByButton(text) {
        if (matchesCommand(text, CONSULTATION_SPECIALIST_BUTTONS.social, 'Соціальна фахівчиня')) {
            return {
                key: 'social',
                label: 'Соціальна фахівчиня',
                sheetName: SOCIAL_CONSULTATIONS_SHEET_NAME,
                specialistChatId: String(DARYNA_CHAT_ID || '').trim()
            };
        }

        if (matchesCommand(text, CONSULTATION_SPECIALIST_BUTTONS.psychologist, 'Психологиня')) {
            return {
                key: 'psychologist',
                label: 'Психологиня',
                sheetName: PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME,
                specialistChatId: String(LIUDMYLA_CHAT_ID || '').trim()
            };
        }

        return null;
    }

    function formatConsultationDate(date) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = String(date.getFullYear());
        return `${day}.${month}.${year}`;
    }

    function formatConsultationDateButtonLabel(date) {
        const weekdayNumber = date.getDay();
        const weekdayLabel = CONSULTATION_WEEKDAY_LABELS[weekdayNumber] || 'дата';
        const weekdayDisplay = weekdayLabel.charAt(0).toUpperCase() + weekdayLabel.slice(1);
        const emoji = CONSULTATION_WEEKDAY_EMOJI[weekdayNumber] || '📅';
        return `${emoji} ${weekdayDisplay} (${formatConsultationDate(date)})`;
    }

    async function loadAvailableConsultationSlots(sheetName) {
        if (!sheetsClient) {
            throw new Error('Google Sheets client не ініціалізовано');
        }

        if (!PERSONAL_DATA_SPREADSHEET_ID) {
            throw new Error('PERSONAL_DATA_SPREADSHEET_ID не встановлено');
        }

        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            range: `${sheetName}!A:E`
        });

        const now = new Date();
        const rows = response.data.values || [];
        const slots = [];

        for (const [rowIndex, row] of rows.entries()) {
            const dateCell = String((row && row[0]) || '').trim();
            const timeCell = String((row && row[1]) || '').trim();
            const nameCell = String((row && row[2]) || '').trim();
            const phoneCell = String((row && row[3]) || '').trim();

            if (!dateCell || !timeCell) {
                continue;
            }

            const normalizedTime = normalizeTimeValue(timeCell);
            if (!normalizedTime) {
                continue;
            }

            const parsedDate = parseDateValue(dateCell, now.getFullYear());
            if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
                continue;
            }

            const slotDateTime = new Date(
                parsedDate.getFullYear(),
                parsedDate.getMonth(),
                parsedDate.getDate(),
                normalizedTime.hour,
                normalizedTime.minute,
                0,
                0
            );

            if (Number.isNaN(slotDateTime.getTime()) || slotDateTime <= now) {
                continue;
            }

            const weekdayNumber = slotDateTime.getDay();
            if (!CONSULTATION_ALLOWED_WEEKDAYS.has(weekdayNumber)) {
                continue;
            }

            // Вважаємо слот вільним, якщо в C і D ще немає даних учасниці.
            const isOccupied = Boolean(nameCell || phoneCell);
            if (isOccupied) {
                continue;
            }

            slots.push({
                rowNumber: rowIndex + 1,
                dateText: formatConsultationDate(slotDateTime),
                timeText: normalizedTime.text,
                weekdayNumber,
                weekdayLabel: CONSULTATION_WEEKDAY_LABELS[weekdayNumber] || '',
                dateSortValue: slotDateTime.getTime(),
                displayDateButton: formatConsultationDateButtonLabel(slotDateTime)
            });
        }

        slots.sort((left, right) => {
            if (left.dateSortValue !== right.dateSortValue) {
                return left.dateSortValue - right.dateSortValue;
            }
            return String(left.timeText).localeCompare(String(right.timeText), 'uk');
        });

        return slots;
    }

    function buildConsultationDateButtonMap(slots) {
        const dateButtonMap = {};

        for (const slot of slots) {
            if (!slot || !slot.dateText) {
                continue;
            }

            if (Object.values(dateButtonMap).includes(slot.dateText)) {
                continue;
            }

            dateButtonMap[slot.displayDateButton] = slot.dateText;
        }

        return dateButtonMap;
    }

    async function refreshConsultationDraftSlots(draft) {
        if (!draft || !draft.sheetName) {
            return {
                availableSlots: [],
                dateButtonMap: {},
                dateButtons: []
            };
        }

        const availableSlots = await loadAvailableConsultationSlots(draft.sheetName);
        const dateButtonMap = buildConsultationDateButtonMap(availableSlots);
        const dateButtons = Object.keys(dateButtonMap);

        draft.availableSlots = availableSlots;
        draft.dateButtonMap = dateButtonMap;
        draft.dateButtons = dateButtons;

        if (draft.dateText) {
            const hasDate = availableSlots.some((slot) => slot.dateText === draft.dateText);
            if (!hasDate) {
                delete draft.dateText;
                delete draft.timeText;
                delete draft.timeOptions;
                delete draft.selectedSlotRowNumber;
            }
        }

        return { availableSlots, dateButtonMap, dateButtons };
    }

    async function saveIndividualConsultationRow({ sheetName, rowNumber, dateText, timeText, name, phone, requestText }) {
        if (!sheetsClient) {
            throw new Error('Google Sheets client не ініціалізовано');
        }

        if (!PERSONAL_DATA_SPREADSHEET_ID) {
            throw new Error('PERSONAL_DATA_SPREADSHEET_ID не встановлено');
        }

        if (Number.isInteger(rowNumber) && rowNumber > 0) {
            const occupancyResponse = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${sheetName}!C${rowNumber}:D${rowNumber}`
            });
            const occupancyRow = (occupancyResponse.data.values || [])[0] || [];
            const existingName = String(occupancyRow[0] || '').trim();
            const existingPhone = String(occupancyRow[1] || '').trim();

            if (existingName || existingPhone) {
                throw new Error('Обраний час уже зайнятий. Будь ласка, оберіть інший слот.');
            }

            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                range: `${sheetName}!C${rowNumber}:E${rowNumber}`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[name || '', phone || '', requestText || '']]
                }
            });
            return;
        }

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            range: `${sheetName}!A:E`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: [[dateText || '', timeText || '', name || '', phone || '', requestText || '']]
            }
        });
    }

    async function notifySpecialistAboutConsultation({ specialistLabel, specialistChatId, dateText, timeText, name, phone, requestText, userChatId }) {
        if (!specialistChatId) {
            console.warn(`⚠️ Не вказано chat ID для сповіщень: ${specialistLabel}`);
            return false;
        }

        const message = [
            '🆕 <b>Нова реєстрація на індивідуальну консультацію</b>',
            '',
            `👩🏻‍💼 Фахівчиня: ${specialistLabel}`,
            `📅 Дата: ${dateText}`,
            `🕐 Час: ${timeText}`,
            `👤 ПІБ: ${name}`,
            `📞 Телефон: ${phone}`,
            `🆔 Chat ID: <code>${userChatId}</code>`,
            '',
            '📝 Звернення:',
            `<i>${String(requestText || '').trim()}</i>`
        ].join('\n');

        try {
            console.log(`📤 Відправляю сповіщення спеціалісту ${specialistLabel} (Chat ID: ${specialistChatId})...`);
            await bot.sendMessage(specialistChatId, message, {
                parse_mode: 'HTML'
            });
            console.log(`✅ Сповіщення успішно відправлено спеціалісту ${specialistLabel}`);
            return true;
        } catch (error) {
            console.error(`❌ Помилка при відправці сповіщення спеціалісту ${specialistLabel}:`, error && error.message ? error.message : error);
            return false;
        }
    }

    async function showConsultationSpecialistMenu(chatId, noticeText = '') {
        const messageLines = [];
        if (noticeText) {
            messageLines.push(noticeText.trim(), '');
        }
        messageLines.push('🗨️ <b>Індивідуальні консультації</b>');
        messageLines.push('Оберіть фахівчиню:');

        await bot.sendMessage(chatId, messageLines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buildConsultationSpecialistMenuKeyboard(),
                resize_keyboard: true
            }
        });
    }

    async function showUnsubscribeMenu(chatId, user) {
        delete user.unregButtonMap;
        delete user.friendUnregButtonMap;
        delete user.pendingUnregEventId;
        delete user.pendingUnregEventName;
        delete user.pendingFriendUnregKey;
        delete user.pendingFriendUnregEventName;
        delete user.pendingFriendRegistrantName;
        delete user.eventButtonMap;
        delete user.pendingReserveEventId;
        delete user.pendingReserveEventName;
        user.context = 'unsubscribe-root';

        await bot.sendMessage(chatId, 'Оберіть, від чого потрібно відписатись:', {
            reply_markup: {
                keyboard: [
                    [{ text: UNSUBSCRIBE_MENU_BUTTONS.self }],
                    [{ text: UNSUBSCRIBE_MENU_BUTTONS.friend }],
                    [{ text: UNSUBSCRIBE_MENU_BUTTONS.consultation }],
                    [{ text: NAVIGATION_BUTTONS.menu }]
                ],
                resize_keyboard: true
            }
        });
    }

    function normalizeAiIntentTag(value) {
        const raw = String(value || '').trim();
        if (!raw) return 'UNKNOWN';

        const firstLine = raw
            .split(/\r?\n/)[0]
            .replace(/[`"']/g, '')
            .trim()
            .toUpperCase();

        if (AI_INTENT_TAGS.includes(firstLine)) {
            return firstLine;
        }

        const normalized = raw.toLowerCase();
        if (normalized.includes('show_day') || normalized.includes('день')) return 'SHOW_DAY';
        if (normalized.includes('register_event') || normalized.includes('реєстр') || normalized.includes('запис')) return 'REGISTER_EVENT';
        if (normalized.includes('show_affisha') || normalized.includes('афіш')) return 'SHOW_AFFISHA';

        return 'UNKNOWN';
    }

    function extractWeekdayFromText(userText) {
        const source = normalizeText(String(userText || '')).toLowerCase();
        const weekdays = {
            "неділя": true,
            "понеділок": true,
            "вівторок": true,
            "середа": true,
            "четвер": true,
            "п'ятниця": true,
            "субота": true
        };

        const normalizedWhole = normalizeWeekdayKey(source);
        if (weekdays[normalizedWhole]) {
            return normalizedWhole;
        }

        const words = source.split(/\s+/).filter(Boolean);
        for (const word of words) {
            const normalizedWord = normalizeWeekdayKey(word);
            if (weekdays[normalizedWord]) {
                return normalizedWord;
            }
        }

        return null;
    }

    function detectIntentLocally(userText) {
        const text = normalizeText(String(userText || '')).toLowerCase();
        if (!text) return 'UNKNOWN';

        if (extractWeekdayFromText(text)) return 'SHOW_DAY';

        if (text.includes('афіш') || text.includes('розклад') || text.includes('які заход')) {
            return 'SHOW_AFFISHA';
        }

        if (
            text.includes('реєстр') ||
            text.includes('запис') ||
            text.includes('хочу на') ||
            text.includes('майстер-клас')
        ) {
            return 'REGISTER_EVENT';
        }

        return 'UNKNOWN';
    }

    async function detectAiIntentTag(userText) {
        if (!AI_ENABLED || !userText) {
            return null;
        }

        const systemPrompt = [
            'Ти чат-бот простору Вільна.',
            'Якщо користувач вітається — відповідай дружньо.',
            'Якщо користувач пише скорочення днів:',
            'пон = понеділок',
            'вів = вівторок',
            'серед = середа',
            'чет = четвер',
            'пят = п\'ятниця',
            'суб = субота',
            'нед = неділя',
            'Визнач намір користувача.',
            'Поверни тільки один тег:',
            'SHOW_DAY',
            'REGISTER_EVENT',
            'SHOW_AFFISHA',
            'UNKNOWN',
            'Не пояснюй відповідь.'
        ].join('\n');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AI_HTTP_TIMEOUT_MS);

        try {
            const response = await fetch(AI_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${AI_API_KEY}`
                },
                body: JSON.stringify({
                    model: AI_MODEL,
                    temperature: 0.1,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: String(userText).slice(0, 1000) }
                    ]
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const body = await response.text();
                throw new Error(`AI API HTTP ${response.status}: ${body.slice(0, 300)}`);
            }

            const data = await response.json();
            const content = data && data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : '';

            return normalizeAiIntentTag(content);
        } finally {
            clearTimeout(timeout);
        }
    }

    async function handleShowAffishaIntent(chatId, user) {
        if (isFriendRegistrationMode(user)) {
            user.context = 'afisha';
            await showAfishaDaysMenu(chatId);
            return;
        }

        const sheetProfile = await loadKnownUserByChatId(chatId, { forceRefresh: true });
        if (sheetProfile) {
            Object.assign(user, sheetProfile);
        } else if (user.phone) {
            const phoneProfile = await loadKnownUserByPhone(user.phone);
            if (phoneProfile) {
                Object.assign(user, phoneProfile);
            }
        } else if (user.username) {
            const usernameProfile = await loadKnownUserByUsername(user.username);
            if (usernameProfile) {
                Object.assign(user, usernameProfile);
            }
        }

        user.profileHydrated = true;

        const registrantData = await resolveRegistrantFormData(chatId, user);
        const hasCompleteProfile = hasCompleteRegistrationProfile(registrantData);
        const hasExistingProfile = Boolean(sheetProfile || user.name || user.phone);

        if (!hasCompleteProfile && !hasExistingProfile) {
            Object.assign(user, registrantData);
        }

        user.context = 'afisha';
        Object.assign(user, registrantData);
        await showAfishaDaysMenu(chatId);
    }

    async function handleUnsubscribeIntent(chatId, user) {
        await restoreUserRegistrationsFromSheet(chatId, user);
        const userRegistrations = userEventRegistrations[chatId] || [];
        const userReserveRegistrations = userEventReserveRegistrations[chatId] || [];

        if (userRegistrations.length === 0 && userReserveRegistrations.length === 0) {
            await bot.sendMessage(chatId, "📅 У вас немає запланованих заходів для відписання.", {
                reply_markup: {
                    keyboard: [
                        [{ text: NAVIGATION_BUTTONS.back }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        const unregButtonMap = {};
        const toSafeDate = (value) => {
            if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        };
        const allEntries = [
            ...userRegistrations.map((reg) => ({ ...reg, mode: 'registration' })),
            ...userReserveRegistrations.map((reg) => ({ ...reg, mode: 'reserve' }))
        ].sort((left, right) => {
            const leftDate = toSafeDate(left && left.eventDate);
            const rightDate = toSafeDate(right && right.eventDate);
            const leftTs = leftDate ? leftDate.getTime() : 0;
            const rightTs = rightDate ? rightDate.getTime() : 0;
            return leftTs - rightTs;
        });

        const buttons = allEntries.map((reg, index) => {
            const eventDate = toSafeDate(reg.eventDate);
            const dateStr = eventDate ? eventDate.toLocaleDateString('uk-UA', {
                day: '2-digit',
                month: '2-digit'
            }) : '--.--';
            const timeStr = eventDate ? eventDate.toLocaleTimeString('uk-UA', {
                hour: '2-digit',
                minute: '2-digit'
            }) : '--:--';
            const modeLabel = reg.mode === 'reserve' ? '🕓 резерв' : '✅ реєстрація';
            const buttonText = `${index + 1}. ${reg.eventName} (${dateStr} ${timeStr}) — ${modeLabel}`;
            unregButtonMap[buttonText] = {
                eventId: reg.eventId,
                eventName: reg.eventName,
                mode: reg.mode
            };
            return [{ text: buttonText }];
        });

        user.unregButtonMap = unregButtonMap;
        user.context = 'unregister';
        buttons.push([{ text: NAVIGATION_BUTTONS.back }]);

        await bot.sendMessage(chatId, "🔴 <b>Виберіть захід для відписання:</b>", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buttons,
                resize_keyboard: true
            }
        });
    }

    async function loadUserConsultationBookings(name, phone) {
        if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) return [];

        const sheetConfigs = [
            { sheetName: SOCIAL_CONSULTATIONS_SHEET_NAME, specialistLabel: 'Соціальна фахівчиня', specialistChatId: String(DARYNA_CHAT_ID || '').trim() },
            { sheetName: PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME, specialistLabel: 'Психологиня', specialistChatId: String(LIUDMYLA_CHAT_ID || '').trim() }
        ];

        const bookings = [];
        const now = new Date();

        for (const config of sheetConfigs) {
            try {
                const response = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range: `${config.sheetName}!A:E`
                });
                const rows = response.data.values || [];

                for (const [rowIndex, row] of rows.entries()) {
                    const dateCell = String((row && row[0]) || '').trim();
                    const timeCell = String((row && row[1]) || '').trim();
                    const nameCell = String((row && row[2]) || '').trim();
                    const phoneCell = String((row && row[3]) || '').trim();
                    const requestCell = String((row && row[4]) || '').trim();

                    if (!dateCell || !timeCell || !nameCell) continue;

                    const normalizedRowName = nameCell.toLowerCase().replace(/\s+/g, ' ').trim();
                    const normalizedUserName = (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
                    const normalizedRowPhone = phoneCell.replace(/\D/g, '');
                    const normalizedUserPhone = (phone || '').replace(/\D/g, '');

                    const nameMatches = normalizedRowName === normalizedUserName;
                    const phoneMatches = normalizedRowPhone && normalizedUserPhone && normalizedRowPhone === normalizedUserPhone;

                    if (!nameMatches && !phoneMatches) continue;

                    const parsedDate = parseDateValue(dateCell, now.getFullYear());
                    if (!parsedDate) continue;
                    const normalizedTime = normalizeTimeValue(timeCell);
                    if (!normalizedTime) continue;

                    const slotDateTime = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate(), normalizedTime.hour, normalizedTime.minute);
                    if (slotDateTime <= now) continue;

                    bookings.push({
                        rowNumber: rowIndex + 1,
                        sheetName: config.sheetName,
                        specialistLabel: config.specialistLabel,
                        specialistChatId: config.specialistChatId,
                        dateText: dateCell,
                        timeText: normalizedTime.text,
                        name: nameCell,
                        phone: phoneCell,
                        requestText: requestCell
                    });
                }
            } catch (err) {
                console.error(`❌ Помилка читання аркуша ${config.sheetName} для скасування:`, err && err.message ? err.message : err);
            }
        }

        return bookings;
    }

    async function cancelConsultationRow(sheetName, rowNumber) {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
            range: `${sheetName}!C${rowNumber}:E${rowNumber}`,
            valueInputOption: 'RAW',
            requestBody: { values: [['', '', '']] }
        });
    }

    async function notifySpecialistAboutCancellation({ specialistLabel, specialistChatId, dateText, timeText, name, phone, userChatId }) {
        if (!specialistChatId) {
            console.warn(`⚠️ Не вказано chat ID для сповіщення про скасування: ${specialistLabel}`);
            return;
        }

        const message = [
            '❌ <b>Скасування запису на консультацію</b>',
            '',
            `👩🏻‍💼 Фахівчиня: ${specialistLabel}`,
            `📅 Дата: ${dateText}`,
            `🕐 Час: ${timeText}`,
            `👤 ПІБ: ${name}`,
            `📞 Телефон: ${phone}`,
            `🆔 Chat ID: <code>${userChatId}</code>`,
        ].join('\n');

        try {
            await bot.sendMessage(specialistChatId, message, { parse_mode: 'HTML' });
        } catch (err) {
            console.error(`❌ Помилка сповіщення про скасування для ${specialistLabel}:`, err && err.message ? err.message : err);
        }
    }

    async function handleCancelConsultationIntent(chatId, user) {
        const name = knownUsers[chatId]?.name || user.name || '';
        const phone = knownUsers[chatId]?.phone || user.phone || '';

        if (!name && !phone) {
            await bot.sendMessage(chatId,
                '⚠️ Не вдалося визначити ваші дані. Будь ласка, спочатку заповніть анкету через «Афіша заходів».', {
                reply_markup: { keyboard: [[{ text: NAVIGATION_BUTTONS.menu }]], resize_keyboard: true }
            });
            return;
        }

        let bookings = [];
        try {
            bookings = await loadUserConsultationBookings(name, phone);
        } catch (err) {
            console.error('❌ Помилка завантаження бронювань:', err && err.message ? err.message : err);
            await bot.sendMessage(chatId, '❌ Не вдалося завантажити ваші записи. Спробуйте пізніше.', {
                reply_markup: { keyboard: [[{ text: NAVIGATION_BUTTONS.menu }]], resize_keyboard: true }
            });
            return;
        }

        if (bookings.length === 0) {
            await bot.sendMessage(chatId,
                '📅 У вас немає майбутніх записів на індивідуальну консультацію.', {
                reply_markup: { keyboard: [[{ text: NAVIGATION_BUTTONS.back }], [{ text: NAVIGATION_BUTTONS.menu }]], resize_keyboard: true }
            });
            return;
        }

        const cancelButtonMap = {};
        const buttons = bookings.map((booking, index) => {
            const buttonText = `${index + 1}. ${booking.specialistLabel} — ${booking.dateText} ${booking.timeText}`;
            cancelButtonMap[buttonText] = index;
            return [{ text: buttonText }];
        });

        user.context = 'cancel-consultation-select';
        user.cancelConsultationBookings = bookings;
        user.cancelConsultationButtonMap = cancelButtonMap;

        buttons.push([{ text: NAVIGATION_BUTTONS.back }]);

        await bot.sendMessage(chatId, '🗨️ <b>Оберіть запис для скасування:</b>', {
            parse_mode: 'HTML',
            reply_markup: { keyboard: buttons, resize_keyboard: true }
        });
    }

    async function handleFriendUnsubscribeIntent(chatId, user) {
        const registrations = friendEventRegistrations[chatId] || [];

        if (registrations.length === 0) {
            await bot.sendMessage(chatId, "👭 Наразі немає реєстрацій подруги для відписки.", {
                reply_markup: {
                    keyboard: [
                        [{ text: NAVIGATION_BUTTONS.back }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        const friendUnregButtonMap = {};
        const buttons = registrations.map((registration, index) => {
            const dateStr = registration.eventDate.toLocaleDateString('uk-UA', {
                day: '2-digit',
                month: '2-digit'
            });
            const timeStr = registration.eventDate.toLocaleTimeString('uk-UA', {
                hour: '2-digit',
                minute: '2-digit'
            });
            const friendLabel = registration.registrantName ? ` — ${registration.registrantName}` : '';
            const buttonText = `${index + 1}. ${registration.eventName}${friendLabel} (${dateStr} ${timeStr})`;
            friendUnregButtonMap[buttonText] = registration.registrationKey;
            return [{ text: buttonText }];
        });

        user.friendUnregButtonMap = friendUnregButtonMap;
        user.context = 'friend-unregister';
        buttons.push([{ text: NAVIGATION_BUTTONS.back }]);

        await bot.sendMessage(chatId, '👭 <b>Виберіть реєстрацію подруги для відписки:</b>', {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buttons,
                resize_keyboard: true
            }
        });
    }

    async function handleIntentTag(chatId, user, intentTag, sourceText) {
        if (intentTag === 'SHOW_DAY') {
            const day = extractWeekdayFromText(sourceText);
            if (day) {
                await showDayAgenda(chatId, day);
            } else {
                await showAfishaDaysMenu(chatId);
            }
            return true;
        }

        if (intentTag === 'REGISTER_EVENT' || intentTag === 'SHOW_AFFISHA') {
            await handleShowAffishaIntent(chatId, user);
            return true;
        }

        return false;
    }

    function parsePositiveChatId(rawValue) {
        const normalizedText = String(rawValue || '').trim();
        if (!/^\d{6,}$/.test(normalizedText)) return null;
        const numericId = Number(normalizedText);
        if (!Number.isFinite(numericId) || numericId <= 0) return null;
        return numericId;
    }

    function normalizePhoneForBroadcast(value) {
        return String(value || '').replace(/\D/g, '');
    }

    function normalizeUsernameForBroadcast(value) {
        return String(value || '').trim().toLowerCase().replace(/^@+/, '');
    }

    function normalizeNameForBroadcast(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function parseBroadcastSelectorToken(rawToken) {
        const token = String(rawToken || '').trim().replace(/^[,;]+|[,;]+$/g, '');
        if (!token) return null;

        const usernameMatch = token.match(/^@([a-zA-Z0-9_]{3,})$/);
        if (usernameMatch) {
            return {
                raw: token,
                type: 'username',
                value: normalizeUsernameForBroadcast(usernameMatch[1])
            };
        }

        const normalizedPhone = normalizePhoneForBroadcast(token);
        if (normalizedPhone.length >= 10) {
            return {
                raw: token,
                type: 'phone',
                value: normalizedPhone
            };
        }

        return null;
    }

    function parseBroadcastSelectorsLine(line) {
        const source = String(line || '').trim();
        if (!source) {
            return [];
        }

        const rawTokens = source.match(/\S+/g) || [];
        if (rawTokens.length === 0) {
            return [];
        }

        const selectors = [];
        for (const rawToken of rawTokens) {
            const selector = parseBroadcastSelectorToken(rawToken);
            if (!selector) {
                return [];
            }
            selectors.push(selector);
        }

        return selectors;
    }

    function parseOwnerBroadcastRequest(messageText) {
        const rawText = String(messageText || '');
        const targetedTriggerMatch = rawText.match(BROADCAST_TARGETED_TRIGGER_REGEX);
        const allTriggerMatch = rawText.match(BROADCAST_ALL_TRIGGER_REGEX);
        const triggerMatch = targetedTriggerMatch || allTriggerMatch;
        if (!triggerMatch) {
            return null;
        }

        const triggerMode = targetedTriggerMatch ? 'targeted' : 'all';

        const textAfterTrigger = rawText.slice(triggerMatch.index + triggerMatch[0].length).trim();
        if (!textAfterTrigger) {
            return { mode: triggerMode === 'targeted' ? 'targeted-empty-message' : 'empty' };
        }

        const lines = textAfterTrigger.split(/\r?\n/);
        if (triggerMode === 'targeted') {
            const firstLine = String(lines[0] || '').trim();
            const separatorIndex = firstLine.indexOf('.');
            const selectorsSource = separatorIndex >= 0
                ? firstLine.slice(0, separatorIndex).trim()
                : firstLine;
            const inlineMessage = separatorIndex >= 0
                ? firstLine.slice(separatorIndex + 1).trim()
                : '';
            const selectors = parseBroadcastSelectorsLine(selectorsSource);
            const targetedText = [inlineMessage, ...lines.slice(1)]
                .filter((part) => String(part || '').trim())
                .join('\n')
                .trim();
            if (selectors.length === 0 || !targetedText) {
                return {
                    mode: 'targeted-empty-message',
                    selectors
                };
            }

            return {
                mode: 'targeted',
                selectors,
                text: targetedText
            };
        }

        return {
            mode: 'all',
            text: rawText
        };
    }

    function mergeBroadcastDirectoryEntry(entriesByKey, entry) {
        if (!entry || !entry.key) {
            return;
        }

        if (!entriesByKey.has(entry.key)) {
            entriesByKey.set(entry.key, {
                kind: entry.kind,
                value: entry.value,
                key: entry.key,
                usernames: new Set(),
                phones: new Set(),
                names: new Set()
            });
        }

        const targetEntry = entriesByKey.get(entry.key);
        const usernameKey = normalizeUsernameForBroadcast(entry.username);
        const phoneKey = normalizePhoneForBroadcast(entry.phone);
        const nameKey = normalizeNameForBroadcast(entry.name);

        if (usernameKey) targetEntry.usernames.add(usernameKey);
        if (phoneKey) targetEntry.phones.add(phoneKey);
        if (nameKey) targetEntry.names.add(nameKey);
    }

    async function loadBroadcastRecipientDirectory(ownerChatId, inMemoryIndex) {
        const entriesByKey = new Map();

        const addChatEntry = (rawChatId, profile) => {
            const chatId = parsePositiveChatId(rawChatId);
            if (!chatId || chatId === ownerChatId) {
                return;
            }

            mergeBroadcastDirectoryEntry(entriesByKey, {
                kind: 'chatId',
                value: chatId,
                key: `id:${chatId}`,
                username: profile && profile.username,
                phone: profile && profile.phone,
                name: profile && profile.name
            });
        };

        for (const [rawChatId, profile] of Object.entries(knownUsers || {})) {
            addChatEntry(rawChatId, profile);
        }

        for (const [rawChatId, profile] of Object.entries(users || {})) {
            addChatEntry(rawChatId, profile || {});
        }

        if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
            return Array.from(entriesByKey.values());
        }

        const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:L`, 'A:L', `${PERSONAL_DATA_SHEET_NAME}!A:G`, 'A:G'];
        for (const range of rangesToTry) {
            try {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range
                });
                const rows = resp.data.values || [];

                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i] || [];
                    const username = row[0];
                    const name = row[1];
                    const phone = row[2];

                    const directChatId = parsePositiveChatId(row[12]) || parsePositiveChatId(row[11]) || parsePositiveChatId(row[10]) || parsePositiveChatId(row[6]);
                    const usernameKey = normalizeUsernameForBroadcast(username);
                    const phoneKey = normalizePhoneForBroadcast(phone);
                    const nameKey = normalizeNameForBroadcast(name);

                    const resolvedChatId = directChatId
                        || (usernameKey && inMemoryIndex.usernameToChatId.get(usernameKey))
                        || (phoneKey && inMemoryIndex.phoneToChatId.get(phoneKey))
                        || (nameKey && inMemoryIndex.nameToChatId.get(nameKey))
                        || null;

                    if (resolvedChatId) {
                        mergeBroadcastDirectoryEntry(entriesByKey, {
                            kind: 'chatId',
                            value: resolvedChatId,
                            key: `id:${resolvedChatId}`,
                            username,
                            phone,
                            name
                        });
                        continue;
                    }

                    if (usernameKey) {
                        mergeBroadcastDirectoryEntry(entriesByKey, {
                            kind: 'username',
                            value: `@${usernameKey}`,
                            key: `username:${usernameKey}`,
                            username,
                            phone,
                            name
                        });
                    }
                }

                if (rows.length > 0) {
                    break;
                }
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
                if (msg.includes('unable to parse range') || msg.includes('not found')) {
                    continue;
                }
                console.error('❌ Не вдалося завантажити довідник отримувачів для адресної розсилки:', e && e.message ? e.message : e);
                break;
            }
        }

        return Array.from(entriesByKey.values());
    }

    function resolveBroadcastRecipientsBySelectors(directory, selectors) {
        const recipientsByKey = new Map();
        const unresolved = [];

        for (const selector of selectors || []) {
            const matches = (directory || []).filter((entry) => {
                if (!entry) return false;
                if (selector.type === 'username') {
                    return entry.usernames && entry.usernames.has(selector.value);
                }
                if (selector.type === 'phone') {
                    return entry.phones && entry.phones.has(selector.value);
                }
                return false;
            });

            if (matches.length === 0) {
                unresolved.push(selector.raw);
                continue;
            }

            for (const match of matches) {
                recipientsByKey.set(match.key, match);
            }
        }

        return {
            recipients: Array.from(recipientsByKey.values()),
            unresolved
        };
    }

    function buildBroadcastRecipientLabel(recipient) {
        if (!recipient) {
            return 'невідомий отримувач';
        }

        const usernames = recipient.usernames ? Array.from(recipient.usernames) : [];
        const phones = recipient.phones ? Array.from(recipient.phones) : [];
        const names = recipient.names ? Array.from(recipient.names) : [];

        if (usernames.length > 0) {
            return `@${usernames[0]}`;
        }

        if (phones.length > 0) {
            return phones[0];
        }

        if (names.length > 0) {
            return names[0];
        }

        if (recipient.kind === 'username' && recipient.value) {
            return String(recipient.value);
        }

        if (recipient.kind === 'chatId' && recipient.value) {
            return `chatId ${recipient.value}`;
        }

        return String(recipient.key || 'невідомий отримувач');
    }

    function buildInMemoryRecipientIndex(ownerChatId) {
        const explicitChatIds = new Set();
        const usernameToChatId = new Map();
        const phoneToChatId = new Map();
        const nameToChatId = new Map();

        const maybeAddChatId = (rawId) => {
            const chatId = parsePositiveChatId(rawId);
            if (!chatId || chatId === ownerChatId) return null;
            explicitChatIds.add(chatId);
            return chatId;
        };

        const attachProfile = (chatId, profile) => {
            if (!chatId || !profile) return;
            const usernameKey = normalizeUsernameForBroadcast(profile.username);
            const phoneKey = normalizePhoneForBroadcast(profile.phone);
            const nameKey = normalizeNameForBroadcast(profile.name);
            if (usernameKey) usernameToChatId.set(usernameKey, chatId);
            if (phoneKey) phoneToChatId.set(phoneKey, chatId);
            if (nameKey) nameToChatId.set(nameKey, chatId);
        };

        for (const [rawChatId, profile] of Object.entries(knownUsers || {})) {
            const chatId = maybeAddChatId(rawChatId);
            attachProfile(chatId, profile);
        }

        Object.keys(userEventRegistrations || {}).forEach(maybeAddChatId);

        for (const [rawChatId, profile] of Object.entries(users || {})) {
            const chatId = maybeAddChatId(rawChatId);
            attachProfile(chatId, profile || {});
        }

        for (const seenId of seenChatIds) {
            maybeAddChatId(seenId);
        }

        return {
            explicitChatIds,
            usernameToChatId,
            phoneToChatId,
            nameToChatId
        };
    }

    async function loadBroadcastTargetsFromSheet(ownerChatId, inMemoryIndex) {
        if (!sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
            return [];
        }

        const targetsByKey = new Map();
        const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:L`, 'A:L', `${PERSONAL_DATA_SHEET_NAME}!A:G`, 'A:G'];

        const addChatIdTarget = (rawId) => {
            const chatId = parsePositiveChatId(rawId);
            if (!chatId || chatId === ownerChatId) return;
            const key = `id:${chatId}`;
            if (!targetsByKey.has(key)) {
                targetsByKey.set(key, { kind: 'chatId', value: chatId, key });
            }
        };

        const addUsernameTarget = (rawUsername) => {
            const username = normalizeUsernameForBroadcast(rawUsername);
            if (!username) return;
            const key = `username:${username}`;
            if (!targetsByKey.has(key)) {
                targetsByKey.set(key, { kind: 'username', value: `@${username}`, key });
            }
        };

        for (const range of rangesToTry) {
            try {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range
                });
                const rows = resp.data.values || [];

                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i] || [];

                    const directChatId = parsePositiveChatId(row[11]) || parsePositiveChatId(row[10]) || parsePositiveChatId(row[6]);
                    if (directChatId) {
                        addChatIdTarget(directChatId);
                        continue;
                    }

                    const usernameKey = normalizeUsernameForBroadcast(row[0]);
                    const phoneKey = normalizePhoneForBroadcast(row[2]);
                    const nameKey = normalizeNameForBroadcast(row[1]);

                    const resolvedChatId =
                        (usernameKey && inMemoryIndex.usernameToChatId.get(usernameKey)) ||
                        (phoneKey && inMemoryIndex.phoneToChatId.get(phoneKey)) ||
                        (nameKey && inMemoryIndex.nameToChatId.get(nameKey)) ||
                        null;

                    if (resolvedChatId) {
                        addChatIdTarget(resolvedChatId);
                        continue;
                    }

                    addUsernameTarget(row[0]);
                }

                if (targetsByKey.size > 0) {
                    break;
                }
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
                if (msg.includes('unable to parse range') || msg.includes('not found')) {
                    continue;
                }
                console.error('❌ Не вдалося завантажити отримувачів розсилки з таблиці:', e && e.message ? e.message : e);
                break;
            }
        }

        return Array.from(targetsByKey.values());
    }

    async function autoBackfillChatIdForRegisteredUser(chatId, msgFrom, activeUser) {
        const targetChatId = parsePositiveChatId(chatId);
        if (!targetChatId || !sheetsClient || !PERSONAL_DATA_SPREADSHEET_ID) {
            return false;
        }

        const username = normalizeUsernameForBroadcast(msgFrom && msgFrom.username);
        const phone = normalizePhoneForBroadcast((activeUser && activeUser.phone) || (knownUsers[targetChatId] && knownUsers[targetChatId].phone));
        const name = normalizeNameForBroadcast((activeUser && activeUser.name) || (knownUsers[targetChatId] && knownUsers[targetChatId].name));

        if (!username && !phone && !name) {
            return false;
        }

        const rangesToTry = [`${PERSONAL_DATA_SHEET_NAME}!A:M`, 'A:M'];

        for (const range of rangesToTry) {
            try {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range
                });
                const rows = resp.data.values || [];

                let bestRowNumber = null;
                let bestScore = 0;
                let nameMatchCount = 0;
                let lastNameMatchRow = null;

                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i] || [];
                    const rowChatId = parsePositiveChatId(row[12]) || parsePositiveChatId(row[11]) || parsePositiveChatId(row[10]) || parsePositiveChatId(row[6]);
                    if (rowChatId === targetChatId) {
                        return false;
                    }
                    if (rowChatId && rowChatId !== targetChatId) {
                        continue;
                    }

                    const rowUsername = normalizeUsernameForBroadcast(row[0]);
                    const rowPhone = normalizePhoneForBroadcast(row[2]);
                    const rowName = normalizeNameForBroadcast(row[1]);

                    let score = 0;
                    if (username && rowUsername && rowUsername === username) score = Math.max(score, 5);
                    if (phone && rowPhone && rowPhone === phone) score = Math.max(score, 4);
                    if (name && rowName && rowName === name) {
                        score = Math.max(score, 2);
                        nameMatchCount += 1;
                        lastNameMatchRow = i + 1;
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        bestRowNumber = i + 1;
                    }
                }

                if (bestScore < 4 && !(bestScore === 2 && nameMatchCount === 1)) {
                    return false;
                }

                if (bestScore === 2 && nameMatchCount === 1 && lastNameMatchRow) {
                    bestRowNumber = lastNameMatchRow;
                }

                if (!bestRowNumber) {
                    return false;
                }

                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId: PERSONAL_DATA_SPREADSHEET_ID,
                    range: `${PERSONAL_DATA_SHEET_NAME}!M${bestRowNumber}:M${bestRowNumber}`,
                    valueInputOption: 'RAW',
                    requestBody: {
                        values: [[String(targetChatId)]]
                    }
                });

                console.log(`✅ Auto-backfill chatId=${targetChatId} у рядок ${bestRowNumber} (${PERSONAL_DATA_SHEET_NAME})`);
                return true;
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
                if (msg.includes('unable to parse range') || msg.includes('not found')) {
                    continue;
                }
                console.error('❌ Auto-backfill chatId failed:', e && e.message ? e.message : e);
                return false;
            }
        }

        return false;
    }

    async function tryHandleOwnerBroadcast(chatId, messageText) {
        if (!Number.isFinite(BROADCAST_OWNER_CHAT_ID) || chatId !== BROADCAST_OWNER_CHAT_ID) {
            return false;
        }

        const broadcastRequest = parseOwnerBroadcastRequest(messageText);
        if (broadcastRequest === null) {
            return false;
        }

        if (broadcastRequest.mode === 'empty') {
            await bot.sendMessage(chatId, 'Напишіть текст повідомлення і додайте в нього знак ❗️ для розсилки всім.');
            return true;
        }

        if (broadcastRequest.mode === 'targeted-empty-message') {
            await bot.sendMessage(chatId, 'Для адресної розсилки використовуйте формат: ❕телефон, @username. текст повідомлення\n\nПриклад:\n❕380501234567, @username. Текст повідомлення');
            return true;
        }

        const inMemoryIndex = buildInMemoryRecipientIndex(chatId);

        if (broadcastRequest.mode === 'targeted') {
            const directory = await loadBroadcastRecipientDirectory(chatId, inMemoryIndex);
            const { recipients, unresolved } = resolveBroadcastRecipientsBySelectors(directory, broadcastRequest.selectors);

            if (recipients.length === 0) {
                const unresolvedHint = unresolved.length > 0
                    ? `\nНе знайдено: ${unresolved.join(', ')}`
                    : '';
                await bot.sendMessage(chatId, `Не знайдено жодного адресата для адресної розсилки.${unresolvedHint}`);
                return true;
            }

            let sentCount = 0;
            let failedCount = 0;
            const sentLabels = [];
            const failedLabels = [];

            for (const recipient of recipients) {
                const destination = recipient.kind === 'chatId' ? recipient.value : recipient.value;
                const recipientLabel = buildBroadcastRecipientLabel(recipient);
                try {
                    await bot.sendMessage(destination, broadcastRequest.text);
                    sentCount += 1;
                    sentLabels.push(recipientLabel);
                } catch (error) {
                    failedCount += 1;
                    failedLabels.push(recipientLabel);
                    console.error(`❌ Targeted broadcast send failed for ${recipient.key}:`, error && error.message ? error.message : error);
                }
            }

            const sentLine = sentLabels.length > 0
                ? `\nНадіслано: ${sentLabels.join(', ')}`
                : '';
            const failedLine = failedLabels.length > 0
                ? `\nНе відправлено: ${failedLabels.join(', ')}`
                : '';
            const unresolvedLine = unresolved.length > 0
                ? `\nНе знайдено: ${unresolved.join(', ')}`
                : '';
            await bot.sendMessage(chatId, `📨 Адресну розсилку виконано. Успішно: ${sentCount}, Помилки: ${failedCount}${sentLine}${failedLine}${unresolvedLine}`);
            return true;
        }

        const recipientsByKey = new Map();

        for (const recipientChatId of inMemoryIndex.explicitChatIds) {
            const key = `id:${recipientChatId}`;
            recipientsByKey.set(key, { kind: 'chatId', value: recipientChatId, key });
        }

        const sheetTargets = await loadBroadcastTargetsFromSheet(chatId, inMemoryIndex);
        for (const target of sheetTargets) {
            recipientsByKey.set(target.key, target);
        }

        const recipients = Array.from(recipientsByKey.values());
        if (recipients.length === 0) {
            await bot.sendMessage(chatId, 'Не знайдено жодного зареєстрованого отримувача для розсилки.');
            return true;
        }

        let sentCount = 0;
        let failedCount = 0;

        for (const recipient of recipients) {
            const destination = recipient.kind === 'chatId' ? recipient.value : recipient.value;
            try {
                await bot.sendMessage(destination, broadcastRequest.text);
                sentCount += 1;
            } catch (error) {
                failedCount += 1;
                console.error(`❌ Broadcast send failed for ${recipient.key}:`, error && error.message ? error.message : error);
            }
        }

        await bot.sendMessage(chatId, `📣 Розсилку виконано. Успішно: ${sentCount}, Помилки: ${failedCount}`);
        return true;
    }


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
    const normalizedUserText = normalizeText(String(text || '')).toLowerCase().trim();

    if (msg.chat.type === 'private') {
        recordSeenChatId(chatId);
        const activeUser = users[chatId] || knownUsers[chatId] || {};
        await autoBackfillChatIdForRegisteredUser(chatId, msg.from || {}, activeUser);
    }

    if (!text) return;

    const trimmedText = String(text || '').trim();
    const commandText = trimmedText.startsWith('/') ? trimmedText : '';
    const isBeneficiarySummaryTrigger = trimmedText === '🧮' || trimmedText === '/summary';

    if (isBeneficiarySummaryTrigger) {
        deleteExpiredBeneficiarySummaryStorage(new Date());
        await sendBeneficiarySummary(bot, chatId, new Date());
        return;
    }

    if (commandText && matchesCommand(commandText, '/test_feedback_group', '/test_feedback_group@' + BOT_USERNAME, '/test_feedback', '/test_feedback@' + BOT_USERNAME, '/test_feedback_me', '/test_feedback_me@' + BOT_USERNAME)) {
        await bot.sendMessage(chatId, `🧪 Отримано команду: ${commandText}`);

        if (matchesCommand(commandText, '/test_feedback_group', '/test_feedback_group@' + BOT_USERNAME)) {
            const testFeedbackMessage = `🧪 Тестове повідомлення у групу відгуків\n\nЦе повідомлення має потрапити в групу “Відгуки”.`;
            console.log(`[TEST_FEEDBACK_GROUP] command received from chat ${chatId}; target=${effectiveAppealsGroupId}`);
            if (effectiveAppealsGroupId) {
                try {
                    console.log(`[TEST_FEEDBACK_GROUP] attempting send to ${effectiveAppealsGroupId}`);
                    await bot.sendMessage(effectiveAppealsGroupId, testFeedbackMessage);
                    console.log(`[TEST_FEEDBACK_GROUP] send succeeded to ${effectiveAppealsGroupId}`);
                    await bot.sendMessage(chatId, `✅ Тестове повідомлення відправлено в групу ${effectiveAppealsGroupId}`);
                } catch (error) {
                    const errorBody = error && error.response && error.response.body
                        ? error.response.body
                        : (error && error.message ? error.message : error);
                    const errorText = JSON.stringify(errorBody || error || {}, null, 2);
                    console.error('❌ Не вдалося відправити тестове повідомлення в групу:', errorText);
                    await bot.sendMessage(chatId, `❌ Не вдалося відправити тестове повідомлення в групу. Telegram відповів: ${String(errorText)}`);
                }
            } else {
                await bot.sendMessage(chatId, '❌ APPEALS_GROUP_ID не встановлено');
            }
        } else if (matchesCommand(commandText, '/test_feedback', '/test_feedback@' + BOT_USERNAME)) {
            const testFeedbackMessage = `🧪 Тестове повідомлення від бота\n\nЦе повідомлення відправлено для перевірки доставки у групу відгуків.`;
            if (effectiveAppealsGroupId) {
                try {
                    await bot.sendMessage(effectiveAppealsGroupId, testFeedbackMessage);
                    await bot.sendMessage(chatId, `✅ Тестове повідомлення відправлено в групу ${effectiveAppealsGroupId}`);
                } catch (error) {
                    const errorBody = error && error.response && error.response.body
                        ? error.response.body
                        : (error && error.message ? error.message : error);
                    console.error('❌ Не вдалося відправити тестовий відгук:', errorBody);
                    await bot.sendMessage(chatId, `❌ Не вдалося відправити тестове повідомлення: ${String(errorBody || error || '')}`);
                }
            } else {
                await bot.sendMessage(chatId, '❌ APPEALS_GROUP_ID не встановлено');
            }
        } else {
            await bot.sendMessage(chatId, '🧪 Це тестове повідомлення від бота. Якщо ти його бачиш — команда працює.');
            await bot.sendMessage(chatId, '✅ Тестове повідомлення надіслано тобі в приватний чат.');
        }
        return;
    }

    if (msg.chat.type === 'private' && await tryHandleOwnerBroadcast(chatId, text)) {
        return;
    }

    const isAddEventCommand = /^\/add_event(?:@\w+)?$/i.test(String(text || '').trim());
    if (msg.chat.type === 'private' && isAddEventCommand) {
        if (!isAdminChatId(chatId)) {
            await bot.sendMessage(chatId, 'Ця команда доступна лише адміністратору.');
            return;
        }

        if (!users[chatId]) {
            users[chatId] = { step: 0 };
        }

        users[chatId].context = 'admin-add-event-date';
        users[chatId].adminAddEventDraft = {};
        await bot.sendMessage(chatId,
            '🛠 <b>Додавання заходу</b>\n\nКрок 1/4: Вкажіть дату у форматі ДД.ММ.РРРР.', {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: NAVIGATION_BUTTONS.menu }]],
                resize_keyboard: true
            }
        });
        return;
    }
    
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

    if (matchesCommand(text, '/check_code', '/check_code@' + BOT_USERNAME)) {
        const payload = String(text || '')
            .replace(/^\/check_code(?:@\w+)?\s*/i, '')
            .trim();

        if (!payload) {
            await bot.sendMessage(chatId, '🧪 Надішліть код після команди, наприклад: /check_code ABC123');
            return;
        }

        const checkCodeMessage =
            '🧪 Перевірка доставки\n' +
            `👤 Відправив: ${resolveFeedbackUserName(chatId, msg.from || null)}\n` +
            `📌 Код для перевірки:\n${payload}`;

        if (effectiveAppealsGroupId) {
            try {
                await bot.sendMessage(effectiveAppealsGroupId, checkCodeMessage);
                await bot.sendMessage(chatId, `✅ Код відправлено в чат для відгуків: ${effectiveAppealsGroupId}`);
            } catch (error) {
                const errorBody = error && error.response && error.response.body
                    ? error.response.body
                    : (error && error.message ? error.message : error);
                console.error('❌ Не вдалося відправити код для перевірки:', errorBody);
                await bot.sendMessage(chatId, `❌ Не вдалося відправити код: ${String(errorBody || error || '')}`);
            }
        } else {
            await bot.sendMessage(chatId, '❌ Чат для відгуків не налаштовано');
        }
        return;
    }

    if (matchesCommand(text, '/test_feedback', '/test_feedback@' + BOT_USERNAME)) {
        const testFeedbackMessage = `🧪 Тестове повідомлення від бота\n\nЦе повідомлення відправлено для перевірки доставки у групу відгуків.`;
        if (effectiveAppealsGroupId) {
            try {
                await bot.sendMessage(effectiveAppealsGroupId, testFeedbackMessage);
                await bot.sendMessage(chatId, `✅ Тестове повідомлення відправлено в групу ${effectiveAppealsGroupId}`);
            } catch (error) {
                const errorBody = error && error.response && error.response.body
                    ? error.response.body
                    : (error && error.message ? error.message : error);
                console.error('❌ Не вдалося відправити тестовий відгук:', errorBody);
                await bot.sendMessage(chatId, `❌ Не вдалося відправити тестове повідомлення: ${String(errorBody || error || '')}`);
            }
        } else {
            await bot.sendMessage(chatId, '❌ APPEALS_GROUP_ID не встановлено');
        }
        return;
    }

    if (matchesCommand(text, '/test_feedback_me', '/test_feedback_me@' + BOT_USERNAME)) {
        try {
            await bot.sendMessage(chatId, '🧪 Це тестове повідомлення від бота. Якщо ти його бачиш — команда працює.');
            await bot.sendMessage(chatId, '✅ Тестове повідомлення надіслано тобі в приватний чат.');
        } catch (error) {
            const errorBody = error && error.response && error.response.body
                ? error.response.body
                : (error && error.message ? error.message : error);
            console.error('❌ Не вдалося відправити тестове повідомлення користувачу:', errorBody);
            await bot.sendMessage(chatId, `❌ Не вдалося надіслати тестове повідомлення: ${String(errorBody || error || '')}`);
        }
        return;
    }

    if (matchesCommand(text, '/test_feedback_group', '/test_feedback_group@' + BOT_USERNAME)) {
        const testFeedbackMessage = `🧪 Тестове повідомлення у групу відгуків\n\nЦе повідомлення має потрапити в групу “Відгуки”.`;
        if (APPEALS_GROUP_ID) {
            try {
                const result = await bot.sendMessage(APPEALS_GROUP_ID, testFeedbackMessage);
                await bot.sendMessage(chatId, `✅ Тестове повідомлення відправлено в групу ${APPEALS_GROUP_ID}\n\nMessage ID: ${result && result.message_id ? result.message_id : 'N/A'}`);
            } catch (error) {
                const errorBody = error && error.response && error.response.body
                    ? error.response.body
                    : (error && error.message ? error.message : error);
                console.error('❌ Не вдалося відправити тестове повідомлення в групу:', errorBody);
                await bot.sendMessage(chatId, `❌ Не вдалося відправити тестове повідомлення в групу: ${String(errorBody || error || '')}`);
            }
        } else {
            await bot.sendMessage(chatId, '❌ APPEALS_GROUP_ID не встановлено');
        }
        return;
    }

    if (matchesCommand(text, '/debug_send_to_chat', '/debug_send_to_chat@' + BOT_USERNAME)) {
        const targetChatId = Number(process.env.DEBUG_TARGET_CHAT_ID || '-1003802751255');
        try {
            await bot.sendMessage(targetChatId, '🧪 DEBUG: direct send to numeric chat id');
            await bot.sendMessage(chatId, `✅ DEBUG send succeeded to ${targetChatId}`);
        } catch (error) {
            const errorBody = error && error.response && error.response.body
                ? error.response.body
                : (error && error.message ? error.message : error);
            await bot.sendMessage(chatId, `❌ DEBUG send failed: ${JSON.stringify(errorBody || error || {}, null, 2)}`);
        }
        return;
    }

    // ДІАГНОСТИКА: тест запису в таблицю персональних даних
    if (text === '/test_write' || text === '/test_table') {
        bot.sendMessage(chatId, '⏳ Тестую запис в таблицю "Зареєстровані"...');
        
        try {
            const testUser = {
                username: 'test_user',
                name: 'ТЕСТ Запис',
                phone: '380000000000',
                birth: '01.01.2000',
                status: 'ВПО',
                health: "Ні, немає істотних проблем зі здоров'ям",
                evacuationStatus: 'Нічого з зазначеного',
                shellingImpact: 'Ні, не постраждала',
                employment: 'Працюю',
                beneficiaryCategory: 'Нічого із вищезазначеного'
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

    // ВІДНОВЛЕННЯ: команда для запису нотаток реєстрацій назад у таблицю з пам'яті
    if (text === '/restore_notes') {
        bot.sendMessage(chatId, '⏳ Відновлюю нотатки реєстрацій у таблиці...');
        const { restored, failed } = await restoreRegistrationNotesToSheet();
        bot.sendMessage(chatId, `✅ Відновлення завершено.\nВідновлено нотаток: ${restored}\nПомилок: ${failed}`);
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

        const existingCachedProfile = knownUsers[chatId] || null;
        let foundProfile = existingCachedProfile;

        if (!foundProfile) {
            foundProfile = await loadKnownUserByChatId(chatId, { forceRefresh: true });
        }

        if (!foundProfile && msg.from && msg.from.username) {
            foundProfile = await loadKnownUserByUsername(msg.from.username);
        }

        if (foundProfile) {
            Object.assign(user, foundProfile);
            user.profileHydrated = true;
            knownUsers[chatId] = foundProfile;

            const thisWeekEvents = await getUserWeeklyEvents(chatId, foundProfile);

            const greetingName = String(foundProfile.name || '').trim().split(/\s+/)[1]
                || String(foundProfile.name || '').trim().split(/\s+/)[0]
                || 'друже';
            let greeting = `✅ Привіт, ${greetingName}! Рад(а) тебе бачити.\n\n`;

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
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
        } else {
            user.step = 1;
            user.registrationMode = true;
            user.registrationData = {
                chatId: String(chatId)
            };

            const existingSessionProfile = user.name || user.phone || user.birth || user.status || user.childrenCount || user.health;
            if (existingSessionProfile) {
                await bot.sendMessage(chatId, "🔄 Ми відновили ваші дані з поточної сесії. Продовжуємо реєстрацію.", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
            } else {
                await bot.sendMessage(chatId, "Профіль не знайдено. 😔\n\nРозпочинаємо реєстрацію...\n\n📝 <b>Крок 1/11:</b> Будь ласка, введіть ваше <b>ПІБ</b> (Прізвище Ім'я По батькові):", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
            }
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

    if (user.context === 'daily-feedback-write' && user.pendingFeedbackDateKey) {
        const dateKey = String(user.pendingFeedbackDateKey || '');
        const feedbackText = String(text || '').trim();
        if (!feedbackText) {
            await bot.sendMessage(chatId, 'Будь ласка, напишіть текст відгуку повідомленням.');
            return;
        }

        const dateLabel = formatFeedbackDateLabel(dateKey) || dateKey;
        const eventNames = getFeedbackEventsForChatByDate(chatId, dateKey);
        const eventsBlock = eventNames.length > 0
            ? eventNames.map((eventName) => `- ${eventName}`).join('\n')
            : '- (події не знайдено)';
        const userName = resolveFeedbackUserName(chatId, msg.from || null);
        const userPhone = resolveFeedbackUserPhone(chatId, msg.from || null);

        const adminMessage =
            '📝 Новий відгук\n' +
            `👤 Користувач: ${userName}\n` +
            `📱 Телефон: ${userPhone}\n` +
            `📅 Дата: ${dateLabel}\n` +
            '📌 Заходи:\n' +
            `${eventsBlock}\n\n` +
            '💬 Відгук:\n' +
            `"${feedbackText}"`;

        try {
            const feedbackDestinationId = effectiveAppealsGroupId || GROUP_ID;
            if (feedbackDestinationId) {
                await bot.sendMessage(feedbackDestinationId, adminMessage);
                console.log(`[FEEDBACK] Sent feedback to ${feedbackDestinationId}`);
            } else {
                console.warn('⚠️ Не вдалося визначити цільову групу для відгуку');
            }

            setFeedbackStatus(chatId, dateKey, 'submitted');
            clearFeedbackFlowState(user);
            saveReminderStateToDisk();

            await bot.sendMessage(chatId,
                'Дякуємо за ваш відгук 💛\nМи раді були вас почути 😊', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
        } catch (error) {
            console.error('❌ Помилка обробки відгуку:', error && error.message ? error.message : error);
            const errorText = error && error.response && error.response.body
                ? JSON.stringify(error.response.body)
                : (error && error.message ? error.message : String(error));
            clearFeedbackFlowState(user);
            await bot.sendMessage(chatId, `❌ Не вдалося надіслати відгук. Спробуйте ще раз трохи пізніше.\n\nДеталі: ${errorText}`);
        }
        return;
    }

    const pendingFeedbackDateKey = getPendingFeedbackDateForChat(chatId);
    if (text === FEEDBACK_BUTTON_YES && pendingFeedbackDateKey) {
        user.context = 'daily-feedback-write';
        user.pendingFeedbackDateKey = pendingFeedbackDateKey;
        await bot.sendMessage(chatId,
            'Напишіть, будь ласка, ваш відгук одним повідомленням. Ми передамо його команді 💛', {
            reply_markup: {
                keyboard: [[{ text: NAVIGATION_BUTTONS.menu }]],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === FEEDBACK_BUTTON_NO && pendingFeedbackDateKey) {
        setFeedbackStatus(chatId, pendingFeedbackDateKey, 'declined');
        clearFeedbackFlowState(user);
        saveReminderStateToDisk();
        await bot.sendMessage(chatId,
            'Дякуємо, що були з нами 💛\nМожливо, наступного разу ви захочете поділитися своїми враженнями 😔', {
            reply_markup: {
                keyboard: getMainMenuKeyboard(chatId),
                resize_keyboard: true
            }
        });
        return;
    }

    // (Старий код waitingForLogin видалено - тепер /start автоматично обробляє профіль)

    if (!user.profileHydrated) {
        let restoredProfile = await loadKnownUserByChatId(chatId, { forceRefresh: true });
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

    if (user.awaitingReminderHoursFor) {
        if (text === '⬅️ Назад до налаштувань') {
            delete user.awaitingReminderHoursFor;
            await showReminderSettingsMenu(chatId);
            return;
        }

        const slotKey = user.awaitingReminderHoursFor;
        const slotConfig = getReminderSlotConfig(slotKey);
        const parsedValue = parseInt(String(text || '').trim(), 10);

        if (!slotConfig || Number.isNaN(parsedValue) || parsedValue < slotConfig.minValue || parsedValue > slotConfig.maxValue) {
            await bot.sendMessage(chatId,
                `❌ Введіть ціле число від ${slotConfig.minValue} до ${slotConfig.maxValue}.`, {
                reply_markup: {
                    keyboard: [[{ text: '⬅️ Назад до налаштувань' }]],
                    resize_keyboard: true
                }
            });
            return;
        }

        const settings = getReminderSettingsForChat(chatId);
        settings[slotKey][slotConfig.valueKey] = parsedValue;
        settings[slotKey].enabled = true;
        user.reminderSettings = settings;
        user.remindersEnabled = settings.enabled;
        delete user.awaitingReminderHoursFor;
        saveReminderStateToDisk();

        await showReminderSettingsMenu(chatId, `✅ Нагадування ${slotConfig.label} налаштовано за ${formatReminderLeadTime(slotKey, parsedValue)} до заходу.`);
        return;
    }

    if (isRegistrationCancelText(text)) {
        clearPendingRegistrationSelection(user);
        delete user.afishaMultiRegistration;
        delete user.afishaFullRegistration;
        delete user.selectedEventsList;
        delete user.currentSelectedEventName;
        delete user.currentSelectedEventId;
        clearFriendRegistrationState(user);
        clearConsultationState(user);
        user.step = 0;
        user.registrationMode = false;

        await bot.sendMessage(chatId, "Реєстрацію скасовано. Оберіть дію в меню.", {
            reply_markup: {
                keyboard: getMainMenuKeyboard(chatId),
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
                keyboard: getMainMenuKeyboard(chatId),
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
    const hasValidRegistrationStep = Number.isInteger(registrationStep) && registrationStep >= 1 && registrationStep <= 11;
    if (user.registrationMode || hasValidRegistrationStep) {
        // Відновлюємо режим форми, якщо прапорець загубився, але крок лишився
        user.registrationMode = true;
        user.step = hasValidRegistrationStep ? registrationStep : 1;
        const registrationDraft = getActiveRegistrationDraft(user);

        if (user.step === 1) {
            if (isLikelyInvalidRegistrantName(text)) {
                await bot.sendMessage(chatId,
                    "❌ Введіть, будь ласка, коректне ПІБ ", {
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

            registrationDraft.name = text;
            user.step = 2;
            const phonePrompt = isFriendRegistrationMode(user)
                ? "📝 <b>Крок 2/11:</b> Введіть <b>номер телефону подруги</b> (формат: 380...)"
                : "📝 <b>Крок 2/11:</b> Введіть ваш <b>номер телефону</b> (формат: 380...)";

            await bot.sendMessage(chatId, phonePrompt, {
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
            const normalizedPhone = normalizeUaPhoneForRegistration(text);
            if (!normalizedPhone) {
                await bot.sendMessage(chatId,
                    "❌ Некоректний номер телефону. Введіть у форматі <b>380XXXXXXXXX</b> або <b>0XXXXXXXXX</b>.", {
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

            registrationDraft.phone = normalizedPhone;
            user.step = 3;
            const birthPrompt = isFriendRegistrationMode(user)
                ? "📝 <b>Крок 3/11:</b> Введіть <b>дату народження подруги</b> (формат: ДД.ММ.РРРР)"
                : "📝 <b>Крок 3/11:</b> Введіть вашу <b>дату народження</b> (формат: ДД.ММ.РРРР)";

            await bot.sendMessage(chatId, birthPrompt, {
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
            const normalizedBirth = normalizeBirthDateStrict(text);
            if (!normalizedBirth) {
                await bot.sendMessage(chatId,
                    "❌ Некоректна дата. Введіть дату лише у форматі <b>ДД.ММ.РРРР</b> (наприклад, <b>05.11.1960</b>).", {
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

            registrationDraft.birth = normalizedBirth;
            user.step = 4;
            const statusPrompt = isFriendRegistrationMode(user)
                ? "📝 <b>Крок 4/11:</b> ВПО/МО статус подруги:\n\n<b>Не ВПО, що постраждали від війни:</b> Громадяни, які живуть у рідних містах, але їхнє житло було зруйноване/пошкоджене, або вони отримали фізичні чи психологічні травми, втратили майно або джерело доходу внаслідок бойових дій.\n\n<b>Не ВПО, що не постраждали від війни:</b> Люди, які проживають у відносно безпечних регіонах, чиє майно, здоров'я та фінансовий стан не зазнали прямого впливу бойових дій."
                : "📝 <b>Крок 4/11:</b> Ваш ВПО/МО статус:\n\n<b>Не ВПО, що постраждали від війни:</b> Громадяни, які живуть у рідних містах, але їхнє житло було зруйноване/пошкоджене, або вони отримали фізичні чи психологічні травми, втратили майно або джерело доходу внаслідок бойових дій.\n\n<b>Не ВПО, що не постраждали від війни:</b> Люди, які проживають у відносно безпечних регіонах, чиє майно, здоров'я та фінансовий стан не зазнали прямого впливу бойових дій.";

            await bot.sendMessage(chatId, statusPrompt, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "ВПО" }],
                        [{ text: "Не ВПО, що постраждали від війни" }],
                        [{ text: "Не ВПО, що не постраждали від війни" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 4) {
            const statusOptions = ['ВПО', 'Не ВПО, що постраждали від війни', 'Не ВПО, що не постраждали від війни'];
            if (!statusOptions.includes(text)) {
                await bot.sendMessage(chatId, "❌ Будь ласка, оберіть варіант кнопками зі списку ВПО/МО.", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "ВПО" }],
                            [{ text: "Не ВПО, що постраждали від війни" }],
                            [{ text: "Не ВПО, що не постраждали від війни" }],
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            registrationDraft.status = text;
            user.step = 5;
            const childrenPrompt = isFriendRegistrationMode(user)
                ? "📝 <b>Крок 5/11:</b> Кількість дітей подруги до 18 років:"
                : "📝 <b>Крок 5/11:</b> Кількість дітей до 18 років:";

            await bot.sendMessage(chatId, childrenPrompt, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "0" }, { text: "1" }],
                        [{ text: "2" }, { text: "3 і більше" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 5) {
            const childrenOptions = ['0', '1', '2', '3 і більше'];
            if (!childrenOptions.includes(text)) {
                await bot.sendMessage(chatId, "❌ Будь ласка, оберіть кількість дітей кнопками.", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "0" }, { text: "1" }],
                            [{ text: "2" }, { text: "3 і більше" }],
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            registrationDraft.childrenCount = text;
            user.step = 6;
            const healthPrompt = isFriendRegistrationMode(user)
                ? "📝 <b>Крок 6/11:</b> Стан здоров'я подруги:"
                : "📝 <b>Крок 6/11:</b> Стан здоров'я:";

            await bot.sendMessage(chatId, healthPrompt, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Ні, немає істотних проблем зі здоров'ям" }],
                        [{ text: "Ні, але є істотні проблеми зі здоров'ям" }],
                        [{ text: "Інвалідність" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 6) {
            const healthOptions = [
                "Ні, немає істотних проблем зі здоров'ям",
                "Ні, але є істотні проблеми зі здоров'ям",
                'Інвалідність'
            ];
            if (!healthOptions.includes(text)) {
                await bot.sendMessage(chatId, "❌ Будь ласка, оберіть стан здоров'я кнопками.", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Ні, немає істотних проблем зі здоров'ям" }],
                            [{ text: "Ні, але є істотні проблеми зі здоров'ям" }],
                            [{ text: "Інвалідність" }],
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            registrationDraft.health = text;
            user.step = 7;

            await bot.sendMessage(chatId, "📝 <b>Крок 7/11:</b> Евакуаційний статус особи:", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Евакуація з попереднього місця проживання за останні 6 місяців" }],
                        [{ text: "Перебування в транзитному центрі та/або в процесі евакуації" }],
                        [{ text: "Готуюсь до евакуації" }],
                        [{ text: "Нічого з зазначеного" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 7) {
            const evacuationOptions = [
                'Евакуація з попереднього місця проживання за останні 6 місяців',
                'Перебування в транзитному центрі та/або в процесі евакуації',
                'Готуюсь до евакуації',
                'Нічого з зазначеного'
            ];
            if (!evacuationOptions.includes(text)) {
                await bot.sendMessage(chatId, "📝 <b>Крок 7/11:</b> Евакуаційний статус особи:", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Евакуація з попереднього місця проживання за останні 6 місяців" }],
                            [{ text: "Перебування в транзитному центрі та/або в процесі евакуації" }],
                            [{ text: "Готуюсь до евакуації" }],
                            [{ text: "Нічого з зазначеного" }],
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            registrationDraft.evacuationStatus = text;
            user.step = 8;

            await bot.sendMessage(chatId, "📝 <b>Крок 8/11:</b> Чи вважаєте себе такою, що прямо або опосередковано постраждала від обстрілів протягом останніх 72 годин або останніх 3 місяців?\n\nПриклади опосередкованого впливу: перебої в електропостачанні, втрата роботи, зміна звичного способу життя та інше.", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Так, постраждала протягом останніх 72 годин" }],
                        [{ text: "Так, постраждала протягом останніх 3 місяців" }],
                        [{ text: "Ні, не постраждала" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 8) {
            const shellingImpactOptions = [
                'Так, постраждала протягом останніх 72 годин',
                'Так, постраждала протягом останніх 3 місяців',
                'Ні, не постраждала'
            ];
            if (!shellingImpactOptions.includes(text)) {
                await bot.sendMessage(chatId, "📝 <b>Крок 8/11:</b> Чи вважаєте себе такою, що прямо або опосередковано постраждала від обстрілів протягом останніх 72 годин або останніх 3 місяців?\n\nПриклади опосередкованого впливу: перебої в електропостачанні, втрата роботи, зміна звичного способу життя та інше.", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Так, постраждала протягом останніх 72 годин" }],
                            [{ text: "Так, постраждала протягом останніх 3 місяців" }],
                            [{ text: "Ні, не постраждала" }],
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            registrationDraft.shellingImpact = text;
            user.step = 9;

            await bot.sendMessage(chatId, "📝 <b>Крок 9/11:</b> Зайнятість:", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Працюю" }, { text: "Не працюю" }],
                        [{ text: "Пенсіонерка" }, { text: "Студентка" }],
                        [{ text: "Школярка" }, { text: "ФОП" }],
                        [{ text: "Волонтерка" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 9) {
            const employmentOptions = ['Працюю', 'Не працюю', 'Пенсіонерка', 'Студентка', 'Школярка', 'ФОП', 'Волонтерка'];
            if (!employmentOptions.includes(text)) {
                await bot.sendMessage(chatId, "📝 <b>Крок 9/11:</b> Зайнятість:", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [
                            [{ text: "Працюю" }, { text: "Не працюю" }],
                            [{ text: "Пенсіонерка" }, { text: "Студентка" }],
                            [{ text: "Школярка" }, { text: "ФОП" }],
                            [{ text: "Волонтерка" }],
                            [{ text: "❌ Скасувати реєстрацію" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            registrationDraft.employment = text;
            user.step = 10;

            await bot.sendMessage(chatId, "📝 <b>Крок 10/11:</b> До яких категорій належите?", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Вагітна" }],
                        [{ text: "Одинока мати" }],
                        [{ text: "Багатодітна мати (3 і більше дітей)" }],
                        [{ text: "Ветеранка" }],
                        [{ text: "Представниця сім'ї загиблого воїна" }],
                        [{ text: "Представниця сім'ї ветерана" }],
                        [{ text: "Особа у складних життєвих обставинах (юридичне підтвердження статусу не потрібно)" }],
                        [{ text: "Нічого із вищезазначеного" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 10) {
            registrationDraft.beneficiaryCategory = text;
            user.step = 11;

            await bot.sendMessage(chatId, "📝 <b>Крок 11/11:</b> Чи маєте ви досвід або потребу, пов'язану з ГЗН?\n\n<b>ГЗН (гендерно зумовлене насильство)</b> — це будь-які дії, завдані людині через її стать або гендер, які спричиняють фізичну, психологічну, сексуальну чи економічну шкоду.\n\n<b>Приклади:</b>\n- фізичне насильство — побиття, штовхання;\n- психологічне — образи, приниження, погрози, контроль;\n- сексуальне — примус до сексуальних дій без згоди;\n- економічне — заборона працювати, відбирання грошей, повний контроль фінансів;\n- переслідування, сексуальні домагання, примусовий шлюб.", {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: "Так" }, { text: "Ні" }],
                        [{ text: "Поки не хочу відповідати" }],
                        [{ text: "❌ Скасувати реєстрацію" }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.step === 11) {
            registrationDraft.gzn = text;

            try {
                console.log(`\n📝 === ЗБЕРЕЖЕННЯ РЕЄСТРАЦІЇ ===`);
                console.log(`ChatID: ${chatId}`);
                console.log(`Дані користувача:`, {
                    name: registrationDraft.name,
                    phone: registrationDraft.phone,
                    birth: registrationDraft.birth,
                    status: registrationDraft.status,
                    childrenCount: registrationDraft.childrenCount,
                    health: registrationDraft.health,
                    evacuationStatus: registrationDraft.evacuationStatus,
                    shellingImpact: registrationDraft.shellingImpact,
                    employment: registrationDraft.employment,
                    gzn: registrationDraft.gzn,
                    beneficiaryCategory: registrationDraft.beneficiaryCategory,
                    friendMode: isFriendRegistrationMode(user)
                });
                
                // Для реєстрації подруги намагаємось прив'язати запис до її chatId за номером телефону.
                let registrationOwnerChatId = isFriendRegistrationMode(user)
                    ? ''
                    : String(chatId || '').trim();
                if (isFriendRegistrationMode(user)) {
                    const friendChatId = await resolveChatIdByPhone(registrationDraft.phone);
                    user.friendTargetChatId = friendChatId;
                    if (friendChatId) {
                        registrationOwnerChatId = friendChatId;
                    }
                }

                await appendRegistrationRow(registrationOwnerChatId, registrationDraft);

                console.log(`✅ Реєстрація успішно збережена для ${chatId}`);
                console.log(`===============================\n`);

                if (!isFriendRegistrationMode(user)) {
                    // Зберігаємо дані користувача для швидкого доступу 
                    knownUsers[chatId] = {
                        name: registrationDraft.name,
                        phone: registrationDraft.phone,
                        birth: registrationDraft.birth,
                        status: registrationDraft.status,
                        childrenCount: registrationDraft.childrenCount,
                        health: registrationDraft.health,
                        evacuationStatus: registrationDraft.evacuationStatus,
                        shellingImpact: registrationDraft.shellingImpact,
                        employment: registrationDraft.employment,
                        gzn: registrationDraft.gzn,
                        beneficiaryCategory: registrationDraft.beneficiaryCategory,
                        username: user.username || ""
                    };
                }

                if (user.afishaMultiRegistration && user.selectedEventsList && user.selectedEventsList.length > 0) {
                    const { successEvents, alreadyRegisteredEvents, reserveEvents, failedEvents } = await completeSelectedEventsRegistration(
                        chatId,
                        user,
                        registrationDraft.name,
                        registrationDraft.phone,
                        {
                            skipReminders: isFriendRegistrationMode(user),
                            reserveMode: user.afishaReserveMode === true,
                            reminderOwnerChatId: isFriendRegistrationMode(user)
                                ? String(user.friendTargetChatId || '').trim()
                                : String(chatId)
                        }
                    );

                    const instantAfisha = user.afishaInstantMode === true;
                    if (instantAfisha && !isFriendRegistrationMode(user)) {
                        delete user.lastAfishaRegisteredEventId;
                        delete user.lastAfishaRegisteredEventName;

                        const lastEvent = successEvents[successEvents.length - 1]
                            || alreadyRegisteredEvents[alreadyRegisteredEvents.length - 1]
                            || reserveEvents[reserveEvents.length - 1];
                        if (lastEvent) {
                            user.lastAfishaRegisteredEventId = lastEvent.id;
                            user.lastAfishaRegisteredEventName = lastEvent.name;
                        }
                    }

                    await bot.sendMessage(chatId, buildRegistrationResultsMessage(
                        successEvents,
                        reserveEvents,
                        failedEvents,
                        isFriendRegistrationMode(user) ? 'Подругу успішно зареєстровано на' : 'Ви успішно зареєстровані на'
                    ), {
                        parse_mode: 'HTML',
                        reply_markup: {
                            keyboard: isFriendRegistrationMode(user)
                                ? [[{ text: FRIEND_FLOW_BUTTONS.addAnother }], [{ text: NAVIGATION_BUTTONS.menu }]]
                                : instantAfisha
                                    ? getAfishaInstantRegistrationKeyboard()
                                    : [[{ text: NAVIGATION_BUTTONS.menu }]],
                            resize_keyboard: true
                        }
                    });

                    if (instantAfisha) {
                        user.context = 'afisha';
                    }

                    if (isFriendRegistrationMode(user)) {
                        clearFriendRegistrationState(user);
                    }
                    return;
                }

                if (isFriendRegistrationMode(user)) {
                    user.step = 0;
                    user.registrationMode = false;
                    user.context = 'afisha';

                    await bot.sendMessage(chatId,
                        "✅ <b>Подругу зареєстровано.</b>\n\nТепер оберіть дні та заходи для запису.", {
                        parse_mode: 'HTML',
                        reply_markup: {
                            keyboard: getAfishaDaysKeyboard(),
                            resize_keyboard: true
                        }
                    });
                    return;
                }

                // Показуємо меню з кнопками
                await bot.sendMessage(chatId, "✅ <b>Реєстрація завершена!</b>\n\n👤 " + registrationDraft.name + "\n📱 " + registrationDraft.phone + "\n\nТепер вибери, що далі:", {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(chatId),
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
                    name: registrationDraft.name,
                    phone: registrationDraft.phone,
                    birth: registrationDraft.birth,
                    status: registrationDraft.status,
                    childrenCount: registrationDraft.childrenCount,
                    health: registrationDraft.health,
                    evacuationStatus: registrationDraft.evacuationStatus,
                    shellingImpact: registrationDraft.shellingImpact,
                    employment: registrationDraft.employment,
                    gzn: registrationDraft.gzn,
                    beneficiaryCategory: registrationDraft.beneficiaryCategory
                });
                console.error(`Помилка:`, error);
                console.error(`Stack:`, error.stack);
                console.error(`===============================\n`);
                
                let errorMsg = error && error.message ? error.message : 'Невідома помилка';
                
                // Додаємо деталі про можливі причини
                let hint = '';
                if (errorMsg.toLowerCase().includes('permission') || errorMsg.toLowerCase().includes('403')) {
                    hint = '\n\n💡 Перевірте, чи додано service account як редактор до Google Sheet.';
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
        await bot.sendMessage(chatId, "Ваш профіль уже створюється один раз при вході в бот. Для запису на заходи відкрийте афішу.", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: MAIN_MENU_BUTTONS.afisha }], [{ text: NAVIGATION_BUTTONS.menu }]],
                resize_keyboard: true
            }
        });
        return;
    }

    if (String(user.context || '').startsWith('admin-add-event-')) {
        if (matchesCommand(text, NAVIGATION_BUTTONS.menu, 'Повернутися в меню', 'Назад в меню') || matchesCommand(text, NAVIGATION_BUTTONS.back, 'Назад') || text === '❌ Скасувати') {
            user.context = null;
            delete user.adminAddEventDraft;
            await bot.sendMessage(chatId, 'Додавання заходу скасовано.', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (!isAdminChatId(chatId)) {
            user.context = null;
            delete user.adminAddEventDraft;
            await bot.sendMessage(chatId, 'Ця дія доступна лише адміністратору.');
            return;
        }

        if (!user.adminAddEventDraft) {
            user.adminAddEventDraft = {};
        }

        if (user.context === 'admin-add-event-date') {
            const parsedDate = parseDateValue(text, new Date().getFullYear());
            if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
                await bot.sendMessage(chatId, '❌ Введіть дату у форматі ДД.ММ.РРРР (наприклад, 15.07.2026).');
                return;
            }

            user.adminAddEventDraft.date = formatSheetDate(parsedDate);
            user.context = 'admin-add-event-time';
            await bot.sendMessage(chatId, '🕐 Крок 2/4: Вкажіть час заходу у форматі ГГ:ХХ (наприклад, 16:15).');
            return;
        }

        if (user.context === 'admin-add-event-time') {
            const normalizedTime = normalizeTimeValue(text);
            if (!normalizedTime) {
                await bot.sendMessage(chatId, '❌ Некоректний час. Введіть у форматі ГГ:ХХ (наприклад, 16:15).');
                return;
            }

            user.adminAddEventDraft.time = normalizedTime.text;
            user.context = 'admin-add-event-name';
            await bot.sendMessage(chatId, '📝 Крок 3/4: Вкажіть назву заходу.');
            return;
        }

        if (user.context === 'admin-add-event-name') {
            const name = String(text || '').trim();
            if (!name) {
                await bot.sendMessage(chatId, '❌ Назва не може бути порожньою.');
                return;
            }

            user.adminAddEventDraft.name = name;
            user.context = 'admin-add-event-seats';
            await bot.sendMessage(chatId, '💺 Крок 4/4: Вкажіть кількість місць (ціле число).');
            return;
        }

        if (user.context === 'admin-add-event-seats') {
            const seats = parseInt(String(text || '').trim(), 10);
            if (!Number.isInteger(seats) || seats <= 0) {
                await bot.sendMessage(chatId, '❌ Кількість місць має бути додатним цілим числом.');
                return;
            }

            const draft = user.adminAddEventDraft;
            const eventId = `${draft.name.replace(/\s+/g, '_')}_${draft.date}_${draft.time}`;
            const exists = events.some((event) => event && event.id === eventId);

            if (exists) {
                user.context = null;
                delete user.adminAddEventDraft;
                await bot.sendMessage(chatId, 'ℹ️ Такий захід уже існує в розкладі.', {
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(chatId),
                        resize_keyboard: true
                    }
                });
                return;
            }

            const dateParts = String(draft.date || '').split('.');
            const timeParts = String(draft.time || '').split(':');
            const eventDate = new Date(
                parseInt(dateParts[2], 10),
                parseInt(dateParts[1], 10) - 1,
                parseInt(dateParts[0], 10),
                parseInt(timeParts[0], 10),
                parseInt(timeParts[1], 10),
                0,
                0
            );

            events.push({
                id: eventId,
                name: draft.name,
                date: eventDate,
                seats,
                registrations: 0,
                reserveCount: 0
            });

            await appendEventToSheet(draft.date, draft.time, draft.name, seats);

            user.context = null;
            delete user.adminAddEventDraft;

            await bot.sendMessage(chatId,
                `✅ Захід додано:\n\n📅 ${draft.date}\n🕐 ${draft.time}\n📝 ${draft.name}\n💺 ${formatSeatsCount(seats)}`,
                {
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(chatId),
                        resize_keyboard: true
                    }
                }
            );
            return;
        }
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.afisha, 'Афіша заходів')) {
        await handleShowAffishaIntent(chatId, user);
        return;
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.editProfile, 'Редагувати профіль')) {
        user.context = 'profile-edit-menu';
        await bot.sendMessage(chatId, 'Оберіть, що хочете змінити:', {
            reply_markup: {
                keyboard: [
                    [{ text: PROFILE_EDIT_BUTTONS.changeName }],
                    [{ text: PROFILE_EDIT_BUTTONS.changePhone }],
                    [{ text: NAVIGATION_BUTTONS.menu }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.context === 'profile-edit-menu') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.menu, 'Повернутися в меню')) {
            user.context = null;
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (text === PROFILE_EDIT_BUTTONS.changeName) {
            user.context = 'profile-edit-name';
            await bot.sendMessage(chatId, 'Введіть нове ПІБ (Прізвище Ім\'я По батькові):', {
                reply_markup: {
                    keyboard: [[{ text: NAVIGATION_BUTTONS.back }], [{ text: NAVIGATION_BUTTONS.menu }]],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (text === PROFILE_EDIT_BUTTONS.changePhone) {
            user.context = 'profile-edit-phone';
            await bot.sendMessage(chatId, 'Введіть новий номер телефону (380... або 0...):', {
                reply_markup: {
                    keyboard: [[{ text: NAVIGATION_BUTTONS.back }], [{ text: NAVIGATION_BUTTONS.menu }]],
                    resize_keyboard: true
                }
            });
            return;
        }

        await bot.sendMessage(chatId, 'Будь ласка, оберіть дію кнопками нижче.', {
            reply_markup: {
                keyboard: [
                    [{ text: PROFILE_EDIT_BUTTONS.changeName }],
                    [{ text: PROFILE_EDIT_BUTTONS.changePhone }],
                    [{ text: NAVIGATION_BUTTONS.menu }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.context === 'profile-edit-name') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.menu, 'Повернутися в меню')) {
            user.context = null;
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, NAVIGATION_BUTTONS.back, 'Назад')) {
            user.context = 'profile-edit-menu';
            await bot.sendMessage(chatId, 'Оберіть, що хочете змінити:', {
                reply_markup: {
                    keyboard: [
                        [{ text: PROFILE_EDIT_BUTTONS.changeName }],
                        [{ text: PROFILE_EDIT_BUTTONS.changePhone }],
                        [{ text: NAVIGATION_BUTTONS.menu }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        if (isLikelyInvalidRegistrantName(text)) {
            await bot.sendMessage(chatId, '❌ Некоректне ПІБ. Введіть, будь ласка, мінімум ім\'я та прізвище.');
            return;
        }

        const profileData = await resolveRegistrantFormData(chatId, user);
        profileData.name = String(text || '').trim();
        profileData.chatId = String(chatId || '');
        profileData.username = String((user && user.username) || profileData.username || '').trim();

        try {
            await appendRegistrationRow(chatId, profileData);
            Object.assign(user, profileData);
            knownUsers[chatId] = Object.assign({}, knownUsers[chatId] || {}, profileData);
            user.context = null;

            await bot.sendMessage(chatId, `✅ ПІБ оновлено: ${profileData.name}`, {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Не вдалося оновити ПІБ: ${error && error.message ? error.message : 'невідома помилка'}`);
        }
        return;
    }

    if (user.context === 'profile-edit-phone') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.menu, 'Повернутися в меню')) {
            user.context = null;
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, NAVIGATION_BUTTONS.back, 'Назад')) {
            user.context = 'profile-edit-menu';
            await bot.sendMessage(chatId, 'Оберіть, що хочете змінити:', {
                reply_markup: {
                    keyboard: [
                        [{ text: PROFILE_EDIT_BUTTONS.changeName }],
                        [{ text: PROFILE_EDIT_BUTTONS.changePhone }],
                        [{ text: NAVIGATION_BUTTONS.menu }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }

        const normalizedPhone = normalizeUaPhoneForRegistration(text);
        if (!normalizedPhone) {
            await bot.sendMessage(chatId, '❌ Некоректний номер. Введіть у форматі 380XXXXXXXXX або 0XXXXXXXXX.');
            return;
        }

        const profileData = await resolveRegistrantFormData(chatId, user);
        profileData.phone = normalizedPhone;
        profileData.chatId = String(chatId || '');
        profileData.username = String((user && user.username) || profileData.username || '').trim();

        try {
            await appendRegistrationRow(chatId, profileData);
            Object.assign(user, profileData);
            knownUsers[chatId] = Object.assign({}, knownUsers[chatId] || {}, profileData);
            user.context = null;

            await bot.sendMessage(chatId, `✅ Телефон оновлено: ${profileData.phone}`, {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Не вдалося оновити телефон: ${error && error.message ? error.message : 'невідома помилка'}`);
        }
        return;
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.friend, 'Зареєструвати подругу') && (!user.selectedEventsList || user.selectedEventsList.length === 0)) {
        await startFriendRegistrationFlow(chatId, user);
        return;
    }

    if (matchesCommand(text, FRIEND_FLOW_BUTTONS.addAnother, 'Зареєструвати ще подругу')) {
        await startFriendRegistrationFlow(chatId, user);
        return;
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.reminders, 'Нагадування')) {
        clearFriendRegistrationState(user);
        await showUserRemindersOverview(chatId, user);
        return;
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.violenceHelp, 'Допомога при насильстві')) {
        clearFriendRegistrationState(user);
        clearConsultationState(user);
        user.context = 'violence-help';

        await bot.sendMessage(chatId,
            '🚨 <b>Допомога при насильстві</b>\n\nОберіть, що вам потрібно зараз:\n\n⚡ Негайна допомога і безпека\n☎️ Гарячі лінії\n🛑 Локальні служби у вашому районі\n⚖️ Правова та 🏥 медична допомога\n\nЯкщо є пряма загроза життю - телефонуйте 102.', {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buildViolenceHelpKeyboard(chatId),
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.context === 'violence-help') {
        const violenceHelpMessages = {
            [VIOLENCE_HELP_BUTTONS.urgentNow]: `⚡ <b>Як діяти зараз</b>

1. Якщо є небезпека - телефонуйте <b>102</b>.
2. Спробуйте перейти у безпечне місце (сусіди, магазин, аптека, укриття).
3. Зв'яжіться з гарячою лінією <b>1547</b> або <b>116 123</b>.
4. Якщо є травми - зверніться по медичну допомогу та зафіксуйте ушкодження.

Не видаляйте повідомлення/фото/аудіо - це може бути важливим доказом.`,
            [VIOLENCE_HELP_BUTTONS.hotlines]: `☎️ <b>Гарячі лінії (коротко)</b>

• <b>1547</b> - урядова лінія (цілодобово, анонімно)
• <b>116 123</b> / 0 800 500 335 - домашнє насильство
• <b>116 111</b> / 0 800 500 225 - для дітей та молоді
• <b>3033</b> - репродуктивне здоров'я (09:00-18:00)
• <b>0 800 202 334</b> - БФ «Сильні»

Онлайн підтримка: https://avrora-help.org.ua/home`,
            [VIOLENCE_HELP_BUTTONS.police]: `👮 <b>Поліція</b>

• Екстрено: <b>102</b> (цілодобово)
• Для швидкого виклику: https://t.me/female_app_bot

ГУНП Дніпропетровської області:
📍 м. Дніпро, вул. Троїцька, 20а
📞 +38 (056) 756 50 01
📧 vdz@dp.police.gov.ua`,
            [VIOLENCE_HELP_BUTTONS.socialPsychologicalHelp]: 'Оберіть район кнопками нижче.',
            [VIOLENCE_HELP_BUTTONS.coordinationAdministrativeHelp]: `🧭 <b>Координація та адміндопомога</b>

Департамент соцзахисту населення Дніпропетровської ОВА
📍 м. Дніпро, вул. Набережна Перемоги, 26
📞 +38 (056) 770 90 29
📧 gupczn@adm.dp.gov.ua
⏰ пн-чт 08:00-17:00, пт 08:00-15:45`,
            [VIOLENCE_HELP_BUTTONS.legalHelp]: `⚖️ <b>Правова допомога</b>

Головна безоплатна лінія:
📞 <b>0 800 213 103</b> (цілодобово)

Додатково:
• БФ «Слов'янське Серце»: +38 (050) 597 74 23
• ГО «М.АРТ.ІН-клуб»: +38 (099) 632 77 01
• Центр допомоги врятованим: +38 (099) 245 21 21
• БФ «Право на захист»: +38 (099) 507 50 90

Онлайн-заявка: r2p.org.ua`,
            [VIOLENCE_HELP_BUTTONS.medicalHelp]: `🏥 <b>Медична допомога</b>

Швидкий контакт:
• <b>3033</b> (пн-пт 09:00-18:00)

Комплексна підтримка BRAVE&SAFE (Дніпро):
• +38 (093) 521 82 93
• +38 (050) 577 83 65

Допомога постраждалим від сексуального насильства:
• БФ «Сильні»: <b>0 800 202 334</b>
• t.me/strong_help_bot

Для локальних сервісів оберіть «🛑 Спеціалізовані служби».`
        };

        if (matchesCommand(text, VIOLENCE_HELP_BUTTONS.specializedServices, 'Спеціалізовані служби')) {
            user.context = 'violence-help-specialized-district';
            await bot.sendMessage(chatId, `🛑 <b>Спеціалізовані служби</b>

Оберіть район - покажу контакти саме для вашої громади.`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: buildViolenceHelpDistrictKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, VIOLENCE_HELP_BUTTONS.socialPsychologicalHelp, 'Соціально-психологічна допомога')) {
            user.context = 'violence-help-social-district';
            await bot.sendMessage(chatId, `💛 <b>Соціально-психологічна допомога</b>

Оберіть район - покажу перевірені служби та простори підтримки.`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: buildViolenceHelpSocialDistrictKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, VIOLENCE_HELP_BUTTONS.coordinationAdministrativeHelp, 'Координація та адміністративна допомога') && !isAdminChatId(chatId)) {
            await bot.sendMessage(chatId, 'Цей розділ доступний лише адміністратору.', {
                reply_markup: {
                    keyboard: buildViolenceHelpKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (violenceHelpMessages[text]) {
            await bot.sendMessage(chatId, violenceHelpMessages[text], {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: buildViolenceHelpKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }
    }

    if (user.context === 'violence-help-specialized-district') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.back)) {
            user.context = 'violence-help';
            delete user.selectedViolenceHelpDistrict;
            await bot.sendMessage(chatId, '🚨 Допомога при насильстві: оберіть потрібний розділ.', {
                reply_markup: {
                    keyboard: buildViolenceHelpKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, NAVIGATION_BUTTONS.menu)) {
            user.context = null;
            delete user.selectedViolenceHelpDistrict;
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        const districtButtons = Object.values(VIOLENCE_HELP_DISTRICT_BUTTONS);

        if (districtButtons.includes(text)) {
            user.context = 'violence-help-specialized-type';
            user.selectedViolenceHelpDistrict = text;
            await bot.sendMessage(chatId, `🧭 Оберіть вид допомоги:

🚗 Мобільні бригади
💬 Консультативні служби
🏠 Денні центри та кризові кімнати
🛏 Притулки`, {
                reply_markup: {
                    keyboard: buildViolenceHelpSpecializedTypeKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        await bot.sendMessage(chatId, 'Будь ласка, оберіть район кнопками нижче.', {
            reply_markup: {
                keyboard: buildViolenceHelpDistrictKeyboard(),
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.context === 'violence-help-social-district') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.back)) {
            user.context = 'violence-help';
            await bot.sendMessage(chatId, '🚨 Допомога при насильстві: оберіть потрібний розділ.', {
                reply_markup: {
                    keyboard: buildViolenceHelpKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, NAVIGATION_BUTTONS.menu)) {
            user.context = null;
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        const socialDistrictMessages = {
            [VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.regional]: `🟡 <b>Дніпропетровський обласний рівень</b>

1. Дніпропетровський обласний центр соціальних служб для сім'ї, дітей та молоді

📍 м. Дніпро, просп. О. Поля, 83/2
📞 +38 (056) 370 48 19, +38 (056) 370 48 22
⏰ пн–пт 09:00–18:00

2. КЗ «Дніпропетровський центр соціально-психологічної допомоги ДОР»

📍 м. Дніпро, просп. Праці, 24
📞 +38 (056) 376 53 83
⏰ пн–пт 09:00–18:00`,
            [VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.dnipro]: `🏙 <b>Дніпровський район — соціально-психологічна допомога</b>

1. Центр допомоги врятованим (UNFPA / ГО «М.АРТ.ІН-клуб»)

📍 м. Дніпро, вул. Воскресенська, 32
📞 +38 (099) 245 21 21
⏰ пн–пт 10:00–18:00

2. Безпечний простір для жінок і дівчат (IRC)

📍 м. Дніпро, вул. Січеславська Набережна, 20
📞 +38 (093) 450 72 89
⏰ пн–пт 09:00–17:30

3. «Вільна» — дружній простір для жінок і дівчат (UNFPA / ГО «М.АРТ.ІН-клуб»)

📍 м. Дніпро, житл. масив Перемога 5, вул. Бульвар Слави, 2а
📞 +38 (066) 000 86 98
⏰ ср–нд 11:00–20:00

4. Безпечний простір БО «Позитивні жінки» (International Medical Corps)

📍 м. Дніпро, вул. Театральна, 2/302
📞 +38 (098) 029 48 58
⏰ пн–пт 09:00–18:00

5. Кар'єрний хаб «Вона.Хаб» (UNFPA / ГО «М.АРТ.ІН-клуб»)

📍 м. Дніпро, вул. Якова Самарського, 6
📞 +38 (093) 662 6715
⏰ пн–пт 09:00–17:00

6. Безпечні простори ГО «Дівчата»: «Дівчата.Діти» (для дітей та батьків)

📍 м. Дніпро, пр. Миру, 18
📞 +38 (066) 786 30 77
⏰ пн–сб 10:00–18:00
🔗 Telegram канал

ГЗН / Кейс-менеджмент

1. БО «Позитивні жінки»

📞 +38 (098) 029 48 58
⏰ пн–пт 09:00–18:00
💼 Послуги: кейс-менеджмент, психологічна підтримка, просвітницька робота, соціальний супровід

2. Інтегрований центр підтримки «Brave and Safe» (Health Right International)

📍 м. Дніпро, вул. Ламана, 1 поверх, каб. 103, 106, 107
📞 +38 (093) 521 82 75, +38 (050) 577 91 75, +38 (098) 114 78 72
⏰ пн–пт 09:00–16:00

3. UNFPA / ГО «М.АРТ.ІН-клуб»

📞 +38 (095) 680 16 77
⏰ пн–пт 09:00–18:00

4. ГО «Дівчата» / CARE

📞 +38 (099) 301 09 71, +38 (099) 391 09 88
⏰ пн–пт 09:00–18:00
💼 Послуги: інформування, консультування, соціальний супровід, інформація щодо поселення, евакуації та CASH допомога`,
            [VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.kamianske]: `🏢 <b>Кам'янський район</b>

1. «Вільна» — дружній простір (UNFPA / ГО «М.АРТ.ІН-клуб»)

📍 м. Кам'янське, просп. Тараса Шевченка, 33а
📞 +38 (066) 001 86 98
⏰ ср–нд 11:00–20:00

2. «Свій Простір» — безпечний простір (NPA / ГО «М.АРТ.ІН-клуб»)

📍 м. Кам'янське, бульв. Будівельників, 4б
📞 +38 (050) 304 42 01
⏰ вт–сб 10:00–19:00

3. ГЗН Кейс-менеджмент (UNFPA / ГО «М.АРТ.ІН-клуб»)

📞 +38 (095) 680 18 70
⏰ пн–пт 09:00–18:00

4. ГЗН Кейс-менеджмент (ГО «Дівчата» / CARE)

📞 +38 (099) 301 09 71, +38 (099) 391 09 88
⏰ пн–пт 09:00–18:00
💼 Послуги: інформування, консультування, соціальний супровід, евакуація, CASH допомога`,
            [VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.kryvyiRih]: `🏭 <b>Криворізький район</b>

1. «Вільна» — дружній мобільний простір (UNFPA / ГО «М.АРТ.ІН-клуб»)

📞 +38 (066) 006 86 98
⏰ ср–нд 11:00–20:00

2. «Дівчата.Діти» — безпечний простір для дітей та батьків (ГО «Дівчата»)

📍 м. Кривий Ріг, 5-й Зарічний мікрорайон, 29
📞 +38 (050) 731 24 98
⏰ пн–сб 10:00–17:00

3. ГЗН Кейс-менеджмент (UNFPA / ГО «М.АРТ.ІН-клуб»)

📞 +38 (095) 680 10 82, +38 (095) 680 16 28
⏰ пн–пт 09:00–18:00

4. ГЗН Кейс-менеджмент (ГО «Дівчата» / CARE)

📞 +38 (099) 301 09 33
⏰ пн–пт 09:00–18:00

5. ГЗН Кейс-менеджмент (ГО «Інша Жінка»)

📞 +38 (067) 853 67 87
⏰ пн–пт 09:00–18:00`,
            [VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS.pavlohrad]: `🏘 <b>Павлоградський район</b>

1. Безпечний простір для жінок і дівчат (ГО «Дівчата»)

📍 м. Павлоград, вул. Центральна, 98 (РДА)
📞 +38 (063) 479 53 17
⏰ вт–сб 10:00–18:00

2. ГЗН Кейс-менеджмент (UNFPA / ГО «М.АРТ.ІН-клуб»)

📞 +38 (095) 680 17 23
⏰ пн–пт 09:00–18:00

3. ГЗН Кейс-менеджмент (ГО «Дівчата» / CARE)

📞 +38 (099) 301 09 71, +38 (099) 391 09 88
⏰ пн–пт 09:00–18:00`
        };

        const districtButtons = Object.values(VIOLENCE_HELP_SOCIAL_PSYCH_DISTRICT_BUTTONS);

        if (districtButtons.includes(text)) {
            await bot.sendMessage(chatId, socialDistrictMessages[text], {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: buildViolenceHelpSocialDistrictKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        await bot.sendMessage(chatId, 'Будь ласка, оберіть район кнопками нижче.', {
            reply_markup: {
                keyboard: buildViolenceHelpSocialDistrictKeyboard(),
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.context === 'violence-help-specialized-type') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.back)) {
            user.context = 'violence-help-specialized-district';
            await bot.sendMessage(chatId, '💡 Оберіть свій район:', {
                reply_markup: {
                    keyboard: buildViolenceHelpDistrictKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, NAVIGATION_BUTTONS.menu)) {
            user.context = null;
            delete user.selectedViolenceHelpDistrict;
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        const supportTypeButtons = Object.values(VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS);
        const specializedServiceMessages = {
            [VIOLENCE_HELP_DISTRICT_BUTTONS.dnipro]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🏙 <b>ДНІПРОВСЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади</b>

🤝 UNFPA / ГО «М.АРТ.ІН-клуб» (Дніпровська громада)
Допомога постраждалим від домашнього насильства

📞 +38 (050) 730 09 72
📞 +38 (067) 610 58 01
📞 +38 (066) 250 04 62
📞 +38 (067) 610 56 50
🕘 щодня 09:00–21:00

🤝 CARE / ГО «Дівчата»

📞 +38 (099) 301 07 85
📞 +38 (099) 301 08 82
📞 +38 (099) 301 08 45
🕘 пн–пт 09:00–18:00

🏢 Дніпровський міський центр соціальних служб

📍 м. Дніпро
📞 +38 (056) 785 73 60
📞 +38 (067) 200 40 62
🕘 пн–чт 09:00–18:00, пт 09:00–16:45

🏘 Територіальні громади

Солонянська громада (с-ще Солоне)

📞 +38 (095) 000 28 50
📞 +38 (067) 19 40 400
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Могилівська громада (с. Могилів)

📞 +38 (096) 683 51 82
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Новопокровська громада

📞 +38 (098) 972 87 58
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Царичанська громада (с-ще Царичанка)

📞 +38 (097) 838 00 39
📞 (05690) 31631
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Китайгородська громада (с. Китайгород)

📞 +38 (066) 310 40 76
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Чумаківська громада (с. Чумаки)

📞 +38 (050) 157 06 27
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Обухівська громада (с-ще Обухівка)

📞 +38 (066) 402 54 54
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Ляшківська громада (с. Ляшківка)

📞 +38 (099) 057 85 56
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Слобожанська громада (с-ще Слобожанське)

📞 (056) 719 91 53
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Любимівська громада (с. Любимівка)

📞 +38 (067) 200 28 18
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

Сурсько-Литовська громада (с. Сурсько-Литовське)

📞 +38 (067) 619 29 33
🕘 пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices]: `🏙 <b>ДНІПРОВСЬКИЙ РАЙОН</b>
💬 <b>Консультативні служби</b>

1. Служба первинного соціально-психологічного консультування осіб (Консультативна служба), які постраждали від домашнього насильства та/або насильства за ознакою статі, Дніпровського міського центру соціальних служб

📍 м. Дніпро, просп. Нігояна, 3
📞 +38 (066) 806 23 50
🕘 пн–чт 09:00–18:00, пт 09:00–16:45

2. Служба первинного соціально-психологічного консультування осіб (Консультативна служба), які постраждали від домашнього насильства та/або насильства за ознакою статі, КЗ «Центр надання соціальних послуг» Підгородненської міської ради

📍 м. Підгороднє, вул. Центральна, 25
📞 +38 (063) 335 99 53
🕘 пн–чт 09:00–18:00, пт 09:00–16:45

3. Служба первинного соціально-психологічного консультування осіб (Консультативна служба), які постраждали від домашнього насильства та/або насильства за ознакою статі, при КЗ «Центр соціальних служб Петриківської селищної ради»

📍 смт Петриківка, просп. Петра Калнишевського, 69
📞 +38 (05634) 2 47 99
📞 +38 (093) 441 06 46
🕘 пн–чт 09:00–18:00, пт 09:00–16:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.dayCenters]: `🏙 <b>ДНІПРОВСЬКИЙ РАЙОН</b>
🏠 <b>Денні центри та кризові кімнати</b>

1. Денний центр Дніпровського міського центру соціальних служб

Для постраждалих від ГЗН
📍 м. Дніпро, просп. Нігояна, 3
📞 +38 (066) 448 61 54
📞 +38 (067) 200 25 66
🕘 пн–чт 09:00–18:00, пт 09:00–16:45

Кризова кімната при Денному центрі Дніпровського міського центру соціальних служб

Для постраждалих від ГЗН
📞 +38 (066) 448 61 54
🕘 цілодобово
📍 адреса не розголошується з безпекових причин

2. Денний центр Новопокровської селищної ради

Соціально-психологічна допомога постраждалим від домашнього насильства та/або насильства за ознакою статі
📍 с. Лугове, вул. Соборна, 6
📞 +38 (098) 972 87 58
🕘 пн–чт 08:00–17:00, пт 08:00–15:45

3. Денний центр та кризова кімната Царичанської селищної ради

Соціально-психологічна допомога постраждалим від домашнього насильства та/або насильства за ознакою статі
📍 с-ще Царичанка, вул. Театральна, 17
📞 (05690) 3-13-43
📞 (05690) 3-30-53
🕘 пн–чт 08:00–17:00, пт 08:00–15:45
Кризова кімната: цілодобово, адреса не розголошується

4. Денний центр та кризова кімната Солонянської селищної ради

Соціально-психологічна допомога постраждалим від домашнього насильства та/або насильства за ознакою статі
📍 с. Військове, вул. Миронова, 8А
📞 +38 (095) 000 28 50
🕘 пн–чт 08:00–17:00, пт 08:00–15:45
Кризова кімната: цілодобово, адреса не розголошується

5. Денний центр Петриківської селищної ради

Соціально-психологічна допомога постраждалим від домашнього насильства та/або насильства за ознакою статі
📍 с. Іванівка, вул. Центральна, 72
📞 +38 093 100 54 80
🕘 пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.shelters]: `🏙 <b>ДНІПРОВСЬКИЙ РАЙОН</b>
🛏 <b>Притулки</b>

1. Притулок для постраждалих від ГЗН (жінки з дітьми)

КЗ «Центр соціальної підтримки дітей та сімей «Мамине Щастя» Дніпровської міської ради»
📍 м. Дніпро
Відділення для жінок з дітьми: +38 (099) 520 79 18, цілодобово
Відділення для жінок без дітей: +38 (099) 520 79 34, цілодобово
📍 Адреси не розголошуються з безпекових причин

2. Притулок для постраждалих від домашнього насильства та/або насильства за ознакою статі

Новопокровська селищна ТГ
📞 +38 (098) 972 87 58, цілодобово
📍 Адреса не розголошується з безпекових причин`
            },
            [VIOLENCE_HELP_DISTRICT_BUTTONS.kryvyiRih]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🏭 <b>КРИВОРІЗЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади</b>

1. Мобільні бригади за підтримки UNFPA / ГО «М.АРТ.ІН-клуб»

Криворізька громада
📞 +38 (067) 452 42 15, +38 (099) 452 42 15
⏰ щоденно 09:00–21:00

2. Мобільна бригада за підтримки CARE DE / ГО «Дівчата»

📞 +38 (099) 301 08 96, +38 (099) 301 07 97
⏰ пн–пт 09:00–18:00

3. Криворізький міський центр соціальних служб

📍 м. Кривий Ріг
📞 +38 (097) 357 71 00
⏰ пн–пт 08:30–16:30

4. КЗ «Кризовий центр для жінок «З надією в майбутнє»

📍 м. Кривий Ріг
📞 +38 (096) 966 43 89, +38 (099) 365 63 44
⏰ цілодобово

5. КЗ «Центр надання соціальних послуг» Апостолівської міської ради

📍 м. Апостолове
📞 +38 (067) 77 955 07, +38 (068) 973 09 09
⏰ пн–чт 08:30–17:00, пт 08:00–15:45

6. Вакулівська сільська рада, с. Вакулове

📞 +38 (096) 578 43 32
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

7. Глеюватська сільська рада, с. Глеюватка

📞 +38 (097) 402 74 97
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

8. Грушівська сільська рада, с. Грушівка

📞 +38 (068) 444 27 81
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

9. Девладівська сільська рада, с-ще Девладово

📞 +38 (097) 444 73 39
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

10. Зеленодольська міська рада, м. Зеленодольськ

📞 +38 (096) 026 31 85
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

11. Лозуватська сільська рада, с. Лозуватка

📞 +38 (098) 062 81 81
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

12. Нивотрудівська сільська рада, с. Нива Трудова

📞 +38 (063) 993 85 22
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

13. Новолатівська сільська рада, с. Новолатівка

📞 +38 (096) 068 54 98
⏰ пн–чт 08:00–17:00, пт 08:00–16:00

14. Новопільська сільська рада, с. Новопілля

📞 +38 (098) 541 36 72
⏰ пн–чт 08:00–17:00, пт 08:00–16:00

15. Софіївський центр надання соціальних послуг, с-ще Софіївка

📞 +38 (063) 625 74 45
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

16. Широківська селищна рада, с-ще Широке

📞 +38 (098) 620 97 23
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`
                ,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices]: `🏭 <b>КРИВОРІЗЬКИЙ РАЙОН</b>
💬 <b>Консультативні служби</b>

1. Апостолівська міська рада — спеціалізована служба первинного соціально-психологічного консультування

📍 м. Апостолове, вул. Остапа Вишні, 1
📞 +38 (068) 973 09 09
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

2. Девладівська сільська рада — спеціалізована служба первинного соціально-психологічного консультування

📍 с-ще Девладово, вул. Центральна, 2
📞 +38 (098) 587 34 05
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

3. Широківська селищна рада — спеціалізована служба первинного соціально-психологічного консультування

📍 с-ще Широке, вул. Вишнева, 1
📞 +38 (097) 642 89 40
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.dayCenters]: `🏭 <b>КРИВОРІЗЬКИЙ РАЙОН</b>
🏠 <b>Денні центри та кризові кімнати</b>

1. Денний центр соціально-психологічної допомоги (структурний підрозділ КЗ «Кризовий центр для жінок «З надією в майбутнє»)

📍 м. Кривий Ріг, вул. Вадима Гурова, 43
📞 +38 (096) 965 85 27
⏰ пн–пт 08:00–17:00`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.shelters]: `🏭 <b>КРИВОРІЗЬКИЙ РАЙОН</b>
🛏 <b>Притулки</b>

1. Притулок для постраждалих від ГЗН жінок з дітьми (КЗ «Кризовий центр для жінок, постраждалих від насильства в сім’ї «З надією в майбутнє»)

📍 м. Кривий Ріг
📞 +38 (096) 966 43 89
⏰ цілодобово
⚠️ адреса не розголошується з безпекових питань`
            },
            [VIOLENCE_HELP_DISTRICT_BUTTONS.kamianske]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🏢 <b>КАМ’ЯНСЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади соціально-психологічної допомоги</b>

1. UNFPA / ГО «М.АРТ.ІН-клуб»

📍 Кам’янський район
📞 +38 (067) 452 42 31, +38 (099) 452 42 31

2. CARE DE / ГО «Дівчата»

📞 +38 (066) 015 14 06, +38 (099) 301 08 82, +38 (099) 301 08 45
⏰ пн–пт 09:00–18:00

3. Кам’янський центр надання соціальних послуг

📍 м. Кам’янське
📞 +38 (068) 601 20 49
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

4. Божедарівська селищна рада

📍 с-ще Божедарівка
📞 +38 (068) 224 03 12
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

5. Верхівцевська міська рада

📍 м. Верхівцеве
📞 +38 (066) 176 72 46
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

6. КУ «Центр надання соціальних послуг» Верхньодніпровськ

📍 м. Верхньодніпровськ
📞 +38 (093) 326 81 47
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

7. Вишнівська селищна рада

📍 смт Вишневе
📞 +38 (096) 607 94 43, +38 (067) 719 72 19
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

8. Вільногірська міська рада

📍 м. Вільногірськ
📞 +38 (067) 914 51 82
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

9. Жовтоводська міська рада (КЗ «Центр надання соціальних послуг»)

📍 м. Жовті Води
📞 +38 (099) 724 23 68
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

10. Затишнянська сільська рада

📍 с. Затишне
📞 +38 (097) 965 63 97
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

11. Криничанська селищна рада

📍 с-ще Кринички
📞 +38 (099) 364 31 58
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

12. Лихівська селищна рада

📍 с-ще Лихівка
📞 +38 (068) 630 76 78
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

13. П’ятихатська міська рада

📍 м. П’ятихатки
📞 +38 (067) 161 88 53
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

14. Саксаганська сільська рада (КУ «Центр надання соціальних послуг»)

📍 с. Грушуватка
📞 +38 (098) 376 85 26
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices]: `🏢 <b>КАМ’ЯНСЬКИЙ РАЙОН</b>
💬 <b>Консультативні служби</b>

1. Спеціалізована служба первинного соціально-психологічного консультування (Кам’янський ЦНСП)

📍 м. Кам’янське, просп. Свободи, 36
📞 +38 (068) 601 20 49
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.dayCenters]: `🏢 <b>КАМ’ЯНСЬКИЙ РАЙОН</b>
🏠 <b>Денні центри та кризові кімнати</b>

1. Денний центр соціально-психологічної допомоги (Кам’янський ЦНСП)

📍 м. Кам’янське, просп. Свободи, 36
📞 +38 (050) 173 68 14
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

2. Кризова кімната Norwegian People’s Aid (NPA) / ГО «М.АРТ.ІН-клуб»

📞 +38 (050) 304 41 89
⏰ цілодобово`
            },
            [VIOLENCE_HELP_DISTRICT_BUTTONS.pavlohrad]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🏘 <b>ПАВЛОГРАДСЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади соціально-психологічної допомоги</b>

1. UNFPA / ГО «М.АР.Т.ІН-клуб»

📞 +38 (067) 452 42 16, +38 (099) 452 42 16
📍 Павлоградський р-н
⏰ щоденно 09:00–21:00

2. CARE DE / ГО «Дівчата»

📞 +38 (099) 301 07 85, +38 (099) 301 08 82, +38 (099) 301 08 45
⏰ пн–пт 09:00–18:00

3. КЗ «Центр надання соціально-психологічних послуг» Павлоградський район

📍 м. Павлоград
📞 +38 (095) 808 81 50
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

4. Богданівська сільська рада

📍 с. Богданівка
📞 (097) 210 05 59, (095) 479 75 46
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

5. Вербківська сільська рада

📍 с. Вербки
📞 +38 (050) 966 22 19, (0563) 258 121
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

6. Межеріцька сільська рада

📍 с. Межирич
📞 +38 (099) 298 84 76
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

7. КЗ «Центр соціальних служб» Тернівської міської ради

📍 м. Тернівка
📞 +38 (095) 718 10 55
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

8. Центр надання соціальних послуг Юр’ївської селищної ради

📍 с-ще Юр’ївка
📞 (05690) 511 33, (05635) 511 31, +38 (066) 821 72 29
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.dayCenters]: `🏘 <b>ПАВЛОГРАДСЬКИЙ РАЙОН</b>
🏠 <b>Денні та кризові центри</b>

1. Денний центр для постраждалих від ГЗН

📍 м. Павлоград, вул. Дніпровська, 18
📞 +38 (095) 808 81 50
⏰ пн–пт 09:00–17:00

2. Кризова кімната при Денному центрі

📍 м. Павлоград
📞 +38 (095) 808 81 50
⏰ цілодобово

3. Пункт тимчасового перебування при Центрі надання соціальних послуг Юр’ївської селищної ради

📞 +38 (066) 997 22 21
⏰ пн–чт 08:00–17:00, пт 08:00–15:45
📍 адреса не розголошується з безпекових причин

4. Пункт соціально-психологічної допомоги при КЗ «Центр надання соціальних послуг» Троїцької сільської ради

📞 +38 (066) 575 18 79
⏰ пн–чт 08:00–17:00, пт 08:00–15:45
📍 адреса не розголошується з безпекових причин`
            },
            [VIOLENCE_HELP_DISTRICT_BUTTONS.samar]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🌾 <b>САМАРІВСЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади соціально-психологічної допомоги</b>

1. Новомосковський центр надання соціальних послуг

📍 м. Самар
📞 +38 (066) 098 56 02
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

2. CARE DE / ГО «Дівчата»

📞 +38 (099) 301 07 85, +38 (099) 301 08 45
⏰ пн–пт 09:00–18:00

3. КЗ «Центр надання соціальних послуг» Губиниської селищної ради

📍 с-ще Губиниха
📞 +38 (098) 666 57 09
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

4. Личківська сільська рада

📍 с. Личкове
📞 +38 (098) 667 45 95
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

5. КУ «Центр надання соціальних послуг» Магдалинівської селищної ради

📍 с-ще Магдалинівка
📞 +38 (066) 161 17 11
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

6. Перещепинська міська рада

📍 м. Перещепине
📞 +38 (097) 481 22 40
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

7. Піщанська сільська територіальна громада

📍 с. Піщанка
📞 +38 (093) 328 71 67
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

8. КЗ «Центр соціальних служб» Черкаської селищної ради

📍 м. Самар
📞 +38 (063) 137 53 93
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

9. КУ «Центр надання соціальних послуг» Чернеччинської сільської ради

📍 с. Гупалівка
📞 +38 (066) 120 90 37, +38 (099) 366 14 04
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices]: `🌾 <b>САМАРІВСЬКИЙ РАЙОН</b>
💬 <b>Спеціалізовані служби первинного консультування</b>

1. КУ «Центр надання соціальних послуг» Магдалинівської селищної ради

📍 с-ще Магдалинівка, вул. Набережна, 1Е
📞 +38 (066) 161 17 11
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`
            },
            [VIOLENCE_HELP_DISTRICT_BUTTONS.nikopol]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🌊 <b>НІКОПОЛЬСЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади соціально-психологічної допомоги</b>

1. Управління гуманітарної політики Нікопольської міської ради

📍 м. Нікополь
📞 (095) 199 67 57
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

2. КЗ «Центр надання соціальних послуг» Марганецької міської ради

📍 м. Марганець
📞 +38 (066) 815 95 99
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

3. Мирівська сільська рада

📍 с. Топила
📞 +38 (097) 810 96 86
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

4. КЗ «Першотравневський сільський центр соціальних служб»

📍 с. Чкалове
📞 +38 (066) 368 46 74, +38 (050) 620 69 63
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

5. КЗ «Центр соціальних служб» Покровської міської ради

📍 м. Покров
📞 (05667) 41 733, +38 (095) 90 70 792
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

6. КЗ «Покровський сільський центр надання соціальних послуг» Покровської сільської ради

📍 с. Покровське
📞 +38 (095) 060 50 94
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

7. КЗ «Центр соціальних послуг «Крок назустріч»» Томаківської селищної ради

📍 с-ще Томаківка
📞 +38 (096) 32 51 456
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

8. КУ «Центр надання соціальних послуг» Червоногригорівської селищної ради

📍 с-ще Червоногригорівка
📞 +38 (099) 470 37 76
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices]: `🌊 <b>НІКОПОЛЬСЬКИЙ РАЙОН</b>
💬 <b>Спеціалізована служба первинного консультування</b>

КЗ «Центр соціальних послуг «Крок назустріч»» Томаківської селищної ради

📍 с-ще Томаківка, вул. Лікарняна, 2-В
📞 +38 (096) 32 51 456
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`
            },
            [VIOLENCE_HELP_DISTRICT_BUTTONS.synelnykove]: {
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.mobileBrigades]: `🌻 <b>СИНЕЛЬНИКІВСЬКИЙ РАЙОН</b>
🚗 <b>Мобільні бригади соціально-психологічної допомоги</b>

1. Мобільна бригада CARE DE/ГО «Дівчата»

📞 +38 (099) 301 07 85, +38 (099) 301 08 82, +38 (099) 301 08 45
⏰ пн–пт 09:00–18:00

2. Синельниківська міська рада

📍 м. Синельникове
📞 +38 (097) 014 93 59
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

3. Миколаївська сільська рада

📍 с. Миколаївка
📞 +38 (099) 295 94 70
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

4. Брагинівська сільська рада

📍 с. Богинівка
📞 +38 (098) 653 54 20
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

5. Межівська селищна рада

📍 с-ще Межова
📞 +38 (066) 847 24 94
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

6. Новопавлівська сільська рада

📍 с. Новопавлівка
📞 +38 (095) 565 88 21
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

7. Дубовиківська сільська рада

📍 с-ще Чаплине
📞 +38 (095) 855 89 92
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

8. Васильківська селищна рада

📍 с-ще Васильківка
📞 +38 (066) 233 65 29
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

9. Роздорська селищна рада (ЦНАП)

📍 с. Роздори
📞 +38 (096) 735 58 49
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

10. Маломихайлівська сільська рада

📍 с. Маломихайлівка
📞 +38 (066) 532 38 65
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

11. КЗ «Першотравенський міський центр соціальних служб»

📍 м. Першотравенськ
📞 +38 (095) 903 12 14
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

12. Покровська селищна рада

📍 сел. Покровка
📞 +38 (066) 789 10 38
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

13. Славгородська селищна рада

📍 с-ще Славгород
📞 +38 (096) 924 83 88
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

14. Зайцівська сільська рада

📍 с. Зайцеве
📞 +38 (050) 194 62 01
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

15. Петропавлівська селищна рада

📍 с-ще Петропавлівка
📞 +38 (099) 539 41 10
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

16. Великомихайлівська сільська рада

📍 с. Великомихайлівка
📞 +38 (066) 036 86 93
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

17. Слов’янська сільська рада

📍 с. Слов’янка
📞 +38 (066) 432 16 36
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

18. Раївська сільська рада

📍 м. Синельникове
📞 +38 (093) 824 05 78
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

19. Українська сільська рада

📍 с-ще Українське
📞 +38 (096) 347 07 56
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

20. Іларіонівська селищна рада

📍 с. Яворницьке
📞 +38 (063) 706 14 48
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.consultativeServices]: `🌻 <b>СИНЕЛЬНИКІВСЬКИЙ РАЙОН</b>
💬 <b>Консультативні служби</b>

1. Покровська селищна рада

📍 с-ще Покровське, вул. Дмитра Яворницького, 119, 4 поверх, каб. 403, 405
📞 +38 (050) 909 43 80
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

2. Васильківська селищна рада

📍 с-ще Васильківка, пров. Парковий, 8
📞 +38 (097) 922 59 31
⏰ пн–чт 09:00–18:00, пт 09:00–16:45

3. Дубовиківська сільська рада

📍 с-ще Чаплине, вул. Лікарняна, 6
📞 +38 (063) 571 18 56
⏰ пн–чт 09:00–18:00, пт 09:00–16:45

4. Миколаївська сільська рада

📍 с. Миколаївка, вул. Козацька, 51
📞 +38 (099) 961 95 12
⏰ пн–чт 08:00–17:00, пт 08:00–15:45

5. Петропавлівська міська рада

📍 м. Петропавлівка, вул. Героїв України, 53
📞 +38 (099) 539 41 10
⏰ пн–чт 08:00–17:00, пт 08:00–15:45`,
                [VIOLENCE_HELP_SPECIALIZED_TYPE_BUTTONS.dayCenters]: `🌻 <b>СИНЕЛЬНИКІВСЬКИЙ РАЙОН</b>
🏠 <b>Денні центри та кризові кімнати</b>

1. Денний центр для постраждалих від ГЗН (Васильківська селищна рада)

📍 смт. Васильківка, вул. Успішна, 160
📞 +38 (096) 948 08 09
⏰ пн–пт 08:00–17:00

2. Кризова кімната при Денному центрі (Васильківська селищна рада)

📞 +38 (096) 948 08 09
📍 адреса не розголошується з безпекових причин`
            }
        };

        if (supportTypeButtons.includes(text)) {
            const districtLabel = user.selectedViolenceHelpDistrict || 'обраного району';
            const specializedMessage = specializedServiceMessages[districtLabel] && specializedServiceMessages[districtLabel][text];

            if (specializedMessage) {
                await bot.sendMessage(chatId, specializedMessage, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: buildViolenceHelpSpecializedTypeKeyboard(),
                        resize_keyboard: true
                    }
                });
                return;
            }

            await bot.sendMessage(chatId,
                `✅ Ви обрали: ${text}\n\n📍 Район: ${districtLabel}\n\nНатисніть «📞 Контакти» → «Написати звернення», і команда допоможе з подальшим супроводом.`, {
                reply_markup: {
                    keyboard: buildViolenceHelpSpecializedTypeKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        await bot.sendMessage(chatId, 'Будь ласка, оберіть вид допомоги кнопками нижче.', {
            reply_markup: {
                keyboard: buildViolenceHelpSpecializedTypeKeyboard(),
                resize_keyboard: true
            }
        });
        return;
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.contacts, 'Контакти')) {
        clearFriendRegistrationState(user);
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
                    [{ text: NAVIGATION_BUTTONS.menu }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (matchesCommand(text, MAIN_MENU_BUTTONS.consultations, 'Індивідуальні консультації')) {
        clearFriendRegistrationState(user);
        clearConsultationState(user);
        delete user.eventButtonMap;
        user.context = 'consultation-specialist';
        user.consultationDraft = {};
        await showConsultationSpecialistMenu(chatId);
        return;
    }

    if (user.context === 'consultation-specialist') {
        if (matchesCommand(text, NAVIGATION_BUTTONS.menu, 'Повернутися в меню', 'Назад в меню')) {
            clearConsultationState(user);
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (matchesCommand(text, NAVIGATION_BUTTONS.back, 'Назад')) {
            clearConsultationState(user);
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        const specialistConfig = getConsultationSpecialistConfigByButton(text);
        if (specialistConfig) {
            const draft = {
                specialistKey: specialistConfig.key,
                specialistLabel: specialistConfig.label,
                sheetName: specialistConfig.sheetName,
                specialistChatId: specialistConfig.specialistChatId
            };

            let availableSlots = [];
            try {
                const refreshed = await refreshConsultationDraftSlots(draft);
                availableSlots = refreshed.availableSlots;
            } catch (error) {
                console.error('❌ Помилка зчитування слотів консультацій:', error && error.message ? error.message : error);
                await bot.sendMessage(chatId,
                    `❌ Не вдалося зчитати доступні дати/час з аркуша «${specialistConfig.sheetName}».
Спробуйте ще раз трохи пізніше.`, {
                    reply_markup: {
                        keyboard: buildConsultationSpecialistMenuKeyboard(),
                        resize_keyboard: true
                    }
                });
                return;
            }

            if (availableSlots.length === 0) {
                const genitiveLabel = specialistConfig.label === 'Психологиня'
                    ? 'психологині'
                    : 'соціальної фахівчині';
                
                await bot.sendMessage(chatId,
                    `Наразі немає вільних місць до ${genitiveLabel}. Спробуйте пізніше.`, {
                    reply_markup: {
                        keyboard: buildConsultationSpecialistMenuKeyboard(),
                        resize_keyboard: true
                    }
                });
                return;
            }

            user.consultationDraft = draft;
            user.context = 'consultation-day';

            await bot.sendMessage(chatId,
                `✅ Обрано: <b>${specialistConfig.label}</b>\n\nОберіть дату консультації:`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: buildConsultationDatesKeyboard(draft.dateButtons),
                    resize_keyboard: true
                }
            });
            return;
        }
    }

    if (user.context === 'consultation-time' && !matchesCommand(text, NAVIGATION_BUTTONS.back, NAVIGATION_BUTTONS.menu)) {
        if (!user.consultationDraft || !user.consultationDraft.specialistKey || !user.consultationDraft.sheetName) {
            clearConsultationState(user);
            await showConsultationSpecialistMenu(chatId, '⚠️ Сесія вибору консультації скинуто. Оберіть фахівчиню ще раз.');
            user.context = 'consultation-specialist';
            user.consultationDraft = {};
            return;
        }

        try {
            await refreshConsultationDraftSlots(user.consultationDraft);
        } catch (error) {
            console.error('❌ Помилка оновлення слотів консультацій:', error && error.message ? error.message : error);
            await bot.sendMessage(chatId, '❌ Не вдалося оновити вільний час. Спробуйте ще раз трохи пізніше.');
            return;
        }

        const refreshedTimeOptions = [...new Set((user.consultationDraft.availableSlots || [])
            .filter((slot) => slot.dateText === user.consultationDraft.dateText)
            .map((slot) => slot.timeText))].sort((left, right) => left.localeCompare(right, 'uk'));
        user.consultationDraft.timeOptions = refreshedTimeOptions;

        const selectedTimeText = String(text || '').trim();
        const timeOptions = Array.isArray(user.consultationDraft && user.consultationDraft.timeOptions)
            ? user.consultationDraft.timeOptions
            : [];

        if (!timeOptions.includes(selectedTimeText)) {
            if (timeOptions.length === 0) {
                user.context = 'consultation-day';
                delete user.consultationDraft?.dateText;
                delete user.consultationDraft?.timeOptions;
                await bot.sendMessage(chatId,
                    'ℹ️ На цю дату вільного часу вже немає. Оберіть, будь ласка, іншу дату.', {
                    reply_markup: {
                        keyboard: buildConsultationDatesKeyboard(Array.isArray(user.consultationDraft.dateButtons) ? user.consultationDraft.dateButtons : []),
                        resize_keyboard: true
                    }
                });
                return;
            }

            await bot.sendMessage(chatId, 'Будь ласка, оберіть час кнопками.', {
                reply_markup: {
                    keyboard: buildConsultationTimeKeyboard(timeOptions),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (!user.consultationDraft || !user.consultationDraft.specialistKey || !user.consultationDraft.dateText) {
            clearConsultationState(user);
            await showConsultationSpecialistMenu(chatId, '⚠️ Сесія вибору консультації скинуто. Оберіть фахівчиню ще раз.');
            user.context = 'consultation-specialist';
            user.consultationDraft = {};
            return;
        }

        const matchingSlot = (user.consultationDraft.availableSlots || []).find((slot) => {
            return slot.dateText === user.consultationDraft.dateText && slot.timeText === selectedTimeText;
        });

        if (!matchingSlot) {
            await bot.sendMessage(chatId, '❌ Обраний час недоступний. Будь ласка, оберіть інший.', {
                reply_markup: {
                    keyboard: buildConsultationTimeKeyboard(timeOptions),
                    resize_keyboard: true
                }
            });
            return;
        }

        user.consultationDraft.timeText = selectedTimeText;
        user.consultationDraft.selectedSlotRowNumber = matchingSlot.rowNumber;
        user.context = 'consultation-description';

        await bot.sendMessage(chatId,
            '📝 <b>Опишіть коротко ваше звернення,</b>\nщоб фахівчиня могла підготуватися до індивідуальної консультації.', {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: NAVIGATION_BUTTONS.back }],
                    [{ text: NAVIGATION_BUTTONS.menu }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    if (user.context === 'consultation-description') {
        const requestText = String(text || '').trim();
        if (requestText.length < 5) {
            await bot.sendMessage(chatId, '❌ Будь ласка, додайте трохи більше деталей (мінімум 5 символів).');
            return;
        }

        const draft = user.consultationDraft || {};
        const registrantData = await resolveRegistrantFormData(chatId, user);
        const registrantName = String(registrantData.name || '').trim();
        const registrantPhone = String(registrantData.phone || '').trim();

        if (!registrantName || !registrantPhone) {
            clearConsultationState(user);
            await bot.sendMessage(chatId,
                '❌ Для запису на консультацію потрібно, щоб у профілі були заповнені ПІБ і номер телефону.\n\nОберіть «Афіша заходів», щоб завершити анкету.', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        try {
            await saveIndividualConsultationRow({
                sheetName: draft.sheetName,
                rowNumber: draft.selectedSlotRowNumber,
                dateText: draft.dateText,
                timeText: draft.timeText,
                name: registrantName,
                phone: registrantPhone,
                requestText
            });

            await notifySpecialistAboutConsultation({
                specialistLabel: draft.specialistLabel,
                specialistChatId: draft.specialistChatId,
                dateText: draft.dateText,
                timeText: draft.timeText,
                name: registrantName,
                phone: registrantPhone,
                requestText,
                userChatId: chatId
            });

            clearConsultationState(user);
            await bot.sendMessage(chatId,
                `✅ <b>Запис на консультацію підтверджено!</b>\n\n` +
                `👩🏻‍💼 Фахівчиня: ${draft.specialistLabel}\n` +
                `📅 Дата: ${draft.dateText}\n` +
                `🕐 Час: ${draft.timeText}\n` +
                `📍 Формат: індивідуальна консультація офлайн (вул. Д. Донцова, 4)\n\n` +
                `📌 Будь ласка, за потреби додаткових уточнень — пишіть нам самостійно. ${draft.key === 'psychologist' ? '@luidmila_psi' : '@DarynaVilna'}`,
                {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        } catch (error) {
            console.error('❌ Помилка запису консультації:', error && error.message ? error.message : error);
            if (String((error && error.message) || '').includes('Обраний час уже зайнятий')) {
                try {
                    await refreshConsultationDraftSlots(draft);
                    const refreshedTimeOptions = [...new Set((draft.availableSlots || [])
                        .filter((slot) => slot.dateText === draft.dateText)
                        .map((slot) => slot.timeText))].sort((left, right) => left.localeCompare(right, 'uk'));

                    if (refreshedTimeOptions.length > 0) {
                        draft.timeOptions = refreshedTimeOptions;
                        delete draft.timeText;
                        delete draft.selectedSlotRowNumber;
                        user.context = 'consultation-time';
                        await bot.sendMessage(chatId,
                            '⏱ Цей час щойно зайняли. Оберіть інший зі списку нижче:', {
                            reply_markup: {
                                keyboard: buildConsultationTimeKeyboard(refreshedTimeOptions),
                                resize_keyboard: true
                            }
                        });
                        return;
                    }

                    user.context = 'consultation-day';
                    delete draft.dateText;
                    delete draft.timeText;
                    delete draft.timeOptions;
                    delete draft.selectedSlotRowNumber;
                    await bot.sendMessage(chatId,
                        '⏱ Всі часи на цю дату вже зайняті. Оберіть, будь ласка, іншу дату.', {
                        reply_markup: {
                            keyboard: buildConsultationDatesKeyboard(Array.isArray(draft.dateButtons) ? draft.dateButtons : []),
                            resize_keyboard: true
                        }
                    });
                    return;
                } catch (refreshError) {
                    console.error('❌ Не вдалося оновити слоти після конфлікту часу:', refreshError && refreshError.message ? refreshError.message : refreshError);
                }
            }

            await bot.sendMessage(chatId,
                `❌ Не вдалося завершити запис на консультацію.\nСпробуйте ще раз пізніше.\n\nДеталі: ${error && error.message ? error.message : 'невідома помилка'}`,
                {
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(chatId),
                        resize_keyboard: true
                    }
                }
            );
            clearConsultationState(user);
            return;
        }
    }

    if (user.context === 'consultation-specialist') {
        await bot.sendMessage(chatId, 'Будь ласка, оберіть одну з кнопок: «Соціальна фахівчиня» або «Психологиня».', {
            reply_markup: {
                keyboard: buildConsultationSpecialistMenuKeyboard(),
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

    const isUnsubscribeFlowActive =
        user.context === 'unsubscribe-root' ||
        user.context === 'unregister' ||
        user.context === 'friend-unregister' ||
        user.context === 'cancel-consultation-select' ||
        user.context === 'cancel-consultation-confirm' ||
        Boolean(user.pendingUnregEventId) ||
        Boolean(user.pendingFriendUnregKey);

    // Перевіряємо чи натиснута кнопка з заходом лише в контексті афіші.
    if (!isUnsubscribeFlowActive && user.context === 'afisha') {
        let selectedEvent = null;
        const selectedEventId = resolveAfishaEventIdFromButtonText(user, text);
        if (selectedEventId) {
            selectedEvent = getAllEvents().find((eventItem) => eventItem.id === selectedEventId) || null;
        }
        if (selectedEvent) {
            const seatsLeft = await getSeatsLeft(selectedEvent.id);

            if (seatsLeft <= 0) {
                user.pendingReserveEventId = selectedEvent.id;
                user.pendingReserveEventName = selectedEvent.name;
                await bot.sendMessage(chatId, `На жаль, на захід "${selectedEvent.name}" місць уже немає.\n\nМожна записатись у резерв.`, {
                    reply_markup: {
                        keyboard: [
                            [{ text: AFISHA_ACTION_BUTTONS.reserve }],
                            [{ text: NAVIGATION_BUTTONS.backToDays }],
                            [{ text: NAVIGATION_BUTTONS.menu }]
                        ],
                        resize_keyboard: true
                    }
                });
                return;
            }

            user.afishaInstantMode = true;
            user.selectedEventsList = [{
                id: selectedEvent.id,
                name: selectedEvent.name,
                date: selectedEvent.date
            }];

            user.currentSelectedEventName = selectedEvent.name;
            user.currentSelectedEventId = selectedEvent.id;
            delete user.pendingReserveEventId;
            delete user.pendingReserveEventName;
            await startSelectedEventsRegistration(chatId, user, { instantAfisha: true });
            return;
        }
    }

    if (!isUnsubscribeFlowActive && user.context === 'afisha' && text === AFISHA_ACTION_BUTTONS.reserve && user.pendingReserveEventId) {
        const reserveEvent = getAllEvents().find((eventItem) => eventItem.id === user.pendingReserveEventId);
        if (!reserveEvent) {
            await bot.sendMessage(chatId, '❌ Захід для резерву не знайдено. Спробуйте обрати його з афіші ще раз.', {
                reply_markup: {
                    keyboard: getAfishaDaysKeyboard(),
                    resize_keyboard: true
                }
            });
            delete user.pendingReserveEventId;
            delete user.pendingReserveEventName;
            return;
        }

        user.afishaInstantMode = true;
        user.selectedEventsList = [{
            id: reserveEvent.id,
            name: reserveEvent.name,
            date: reserveEvent.date
        }];
        user.currentSelectedEventName = reserveEvent.name;
        user.currentSelectedEventId = reserveEvent.id;
        user.pendingReserveEventId = reserveEvent.id;
        user.pendingReserveEventName = reserveEvent.name;

        await startSelectedEventsRegistration(chatId, user, { instantAfisha: true, reserveMode: true });
        return;
    }

    // якщо натиснутий день тижня (з датою або без), показуємо афішу для обраного дня
    const afishaDaySelection = parseAfishaDaySelection(text);

    if (user.context === 'consultation-day' && !matchesCommand(text, NAVIGATION_BUTTONS.back, NAVIGATION_BUTTONS.menu)) {
        if (!user.consultationDraft || !user.consultationDraft.specialistKey) {
            clearConsultationState(user);
            user.context = 'consultation-specialist';
            user.consultationDraft = {};
            await showConsultationSpecialistMenu(chatId, '⚠️ Сесія вибору консультації скинуто. Оберіть фахівчиню ще раз.');
            return;
        }

        const draft = user.consultationDraft;
        try {
            await refreshConsultationDraftSlots(draft);
        } catch (error) {
            console.error('❌ Помилка оновлення слотів консультацій:', error && error.message ? error.message : error);
            await bot.sendMessage(chatId,
                '❌ Не вдалося оновити доступні дати. Спробуйте ще раз трохи пізніше.', {
                reply_markup: {
                    keyboard: buildConsultationSpecialistMenuKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        const dateButtonMap = draft.dateButtonMap || {};
        const selectedDateText = dateButtonMap[text];

        if (!selectedDateText) {
            const dateButtons = Array.isArray(draft.dateButtons) ? draft.dateButtons : [];
            await bot.sendMessage(chatId, 'Будь ласка, оберіть дату кнопками.', {
                reply_markup: {
                    keyboard: buildConsultationDatesKeyboard(dateButtons),
                    resize_keyboard: true
                }
            });
            return;
        }

        const dateSlots = (draft.availableSlots || []).filter((slot) => slot.dateText === selectedDateText);
        const timeOptions = [...new Set(dateSlots.map((slot) => slot.timeText))].sort((left, right) => {
            return left.localeCompare(right, 'uk');
        });

        if (timeOptions.length === 0) {
            await bot.sendMessage(chatId,
                '❌ Для обраної дати немає вільного часу. Оберіть іншу дату.', {
                reply_markup: {
                    keyboard: buildConsultationDatesKeyboard(draft.dateButtons || []),
                    resize_keyboard: true
                }
            });
            return;
        }

        draft.dateText = selectedDateText;
        draft.timeOptions = timeOptions;
        delete draft.timeText;
        delete draft.selectedSlotRowNumber;
        user.context = 'consultation-time';

        await bot.sendMessage(chatId,
            `📅 Обрано дату: <b>${draft.dateText}</b>\n\nОберіть зручний час:`, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buildConsultationTimeKeyboard(timeOptions),
                resize_keyboard: true
            }
        });
        return;
    }
    
    console.log('🔍 Перевірка дня: text="' + text + '" → parsed="' + (afishaDaySelection ? afishaDaySelection.weekdayKey : 'none') + '"');
    if (afishaDaySelection) {
        console.log('✅ Знайдено день: ' + afishaDaySelection.weekdayKey + ' → ' + afishaDaySelection.dayNum);
        await showDayAgenda(chatId, text);
        return;
    }
    console.log('⚠️ День не знайдено. Доступні ключі:', Object.keys(WEEKDAY_INDEX_BY_NAME));

    // === ПЕРЕВІРЯЄМО КОНТЕКСТ ВІДПИСАННЯ ДО ПОШУКУ ЗАХОДУ ===
    // Обробка вибору заходу для відписання
    if (user.context === 'unregister' && user.unregButtonMap && user.unregButtonMap[text]) {
        const mapped = user.unregButtonMap[text];
        const eventId = mapped && mapped.eventId;
        const selectedMode = mapped && mapped.mode ? mapped.mode : 'registration';
        
        // Знаходимо інформацію про захід у відповідному списку
        const sourceList = selectedMode === 'reserve'
            ? (userEventReserveRegistrations[chatId] || [])
            : (userEventRegistrations[chatId] || []);
        const regIndex = sourceList.findIndex((r) => r.eventId === eventId);
        if (!eventId || regIndex === -1) {
            bot.sendMessage(chatId, "❌ Захід не знайдено.", {
                reply_markup: {
                    keyboard: [[{ text: MAIN_MENU_BUTTONS.reminders }], [{ text: NAVIGATION_BUTTONS.menu }]],
                    resize_keyboard: true
                }
            });
            delete user.unregButtonMap;
            user.context = null;
            return;
        }
        
        const eventName = String((mapped && mapped.eventName) || sourceList[regIndex].eventName || '').trim();
        
        // Підтвердження
        user.pendingUnregEventId = eventId;
        user.pendingUnregEventName = eventName;
        user.pendingUnregMode = selectedMode;
        
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

    if (user.context === 'friend-unregister' && user.friendUnregButtonMap && user.friendUnregButtonMap[text]) {
        const registrationKey = user.friendUnregButtonMap[text];
        const registration = (friendEventRegistrations[chatId] || []).find((item) => item.registrationKey === registrationKey);

        if (!registration) {
            bot.sendMessage(chatId, "❌ Реєстрацію подруги не знайдено.", {
                reply_markup: {
                    keyboard: [[{ text: MAIN_MENU_BUTTONS.unsubscribeFriend }], [{ text: NAVIGATION_BUTTONS.menu }]],
                    resize_keyboard: true
                }
            });
            delete user.friendUnregButtonMap;
            user.context = null;
            return;
        }

        user.pendingFriendUnregKey = registrationKey;
        user.pendingFriendUnregEventName = registration.eventName;
        user.pendingFriendRegistrantName = registration.registrantName;

        const registrantSuffix = registration.registrantName
            ? `👭 <b>${registration.registrantName}</b>\n`
            : '';
        const confirmMsg =
            `❓ <b>Ви впевнені, що хочете відписати подругу від заходу?</b>\n\n` +
            `${registrantSuffix}` +
            `📌 <b>${registration.eventName}</b>\n\n` +
            `Місце звільниться для інших учасниць.`;

        bot.sendMessage(chatId, confirmMsg, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: '✅ Так, відписати подругу' }],
                    [{ text: '❌ Скасувати' }]
                ],
                resize_keyboard: true
            }
        });
        return;
    }

    // Повертаємось до афіші для додавання ще одного заходу
    if (text === "➕ Додати ще один" || text === "➕ Додати ще захід") {
        await showAfishaDaysMenu(chatId);
        return;
    }

    if (text === '❌ Відмінити реєстрацію') {
        const lastEventId = user.lastAfishaRegisteredEventId;

        if (!lastEventId) {
            await bot.sendMessage(chatId, 'Немає активної реєстрації для скасування.', {
                reply_markup: {
                    keyboard: getAfishaInstantRegistrationKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        let result = await unregisterFromEvent(chatId, lastEventId);
        if (!result || result.status !== 'ok') {
            result = await unregisterFromReserve(chatId, lastEventId);
        }
        if (result.status === 'ok') {
            const details = result.mode === 'reserve'
                ? 'Запис у резерв скасовано.'
                : 'Місце звільнено для інших учасників.';
            await bot.sendMessage(chatId,
                `✅ <b>Реєстрацію скасовано.</b>\n\n📌 ${result.eventName}\n\n${details}`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: getAfishaInstantRegistrationKeyboard(),
                    resize_keyboard: true
                }
            });
            delete user.lastAfishaRegisteredEventId;
            delete user.lastAfishaRegisteredEventName;
        } else {
            await bot.sendMessage(chatId, '❌ Не вдалося скасувати реєстрацію. Спробуйте ще раз.', {
                reply_markup: {
                    keyboard: getAfishaInstantRegistrationKeyboard(),
                    resize_keyboard: true
                }
            });
        }
        return;
    }

    // Скасування реєстрації
    if (text === "❌ Скасувати" || text === "❌ Відмінити") {
        if (String(user.context || '').startsWith('consultation-')) {
            clearConsultationState(user);
            user.step = 0;
            user.registrationMode = false;
            await bot.sendMessage(chatId, 'Запис на консультацію скасовано. Оберіть дію в меню.', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        const inUnregisterFlow = user.context === 'unregister'
            || user.context === 'friend-unregister'
            || user.pendingUnregEventId
            || user.pendingFriendUnregKey;

        if (!inUnregisterFlow) {
            resetSelectedEventsFlow(user);
            clearFriendRegistrationState(user);

            bot.sendMessage(chatId, "Вибір заходів скасовано. Оберіть захід з афіші.", {
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
            const registrationsLabel = `👥 ${formatPeopleCount(Math.max(0, Number(event.registrations) || 0))}`;
            const reserveLabel = `🕓 ${formatPeopleCount(Math.max(0, Number(event.reserveCount) || 0))}`;
            const buttonText = `${event.name} | ${formatEventDate(event.date)} | 💺 ${formatSeatsCount(event.seatsLeft)} | ${registrationsLabel} | ${reserveLabel}`;
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

    if (matchesCommand(text, NAVIGATION_BUTTONS.backToDays, 'Назад до вибору днів')) {
        delete user.selectedEventName;
        delete user.selectedEventId;
        delete user.pendingReserveEventId;
        delete user.pendingReserveEventName;
        delete user.eventButtonMap;
        user.context = 'afisha';
        await showAfishaDaysMenu(chatId);
        return;
    }

    if (matchesCommand(text, NAVIGATION_BUTTONS.back, 'Назад')) {
        if (user.context === 'consultation-description') {
            user.context = 'consultation-time';
            const timeOptions = Array.isArray(user.consultationDraft && user.consultationDraft.timeOptions)
                ? user.consultationDraft.timeOptions
                : [];
            await bot.sendMessage(chatId, 'Оберіть інший час консультації:', {
                reply_markup: {
                    keyboard: buildConsultationTimeKeyboard(timeOptions),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.context === 'consultation-time' && !matchesCommand(text, NAVIGATION_BUTTONS.back, NAVIGATION_BUTTONS.menu)) {
            user.context = 'consultation-day';
            delete user.consultationDraft?.dateText;
            delete user.consultationDraft?.timeText;
            delete user.consultationDraft?.timeOptions;
            delete user.consultationDraft?.selectedSlotRowNumber;
            const dateButtons = Array.isArray(user.consultationDraft && user.consultationDraft.dateButtons)
                ? user.consultationDraft.dateButtons
                : [];
            await bot.sendMessage(chatId, 'Оберіть іншу дату консультації:', {
                reply_markup: {
                    keyboard: buildConsultationDatesKeyboard(dateButtons),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.context === 'consultation-day') {
            user.context = 'consultation-specialist';
            delete user.consultationDraft?.dateButtons;
            delete user.consultationDraft?.dateButtonMap;
            delete user.consultationDraft?.availableSlots;
            delete user.consultationDraft?.dateText;
            delete user.consultationDraft?.timeOptions;
            delete user.consultationDraft?.timeText;
            delete user.consultationDraft?.selectedSlotRowNumber;
            await showConsultationSpecialistMenu(chatId, 'Оберіть фахівчиню для консультації:');
            return;
        }

        if (user.context === 'consultation-specialist') {
            clearConsultationState(user);
            await bot.sendMessage(chatId, 'Меню: оберіть потрібний розділ', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.context === 'violence-help-specialized-type') {
            user.context = 'violence-help-specialized-district';
            await bot.sendMessage(chatId, '💡 Оберіть свій район:', {
                reply_markup: {
                    keyboard: buildViolenceHelpDistrictKeyboard(),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.context === 'violence-help-specialized-district') {
            user.context = 'violence-help';
            delete user.selectedViolenceHelpDistrict;
            await bot.sendMessage(chatId, '🚨 Допомога при насильстві: оберіть потрібний розділ.', {
                reply_markup: {
                    keyboard: buildViolenceHelpKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        if (user.context === 'violence-help-social-district') {
            user.context = 'violence-help';
            await bot.sendMessage(chatId, '🚨 Допомога при насильстві: оберіть потрібний розділ.', {
                reply_markup: {
                    keyboard: buildViolenceHelpKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        delete user.afishaFullRegistration;
        delete user.afishaPendingEventId;
        delete user.afishaPendingEventName;

        if (
            user.context === 'unsubscribe-root'
            || user.context === 'unregister'
            || user.context === 'friend-unregister'
            || user.context === 'cancel-consultation-select'
            || user.context === 'cancel-consultation-confirm'
            || user.pendingUnregEventId
            || user.pendingFriendUnregKey
        ) {
            delete user.pendingCancelBooking;
            delete user.cancelConsultationBookings;
            delete user.cancelConsultationButtonMap;
            await showUnsubscribeMenu(chatId, user);
            return;
        }

        if (user.context === 'daily-feedback-write') {
            clearFeedbackFlowState(user);
        }

        if (user.context === 'afisha') {
            delete user.selectedEventName;
            delete user.selectedEventId;
            delete user.eventButtonMap;
            await showAfishaDaysMenu(chatId);
            return;
        }

        delete user.selectedEventName;
        delete user.eventButtonMap;
        clearFeedbackFlowState(user);
        user.context = null;
        bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: getMainMenuKeyboard(chatId),
                resize_keyboard: true
            }
        });
        user.step = 0;
        user.registrationMode = false;
        return;
    }

    // Кнопка відписання від заходів
    if (matchesCommand(text, MAIN_MENU_BUTTONS.unsubscribe, '❌ Відписатись від заходу')) {
        await showUnsubscribeMenu(chatId, user);
        return;
    }

    if (matchesCommand(text, UNSUBSCRIBE_MENU_BUTTONS.self, 'Відписатись')) {
        await handleUnsubscribeIntent(chatId, user);
        return;
    }

    if (matchesCommand(text, UNSUBSCRIBE_MENU_BUTTONS.friend, MAIN_MENU_BUTTONS.unsubscribeFriend, '👭 Відписати подругу', 'Відписати подругу')) {
        await handleFriendUnsubscribeIntent(chatId, user);
        return;
    }

    if (matchesCommand(text, UNSUBSCRIBE_MENU_BUTTONS.consultation, '🗨️❌ Відписатись від консультації')) {
        await handleCancelConsultationIntent(chatId, user);
        return;
    }

    // Вибір запису консультації для скасування
    if (user.context === 'cancel-consultation-select' && user.cancelConsultationButtonMap) {
        const bookingIndex = user.cancelConsultationButtonMap[text];
        if (bookingIndex !== undefined) {
            const booking = user.cancelConsultationBookings[bookingIndex];
            user.pendingCancelBooking = booking;
            user.context = 'cancel-consultation-confirm';

            await bot.sendMessage(chatId,
                `❓ <b>Підтвердіть скасування запису:</b>\n\n` +
                `👩🏻‍💼 ${booking.specialistLabel}\n` +
                `📅 ${booking.dateText}\n` +
                `🕐 ${booking.timeText}\n\n` +
                `Ви впевнені, що хочете скасувати цей запис?`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '✅ Так, скасувати запис' }],
                        [{ text: '❌ Ні, залишити' }]
                    ],
                    resize_keyboard: true
                }
            });
            return;
        }
    }

    // Підтвердження скасування консультації
    if (text === '✅ Так, скасувати запис' && user.pendingCancelBooking) {
        const booking = user.pendingCancelBooking;
        try {
            await cancelConsultationRow(booking.sheetName, booking.rowNumber);

            await notifySpecialistAboutCancellation({
                specialistLabel: booking.specialistLabel,
                specialistChatId: booking.specialistChatId,
                dateText: booking.dateText,
                timeText: booking.timeText,
                name: booking.name,
                phone: booking.phone,
                userChatId: chatId
            });

            delete user.pendingCancelBooking;
            delete user.cancelConsultationBookings;
            delete user.cancelConsultationButtonMap;
            user.context = null;

            await bot.sendMessage(chatId,
                `✅ <b>Запис скасовано!</b>\n\n` +
                `👩🏻‍💼 ${booking.specialistLabel}\n` +
                `📅 ${booking.dateText} о ${booking.timeText}\n\n` +
                `Слот звільнено. Дякуємо, що попередили! 🩵`, {
                parse_mode: 'HTML',
                reply_markup: { keyboard: getMainMenuKeyboard(chatId), resize_keyboard: true }
            });
        } catch (err) {
            console.error('❌ Помилка скасування консультації:', err && err.message ? err.message : err);
            await bot.sendMessage(chatId, '❌ Не вдалося скасувати запис. Спробуйте пізніше.', {
                reply_markup: { keyboard: getMainMenuKeyboard(chatId), resize_keyboard: true }
            });
        }
        return;
    }

    if (text === '❌ Ні, залишити' && user.context === 'cancel-consultation-confirm') {
        delete user.pendingCancelBooking;
        user.context = null;
        await bot.sendMessage(chatId, '👍 Запис залишено без змін.', {
            reply_markup: { keyboard: getMainMenuKeyboard(chatId), resize_keyboard: true }
        });
        return;
    }

    // Потвердження відписання
    if (text === "✅ Так, відписатись" && user.pendingUnregEventId) {
        const eventId = user.pendingUnregEventId;
        const eventName = user.pendingUnregEventName;
        const unregMode = user.pendingUnregMode;

        let result;
        if (unregMode === 'reserve') {
            result = await unregisterFromReserve(chatId, eventId);
            if (result.status !== 'ok') {
                result = await unregisterFromEvent(chatId, eventId);
            }
        } else {
            result = await unregisterFromEvent(chatId, eventId);
            if (result.status !== 'ok') {
                result = await unregisterFromReserve(chatId, eventId);
            }
        }
        
        if (result.status === 'ok') {
            bot.sendMessage(chatId, 
                `✅ <b>Ви успішно відписались від заходу!</b>\n\n📌 ${eventName}\n\nМісце звільнено для інших учасників. 🩵`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: MAIN_MENU_BUTTONS.afisha }],
                        [{ text: NAVIGATION_BUTTONS.menu }]
                    ],
                    resize_keyboard: true
                }
            });
        } else {
            bot.sendMessage(chatId, "❌ Помилка при відписанні. Спробуйте ще раз.", {
                reply_markup: {
                    keyboard: [[{ text: MAIN_MENU_BUTTONS.afisha }], [{ text: NAVIGATION_BUTTONS.menu }]],
                    resize_keyboard: true
                }
            });
        }
        
        delete user.pendingUnregEventId;
        delete user.pendingUnregEventName;
        delete user.pendingUnregMode;
        delete user.unregButtonMap;
        user.context = null;
        return;
    }

    if (text === '✅ Так, відписати подругу' && user.pendingFriendUnregKey) {
        const result = await unregisterFriendFromEvent(chatId, user.pendingFriendUnregKey);

        if (result.status === 'ok') {
            const registrantSuffix = result.registrantName ? `👭 ${result.registrantName}\n` : '';
            bot.sendMessage(chatId,
                `✅ <b>Подругу успішно відписано від заходу!</b>\n\n${registrantSuffix}📌 ${result.eventName}\n\nМісце звільнено для інших учасниць. 🩵`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: MAIN_MENU_BUTTONS.unsubscribeFriend }],
                        [{ text: NAVIGATION_BUTTONS.menu }]
                    ],
                    resize_keyboard: true
                }
            });
        } else {
            bot.sendMessage(chatId, '❌ Помилка при відписанні подруги. Спробуйте ще раз.', {
                reply_markup: {
                    keyboard: [[{ text: MAIN_MENU_BUTTONS.unsubscribeFriend }], [{ text: NAVIGATION_BUTTONS.menu }]],
                    resize_keyboard: true
                }
            });
        }

        delete user.pendingFriendUnregKey;
        delete user.pendingFriendUnregEventName;
        delete user.pendingFriendRegistrantName;
        delete user.friendUnregButtonMap;
        user.context = null;
        return;
    }

    // Скасування під час вибору для відписання
    if (((text === "❌ Скасувати" || text === "❌ Відмінити") && user.context === 'unregister') ||
        ((text === "❌ Скасувати" || text === "❌ Відмінити") && user.pendingUnregEventId) ||
        ((text === "❌ Скасувати" || text === "❌ Відмінити") && user.context === 'friend-unregister') ||
        ((text === "❌ Скасувати" || text === "❌ Відмінити") && user.pendingFriendUnregKey)) {
        delete user.unregButtonMap;
        delete user.friendUnregButtonMap;
        delete user.pendingUnregEventId;
        delete user.pendingUnregEventName;
        delete user.pendingUnregMode;
        delete user.pendingFriendUnregKey;
        delete user.pendingFriendUnregEventName;
        delete user.pendingFriendRegistrantName;
        user.context = null;
        
        bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: getMainMenuKeyboard(chatId),
                resize_keyboard: true
            }
        });
        return;
    }

    // Налаштування нагадувань
    if (text === "⚙️ Налаштування нагадувань") {
        await showReminderSettingsMenu(chatId);
        return;
    }

    if (text === '🔔 Увімкнути всі нагадування' || text === '🔊 Увімкнути нагадування') {
        const settings = getReminderSettingsForChat(chatId);
        setAllReminderSlotsEnabled(settings, true);
        user.reminderSettings = settings;
        user.remindersEnabled = true;
        saveReminderStateToDisk();

        await showReminderSettingsMenu(chatId, '✅ Загальні нагадування увімкнено (включно з 24 год і 1 год).');
        return;
    }

    if (text === '🔕 Вимкнути всі нагадування' || text === '🔔 Вимкнути нагадування') {
        const settings = getReminderSettingsForChat(chatId);
        setAllReminderSlotsEnabled(settings, false);
        user.reminderSettings = settings;
        user.remindersEnabled = false;
        saveReminderStateToDisk();

        await showReminderSettingsMenu(chatId, '❌ Загальні нагадування вимкнено (включно з 24 год і 1 год).');
        return;
    }

    if (text === '🔔 Увімкнути 24 год' || text === '🔕 Вимкнути 24 год') {
        const settings = getReminderSettingsForChat(chatId);
        settings.reminder24h.enabled = text === '🔔 Увімкнути 24 год';
        user.reminderSettings = settings;
        saveReminderStateToDisk();

        await showReminderSettingsMenu(
            chatId,
            settings.reminder24h.enabled
                ? `✅ Нагадування 24 год увімкнено за ${formatReminderLeadTime('reminder24h', settings.reminder24h.hoursBefore)}.`
                : '❌ Нагадування 24 год вимкнено.'
        );
        return;
    }

    if (text === '🔔 Увімкнути 1 год' || text === '🔕 Вимкнути 1 год') {
        const settings = getReminderSettingsForChat(chatId);
        settings.reminder1h.enabled = text === '🔔 Увімкнути 1 год';
        user.reminderSettings = settings;
        saveReminderStateToDisk();

        await showReminderSettingsMenu(
            chatId,
            settings.reminder1h.enabled
                ? `✅ Нагадування 1 год увімкнено за ${formatReminderLeadTime('reminder1h', settings.reminder1h.minutesBefore)}.`
                : '❌ Нагадування 1 год вимкнено.'
        );
        return;
    }

    if (text === '⏱ Змінити 24 год' || text === '⏱ Змінити 1 год') {
        const slotKey = text === '⏱ Змінити 24 год' ? 'reminder24h' : 'reminder1h';
        const slotConfig = getReminderSlotConfig(slotKey);
        const settings = getReminderSettingsForChat(chatId);
        user.awaitingReminderHoursFor = slotKey;

        await bot.sendMessage(chatId,
            `⏱ <b>Налаштування нагадування ${slotConfig.label}</b>\n\n` +
            `Зараз воно надсилається за ${formatReminderLeadTime(slotKey, settings[slotKey][slotConfig.valueKey])} до початку.\n` +
            `Введіть нове значення в ${slotConfig.inputUnitLabel} від ${slotConfig.minValue} до ${slotConfig.maxValue}.`, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: '⬅️ Назад до налаштувань' }]],
                resize_keyboard: true
            }
        });
        return;
    }

    if (text === '⬅️ До нагадувань') {
        delete user.awaitingReminderHoursFor;
        await showUserRemindersOverview(chatId, user);
        return;
    }

    if (matchesCommand(text, NAVIGATION_BUTTONS.menu, 'Повернутися в меню', 'Назад в меню')) {
        if (users[chatId]) {
            delete users[chatId].eventButtonMap;
            delete users[chatId].afishaFullRegistration;
            delete users[chatId].afishaPendingEventId;
            delete users[chatId].afishaPendingEventName;
            delete users[chatId].afishaMultiRegistration;
            delete users[chatId].selectedEventsList;
            delete users[chatId].selectedEventId;
            delete users[chatId].selectedEventName;
            delete users[chatId].awaitingReminderHoursFor;
            delete users[chatId].unregButtonMap;
            delete users[chatId].friendUnregButtonMap;
            delete users[chatId].pendingUnregEventId;
            delete users[chatId].pendingUnregEventName;
            delete users[chatId].pendingFriendUnregKey;
            delete users[chatId].pendingFriendUnregEventName;
            delete users[chatId].pendingFriendRegistrantName;
            clearFeedbackFlowState(users[chatId]);
            clearFriendRegistrationState(users[chatId]);
            clearConsultationState(users[chatId]);
            users[chatId].step = 0;
            users[chatId].registrationMode = false;
            users[chatId].context = null;
        }
        bot.sendMessage(chatId, "Меню: оберіть потрібний розділ", {
            reply_markup: {
                keyboard: getMainMenuKeyboard(chatId),
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
                    keyboard: getMainMenuKeyboard(chatId),
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

    // Якщо реєстрація активна, не показуємо fallback-меню.
    // Це захищає сценарій анкети від випадкового "Не зовсім зрозумілий запит".
    const activeRegistrationStep = Number(user.step);
    const isRegistrationInProgress = user.registrationMode === true ||
        (Number.isInteger(activeRegistrationStep) && activeRegistrationStep >= 1 && activeRegistrationStep <= 11);

    if (isRegistrationInProgress) {
        return;
    }

    // AI fallback: якщо текст не збігся з жодною кнопкою/сценарієм вище.
    if (msg.chat.type === 'private') {
        if (!AI_ENABLED || shouldSkipAiIntentDetection(text)) {
            const fallbackIntentTag = detectIntentLocally(text);
            console.log(`🧠 Local fallback: ${fallbackIntentTag}`);
            if (await handleIntentTag(chatId, user, fallbackIntentTag, text)) {
                return;
            }

            await bot.sendMessage(chatId, 'Не зовсім зрозумілий запит. Будь ласка, оберіть потрібний розділ:', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
            return;
        }

        try {
            console.log(`🧠 AI intent detection: input="${String(text).slice(0, 120)}"`);
            const intentTag = await detectAiIntentTag(text);
            console.log(`🧠 AI intent detection result: ${intentTag}`);

            if (await handleIntentTag(chatId, user, intentTag || 'UNKNOWN', text)) {
                return;
            }

            await bot.sendMessage(chatId, 'Не зовсім зрозумілий запит. Будь ласка, оберіть потрібний розділ:', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
        } catch (error) {
            console.error('❌ AI fallback error:', error && error.message ? error.message : error);
            const fallbackIntentTag = detectIntentLocally(text);
            console.log(`🧠 Local intent fallback result: ${fallbackIntentTag}`);

            if (await handleIntentTag(chatId, user, fallbackIntentTag, text)) {
                return;
            }

            await bot.sendMessage(chatId, 'Не зовсім зрозумілий запит. Будь ласка, оберіть потрібний розділ:', {
                reply_markup: {
                    keyboard: getMainMenuKeyboard(chatId),
                    resize_keyboard: true
                }
            });
        }
        return;
    }

    // Step 7 больше не используется - регистрация завершается на step 6
    // Обработка "Афіша заходів" остается в основном меню

});

console.log("⏳ Бот ініціалізується. Telegram webhook автоматично встановлюється після підключення до Google Sheets.");
console.log("📋 Розклад:", config.SPREADSHEET_ID);
console.log("👤 Персональні дані:", config.PERSONAL_DATA_SPREADSHEET_ID);
