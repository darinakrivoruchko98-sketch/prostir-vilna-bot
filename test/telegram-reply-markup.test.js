const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSendOptions } = require('../src/utils/telegram-reply-markup');

test('normalizeSendOptions adds remove_keyboard for plain messages', () => {
    const result = normalizeSendOptions();
    assert.deepEqual(result.reply_markup, { remove_keyboard: true });
});

test('normalizeSendOptions preserves explicit keyboard markup', () => {
    const input = { reply_markup: { keyboard: [[{ text: 'Test' }]] } };
    const result = normalizeSendOptions(input);
    assert.deepEqual(result.reply_markup, input.reply_markup);
});

test('normalizeSendOptions lays out reply keyboard buttons in two columns', () => {
    const input = {
        reply_markup: {
            keyboard: [
                [{ text: 'Дата 1' }],
                [{ text: 'Дата 2' }],
                [{ text: 'Дата 3' }],
                [{ text: 'Повернутися в меню' }]
            ],
            resize_keyboard: true
        }
    };

    const result = normalizeSendOptions(input);

    assert.deepEqual(result.reply_markup.keyboard, [
        [{ text: 'Дата 1' }, { text: 'Дата 2' }],
        [{ text: 'Дата 3' }, { text: 'Повернутися в меню' }]
    ]);
    assert.equal(result.reply_markup.resize_keyboard, true);
});

test('normalizeSendOptions preserves a single-button reply keyboard', () => {
    const input = { reply_markup: { keyboard: [[{ text: 'Назад' }]] } };
    const result = normalizeSendOptions(input);
    assert.deepEqual(result.reply_markup, input.reply_markup);
});

test('normalizeSendOptions preserves force_reply markup', () => {
    const input = { reply_markup: { force_reply: true } };
    const result = normalizeSendOptions(input);
    assert.deepEqual(result.reply_markup, input.reply_markup);
});
