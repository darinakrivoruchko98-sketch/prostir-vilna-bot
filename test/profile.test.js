const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCompleteRegistrationProfile } = require('../src/utils/profile');

test('treats a full profile as complete', () => {
  const profile = {
    name: 'Іванова Марія',
    phone: '380501234567',
    birth: '2000',
    status: 'ВПО',
    childrenCount: '2',
    health: 'Ні',
    evacuationStatus: 'Нічого з зазначеного',
    shellingImpact: 'Ні',
    employment: 'Працюю',
    beneficiaryCategory: 'Нічого із вищезазначеного',
    gzn: 'Так'
  };

  assert.equal(hasCompleteRegistrationProfile(profile), true);
});

test('treats a missing profile field as incomplete', () => {
  const profile = {
    name: 'Іванова Марія',
    phone: '380501234567',
    birth: '2000',
    status: 'ВПО',
    childrenCount: '2',
    health: 'Ні',
    evacuationStatus: 'Нічого з зазначеного',
    shellingImpact: 'Ні',
    employment: 'Працюю',
    beneficiaryCategory: 'Нічого із вищезазначеного',
    gzn: ''
  };

  assert.equal(hasCompleteRegistrationProfile(profile), false);
});
