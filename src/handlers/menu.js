const state = require('../state');

const MAIN_MENU_KEYBOARD = {
    keyboard: [
        [{ text: "Реєстрація" }],
        [{ text: "Афіша заходів" }],
        [{ text: "Контакти" }],
        [{ text: "Назад" }]
    ],
    resize_keyboard: true
};

function handleStart(bot, chatId) {
    bot.sendMessage(chatId, "Меню:", {
        reply_markup: MAIN_MENU_KEYBOARD
    });
    delete state.users[chatId];
}

function handleBack(bot, chatId) {
    const user = state.users[chatId];
    if (user) {
        delete user.selectedEventName;
        delete user.eventButtonMap;
        user.context = null;
    }
    bot.sendMessage(chatId, "Меню:", {
        reply_markup: MAIN_MENU_KEYBOARD
    });
    delete state.users[chatId];
}

function handleReturnToMenu(bot, chatId) {
    if (state.users[chatId]) {
        delete state.users[chatId].eventButtonMap;
    }
    delete state.users[chatId];
    bot.sendMessage(chatId, "Меню:", {
        reply_markup: MAIN_MENU_KEYBOARD
    });
}

module.exports = {
    MAIN_MENU_KEYBOARD,
    handleStart,
    handleBack,
    handleReturnToMenu,
};
