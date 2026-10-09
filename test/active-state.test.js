import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore, MemoryStore, normalizeStore, summaryVersion } from '../src/memory-store.js';
import { parseStateChanges, projectActiveState, stateContext, stateId, reconcileTrackedCheckpoint, trackedFactUpdates } from '../src/active-state.js';
import { getAssistantMessages } from '../src/utils.js';
import { projectLongFacts } from '../src/continuity.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { normalizeSettings } from '../src/defaults.js';
import { refreshSnapshot } from '../src/cache-control.js';

const task = { kind: 'thread', entity: '林/主角', key: '松开的那只手', value: '已发布，尚未入睡', status: 'active', condition: '维持到入睡前才能结算', lifetime: 'temporary', evidence: '系统正式发布任务', confirmed: true };
const skill = { kind: 'state', entity: '林/主角', key: '洞察', value: 'Lv.2', status: 'active', lifetime: 'permanent', evidence: '已获得洞察Lv.2', confirmed: true };
function put(store, floor, changes, extra = {}) {
    const id = `m${floor}`;
    store.summaries[id] = { messageId: id, floor, event: `event${floor}`, status: 'frozen', frozen: true, sourceFingerprint: `fp${floor}`, stateChanges: changes.map(item => ({ ...item, id: item.id ?? stateId(item) })), ...extra };
}

test('structured deltas require explicit confirmed flag and a verbatim source quote; unknown closures are rejected', () => {
    assert.equal(parseStateChanges(JSON.stringify([task]), task.evidence).length, 1);
    assert.deepEqual(parseStateChanges(JSON.stringify([{ ...task, confirmed: false }]), task.evidence), []);
    assert.deepEqual(parseStateChanges(JSON.stringify([task]), '世界书里的候选任务'), []);
    assert.deepEqual(parseStateChanges(JSON.stringify([{ ...task, status: 'completed' }]), task.evidence), []);
    assert.deepEqual(parseStateChanges('not json', task.evidence), []);
});

test('task persists through 100 quiet floors and ends only on an evidenced update under its stable ID', () => {
    const store = createEmptyStore('a'); put(store, 1, [task]);
    for (let floor = 2; floor <= 100; floor++) put(store, floor, []);
    assert.equal(projectActiveState(store)[0].status, 'active');
    const end = { ...task, id: stateId(task), status: 'completed', value: '结算完成', evidence: '系统确认任务完成，发放奖励' };
    put(store, 101, parseStateChanges(JSON.stringify([end]), end.evidence, projectActiveState(store)));
    const current = projectActiveState(store); assert.equal(current.length, 1); assert.equal(current[0].status, 'completed');
    assert.equal(current[0].history.length, 1); assert.equal(stateContext(store), '无');
    assert.match(stateContext(store, 100), /维持到入睡前/);
});

test('skill upgrade and numeric attribute replacement keep one current value per character with history', () => {
    const store = createEmptyStore('a'); put(store, 1, [skill, { ...skill, entity: '林/守卫' }, { ...skill, key: '力量', value: '10' }]);
    put(store, 2, [{ ...skill, value: 'Lv.3' }, { ...skill, key: '力量', value: '12' }]);
    const rows = projectActiveState(store); assert.equal(rows.length, 3);
    const hero = rows.find(item => item.id === stateId(skill)); assert.equal(hero.value, 'Lv.3'); assert.equal(hero.history[0].value, 'Lv.2');
    assert.equal(rows.find(item => item.entity === '林/守卫').value, 'Lv.2');
    assert.equal(rows.find(item => item.key === '力量').value, '12');
    const facts = trackedFactUpdates([{ action: 'add', text: '林/主角的洞察达到Lv.2' }], store, 2);
    assert.equal(facts.filter(item => item.id === hero.id).length, 1); assert.match(facts.find(item => item.id === hero.id).text, /Lv.3/);
    assert.equal(projectLongFacts(store, Infinity, { includeTracked: true }).facts.length, 3);
});

test('old source flags keep frozen state usable; explicit deletion remains excluded', () => {
    const store = createEmptyStore('a'); put(store, 1, [task, skill]); put(store, 2, [{ ...skill, value: 'Lv.3' }]);
    store.summaries.m2.status = 'stale'; store.summaries.m2.sourceValidity = 'changed';
    assert.equal(projectActiveState(store).find(item => item.kind === 'state').needsReview, false);
    assert.match(stateContext(store), /Lv.3/);
    store.summaries.m2.status = 'orphaned';
    store.summaries.m1.status = 'orphaned'; assert.ok(projectActiveState(store).every(item => item.needsReview));
    assert.equal(stateContext(store), '无');
});

