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
    // E: ВПО/МО
    // F: Кількість дітей до 18 років
    // G: Стан здоров'я
    // H: Евакуаційний статус
    // I: Вплив обстрілів
    // J: Зайнятість
    // K: Категорія
    // L: ГЗН
    // M: Чат ID
    const values = [
        user.username || '',
        user.name || '',
        user.phone || '',
        user.birth || '',
        user.status || '',
        user.childrenCount || '',
        user.health || '',
        user.evacuationStatus || '',
        user.shellingImpact || '',
        user.employment || '',
        user.beneficiaryCategory || '',
        user.gzn || '',
        String(chatId)
    ];

    const findFirstFreeRow = (rows) => {
        const searchStartIndex = 1;
        let targetRow = Math.max(2, rows.length + 1);

        for (let i = searchStartIndex; i < rows.length; i++) {
            const row = rows[i] || [];
            const cell = String(row[0] || '').trim();
            if (cell === '') {
                targetRow = i + 1;
                break;
            }
        }

        return targetRow;
    };

    console.log(`appendRegistrationRow -> writing to ${config.PERSONAL_DATA_SHEET_NAME}:`, values);

    const maxTries = 3;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxTries; attempt++) {
        if (!state.sheetsClient) {
            console.warn(`sheetsClient not ready, attempt ${attempt}/${maxTries}`);
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            continue;
        }

        try {
            console.log(`\n📝 Спроба ${attempt}/${maxTries}: Читання листа "${config.PERSONAL_DATA_SHEET_NAME}"...`);
            const metaResp = await state.sheetsClient.spreadsheets.get({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID
            });
            const sheetTitles = (metaResp.data.sheets || []).map((sheet) => sheet.properties && sheet.properties.title ? sheet.properties.title : '');
            console.log(`📋 Доступні листи: ${sheetTitles.join(', ') || '(немає)'}`);
            if (!sheetTitles.includes(config.PERSONAL_DATA_SHEET_NAME)) {
                throw new Error(`Лист "${config.PERSONAL_DATA_SHEET_NAME}" не знайдено. Доступні листи: ${sheetTitles.join(', ') || '(немає)'}`);
            }
            const existingResp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A:M`
            });
            const rows = existingResp.data.values || [];
            console.log(`✅ Лист прочитаний. Рядків: ${rows.length}`);

            const targetRow = findFirstFreeRow(rows);
            console.log(`📝 Запис у рядок ${targetRow}`);

            await state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A${targetRow}:M${targetRow}`,
                valueInputOption: 'RAW',
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

            const msg = errorMsg.toLowerCase();
            if ((msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('sheet')) && attempt === 1) {
                try {
                    console.warn('⚠️  Спроба fallback-діапазону A:M (перший аркуш)...');

                    const existingResp = await state.sheetsClient.spreadsheets.values.get({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: 'A:M'
                    });
                    const rows = existingResp.data.values || [];
                    const targetRow = findFirstFreeRow(rows);

                    await state.sheetsClient.spreadsheets.values.update({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A${targetRow}:M${targetRow}`,
                        valueInputOption: 'RAW',
                        requestBody: { values: [values] }
                    });
                    console.log(`✅ Записано в таблицю (fallback A:M, рядок ${targetRow}) ✅\n`);
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('❌ Fallback append to A:M failed:', e2 && e2.message ? e2.message : e2);
                }
            }

            if (msg.includes('permission') || errorCode === 403 || errorCode === '403') {
                console.error('⚠️  ❌ Помилка дозволів (403)! Перевірте, чи добавлено service account як редактор до Google Sheet.');
            }

            if (msg.includes('quota') || msg.includes('rate limit')) {
                console.error('⚠️  ❌ Перевищено ліміт API! Спробуйте ще раз пізніше.');
            }

            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
    }

    if (lastErr) {
        const msg = lastErr && lastErr.message ? lastErr.message : 'Unknown error';
        throw new Error(`Помилка при збереженні до Google Sheets: ${msg}`);
    }
    throw new Error('Unknown error writing to sheet');
}

function parsePersonalDataRow(row) {
    const cells = (row || []).map((cell) => String(cell || '').trim());
    const hasMColumns = cells.length > 12;
    const current = {
        username: cells[0] || '',
        name: cells[1] || '',
        phone: cells[2] || '',
        birth: cells[3] || '',
        status: cells[4] || '',
        childrenCount: hasMColumns ? (cells[5] || '') : '',
        health: hasMColumns ? (cells[6] || '') : (cells[5] || ''),
        evacuationStatus: hasMColumns ? (cells[7] || '') : (cells[6] || ''),
        shellingImpact: hasMColumns ? (cells[8] || '') : (cells[7] || ''),
        employment: hasMColumns ? (cells[9] || '') : (cells[8] || ''),
        beneficiaryCategory: hasMColumns ? (cells[10] || '') : (cells[10] || cells[9] || ''),
        gzn: hasMColumns ? (cells[11] || '') : (cells[9] || ''),
        chatId: hasMColumns ? (cells[12] || '') : (cells[11] || cells[10] || '')
    };
    const legacy = {
        username: cells[7] || '',
        name: cells[0] || '',
        phone: cells[1] || '',
        birth: cells[2] || '',
        status: cells[4] || '',
        childrenCount: '',
        health: cells[5] || '',
        evacuationStatus: '',
        shellingStatus: '',
        chatId: cells[6] || '',
        employment: cells[9] || '',
        gzn: '',
        beneficiaryCategory: ''
    };

    return {
        username: current.username || legacy.username,
        name: current.name || legacy.name,
        phone: current.phone || legacy.phone,
        birth: current.birth || legacy.birth,
        status: current.status || legacy.status,
        childrenCount: current.childrenCount || legacy.childrenCount,
        health: current.health || legacy.health,
        evacuationStatus: current.evacuationStatus || legacy.evacuationStatus,
        shellingImpact: current.shellingImpact || legacy.shellingImpact,
        employment: current.employment || legacy.employment,
        gzn: current.gzn || legacy.gzn,
        beneficiaryCategory: current.beneficiaryCategory || legacy.beneficiaryCategory,
        chatId: current.chatId || legacy.chatId
    };
}

async function findUserByChatId(chatId) {
    if (!state.sheetsClient || !config.PERSONAL_DATA_SPREADSHEET_ID) return null;

    const ranges = [];
    if (config.PERSONAL_DATA_SHEET_NAME) {
        ranges.push(`${config.PERSONAL_DATA_SHEET_NAME}!A:M`);
        ranges.push(`'${config.PERSONAL_DATA_SHEET_NAME}'!A:M`);
    }
    ranges.push('Зареєстровані!A:M');
    ranges.push("'Зареєстровані'!A:M");
    ranges.push('A:M');

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
                const rowChatId = String(row[12] || row[11] || row[10] || '').trim();
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
