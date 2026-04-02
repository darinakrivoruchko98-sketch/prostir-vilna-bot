const state = require('../state');
const { getEventsForDay } = require('../events/store');
const { getSeatsLeft } = require('../sheets/registration');
const { formatEventDate } = require('../utils/date');

const WEEKDAYS = { 'Неділя':0, 'Понеділок':1, 'Вівторок':2, 'Середа':3, 'Четвер':4, 'П\u2019ятниця':5, 'Субота':6 };

function handleAfishaMenu(bot, chatId, user) {
    user.context = 'afisha';
    bot.sendMessage(chatId, "Оберіть день:", {
        reply_markup: {
            keyboard: [
                [{ text: "Понеділок" }],
                [{ text: "Вівторок" }],
                [{ text: "Середа" }],
                [{ text: "Четвер" }],
                [{ text: "П\u2019ятниця" }],
                [{ text: "Субота" }],
                [{ text: "Неділя" }],
                [{ text: "Повернутися в меню" }]
            ],
            resize_keyboard: true
        }
    });
}

// Відображає афішу для конкретного дня
async function showDayAgenda(bot, chatId, dayName) {
    const dayNum = WEEKDAYS[dayName];
    const dayEvents = getEventsForDay(dayNum);
    dayEvents.sort((a,b)=>a.date-b.date);

    if (dayEvents.length === 0) {
        const dayForms = {
            'Понеділок': 'понеділок',
            'Вівторок': 'вівторок',
            'Середа': 'середу',
            'Четвер': 'четвер',
            'П\u2019ятниця': 'п\u2019ятницю',
            'Субота': 'суботу',
            'Неділя': 'неділю'
        };

        bot.sendMessage(chatId, `На ${dayForms[dayName] || dayName} немає заходів.`, {
            reply_markup: {
                keyboard: [[{ text: "Повернутися в меню" }]],
                resize_keyboard: true
            }
        });
        return;
    }
    let msg = `📅 Заходи в ${dayName}:\n\n`;
    const buttons = [];
    const eventButtonMap = {};
    for (const ev of dayEvents) {
        const seatsLeft = await getSeatsLeft(ev.id);
        const time = String(ev.date.getHours()).padStart(2,'0')+":"+String(ev.date.getMinutes()).padStart(2,'0');
        const seatsLabel = seatsLeft > 0 ? `💺 ${seatsLeft} місць` : `❌ закрито`;
        msg += `Назва: ${ev.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}\n\n`;
        const buttonText = `${ev.name} | ${formatEventDate(ev.date)} | ${seatsLabel}`;
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
    WEEKDAYS,
    handleAfishaMenu,
    showDayAgenda,
};
