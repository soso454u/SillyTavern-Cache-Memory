import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, MemoryStore, summaryMatchesEntry } from '../src/memory-store.js';
import { stateId, projectActiveState, parseStateChanges, stateContext, reconcileTrackedCheckpoint, trackedFactUpdates } from '../src/active-state.js';
import { collectKeepItems, formatKeepItems, projectLongFacts } from '../src/continuity.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { memoryOverviewStats } from '../src/ui.js';
import { normalizeSettings } from '../src/defaults.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';

function put(store, floor, changes = [], extra = {}) {
    const messageId = `m${floor}`;
    store.summaries[messageId] = { messageId, floor, event: '已保存的剧情', status: 'frozen', frozen: true,
        sourceContentFingerprint: `body${floor}`, stateChanges: changes.map(row => ({ ...row, id: row.id ?? stateId(row) })), ...extra };
}
const task = { kind: 'thread', entity: '角色甲', key: '任务：归途', value: '尚未完成', status: 'active', acquisition: 'pending', evidence: '系统正式发布归途任务' };
const skill = { kind: 'state', entity: '角色甲', key: '观察', value: 'Lv.1', status: 'active', category: 'skill', lifetime: 'permanent', acquisition: 'obtained', evidence: '获得一级观察技能' };

test('legacy aliases of one named task inherit completion under one stable ID and cannot reopen', () => {
    const store = createEmptyStore('a');
    put(store, 210, [{ ...task, id: 'legacy-announcement' }]);
    put(store, 213, [{ ...task, id: 'legacy-condition', key: '【归途】剧情判定', value: '条件明确' }]);
    put(store, 214, [{ ...task, id: 'legacy-condition', key: '【归途】剧情判定', value: '完成并领取奖励', status: 'completed', acquisition: 'obtained', evidence: '归途任务结算完成' }]);
    put(store, 220, [{ ...task, id: 'legacy-announcement' }]);
    const original = structuredClone(store);
    const rows = projectActiveState(store);
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'legacy-announcement');
    assert.equal(rows[0].status, 'completed'); assert.equal(rows[0].sourceFloor, 214);
    assert.match(stateContext(store), /completed/);
    const content = '[Story So Far]\n先前领取任务，后来完成\n[Current State]\n角色甲 · 任务：归途：尚未完成\n[Open Threads]\n角色甲 · 任务：归途：尚未完成（尚未领取）';
    const projected = reconcileTrackedCheckpoint(content, store, 225, 221);
    assert.doesNotMatch(projected, /尚未完成|尚未领取/); assert.match(projected, /先前领取任务，后来完成/);
    assert.deepEqual(store, original);
    const row = { ...task, key: '【归途】判定', confirmed: true };
    assert.equal(parseStateChanges(JSON.stringify([row]), row.evidence, rows)[0].id, 'legacy-announcement');
});

test('task title normalization keeps different characters and explicitly distinct repeat tasks separate', () => {
    const store = createEmptyStore('a');
    put(store, 1, [task, { ...task, entity: '角色乙' }, { ...task, key: '任务：归途（第二次）' }]);
    assert.equal(projectActiveState(store).length, 3);
});

test('first observed explicit settlement is recorded; an unconfirmed closure is rejected', () => {
    const row = { ...task, status: 'completed', confirmed: true, evidence: '系统确认归途任务结算完成' };
    assert.equal(parseStateChanges(JSON.stringify([row]), row.evidence).length, 1);
    assert.equal(parseStateChanges(JSON.stringify([{ ...row, confirmed: false }]), row.evidence).length, 0);
    assert.equal(parseStateChanges(JSON.stringify([{ ...row, evidence: '归途任务尚未完成' }]), '归途任务尚未完成').length, 0);
});

test('a later evidenced knowledge change retires its old sourced KEEP and retains other observer secrets', () => {
    const store = createEmptyStore('a');
    const secret = { kind: 'state', entity: '角色甲', key: '藏匿信件秘密', category: 'knowledge', status: 'active', actors: ['角色甲', '角色乙'], value: '角色甲藏匿蓝色信件，角色乙不知情', evidence: '蓝色信件藏在衣柜' };
    put(store, 1, [secret]);
    store.keepRegistry['KEEP-0001'] = { text: '角色甲藏匿蓝色信件，角色乙对此不知情', sourceId: 'm1', sourceFloor: 1, status: 'active' };
    store.keepRegistry['KEEP-0002'] = { text: '角色甲藏匿另一封红色信件，角色丙不知情', sourceId: 'm1', sourceFloor: 1, status: 'active' };
    store.keepRegistry['KEEP-0003'] = { text: '角色甲藏匿另一封红色信件，角色乙对此不知情', sourceId: 'm1', sourceFloor: 1, status: 'active' };
    put(store, 2, [{ ...secret, value: '角色甲藏匿蓝色信件，角色乙已获知', evidence: '角色乙读到了蓝色信件' }]);
    const original = structuredClone(store);
    assert.equal(collectKeepItems(store, 1)[0].status, 'active');
    const keeps = collectKeepItems(store);
    assert.equal(keeps[0].status, 'superseded'); assert.equal(keeps[1].status, 'active'); assert.equal(keeps[2].status, 'active');
    assert.doesNotMatch(formatKeepItems(keeps), /蓝色信件/); assert.match(formatKeepItems(keeps), /红色信件/);
    assert.deepEqual(store, original);
    store.summaries.m2.status = 'orphaned';
    assert.equal(collectKeepItems(store)[0].status, 'active');
});

