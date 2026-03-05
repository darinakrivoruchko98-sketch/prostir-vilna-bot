const state = require('../state');
const { handleStart, handleBack, handleReturnToMenu } = require('./menu');
const { handleContacts } = require('./contacts');
const { handleAppealStart, handleAppealText } = require('./appeal');
const { WEEKDAYS, handleAfishaMenu, showDayAgenda } = require('./afisha');
const { handleRegistrationStart, handlePersonalDataStep } = require('./registration');
const { handleEventClick, showEventDetails, handleRegister, handleChooseMore, handleDali, handleFinish, handleStep7EventClick, handleBackToList } = require('./event-selection');
const { handleGroupMessage } = require('./group-message');

function registerHandlers(bot, GROUP_ID) {
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text || msg.caption || "";

        if (!text) return;

        // respond to /start command by showing main menu
        if (text === '/start') {
            handleStart(bot, chatId);
            return;
        }

        // === ОБРОБКА ПОВІДОМЛЕНЬ З ГРУПИ/КАНАЛУ ===
        if (await handleGroupMessage(bot, msg, text)) {
            return;
        }

        // === ОБРОБКА КОРИСТУВАЦЬКИХ ПОВІДОМЛЕНЬ ===
        if (!state.users[chatId]) {
            state.users[chatId] = { step: 0 };
        }

        let user = state.users[chatId];

        if (text === "Реєстрація") {
            handleRegistrationStart(bot, chatId, user);
            return;
        }

        if (text === "Афіша заходів") {
            handleAfishaMenu(bot, chatId, user);
            return;
        }

        if (text === "Контакти") {
            handleContacts(bot, chatId);
            return;
        }

        if (text === "Написати звернуння") {
            handleAppealStart(bot, chatId, user);
            return;
        }

        // === ОБРОБКА ЗВЕРНЕНЬ ===
        if (user.context === 'appeal' && user.step === 1 && text !== "Скасувати") {
            await handleAppealText(bot, chatId, text, user, GROUP_ID);
            return;
        }

        if (text === "Скасувати" && user.context === 'appeal') {
            user.context = null;
            user.step = 0;
            handleStart(bot, chatId);
            return;
        }

        // якщо натиснутий день тижня, делегуємо показ загального меню на відповідну функцію
        if (WEEKDAYS[text] !== undefined) {
            await showDayAgenda(bot, chatId, text);
            return;
        }

        // Перевіряємо чи натиснута кнопка з заходом
        const selectedEvent = handleEventClick(bot, chatId, text, user);

        if (selectedEvent) {
            await showEventDetails(bot, chatId, selectedEvent, user);
            return;
        }

        // Обробка реєстрації на захід
        if (text === "Реєструватися") {
            await handleRegister(bot, chatId, user);
            return;
        }

        if (text === "Обрати ще захід" && user.step === 7) {
            await handleChooseMore(bot, chatId, user);
            return;
        }

        if (text === "Назад") {
            handleBack(bot, chatId);
            return;
        }

        if (text === "Повернутися в меню") {
            handleReturnToMenu(bot, chatId);
            return;
        }

        // Personal data steps 1-6
        if (user.step >= 1 && user.step <= 6) {
            const handled = await handlePersonalDataStep(bot, chatId, text, user);
            if (handled) return;
        }

        // Коли натиснули "Далі" після вводу особистих даних
        if (user.step === 7 && text === "Далі") {
            await handleDali(bot, chatId, user);
            return;
        }

        if (user.step === 7) {
            // Завершить реєстрацію
            if (text === "✅ Завершити") {
                await handleFinish(bot, chatId, user);
                return;
            }

            // Перевіряємо чи це натиск на захід (step 7 context)
            const handled = await handleStep7EventClick(bot, chatId, text, user);
            if (handled) return;

            // Обробка кнопки "Назад до списку" під час перегляду деталей
            if (text === "Назад до списку") {
                await handleBackToList(bot, chatId, user);
                return;
            }
        }

    });
}

module.exports = registerHandlers;
