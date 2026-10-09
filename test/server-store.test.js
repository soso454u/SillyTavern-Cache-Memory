import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyStore } from '../src/memory-store.js';

test('server routes enforce authenticated isolation, atomic CAS and reject old schema/wrong chat', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-memory-cas-test-'));
    const previous = process.env.SILLYTAVERN_DATA_DIR;
    process.env.SILLYTAVERN_DATA_DIR = directory;
    try {
        const plugin = await import(`../server-plugin/cache-memory-memory/index.mjs?test=${Date.now()}`);
        const routes = new Map();
        await plugin.init({ get: (url, fn) => routes.set(`GET ${url}`, fn), post: (url, fn) => routes.set(`POST ${url}`, fn) });
        const request = async (method, body, user = 'synthetic-user', chatId = 'synthetic-chat') => {
            let status = 200, data;
            const response = { status: code => { status = code; return response; }, json: value => { data = value; return response; }, sendStatus: code => { status = code; } };
            await routes.get(`${method} /memory/:chatId`)({ user: user ? { profile: { handle: user } } : null, params: { chatId }, body }, response);
            return { status, data };
        };
        assert.equal((await request('GET', null, '')).status, 401);
        const snapshot = createEmptyStore('synthetic-chat'); snapshot.summaries.a = { messageId: 'a', event: 'synthetic' };
        const initial = await request('POST', { snapshot, baseRevision: 0 }); assert.equal(initial.status, 200); assert.equal(initial.data.record.revision, 1);
        const branch = structuredClone(snapshot); branch.summaries.b = { event: 'second' };
        branch.tombstones['Summary:gone'] = { deletedAt: 'synthetic-time' };
        const attempts = await Promise.all([1, 2].map(() => request('POST', { snapshot: branch, baseSnapshot: snapshot, baseRevision: 1 })));
        assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
        assert.equal((await request('GET')).data.revision, 2);
        assert.equal((await request('GET', null, 'another-user')).data.store, null);
        assert.equal((await request('POST', { snapshot: { ...snapshot, chatId: 'wrong' }, baseRevision: 2 })).status, 400);
        assert.equal((await request('POST', { snapshot: { ...snapshot, version: 5 }, baseRevision: 2 })).status, 409);
        const files = await fs.readdir(path.join(directory, 'cache-memory')); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]+\.json$/);
        const persisted = JSON.parse(await fs.readFile(path.join(directory, 'cache-memory', files[0]), 'utf8'));
        assert.equal(persisted.store.sync.revision, 2); assert.ok(persisted.store.summaries.b);
        assert.ok(persisted.store.tombstones['Summary:gone']);
    } finally {
        if (previous === undefined) delete process.env.SILLYTAVERN_DATA_DIR; else process.env.SILLYTAVERN_DATA_DIR = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
