const state = require('../state');

function handleAppealStart(bot, chatId, user) {
    user.context = 'appeal';
    user.step = 1;
    bot.sendMessage(chatId, "📝 Напишіть своє звернення. Ми обов'язково його прочитаємо та зв'яжемося з вами.", {
        reply_markup: {
            keyboard: [[{ text: "Скасувати" }]],
            resize_keyboard: true
        }
    });
}

async function handleAppealText(bot, chatId, text, user, GROUP_ID) {
    if (user.step === 1) {
        const userName = state.knownUsers[chatId]?.name || `користувач ${chatId}`;
        const userPhone = state.knownUsers[chatId]?.phone || 'не вказаний';

        const appealMessage = `
📬 <b>Нове звернення</b>

👤 <b>Ім'я:</b> ${userName}
📱 <b>Телефон:</b> ${userPhone}
🔗 <b>Telegram ID:</b> ${chatId}

📝 <b>Текст звернення:</b>
${text}
        `;

        // Відправляємо звернення в групу
        if (GROUP_ID) {
            try {
                await bot.sendMessage(GROUP_ID, appealMessage, {
                    parse_mode: 'HTML'
                });
                bot.sendMessage(chatId, "✅ Дякуємо! Ваше звернення надіслано. Ми обов'язково зв'яжемося з вами.", {
                    reply_markup: {
                        keyboard: [[{ text: "Повернутися в меню" }]],
                        resize_keyboard: true
                    }
                });
                user.step = 0;
                user.context = null;
            } catch (error) {
                console.error('Помилка при відправці звернення до групи:', error);
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
            bot.sendMessage(chatId, "⚠️ Групу не налаштовано. Спробуйте написати напряму фахівцям.", {
                reply_markup: {
                    keyboard: [[{ text: "Повернутися в меню" }]],
                    resize_keyboard: true
                }
            });
            user.step = 0;
            user.context = null;
        }
    }
}

module.exports = {
    handleAppealStart,
    handleAppealText
};
