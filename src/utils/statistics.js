const fs = require('fs');
const path = require('path');
const state = require('../state');
const config = require('../config');
const { parsePersonalDataRow } = require('../sheets/personal-data');

const DEFAULT_HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'statistics-history.json');

function normalizeText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function normalizeRegistrationStatus(value) {
    const normalized = normalizeText(value);

    if (!normalized) return null;

    if (normalized.includes('не впо')) {
        if (normalized.includes('не постраждали') || normalized.includes('не постраждала')) {
            return 'Не ВПО, не постраждали від війни';
        }
        if (normalized.includes('постраждали') || normalized.includes('постраждала')) {
            return 'Не ВПО, постраждали від війни';
        }
        return null;
    }

    if (normalized.includes('впо')) {
        return 'ВПО';
    }

    return null;
}

function calculateAgeAtDate(birthDate, asOfDate) {
    if (!birthDate) return null;

    const birth = new Date(birthDate);
    const asOf = new Date(asOfDate);

    if (Number.isNaN(birth.getTime()) || Number.isNaN(asOf.getTime())) {
        return null;
    }

    let age = asOf.getFullYear() - birth.getFullYear();
    const monthDiff = asOf.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birth.getDate())) {
        age -= 1;
    }
    return age;
}

function getAgeGroup(age) {
    if (age === null || Number.isNaN(age)) return null;
    if (age < 18) return 'до 18 років';
    if (age < 60) return '18–59 років';
    return '60+ років';
}

function isSpecialNeeds(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('інвал') || normalized.includes('істотні проблеми') || normalized.includes('суттєві проблеми');
}

function formatDateParts(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getDateOnly(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return formatDateParts(date);
}

function getWeekRange(referenceDate = new Date()) {
    const date = new Date(referenceDate);
    const day = date.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(date);
    monday.setDate(date.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
        startDate: formatDateParts(monday),
        endDate: formatDateParts(sunday)
    };
}

function getMonthRange(referenceDate = new Date()) {
    const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
    const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0);
    return {
        startDate: formatDateParts(start),
        endDate: formatDateParts(end)
    };
}

function getDayRange(referenceDate = new Date()) {
    const date = new Date(referenceDate);
    return {
        startDate: formatDateParts(date),
        endDate: formatDateParts(date)
    };
}

function getPeriodDefinition(selection, referenceDate = new Date()) {
    const normalizedSelection = String(selection || '').trim().toLowerCase();

    if (normalizedSelection === 'previous-day') {
        const previousDayDate = new Date(referenceDate);
        previousDayDate.setDate(previousDayDate.getDate() - 1);
        const dayRange = getDayRange(previousDayDate);
        return {
            type: 'day',
            kind: 'previous-day',
            key: `day:${dayRange.startDate}`,
            label: dayRange.startDate,
            startDate: dayRange.startDate,
            endDate: dayRange.endDate,
            displayLabel: `📅 Попередній день (${dayRange.startDate})`
        };
    }

    if (normalizedSelection === 'current-day' || normalizedSelection === 'day') {
        const dayRange = getDayRange(referenceDate);
        return {
            type: 'day',
            kind: 'current-day',
            key: `day:${dayRange.startDate}`,
            label: dayRange.startDate,
            startDate: dayRange.startDate,
            endDate: dayRange.endDate,
            displayLabel: `📅 Поточний день (${dayRange.startDate})`
        };
    }

    if (normalizedSelection === 'previous-week') {
        const previousWeekDate = new Date(referenceDate);
        previousWeekDate.setDate(previousWeekDate.getDate() - 7);
        const weekRange = getWeekRange(previousWeekDate);
        return {
            type: 'week',
            kind: 'previous-week',
            key: `week:${weekRange.startDate}`,
            label: `${weekRange.startDate} – ${weekRange.endDate}`,
            startDate: weekRange.startDate,
            endDate: weekRange.endDate,
            displayLabel: `📊 Попередній тиждень (${weekRange.startDate} – ${weekRange.endDate})`
        };
    }

    if (normalizedSelection === 'current-week') {
        const weekRange = getWeekRange(referenceDate);
        return {
            type: 'week',
            kind: 'current-week',
            key: `week:${weekRange.startDate}`,
            label: `${weekRange.startDate} – ${weekRange.endDate}`,
            startDate: weekRange.startDate,
            endDate: weekRange.endDate,
            displayLabel: `📊 Поточний тиждень (${weekRange.startDate} – ${weekRange.endDate})`
        };
    }

    if (normalizedSelection === 'previous-month') {
        const previousMonthDate = new Date(referenceDate);
        previousMonthDate.setMonth(previousMonthDate.getMonth() - 1);
        const monthRange = getMonthRange(previousMonthDate);
        return {
            type: 'month',
            kind: 'previous-month',
            key: `month:${monthRange.startDate}`,
            label: `${monthRange.startDate} – ${monthRange.endDate}`,
            startDate: monthRange.startDate,
            endDate: monthRange.endDate,
            displayLabel: `📅 Попередній місяць (${monthRange.startDate} – ${monthRange.endDate})`
        };
    }

    const monthRange = getMonthRange(referenceDate);
    return {
        type: 'month',
        kind: 'current-month',
        key: `month:${monthRange.startDate}`,
        label: `${monthRange.startDate} – ${monthRange.endDate}`,
        startDate: monthRange.startDate,
        endDate: monthRange.endDate,
        displayLabel: `📅 Поточний місяць (${monthRange.startDate} – ${monthRange.endDate})`
    };
}

