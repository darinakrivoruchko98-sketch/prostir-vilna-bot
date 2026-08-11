function normalizeSendOptions(options = {}) {
    const normalized = { ...options };

    if (!normalized.reply_markup) {
        normalized.reply_markup = { remove_keyboard: true };
        return normalized;
    }

    if (normalized.reply_markup && typeof normalized.reply_markup === 'object') {
        const replyMarkup = normalized.reply_markup;
        const hasKeyboard = Object.prototype.hasOwnProperty.call(replyMarkup, 'keyboard');
        const hasForceReply = Object.prototype.hasOwnProperty.call(replyMarkup, 'force_reply');

        if (!hasKeyboard && !hasForceReply) {
            normalized.reply_markup = { ...replyMarkup, remove_keyboard: true };
        }
    }

    return normalized;
}

module.exports = {
    normalizeSendOptions
};
