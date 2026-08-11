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

function getDateOnly(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return date.toISOString().slice(0, 10);
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
        startDate: monday.toISOString().slice(0, 10),
        endDate: sunday.toISOString().slice(0, 10)
    };
}

function getMonthRange(referenceDate = new Date()) {
    const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
    const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0);
    return {
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10)
    };
}

function getPeriodDefinition(selection, referenceDate = new Date()) {
    const normalizedSelection = String(selection || '').trim().toLowerCase();
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
    if (period.type === 'week') {
        return `${period.startDate} – ${period.endDate}`;
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
    const seenIdentities = new Set();
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

    for (const registration of registrations || []) {
        const profile = registration && registration.profile ? registration.profile : {};
        const profileChatId = String(profile.chatId || '').trim();
        const profilePhone = String(profile.phone || '').trim();
        const profileName = String(profile.name || '').trim();
        const identityKey = profileChatId || profilePhone || profileName;
        if (!identityKey || seenIdentities.has(identityKey)) {
            continue;
        }
        seenIdentities.add(identityKey);

        const normalizedStatus = normalizeRegistrationStatus(profile.status || '');
        if (normalizedStatus) {
            statusBuckets[normalizedStatus] = (statusBuckets[normalizedStatus] || 0) + 1;
        }

        const age = calculateAgeAtDate(profile.birth || '', period.endDate || period.startDate || new Date().toISOString().slice(0, 10));
        const ageGroup = getAgeGroup(age);
        if (ageGroup) {
            ageBuckets[ageGroup] = (ageBuckets[ageGroup] || 0) + 1;
        }

        if (isSpecialNeeds(profile.health || '')) {
            specialNeedsCount += 1;
        }
    }

    return {
        period,
        totalUniquePeople: seenIdentities.size,
        status: statusBuckets,
        ageGroups: ageBuckets,
        specialNeeds: specialNeedsCount
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
    const spreadsheetId = options.spreadsheetId || config.PERSONAL_DATA_SPREADSHEET_ID;
    const sheetName = options.sheetName || config.PERSONAL_DATA_SHEET_NAME || 'Зареєстровані';
    if (!state.sheetsClient || !spreadsheetId) {
        return [];
    }

    const profileRows = await readSheetRows(spreadsheetId, `${sheetName}!A:M`);
    const registrationRows = await readSheetRows(spreadsheetId, `${sheetName}!A:E`);
    const parsedProfiles = (profileRows || []).slice(1).map((row) => parsePersonalDataRow(row));
    const profileByPhone = new Map();
    const profileByName = new Map();

    for (const profile of parsedProfiles) {
        const normalizedPhone = String(profile.phone || '').replace(/\D/g, '');
        const normalizedName = normalizeText(profile.name || '');
        if (normalizedPhone) {
            profileByPhone.set(normalizedPhone, profile);
        }
        if (normalizedName) {
            profileByName.set(normalizedName, profile);
        }
    }

    const registrations = [];
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
        let matchedProfile = null;
        if (phone) {
            matchedProfile = profileByPhone.get(phone) || null;
        }
        if (!matchedProfile && name) {
            matchedProfile = profileByName.get(name) || null;
        }

        if (!matchedProfile || !matchedProfile.chatId) {
            continue;
        }

        registrations.push({
            registrationDate,
            profile: matchedProfile
        });
    }

    return registrations;
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
    DEFAULT_HISTORY_PATH
};
