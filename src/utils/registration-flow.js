function isRegistrationCancelText(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return false;

    return [
        '❌ Скасувати реєстрацію',
        '❌ Відмінити реєстрацію',
        '❌ Відмінити',
        '❌ Скасувати'
    ].includes(normalized);
}

module.exports = {
    isRegistrationCancelText
};
