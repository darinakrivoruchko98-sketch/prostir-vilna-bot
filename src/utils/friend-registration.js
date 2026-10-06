const { hasLikelyRegistrantNameShape } = require('./profile');

function buildFriendRegistrationRecord({
    registrantChatId,
    friendChatId,
    friendName,
    friendPhone,
    eventId
} = {}) {
    return {
        registrantChatId: String(registrantChatId || '').trim(),
        friendChatId: String(friendChatId || '').trim(),
        friendName: String(friendName || '').trim(),
        friendPhone: String(friendPhone || '').replace(/\D/g, ''),
        eventId: String(eventId || '').trim()
    };
}

function isValidFriendRegistrationRecord(record) {
    return Boolean(record && record.eventId
        && hasLikelyRegistrantNameShape(record.friendName)
        && /^380\d{9}$/.test(record.friendPhone));
}

async function registerFriendForEvent(record, operations) {
    if (!isValidFriendRegistrationRecord(record)) {
        return { status: 'invalid-registrant' };
    }

    if (!(await operations.hasAvailableSeat(record))) {
        return { status: 'no-seats' };
    }

    if (await operations.isDuplicate(record)) {
        return { status: 'already-registered' };
    }

    try {
        await operations.writeRegistrant(record);
        await operations.writeEventRegistration(record);
        return { status: 'success', record };
    } catch (error) {
        return { status: 'failed', error };
    }
}

module.exports = {
    buildFriendRegistrationRecord,
    isValidFriendRegistrationRecord,
    registerFriendForEvent
};