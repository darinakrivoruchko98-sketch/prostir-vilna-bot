const test = require('node:test');
const assert = require('node:assert/strict');
const { clearFeedbackFlowState } = require('../src/utils/feedback-state');

test('clearFeedbackFlowState resets daily feedback context and pending key', () => {
    const user = {
        context: 'daily-feedback-write',
        pendingFeedbackDateKey: '2024-01-01',
        otherField: 'keep-me'
    };

    const result = clearFeedbackFlowState(user);

    assert.equal(result.context, null);
    assert.equal(result.pendingFeedbackDateKey, undefined);
    assert.equal(result.otherField, 'keep-me');
});

test('clearFeedbackFlowState leaves non-feedback state unchanged', () => {
    const user = {
        context: 'menu',
        pendingFeedbackDateKey: '2024-01-01',
        step: 2
    };

    const result = clearFeedbackFlowState(user);

    assert.equal(result.context, 'menu');
    assert.equal(result.pendingFeedbackDateKey, undefined);
    assert.equal(result.step, 2);
});
