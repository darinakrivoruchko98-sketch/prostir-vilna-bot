const state = require('../state');
const { appendRegistrationRow } = require('../sheets/personal-data');

function handleRegistrationStart(bot, chatId, user) {
    // Спочатку запитуємо особисті дані
    user.step = 1;
    bot.sendMessage(chatId, "Введіть ПІБ");
}

async function handlePersonalDataStep(bot, chatId, text, user) {
    if (user.step === 1) {
        user.name = text;
        user.step = 2;
        bot.sendMessage(chatId, "Телефон (380...)");
        return true;
    }

    if (user.step === 2) {
        user.phone = text;
        user.step = 3;
        bot.sendMessage(chatId, "Дата народження");
        return true;
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
        return true;
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
        return true;
    }

    if (user.step === 5) {
        user.status = text;
        user.step = 6;
        // step 6: health buttons
        bot.sendMessage(chatId, "Проблеми зі здоров'ям:", {
            reply_markup: {
                keyboard: [
                    [{ text: "Інвалідність" }],
                    [{ text: "Суттєві проблеми" }],
                    [{ text: "Немає" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 6) {
        user.health = text;

        try {
            await appendRegistrationRow(chatId, user);
            // Remember user for quick registration from afisha
            state.knownUsers[chatId] = {
                name: user.name,
                phone: user.phone,
                birth: user.birth,
                visited: user.visited,
                status: user.status,
                health: user.health,
            };
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
        return true;
    }

    return false;
}

module.exports = {
    handleRegistrationStart,
    handlePersonalDataStep,
};
