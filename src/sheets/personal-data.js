const state = require('../state');
const config = require('../config');

async function appendRegistrationRow(chatId, user) {

    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        throw new Error('PERSONAL_DATA_SPREADSHEET_ID not set');
    }

    // Структура таблиці "Зареєстровані":
    // A: Ім'я акаунта
    // B: Прізвище Ім'я По-батькові
    // C: Телефон
    // D: Дата народження
    // E: Відвідування
    // F: ВПО/МО
    // G: Інвалідність/Суттєві проблеми
    // H: Діти
    // I: Зайнятість
    // J: ГНЗ
    // K: Чат ID
    const values = [
        user.username || "",       // Колонка A: Ім'я акаунта
        user.name || "",           // Колонка B: ПІБ
        user.phone || "",          // Колонка C: Телефон
        user.birth || "",          // Колонка D: Дата народження
        user.visited || "",        // Колонка E: Відвідування
        user.status || "",         // Колонка F: ВПО/МО
        user.health || "",         // Колонка G: Інвалідність/Суттєві проблеми
        user.childrenCount || "",  // Колонка H: Діти
        user.employment || "",     // Колонка I: Зайнятість
        user.gbvAffected || "",    // Колонка J: ГНЗ
        String(chatId)             // Колонка K: Чат ID
    ];

    const findFirstFreeRow = (rows) => {
        const searchStartIndex = 1;
        let targetRow = Math.max(2, rows.length + 1);

        for (let i = searchStartIndex; i < rows.length; i++) {
            const row = rows[i] || [];
            // Перевіряємо колонку A (ПІБ) - якщо вона пуста, то рядок вільний
            const cell = String(row[0] || '').trim();
            if (cell === '') {
                targetRow = i + 1;
                break;
            }
        }

        return targetRow;
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
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A:K`
            });
            const rows = existingResp.data.values || [];
            console.log(`✅ Лист прочитаний. Рядків: ${rows.length}`);
            
            const targetRow = findFirstFreeRow(rows);
            console.log(`📝 Запис у рядок ${targetRow}`);

            await state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A${targetRow}:K${targetRow}`,
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
                    console.warn('⚠️  Спроба fallback-діапазону A:K (перший аркуш)...');

                    const existingResp = await state.sheetsClient.spreadsheets.values.get({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: "A:K",
                    });
                    const rows = existingResp.data.values || [];
                    const targetRow = findFirstFreeRow(rows);

                    await state.sheetsClient.spreadsheets.values.update({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A${targetRow}:K${targetRow}`,
                        valueInputOption: "RAW",
                        requestBody: { values: [values] }
                    });
                    console.log(`✅ Записано в таблицю (fallback A:K, рядок ${targetRow}) ✅\n`);
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('❌ Fallback append to A:H failed:', e2 && e2.message ? e2.message : e2);
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

function parsePersonalDataRow(row) {
    const cells = (row || []).map((cell) => String(cell || '').trim());
    const current = {
        username: cells[0] || '',
        name: cells[1] || '',
        phone: cells[2] || '',
        birth: cells[3] || '',
        visited: cells[4] || '',
        status: cells[5] || '',
        health: cells[6] || '',
        childrenCount: cells[7] || '',
        employment: cells[8] || '',
        gbvAffected: cells[9] || '',
        chatId: cells[10] || ''
    };
    const legacy = {
        username: cells[7] || '',
        name: cells[0] || '',
        phone: cells[1] || '',
        birth: cells[2] || '',
        visited: cells[3] || '',
        status: cells[4] || '',
        health: cells[5] || '',
        chatId: cells[6] || '',
        childrenCount: cells[8] || '',
        employment: cells[9] || '',
        gbvAffected: cells[10] || ''
    };

    return {
        username: current.username || legacy.username,
        name: current.name || legacy.name,
        phone: current.phone || legacy.phone,
        birth: current.birth || legacy.birth,
        visited: current.visited || legacy.visited,
        status: current.status || legacy.status,
        health: current.health || legacy.health,
        childrenCount: current.childrenCount || legacy.childrenCount,
        employment: current.employment || legacy.employment,
        gbvAffected: current.gbvAffected || legacy.gbvAffected,
        chatId: current.chatId || legacy.chatId
    };
}

async function findUserByChatId(chatId) {
    if (!state.sheetsClient || !config.PERSONAL_DATA_SPREADSHEET_ID) return null;

    const ranges = [];
    if (config.PERSONAL_DATA_SHEET_NAME) {
        ranges.push(`${config.PERSONAL_DATA_SHEET_NAME}!A:K`);
        ranges.push(`'${config.PERSONAL_DATA_SHEET_NAME}'!A:K`);
    }
    ranges.push('Зареєстровані!A:K');
    ranges.push("'Зареєстровані'!A:K");
    ranges.push('A:K');

    const chatIdStr = String(chatId).trim();

    for (const range of ranges) {
        try {
            const resp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range
            });
            const rows = resp.data.values || [];
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i] || [];
                const rowChatId = String(row[10] || '').trim();
                const rowLegacyChatId = String(row[6] || '').trim();
                const rowLegacyUsernameAsChatId = String(row[7] || '').trim();
                if (rowChatId === chatIdStr || rowLegacyChatId === chatIdStr || rowLegacyUsernameAsChatId === chatIdStr) {
                    return parsePersonalDataRow(row);
                }
            }
        } catch (e) {
            const msg = e && e.message ? String(e.message).toLowerCase() : '';
            if (msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('invalid argument')) {
                continue;
            }
            console.error('findUserByChatId error:', e && e.message ? e.message : e);
            break;
        }
    }

    return null;
}

module.exports = {
    appendRegistrationRow,
    findUserByChatId,
};
