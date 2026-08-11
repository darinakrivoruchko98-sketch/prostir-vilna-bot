const test = require('node:test');
const assert = require('node:assert/strict');
const { getAdminIds, isAdminUserId } = require('../src/utils/admin-access');

test('getAdminIds normalizes and deduplicates admin IDs', () => {
    assert.deepEqual(getAdminIds([375328037, '375328037', '999', '', 'abc']), [375328037, 999]);
});

test('isAdminUserId only allows configured admin IDs', () => {
    assert.equal(isAdminUserId(375328037, [375328037, 999]), true);
    assert.equal(isAdminUserId('999', [375328037, 999]), true);
    assert.equal(isAdminUserId(123, [375328037, 999]), false);
    assert.equal(isAdminUserId(null, [375328037, 999]), false);
    assert.equal(isAdminUserId(undefined, [375328037, 999]), false);
});
