const config = require('./src/config');
const TelegramBot = require('node-telegram-bot-api');
const { initSheets } = require('./src/sheets/init');
const { cleanupPastEvents } = require('./src/events/store');
const registerHandlers = require('./src/handlers');

const bot = new TelegramBot(config.TOKEN, { polling: false });
registerHandlers(bot);
initSheets(bot);
setInterval(cleanupPastEvents, 60000);

console.log("⏳ Бот ініціалізується. Telegram polling стартує після підключення до Google Sheets.");
console.log("📋 Розклад:", config.SPREADSHEET_ID);
console.log("👤 Персональні дані:", config.PERSONAL_DATA_SPREADSHEET_ID);
