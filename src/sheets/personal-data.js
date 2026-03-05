const state = require('../state');
const config = require('../config');

async function appendRegistrationRow(chatId, user) {

    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        throw new Error('PERSONAL_DATA_SPREADSHEET_ID not set');
    }

    const values = [
        String(chatId),
        user.name || "",
        user.phone || "",
        user.birth || "",
        user.visited || "",
        user.status || "",
        user.health || ""
    ];

    const findFirstFreeRow = (rows) => {
        const searchStartIndex = 1;
        let targetRow = Math.max(2, rows.length + 1);

        for (let i = searchStartIndex; i < rows.length; i++) {
            const row = rows[i] || [];
            // Перевіряємо ВСІ колонки A-G (індекси 0-6)
            const personalDataHasValues = [0, 1, 2, 3, 4, 5, 6].some((idx) => String(row[idx] || '').trim() !== '');
            if (!personalDataHasValues) {
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
            const existingResp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A:G`
            });
            const rows = existingResp.data.values || [];
            const targetRow = findFirstFreeRow(rows);

            await state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A${targetRow}:G${targetRow}`,
                valueInputOption: "RAW",
                requestBody: { values: [values] }
            });
            console.log(`Записано в таблицю ${config.PERSONAL_DATA_SHEET_NAME} (рядок ${targetRow}) ✅`);
            return;
        } catch (e) {
            lastErr = e;
            try {
                const apiInfo = e && e.response && e.response.data ? JSON.stringify(e.response.data) : null;
                console.error(`appendRegistrationRow attempt ${attempt} failed:`, e && e.message ? e.message : e, apiInfo ? `| api: ${apiInfo}` : '');
            } catch (logErr) {
                console.error(`appendRegistrationRow attempt ${attempt} failed (unable to stringify error):`, e);
            }

            // Якщо помилка з листом — пробуємо перший лист як fallback
            const msg = (e && e.message) ? String(e.message).toLowerCase() : '';
            if ((msg.includes('unable to parse range') || msg.includes('not found') || msg.includes('sheet') ) && attempt === 1) {
                try {
                    console.warn('appendRegistrationRow: попробую fallback-діапазон A:G (перший аркуш)');

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
                    console.log(`Записано в таблицю (fallback A:G, рядок ${targetRow}) ✅`);
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('Fallback append to A:G failed:', e2 && e2.message ? e2.message : e2);
                }
            }

            // Если ошибка связана с правами — дать подсказку в лог
            if (msg.includes('permission') || (e && e.code === 403)) {
                console.error('appendRegistrationRow: можливі проблеми з дозволами. Перевірте, чи додано service account як редактор до Google Sheet.');
            }

            await new Promise(r => setTimeout(r, 500 * attempt));
        }
    }

    // якщо всі спроби не вдались — кинути помилку вгору
    throw lastErr || new Error('Unknown error writing to sheet');
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
        // Find the latest matching row (column A = index 0)
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i][0] === chatIdStr) {
                return {
                    name: rows[i][1] || '',
                    phone: rows[i][2] || '',
                    birth: rows[i][3] || '',
                    visited: rows[i][4] || '',
                    status: rows[i][5] || '',
                    health: rows[i][6] || '',
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
