const state = require('../state');
const { getAllEvents } = require('../events/store');
const { getSeatsLeft } = require('../sheets/registration');
const { formatShortDate, formatTime } = require('../utils/date');

function buildDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getAfishaDates() {
    const events = getAllEvents().slice().sort((a, b) => a.date - b.date);
    const seen = new Set();
    const dates = [];

    for (const eventItem of events) {
        const key = buildDateKey(eventItem.date);
        if (seen.has(key)) continue;
        seen.add(key);
        dates.push({
            key,
            label: formatShortDate(eventItem.date)
        });
    }

    return dates;
}

function handleAfishaMenu(bot, chatId, user) {
    user.context = 'afisha';
    const dates = getAfishaDates();

    if (dates.length === 0) {
        bot.sendMessage(chatId, "Наразі немає запланованих заходів 🤍", {
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
        return;
    }

    const dateButtonMap = {};
    const dateButtons = dates.map((entry) => {
        dateButtonMap[entry.label] = entry.key;
        return [{ text: entry.label }];
    });

    user.afishaDateButtonMap = dateButtonMap;

    bot.sendMessage(chatId, "Оберіть дату:", {
        reply_markup: {
            keyboard: [...dateButtons, [{ text: "Повернутися в меню" }]],
            resize_keyboard: true
        }
    });
}

function resolveAfishaDateSelection(user, buttonText) {
    if (!user || !user.afishaDateButtonMap) return null;
    return user.afishaDateButtonMap[buttonText] || null;
}

// Відображає афішу для конкретної дати
async function showDateAgenda(bot, chatId, selectedDateKey, selectedDateLabel) {
    const dateEvents = getAllEvents()
        .filter((eventItem) => buildDateKey(eventItem.date) === selectedDateKey)
        .sort((a, b) => a.date - b.date);

    if (dateEvents.length === 0) {
        bot.sendMessage(chatId, `На ${selectedDateLabel} немає заходів.`, {
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
        return;
    }

    let msg = `📅 Заходи на ${selectedDateLabel}:\n\n`;
    const buttons = [];
    const eventButtonMap = {};
    for (const ev of dateEvents) {
        const seatsLeft = await getSeatsLeft(ev.id);
        const time = formatTime(ev.date);
        const seatsLabel = seatsLeft > 0 ? `💺 ${seatsLeft} місць` : `❌ закрито`;
        msg += `Назва: ${ev.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}\n\n`;
        const buttonText = `${ev.name} | ${selectedDateLabel} | ${time} | ${seatsLabel}`;
        buttons.push([{ text: buttonText }]);
        eventButtonMap[buttonText] = ev.id;
    }
    buttons.push([{ text: "Повернутися в меню" }]);

    if (!state.users[chatId]) {
        state.users[chatId] = { step: 0 };
    }
    state.users[chatId].eventButtonMap = eventButtonMap;

    bot.sendMessage(chatId, msg, {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: true
        }
    });
}

module.exports = {
    handleAfishaMenu,
    resolveAfishaDateSelection,
    showDateAgenda,
};
