import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const info = Object.freeze({
    id: 'cache-memory-memory',
    name: 'Cache Memory Authoritative Store',
    description: 'Authenticated, atomic, per-user Cache Memory persistence.',
});

const VERSION = 2;
const root = path.resolve(process.env.SILLYTAVERN_DATA_DIR || globalThis.DATA_ROOT || path.join(process.cwd(), 'data'), 'cache-memory');
// Older plugins ignored ST's configured dataRoot. Read that former location
// only if the configured location is absent; corruption never triggers fallback.
const legacyRoot = path.resolve(process.env.SILLYTAVERN_DATA_DIR || path.join(process.cwd(), 'data'), 'cache-memory');
const locks = new Map();

function userId(request) {
    const value = request?.user?.profile?.handle;
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function safeId(value) {
    const id = String(value || '').trim();
    return id.length <= 2000 ? id : '';
}

function key(user, chatId) {
    return crypto.createHash('sha256').update(`${user}\0${chatId}`).digest('hex');
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
}

function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function clone(value) { return structuredClone(value); }

function entities(value, section) {
    const source = value?.[section];
    if (['summaries', 'keepRegistry', 'stateOverrides', 'tombstones'].includes(section)) return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    if (section === 'checkpoints' || section === 'longMemories') return Array.isArray(source) ? Object.fromEntries(source.map(item => [String(item?.id || ''), item]).filter(([id]) => id)) : {};
    return {};
}

function materialize(value, section, map) {
    if (['summaries', 'keepRegistry', 'stateOverrides', 'tombstones'].includes(section)) value[section] = map;
    else if (section === 'checkpoints' || section === 'longMemories') value[section] = Object.values(map).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function threeWayMerge(base, local, remote) {
    const merged = clone(remote || local || base || {});
    delete merged.recovery;
    const conflicts = [];
    for (const section of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry', 'stateOverrides', 'tombstones']) {
        const b = entities(base, section), l = entities(local, section), r = entities(remote, section);
        const output = { ...r };
        for (const id of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
            const bv = b[id], lv = l[id], rv = r[id];
            const same = (a, c) => JSON.stringify(stable(a)) === JSON.stringify(stable(c));
            if (same(lv, bv)) { if (rv === undefined) delete output[id]; else output[id] = rv; continue; }
            if (same(rv, bv) || same(lv, rv)) { if (lv === undefined) delete output[id]; else output[id] = lv; continue; }
            conflicts.push({ section, id, remote: clone(rv), local: clone(lv), base: clone(bv) });
        }
        materialize(merged, section, output);
    }
    for (const key of ['chatId', 'version', 'injectionSnapshot', 'summaryMode']) {
        if (local?.[key] !== undefined && JSON.stringify(stable(local[key])) !== JSON.stringify(stable(base?.[key]))) {
            if (remote?.[key] === undefined || JSON.stringify(stable(remote[key])) === JSON.stringify(stable(base?.[key]))) merged[key] = clone(local[key]);
            else if (JSON.stringify(stable(local[key])) !== JSON.stringify(stable(remote[key]))) conflicts.push({ section: 'root', id: key, remote: clone(remote[key]), local: clone(local[key]), base: clone(base?.[key]) });
        }
    }
    return { merged, conflicts };
}

async function readFile(user, chatId) {
    for (const directory of new Set([root, legacyRoot])) {
        try { return validateRecord(JSON.parse(await fs.readFile(path.join(directory, `${key(user, chatId)}.json`), 'utf8')), chatId); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return null;
}

function validateSnapshot(store) {
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('invalid memory snapshot');
    for (const section of ['summaries', 'keepRegistry', 'stateOverrides', 'tombstones']) {
        if (Object.hasOwn(store, section) && (!store[section] || typeof store[section] !== 'object' || Array.isArray(store[section]))) throw new Error(`invalid ${section}`);
    }
    for (const section of ['checkpoints', 'longMemories']) {
        if (!Array.isArray(store[section])) throw new Error(`invalid ${section}`);
    }
    if (!store.summaries || !store.keepRegistry) throw new Error('missing memory sections');
}

function validateRecord(record, chatId) {
    if (record?.chatId !== chatId || !Number.isInteger(record.revision) || record.revision < 1) throw new Error('invalid stored chat identity/revision');
    validateSnapshot(record.store);
    if (record.store.chatId !== chatId || record.digest !== digest(record.store)) throw new Error('stored memory checksum mismatch; original file retained');
    return record;
}

function unexplainedLoss(before, after) {
    return ['summaries', 'checkpoints', 'longMemories', 'keepRegistry', 'stateOverrides'].some(section => {
        const type = { summaries: 'Summary', checkpoints: 'Checkpoint', longMemories: 'Long Memory', keepRegistry: 'KEEP', stateOverrides: 'stateOverrides' }[section];
        const a = entities(before, section), b = entities(after, section);
        return Object.keys(a).some(id => !Object.hasOwn(b, id) && !after?.tombstones?.[`${type}:${id}`]);
    });
}

async function history(user, chatId, storageRoot = root) {
    const directory = path.join(storageRoot, 'history', key(user, chatId));
    let names;
    try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter(name => /^\d+-[a-f0-9]{64}\.json$/.test(name))) {
        records.push(validateRecord(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')), chatId));
    }
    return records.sort((a, b) => b.revision - a.revision);
}

async function durableWrite(file, record) {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, file);
        if (process.platform !== 'win32') {
            const directory = await fs.open(path.dirname(file), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally { await fs.rm(temp, { force: true }); }
}

async function writeAtomic(user, chatId, record) {
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, `${key(user, chatId)}.json`);
    const previous = await readFile(user, chatId);
    if (previous) {
        const directory = path.join(root, 'history', key(user, chatId));
        await fs.mkdir(directory, { recursive: true });
        await durableWrite(path.join(directory, `${previous.revision}-${previous.digest}.json`), previous);
    }
    await durableWrite(file, record);
    // Keep five prior server revisions; backups are outside model/export memory.
    const old = (await history(user, chatId)).slice(5);
    for (const entry of old) await fs.rm(path.join(root, 'history', key(user, chatId), `${entry.revision}-${entry.digest}.json`));
}

async function withLock(lockKey, callback) {
    const previous = locks.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(lockKey, current);
    await previous;
    try { return await callback(); }
    finally {
        release();
        if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
}

function requireIdentity(request, response) {
    const user = userId(request);
    if (!user) { response.status(401).json({ error: 'Authenticated SillyTavern user required' }); return null; }
    return user;
}

function guardedRoute(handler) {
    return (request, response) => Promise.resolve().then(() => handler(request, response)).catch(error =>
        response.status(503).json({ error: `Memory storage unavailable; originals retained: ${error.message}` }));
}

export async function init(router) {
    router.get('/status', (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        if (!userId(request)) return response.sendStatus(401);
        return response.json({ id: info.id, version: VERSION, atomic: true, revisionCheck: true, userScoped: true, history: true });
    });
    router.get('/memory/:chatId', guardedRoute(async (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        const user = requireIdentity(request, response); if (!user) return;
        const chatId = safeId(request.params.chatId); if (!chatId) return response.status(400).json({ error: 'chatId required' });
        const record = await readFile(user, chatId);
        return response.json(record || { chatId, revision: 0, digest: '', store: null, conflicts: [] });
    }));
    router.get('/memory/:chatId/history', guardedRoute(async (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        const user = requireIdentity(request, response); if (!user) return;
        const chatId = safeId(request.params.chatId); if (!chatId) return response.status(400).json({ error: 'chatId required' });
        const records = await history(user, chatId);
        if (root !== legacyRoot) {
            records.push(...await history(user, chatId, legacyRoot));
            try { records.push(validateRecord(JSON.parse(await fs.readFile(path.join(legacyRoot, `${key(user, chatId)}.json`), 'utf8')), chatId)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return response.json({ chatId, records });
    }));
    router.post('/memory/:chatId', guardedRoute(async (request, response) => {
        const user = requireIdentity(request, response); if (!user) return;
        const chatId = safeId(request.params.chatId); if (!chatId) return response.status(400).json({ error: 'chatId required' });
        const payload = request.body || {};
        if (!payload.snapshot || typeof payload.snapshot !== 'object') return response.status(400).json({ error: 'snapshot required' });
        try { validateSnapshot(payload.snapshot); } catch (error) { return response.status(400).json({ error: error.message }); }
        return withLock(key(user, chatId), async () => {
            const current = await readFile(user, chatId);
            const currentRevision = Number(current?.revision || 0);
            const base = payload.baseSnapshot || null;
            if (Number(payload.baseRevision || 0) !== currentRevision) return response.status(409).json({ error: 'revision conflict', record: current });
            if (payload.snapshot.chatId !== chatId) return response.status(400).json({ error: 'chat identity mismatch' });
            if (Number(current?.store?.version || 0) > Number(payload.snapshot.version || 0)) return response.status(409).json({ error: 'schema downgrade refused', record: current });
            if (current?.store && !payload.allowReplacement && unexplainedLoss(current.store, payload.snapshot)) return response.status(409).json({ error: 'memory integrity loss: deletion markers required', record: current });
            const merged = current?.store ? threeWayMerge(base || current.store, payload.snapshot, current.store) : { merged: clone(payload.snapshot), conflicts: [] };
            if (merged.conflicts.length) return response.status(409).json({ error: 'record conflicts', conflicts: merged.conflicts, record: current });
            delete merged.merged.recovery;
            merged.merged.sync = { ...merged.merged.sync, revision: currentRevision + 1 };
            const next = {
                version: VERSION, chatId, revision: currentRevision + 1,
                digest: digest(merged.merged), updatedAt: new Date().toISOString(),
                writerId: String(payload.writerId || '').slice(0, 120), store: merged.merged, conflicts: [],
            };
            await writeAtomic(user, chatId, next);
            return response.json({ state: 'committed', record: next });
        });
    }));
}

export async function exit() {}

export { digest, threeWayMerge };
