function normalizeText(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizeName(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

function parseBirthToYear(value) {
    if (!value) return null;

    const raw = String(value).trim();
    const patterns = [
        /(\d{4})[\-/.](\d{1,2})[\-/.](\d{1,2})/,
        /(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{4})/,
        /(\d{4})/
    ];

    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (!match) continue;

        if (pattern === patterns[2]) {
            const year = Number.parseInt(match[1], 10);
            if (Number.isFinite(year) && year >= 1900 && year <= 2100) {
                return year;
            }
            continue;
        }

        const year = Number.parseInt(match[1] || match[3], 10);
        if (Number.isFinite(year) && year >= 1900 && year <= 2100) {
            return year;
        }
    }

    return null;
}

function getAgeFromBirthDate(birthText, referenceDate = new Date()) {
    const year = parseBirthToYear(birthText);
    if (!year) return null;

    const reference = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (Number.isNaN(reference.getTime())) {
        return null;
    }

    const currentYear = reference.getFullYear();
    const currentMonth = reference.getMonth() + 1;
    const currentDay = reference.getDate();

    let age = currentYear - year;
    const birthMonth = 0;
    const birthDay = 0;

    if (currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)) {
        age -= 1;
    }

    return Number.isFinite(age) ? age : null;
}

function categorizeStatus(statusText) {
    const value = normalizeText(statusText);

    if (value === 'впо') return 'vpo';
    if (value === 'не впо, що постраждали від війни') return 'non-vpo-damaged';
    if (value === 'не впо, що не постраждали від війни') return 'non-vpo-safe';
    return 'other';
}

function hasHealthIssue(healthText) {
    const value = normalizeText(healthText || '');
    return value.includes('інвалідність') || value.includes('істотні проблеми') || value.includes('проблеми зі здоров') || value.includes('проблеми со здоров') || value.includes('проблеми');
}

function buildBeneficiarySummary(records, referenceDate = new Date()) {
    const uniqueRecords = [];
    const seen = new Set();

    for (const record of records || []) {
        const name = normalizeName(record && record.name ? record.name : '');
        const phone = String(record && record.phone ? record.phone : '').replace(/\D/g, '');
        const key = `${name}|${phone}`.toLowerCase();
        if (!name && !phone) continue;
        if (seen.has(key)) continue;
        seen.add(key);

        const age = getAgeFromBirthDate(record && record.birth ? record.birth : '', referenceDate);
        const statusBucket = categorizeStatus(record && record.status ? record.status : '');
        const healthIssue = hasHealthIssue(record && record.health ? record.health : '');

        let ageBucket = 'unknown';
        if (Number.isFinite(age)) {
            if (age < 18) ageBucket = 'under18';
            else if (age < 60) ageBucket = '18to59';
            else ageBucket = '60plus';
        }

        uniqueRecords.push({
            name,
            phone,
            birth: record && record.birth ? String(record.birth) : '',
            status: record && record.status ? String(record.status) : '',
            health: record && record.health ? String(record.health) : '',
            age,
            ageBucket,
            statusBucket,
            healthIssue
        });
    }

    const counts = {
        total: uniqueRecords.length,
        vpo: 0,
        nonVpoDamaged: 0,
        nonVpoSafe: 0,
        under18: 0,
        age18to59: 0,
        age60plus: 0,
        healthIssues: 0
    };

    for (const item of uniqueRecords) {
        if (item.statusBucket === 'vpo') counts.vpo += 1;
        else if (item.statusBucket === 'non-vpo-damaged') counts.nonVpoDamaged += 1;
        else if (item.statusBucket === 'non-vpo-safe') counts.nonVpoSafe += 1;

        if (item.ageBucket === 'under18') counts.under18 += 1;
        else if (item.ageBucket === '18to59') counts.age18to59 += 1;
        else if (item.ageBucket === '60plus') counts.age60plus += 1;

        if (item.healthIssue) counts.healthIssues += 1;
    }

    return {
        counts,
        items: uniqueRecords
    };
}

module.exports = {
    buildBeneficiarySummary,
    getAgeFromBirthDate,
    categorizeStatus,
    hasHealthIssue,
    parseBirthToYear
};
