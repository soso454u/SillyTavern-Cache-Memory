import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { currentInjectionBlocks } from '../src/injection.js';

for (const section of ['Stage Story', 'Story So Far', 'Events']) {
    test(`135 floors with ${section} keep 27 CP stories; two Long stories replace only their covered 20 CPs`, () => {
        const store = createEmptyStore('a'), settings = normalizeSettings({ injectionMode: 'checkpoint_boundary' });
        for (let n = 1; n <= 27; n++) store.checkpoints.push({ id: `checkpoint-${n}`, memoryKind: 'state',
            startFloor: n * 5 - 4, endFloor: n * 5, status: 'frozen', content: `[CHECKPOINT]\n[${section}]\n第${n}阶段：守卫交还钥匙并承诺“天亮前回来”。\n[Characters]\n医师是守卫的姐姐\n[Current State]\n当时地点${n}\n[Secrets & Knowledge]\n医师知道密道，守卫不知道。` });
        const originals = structuredClone(store.checkpoints);
        store.injectionSnapshot = { mode: settings.injectionMode, value: '此前只注入最新CP的冻结字节', blocks: [] };
        for (const reason of ['chat changed', 'new summary', 'state management']) assert.equal(refreshSnapshot(store, settings, reason).value, '此前只注入最新CP的冻结字节');
        const text = refreshSnapshot(store, settings, 'manual reinject').value;
        const cps = store.injectionSnapshot.blocks.filter(block => block.type === 'checkpoint');
        assert.equal(cps.length, 27);
        for (let n = 1; n <= 27; n++) {
            const block = cps.find(block => block.startFloor === n * 5 - 4);
            assert.equal(block.endFloor, n * 5); assert.match(block.text, new RegExp(`第${n}阶段`));
            assert.match(block.text, /交还钥匙[\s\S]*天亮前回来/);
            assert.doesNotMatch(block.text, /当时地点|\[Characters\]|\[Current State\]/);
        }
        assert.equal(store.injectionSnapshot.blocks.filter(block => block.type === 'legacy-context').length, 1);
        assert.match(text, /医师知道密道，守卫不知道/); assert.doesNotMatch(text, /当时地点26(?:\n|$)/);
        for (let n = 1; n <= 2; n++) store.longMemories.push({ id: `long-${n}`, startFloor: n * 50 - 49,
            endFloor: n * 50, status: 'frozen', content: `[STORY_ARC]\n第${n}段长期剧情：钥匙交还、承诺及后续后果。` });
        assert.equal(refreshSnapshot(store, settings, 'new summary').value, text);
        refreshSnapshot(store, settings, 'new long memory');
        const covered = store.injectionSnapshot.blocks;
        assert.equal(covered.filter(block => block.type === 'long-story').length, 2);
        assert.deepEqual(covered.filter(block => block.type === 'checkpoint').map(block => [block.startFloor, block.endFloor]),
            [[101,105],[106,110],[111,115],[116,120],[121,125],[126,130],[131,135]]);
        assert.deepEqual(store.checkpoints, originals); assert.equal(store.longMemories.length, 2);
    });
}

test('an old state-only CP retains its sole historical record instead of silently losing the stage', () => {
    const store = createEmptyStore('a');
    store.checkpoints.push({ id: 'cp-1', startFloor: 1, endFloor: 5, status: 'frozen', memoryKind: 'state',
        content: '[CHECKPOINT]\n[Current State]\n旅人交出钥匙，守卫当面拒收。' });
    const original = structuredClone(store);
    const cp = currentInjectionBlocks(store, normalizeSettings({ injectionMode: 'checkpoint_boundary' })).find(block => block.type === 'checkpoint');
    assert.match(cp.text, /历史剧情[\s\S]*历史记录[\s\S]*旅人交出钥匙，守卫当面拒收/);
    assert.deepEqual(store, original);
});
