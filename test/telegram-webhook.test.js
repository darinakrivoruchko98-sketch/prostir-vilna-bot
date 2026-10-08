const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebhookHandler, registerWebhook, ALLOWED_UPDATES } = require('../src/telegram-webhook');

function run(secretHeader, secret = 's3cret') {
  const updates = [];
  const bot = { processUpdate: (u) => updates.push(u) };
  const req = { body: { update_id: 1 }, get: (n) => (n.toLowerCase() === 'x-telegram-bot-api-secret-token' ? secretHeader : undefined) };
  let status;
  createWebhookHandler(bot, secret)(req, { sendStatus: (c) => { status = c; } });
  return { status, updates };
}

test('correct secret -> 200 and processUpdate called', () => {
  const { status, updates } = run('s3cret');
  assert.equal(status, 200);
  assert.deepEqual(updates, [{ update_id: 1 }]);
});

test('wrong or missing secret -> 401 and processUpdate not called', () => {
  for (const h of ['bad', undefined, '']) {
    const { status, updates } = run(h);
    assert.equal(status, 401);
    assert.equal(updates.length, 0);
  }
  assert.equal(run('x', '').status, 401);
});

test('registerWebhook sets URL, secret_token and allowed_updates', async () => {
  let call;
  const bot = { setWebHook: async (...a) => { call = a; } };
  const url = await registerWebhook(bot, { url: 'https://x.onrender.com/', secret: 'abc' });
  assert.equal(url, 'https://x.onrender.com/telegram/webhook');
  assert.deepEqual(call, [url, { secret_token: 'abc', allowed_updates: ALLOWED_UPDATES }]);
  assert.deepEqual(ALLOWED_UPDATES, ['message', 'callback_query']);
  await assert.rejects(registerWebhook(bot, { url: '', secret: 'abc' }));
});
