const state = require('../state');
const config = require('../config');
const { createAuthorizedSheetsClient } = require('./auth');
const { parseEventFromRow } = require('../events/parser');
const { promoteReserveRegistrantsIfNeeded } = require('./schedule');

function startPollingIfNeeded(bot) {
    if (state.pollingStarted) return;
    bot.startPolling();
    state.pollingStarted = true;
    console.log("🤖 Telegram polling запущено ✅");
}

async function loadEventsFromSheet() {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) {
        console.warn("⚠️ sheetsClient або SPREADSHEET_ID не готові");
        return;
    }

    try {
        const previousEventsById = new Map((state.events || []).map((event) => [event.id, event]));
        let rows = [];
        const readErrors = [];
        for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
            try {
                console.log(`📖 Спроба прочитати лист: "${scheduleSheet}"`);
                const resp = await state.sheetsClient.spreadsheets.values.get({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range: `${scheduleSheet}!A:E`
                });
                rows = resp.data.values || [];
                if (rows && rows.length) {
                    console.log(`   ✅ Використано лист "${scheduleSheet}" (${rows.length} рядків)`);
                    break;
                }
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
                if (msg.includes('unable to parse range') || msg.includes('not found')) {
                    console.log(`   ⚠️ Лист "${scheduleSheet}" не знайдено, пробую далі...`);
                    continue;
                }
                readErrors.push({ sheet: scheduleSheet, message: e && e.message ? e.message : String(e) });
            }
        }

        // Если всё ещё пусто, попробуем ещё общий диапазон
        if (!rows || rows.length === 0) {
            try {
                console.log('📖 Спроба прочитати діапазон A:E (перший лист)...');
                const alt2 = await state.sheetsClient.spreadsheets.values.get({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range: "A:E"
                });
                rows = alt2.data.values || [];
                if (rows && rows.length) console.log(`   ✅ Прочитано ${rows.length} рядків`);
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                readErrors.push({ sheet: 'A:E', message: msg });
            }
        }

        if ((!rows || rows.length === 0) && readErrors.length > 0) {
            const details = readErrors.map((entry) => `${entry.sheet}: ${entry.message}`).join(' | ');
            throw new Error(`Не вдалося зчитати розклад із таблиці ${config.SPREADSHEET_ID}. ${details}`);
        }

        console.log(`\n🔍 ДІАГНОСТИКА ЗАВАНТАЖЕННЯ Розкладу (перші 5 рядків):`);
        for (let i = 0; i < Math.min(5, rows.length); i++) {
            const row = rows[i] || [];
            console.log(`   Рядок ${i}: [${row.map(c => `"${c}"`).join(', ')}]`);
        }

        // Очистити поточні заходи перед завантаженням
        state.events = [];
        const seen = new Set();
        let dateContext = null;

        for (const [i, row] of rows.entries()) {
            const parsed = parseEventFromRow(row, dateContext);
            dateContext = parsed.nextDateContext;

            if (!parsed.event) {
                continue;
            }

            const ev = parsed.event;

            if (i === 0 && /дата|час|назва|захід/i.test(String((row || []).join(' ')))) {
                console.log(`   ℹ️ Пропущено заголовок (рядок 0)`);
                continue;
            }

            if (seen.has(ev.id)) {
                console.log(`   ℹ️ Подвійний захід: ${ev.name} (${ev.date})`);
                continue;
            }

            seen.add(ev.id);
            const previousEvent = previousEventsById.get(ev.id);
            if (previousEvent && Number.isFinite(previousEvent.seats) && ev.seats > previousEvent.seats) {
                try {
                    await promoteReserveRegistrantsIfNeeded(ev, previousEvent.seats);
                } catch (promotionErr) {
                    console.error('⚠️ Не вдалося автоматично перенести резерв для заходу', ev.id, promotionErr && promotionErr.message ? promotionErr.message : promotionErr);
                }
            }
            state.events.push(ev);
            console.log(`   📅 Завантажено: ${ev.name} | ${ev.date.toLocaleDateString('uk-UA')} | ${ev.seats} місць`);
        }

        if (state.events.length === 0) {
            console.warn(`⚠️ Розклад прочитано, але заходів не знайдено. Перевірте дані у листі ${config.SCHEDULE_SHEET_NAME}.`);
        } else {
            console.log(`\n✅ Розклад завантажено з Sheets (${state.events.length} заходів)`);
        }

    } catch (e) {
        console.error('❌ Error loading schedule from Sheets:', e && e.message ? e.message : e);
    }
}

async function ensureRegistrationsSheet() {
    if (!state.sheetsClient || !config.PERSONAL_DATA_SPREADSHEET_ID) return;
    try {
        const meta = await state.sheetsClient.spreadsheets.get({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            fields: 'sheets.properties.title',
        });
        const titles = (meta.data.sheets || []).map(s => s.properties.title);
        if (titles.includes(config.REGISTRATIONS_SHEET_NAME)) return;

        await state.sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    addSheet: {
                        properties: { title: config.REGISTRATIONS_SHEET_NAME },
                    },
                }],
            },
        });
        // Write header row
        await state.sheetsClient.spreadsheets.values.update({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            range: `${config.REGISTRATIONS_SHEET_NAME}!A1:E1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [['Дата реєстрації', 'ПІБ', 'Телефон', 'Назва заходу', 'Дата заходу']],
            },
        });
        console.log(`✅ Створено лист "${config.REGISTRATIONS_SHEET_NAME}" з заголовками`);
    } catch (e) {
        console.error('ensureRegistrationsSheet error:', e && e.message ? e.message : e);
    }
}

async function initSheets(bot) {
    try {
        state.sheetsClient = await createAuthorizedSheetsClient();
        state.bot = bot;

        console.log("Google Sheets підключено ✅");
        startPollingIfNeeded(bot);

        // Перевірити/створити лист "Реєстрації"
        try {
            await ensureRegistrationsSheet();
        } catch (e) {
            console.error('ensureRegistrationsSheet failed', e);
        }

        // Початкове завантаження розкладу та періодичне оновлення
        try {
            await loadEventsFromSheet();
        } catch (e) {
            console.error('Initial loadEventsFromSheet failed', e);
        }

        if (state.sheetsRefreshInterval) {
            clearInterval(state.sheetsRefreshInterval);
        }
        state.sheetsRefreshInterval = setInterval(() => {
            loadEventsFromSheet();
        }, 15000);

    } catch (err) {
        console.error("Sheets error", err && err.message ? err.message : err);
        setTimeout(() => initSheets(bot), 30000);
    }
}

module.exports = {
    startPollingIfNeeded,
    initSheets,
    loadEventsFromSheet,
};
