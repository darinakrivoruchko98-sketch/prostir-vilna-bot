const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startSelfKeepAlive, stopSelfKeepAlive } = require('../src/utils/keep-alive');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('feedback scheduler is not started inside initSheets', () => {
    const start = source.indexOf('async function initSheets()');
    const end = source.indexOf('function triggerDailyFeedbackCatchUp');
    assert.ok(start > 0 && end > start);
    assert.equal(source.slice(start, end).includes('checkAndSendDailyFeedbackRequests'), false);
    assert.match(source, /\nstartDailyFeedbackScheduler\(\);/);
});

test('self keep-alive pings /health and is disabled without url', async () => {
    assert.equal(startSelfKeepAlive({ baseUrl: '' }), null);
    const urls = [];
    const timer = startSelfKeepAlive({ baseUrl: 'https://x.onrender.com/', intervalMs: 5, fetchImpl: async (u) => { urls.push(u); } });
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(timer);
    assert.equal(urls[0], 'https://x.onrender.com/health');
    stopSelfKeepAlive();
});

test('self keep-alive does not start a second timer', () => {
    const a = startSelfKeepAlive({ baseUrl: 'https://x.onrender.com', intervalMs: 1000, fetchImpl: async () => {} });
    const b = startSelfKeepAlive({ baseUrl: 'https://x.onrender.com', intervalMs: 1000, fetchImpl: async () => {} });
    assert.equal(a, b);
    stopSelfKeepAlive();
});

test('feedback check is guarded against overlap, saved per send, Kyiv timezone default', () => {
    assert.match(source, /dailyFeedbackCheckInFlight/);
    assert.match(source, /if \(dailyFeedbackTimer\)/);
    assert.match(source, /APP_TIME_ZONE = process\.env\.APP_TIME_ZONE \|\| 'Europe\/Kyiv'/);
    const fn = source.slice(source.indexOf('async function runDailyFeedbackCheck'));
    assert.ok(fn.indexOf('saveReminderStateToDisk()') < fn.indexOf('catch (error)'));
});

test('/health triggers idempotent feedback catch-up', () => {
    const h = source.slice(source.indexOf("app.get('/health'"));
    assert.ok(h.slice(0, 400).includes('triggerDailyFeedbackCatchUp()'));
    assert.match(source, /if \(currentStatus\) \{\s*continue;/);
});

test('keep-alive logs success and failure', async () => {
    const logs = [];
    const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    const t = startSelfKeepAlive({ baseUrl: 'https://x.onrender.com', intervalMs: 5, logger, fetchImpl: async () => ({ ok: true }) });
    await new Promise((r) => setTimeout(r, 30));
    stopSelfKeepAlive();
    assert.ok(t && logs.some((m) => m.includes('ping ok')));
    startSelfKeepAlive({ baseUrl: 'https://x.onrender.com', intervalMs: 5, logger, fetchImpl: async () => { throw new Error('boom'); } });
    await new Promise((r) => setTimeout(r, 30));
    stopSelfKeepAlive();
    assert.ok(logs.some((m) => m.includes('failed')));
});