test('skills and attributes have one latest keyed value across current sections; history survives', () => {
    const store = createEmptyStore('a'); put(store, 1, [skill]); put(store, 2, [{ ...skill, value: 'Lv.2' }]);
    const text = '[Story So Far]\n角色甲曾凭Lv.1观察发现线索\n[Characters]\n角色甲 · 观察：Lv.1\n[Current State]\n角色甲 · 观察：Lv.1\n[Continuity Locks]\n角色甲 · 观察：Lv.1';
    const result = reconcileTrackedCheckpoint(text, store, 5);
    assert.match(result, /曾凭Lv.1观察发现线索/);
    assert.equal((result.match(/Lv.2/g) ?? []).length, 1);
    assert.doesNotMatch(result, /观察：Lv.1/);
    const facts = [{ id: 'fact-observation', stateId: stateId(skill), text: '角色甲 · 观察：Lv.2', status: 'active' }];
    assert.deepEqual(trackedFactUpdates([], store, 5, facts), []);
});

test('counts distinguish 244 stored records from 225/226 valid summaries without deletion', () => {
    const store = createEmptyStore('a');
    const entries = Array.from({ length: 226 }, (_, i) => ({ messageId: `m${i + 1}`, floor: i + 1, contentFingerprint: `body${i + 1}` }));
    for (let floor = 1; floor <= 225; floor++) put(store, floor);
    for (let i = 0; i < 19; i++) store.summaries[`old${i}`] = { messageId: `old${i}`, floor: i === 18 ? 226 : 204 + i, status: 'orphaned', event: '旧版本' };
    const before = structuredClone(store);
    const stats = memoryOverviewStats(store, entries, normalizeSettings());
    assert.equal(stats.storedSummaryRecords, 244); assert.equal(stats.summaries.actual, 225); assert.equal(stats.summaries.expected, 226);
    assert.deepEqual(stats.summaryDetails.filter(row => row.current).map(row => [row.floor, row.reason]), [[226, 'missing']]);
    assert.equal(stats.summaryDetails.filter(row => !row.current && row.reason === 'orphaned').length, 19);
    assert.deepEqual(store, before);
    put(store, 226); assert.equal(memoryOverviewStats(store, entries, normalizeSettings()).summaries.actual, 226);
});

test('body mismatches, empty, deleted and unverifiable summaries share the same counting and generation eligibility', () => {
    const data = createEmptyStore('a');
    const chat = Array.from({ length: 6 }, (_, i) => ({ name: 'A', mes: `正文${i + 1}`, gen_started: `g${i}` }));
    const entries = getAssistantMessages(chat);
    for (const entry of entries) data.summaries[entry.messageId] = { messageId: entry.messageId, floor: entry.floor, event: '摘要', status: 'frozen', frozen: true, sourceContentFingerprint: entry.contentFingerprint };
    data.summaries[entries[1].messageId].sourceContentFingerprint = 'old-body';
    delete data.summaries[entries[2].messageId].sourceContentFingerprint;
    data.summaries[entries[3].messageId].status = 'orphaned';
    data.summaries[entries[4].messageId].event = '';
    data.summaries[entries[5].messageId].sourceValidity = 'unverified'; // Diagnostic flags alone do not invalidate matching content.
    const metadata = { cache_memory: data };
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const stats = memoryOverviewStats(store.current(), entries, normalizeSettings());
    assert.equal(stats.summaries.actual, 2); assert.equal(store.currentSummaries(chat).length, stats.summaries.actual);
    assert.deepEqual(stats.summaryDetails.filter(row => row.current).map(row => row.reason), ['body-mismatch', 'unverified', 'orphaned', 'empty']);
    assert.equal(summaryMatchesEntry(data.summaries[entries[2].messageId], entries[2]), false);
});

