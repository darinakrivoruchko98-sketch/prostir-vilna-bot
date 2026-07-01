const state = require('../state');

// Видаляти минулі заходи
function cleanupPastEvents() {
    const now = new Date();
    const initialCount = state.events.length;
    state.events = state.events.filter(e => e.date > now);

    if (state.events.length < initialCount) {
        console.log(`🧹 Видалено ${initialCount - state.events.length} минулих заходів`);
    }
}

// Повертає масив майбутніх заходів
function getAllEvents() {
    cleanupPastEvents();
    const now = new Date();
    return state.events.filter(e => e.date > now);
}

// Фільтрує заходи за номером дня (0-6)
function getEventsForDay(dayNum) {
    return getAllEvents().filter(e => e.date.getDay() === dayNum);
}

// Фільтрувати та сортувати заходи
function getUpcomingEvents() {
    const now = new Date();
    const filtered = state.events.filter(e => {
        if (e.date < now) return false; // майбутні тільки
        return true;
    });

    // Сортуємо за датою та часом
    filtered.sort((a, b) => a.date - b.date);
    return filtered;
}

// Отримати заходи на наступний тиждень
function getWeekEvents() {
    const now = new Date();
    const weekLater = new Date(now);
    weekLater.setDate(weekLater.getDate() + 7);

    const filtered = state.events.filter(e => {
        if (e.date < now) return false; // майбутні тільки
        if (e.date > weekLater) return false; // тільки на 7 днів
        return true;
    });

    // Сортуємо за датою та часом
    filtered.sort((a, b) => a.date - b.date);
    return filtered;
}

module.exports = {
    cleanupPastEvents,
    getAllEvents,
    getEventsForDay,
    getUpcomingEvents,
    getWeekEvents,
};
