const state = require('../state');
const { getAllEvents } = require('../events/store');
const { findEventByButtonText } = require('../events/parser');
const { appendEventRegistration, getSeatsLeft } = require('../sheets/registration');
const { findUserByChatId } = require('../sheets/personal-data');
const { incrementSheetRegistration } = require('../sheets/schedule');
const { formatEventDate } = require('../utils/date');
const { pluralizeEvents } = require('../utils/text');

// Перевіряємо чи натиснута кнопка з заходом (general context, not step 7)
function handleEventClick(bot, chatId, text, user) {
    let selectedEvent = null;
    if (user.eventButtonMap && user.eventButtonMap[text]) {
        selectedEvent = getAllEvents().find((eventItem) => eventItem.id === user.eventButtonMap[text]) || null;
    }

    // Fallback для старих клавіатур без мапи (точне співпадіння назва+дата+час)
    if (!selectedEvent) {
        selectedEvent = findEventByButtonText(text, getAllEvents());
    }

    // Legacy fallback (залишаємо на крайній випадок)
    if (!selectedEvent) {
        selectedEvent = getAllEvents().find((eventItem) => text.includes(eventItem.name));
    }

    if (!selectedEvent) return null;
    return selectedEvent;
}

async function showEventDetails(bot, chatId, selectedEvent, user) {
    // compute seats left asynchronously before replying
    const seatsLeft = await getSeatsLeft(selectedEvent.id);
    const seatsInfo = seatsLeft > 0
        ? `💺 Місць залишилось: ${seatsLeft}\n`
        : `❌ Місця закінчилися\n`;

    // build keyboard options
    const buttons = [];
    let isKnownUser = !!(state.knownUsers && state.knownUsers[chatId]);
    if (!isKnownUser && user.context === 'afisha') {
        const found = await findUserByChatId(chatId);
        if (found) {
            state.knownUsers[chatId] = found;
            isKnownUser = true;
        }
    }
    if (user.context !== 'afisha' || isKnownUser) {
        if (seatsLeft > 0) {
            buttons.push([{ text: "Реєструватися" }]);
        } else {
            buttons.push([{ text: "Місць немає" }]);
        }
    }
    buttons.push([{ text: "Назад" }]);

    bot.sendMessage(chatId, `✅ Ви вибрали: ${selectedEvent.name}\n📅 ${formatEventDate(selectedEvent.date)}\n${seatsInfo}`, {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: true
        }
    });

    // Зберігаємо вибраний захід для наступного кроку
    user.selectedEventName = selectedEvent.name;
    user.selectedEventId = selectedEvent.id;
}

