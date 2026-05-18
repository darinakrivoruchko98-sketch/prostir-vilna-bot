const state = require('../state');
const config = require('../config');
const { findUserByChatId } = require('../sheets/personal-data');

const ADMIN_MENU_KEYBOARD = {
    keyboard: [
        [{ text: "📊 Статистика" }],
        [{ text: "📋 Переглянути реєстрації" }],
        [{ text: "✏️ Редагувати заходи" }],
        [{ text: "Назад" }]
    ],
    resize_keyboard: true
};

function isAdmin(chatId) {
    return config.ADMIN_IDS && config.ADMIN_IDS.includes(Number(chatId));
}

function handleAdminMenu(bot, chatId) {
    bot.sendMessage(chatId, "🔐 Меню адміністратора:", {
        reply_markup: ADMIN_MENU_KEYBOARD
    });
}

async function handleStatistics(bot, chatId) {
    try {
        const totalEvents = state.events.length;
        const totalRegistrations = Object.values(state.userEventRegistrations || {}).reduce((sum, events) => sum + events.length, 0);
        
        let eventDetails = "📊 <b>Статистика заходів:</b>\n\n";
        
        for (const event of state.events) {
            const registeredCount = Object.values(state.userEventRegistrations || {}).filter(events => 
                events.some(e => e.eventId === event.id)
            ).length;
            const availableSeats = event.availableSeats || 0;
            const totalSeats = registeredCount + availableSeats;
            
            eventDetails += `<b>${event.title}</b>\n`;
            eventDetails += `📅 ${event.date} о ${event.time}\n`;
            eventDetails += `👥 Зареєстровано: ${registeredCount}/${totalSeats}\n`;
            eventDetails += `💺 Вільних місць: ${availableSeats}\n\n`;
        }
        
        const summary = `📈 <b>Загальна статистика:</b>
🎯 Всього заходів: ${totalEvents}
👤 Всього реєстрацій: ${totalRegistrations}
`;
        
        await bot.sendMessage(chatId, summary + "\n" + eventDetails, {
            parse_mode: 'HTML',
            reply_markup: ADMIN_MENU_KEYBOARD
        });
    } catch (e) {
        console.error('Error in handleStatistics:', e);
        bot.sendMessage(chatId, `❌ Помилка при отриманні статистики: ${e.message}`, {
            reply_markup: ADMIN_MENU_KEYBOARD
        });
    }
}

async function handleViewRegistrations(bot, chatId) {
    try {
        if (!state.sheetsClient || !config.PERSONAL_DATA_SPREADSHEET_ID) {
            bot.sendMessage(chatId, "❌ Не вдалося підключитися до Google Sheets.", {
                reply_markup: ADMIN_MENU_KEYBOARD
            });
            return;
        }

        const resp = await state.sheetsClient.spreadsheets.values.get({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            range: `${config.PERSONAL_DATA_SHEET_NAME}!A:K`
        });
        
        const rows = resp.data.values || [];
        if (rows.length <= 1) {
            bot.sendMessage(chatId, "📋 Реєстрацій немає", {
                reply_markup: ADMIN_MENU_KEYBOARD
            });
            return;
        }

        let registrationList = "<b>📋 Список зареєстрованих користувачів:</b>\n\n";
        
        for (let i = 1; i < Math.min(rows.length, 51); i++) {
            const row = rows[i] || [];
            const username = row[0] || '';
            const name = row[1] || '';
            const phone = row[2] || '';
            const chatId_row = row[10] || '';
            
            if (name.trim()) {
                registrationList += `👤 <b>${name}</b>\n`;
                if (phone) registrationList += `📱 ${phone}\n`;
                if (username) registrationList += `@${username}\n`;
                if (chatId_row) registrationList += `🔗 ID: ${chatId_row}\n`;
                registrationList += "\n";
            }
        }

        if (rows.length > 50) {
            registrationList += `\n<i>... та ще ${rows.length - 50} користувачів (всього: ${rows.length - 1})</i>`;
        } else {
            registrationList += `\n<i>Всього: ${rows.length - 1} користувачів</i>`;
        }

        await bot.sendMessage(chatId, registrationList, {
            parse_mode: 'HTML',
            reply_markup: ADMIN_MENU_KEYBOARD
        });
    } catch (e) {
        console.error('Error in handleViewRegistrations:', e);
        bot.sendMessage(chatId, `❌ Помилка при отриманні реєстрацій: ${e.message}`, {
            reply_markup: ADMIN_MENU_KEYBOARD
        });
    }
}

async function handleEditEvents(bot, chatId) {
    try {
        if (!state.events || state.events.length === 0) {
            bot.sendMessage(chatId, "📋 Заходів немає", {
                reply_markup: ADMIN_MENU_KEYBOARD
            });
            return;
        }

        let eventList = "<b>✏️ Редагування заходів:</b>\n\n";
        const buttons = [];

        for (let i = 0; i < Math.min(state.events.length, 10); i++) {
            const event = state.events[i];
            const registeredCount = Object.values(state.userEventRegistrations || {}).filter(events => 
                events.some(e => e.eventId === event.id)
            ).length;
            const availableSeats = event.availableSeats || 0;
            
            eventList += `${i + 1}. <b>${event.title}</b>\n`;
            eventList += `   📅 ${event.date} о ${event.time}\n`;
            eventList += `   👥 ${registeredCount}/${registeredCount + availableSeats}\n\n`;
            
            buttons.push([{ text: `${i + 1}. ${event.title.substring(0, 20)}...` }]);
        }

        if (state.events.length > 10) {
            eventList += `\n<i>... та ще ${state.events.length - 10} заходів</i>`;
        }

        eventList += "\n\n💡 Щоб редагувати захід, натисніть на його номер або відредагуйте Google Sheet напряму.";
        buttons.push([{ text: "Назад" }]);

        await bot.sendMessage(chatId, eventList, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: buttons,
                resize_keyboard: true
            }
        });
    } catch (e) {
        console.error('Error in handleEditEvents:', e);
        bot.sendMessage(chatId, `❌ Помилка при отриманні заходів: ${e.message}`, {
            reply_markup: ADMIN_MENU_KEYBOARD
        });
    }
}

module.exports = {
    isAdmin,
    handleAdminMenu,
    handleStatistics,
    handleViewRegistrations,
    handleEditEvents,
    ADMIN_MENU_KEYBOARD
};
