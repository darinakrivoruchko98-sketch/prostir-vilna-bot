const test = require('node:test');
const assert = require('node:assert/strict');
const { withCache, invalidateCache } = require('../src/sheets/cache');

test('withCache reuses value until ttl expires', async () => {
  let calls = 0;
  const key = 'test:sheet';
  const value = await withCache(key, 1000, async () => {
    calls += 1;
    return { ok: true };
  });

  const cachedValue = await withCache(key, 1000, async () => {
    calls += 1;
    return { ok: false };
  });

  assert.deepEqual(value, { ok: true });
  assert.deepEqual(cachedValue, { ok: true });
  assert.equal(calls, 1);

  invalidateCache(key);
});
