const state = require('../state');
const config = require('../config');
const { createAuthorizedSheetsClient } = require('./auth');
const { parseEventFromRow } = require('../events/parser');

function startPollingIfNeeded(bot) {
    if (state.pollingStarted) return;
    bot.startPolling();
    state.pollingStarted = true;
    console.log("🤖 Telegram polling запущено ✅");
}

async function loadEventsFromSheet() {
    if (!state.sheetsClient || !config.SPREADSHEET_ID) return;

    try {
        let rows = [];
        const readErrors = [];
        for (const scheduleSheet of config.SCHEDULE_SHEET_CANDIDATES) {
            try {
                const resp = await state.sheetsClient.spreadsheets.values.get({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range: `${scheduleSheet}!A:E`
                });
                rows = resp.data.values || [];
                if (rows && rows.length) {
                    console.log(`   Використано лист ${scheduleSheet}`);
                    break;
                }
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
                if (msg.includes('unable to parse range') || msg.includes('not found')) {
                    continue;
                }
                readErrors.push({ sheet: scheduleSheet, message: e && e.message ? e.message : String(e) });
            }
        }

        // Если всё ещё пусто, попробуем ещё общий диапазон
        if (!rows || rows.length === 0) {
            try {
                const alt2 = await state.sheetsClient.spreadsheets.values.get({
                    spreadsheetId: config.SPREADSHEET_ID,
                    range: "A:E"
                });
                rows = alt2.data.values || [];
                if (rows && rows.length) console.log('   Використано діапазон A:E');
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                readErrors.push({ sheet: 'A:E', message: msg });
            }
        }

        if ((!rows || rows.length === 0) && readErrors.length > 0) {
            const details = readErrors.map((entry) => `${entry.sheet}: ${entry.message}`).join(' | ');
            throw new Error(`Не вдалося зчитати розклад із таблиці ${config.SPREADSHEET_ID}. ${details}`);
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
                continue;
            }

            if (seen.has(ev.id)) {
                continue;
            }

            seen.add(ev.id);
            state.events.push(ev);
        }

        if (state.events.length === 0) {
            console.warn(`⚠️ Розклад прочитано, але заходів не знайдено. Перевірте дані у листі ${config.SCHEDULE_SHEET_NAME}.`);
        }
        console.log(`✅ Розклад завантажено з Sheets (${state.events.length} заходів)`);

    } catch (e) {
        console.error('Error loading schedule from Sheets', e);
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
        }, 60000);

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
