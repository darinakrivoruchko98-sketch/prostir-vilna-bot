// Форматує блок інформації про захід для повідомлення
function formatEventDetails(event) {
    const time = String(event.date.getHours()).padStart(2,'0')+":"+
                 String(event.date.getMinutes()).padStart(2,'0');
    const seatsLeft = event.seats - (event.registrations || 0);
    const seatsLabel = seatsLeft > 0 ? `${seatsLeft} місць` : "❌ закрито";
    return `Назва: ${event.name}\nЧас: ${time}\nМісць залишилось: ${seatsLabel}`;
}

module.exports = {
    formatEventDetails,
};
