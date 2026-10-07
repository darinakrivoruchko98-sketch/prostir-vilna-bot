const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRecentKeyTracker } = require('../src/utils/update-dedupe');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractFunction(name) {
    const start = serverSource.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const next = serverSource.indexOf('\nasync function ', start + 10);
    const nextPlain = serverSource.indexOf('\nfunction ', start + 10);
    const ends = [next, nextPlain].filter((i) => i > 0);
    return serverSource.slice(start, Math.min(...ends));
}

test('successful registration consumes selectedEventsList and resets the selection flow', () => {
    const complete = extractFunction('completeSelectedEventsRegistration');
    assert.match(complete, /if \(!hadError\) \{\s*resetSelectedEventsFlow\(user\);/);
    assert.doesNotMatch(complete, /user\.selectedEventsList = \[\];/);
    const reset = serverSource.slice(serverSource.indexOf('function resetSelectedEventsFlow('), serverSource.indexOf('async function completeSelectedEventsRegistration('));
    for (const field of ['selectedEventsList', 'selectedEventId', 'afishaMultiRegistration', 'currentSelectedEventId']) {
        assert.match(reset, new RegExp(`delete user\\.${field};`));
    }
});

test('repeated callback_query.id is ignored and cannot register another event', () => {
    const tracker = createRecentKeyTracker();
    assert.equal(tracker.seenBefore('cb-1'), false);
    assert.equal(tracker.seenBefore('cb-1'), true);
    assert.equal(tracker.seenBefore('cb-2'), false);
    assert.match(serverSource, /processedCallbackQueries\.seenBefore\(callbackQuery\.id\)/);

    const wrapper = extractFunction('registerForSelectedEvent');
    assert.match(wrapper, /registrationActionId/);
    assert.match(wrapper, /user\.selectedEventId !== eventId/);
    assert.match(wrapper, /status: 'failed'/);
});

test('one update_id cannot run registration twice', () => {
    const tracker = createRecentKeyTracker(3);
    assert.equal(tracker.seenBefore(100), false);
    assert.equal(tracker.seenBefore(100), true);
    assert.equal(tracker.seenBefore(undefined), false);
    assert.equal(tracker.seenBefore(undefined), false);
    // Старі ключі витісняються лише після перевищення ліміту.
    tracker.seenBefore(101); tracker.seenBefore(102); tracker.seenBefore(103);
    assert.equal(tracker.seenBefore(100), false);
    assert.match(serverSource, /bot\.processUpdate = function \(update\)[\s\S]*processedUpdates\.seenBefore\(update\.update_id\)/);

    const complete = extractFunction('completeSelectedEventsRegistration');
    assert.ok(complete.indexOf('user.registrationAction') < complete.indexOf('await registerForSelectedEvent('));
});

test('failed registration keeps selectedEventsList; only error-free completion clears it', () => {
    const complete = extractFunction('completeSelectedEventsRegistration');
    const errorBranch = complete.slice(complete.indexOf('} else {\n            hadError = true;'));
    assert.match(errorBranch, /hadError = true;/);
    const resetIdx = complete.indexOf('resetSelectedEventsFlow(user);');
    assert.ok(resetIdx > complete.indexOf('if (!hadError)'));
    assert.equal(complete.split('resetSelectedEventsFlow(user)').length - 1, 1);
});

test('stale selectedEventId without a current registration action cannot register', () => {
    const complete = extractFunction('completeSelectedEventsRegistration');
    assert.match(complete, /if \(!action \|\| !action\.id\)[\s\S]*return \{ successEvents: \[\]/);
    const wrapper = extractFunction('registerForSelectedEvent');
    assert.match(wrapper, /!action \|\| !options\.registrationActionId/);
    assert.match(wrapper, /action\.id !== options\.registrationActionId/);
    const start = extractFunction('startSelectedEventsRegistration');
    assert.match(start, /user\.registrationAction = \{/);
    const reset = serverSource.slice(serverSource.indexOf('function resetSelectedEventsFlow('), serverSource.indexOf('async function completeSelectedEventsRegistration('));
    assert.match(reset, /delete user\.registrationAction;/);
});