function getPeriodLabel(period) {
    if (!period) return 'Статистика';
    if (period.type === 'day') {
        return period.startDate || 'Статистика';
    }
    return `${period.startDate} – ${period.endDate}`;
}

function getStatisticsSelectionButtons() {
    return [
        { text: '📊 Поточний тиждень', value: 'current-week' },
        { text: '📊 Попередній тиждень', value: 'previous-week' },
        { text: '📅 Поточний місяць', value: 'current-month' },
        { text: '📅 Попередній місяць', value: 'previous-month' }
    ];
}

function resolveStatisticsSelectionFromText(text) {
    const normalizedText = String(text || '').trim().toLowerCase();
    const buttonMap = {
        '📊 поточний тиждень': 'current-week',
        '📊 попередній тиждень': 'previous-week',
        '📅 поточний місяць': 'current-month',
        '📅 попередній місяць': 'previous-month'
    };
    return buttonMap[normalizedText] || null;
}

function buildStatisticsSnapshotForPeriod(period, registrations) {
    const seenProfiles = new Set();
    const seenEventProfiles = new Set();
    const statusBuckets = {
        'ВПО': 0,
        'Не ВПО, постраждали від війни': 0,
        'Не ВПО, не постраждали від війни': 0
    };
    const ageBuckets = {
        'до 18 років': 0,
        '18–59 років': 0,
        '60+ років': 0
    };
    let specialNeedsCount = 0;
    const eventRegistrationTotals = {};

    for (const registration of registrations || []) {
        const profile = registration && registration.profile ? registration.profile : null;
        const profileChatId = String(profile && profile.chatId ? profile.chatId : '').trim();
        const profilePhone = String(profile && profile.phone ? profile.phone : '').trim();
        const profileName = String(profile && profile.name ? profile.name : '').trim();
        const identityKey = profileChatId || profilePhone || profileName;
        const eventKey = registration && (registration.eventKey || registration.eventName || registration.eventDate)
            ? (registration.eventKey || `${String(registration.eventName || '').trim().toLowerCase()}_${String(registration.eventDate || '').trim()}`)
            : null;

        if (eventKey) {
            const existingEventEntry = eventRegistrationTotals[eventKey] || { registrationCount: 0, source: 'schedule' };
            const scheduleRegistrationCount = Number.isFinite(Number(registration.scheduleRegistrationCount))
                ? Number(registration.scheduleRegistrationCount)
                : null;
            if (scheduleRegistrationCount !== null && scheduleRegistrationCount >= 0) {
                existingEventEntry.registrationCount = Math.max(existingEventEntry.registrationCount, scheduleRegistrationCount);
                existingEventEntry.source = 'schedule';
            }
            eventRegistrationTotals[eventKey] = existingEventEntry;
        }

        if (!profile || !identityKey) {
            continue;
        }

        if (identityKey) {
            seenProfiles.add(identityKey);
        }

        const eventIdentityKey = eventKey ? `${eventKey}:${identityKey}` : identityKey;
        if (seenEventProfiles.has(eventIdentityKey)) {
            continue;
        }
        seenEventProfiles.add(eventIdentityKey);

        const normalizedStatus = normalizeRegistrationStatus(profile.status || '');
        if (normalizedStatus) {
            statusBuckets[normalizedStatus] = (statusBuckets[normalizedStatus] || 0) + 1;
        }

        const age = calculateAgeAtDate(profile.birth || '', period.endDate || period.startDate || formatDateParts(new Date()));
        const ageGroup = getAgeGroup(age);
        if (ageGroup) {
            ageBuckets[ageGroup] = (ageBuckets[ageGroup] || 0) + 1;
        }

        if (isSpecialNeeds(profile.health || '')) {
            specialNeedsCount += 1;
        }
    }

    const totalRegistered = Object.values(eventRegistrationTotals).reduce((sum, entry) => sum + (Number(entry && entry.registrationCount) || 0), 0);

    return {
        period,
        totalUniquePeople: seenProfiles.size,
        totalRegistered,
        status: statusBuckets,
        ageGroups: ageBuckets,
        specialNeeds: specialNeedsCount,
        eventRegistrationTotals
    };
}

