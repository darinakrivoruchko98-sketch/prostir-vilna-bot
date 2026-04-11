const state = require('../state');
const { getAllEvents } = require('../events/store');
const { findEventByButtonText } = require('../events/parser');
const { appendEventRegistration, getSeatsLeft } = require('../sheets/registration');
const { findUserByChatId } = require('../sheets/personal-data');
const { incrementSheetRegistration, isRegistrantAlreadyInEventNote } = require('../sheets/schedule');
const { formatEventDate, formatShortDate, formatTime } = require('../utils/date');
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
    if (seatsLeft > 0) {
        buttons.push([{ text: "Реєструватися" }]);
    } else {
        buttons.push([{ text: "Місць немає" }]);
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

function resolveRegistrantProfile(chatId, user, providedName, providedPhone) {
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

    return resolved;
}

function formatEventButtonText(event, seatsLeft) {
    return `${event.name} | ${formatShortDate(event.date)} | ${formatTime(event.date)} | 💺 ${seatsLeft}`;
}

async function registerForSelectedEvent(chatId, user, providedName, providedPhone) {
    const eventId = user.selectedEventId;
    const eventName = user.selectedEventName;
    if (!eventId || !eventName) {
        return { status: 'no-selection' };
    }

    const seatsLeft = await getSeatsLeft(eventId);
    if (seatsLeft <= 0) {
        return { status: 'no-seats' };
    }

    const registrantProfile = resolveRegistrantProfile(chatId, user, providedName || '', providedPhone || '');

    const evObj = state.events.find(e => e.id === eventId);
    if (evObj) {
        const alreadyRegistered = await isRegistrantAlreadyInEventNote(evObj, registrantProfile);
        if (alreadyRegistered) {
            return { status: 'already-registered' };
        }
    }

    await appendEventRegistration(user, evObj || { name: eventName, date: new Date() }, {
        name: registrantProfile.name,
        phone: registrantProfile.phone
    });

    if (evObj) {
        await incrementSheetRegistration(evObj, {
            userId: registrantProfile.userId,
            name: registrantProfile.name,
            phone: registrantProfile.phone
        });
        evObj.registrations = (evObj.registrations || 0) + 1;
        if (typeof evObj.seats === 'number') evObj.seats = Math.max(0, evObj.seats - 1);
    }

    if (user.step === 7) {
        if (!user.selectedEvents) user.selectedEvents = [];
        user.selectedEvents.push({ id: eventId, name: eventName });
    }

    delete user.selectedEventName;
    delete user.selectedEventId;
    delete user.afishaFullRegistration;
    delete user.afishaPendingEventId;
    delete user.afishaPendingEventName;

    return { status: 'ok' };
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

    // If in afisha context and user data is not available, redirect to registration
    if (user.context === 'afisha' && !user.name) {
        user.afishaFullRegistration = true;
        user.afishaPendingEventId = eventId;
        user.afishaPendingEventName = eventName;
        user.step = 1;
        bot.sendMessage(chatId, "Прізвище Ім'я По-батькові");
        return;
    }

    try {
        const result = await registerForSelectedEvent(chatId, user, user.name || '', user.phone || '');

        if (result.status === 'no-selection') {
            bot.sendMessage(chatId, "Спочатку оберіть захід.");
            return;
        }

        if (result.status === 'no-seats') {
            bot.sendMessage(chatId, "❌ Вибачте, місця закінчилися.");
            return;
        }

        if (result.status === 'already-registered') {
            bot.sendMessage(chatId, "ℹ️ Ви вже зареєстровані на цей захід.");
            return;
        }
    } catch (registrationError) {
        console.error('Error during event registration flow', registrationError && registrationError.message ? registrationError.message : registrationError);
        bot.sendMessage(chatId, "Помилка при записі реєстрації в таблицю. Спробуйте ще раз.");
        return;
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
        const buttonText = formatEventButtonText(event, event.seatsLeft);
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
        const buttonText = formatEventButtonText(event, event.seatsLeft);
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
        const buttonText = formatEventButtonText(event, event.seatsLeft);
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
    registerForSelectedEvent,
};
