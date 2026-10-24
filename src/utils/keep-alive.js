const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

let activeTimer = null;

function startSelfKeepAlive({ baseUrl, intervalMs = DEFAULT_INTERVAL_MS, fetchImpl = globalThis.fetch, logger = console } = {}) {
    const root = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!root || typeof fetchImpl !== 'function') {
        logger.log('ℹ️ keep-alive вимкнено: не задано KEEP_ALIVE_URL / RENDER_EXTERNAL_URL / WEBHOOK_URL');
        return null;
    }

    if (activeTimer) {
        return activeTimer;
    }

    const url = `${root}/health`;
    logger.log(`ℹ️ keep-alive увімкнено: ${url} кожні ${Math.round(intervalMs / 1000)} с`);
    const timer = setInterval(() => {
        Promise.resolve(fetchImpl(url, { signal: AbortSignal.timeout(15000) })).then((response) => {
            if (response && response.ok === false) {
                logger.warn(`⚠️ keep-alive ping: HTTP ${response.status}`);
            } else {
                logger.log(`💓 keep-alive ping ok: ${url}`);
            }
        }).catch((error) => {
            logger.warn('⚠️ keep-alive ping failed:', error && error.message ? error.message : error);
        });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    activeTimer = timer;
    return timer;
}

function stopSelfKeepAlive() {
    if (activeTimer) clearInterval(activeTimer);
    activeTimer = null;
}

module.exports = { stopSelfKeepAlive, startSelfKeepAlive, DEFAULT_INTERVAL_MS };
