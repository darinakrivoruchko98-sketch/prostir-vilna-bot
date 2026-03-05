const state = require('../state');
const config = require('../config');

async function appendRegistrationRow(chatId, user) {

    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        throw new Error('PERSONAL_DATA_SPREADSHEET_ID not set');
    }

    // Структура таблиці "Березень":
    // A: Прізвище Ім'я По-батькові (ПІБ)
    // B: Телефон
    // C: Дата народження
    // D: Чи відвідували простір?
    // E: ВПО/МО
    // F: Інвалідність/Суттєві проблеми
    // G: Ім'я акаунта (chatId для ідентифікації)
    const values = [
        user.name || "",           // Колонка A: ПІБ
        user.phone || "",          // Колонка B: Телефон
        user.birth || "",          // Колонка C: Дата народження
        user.visited || "",        // Колонка D: Чи відвідували?
        user.status || "",         // Колонка E: ВПО/МО
        user.health || "",         // Колонка F: Інвалідність
        String(chatId)              // Колонка G: ID користувача (для пошуку)
    ];

    const findFirstFreeRow = (rows) => {
        const searchStartIndex = 1;
        let targetRow = Math.max(2, rows.length + 1);

        for (let i = searchStartIndex; i < rows.length; i++) {
            const row = rows[i] || [];
            // Перевіряємо колонку A (ПІБ) - якщо вона пуста, то рядок вільний
            const cell = String(row[0] || '').trim();
            if (cell === '') {
    };

    console.log(`appendRegistrationRow -> writing to ${config.PERSONAL_DATA_SHEET_NAME}:`, values);

    // If sheetsClient not ready, retry a few times
    const maxTries = 3;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
        if (!state.sheetsClient) {
            console.warn(`sheetsClient not ready, attempt ${attempt}/${maxTries}`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
        }

        try {
            console.log(`\n📝 Спроба ${attempt}/${maxTries}: Читання листа "${config.PERSONAL_DATA_SHEET_NAME}"...`);
            const existingResp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A:G`
            });
            const rows = existingResp.data.values || [];
            console.log(`✅ Лист прочитаний. Рядків: ${rows.length}`);
            
            const targetRow = findFirstFreeRow(rows);
            console.log(`📝 Запис у рядок ${targetRow}`);

            await state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A${targetRow}:G${targetRow}`,
                valueInputOption: "RAW",
                requestBody: { values: [values] }
            });
            console.log(`✅ Записано в таблицю ${config.PERSONAL_DATA_SHEET_NAME} (рядок ${targetRow}) ✅\n`);
            return;
        } catch (e) {
            lastErr = e;
            const errorMsg = e && e.message ? e.message : String(e);
            const errorCode = e && e.code ? e.code : 'unknown';
            
            try {
                const apiInfo = e && e.response && e.response.data ? JSON.stringify(e.response.data) : null;
                console.error(`\n❌ Спроба ${attempt} не вдалась:`);
                console.error(`   Код помилки: ${errorCode}`);
                console.error(`   Повідомлення: ${errorMsg}`);
                if (apiInfo) console.error(`   API деталі: ${apiInfo}`);
                console.error(`   Лист: "${config.PERSONAL_DATA_SHEET_NAME}"`);
                console.error(`   SpreadsheetId: ${config.PERSONAL_DATA_SPREADSHEET_ID}\n`);
            } catch (logErr) {
                console.error(`\n❌ Спроба ${attempt} не вдалась (неможливо вивести деталі):`, e);
            }

            // Якщо помилка з листом — пробуємо перший лист як fallback
            const msg = errorMsg.toLowerCase();
            if ((msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('sheet') ) && attempt === 1) {
                try {
                    console.warn('⚠️  Спроба fallback-діапазону A:G (перший аркуш)...');

                    const existingResp = await state.sheetsClient.spreadsheets.values.get({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: "A:G",
                    });
                    const rows = existingResp.data.values || [];
                    const targetRow = findFirstFreeRow(rows);

                    await state.sheetsClient.spreadsheets.values.update({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A${targetRow}:G${targetRow}`,
                        valueInputOption: "RAW",
                        requestBody: { values: [values] }
                    });
                    console.log(`✅ Записано в таблицю (fallback A:G, рядок ${targetRow}) ✅\n`);
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('❌ Fallback append to A:G failed:', e2 && e2.message ? e2.message : e2);
                }
            }

            // Если ошибка связана с правами — дать подсказку в лог
            if (msg.includes('permission') || errorCode === 403 || errorCode === '403') {
                console.error('⚠️  ❌ Помилка дозволів (403)! Перевірте, чи добавлено service account як редактор до Google Sheet.');
            }
            
            if (msg.includes('quota') || msg.includes('rate limit')) {
                console.error('⚠️  ❌ Перевищено ліміт API! Спробуйте ще раз пізніше.');
            }

            await new Promise(r => setTimeout(r, 500 * attempt));
        }
    }

    // якщо всі спроби не вдались — кинути помилку вгору з деталями
    if (lastErr) {
        const msg = lastErr && lastErr.message ? lastErr.message : 'Unknown error';
        throw new Error(`Помилка при збереженні до Google Sheets: ${msg}`);
    }
    throw new Error('Unknown error writing to sheet');
}

async function findUserByChatId(chatId) {
    if (!state.sheetsClient || !config.PERSONAL_DATA_SPREADSHEET_ID) return null;

    try {
        const resp = await state.sheetsClient.spreadsheets.values.get({
            spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
            range: `${config.PERSONAL_DATA_SHEET_NAME}!A:G`
        });
        const rows = resp.data.values || [];
        const chatIdStr = String(chatId);
        // Find the latest matching row (chatId is now in column G = index 6)
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i][6] === chatIdStr) {  // Column G (index 6) contains chatId
                return {
                    name: rows[i][0] || '',      // Column A: ПІБ
                    phone: rows[i][1] || '',     // Column B: Телефон
                    birth: rows[i][2] || '',     // Column C: Дата народження
                    visited: rows[i][3] || '',   // Column D: Чи відвідували?
                    status: rows[i][4] || '',    // Column E: ВПО/МО
                    health: rows[i][5] || ''     // Column F: Інвалідність
                };
            }
        }
    } catch (e) {
        console.error('findUserByChatId error:', e && e.message ? e.message : e);
    }
    return null;
}

module.exports = {
    appendRegistrationRow,
    findUserByChatId,
};
