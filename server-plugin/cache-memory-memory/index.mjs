import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const info = Object.freeze({
    id: 'cache-memory-memory',
    name: 'Cache Memory Authoritative Store',
    description: 'Authenticated, atomic, per-user Cache Memory persistence.',
});

const VERSION = 1;
const root = path.resolve(process.env.SILLYTAVERN_DATA_DIR || path.join(process.cwd(), 'data'), 'cache-memory');
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
    if (['summaries', 'keepRegistry', 'stateOverrides', 'recovery'].includes(section)) return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    if (section === 'checkpoints' || section === 'longMemories') return Array.isArray(source) ? Object.fromEntries(source.map(item => [String(item?.id || ''), item]).filter(([id]) => id)) : {};
    return {};
}

function materialize(value, section, map) {
    if (['summaries', 'keepRegistry', 'stateOverrides', 'recovery'].includes(section)) value[section] = map;
    else if (section === 'checkpoints' || section === 'longMemories') value[section] = Object.values(map).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function threeWayMerge(base, local, remote) {
    const merged = clone(remote || local || base || {});
    const conflicts = [];
    for (const section of ['summaries', 'checkpoints', 'longMemories', 'keepRegistry', 'stateOverrides', 'recovery']) {
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
    for (const key of ['chatId', 'version', 'injectionSnapshot']) {
        if (local?.[key] !== undefined && JSON.stringify(stable(local[key])) !== JSON.stringify(stable(base?.[key]))) {
            if (remote?.[key] === undefined || JSON.stringify(stable(remote[key])) === JSON.stringify(stable(base?.[key]))) merged[key] = clone(local[key]);
            else if (JSON.stringify(stable(local[key])) !== JSON.stringify(stable(remote[key]))) conflicts.push({ section: 'root', id: key, remote: clone(remote[key]), local: clone(local[key]), base: clone(base?.[key]) });
        }
    }
    return { merged, conflicts };
}

async function readFile(user, chatId) {
    try { return JSON.parse(await fs.readFile(path.join(root, `${key(user, chatId)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeAtomic(user, chatId, record) {
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, `${key(user, chatId)}.json`);
    const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, file);
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

export async function init(router) {
    router.get('/status', (request, response) => {
        if (!userId(request)) return response.sendStatus(401);
        return response.json({ id: info.id, version: VERSION, atomic: true, revisionCheck: true, userScoped: true });
    });
    router.get('/memory/:chatId', async (request, response) => {
        const user = requireIdentity(request, response); if (!user) return;
        const chatId = safeId(request.params.chatId); if (!chatId) return response.status(400).json({ error: 'chatId required' });
        const record = await readFile(user, chatId);
        return response.json(record || { chatId, revision: 0, digest: '', store: null, conflicts: [] });
    });
    router.post('/memory/:chatId', async (request, response) => {
        const user = requireIdentity(request, response); if (!user) return;
        const chatId = safeId(request.params.chatId); if (!chatId) return response.status(400).json({ error: 'chatId required' });
        const payload = request.body || {};
        if (!payload.snapshot || typeof payload.snapshot !== 'object') return response.status(400).json({ error: 'snapshot required' });
        return withLock(key(user, chatId), async () => {
            const current = await readFile(user, chatId);
            const currentRevision = Number(current?.revision || 0);
            const base = payload.baseSnapshot || null;
            if (Number(payload.baseRevision || 0) !== currentRevision) return response.status(409).json({ error: 'revision conflict', record: current });
            if (payload.snapshot.chatId !== chatId) return response.status(400).json({ error: 'chat identity mismatch' });
            if (Number(current?.store?.version || 0) > Number(payload.snapshot.version || 0)) return response.status(409).json({ error: 'schema downgrade refused', record: current });
            const merged = current?.store ? threeWayMerge(base || current.store, payload.snapshot, current.store) : { merged: clone(payload.snapshot), conflicts: [] };
            if (merged.conflicts.length) return response.status(409).json({ error: 'record conflicts', conflicts: merged.conflicts, record: current });
            merged.merged.sync = { ...merged.merged.sync, revision: currentRevision + 1 };
            const next = {
                version: VERSION, chatId, revision: currentRevision + 1,
                digest: digest(merged.merged), updatedAt: new Date().toISOString(),
                writerId: String(payload.writerId || '').slice(0, 120), store: merged.merged, conflicts: [],
            };
            await writeAtomic(user, chatId, next);
            return response.json({ state: 'committed', record: next });
        });
    });
}

export async function exit() {}

export { digest, threeWayMerge };
