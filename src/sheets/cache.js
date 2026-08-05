const cacheStore = new Map();

function getCacheKey(scope, key) {
    return `${scope}:${key}`;
}

function getCachedValue(scope, key) {
    const fullKey = getCacheKey(scope, key);
    const entry = cacheStore.get(fullKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cacheStore.delete(fullKey);
        return null;
    }
    return entry.value;
}

function setCachedValue(scope, key, value, ttlMs) {
    const fullKey = getCacheKey(scope, key);
    cacheStore.set(fullKey, {
        value,
        expiresAt: Date.now() + ttlMs,
    });
}

function invalidateCache(scope, key) {
    if (key === undefined) {
        for (const cacheKey of [...cacheStore.keys()]) {
            if (cacheKey.startsWith(`${scope}:`)) {
                cacheStore.delete(cacheKey);
            }
        }
        return;
    }

    cacheStore.delete(getCacheKey(scope, key));
}

async function withCache(scope, key, ttlMs, factory) {
    let cacheScope = scope;
    let cacheKey = key;
    let ttl = ttlMs;
    let loader = factory;

    if (typeof key === 'number' && typeof ttlMs === 'function' && factory === undefined) {
        cacheScope = 'default';
        cacheKey = scope;
        ttl = key;
        loader = ttlMs;
    }

    if (typeof loader !== 'function') {
        throw new TypeError('factory must be a function');
    }

    const cached = getCachedValue(cacheScope, cacheKey);
    if (cached !== null) {
        return cached;
    }

    const freshValue = await loader();
    setCachedValue(cacheScope, cacheKey, freshValue, ttl);
    return freshValue;
}

function getCacheStats() {
    return {
        size: cacheStore.size,
        keys: [...cacheStore.keys()],
    };
}

module.exports = {
    withCache,
    invalidateCache,
    getCacheStats,
    getCachedValue,
    setCachedValue,
};
