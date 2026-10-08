import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ApiCacheAdapterBridge,
    describeApiConnection,
    normalizeApiCachePolicy,
    resolveApiCachePolicy,
} from '../src/api-cache-adapter.js';
import { transformRequest } from '../server-plugin/cache-memory-api-adapter/index.mjs';

function textOf(message) {
    return typeof message.content === 'string' ? message.content
        : message.content.filter(part => part?.type === 'text').map(part => part.text).join('');
}

test('server adapter adds independent cache blocks without changing or duplicating text', () => {
    const body = {
        chat_completion_source: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        messages: [
            { role: 'system', name: 'main', content: 'Fixed role settings' },
            { role: 'system', content: '[CACHE_MEMORY]\nFrozen checkpoint' },
            { role: 'user', content: 'old question' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'new question' },
            { role: 'assistant', content: '   ' },
        ],
    };
    const before = body.messages.map(textOf);
    const { body: output, preview } = transformRequest(body, {
        enabled: true, ttl: '1h', cacheStatic: true, cacheMemory: true, cacheHistory: true, historyDepth: 2,
    });
    assert.equal(preview.applied, true);
    assert.equal(preview.cachePoints.length, 3);
    assert.deepEqual(output.messages.map(textOf), before);
    assert.deepEqual(body.messages.map(message => message.content), [
        'Fixed role settings', '[CACHE_MEMORY]\nFrozen checkpoint', 'old question', 'old answer', 'new question', '   ',
    ]);
    assert.ok(preview.cachePoints.every(point => point.ttl === '1h' && point.sha256.length === 12));
    assert.equal(JSON.stringify(preview).includes('Frozen checkpoint'), false);
});

test('existing New API cache rewrite wins and prevents a second strategy', () => {
    const { body, preview } = transformRequest({
        chat_completion_source: 'custom', model: 'claude-proxy',
        custom_include_body: 'cache_control:\n  enabled: true',
        messages: [{ role: 'user', content: 'keep me' }],
    }, { enabled: true, compatibility: 'anthropic-blocks' });
    assert.equal(preview.applied, false);
    assert.equal(preview.conflict, true);
    assert.equal(body.messages[0].content, 'keep me');
});

test('auto capability detection safely bypasses unknown and native Claude sources', () => {
    const messages = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'hello' }];
    const custom = transformRequest({ chat_completion_source: 'custom', model: 'claude-proxy', messages }, { enabled: true });
    assert.equal(custom.preview.applied, false);
    assert.match(custom.preview.summary, /自动检测/);
    const native = transformRequest({ chat_completion_source: 'claude', model: 'claude-sonnet-4', messages }, { enabled: true });
    assert.equal(native.preview.applied, false);
    assert.match(native.preview.summary, /config\.yaml/);
});

test('manual compatibility mode supports custom connections and skips empty text', () => {
    const result = transformRequest({
        chat_completion_source: 'custom', model: 'claude-proxy',
        messages: [{ role: 'system', content: '' }, { role: 'system', content: 'fixed' }, { role: 'user', content: 'hello' }],
    }, { enabled: true, compatibility: 'anthropic-blocks', cacheHistory: false, cacheMemory: false });
    assert.equal(result.preview.applied, true);
    assert.equal(result.preview.cachePoints[0].messageIndex, 1);
    assert.equal(result.body.messages[0].content, '');
});

test('connection policies are normalized and selected per API connection', () => {
    const connection = describeApiConnection({ chat_completion_source: 'custom', custom_url: 'https://api.example/v1/', model: 'claude-x' });
    assert.match(connection.key, /^cm-[0-9a-z]+$/);
    assert.equal(connection.endpoint, 'api.example/v1');
    const policy = normalizeApiCachePolicy({ enabled: true, ttl: 'bad', historyDepth: 999 });
    assert.equal(policy.ttl, '5m');
    assert.equal(policy.historyDepth, 64);
    assert.equal(resolveApiCachePolicy({
        apiCacheDefaultPolicy: { enabled: false },
        apiCacheConnections: { [connection.key]: { enabled: true, ttl: '1h' } },
    }, connection.key).ttl, '1h');
});

test('fetch bridge excludes Cache Memory background API calls and routes main calls through server plugin', async () => {
    const requests = [];
    const preview = { applied: true, summary: 'server applied', cachePoints: [] };
    const target = {
        fetch: async (url, init) => {
            requests.push({ url, body: JSON.parse(init.body) });
            return new Response('{}', { headers: { 'x-cache-memory-adapter-preview': encodeURIComponent(JSON.stringify(preview)) } });
        },
    };
    const settings = {
        apiCacheAdapterEnabled: true,
        apiCacheDefaultPolicy: { enabled: true, compatibility: 'anthropic-blocks' },
        apiCacheConnections: {},
    };
    const bridge = new ApiCacheAdapterBridge({ getSettings: () => settings, updateSettings: patch => Object.assign(settings, patch) });
    bridge.available = true;
    bridge.install(target);
    await target.fetch('/api/backends/chat-completions/generate', {
        method: 'POST', body: JSON.stringify({ cache_memory_internal: true, messages: [] }),
    });
    await target.fetch('/api/backends/chat-completions/generate', {
        method: 'POST', body: JSON.stringify({ chat_completion_source: 'custom', model: 'claude-x', custom_url: 'https://api.example/v1', messages: [] }),
    });
    assert.equal(requests[0].url, '/api/backends/chat-completions/generate');
    assert.equal(requests[1].url, '/api/plugins/cache-memory-api-adapter/generate');
    assert.equal(requests[1].body.cache_memory_adapter.policy.enabled, true);
    assert.equal(bridge.status.preview.applied, true);
    bridge.uninstall();
});
