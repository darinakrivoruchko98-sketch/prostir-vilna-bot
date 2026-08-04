const state = require('../state');
const { appendRegistrationRow } = require('../sheets/personal-data');
const { registerForSelectedEvent } = require('./event-selection');

function handleRegistrationStart(bot, chatId, user) {
    user.step = 1;
    bot.sendMessage(chatId, "Прізвище Ім'я По-батькові");
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
        const step4Message = `📝 <b>Крок 4/11:</b> Ваш ВПО/МО статус:

<b>Не ВПО, що постраждали від війни:</b> Громадяни, які живуть у рідних містах, але їхнє житло було зруйноване/пошкоджене, або вони отримали фізичні чи психологічні травми, втратили майно або джерело доходу внаслідок бойових дій.

<b>Не ВПО, що не постраждали від війни:</b> Люди, які проживають у відносно безпечних регіонах, чиє майно, здоров'я та фінансовий стан не зазнали прямого впливу бойових дій.`;
        bot.sendMessage(chatId, step4Message, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "ВПО" }],
                    [{ text: "Не ВПО, що постраждали від війни" }],
                    [{ text: "Не ВПО, що не постраждали від війни" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 4) {
        user.status = text;
        user.step = 5;
        bot.sendMessage(chatId, "📝 <b>Крок 5/11:</b> Кількість дітей до 18 років:", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "0" }, { text: "1" }],
                    [{ text: "2" }, { text: "3 і більше" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 5) {
        user.childrenCount = text;
        user.step = 6;
        bot.sendMessage(chatId, "📝 <b>Крок 6/11:</b> Стан здоров'я:", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Ні, немає істотних проблем зі здоров'ям" }],
                    [{ text: "Ні, але є істотні проблеми зі здоров'ям" }],
                    [{ text: "Інвалідність" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 6) {
        user.health = text;
        user.step = 7;
        bot.sendMessage(chatId, "📝 <b>Крок 7/11:</b> Евакуаційний статус особи:", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Евакуація з попереднього місця проживання за останні 6 місяців" }],
                    [{ text: "Перебування в транзитному центрі та/або в процесі евакуації" }],
                    [{ text: "Готуюсь до евакуації" }],
                    [{ text: "Нічого з зазначеного" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 7) {
        user.evacuationStatus = text;
        user.step = 8;
        bot.sendMessage(chatId, "📝 <b>Крок 8/11:</b> Вплив обстрілів:", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Так, постраждала протягом останніх 72 годин" }],
                    [{ text: "Так, постраждала протягом останніх 3 місяців" }],
                    [{ text: "Ні, не постраждала" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 8) {
        user.shellingImpact = text;
        user.step = 9;
        bot.sendMessage(chatId, "📝 <b>Крок 9/11:</b> Зайнятість:", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Працюю" }, { text: "Не працюю" }],
                    [{ text: "Пенсіонерка" }, { text: "Студентка" }],
                    [{ text: "Школярка" }, { text: "ФОП" }],
                    [{ text: "Волонтерка" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 9) {
        user.employment = text;
        user.step = 10;
        bot.sendMessage(chatId, "📝 <b>Крок 10/11:</b> До яких категорій належите?", {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Вагітна" }, { text: "Одинока мати" }],
                    [{ text: "Багатодітна мати (3 і більше дітей)" }],
                    [{ text: "Ветеранка" }],
                    [{ text: "Представниця сім'ї загиблого воїна" }],
                    [{ text: "Представниця сім'ї ветерана" }],
                    [{ text: "Особа у складних життєвих обставинах" }],
                    [{ text: "Нічого із вищезазначеного" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 10) {
        user.beneficiaryCategory = text;
        user.step = 11;
        const step11Message = `📝 <b>Крок 11/11:</b> Чи маєте ви досвід або потребу, пов'язану з ГЗН?\n\n<b>ГЗН (гендерно зумовлене насильство)</b> — це будь-які дії, завдані людині через її стать або гендер, які спричиняють фізичну, психологічну, сексуальну чи економічну шкоду.\n\n<b>Приклади:</b>\n- фізичне насильство — побиття, штовхання;\n- психологічне — образи, приниження, погрози, контроль;\n- сексуальне — примус до сексуальних дій без згоди;\n- економічне — заборона працювати, відбирання грошей, повний контроль фінансів;\n- переслідування, сексуальні домагання, примусовий шлюб.`;
        bot.sendMessage(chatId, step11Message, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: "Так" }, { text: "Ні" }],
                    [{ text: "Поки не хочу відповідати" }]
                ],
                resize_keyboard: true
            }
        });
        return true;
    }

    if (user.step === 11) {
        user.gzn = text;
        try {
            await appendRegistrationRow(chatId, user);
            state.knownUsers[chatId] = {
                name: user.name,
                phone: user.phone,
                birth: user.birth,
                status: user.status,
                childrenCount: user.childrenCount,
                health: user.health,
                evacuationStatus: user.evacuationStatus,
                shellingImpact: user.shellingImpact,
                employment: user.employment,
                gzn: user.gzn,
                beneficiaryCategory: user.beneficiaryCategory,
            };

            if (user.afishaFullRegistration) {
                user.selectedEventId = user.afishaPendingEventId;
                user.selectedEventName = user.afishaPendingEventName;

                const result = await registerForSelectedEvent(chatId, user, user.name || '', user.phone || '');
                if (result.status === 'no-selection') {
                    bot.sendMessage(chatId, "Спочатку оберіть захід.");
                    return true;
                }
                if (result.status === 'no-seats') {
                    bot.sendMessage(chatId, "❌ Вибачте, місця закінчилися.");
                    return true;
                }
                if (result.status === 'reserve-added') {
                    bot.sendMessage(chatId, "🕒 Місць поки немає, але вас додано в резерв. Коли кількість місць збільшиться, бот перенесе вас у реєстрацію автоматично.");
                    return true;
                }
                if (result.status === 'already-registered') {
                    bot.sendMessage(chatId, "ℹ️ Ви вже зареєстровані на цей захід.");
                    return true;
                }

                bot.sendMessage(chatId, "✅ Ви успішно зареєстровані на захід!", {
                    reply_markup: {
                        keyboard: [
                            [{ text: "Назад" }],
                            [{ text: "Повернутися в меню" }]
                        ],
                        resize_keyboard: true
                    }
                });
                return true;
            }

            user.step = 12;
            user.selectedEvents = [];

            bot.sendMessage(chatId, "✅ Ваші дані збережено! Натисніть «Далі», щоб обрати заходи.", {
                reply_markup: {
                    keyboard: [[{ text: "Далі" }]],
                    resize_keyboard: true
                }
            });
        } catch (err) {
            const errorMessage = err && err.message ? err.message : String(err || '');
            console.error('Помилка запису в таблицю під час діалогу:', err);
            bot.sendMessage(chatId, `⚠️ Помилка при збереженні даних у таблиці.\n\nДеталі: ${errorMessage}`, {
                reply_markup: {
                    keyboard: [[{ text: "Далі" }]],
                    resize_keyboard: true
                }
            });
        }
        return true;
    }

    return false;
}

module.exports = {
    handleRegistrationStart,
    handlePersonalDataStep,
};
