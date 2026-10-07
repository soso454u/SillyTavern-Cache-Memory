import { INJECTION_MODES } from './defaults.js?v=1.8.0';
import { collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, previousState, projectLongFacts, summaryText } from './continuity.js?v=1.8.0';

function byRange(a, b) {
    return Number(a.startFloor ?? a.floor) - Number(b.startFloor ?? b.floor);
}

export function buildInjection(store, settings) {
    if (!settings.enabled || settings.injectionMode === INJECTION_MODES.NONE) return '';
    if (settings.strictCacheMode) return store.injectionSnapshot?.value ?? '';
    const states = store.checkpoints.filter(item => isUsableMemory(item) && item.memoryKind === 'state').sort(byRange);
    const latest = states.at(-1);
    if (settings.memoryStrategy !== 'legacy' && (store.version >= 2 || latest || store.longMemories.some(item => item.memoryKind === 'facts'))) {
        const blocks = [];
        const legacyLatest = store.checkpoints.filter(isUsableMemory).sort(byRange).at(-1);
        const stateEnd = latest?.endFloor ?? legacyLatest?.endFloor ?? 0;
        const facts = formatLongFacts(projectLongFacts(store));
        if (facts !== '无') blocks.push(`[LONG_MEMORY]\n${facts}`);
        const keeps = formatKeepItems(collectKeepItems(store));
        if (keeps !== '无') blocks.push(`[KEEP]\n${keeps}`);
        if ([INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode) && stateEnd) {
            blocks.push(`[LATEST_CHECKPOINT | 截至第${stateEnd}层]\n${latest?.content ?? previousState(store, stateEnd + 1).content}`);
        }
        if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
            // Include every summary after the latest checkpoint; count limits must not create a gap.
            const summaries = Object.values(store.summaries).filter(item => isUsableMemory(item) && item.floor > stateEnd)
                .sort((a, b) => a.floor - b.floor);
            for (const item of summaries) blocks.push(`[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${summaryText(item)}`);
        }
        return blocks.length ? `<CACHE_MEMORY>\n\n${blocks.join('\n\n')}\n\n</CACHE_MEMORY>` : '';
    }
    const blocks = [];
    const longs = [...store.longMemories]
        .filter(item => item.frozen !== false && item.status !== 'failed')
        .sort(byRange);
    for (const item of longs) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);

    if ([INJECTION_MODES.CHECKPOINT_BOUNDARY, INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode)) {
        const coveredThrough = longs.at(-1)?.endFloor ?? 0;
        const checkpoints = [...store.checkpoints]
            .filter(item => item.frozen !== false && item.status !== 'failed' && item.endFloor > coveredThrough)
            .sort(byRange)
            .slice(-settings.recentCheckpointCount);
        for (const item of checkpoints) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);
    }

    if (settings.injectionMode === INJECTION_MODES.LONG_CHECKPOINT_RECENT) {
        const summaries = Object.values(store.summaries)
            .filter(item => ['frozen', 'manual-edited'].includes(item.status))
            .sort((a, b) => a.floor - b.floor)
            .slice(-settings.recentSummaryCount);
        for (const item of summaries) {
            blocks.push(`[RECENT_SUMMARY_${String(item.floor).padStart(3, '0')}]\n${item.title}\n人物：${item.characters}\n事件：${item.event}`);
        }
    }

    return blocks.length ? `<CACHE_MEMORY>\n\n${blocks.join('\n\n')}\n\n</CACHE_MEMORY>` : '';
}
