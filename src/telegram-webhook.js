const crypto = require('node:crypto');

const WEBHOOK_PATH = '/telegram/webhook';
// Тільки ті типи оновлень, на які є handlers: bot.on('message') та bot.on('callback_query').
const ALLOWED_UPDATES = ['message', 'callback_query'];

function secretsMatch(received, expected) {
    const a = crypto.createHash('sha256').update(String(received || '')).digest();
    const b = crypto.createHash('sha256').update(String(expected || '')).digest();
    return crypto.timingSafeEqual(a, b);
}

function createWebhookHandler(bot, secret) {
    return (req, res) => {
        const received = req.get('X-Telegram-Bot-Api-Secret-Token');
        if (!secret || !received || !secretsMatch(received, secret)) {
            return res.sendStatus(401);
        }
        try {
            bot.processUpdate(req.body);
        } catch (error) {
            console.error('❌ processUpdate (webhook) помилка:', error && error.message ? error.message : error);
        }
        return res.sendStatus(200);
    };
}

async function registerWebhook(bot, { url, secret }) {
    if (!url || !secret) {
        throw new Error('WEBHOOK_URL і WEBHOOK_SECRET обовʼязкові для webhook-режиму');
    }
    const fullUrl = `${String(url).replace(/\/+$/, '')}${WEBHOOK_PATH}`;
    await bot.setWebHook(fullUrl, { secret_token: secret, allowed_updates: ALLOWED_UPDATES });
    return fullUrl;
}

module.exports = { WEBHOOK_PATH, ALLOWED_UPDATES, createWebhookHandler, registerWebhook };
