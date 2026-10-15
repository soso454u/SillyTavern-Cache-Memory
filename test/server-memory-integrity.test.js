import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyStore } from '../src/memory-store.js';

// Real route handlers and temporary files only; no network or model calls.
test('server refuses silent memory loss, keeps five readable history revisions and isolates users', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-memory-integrity-'));
    const previous = process.env.SILLYTAVERN_DATA_DIR; process.env.SILLYTAVERN_DATA_DIR = directory;
    try {
        const plugin = await import(`../server-plugin/cache-memory-memory/index.mjs?integrity=${Date.now()}`);
        const routes = new Map(); await plugin.init({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) });
        const request = async (method, body, suffix = '', user = 'user-a') => {
            let status = 200, data;
            const response = { set() {}, status(code) { status = code; return this; }, json(value) { data = value; return this; }, sendStatus(code) { status = code; } };
            await routes.get(`${method} /memory/:chatId${suffix}`)({ user: { profile: { handle: user } }, params: { chatId: 'chat-a' }, body }, response);
            return { status, data };
        };
        const snapshot = createEmptyStore('chat-a');
        for (let i = 1; i <= 318; i++) snapshot.summaries[`m${i}`] = { messageId: `m${i}`, event: `synthetic ${i}`, floor: i };
        snapshot.checkpoints.push({ id: 'cp', content: 'synthetic checkpoint' }); snapshot.longMemories.push({ id: 'long', content: 'synthetic long' });
        snapshot.keepRegistry['KEEP-0001'] = { text: 'synthetic KEEP', status: 'active' };
        assert.equal((await request('POST', { snapshot, baseRevision: 0 })).status, 200);
        const original = (await request('GET')).data;
        for (const section of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry']) {
            const partial = structuredClone(snapshot); partial[section] = Array.isArray(partial[section]) ? [] : {};
            assert.equal((await request('POST', { snapshot: partial, baseRevision: 1, baseSnapshot: original.store })).status, 409);
            assert.deepEqual((await request('GET')).data, original);
        }
        const damaged = { ...snapshot, checkpoints: {} };
        assert.equal((await request('POST', { snapshot: damaged, baseRevision: 1 })).status, 400);
        for (let revision = 1; revision <= 7; revision++) {
            const current = (await request('GET')).data, next = structuredClone(current.store);
            next.summaries.m1.event = `edit ${revision}`;
            assert.equal((await request('POST', { snapshot: next, baseSnapshot: current.store, baseRevision: revision })).status, 200);
        }
        const histories = (await request('GET', null, '/history')).data.records;
        assert.deepEqual(histories.map(record => record.revision), [7, 6, 5, 4, 3]);
        assert.ok(histories.every(record => Object.keys(record.store.summaries).length === 318 && record.digest === plugin.digest(record.store)));
        assert.equal((await request('GET', null, '/history', 'other-user')).data.records.length, 0);
        const beforeClear = (await request('GET')).data, clear = createEmptyStore('chat-a');
        for (const id of Object.keys(beforeClear.store.summaries)) clear.tombstones[`Summary:${id}`] = { deletedAt: 'explicit' };
        clear.tombstones['Checkpoint:cp'] = {}; clear.tombstones['Long Memory:long'] = {}; clear.tombstones['KEEP:KEEP-0001'] = {};
        assert.equal((await request('POST', { snapshot: clear, baseSnapshot: beforeClear.store, baseRevision: 8 })).status, 200);
        const savedHistory = (await request('GET', null, '/history')).data.records;
        assert.equal(savedHistory[0].revision, 8); assert.equal(Object.keys(savedHistory[0].store.summaries).length, 318);
        const files = (await fs.readdir(path.join(directory, 'cache-memory'))).filter(name => name.endsWith('.json'));
        const filename = path.join(directory, 'cache-memory', files[0]);
        const corrupted = JSON.parse(await fs.readFile(filename, 'utf8')); corrupted.store.summaries = { injected: { event: 'corruption' } };
        const raw = JSON.stringify(corrupted); await fs.writeFile(filename, raw);
        assert.equal((await request('GET')).status, 503);
        assert.equal((await request('POST', { snapshot, baseRevision: 9 })).status, 503);
        assert.equal(await fs.readFile(filename, 'utf8'), raw);
        assert.equal((await request('GET', null, '/history')).data.records[0].revision, 8);
    } finally {
        if (previous === undefined) delete process.env.SILLYTAVERN_DATA_DIR; else process.env.SILLYTAVERN_DATA_DIR = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('configured ST dataRoot reads former plugin location safely and preserves it during migration', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-memory-root-'));
    const previousEnv = process.env.SILLYTAVERN_DATA_DIR, previousRoot = globalThis.DATA_ROOT, previousCwd = process.cwd();
    delete process.env.SILLYTAVERN_DATA_DIR; delete globalThis.DATA_ROOT; process.chdir(directory);
    try {
        async function routesFor(tag) {
            const plugin = await import(`../server-plugin/cache-memory-memory/index.mjs?root=${tag}-${Date.now()}`), routes = new Map();
            await plugin.init({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) });
            return async (method, body) => {
                let status = 200, data;
                const response = { set() {}, status(code) { status = code; return this; }, json(value) { data = value; return this; } };
                await routes.get(`${method} /memory/:chatId`)({ user: { profile: { handle: 'same-user' } }, params: { chatId: 'same-chat' }, body }, response);
                return { status, data };
            };
        }
        const old = await routesFor('old'), snapshot = createEmptyStore('same-chat'); snapshot.summaries.a = { messageId: 'a', event: 'former location' };
        assert.equal((await old('POST', { snapshot, baseRevision: 0 })).status, 200);
        const filename = (await fs.readdir(path.join(directory, 'data/cache-memory')))[0];
        const formerPath = path.join(directory, 'data/cache-memory', filename), original = await fs.readFile(formerPath, 'utf8');
        globalThis.DATA_ROOT = path.join(directory, 'configured-data'); const current = await routesFor('configured');
        const record = (await current('GET')).data; assert.equal(record.store.summaries.a.event, 'former location');
        const next = structuredClone(record.store); next.summaries.b = { messageId: 'b', event: 'new configured location' };
        assert.equal((await current('POST', { snapshot: next, baseSnapshot: record.store, baseRevision: record.revision })).status, 200);
        assert.equal(await fs.readFile(formerPath, 'utf8'), original);
        const migrated = JSON.parse(await fs.readFile(path.join(directory, 'configured-data/cache-memory', filename), 'utf8'));
        assert.ok(migrated.store.summaries.a); assert.ok(migrated.store.summaries.b);
        assert.equal((await current('GET')).data.revision, 2);
    } finally {
        process.chdir(previousCwd);
        if (previousEnv === undefined) delete process.env.SILLYTAVERN_DATA_DIR; else process.env.SILLYTAVERN_DATA_DIR = previousEnv;
        if (previousRoot === undefined) delete globalThis.DATA_ROOT; else globalThis.DATA_ROOT = previousRoot;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
