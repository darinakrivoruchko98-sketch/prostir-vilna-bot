const config = require('../config');

function normalizeAdminId(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const normalized = Number(String(value).trim());
    return Number.isFinite(normalized) ? normalized : null;
}

function getAdminIds(adminIds = config.ADMIN_IDS) {
    return Array.from(new Set(
        (adminIds || [])
            .map((id) => normalizeAdminId(id))
            .filter((id) => id !== null)
    ));
}

function isAdminUserId(value, adminIds = config.ADMIN_IDS) {
    const normalizedValue = normalizeAdminId(value);
    if (normalizedValue === null) {
        return false;
    }

    return getAdminIds(adminIds).includes(normalizedValue);
}

module.exports = {
    getAdminIds,
    isAdminUserId
};
