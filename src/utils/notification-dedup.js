function createNotificationDeduper(cooldownMs = 30000) {
    const sentAtByKey = new Map();

    function normalizeValue(value) {
        if (value instanceof Date) {
            return value.getTime();
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        return String(value || '').trim();
    }

    function buildKey(notification) {
        const chatId = String(notification && notification.chatId || '').trim();
        const kind = String(notification && notification.kind || 'general').trim();
        const eventId = String(notification && notification.eventId || '').trim();
        const eventName = String(notification && notification.eventName || '').trim();
        const eventDate = normalizeValue(notification && notification.eventDate);

        const identity = eventId || eventName || 'unknown-event';
        return `${kind}::${chatId}::${identity}::${eventDate}`;
    }

    function shouldSend(notification) {
        const key = buildKey(notification);
        if (!key) {
            return true;
        }

        const now = Date.now();
        const lastSentAt = sentAtByKey.get(key);
        if (!lastSentAt) {
            return true;
        }

        return now - lastSentAt >= cooldownMs;
    }

    function markSent(notification) {
        const key = buildKey(notification);
        if (!key) {
            return;
        }

        sentAtByKey.set(key, Date.now());
    }

    function clear(notification) {
        const key = buildKey(notification);
        if (!key) {
            return;
        }

        sentAtByKey.delete(key);
    }

    return {
        shouldSend,
        markSent,
        clear
    };
}

module.exports = {
    createNotificationDeduper
};
