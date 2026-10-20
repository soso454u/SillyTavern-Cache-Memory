export const RETRY_DELAYS = Object.freeze([2000, 5000, 10000]);

export function isRetryableError(error) {
    if (['REQUEST_ABORTED', 'CHAT_CHANGED', 'SOURCE_CHANGED', 'SAVE_UNCONFIRMED', 'ST_PROXY_ROUTE_MISSING'].includes(error?.code)) return false;
    if (['authentication_error', 'permission_error', 'endpoint_error'].includes(error?.category)) return false;
    const status = Number(error?.status) || Number(String(error?.diagnostics?.upstream ?? '').match(/HTTP (\d+)/)?.[1])
        || Number(String(error?.diagnostics?.proxy ?? '').match(/HTTP (\d+)/)?.[1]);
    if (status && status !== 200) return [408, 429, 500, 502, 503, 504].includes(status);
    return ['REQUEST_TIMEOUT', 'CONNECTION_CLOSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)
        || error?.category === 'network_error'
        || /\b(?:408|429|500|502|503|504)\b|gateway[ -]time.?out|timed out|请求超时|rate.?limit|too many requests|failed to fetch|fetch failed|load failed|network|socket|网络|断网/i.test(error?.message ?? '');
}

export function waitForRetry(ms, signal) {
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(Object.assign(new Error('重试已取消'), { code: 'REQUEST_ABORTED' })); };
        let timer;
        if (signal?.aborted) return cancel();
        timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

// Three retries AFTER the original attempt. Callers own their context guards.
export async function retryOperation(operation, { signal, assertActive = () => {}, delay = waitForRetry,
    retryable = isRetryableError, onRetry = () => {} } = {}) {
    for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw Object.assign(new Error('重试已取消'), { code: 'REQUEST_ABORTED' });
        assertActive();
        try { return await operation(); }
        catch (error) {
            if (signal?.aborted) throw Object.assign(new Error('重试已取消'), { code: 'REQUEST_ABORTED' });
            assertActive();
            if (attempt >= RETRY_DELAYS.length || !retryable(error)) throw error;
            onRetry({ attempt: attempt + 1, maxRetries: RETRY_DELAYS.length, waitMs: RETRY_DELAYS[attempt], error });
            await delay(RETRY_DELAYS[attempt], signal);
        }
    }
}