test('legacy missing fingerprints stay frozen without automatic regeneration and cannot enter CP inputs', async () => {
    const chat = [{ name: 'A', mes: '正文', gen_started: 'g' }], metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const entry = getAssistantMessages(chat)[0];
    store.addSummary({ messageId: entry.messageId, floor: 1, event: '旧摘要', status: 'frozen' });
    let calls = 0;
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(), apiClient: { complete: async () => { calls++; } } });
    await summarizer.summarizeLatest(); assert.equal(calls, 0);
    assert.equal(await summarizer.generateCheckpoint(1, 1), null); assert.equal(calls, 0);
    assert.equal(store.getSummary(entry.messageId).event, '旧摘要');
});

test('strict snapshots preserve published bytes, deduplicate only new current lines, and retain changed values', () => {
    const store = createEmptyStore('a'), settings = normalizeSettings();
    const cp = (id, start, text) => ({ id, startFloor: start, endFloor: start + 4, memoryKind: 'state', content: text, status: 'frozen' });
    const content = '[Characters]\n角色甲：\n- 身份：医生\n[Current State]\n- 角色甲 · 观察：Lv.1\n[Story So Far]\n因曾经的误会而作出承诺';
    store.checkpoints.push(cp('checkpoint-001', 1, content));
    refreshSnapshot(store, settings, 'new checkpoint'); const before = structuredClone(store.injectionSnapshot);
    put(store, 6, [skill]);
    assert.equal(refreshSnapshot(store, settings, 'new summary').value, before.value);
    store.checkpoints.push(cp('checkpoint-002', 6, content));
    refreshSnapshot(store, settings, 'new checkpoint');
    assert.deepEqual(store.injectionSnapshot.blocks[0], before.blocks[0]);
    const second = store.injectionSnapshot.blocks.find(row => row.id === 'checkpoint:checkpoint-002').text;
    assert.doesNotMatch(second, /身份：医生|观察：Lv.1/); assert.match(second, /因曾经的误会/);
    put(store, 11, [{ ...skill, value: 'Lv.2' }]);
    store.checkpoints.push(cp('checkpoint-003', 11, content)); refreshSnapshot(store, settings, 'new checkpoint');
    assert.match(store.injectionSnapshot.blocks.at(-1).text, /观察：Lv.2/);
    assert.deepEqual(store.checkpoints[0].content, content);
});

test('in-flight KEEP snapshots cannot reactivate manually resolved records', () => {
    const metadata = {}, store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    store.current().keepRegistry['KEEP-0001'] = { text: '约定', status: 'resolved', sourceFloor: 1 };
    store.applyKeepItems([{ id: 'KEEP-0001', text: '约定', status: 'active' }]);
    assert.equal(store.current().keepRegistry['KEEP-0001'].status, 'resolved');
});

test('an older tracked value cannot overwrite a newer long fact or discard its model update', () => {
    const store = createEmptyStore('a'); put(store, 1, [skill]);
    const fact = { id: 'fact-new', stateId: stateId(skill), text: '角色甲 · 观察：Lv.3', status: 'active', floor: 50 };
    const updates = [{ action: 'replace', id: 'fact-latest', previousId: fact.id, stateId: fact.stateId, text: '角色甲 · 观察：Lv.4' }];
    assert.deepEqual(trackedFactUpdates(updates, store, 100, [fact]), updates);
    store.longMemories.push({ id: 'long-001', startFloor: 1, endFloor: 50, memoryKind: 'facts', status: 'frozen', factUpdates: [{ action: 'add', ...fact }] });
    assert.equal(projectLongFacts(store, 100, { includeTracked: true }).facts[0].text, fact.text);
});

test('changing KEEP during a checkpoint request rejects the stale lifecycle and aggregate', async () => {
    const chat = [{ name: 'A', mes: '合成正文', gen_started: 'g' }], metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata() {} });
    const entry = getAssistantMessages(chat)[0];
    store.addSummary({ messageId: entry.messageId, floor: 1, event: '合成摘要', status: 'frozen', sourceContentFingerprint: entry.contentFingerprint });
    store.current().keepRegistry['KEEP-0001'] = { text: '约定', status: 'active', sourceFloor: 1 };
    let resolve;
    const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => normalizeSettings(), apiClient: { complete: () => new Promise(done => { resolve = done; }) } });
    const pending = summarizer.generateCheckpoint(1, 1);
    const rejected = assert.rejects(pending, error => error.code === 'SOURCE_CHANGED');
    store.current().keepRegistry['KEEP-0001'].status = 'resolved';
    resolve({ content: '[Current State]\n合成状态' });
    await rejected;
    assert.equal(store.current().keepRegistry['KEEP-0001'].status, 'resolved');
    assert.deepEqual(store.current().checkpoints, []);
});
