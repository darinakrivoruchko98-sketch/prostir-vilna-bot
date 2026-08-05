function isTemporarySheetsError(error) {
    const message = String((error && (error.message || error)) || '').toLowerCase();
    return Boolean(
        message.includes('quota') ||
        message.includes('rate limit') ||
        message.includes('temporarily') ||
        message.includes('too many requests') ||
        message.includes('read requests') ||
        message.includes('retry')
    );
}

function getUserFacingSheetsMessage(error) {
    if (isTemporarySheetsError(error)) {
        return '⚠️ Тимчасово не вдалося зберегти дані через перевантаження Google Sheets. Спробуйте ще через хвилину або напишіть @DarynaVilna.';
    }

    return '⚠️ Помилка при збереженні даних у таблиці. Спробуйте ще раз або напишіть @DarynaVilna.';
}

module.exports = {
    isTemporarySheetsError,
    getUserFacingSheetsMessage,
};
