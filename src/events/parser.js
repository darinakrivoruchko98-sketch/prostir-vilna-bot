const { parseDateValue, normalizeTimeValue, formatSheetDate, formatSheetTime, parseEventDate, monthsUa } = require('../utils/date');
const { normalizeTitle } = require('../utils/text');

function parseEventFromRow(row, currentDateContext) {
    if (!row || row.length === 0) {
        return { event: null, nextDateContext: currentDateContext };
    }

    const cells = row.map((cell) => String(cell || '').trim());
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 0) {
        return { event: null, nextDateContext: currentDateContext };
    }

    const yearHint = currentDateContext ? currentDateContext.getFullYear() : new Date().getFullYear();
    const dateIndex = cells.findIndex((cell) => parseDateValue(cell, yearHint));
    const timeIndex = cells.findIndex((cell) => normalizeTimeValue(cell));

    if (nonEmpty.length === 1 && dateIndex >= 0 && timeIndex === -1) {
        return {
            event: null,
            nextDateContext: parseDateValue(cells[dateIndex], yearHint) || currentDateContext
        };
    }

    const dateBase = dateIndex >= 0
        ? parseDateValue(cells[dateIndex], yearHint)
        : currentDateContext;

    let time = timeIndex >= 0 ? normalizeTimeValue(cells[timeIndex]) : null;
    let title = cells[2] ? String(cells[2]).trim() : '';
    let seats = parseInt(cells[3], 10);
    let registrations = parseInt(cells[4], 10);

    if (!time) {
        const line = nonEmpty.join(' ');
        const lineTime = line.match(/(\d{1,2})[:.](\d{2})/);
        if (lineTime) {
            time = normalizeTimeValue(`${lineTime[1]}:${lineTime[2]}`);
        }

        if (!title) {
            const pieces = line.split(/\s*[–-]\s*/).map((v) => v.trim()).filter(Boolean);
            if (pieces.length >= 2) {
                const start = pieces[0].match(/\d{1,2}[:.]\d{2}/) ? 1 : 0;
                title = pieces.slice(start, pieces.length - 1).join(' – ').trim() || pieces[start] || '';
                const seatFromTail = pieces[pieces.length - 1].match(/\d+/);
                if (seatFromTail) seats = parseInt(seatFromTail[0], 10);
            }
        }
    }

    if (!title) {
        title = cells.find((cell, idx) => {
            if (!cell) return false;
            if (idx === dateIndex || idx === timeIndex) return false;
            if (/^\d+$/.test(cell)) return false;
            if (parseDateValue(cell, yearHint)) return false;
            if (normalizeTimeValue(cell)) return false;
            return true;
        }) || '';
    }

    if (!Number.isFinite(seats)) {
        const seatCell = cells.find((cell, idx) => idx !== dateIndex && idx !== timeIndex && /\d+/.test(cell));
        seats = seatCell ? parseInt((seatCell.match(/\d+/) || [0])[0], 10) : 0;
    }

    if (!Number.isFinite(registrations)) {
        registrations = 0;
    }

    if (!dateBase || !time || !title) {
        // ДІАГНОСТИКА для неповних даних
        if (nonEmpty.length >= 2) {
            console.log(`⚠️ Неповні дані в рядку: cells=[${cells.join('|')}]`);
            console.log(`   dateIndex=${dateIndex}, dateBase=${dateBase}, time=${time}, title="${title}"`);
        }
        return { event: null, nextDateContext: dateBase || currentDateContext };
    }

    const eventDate = new Date(Date.UTC(
        dateBase.getUTCFullYear(),
        dateBase.getUTCMonth(),
        dateBase.getUTCDate(),
        time.hour,
        time.minute,
        0,
        0
    ));

    if (Number.isNaN(eventDate.getTime())) {
        return { event: null, nextDateContext: dateBase || currentDateContext };
    }

    return {
        event: {
            id: `${title.replace(/\s+/g,'_')}_${formatSheetDate(eventDate)}_${formatSheetTime(eventDate)}`,
            name: title,
            date: eventDate,
            seats: Number.isFinite(seats) ? seats : 0,
            registrations: Number.isFinite(registrations) ? registrations : 0
        },
        nextDateContext: dateBase
    };
}

function parseEventSelectionFromButtonText(buttonText) {
    const parts = String(buttonText || '').split('|').map((part) => part.trim());
    if (parts.length < 3) return null;

    const rawName = parts[0] || '';
    const eventName = rawName.replace(/^☐\s*/, '').trim();
    const datePart = parts[1] || '';
    const timePart = parts[2] || '';

    if (!eventName) return null;

    const dateMatch = datePart.match(/^(\d{1,2})\s+([А-Яа-яІіЇїЄєґҐ'']+)$/);
    const parsedTime = normalizeTimeValue(timePart);
    if (!dateMatch || !parsedTime) return null;

    const day = parseInt(dateMatch[1], 10);
    const monthName = dateMatch[2].toLowerCase();
    const month = monthsUa[monthName];
    if (!Number.isFinite(day) || month === undefined) return null;

    return {
        eventName,
        day,
        month,
        hour: parsedTime.hour,
        minute: parsedTime.minute
    };
}

function findEventByButtonText(buttonText, candidateEvents) {
    const parsedSelection = parseEventSelectionFromButtonText(buttonText);
    if (!parsedSelection) return null;

    return candidateEvents.find((eventItem) => (
        normalizeTitle(eventItem.name) === normalizeTitle(parsedSelection.eventName) &&
        eventItem.date.getDate() === parsedSelection.day &&
        eventItem.date.getMonth() === parsedSelection.month &&
        eventItem.date.getHours() === parsedSelection.hour &&
        eventItem.date.getMinutes() === parsedSelection.minute
    )) || null;
}

module.exports = {
    parseEventFromRow,
    parseEventSelectionFromButtonText,
    findEventByButtonText,
};
