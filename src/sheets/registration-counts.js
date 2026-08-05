function calculateRegistrationSheetValues(currentRemainingSeats, currentRegistrations, action) {
    const safeRemaining = Number.isFinite(Number(currentRemainingSeats)) ? Math.max(0, Number(currentRemainingSeats)) : 0;
    const safeRegistrations = Number.isFinite(Number(currentRegistrations)) ? Math.max(0, Number(currentRegistrations)) : 0;

    if (action === 'increment') {
        return [Math.max(0, safeRemaining - 1), safeRegistrations + 1];
    }

    if (action === 'decrement') {
        return [safeRemaining + 1, Math.max(0, safeRegistrations - 1)];
    }

    return [safeRemaining, safeRegistrations];
}

module.exports = {
    calculateRegistrationSheetValues,
};