async function handleRegister(bot, chatId, user) {
    const eventId = user.selectedEventId;
    const eventName = user.selectedEventName;
    if (!eventId || !eventName) return;

    // Populate user data from knownUsers if missing (e.g. afisha quick registration)
    if (!user.name && state.knownUsers && state.knownUsers[chatId]) {
        const known = state.knownUsers[chatId];
        user.name = known.name;
        user.phone = known.phone;
    } else if (!user.name) {
        const found = await findUserByChatId(chatId);
        if (found) {
            state.knownUsers[chatId] = found;
            user.name = found.name;
            user.phone = found.phone;
        }
    }

    const seatsLeft = await getSeatsLeft(eventId);
    if (seatsLeft <= 0) {
        bot.sendMessage(chatId, "❌ Вибачте, місця закінчилися.");
        return;
    }
    const evObj = state.events.find(e => e.id === eventId);
    await appendEventRegistration(user, evObj || { name: eventName, date: new Date() });
    if (evObj) {
        await incrementSheetRegistration(evObj);
        evObj.registrations = (evObj.registrations || 0) + 1;
        // reduce local seats count as well
        if (typeof evObj.seats === 'number') evObj.seats = Math.max(0, evObj.seats - 1);
    }

    // Додати в selectedEvents для step 7
    if (user.step === 7) {
        if (!user.selectedEvents) user.selectedEvents = [];
        user.selectedEvents.push({ id: eventId, name: eventName });
    }

    if (user.context === 'afisha') {
        bot.sendMessage(chatId, "✅ Ви успішно зареєстровані на захід!", {
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
    } else {
        bot.sendMessage(chatId, "✅ Ви успішно зареєстровані на захід!", {
            reply_markup: {
                keyboard: [
                    [{ text: "Обрати ще захід" }],
                    [{ text: "✅ Завершити" }]
                ],
                resize_keyboard: true
            }
        });
    }
    delete user.selectedEventName;
    delete user.selectedEventId;
}

async function handleChooseMore(bot, chatId, user) {
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
        const buttonText = `☐ ${event.name} | ${formatEventDate(event.date)} | 💺 ${event.seatsLeft}`;
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
}

async function handleDali(bot, chatId, user) {
    const allEvents = getAllEvents();
    const avail = [];
    const eventButtonMap = {};
    for (const ev of allEvents) {
        const seatsLeft = await getSeatsLeft(ev.id);
        if (seatsLeft > 0) avail.push(Object.assign({}, ev, { seatsLeft }));
    }
    if (avail.length === 0) {
        bot.sendMessage(chatId, "Наразі немає заходів з вільними місцями 🤍", {
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
        delete state.users[chatId];
        return;
    }
    const eventButtons = avail.map(event => {
        const buttonText = `☐ ${event.name} | ${formatEventDate(event.date)} | 💺 ${event.seatsLeft}`;
        eventButtonMap[buttonText] = event.id;
        return [{ text: buttonText }];
    });
    user.eventButtonMap = eventButtonMap;
    eventButtons.push([{ text: "✅ Завершити" }]);
    bot.sendMessage(chatId, "Натисніть на захід, на який бажаєте зареєструватись. Потім натисніть Завершити:", {
        reply_markup: {
            keyboard: eventButtons,
            resize_keyboard: true
        }
    });
}

async function handleFinish(bot, chatId, user) {
    const count = user.selectedEvents ? user.selectedEvents.length : 0;
    const eventWord = pluralizeEvents(count);

    let message = `Дякуємо за реєстрацію! Ви зареєстровані на ${count} ${eventWord}. 🤍\n\n`;

    // Додаємо список усіх вибраних заходів
    if (user.selectedEvents && user.selectedEvents.length > 0) {
        message += `📋 Ваші заходи:\n\n`;
        for (let i = 0; i < user.selectedEvents.length; i++) {
            const ev = user.selectedEvents[i];
            const event = state.events.find(e => e.id === ev.id);
            if (event) {
                const dateStr = formatEventDate(event.date);
                    message += `${i+1}. <b>${event.name}</b>\n   📅 ${dateStr}\n\n`;
                }
            }
        }

        bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
        delete state.users[chatId];
}

async function handleStep7EventClick(bot, chatId, text, user) {
    // Перевіряємо чи це натиск на захід (беремо актуальний список з вільними місцями)
    const allEvents = getAllEvents();
    const avail = [];
    const registeredIds = user.selectedEvents ? user.selectedEvents.map(e => e.id) : [];
    for (const ev of allEvents) {
        if (registeredIds.includes(ev.id)) continue; // пропустити вже вибрані
        const seatsLeft = await getSeatsLeft(ev.id);
        if (seatsLeft > 0) avail.push(Object.assign({}, ev, { seatsLeft }));
    }

    let selectedEvent = null;
    if (user.eventButtonMap && user.eventButtonMap[text]) {
        selectedEvent = avail.find((eventItem) => eventItem.id === user.eventButtonMap[text]) || null;
    }

    if (!selectedEvent) {
        selectedEvent = findEventByButtonText(text, avail);
    }

    if (!selectedEvent) {
        selectedEvent = avail.find((eventItem) => text.includes(eventItem.name));
    }

    if (!selectedEvent) return false;

    // Показати деталі заходу з кнопкою реєстрації
    const seatsLeft = await getSeatsLeft(selectedEvent.id);
    const seatsInfo = seatsLeft > 0
        ? `💺 Місць залишилось: ${seatsLeft}\n`
        : `❌ Місця закінчилися\n`;

    const buttons = [];
    if (seatsLeft > 0) {
        buttons.push([{ text: "Реєструватися" }]);
    }
    buttons.push([{ text: "Назад до списку" }]);

    bot.sendMessage(chatId, `✅ Ви вибрали: ${selectedEvent.name}\n📅 ${formatEventDate(selectedEvent.date)}\n${seatsInfo}`, {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: true
        }
    });

    // Зберігаємо вибраний захід для наступного кроку
    user.selectedEventName = selectedEvent.name;
    user.selectedEventId = selectedEvent.id;
    return true;
}

async function handleBackToList(bot, chatId, user) {
    // Показати список знов
    const allEventsForList = getAllEvents();
    const availForList = [];
    const regIds = user.selectedEvents ? user.selectedEvents.map(e => e.id) : [];
    for (const ev of allEventsForList) {
        if (regIds.includes(ev.id)) continue;
        const sl = await getSeatsLeft(ev.id);
        if (sl > 0) availForList.push(Object.assign({}, ev, { seatsLeft: sl }));
    }
    if (availForList.length === 0) {
        bot.sendMessage(chatId, "Немає ще доступних заходів 🤍", {
            reply_markup: {
                keyboard: [[{ text: "✅ Завершити" }]],
                resize_keyboard: true
            }
        });
        return;
    }
    const eventButtonMap = {};
    const eventButtons = availForList.map(event => {
        const buttonText = `${event.name} | ${formatEventDate(event.date)} | 💺 ${event.seatsLeft}`;
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
    delete user.selectedEventName;
    delete user.selectedEventId;
}

module.exports = {
    handleEventClick,
    showEventDetails,
    handleRegister,
    handleChooseMore,
    handleDali,
    handleFinish,
    handleStep7EventClick,
    handleBackToList,
};
