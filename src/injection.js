import { INJECTION_MODES } from './defaults.js?v=1.3.3';

function byRange(a, b) {
    return Number(a.startFloor ?? a.floor) - Number(b.startFloor ?? b.floor);
}

export function buildInjection(store, settings) {
    if (!settings.enabled || settings.injectionMode === INJECTION_MODES.NONE) return '';
    const blocks = [];
    const longs = [...store.longMemories]
        .filter(item => item.frozen !== false && item.status !== 'failed')
        .sort(byRange);
    for (const item of longs) blocks.push(`[${String(item.id).toUpperCase().replaceAll('-', '_')}]\n${item.content}`);

    if ([INJECTION_MODES.LONG_CHECKPOINT, INJECTION_MODES.LONG_CHECKPOINT_RECENT].includes(settings.injectionMode)) {
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