function ensureStatisticsHistoryFile(historyPath = DEFAULT_HISTORY_PATH) {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    if (!fs.existsSync(historyPath)) {
        fs.writeFileSync(historyPath, JSON.stringify({ versions: [1], periods: [] }, null, 2));
    }
}

function loadStatisticsHistory(historyPath = DEFAULT_HISTORY_PATH) {
    ensureStatisticsHistoryFile(historyPath);
    try {
        return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (error) {
        return { versions: [1], periods: [] };
    }
}

function saveStatisticsHistory(historyData, historyPath = DEFAULT_HISTORY_PATH) {
    ensureStatisticsHistoryFile(historyPath);
    fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2));
}

function upsertPeriodSnapshot(snapshot, historyData = null, historyPath = DEFAULT_HISTORY_PATH) {
    const data = historyData || loadStatisticsHistory(historyPath);
    const periods = Array.isArray(data.periods) ? data.periods : [];
    const existingIndex = periods.findIndex((entry) => entry && entry.period && entry.period.type === snapshot.period.type && entry.period.key === snapshot.period.key);
    if (existingIndex >= 0) {
        periods[existingIndex] = snapshot;
    } else {
        periods.push(snapshot);
    }
    data.periods = periods;
    saveStatisticsHistory(data, historyPath);
    return snapshot;
}

function findSnapshotInHistory(historyData, period) {
    const periods = Array.isArray(historyData && historyData.periods) ? historyData.periods : [];
    return periods.find((entry) => entry && entry.period && entry.period.type === period.type && entry.period.key === period.key) || null;
}

async function readSheetRows(spreadsheetId, range) {
    if (!state.sheetsClient || !spreadsheetId) {
        return [];
    }

    try {
        const response = await state.sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
        return response.data.values || [];
    } catch (error) {
        return [];
    }
}

