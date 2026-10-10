import { normalizeStore, STORE_VERSION, mergeMemoryStores, applyMemoryTombstones } from './memory-store.js?v=1.24.0';
import { projectActiveState, isTrackedActive } from './active-state.js?v=1.24.0';
import { projectLongFacts } from './continuity.js?v=1.24.0';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function inspectMemoryImport(data, chatId, { assistants = [] } = {}) {
    if (!object(data) || !Number.isInteger(data.version) || data.version < 1 || data.version > STORE_VERSION
        || !object(data.summaries) || !Array.isArray(data.checkpoints) || !Array.isArray(data.longMemories)) throw new Error('不是支持的 Cache Memory JSON（v1–v6）');
    let legacyIdentity = false;
    if (!data.chatId || String(data.chatId) !== String(chatId)) {
        let scope; try { scope = JSON.parse(chatId); } catch { /* Non-scoped test/legacy caller. */ }
        const records = Object.entries(data.summaries);
        legacyIdentity = data.version <= 4 && Array.isArray(scope) && scope.length === 3 && data.chatId === scope[2] && records.length > 0
            && records.every(([id, row]) => assistants.some(entry => entry.messageId === id || row?.sourceFingerprint && row.sourceFingerprint === entry.fingerprint));
        if (!legacyIdentity) throw new Error('JSON 聊天身份缺失或不匹配，已阻止导入');
    }
    for (const section of ['keepRegistry', 'stateOverrides', 'recovery', 'tombstones']) if (data[section] != null && !object(data[section])) throw new Error(`${section} 格式错误`);
    const guardKeys = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('JSON 包含不安全字段');
            guardKeys(child);
        }
    };
    guardKeys(data);
    const warnings = legacyIdentity ? ['旧版文件的聊天名和全部摘要来源已与当前聊天核对'] : [];
    for (const [id, row] of Object.entries(data.summaries)) {
        if (!object(row) || row.messageId !== id || !Number.isInteger(row.floor) || row.floor < 1) throw new Error(`Summary ${id} 身份或楼层格式错误`);
        for (const field of ['raw', 'event', 'state', 'open', 'keep', 'quote', 'title', 'characters', 'sourceFingerprint', 'sourceContentFingerprint']) if (row[field] != null && typeof row[field] !== 'string') throw new Error(`Summary ${id} 的 ${field} 格式错误`);
        if (row.stateChanges != null && (!Array.isArray(row.stateChanges) || row.stateChanges.some(change => !object(change) || !change.id || !['thread', 'state'].includes(change.kind) || typeof change.entity !== 'string' || typeof change.key !== 'string' || typeof change.value !== 'string'))) throw new Error(`Summary ${id} 的状态变化格式错误`);
    }
    for (const section of ['checkpoints', 'longMemories']) {
        const ids = new Set();
        for (const row of data[section]) {
            if (!object(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.content !== 'string'
                || !Number.isInteger(row.startFloor) || !Number.isInteger(row.endFloor) || row.startFloor < 1 || row.endFloor < row.startFloor) throw new Error(`${section} 存在无效或重复记录`);
            ids.add(row.id);
            if (row.previousCheckpointId != null && typeof row.previousCheckpointId !== 'string') throw new Error(`${row.id} 前序身份格式错误`);
            if (row.factUpdates != null && (!Array.isArray(row.factUpdates) || row.factUpdates.some(update => !object(update) || !['add', 'update', 'replace', 'retire'].includes(update.action) || typeof update.id !== 'string'))) throw new Error(`${row.id} 长期事实格式错误`);
            if (row.summaryIds != null && (!Array.isArray(row.summaryIds) || row.summaryIds.some(id => typeof id !== 'string'))) throw new Error(`${row.id} 摘要关联格式错误`);
            if (row.checkpointVersions != null && (!object(row.checkpointVersions) || Object.values(row.checkpointVersions).some(value => typeof value !== 'string'))) throw new Error(`${row.id} Checkpoint 版本格式错误`);
            if (row.sourceVersions != null && (!object(row.sourceVersions) || Object.values(row.sourceVersions).some(value => typeof value !== 'string'))) throw new Error(`${row.id} 来源版本格式错误`);
            if (row.checkpointIds != null && (!Array.isArray(row.checkpointIds) || row.checkpointIds.some(id => typeof id !== 'string'))) throw new Error(`${row.id} 关联关系格式错误`);
            const missing = Object.keys(row.sourceVersions ?? {}).filter(id => !data.summaries[id]);
            if (missing.length) warnings.push(`${row.id} 有 ${missing.length} 个来源摘要不存在，保留已生成内容`);
            if (row.previousCheckpointId && !data.checkpoints.some(cp => cp.id === row.previousCheckpointId)
                || row.checkpointIds?.some(id => !data.checkpoints.some(cp => cp.id === id))) warnings.push(`${row.id} 的关联 Checkpoint 不完整，保留已生成内容`);
        }
    }
    for (const [id, row] of Object.entries(data.keepRegistry ?? {})) if (!object(row) || typeof row.text !== 'string') throw new Error(`KEEP ${id} 格式错误`);
    for (const [id, row] of Object.entries(data.stateOverrides ?? {})) {
        if (!object(row) || !['thread', 'state'].includes(row.kind) || !row.id || !row.sourceId) throw new Error(`状态 ${id} 格式错误`);
        if (!data.summaries[row.sourceId]) warnings.push(`状态 ${id} 来源不存在，保留现有状态记录`);
    }
    const store = normalizeStore(structuredClone(data), chatId), states = projectActiveState(store);
    const counts = { Summary: Object.keys(store.summaries).length, Checkpoint: store.checkpoints.length,
        'Long Memory': store.longMemories.length, 'Long Facts': projectLongFacts(store).facts.length,
        KEEP: Object.keys(store.keepRegistry).length, 'Active Threads': states.filter(row => row.kind === 'thread' && isTrackedActive(row)).length,
        'Character State': states.filter(row => row.kind === 'state').length };
    return { store, counts, warnings, sourceVersion: data.version };
}

export function prepareMemoryImport(current, inspected, { mode = 'replace', preference = 'local' } = {}) {
    const result = mode === 'replace' ? { merged: structuredClone(inspected.store), conflicts: [], added: { total: 0 } }
        : preference === 'incoming' ? mergeMemoryStores(inspected.store, current, current.chatId) : mergeMemoryStores(current, inspected.store, current.chatId);
    const merged = result.merged;
    if (mode === 'replace') {
        // A confirmed file restore may undo an earlier deletion. Mark records
        // omitted by the file explicitly, so an old window cannot re-add them.
        merged.tombstones = { ...current.tombstones, ...merged.tombstones };
        for (const [section, type] of [['summaries', 'Summary'], ['checkpoints', 'Checkpoint'], ['longMemories', 'Long Memory'], ['keepRegistry', 'KEEP'], ['stateOverrides', 'stateOverrides']]) {
            const ids = value => Array.isArray(value) ? value.map(row => row.id) : Object.keys(value);
            const restored = new Set(ids(merged[section]));
            for (const id of restored) delete merged.tombstones[`${type}:${id}`];
            for (const id of ids(current[section])) if (!restored.has(id)) merged.tombstones[`${type}:${id}`] = { reason: 'confirmed-json-restore', deletedAt: new Date().toISOString() };
        }
    } else merged.tombstones = { ...current.tombstones, ...merged.tombstones };
    delete merged.recovery;
    applyMemoryTombstones(merged);
    if (current.injectionSnapshot) merged.injectionSnapshot = structuredClone(current.injectionSnapshot);
    else delete merged.injectionSnapshot;
    return result;
}
