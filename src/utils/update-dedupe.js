// Пам'ятає нещодавно оброблені ключі (update_id / callback_query.id), щоб не обробляти їх вдруге.
function createRecentKeyTracker(limit = 2000) {
    const seen = new Set();
    return {
        // Повертає true, якщо ключ уже бачили; інакше запам'ятовує його.
        seenBefore(key) {
            if (key === undefined || key === null || key === '') return false;
            const normalized = String(key);
            if (seen.has(normalized)) return true;
            seen.add(normalized);
            if (seen.size > limit) {
                seen.delete(seen.values().next().value);
            }
            return false;
        }
    };
}

module.exports = { createRecentKeyTracker };
