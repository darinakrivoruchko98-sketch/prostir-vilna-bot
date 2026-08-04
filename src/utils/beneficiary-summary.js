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

function parseRegistrantsFromNoteText(noteText) {
    if (!noteText) return [];

    const lines = String(noteText)
        .split(/\r?\n/)
        .map((line) => String(line || '').trim())
        .filter(Boolean);

    const registrants = [];
    const seen = new Set();

    let inRegisteredSection = false;
    let sawRegisteredHeader = false;

    for (const rawLine of lines) {
        const line = rawLine.replace(/^[-*•]\s*/, '').trim();
        if (!line) continue;

        if (/^зареєстровано\s*:/i.test(line)) {
            inRegisteredSection = true;
            sawRegisteredHeader = true;
            continue;
        }

        if (/^резерв\s*:/i.test(line)) {
            inRegisteredSection = false;
            continue;
        }

        if (!sawRegisteredHeader && !inRegisteredSection) {
            inRegisteredSection = true;
        }

        if (!inRegisteredSection) {
            continue;
        }

        if (/^список\s+порожній$/i.test(line)
            || /^EVENT_ID\s*:/i.test(line)
            || /^\d+[.)-]?\s*EVENT_ID\s*:/i.test(line)) {
            continue;
        }

        let name = '';
        let phone = '';
        let identifier = '';

        const cleanedLine = line.replace(/^\d+[.)-]?\s*/, '').trim();

        const structuredMatch = cleanedLine.match(/^(.*?)\s*(?:\||[—-])\s*(.+)$/);
        if (structuredMatch) {
            name = String(structuredMatch[1] || '').trim();
            const candidate = String(structuredMatch[2] || '').trim();
            const normalizedCandidate = candidate.replace(/\D/g, '');
            const isPhoneCandidate = /^\+?\d[\d\s()\-]{6,}$/.test(candidate);
            if (isPhoneCandidate) {
                phone = candidate;
            } else if (/^\d+$/.test(candidate) && normalizedCandidate.length >= 5) {
                identifier = normalizedCandidate;
            } else if (normalizedCandidate.length >= 5) {
                identifier = normalizedCandidate;
            } else {
                phone = candidate;
            }
        } else {
            const trimmed = String(cleanedLine).trim();
            if (/^\d+$/.test(trimmed) && trimmed.length >= 5) {
                identifier = trimmed;
            } else {
                const phoneMatch = cleanedLine.match(/(\+?\d[\d\s()\-]{6,})$/);
                if (phoneMatch) {
                    phone = String(phoneMatch[1] || '').trim();
                    name = cleanedLine.slice(0, cleanedLine.length - phone.length).replace(/[,:;\-\s]+$/, '').trim();
                } else {
                    const bulletName = cleanedLine.trim();
                    if (bulletName) {
                        name = bulletName;
                    }
                }
            }
        }

        if (!name && !phone && !identifier) continue;

        const key = `${normalizeName(name)}|${String(phone).replace(/\D/g, '')}|${identifier}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        if (identifier) {
            registrants.push({ name, phone, identifier });
        } else {
            registrants.push({ name, phone });
        }
    }

    return registrants;
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
    parseRegistrantsFromNoteText,
    getAgeFromBirthDate,
    categorizeStatus,
    hasHealthIssue,
    parseBirthToYear
};
