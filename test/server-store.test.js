import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyStore, memoryContentDigest } from '../src/memory-store.js';
import { MemoryPersistenceCoordinator } from '../src/persistence.js';
import { inspectMemoryImport, prepareMemoryImport } from '../src/memory-import.js';

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
        snapshot.recovery = { old: { content: 'obsolete backup' } };
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
        assert.equal(persisted.store.recovery, undefined);
        persisted.store.recovery = { historical: { content: 'old archived content' } };
        await fs.writeFile(path.join(directory, 'cache-memory', files[0]), JSON.stringify(persisted));
        const metadata = { cache_memory: structuredClone(persisted.store) };
        const coordinator = new MemoryPersistenceCoordinator({ getChatId: () => 'synthetic-chat', getMetadata: () => metadata,
            readAuthoritativeStore: async () => (await request('GET')).data,
            commitAuthoritative: async (_, payload) => {
                const response = await request('POST', payload);
                if (response.status !== 200) throw Object.assign(new Error(response.data.error), { status: response.status, data: response.data });
                return response.data;
            },
        });
        coordinator.activate('synthetic-chat', metadata.cache_memory);
        coordinator.enqueue(metadata.cache_memory, 'store migration');
        assert.equal((await coordinator.flush()).state, 'confirmed');
        assert.equal((await request('GET')).data.store.recovery, undefined);
        assert.equal((await coordinator.verify()).state, 'confirmed');
        const imported = createEmptyStore('synthetic-chat');
        imported.summaries.restored = { messageId: 'restored', floor: 1, event: 'restored file', status: 'frozen' };
        metadata.cache_memory = prepareMemoryImport(metadata.cache_memory, inspectMemoryImport(imported, 'synthetic-chat')).merged;
        coordinator.enqueue(metadata.cache_memory, 'memory import');
        assert.equal((await coordinator.flush()).state, 'confirmed');
        const diskReadback = (await request('GET')).data;
        assert.equal(diskReadback.revision, 4); assert.ok(diskReadback.store.summaries.restored);
        assert.equal(diskReadback.store.summaries.a, undefined); assert.equal(diskReadback.store.summaries.b, undefined);
        assert.ok(diskReadback.store.tombstones['Summary:a']);
        assert.equal(memoryContentDigest(diskReadback.store), memoryContentDigest(metadata.cache_memory));
    } finally {
        if (previous === undefined) delete process.env.SILLYTAVERN_DATA_DIR; else process.env.SILLYTAVERN_DATA_DIR = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
