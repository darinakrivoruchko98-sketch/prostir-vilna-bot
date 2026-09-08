function normalizeText(text) {
    if (!text) return '';
    return String(text)
        .replace(/[\u2019\u2018\u02BC\u0060]/g, "'")
        .replace(/\u00A0/g, ' ')
        .trim();
}

function normalizeCommandText(text) {
    return normalizeText(String(text || ''))
        .replace(/[^\p{L}\p{N}\s']/gu, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const WEEKDAY_INDEX_BY_NAME = {
    'неділя': 0,
    'понеділок': 1,
    'вівторок': 2,
    'середа': 3,
    'четвер': 4,
    "п'ятниця": 5,
    'субота': 6
};

function normalizeWeekdayKey(value) {
    const source = normalizeCommandText(String(value || ''));
    if (!source) {
        return '';
    }

    const aliases = {
        'пн': "понеділок",
        'пон': "понеділок",
        'вів': 'вівторок',
        'вт': 'вівторок',
        'втр': 'вівторок',
        'ср': 'середа',
        'серед': 'середа',
        'срд': 'середа',
        'чет': 'четвер',
        'чт': 'четвер',
        'чтв': 'четвер',
        'пт': "п'ятниця",
        'птн': "п'ятниця",
        'пят': "п'ятниця",
        'сб': 'субота',
        'суб': 'субота',
        'сбт': 'субота',
        'нд': 'неділя',
        'нед': 'неділя',
        "п'ятниця": "п'ятниця",
        'пятниця': "п'ятниця",
        'пятницю': "п'ятниця",
        "п'ятницю": "п'ятниця"
    };

    return aliases[source] || source;
}

function parseAfishaDaySelection(value) {
    const source = normalizeText(String(value || '')).trim();
    if (!source) {
        return null;
    }

    const withoutDate = source.replace(/\(\s*\d{2}[./-]\d{2}[./-]\d{4}\s*\)/g, ' ').trim();
    const direct = normalizeWeekdayKey(withoutDate);
    if (WEEKDAY_INDEX_BY_NAME[direct] !== undefined) {
        return {
            weekdayKey: direct,
            dayNum: WEEKDAY_INDEX_BY_NAME[direct]
        };
    }

    const tokens = withoutDate
        .split(/\s+/)
        .map((token) => token.replace(/[()]/g, ''))
        .filter(Boolean);

    for (const token of tokens) {
        const normalizedToken = normalizeWeekdayKey(token);
        if (WEEKDAY_INDEX_BY_NAME[normalizedToken] !== undefined) {
            return {
                weekdayKey: normalizedToken,
                dayNum: WEEKDAY_INDEX_BY_NAME[normalizedToken]
            };
        }
    }

    return null;
}

module.exports = {
    normalizeText,
    normalizeCommandText,
    normalizeWeekdayKey,
    parseAfishaDaySelection
};
