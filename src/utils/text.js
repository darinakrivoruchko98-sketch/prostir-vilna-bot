// Правильна граматика для множини заходів
function pluralizeEvents(count) {
    if (count === 1) return "захід";
    if (count % 10 === 2 || count % 10 === 3 || count % 10 === 4) {
        if (count % 100 === 12 || count % 100 === 13 || count % 100 === 14) {
            return "заходів";
        }
        return "заходи";
    }
    return "заходів";
}

function normalizeTitle(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = {
    pluralizeEvents,
    normalizeTitle,
};
