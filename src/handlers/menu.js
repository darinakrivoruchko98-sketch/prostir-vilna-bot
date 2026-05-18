const state = require('../state');
const { isAdmin } = require('./admin');

const MAIN_MENU_KEYBOARD = {
    keyboard: [
        [{ text: "Реєстрація" }],
        [{ text: "Афіша заходів" }],
        [{ text: "Контакти" }],
        [{ text: "Назад" }]
    ],
    resize_keyboard: true
};

const ADMIN_MENU_KEYBOARD = {
    keyboard: [
        [{ text: "📊 Статистика" }],
        [{ text: "📋 Переглянути реєстрації" }],
        [{ text: "✏️ Редагувати заходи" }],
        [{ text: "Афіша заходів" }],
        [{ text: "Назад" }]
    ],
    resize_keyboard: true
};

function handleStart(bot, chatId) {
    const menuKeyboard = isAdmin(chatId) ? ADMIN_MENU_KEYBOARD : MAIN_MENU_KEYBOARD;
    const greeting = isAdmin(chatId) ? "🔐 Адміністраторське меню:" : "Меню:";
    
    bot.sendMessage(chatId, greeting, {
        reply_markup: menuKeyboard
    });
    delete state.users[chatId];
}

function handleBack(bot, chatId) {
    const user = state.users[chatId];
    if (user) {
        delete user.selectedEventName;
        delete user.eventButtonMap;
        delete user.afishaFullRegistration;
        delete user.afishaPendingEventId;
        delete user.afishaPendingEventName;
        user.context = null;
    }
    const menuKeyboard = isAdmin(chatId) ? ADMIN_MENU_KEYBOARD : MAIN_MENU_KEYBOARD;
    const greeting = isAdmin(chatId) ? "🔐 Адміністраторське меню:" : "Меню:";
    
    bot.sendMessage(chatId, greeting, {
        reply_markup: menuKeyboard
    });
    delete state.users[chatId];
}

function handleReturnToMenu(bot, chatId) {
    if (state.users[chatId]) {
        delete state.users[chatId].eventButtonMap;
        delete state.users[chatId].afishaFullRegistration;
        delete state.users[chatId].afishaPendingEventId;
        delete state.users[chatId].afishaPendingEventName;
    }
    delete state.users[chatId];
    const menuKeyboard = isAdmin(chatId) ? ADMIN_MENU_KEYBOARD : MAIN_MENU_KEYBOARD;
    const greeting = isAdmin(chatId) ? "🔐 Адміністраторське меню:" : "Меню:";
    
    bot.sendMessage(chatId, greeting, {
        reply_markup: menuKeyboard
    });
}

module.exports = {
    MAIN_MENU_KEYBOARD,
    ADMIN_MENU_KEYBOARD,
    handleStart,
    handleBack,
    handleReturnToMenu,
};