async function collectStatisticsRegistrationsForPeriod(period, options = {}) {
    const personalSpreadsheetId = options.personalSpreadsheetId || options.spreadsheetId || config.PERSONAL_DATA_SPREADSHEET_ID;
    const scheduleSpreadsheetId = options.scheduleSpreadsheetId || config.SPREADSHEET_ID || personalSpreadsheetId;
    const personalSheetName = options.personalSheetName || config.PERSONAL_DATA_SHEET_NAME || 'Зареєстровані';
    const scheduleSheetName = options.scheduleSheetName || config.SCHEDULE_SHEET_NAME || 'Розклад';
    if (!state.sheetsClient || !personalSpreadsheetId) {
        return [];
    }

    const profileRows = await readSheetRows(personalSpreadsheetId, `${personalSheetName}!A:M`);
    const registrationRows = await readSheetRows(personalSpreadsheetId, `${personalSheetName}!A:E`);
    const parsedProfiles = (profileRows || []).slice(1).map((row) => parsePersonalDataRow(row));
    const profileByPhone = new Map();
    const profileByName = new Map();
    const profileByChatId = new Map();

    for (const profile of parsedProfiles) {
        const normalizedPhone = String(profile.phone || '').replace(/\D/g, '');
        const normalizedName = normalizeText(profile.name || '');
        const normalizedChatId = String(profile.chatId || '').trim();
        if (normalizedPhone) {
            profileByPhone.set(normalizedPhone, profile);
        }
        if (normalizedName) {
            profileByName.set(normalizedName, profile);
        }
        if (normalizedChatId) {
            profileByChatId.set(normalizedChatId, profile);
        }
    }

    const scheduleEntries = [];
    try {
        const scheduleRows = await readSheetRows(scheduleSpreadsheetId, `${scheduleSheetName}!A:E`);
        for (const row of (scheduleRows || []).slice(1) || []) {
            const parsedEvent = require('../events/parser').parseEventFromRow(row, null).event;
            if (!parsedEvent) {
                continue;
            }
            const eventDate = parsedEvent.date ? formatDateParts(parsedEvent.date) : '';
            const startDate = period && period.startDate ? period.startDate : null;
            const endDate = period && period.endDate ? period.endDate : null;
            if (startDate && endDate && (eventDate < startDate || eventDate > endDate)) {
                continue;
            }
            const eventKey = `${String(parsedEvent.name || '').trim().toLowerCase()}_${eventDate}`;
            const registrationCount = Number.isFinite(parsedEvent.registrations) ? parsedEvent.registrations : 0;
            scheduleEntries.push({
                eventName: parsedEvent.name,
                eventDate,
                eventKey,
                scheduleRegistrationCount: registrationCount,
                profile: null
            });
        }
    } catch (error) {
        // Ignore schedule read failures and rely on the fallback total from any matched rows.
    }

    const matchedRegistrations = [];
    const seenRegistrationKeys = new Set();
    for (const row of registrationRows.slice(1) || []) {
        const timestamp = row[0] || '';
        const registrationDate = getDateOnly(timestamp);
        if (!registrationDate) {
            continue;
        }

        const startDate = period && period.startDate ? period.startDate : null;
        const endDate = period && period.endDate ? period.endDate : null;
        if (startDate && endDate && (registrationDate < startDate || registrationDate > endDate)) {
            continue;
        }

        const phone = String(row[2] || '').replace(/\D/g, '');
        const name = normalizeText(row[1] || '');
        const chatId = String(row[4] || '').trim();
        let matchedProfile = null;
        if (chatId) {
            matchedProfile = profileByChatId.get(chatId) || null;
        }
        if (!matchedProfile && phone) {
            matchedProfile = profileByPhone.get(phone) || null;
        }
        if (!matchedProfile && name) {
            matchedProfile = profileByName.get(name) || null;
        }

        if (!matchedProfile) {
            continue;
        }

        const eventName = String(row[3] || '').trim();
        const eventDate = String(row[4] || '').trim();
        const eventKey = eventName && eventDate ? `${String(eventName).trim().toLowerCase()}_${eventDate}` : null;
        const identityKey = String(matchedProfile.chatId || matchedProfile.phone || matchedProfile.name || '').trim();
        const registrationKey = `${identityKey}:${eventKey || registrationDate}`;
        if (!identityKey || seenRegistrationKeys.has(registrationKey)) {
            continue;
        }
        seenRegistrationKeys.add(registrationKey);

        matchedRegistrations.push({
            registrationDate,
            profile: matchedProfile,
            eventName,
            eventDate,
            eventKey,
            scheduleRegistrationCount: null
        });
    }

    return [...scheduleEntries, ...matchedRegistrations];
}