test('manual corrections and completion persist without generating or refreshing frozen injection', () => {
    const metadata = { cache_memory: createEmptyStore('a') }, reasons = [];
    put(metadata.cache_memory, 1, [task, skill]);
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: () => {}, onChange: (_, reason) => reasons.push(reason) });
    store.editTrackedState({ ...task, id: stateId(task), sourceFloor: 1, status: 'cancelled', value: '系统取消' });
    store.editTrackedState({ ...skill, id: stateId(skill), sourceFloor: 1, value: 'Lv.4' });
    assert.deepEqual(reasons, ['state management', 'state management']);
    const reloaded = normalizeStore(JSON.parse(JSON.stringify(store.current())), 'a');
    assert.equal(projectActiveState(reloaded).find(item => item.kind === 'thread').status, 'cancelled');
    assert.equal(projectActiveState(reloaded).find(item => item.kind === 'state').value, 'Lv.4');
    put(reloaded, 2, [{ ...skill, value: 'Lv.5' }]);
    assert.equal(projectActiveState(reloaded).find(item => item.kind === 'state').value, 'Lv.5');
    assert.throws(() => store.editTrackedState({ ...skill, sourceFloor: 999 }), /来源/);
});

test('checkpoint retains quiet active tasks even if model omits them; completed tasks leave active section', () => {
    const store = createEmptyStore('a'); put(store, 1, [task]);
    assert.match(reconcileTrackedCheckpoint('[Open Threads]\n无', store, 50), /松开的那只手.*维持到入睡前/);
    put(store, 51, [{ ...task, status: 'completed', value: '结算完成' }]);
    assert.doesNotMatch(reconcileTrackedCheckpoint('[Open Threads]\n林/主角 · 松开的那只手：尚未入睡', store, 51), /尚未入睡/);
});

test('same Summary request extracts state, no additional calls; disabled mode preserves original request body', async () => {
    for (const enabled of [true, false]) {
        const settings = normalizeSettings({ activeStateEnabled: enabled }), metadata = {}, requests = [];
        const chat = [{ name: '林', mes: task.evidence, gen_started: 'one' }];
        const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: () => {} });
        const summarizer = new MemorySummarizer({ store, getChat: () => chat, getSettings: () => settings, apiClient: { complete: async request => {
            requests.push(request); return { content: `[SUMMARY]\n[Event]\n${task.evidence}\n[Open]\n松开的那只手\n[KEEP]\n无\n[Changes]\n${JSON.stringify([task])}` };
        } } });
        await summarizer.summarizeEntry(getAssistantMessages(chat)[0]);
        assert.equal(requests.length, 1); assert.equal(projectActiveState(store.current()).length, enabled ? 1 : 0);
        assert.equal(requests[0].userContent, task.evidence);
        assert.doesNotMatch(store.current().summaries[getAssistantMessages(chat)[0].messageId].keep, /confirmed/);
    }
});

test('source edits preserve frozen Summary/CP/Long; explicit deletion retains original records', () => {
    const chat = [1, 2].map(floor => ({ name: 'A', mes: `正文${floor}`, gen_started: `g${floor}` })), metadata = {};
    const store = new MemoryStore({ getMetadata: () => metadata, getChatId: () => 'a', saveMetadata: () => {} });
    for (const entry of getAssistantMessages(chat)) store.addSummary({ messageId: entry.messageId, sourceFingerprint: entry.fingerprint, sourceContentFingerprint: entry.contentFingerprint, floor: entry.floor, messageIndex: entry.messageIndex, event: 'test', status: 'frozen' });
    const versions = Object.fromEntries(Object.values(store.current().summaries).map(item => [item.messageId, summaryVersion(item)]));
    store.addCheckpoint({ id: 'checkpoint-001', startFloor: 1, endFloor: 2, content: 'CP', sourceVersions: versions, status: 'frozen' });
    store.addLongMemory({ id: 'long-001', startFloor: 1, endFloor: 2, checkpointIds: ['checkpoint-001'], status: 'frozen', content: 'Long' });
    chat[1].mes = '修改后的正文'; const before = structuredClone(chat); store.syncMessages(chat);
    assert.deepEqual(chat, before); assert.equal(Object.values(store.current().summaries)[0].status, 'frozen');
    assert.equal(store.current().checkpoints[0].status, 'frozen'); assert.equal(store.current().longMemories[0].status, 'frozen');
    chat.pop(); store.reconcileDeletion(chat); assert.equal(Object.keys(store.current().summaries).length, 2);
});

test('oversized frozen injection remains complete and only changes at publish boundaries', () => {
    const settings = normalizeSettings(), store = createEmptyStore('a');
    store.checkpoints = Array.from({ length: 30 }, (_, i) => ({ id: `checkpoint-${i}`, startFloor: i * 5 + 1, endFloor: i * 5 + 5, content: `剧情${i}\n${'汉'.repeat(2000)}`, status: 'frozen' }));
    refreshSnapshot(store, settings, 'new checkpoint');
    const frozen = store.injectionSnapshot.value;
    assert.ok(frozen.length > 60000); assert.equal(store.injectionSnapshot.budget, undefined);
    for (let i = 0; i < 30; i++) assert.ok(frozen.includes(`剧情${i}\n${'汉'.repeat(2000)}`));
    assert.equal(store.checkpoints.length, 30); assert.match(frozen, /剧情29/);
    put(store, 151, [task]); assert.equal(refreshSnapshot(store, settings, 'new summary').value, frozen);
});
