require('dotenv').config();

const DEFAULT_BOT_TOKEN = "8448480345:AAH48UBqGxkrzc_vyT6mKsQsc3264ifhLgg";
const TOKEN = process.env.TOKEN || process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const CHAT_ID = process.env.CHAT_ID;
const APPEALS_GROUP_ID = Number(process.env.APPEALS_GROUP_ID || '-1003802751255');
globalThis.APPEALS_GROUP_ID = APPEALS_GROUP_ID;
// Адміни (можна додавати через ADMIN_IDS або просто в коді)
const ADMIN_IDS = (process.env.ADMIN_IDS || '375328037').split(',').map(id => Number(id.trim()));
// Таблиця для розкладу та реєстрацій на заходи
const DEFAULT_SCHEDULE_SPREADSHEET_ID = "1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || DEFAULT_SCHEDULE_SPREADSHEET_ID;
const SCHEDULE_SHEET_NAME = process.env.SCHEDULE_SHEET_NAME || "Розклад";
// Таблиця для персональних даних (ПІБ, телефон тощо)
const PERSONAL_DATA_SPREADSHEET_ID = process.env.PERSONAL_DATA_SPREADSHEET_ID || "1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE";
const PERSONAL_DATA_SHEET_NAME = process.env.PERSONAL_DATA_SHEET_NAME || "Зареєстровані";
const REGISTRATIONS_SHEET_NAME = process.env.REGISTRATIONS_SHEET_NAME || "Зареєстровані";
const SOCIAL_CONSULTATIONS_SHEET_NAME = process.env.SOCIAL_CONSULTATIONS_SHEET_NAME || "Соц";
const PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME = process.env.PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME || "Псих";
const SOCIAL_SPECIALIST_CHAT_ID = process.env.SOCIAL_SPECIALIST_CHAT_ID || "";
const PSYCHOLOGIST_CHAT_ID = process.env.PSYCHOLOGIST_CHAT_ID || "";
const SCHEDULE_SHEET_CANDIDATES = [SCHEDULE_SHEET_NAME, "Заходи"];

// Таблиця розкладу: https://docs.google.com/spreadsheets/d/1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8/edit
// Таблиця персональних даних: https://docs.google.com/spreadsheets/d/1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE/edit

if (!process.env.SPREADSHEET_ID) {
    console.warn(`SPREADSHEET_ID не встановлений, використовую значення за замовчуванням: ${DEFAULT_SCHEDULE_SPREADSHEET_ID}`);
}
if (!process.env.TOKEN && !process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("TOKEN не встановлено через env, використовую значення з коду");
}
console.log("📋 Таблиця розкладу:", SPREADSHEET_ID);
console.log("📄 Аркуш розкладу:", SCHEDULE_SHEET_NAME);
console.log("👤 Таблиця персональних даних:", PERSONAL_DATA_SPREADSHEET_ID);
console.log("📄 Аркуш персональних даних:", PERSONAL_DATA_SHEET_NAME);
console.log(`[CONFIGBOOT] APPEALS_GROUP_ID=${APPEALS_GROUP_ID}`);

if (!TOKEN) {
    console.error("TOKEN не встановлено");
    process.exit(1);
}

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

module.exports = {
    TOKEN,
    GROUP_ID,
    CHAT_ID,
    APPEALS_GROUP_ID,
    ADMIN_IDS,
    SPREADSHEET_ID,
    SCHEDULE_SHEET_NAME,
    PERSONAL_DATA_SPREADSHEET_ID,
    PERSONAL_DATA_SHEET_NAME,
    REGISTRATIONS_SHEET_NAME,
    SOCIAL_CONSULTATIONS_SHEET_NAME,
    PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME,
    SOCIAL_SPECIALIST_CHAT_ID,
    PSYCHOLOGIST_CHAT_ID,
    SCHEDULE_SHEET_CANDIDATES,
};
