const crypto = require('crypto');

const LEGACY_PREFIX = 'UNDO_REGISTER:';
const TOKEN_PREFIX = 'UNDO_T:';
const MAX_CALLBACK_DATA_BYTES = 64;
const TOKEN_LENGTH = 16;

function buildUndoToken(eventId) {
    return crypto.createHash('sha1').update(String(eventId || '')).digest('hex').slice(0, TOKEN_LENGTH);
}

// Старий формат зберігаємо, коли він вміщується в ліміт Telegram; інакше — короткий стабільний токен.
function buildUndoCallbackData(eventId) {
    const id = String(eventId || '').trim();
    const legacy = `${LEGACY_PREFIX}${id}`;
    if (Buffer.byteLength(legacy, 'utf8') <= MAX_CALLBACK_DATA_BYTES) {
        return legacy;
    }
    return `${TOKEN_PREFIX}${buildUndoToken(id)}`;
}

// Повертає eventId або '' (не undo-кнопка / токен не знайдено серед кандидатів).
function resolveUndoEventId(data, candidateEventIds = []) {
    const raw = String(data || '');
    if (raw.startsWith(LEGACY_PREFIX)) {
        return raw.slice(LEGACY_PREFIX.length).trim();
    }
    if (raw.startsWith(TOKEN_PREFIX)) {
        const token = raw.slice(TOKEN_PREFIX.length).trim();
        for (const candidate of candidateEventIds) {
            const id = String(candidate || '').trim();
            if (id && buildUndoToken(id) === token) return id;
        }
    }
    return '';
}

function isUndoCallbackData(data) {
    const raw = String(data || '');
    return raw.startsWith(LEGACY_PREFIX) || raw.startsWith(TOKEN_PREFIX);
}

module.exports = {
    MAX_CALLBACK_DATA_BYTES,
    buildUndoCallbackData,
    resolveUndoEventId,
    isUndoCallbackData
};
