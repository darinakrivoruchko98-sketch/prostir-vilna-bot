function formatSeatsCount(count) {
    const normalizedCount = Math.abs(Number(count));
    const lastTwoDigits = normalizedCount % 100;
    const lastDigit = normalizedCount % 10;

    let seatWord = 'місць';
    if (lastTwoDigits < 11 || lastTwoDigits > 14) {
        if (lastDigit === 1) {
            seatWord = 'місце';
        } else if (lastDigit >= 2 && lastDigit <= 4) {
            seatWord = 'місця';
        }
    }

    return `${count} ${seatWord}`;
}

function formatPeopleCount(count) {
    const normalizedCount = Math.abs(Number(count));
    const lastTwoDigits = normalizedCount % 100;
    const lastDigit = normalizedCount % 10;

    let peopleWord = 'людей';
    if (lastTwoDigits < 11 || lastTwoDigits > 14) {
        if (lastDigit === 1) {
            peopleWord = 'людина';
        } else if (lastDigit >= 2 && lastDigit <= 4) {
            peopleWord = 'людини';
        }
    }

    return `${count} ${peopleWord}`;
}

function buildAgendaEventSummary(event, seatsLeft) {
    const normalizedSeatsLeft = Number.isFinite(Number(seatsLeft)) ? Number(seatsLeft) : 0;
    const time = String(event && event.date instanceof Date ? event.date.getHours() : 0).padStart(2, '0') + ':' + String(event && event.date instanceof Date ? event.date.getMinutes() : 0).padStart(2, '0');
    const seatsLabel = normalizedSeatsLeft > 0 ? `💺 ${formatSeatsCount(normalizedSeatsLeft)}` : '❌ закрито';
    const registrationsLabel = `👥 Зареєстровано: ${formatPeopleCount(Math.max(0, Number(event && event.registrations) || 0))}`;
    const reserveLabel = `🕓 Резерв: ${formatPeopleCount(Math.max(0, Number(event && event.reserveCount) || 0))}`;

    return {
        time,
        seatsLabel,
        registrationsLabel,
        reserveLabel,
        messageLines: [
            `Назва: ${event && event.name ? event.name : ''}`,
            `Час: ${time}`,
            `Місць залишилось: ${seatsLabel}`,
            registrationsLabel,
            reserveLabel
        ],
        buttonText: `${event && event.name ? event.name : ''} | ${time} | ${seatsLabel} | 👥 ${formatPeopleCount(Math.max(0, Number(event && event.registrations) || 0))} | 🕓 ${formatPeopleCount(Math.max(0, Number(event && event.reserveCount) || 0))}`
    };
}

module.exports = {
    formatSeatsCount,
    formatPeopleCount,
    buildAgendaEventSummary
};
