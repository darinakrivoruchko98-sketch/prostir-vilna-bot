const state = require('../state');
const config = require('../config');

async function appendRegistrationRow(chatId, user) {

    if (!config.PERSONAL_DATA_SPREADSHEET_ID) {
        throw new Error('PERSONAL_DATA_SPREADSHEET_ID not set');
    }

    const values = [
        new Date().toISOString(),
        user.name || "",
        user.phone || "",
        user.birth || "",
        user.visited || "",
        user.status || "",
        user.health || ""
    ];

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
            // Знаходимо останній рядок з даними щоб писати у наступну пусту комірку
            const resp = await state.sheetsClient.spreadsheets.values.get({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!A:A`
            });
            const rows = resp.data.values || [];
            const nextRow = rows.length + 1; // Наступний рядок після існуючих даних

            // Пишемо у новий рядок
            const range = `${config.PERSONAL_DATA_SHEET_NAME}!A${nextRow}`;

            await state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: range,
                valueInputOption: "USER_ENTERED",
                requestBody: {
                    values: [values],
                    majorDimension: "ROWS"
                }
            });
            // Write chatId to column I separately to not overwrite column H
            await state.sheetsClient.spreadsheets.values.update({
                spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                range: `${config.PERSONAL_DATA_SHEET_NAME}!I${nextRow}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[String(chatId)]] }
            });
            console.log(`Записано в таблицю ${config.PERSONAL_DATA_SHEET_NAME} (рядок ${nextRow}) ✅`);
            return;
        } catch (e) {
            lastErr = e;
            // Более подробное логирование ошибки от Google API (если есть)
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
                    console.warn('appendRegistrationRow: спробую fallback на перший аркуш');
                    const respFallback = await state.sheetsClient.spreadsheets.values.get({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A:A`
                    });
                    const rowsFallback = respFallback.data.values || [];
                    const nextRowFallback = rowsFallback.length + 1;

                    await state.sheetsClient.spreadsheets.values.update({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: `A${nextRowFallback}`,
                        valueInputOption: "USER_ENTERED",
                        requestBody: {
                            values: [values],
                            majorDimension: "ROWS"
                        }
                    });
                    await state.sheetsClient.spreadsheets.values.update({
                        spreadsheetId: config.PERSONAL_DATA_SPREADSHEET_ID,
                        range: `I${nextRowFallback}`,
                        valueInputOption: "USER_ENTERED",
                        requestBody: { values: [[String(chatId)]] }
                    });
                    console.log("Записано в таблицю (fallback, рядок " + nextRowFallback + ") ✅");
                    return;
                } catch (e2) {
                    lastErr = e2;
                    console.error('Fallback write failed:', e2 && e2.message ? e2.message : e2);
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
            range: `${config.PERSONAL_DATA_SHEET_NAME}!A:I`
        });
        const rows = resp.data.values || [];
        const chatIdStr = String(chatId);
        // Find the latest matching row (column I = index 8)
        for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i][8] === chatIdStr) {
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
