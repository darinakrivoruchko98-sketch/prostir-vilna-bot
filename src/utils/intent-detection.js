function shouldSkipAiIntentDetection(text) {
    if (typeof text !== 'string') return true;

    const trimmed = text.trim();
    if (!trimmed) return true;

    const hasLetters = /[\p{L}\p{N}]/u.test(trimmed);
    if (!hasLetters) return true;

    return false;
}

module.exports = {
    shouldSkipAiIntentDetection
};