async function buildStatisticsSnapshotForSelection(selection, referenceDate = new Date(), historyPath = DEFAULT_HISTORY_PATH) {
    const period = getPeriodDefinition(selection, referenceDate);
    const historyData = loadStatisticsHistory(historyPath);
    if (selection && selection !== 'current-week' && selection !== 'current-month') {
        const archivedSnapshot = findSnapshotInHistory(historyData, period);
        if (archivedSnapshot) {
            return archivedSnapshot;
        }
    }

    const registrations = await collectStatisticsRegistrationsForPeriod(period);
    const snapshot = buildStatisticsSnapshotForPeriod(period, registrations);
    snapshot.period = { ...period };
    upsertPeriodSnapshot(snapshot, historyData, historyPath);
    return snapshot;
}

function formatStatisticsSnapshot(snapshot) {
    const periodLabel = snapshot && snapshot.period && snapshot.period.displayLabel
        ? snapshot.period.displayLabel
        : getPeriodLabel(snapshot && snapshot.period ? snapshot.period : null);

    const lines = [
        '🧮 Статистика Простору «Вільна»',
        '',
        `📅 ${periodLabel}`,
        '',
        `👥 Всього зареєстровано: ${snapshot && Number.isFinite(snapshot.totalUniquePeople) ? snapshot.totalUniquePeople : 0}`,
        '',
        '📊 Статус:',
        `🟢 ВПО — ${snapshot && snapshot.status ? snapshot.status['ВПО'] || 0 : 0}`,
        `🟡 Не ВПО, постраждали від війни — ${snapshot && snapshot.status ? snapshot.status['Не ВПО, постраждали від війни'] || 0 : 0}`,
        `⚪ Не ВПО, не постраждали від війни — ${snapshot && snapshot.status ? snapshot.status['Не ВПО, не постраждали від війни'] || 0 : 0}`,
        '',
        '📈 Вік:',
        `👧 До 18 років — ${snapshot && snapshot.ageGroups ? snapshot.ageGroups['до 18 років'] || 0 : 0}`,
        `👩 18–59 років — ${snapshot && snapshot.ageGroups ? snapshot.ageGroups['18–59 років'] || 0 : 0}`,
        `👵 60+ років — ${snapshot && snapshot.ageGroups ? snapshot.ageGroups['60+ років'] || 0 : 0}`,
        '',
        '♿ Особливі потреби:',
        `🧩 Інвалідність / суттєві проблеми зі здоров\'ям — ${snapshot && Number.isFinite(snapshot.specialNeeds) ? snapshot.specialNeeds : 0}`
    ];

    return lines.join('\n');
}

module.exports = {
    normalizeRegistrationStatus,
    calculateAgeAtDate,
    isSpecialNeeds,
    buildStatisticsSnapshotForPeriod,
    ensureStatisticsHistoryFile,
    loadStatisticsHistory,
    saveStatisticsHistory,
    upsertPeriodSnapshot,
    getPeriodDefinition,
    getPeriodLabel,
    getStatisticsSelectionButtons,
    resolveStatisticsSelectionFromText,
    buildStatisticsSnapshotForSelection,
    collectStatisticsRegistrationsForPeriod,
    formatStatisticsSnapshot,
    DEFAULT_HISTORY_PATH,
    getDayRange,
    buildStatisticsSnapshotsForPeriods: (referenceDate = new Date()) => [
        { selection: 'current-day', period: getPeriodDefinition('current-day', referenceDate) },
        { selection: 'current-week', period: getPeriodDefinition('current-week', referenceDate) },
        { selection: 'current-month', period: getPeriodDefinition('current-month', referenceDate) }
    ]
};
