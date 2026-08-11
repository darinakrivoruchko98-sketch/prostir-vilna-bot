const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeRegistrationStatus,
    calculateAgeAtDate,
    isSpecialNeeds,
    buildStatisticsSnapshotForPeriod,
    getStatisticsSelectionButtons,
    resolveStatisticsSelectionFromText
} = require('../src/utils/statistics');

test('normalizeRegistrationStatus maps common values to canonical categories', () => {
    assert.equal(normalizeRegistrationStatus('ВПО'), 'ВПО');
    assert.equal(normalizeRegistrationStatus(' ВПО '), 'ВПО');
    assert.equal(normalizeRegistrationStatus('Не ВПО, що постраждали від війни'), 'Не ВПО, постраждали від війни');
    assert.equal(normalizeRegistrationStatus('Не ВПО, що не постраждали від війни'), 'Не ВПО, не постраждали від війни');
    assert.equal(normalizeRegistrationStatus('не впо, постраждали'), 'Не ВПО, постраждали від війни');
    assert.equal(normalizeRegistrationStatus('unknown value'), null);
});

test('calculateAgeAtDate works for different birth dates', () => {
    assert.equal(calculateAgeAtDate('2010-01-01', '2026-08-11'), 16);
    assert.equal(calculateAgeAtDate('1960-01-01', '2026-08-11'), 66);
});

test('isSpecialNeeds flags disability and significant health problems', () => {
    assert.equal(isSpecialNeeds('Інвалідність'), true);
    assert.equal(isSpecialNeeds('Ні, але є істотні проблеми зі здоров\'ям'), true);
    assert.equal(isSpecialNeeds('Ні, немає істотних проблем зі здоров\'ям'), false);
});

test('buildStatisticsSnapshotForPeriod deduplicates by chat id and aggregates categories', () => {
    const period = {
        type: 'week',
        startDate: '2026-08-10',
        endDate: '2026-08-16'
    };

    const registrations = [
        {
            registrationDate: '2026-08-12T10:00:00.000Z',
            profile: { birth: '2000-04-01', status: 'ВПО', health: 'Ні, немає істотних проблем зі здоров\'ям', evacuationStatus: 'Нічого', chatId: '1' }
        },
        {
            registrationDate: '2026-08-12T12:00:00.000Z',
            profile: { birth: '2010-06-01', status: 'Не ВПО, що постраждали від війни', health: 'Інвалідність', evacuationStatus: 'Нічого', chatId: '2' }
        },
        {
            registrationDate: '2026-08-13T09:00:00.000Z',
            profile: { birth: '1960-03-01', status: 'Не ВПО, що не постраждали від війни', health: 'Ні, але є істотні проблеми зі здоров\'ям', evacuationStatus: 'Нічого', chatId: '3' }
        },
        {
            registrationDate: '2026-08-13T09:30:00.000Z',
            profile: { birth: '2000-04-01', status: 'ВПО', health: 'Ні, немає істотних проблем зі здоров\'ям', evacuationStatus: 'Нічого', chatId: '1' }
        }
    ];

    const snapshot = buildStatisticsSnapshotForPeriod(period, registrations);

    assert.equal(snapshot.totalUniquePeople, 3);
    assert.equal(snapshot.status['ВПО'], 1);
    assert.equal(snapshot.status['Не ВПО, постраждали від війни'], 1);
    assert.equal(snapshot.status['Не ВПО, не постраждали від війни'], 1);
    assert.equal(snapshot.ageGroups['до 18 років'], 1);
    assert.equal(snapshot.ageGroups['18–59 років'], 1);
    assert.equal(snapshot.ageGroups['60+ років'], 1);
    assert.equal(snapshot.specialNeeds, 2);
});

test('buildStatisticsSnapshotForPeriod preserves event registration counts from the schedule data', () => {
    const period = {
        type: 'week',
        startDate: '2026-08-10',
        endDate: '2026-08-16'
    };

    const registrations = [
        {
            registrationDate: '2026-08-12T10:00:00.000Z',
            profile: { birth: '2000-04-01', status: 'ВПО', health: 'Ні, немає істотних проблем зі здоров\'ям', chatId: '10' },
            eventName: 'Майстерня',
            eventDate: '2026-08-12',
            scheduleRegistrationCount: 12
        },
        {
            registrationDate: '2026-08-13T10:00:00.000Z',
            profile: { birth: '2010-04-01', status: 'Не ВПО, що постраждали від війни', health: 'Інвалідність', chatId: '11' },
            eventName: 'Майстерня',
            eventDate: '2026-08-12',
            scheduleRegistrationCount: 12
        }
    ];

    const snapshot = buildStatisticsSnapshotForPeriod(period, registrations);

    assert.equal(snapshot.totalUniquePeople, 2);
    assert.equal(snapshot.eventRegistrationTotals['майстерня_2026-08-12'].registrationCount, 12);
    assert.equal(snapshot.eventRegistrationTotals['майстерня_2026-08-12'].source, 'schedule');
});

test('statistics selection helpers return the expected period options', () => {
    const buttons = getStatisticsSelectionButtons();
    assert.ok(buttons.some((button) => button.text === '📊 Поточний тиждень'));
    assert.ok(buttons.some((button) => button.text === '📅 Поточний місяць'));

    const resolved = resolveStatisticsSelectionFromText('📊 Попередній тиждень');
    assert.equal(resolved, 'previous-week');
});
