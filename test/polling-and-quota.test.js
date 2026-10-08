const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing: ${end}`);
  return source.slice(from, to);
}

test('there is exactly one Telegram bot, using webhook instead of polling', () => {
  assert.equal((source.match(/new TelegramBot\(/g) || []).length, 1);
  assert.match(source, /new TelegramBot\(TOKEN, \{ polling: false \}\)/);
  assert.doesNotMatch(source, /\.startPolling\(|\.stopPolling\(|deleteWebHook\(|polling_error/);
  assert.match(source, /app\.post\(WEBHOOK_PATH, createWebhookHandler\(bot, process\.env\.WEBHOOK_SECRET\)\)/);
  assert.match(source, /app\.listen\([\s\S]*?registerWebhook\(bot/);
  assert.doesNotMatch(source, /\.launch\(/);
});

test('manual note sync has no separate 15s timer and runs from loadEventsFromSheet with a forced refresh only on heavy (changed or 60s) cycles', () => {
  assert.doesNotMatch(source, /syncManualRegistrationsFromScheduleNotes\(\)\.catch/);
  assert.doesNotMatch(source, /}, 15 \* 1000\)/);
  const loader = between('async function loadEventsFromSheet() {', '/* ===== SAVE TO SHEET ===== */');
  assert.match(loader, /syncManualRegistrationsFromScheduleNotes\(\{ forceRefresh: heavySyncDue \}\)/);
});

test('schedule note index is cached instead of re-read on every call', () => {
  const fn = between('async function buildScheduleEventNoteIndex(forceRefresh = false) {', 'async function buildScheduleEventNoteIndexUncached()');
  assert.match(fn, /withCache\('schedule-note-index'/);
});

test('reserve promotion in the refresh loop is skipped for events without reserve but kept otherwise', () => {
  const loader = between('async function loadEventsFromSheet() {', '/* ===== SAVE TO SHEET ===== */');
  assert.match(loader, /if \(!\(Number\(event\.reserveCount\) > 0\)\) continue;[\s\S]*?promoteReserveRegistrantsForAvailableSeats\(event, availableSeats\)/);
});

test('10s refresh is cheap: overlap guard, heavy note reads throttled to 60s, promotion retry throttled', () => {
  assert.match(source, /const SCHEDULE_HEAVY_SYNC_INTERVAL_MS = 60 \* 1000;/);
  const loader = between('let loadEventsInProgress = false;', '/* ===== SAVE TO SHEET ===== */');
  assert.match(loader, /if \(loadEventsInProgress\) return;/);
  assert.match(loader, /if \(heavySyncDue\) \{\s*await reconcileScheduleNotesWithEvents\(events\);/);
  assert.match(loader, /reservePromotionAttempts/);
  assert.match(loader, /promoteReserveRegistrantsForAvailableSeats\(event, availableSeats\)/);
  assert.doesNotMatch(source, /}, 15 \* 1000\)/);
});

test('manual note registration falls back to the note userId only when the phone is absent', () => {
  const sync = between('async function syncManualRegistrationsFromScheduleNotes(', 'async function notifyRegistrantAboutRegistration(');
  assert.match(sync, /if \(phoneKey\) \{\s*recipientChatId = await resolveChatIdByPhone/);
  assert.match(sync, /else if \(Number\.isInteger\(noteUserId\) && noteUserId > 0\)/);
});
