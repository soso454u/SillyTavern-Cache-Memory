import { normalizeStore, STORE_VERSION, mergeMemoryStores, memoryContentDigest, applyMemoryTombstones } from './memory-store.js?v=1.21.0';
import { projectActiveState, isTrackedActive } from './active-state.js?v=1.21.0';
import { projectLongFacts } from './continuity.js?v=1.21.0';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function inspectMemoryImport(data, chatId) {
    if (!object(data) || !Number.isInteger(data.version) || data.version < 1 || data.version > STORE_VERSION
        || !object(data.summaries) || !Array.isArray(data.checkpoints) || !Array.isArray(data.longMemories)) throw new Error('不是支持的 Cache Memory JSON（v1–v6）');
    if (!data.chatId || String(data.chatId) !== String(chatId)) throw new Error('JSON 聊天身份缺失或不匹配，已阻止导入');
    for (const section of ['keepRegistry', 'stateOverrides', 'recovery', 'tombstones']) if (data[section] != null && !object(data[section])) throw new Error(`${section} 格式错误`);
    const guardKeys = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('JSON 包含不安全字段');
            guardKeys(child);
        }
    };
    guardKeys(data);
    const warnings = [];
    for (const [id, row] of Object.entries(data.summaries)) {
        if (!object(row) || row.messageId !== id || !Number.isInteger(row.floor) || row.floor < 1) throw new Error(`Summary ${id} 身份或楼层格式错误`);
        for (const field of ['raw', 'event', 'state', 'open', 'keep', 'quote', 'title', 'characters', 'sourceFingerprint']) if (row[field] != null && typeof row[field] !== 'string') throw new Error(`Summary ${id} 的 ${field} 格式错误`);
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
            if (missing.length) warnings.push(`${row.id} 有 ${missing.length} 个来源摘要不存在，导入后保留待核对`);
            if (row.previousCheckpointId && !data.checkpoints.some(cp => cp.id === row.previousCheckpointId)
                || row.checkpointIds?.some(id => !data.checkpoints.some(cp => cp.id === id))) warnings.push(`${row.id} 的关联 Checkpoint 不完整，导入后保留待核对`);
        }
    }
    for (const [id, row] of Object.entries(data.keepRegistry ?? {})) if (!object(row) || typeof row.text !== 'string') throw new Error(`KEEP ${id} 格式错误`);
    for (const [id, row] of Object.entries(data.stateOverrides ?? {})) {
        if (!object(row) || !['thread', 'state'].includes(row.kind) || !row.id || !row.sourceId) throw new Error(`状态 ${id} 格式错误`);
        if (!data.summaries[row.sourceId]) warnings.push(`状态 ${id} 来源不存在，导入后待核对`);
    }
    const store = normalizeStore(structuredClone(data), chatId), states = projectActiveState(store);
    const counts = { Summary: Object.keys(store.summaries).length, Checkpoint: store.checkpoints.length,
        'Long Memory': store.longMemories.length, 'Long Facts': projectLongFacts(store).facts.length,
        KEEP: Object.keys(store.keepRegistry).length, 'Active Threads': states.filter(row => row.kind === 'thread' && isTrackedActive(row)).length,
        'Character State': states.filter(row => row.kind === 'state').length };
    return { store, counts, warnings, sourceVersion: data.version };
}

export function prepareMemoryImport(current, inspected, { mode = 'merge', preference = 'local' } = {}) {
    const result = mode === 'replace' ? { merged: structuredClone(inspected.store), conflicts: [], added: { total: 0 } }
        : preference === 'incoming' ? mergeMemoryStores(inspected.store, current, current.chatId) : mergeMemoryStores(current, inspected.store, current.chatId);
    const merged = result.merged;
    merged.tombstones = { ...current.tombstones, ...merged.tombstones };
    applyMemoryTombstones(merged);
    merged.recovery = { ...current.recovery, ...merged.recovery };
    merged.recovery[`import-backup:${memoryContentDigest(current)}`] = { kind: 'import-backup', snapshot: structuredClone(current), incoming: structuredClone(inspected.store) };
    if (current.injectionSnapshot) merged.injectionSnapshot = structuredClone(current.injectionSnapshot);
    else delete merged.injectionSnapshot;
    return result;
}
