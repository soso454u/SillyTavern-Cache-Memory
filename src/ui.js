import { bindDialogViewport, resolveUIRoot, viewportSize } from './ui-context.js?v=1.22.9';
import { effectiveInjectionMode } from './cache-control.js?v=1.22.9';
import { API_PROVIDERS, DEFAULT_PROMPTS, GENERATION_TRANSPORTS, LEGACY_PROMPTS, INJECTION_MODES, PLUGIN_VERSION, THINKING_MODES } from './defaults.js?v=1.22.9';
import { HistoryBackfill } from './history-backfill.js?v=1.22.9';
import { downloadJson, formatDate, getAssistantMessages } from './utils.js?v=1.22.9';
import { collectKeepItems, isUsableMemory, projectLongFacts, readSection } from './continuity.js?v=1.22.9';
import { buildStructuredSummary } from './summary-format.js?v=1.22.9';
import { SUMMARY_FILTER_MODES } from './summary-source.js?v=1.22.9';
import { API_CACHE_COMPATIBILITY } from './api-cache-adapter.js?v=1.22.9';
import { parseFloorSummary } from './summarizer.js?v=1.22.9';
import { projectActiveState, isTrackedActive } from './active-state.js?v=1.22.9';

import { memoryHealth, summaryForEntry, currentSummaryHealth, mergeMemoryStores, memoryContentDigest } from './memory-store.js?v=1.22.9';
import { inspectMemoryImport, prepareMemoryImport } from './memory-import.js?v=1.22.9';

const STYLE_ID = 'cache-memory-parent-style';
const OWNER_KEY = '__cacheMemoryUIOwner';
const ROOT_ID = 'cache-memory-settings';
const CONFIG_ID = 'cache-memory-config';
const MANAGER_ID = 'cache-memory-manager';
const WAND_CONTAINER_ID = 'cache-memory-wand-container';
const WAND_ENTRY_ID = 'cache-memory-wand-entry';

const CHECKPOINT_SECTIONS = Object.freeze([
    ['storySoFar', 'Story So Far', '必要前情'],
    ['characters', 'Characters', '人物状态'],
    ['currentState', 'Current State', '当前世界状态'],
    ['secretsKnowledge', 'Secrets & Knowledge', '秘密与认知差'],
    ['openThreads', 'Open Threads', '未解决事项'],
    ['continuityLocks', 'Continuity Locks', '连续性锁'],
]);

export function estimateTokenCount(value) {
    let tokens = 0;
    let asciiLength = 0;
    const flushAscii = () => {
        tokens += Math.ceil(asciiLength / 4);
        asciiLength = 0;
    };
    for (const character of String(value ?? '')) {
        if (character.codePointAt(0) <= 0x7f) {
            if (!/\s/.test(character)) asciiLength += 1;
        } else {
            flushAscii();
            if (!/\s/u.test(character)) tokens += 1;
        }
    }
    flushAscii();
    return tokens;
}

function completedRanges(latestFloor, interval) {
    const ranges = [];
    for (let startFloor = 1; startFloor + interval - 1 <= latestFloor; startFloor += interval) {
        ranges.push([startFloor, startFloor + interval - 1]);
    }
    return ranges;
}

function compactRanges(ranges) {
    const labels = ranges.slice(0, 4).map(([start, end]) => `第${start}–${end}层`);
    return `${labels.join('、')}${ranges.length > labels.length ? ` 等 ${ranges.length} 段` : ''}`;
}

export function summaryHealthDetails(store, assistants) {
    const summaries = store?.summaries && typeof store.summaries === 'object' ? store.summaries : {};
    const entries = Array.isArray(assistants) ? assistants : [];
    const matched = new Set();
    const details = [];
    for (const entry of entries) {
        const record = summaryForEntry(store, entry);
        if (record) matched.add(record);
        const health = currentSummaryHealth(record, entry);
        if (health.code !== 'valid') details.push({ floor: entry.floor, messageId: entry.messageId, reason: health.code, label: health.label, current: true });
    }
    for (const [key, record] of Object.entries(summaries)) {
        if (matched.has(record)) continue;
        const id = String(record?.messageId || key);
        const related = entries.find(entry => entry.relatedMessageIds?.includes(key)
            || record.sourceMessageKey && record.sourceMessageKey === entry.sourceMessageKey
            || entry.messageId === id);
        const reason = record?.status === 'orphaned' ? 'orphaned' : related ? 'old-version' : 'source-unloaded';
        const label = reason === 'orphaned' ? '旧消息 / 旧版本来源已失效（orphaned），摘要仍保留' : reason === 'old-version'
            ? '当前消息的旧版本 / 重复存储记录，未参与整理' : '来源消息当前未加载；摘要保留且不自动判定 orphaned';
        details.push({ floor: Number(record?.floor) || 0, messageId: id, reason, label, current: false });
    }
    return details.sort((a, b) => a.floor - b.floor || a.messageId.localeCompare(b.messageId));
}

export function memoryOverviewStats(store, assistants, settings) {
    const safeStore = {
        summaries: {}, checkpoints: [], longMemories: [], keepRegistry: {},
        ...(store && typeof store === 'object' ? store : {}),
    };
    const entries = Array.isArray(assistants) ? assistants : [];
    const checkpointInterval = Math.max(1, Number(settings?.checkpointInterval) || 5);
    const longMemoryInterval = Math.ceil(Math.max(checkpointInterval, Number(settings?.longMemoryInterval) || 50) / checkpointInterval) * checkpointInterval;
    const latestFloor = entries.at(-1)?.floor ?? 0;
    const checkpoints = safeStore.checkpoints.filter(isUsableMemory);
    const longMemories = safeStore.longMemories.filter(isUsableMemory);
    const checkpointRanges = completedRanges(latestFloor, checkpointInterval);
    const longRanges = completedRanges(latestFloor, longMemoryInterval);
    const summaryDetails = summaryHealthDetails(safeStore, entries);
    const currentIssues = summaryDetails.filter(item => item.current);
    const usableSummaries = entries.filter(entry => currentSummaryHealth(summaryForEntry(safeStore, entry), entry).code === 'valid');
    const generatedSummaries = entries.filter(entry => {
        const row = summaryForEntry(safeStore, entry);
        return row && row.status !== 'failed' && row.frozen !== false && ['raw', 'event', 'state', 'open', 'keep', 'quote'].some(key => String(row[key] ?? '').trim());
    });
    const missingCheckpointRanges = checkpointRanges.filter(([start, end]) => !checkpoints.some(item => item.startFloor === start && item.endFloor === end));
    const missingSummaryFloors = currentIssues.map(item => item.floor);
    const missingLongRanges = longRanges.filter(([start, end]) => !longMemories.some(item => item.startFloor === start && item.endFloor === end));
    const longDueThrough = longRanges.at(-1)?.[1] ?? 0;
    const checkpointGapsBlockingLong = missingCheckpointRanges.filter(([, end]) => end <= longDueThrough);
    const issues = [];
    if (missingSummaryFloors.length) {
        const labels = currentIssues.slice(0, 8).map(item => `第${item.floor}层：${item.label}`);
        issues.push(`Summary 待处理 ${missingSummaryFloors.length} 层（${labels.join('；')}）；对应 Checkpoint 需先修复来源。`);
    }
    const aggregateDetails = [];
    for (const [type, ranges, list] of [['Checkpoint', missingCheckpointRanges, safeStore.checkpoints], ['Long Memory', missingLongRanges, safeStore.longMemories]]) {
        for (const [start, end] of ranges) {
            const item = list.find(row => row.startFloor === start && row.endFloor === end);
            aggregateDetails.push({ type, id: item?.id, startFloor: start, endFloor: end, ...memoryHealth(item) });
        }
        const details = aggregateDetails.filter(row => row.type === type);
        if (details.length) issues.push(`${type} 待处理 ${details.length} 段（${details.slice(0, 8).map(row => `${row.id || '未生成'} 第${row.startFloor}–${row.endFloor}层：${row.label}`).join('；')}）。`);
    }
    const injectionValue = String(safeStore.injectionSnapshot?.value ?? '');
    const blockCount = (safeStore.injectionSnapshot?.blocks ?? []).filter(block => block.type === 'checkpoint').length;
    const textCount = injectionValue.match(/^\[(?:LATEST_)?CHECKPOINT(?:_[^\]\n]+)?(?:\s*\|[^\]\n]+)?\]/gm)?.length ?? 0;
    return {
        summaries: { actual: usableSummaries.length, generated: generatedSummaries.length, expected: entries.length },
        checkpoints: { actual: checkpoints.length, expected: checkpointRanges.length },
        longMemories: { actual: longMemories.length, expected: longRanges.length },
        activeLongFacts: projectLongFacts(safeStore).facts.filter(item => isTrackedActive(item)).length,
        activeKeeps: collectKeepItems(safeStore).filter(item => isTrackedActive(item)).length,
        injectedCheckpoints: Math.max(blockCount, textCount),
        estimatedTokens: estimateTokenCount(injectionValue),
        recentBodyWindow: '由 SillyTavern 上下文设置控制',
        storedSummaryRecords: Object.keys(safeStore.summaries).length,
        summaryDetails, aggregateDetails,
        issues,
    };
}

export function parseCheckpointSections(content) {
    const text = String(content ?? '');
    if (!/^\s*\[CHECKPOINT\]\s*$/im.test(text)) return null;
    const fields = Object.fromEntries(CHECKPOINT_SECTIONS.map(([key, section]) => [key, readSection(text, section)]));
    return Object.values(fields).some(Boolean) ? fields : null;
}

export function buildCheckpointContent(fields) {
    return ['[CHECKPOINT]', ...CHECKPOINT_SECTIONS.flatMap(([key, section]) => [`[${section}]`, String(fields[key] ?? '').trim() || '无'])]
        .join('\n');
}

function notify(type, message) {
    const root = resolveUIRoot();
    const owner = root.window?.[OWNER_KEY] ?? root[OWNER_KEY];
    if (owner?.config && !owner.config.hidden) {
        owner.setStatus(type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'success', message);
        return;
    }
    const toaster = root.toastr;
    if (toaster?.[type]) toaster[type](message, 'Cache Memory');
    else console[type === 'error' ? 'error' : 'info']('[Cache Memory]', message);
}

export function formatModelListFailure(result) {
    const diagnostics = result?.diagnostics ?? {};
    const lines = [
        '模型列表获取失败',
        `URL: ${diagnostics.endpoint || '未知'}`,
        `状态: ${diagnostics.upstream && !diagnostics.upstream.startsWith('未提供') ? diagnostics.upstream : diagnostics.proxy || '未知'}`,
    ];
    const responseBody = diagnostics.proxyBody || diagnostics.directBody;
    const exception = diagnostics.proxyException || diagnostics.directException;
    if (responseBody) lines.push(`响应（前 500 字）: ${responseBody}`);
    if (exception) lines.push(`错误: ${exception}`);
    lines.push('疑似 CORS: 否（请求由 SillyTavern 同源后端转发）');
    if (diagnostics.proxyEndpoint) lines.push(`代理 URL: ${diagnostics.proxyEndpoint}`);
    if (diagnostics.proxy && diagnostics.proxy !== '未请求') lines.push(`代理状态: ${diagnostics.proxy}`);
    const repeatedBody = /^HTTP \d+:/.test(result?.error ?? '')
        && [diagnostics.directBody, diagnostics.proxyBody].some(body => body && result.error.endsWith(body));
    if (result?.error && !repeatedBody && result.error !== exception) {
        lines.push(`错误: ${result.error}`);
    }
    return lines.join('\n');
}

export function formatConnectionFailure(error) {
    const d = error.diagnostics ?? {};
    const upstream = String(d.upstream || '未提供').replace(/^HTTP\s+/i, '');
    const categoryLabels = {
        authentication_error: 'API Key / 鉴权错误', permission_error: '权限错误', endpoint_error: 'Endpoint / 路径错误',
        rate_limit_error: '限流', upstream_error: '上游服务异常', timeout: '请求超时',
        proxy_error: 'SillyTavern 后端代理错误', network_error: '服务端网络错误', cancelled: '请求已取消',
    };
    return ['连接失败', `URL: ${d.endpoint || '未知'}`, `代理状态：${d.proxy || '未请求'}`,
        `上游 HTTP：${upstream}`, `错误类型：${categoryLabels[error.category] || '未知错误'}`,
        `响应前 500 字：${d.proxyBody || '无可读取响应'}`, `错误：${error.message}`].join('\n');
}

export function formatSummaryFailure(record) {
    const d = record.errorDiagnostics;
    if (!d) return record.error || '未知错误';
    const upstream = d.upstream?.match(/^HTTP (\d+)/)?.[1];
    const category = record.errorCode === 'REQUEST_TIMEOUT' ? '客户端超时（达到插件超时设置）'
        : upstream === '504' ? '上游 HTTP 504（网关超时）'
        : record.errorCategory === 'proxy_error' ? 'SillyTavern 后端或其网关失败'
        : upstream ? `上游 HTTP ${upstream}` : 'SillyTavern 后端返回失败（上游状态未提供）';
    return `${category}\n${record.error || '未知错误'}\n代理状态：${d.proxy || '未知'}\n上游状态：${d.upstream || '未提供'}`;
}

function settingsHost(doc) {
    return doc.querySelector('#extensions_settings2')
        ?? doc.querySelector('#extensions_settings')
        ?? doc.querySelector('#extensions_settings_block');
}

function settingsTemplate() {
    return `
        <div id="${ROOT_ID}" class="inline-drawer cache-memory-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>缓存记忆</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cache-memory-status" data-cache-status data-state="idle">等待生成</div>
                <div class="cache-memory-launcher-options">
                    <label class="checkbox_label"><input type="checkbox" data-setting="enabled"><span>启用缓存记忆</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-setting="showWandButton"><span>在魔法棒菜单中显示</span></label>
                </div>
                <div class="cache-memory-actions cache-memory-launcher-actions">
                    <button type="button" class="menu_button" data-open-settings><i class="fa-solid fa-sliders"></i> 打开设置</button>
                    <button type="button" class="menu_button" data-open-manager><i class="fa-solid fa-box-archive"></i> 记忆管理</button>
                </div>
                <small class="cache-memory-version">v${PLUGIN_VERSION}</small>
            </div>
        </div>`;
}

function managerPanelTemplate() {
    return `
        <section id="${MANAGER_ID}" class="cache-memory-tab-panel cache-memory-manager-panel" role="tabpanel" data-settings-panel="manager" hidden>
            <nav class="cache-memory-manager-tabs" aria-label="记忆管理页面">
                <button type="button" data-manager-view="overview">概览</button><button type="button" data-manager-view="summaries">楼层摘要</button><button type="button" data-manager-view="checkpoints">阶段记忆</button><button type="button" data-manager-view="long">长期记忆 Long Memory</button><button type="button" data-manager-view="facts">长期事实</button><button type="button" data-manager-view="keeps">KEEP</button><button type="button" data-manager-view="threads">未解决事项</button><button type="button" data-manager-view="states">角色状态</button>
            </nav>
            <div class="cache-memory-manager-toolbar">
                <button type="button" class="menu_button" data-save-memory>上传记忆到服务器</button>
                <button type="button" class="menu_button" data-read-server>从服务器恢复记忆</button>
                <button type="button" class="menu_button" data-export><i class="fa-solid fa-download"></i> 下载记忆 JSON</button>
                <button type="button" class="menu_button" data-import-merge><i class="fa-solid fa-upload"></i> 导入记忆 JSON</button>
                <input type="file" accept="application/json,.json" data-import-merge-file hidden>
            </div>
            <details class="cache-memory-backup"><summary>保存与诊断</summary>
            <div class="cache-memory-actions cache-memory-manager-toolbar">
                <button type="button" class="menu_button" data-validate-memory>检查记忆状态</button>
                <button type="button" class="menu_button" data-reinject>重新注入</button>
                <button type="button" class="menu_button" data-reparse-summaries>重新解析摘要</button>
            </div><p data-memory-diagnostics></p>
            <div class="cache-memory-manager-toolbar">
                <button type="button" class="menu_button cache-memory-danger" data-clear-current-chat><i class="fa-solid fa-triangle-exclamation"></i> 清空当前聊天记忆</button>
            </div>
            <div>
                <div class="cache-memory-actions" data-memory-conflict-actions hidden>
                    <button type="button" class="menu_button" data-memory-conflict="merge">合并双方</button>
                    <button type="button" class="menu_button" data-memory-conflict="export">导出冲突副本</button>
                    <button type="button" class="menu_button cache-memory-danger" data-memory-conflict="server">以服务器为准</button>
                    <button type="button" class="menu_button cache-memory-danger" data-memory-conflict="local">以本机为准</button>
                </div>
            </div>
            <div data-conflict-details></div>
            </details>
            <div class="cache-memory-save-state" data-memory-save-box data-state="unknown"><strong>记忆保存状态：</strong><span data-memory-save-status>状态未知</span></div>
            <div class="cache-memory-manager-content" data-manager-content></div>
        </section>`;
}

export function configTemplate() {
    return `
        <div id="${CONFIG_ID}" class="cache-memory-overlay" hidden>
            <div class="cache-memory-config-frame">
            <div class="cache-memory-config-panel" role="dialog" aria-modal="true" aria-labelledby="cache-memory-config-title">
                <div class="cache-memory-pinned">
                <header class="cache-memory-dialog-header">
                    <div class="cache-memory-dialog-title" title="拖动标题栏移动弹窗">
                        <i class="fa-solid fa-brain" aria-hidden="true"></i>
                        <div><h3 id="cache-memory-config-title">缓存记忆</h3><small>自动整理剧情，保留关键细节</small></div>
                    </div>
                    <button type="button" class="menu_button cache-memory-icon-button" data-settings-close title="关闭" aria-label="关闭"><span aria-hidden="true">×</span></button>
                </header>
                <div class="cache-memory-task-feedback cache-memory-status" data-cache-status data-state="idle" role="status" aria-live="polite" hidden></div>
                <div class="cache-memory-config-status cache-memory-status" data-freeze-status data-state="success" hidden></div>
                <nav class="cache-memory-tabs" role="tablist" aria-label="Cache Memory 设置">
                    <button type="button" class="cache-memory-tab is-active" role="tab" aria-selected="true" data-settings-tab="general"><i class="fa-solid fa-layer-group"></i><span>常规</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="manager"><i class="fa-solid fa-box-archive"></i><span>记忆管理</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="api"><i class="fa-solid fa-key"></i><span>模型接口</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="injection"><i class="fa-solid fa-syringe"></i><span>记忆注入</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="prompts"><i class="fa-solid fa-file-lines"></i><span>提示词</span></button>
                </nav>
                </div>
                <div class="cache-memory-config-content">
                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="general">
                        <div class="cache-memory-section-heading"><div><h4>运行与分层</h4><p>控制摘要生成和冻结记忆的楼层范围。</p></div></div>
                        <div class="cache-memory-switches">
                            <label class="cache-memory-toggle"><span><strong>启用插件</strong><small>显示楼层记忆并启用处理流程</small></span><input type="checkbox" data-setting="enabled"></label>
                            <label class="cache-memory-toggle"><span><strong>自动生成小总结</strong><small>正常回复结束后自动排队</small></span><input type="checkbox" data-setting="autoSummarize"></label>
                            <label class="cache-memory-toggle"><span><strong>任务与角色状态管理</strong><small>复用摘要请求；每层保存，仍只在原缓存边界发布</small></span><input type="checkbox" data-setting="activeStateEnabled"></label>
                            <label class="cache-memory-toggle"><span><strong>使用独立模型接口</strong><small>不占用 SillyTavern 当前聊天模型</small></span><input type="checkbox" data-setting="independentApi"></label>
                            <label class="cache-memory-toggle"><span><strong>严格缓存模式</strong><small>小总结仅后台保存，主 Prompt 只在边界更新</small></span><input type="checkbox" data-setting="strictCacheMode"></label>
                            <label class="cache-memory-toggle"><span><strong>魔法棒菜单入口</strong><small>在输入框旁的扩展菜单中显示</small></span><input type="checkbox" data-setting="showWandButton"></label>
                        </div>
                        <div class="cache-memory-grid">
                            <label>记忆策略<select data-setting="memoryStrategy"><option value="incremental">增量状态 + 长期事实 + KEEP</option><option value="legacy">兼容旧版分段摘要</option></select></label>
                            <label>过滤策略<select data-setting="summaryFilterMode"><option value="${SUMMARY_FILTER_MODES.DEFAULT}">默认（推荐）</option><option value="${SUMMARY_FILTER_MODES.CUSTOM}">自定义标签</option><option value="${SUMMARY_FILTER_MODES.FULL}">不过滤（完整正文）</option></select></label>
                            <label data-custom-filter>正文标签（按优先级，用逗号或换行分隔）<textarea rows="3" data-setting="summaryFilterTags" placeholder="content, context, story"></textarea></label>
                            <label>阶段记忆间隔（层）<input type="number" min="1" max="1000" data-setting="checkpointInterval"></label>
                            <label>长期记忆间隔（层）<input type="number" min="1" max="10000" data-setting="longMemoryInterval"></label>
                            <label>小总结目标长度<input type="number" min="50" data-setting="summaryMaxLength"></label>
                            <label>阶段状态目标长度<input type="number" min="100" data-setting="checkpointMaxLength"></label>
                            <label>长期事实目标长度<input type="number" min="200" data-setting="longMemoryMaxLength"></label>
                            <label data-legacy-setting>旧版近期小总结数量<input type="number" min="0" data-setting="recentSummaryCount"></label>
                            <label data-legacy-setting>旧版近期阶段记忆数量<input type="number" min="0" data-setting="recentCheckpointCount"></label>
                        </div>
                        <small class="cache-memory-help">默认每 5 层提交 Checkpoint、每 50 层提交分段 Long Memory；已有自定义间隔保留。后台增量状态和 KEEP 不会逐层刷新严格模式的 Prompt。</small>
                    </section>
                    ${managerPanelTemplate()}

                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="api" hidden>
                        <div class="cache-memory-section-heading"><div><h4>模型接口</h4><p>统一使用 OpenAI 兼容接口。</p></div></div>
                        <div class="cache-memory-api-guide"><i class="fa-solid fa-circle-info"></i><span><strong>设置顺序：</strong>填写接口地址 → 保存密钥 → 获取模型或手动填写 → 测试连接。密钥只保存在当前浏览器。</span></div>
                        <div class="cache-memory-grid">
                            <label>接口类型<input type="text" value="OpenAI 兼容接口" readonly></label>
                            <label>接口地址<input type="url" data-setting="apiBaseUrl" placeholder="例如：https://example.com/v1"></label>
                            <label>API 密钥<input type="password" data-api-key autocomplete="off" placeholder="未配置"></label>
                            <label>摘要模型<input type="text" data-setting="model" placeholder="可手动填写模型名称"><select data-model-list data-model-select aria-label="从完整模型列表选择"><option value="">获取列表后可在此选择模型</option></select></label>
                            <label>创造性（0 更稳定）<input type="number" min="0" max="2" step="0.05" data-setting="temperature"></label>
                            <label>小总结 max tokens<input type="number" min="32" data-setting="summaryMaxTokens"></label>
                            <label>Checkpoint max tokens<input type="number" min="32" data-setting="checkpointMaxTokens"></label>
                            <label>Long Memory max tokens<input type="number" min="32" data-setting="longMemoryMaxTokens"></label>
                            <label>输出上限参数<select data-setting="tokenLimitParameter"><option value="max_tokens">max_tokens（默认）</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
                            <label>超时时间（毫秒）<input type="number" min="1000" step="1000" data-setting="timeoutMs"></label>
                            <label>生成传输<select data-setting="generationTransport"><option value="${GENERATION_TRANSPORTS.AUTO}">自动（推荐，优先流式）</option><option value="${GENERATION_TRANSPORTS.STREAM}">流式</option><option value="${GENERATION_TRANSPORTS.NON_STREAM}">非流式</option></select></label>
                            <label>思考模式<select data-setting="thinkingMode"><option value="${THINKING_MODES.DISABLED}">关闭思考（推荐）</option><option value="${THINKING_MODES.AUTO}">自动</option><option value="${THINKING_MODES.ENABLED}">开启思考</option></select></label>
                        </div>
                        <div class="cache-memory-actions">
                            <button type="button" class="menu_button" data-save-api-key><i class="fa-solid fa-key"></i> 保存密钥</button>
                            <button type="button" class="menu_button cache-memory-primary" data-list-models><i class="fa-solid fa-arrows-rotate"></i> 获取模型列表</button>
                            <button type="button" class="menu_button" data-test-api="stream"><i class="fa-solid fa-bolt"></i> 极速流式测试</button>
                            <button type="button" class="menu_button" data-test-api="non-stream"><i class="fa-solid fa-stopwatch"></i> 非流式诊断测试</button>
                            <button type="button" class="menu_button" data-clear-api-key><i class="fa-solid fa-trash"></i> 清除密钥</button>
                        </div>
                        <small class="cache-memory-key-state" data-api-key-state></small>
                        <small class="cache-memory-warning">安全提示：API 密钥只保存在当前浏览器，不会写入聊天记录。所有第三方模型请求均由 SillyTavern 同源后端转发，浏览器不会跨域直连。</small>
                        <small class="cache-memory-help">模型输入框支持手动填写和下拉选择；获取列表失败时不会影响手动填写与测试连接。</small>
                        <small class="cache-memory-help">新配置默认超时 180000 毫秒。已有超时设置保留；若已调高但仍约 60 秒返回 504，请检查服务器前的网关超时设置。</small>
                        <section class="cache-memory-api-adapter">
                            <div class="cache-memory-section-heading"><div><h4>API 缓存适配器（可选）</h4><p>控制主模型请求的缓存断点；实际结构改写只在 SillyTavern 服务端完成。</p></div></div>
                            <label class="cache-memory-toggle"><span><strong>启用服务端缓存适配器</strong><small>服务端插件缺失或接口不兼容时保持原请求</small></span><input type="checkbox" data-setting="apiCacheAdapterEnabled"></label>
                            <div class="cache-memory-adapter-connection"><strong>当前连接：</strong><span data-api-cache-connection>尚未识别</span></div>
                            <div class="cache-memory-switches">
                                <label class="cache-memory-toggle"><span><strong>启用此连接策略</strong><small>按主模型 API 连接分别保存</small></span><input type="checkbox" data-api-cache-policy="enabled"></label>
                                <label class="cache-memory-toggle"><span><strong>固定设定断点</strong><small>只选择独立、非空的前置 system 消息块</small></span><input type="checkbox" data-api-cache-policy="cacheStatic"></label>
                                <label class="cache-memory-toggle"><span><strong>冻结记忆断点</strong><small>识别 CACHE_MEMORY / Checkpoint / Long Memory</small></span><input type="checkbox" data-api-cache-policy="cacheMemory"></label>
                                <label class="cache-memory-toggle"><span><strong>滚动历史断点</strong><small>按独立 user / assistant 消息块选择</small></span><input type="checkbox" data-api-cache-policy="cacheHistory"></label>
                            </div>
                            <div class="cache-memory-grid">
                                <label>缓存 TTL<select data-api-cache-policy="ttl"><option value="5m">5 分钟</option><option value="1h">1 小时</option></select></label>
                                <label>历史断点深度<input type="number" min="1" max="64" data-api-cache-policy="historyDepth"></label>
                                <label>接口兼容模式<select data-api-cache-policy="compatibility"><option value="${API_CACHE_COMPATIBILITY.AUTO}">自动检测（仅确认兼容时启用）</option><option value="${API_CACHE_COMPATIBILITY.ANTHROPIC_BLOCKS}">Anthropic 内容块（手动确认）</option></select></label>
                            </div>
                            <div class="cache-memory-actions">
                                <button type="button" class="menu_button" data-api-cache-probe><i class="fa-solid fa-server"></i> 检测服务端适配器</button>
                                <button type="button" class="menu_button" data-api-cache-reset><i class="fa-solid fa-arrow-rotate-left"></i> 此连接恢复默认</button>
                            </div>
                            <div class="cache-memory-adapter-status" data-api-cache-status data-state="idle">尚未检测服务端适配器</div>
                            <pre class="cache-memory-continuity" data-api-cache-preview hidden></pre>
                            <small class="cache-memory-warning">Claude 原生源的官方缓存由 ST 服务端 config.yaml 管理，本适配器不会覆盖。自动模式只对确认支持内容块 cache_control 的连接生效；检测到 New API 已有缓存字段时会旁路，避免双重改写。</small>
                        </section>
                    </section>

                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="injection" hidden>
                        <div class="cache-memory-section-heading"><div><h4>记忆注入</h4><p>选择发送请求时附加到上下文的冻结记忆层。</p></div></div>
                        <label class="cache-memory-field">注入范围<select data-setting="injectionMode"><option value="${INJECTION_MODES.NONE}">不注入（缓存最安全）</option><option value="${INJECTION_MODES.CHECKPOINT_BOUNDARY}">Checkpoint 边界（新安装默认）</option><option value="${INJECTION_MODES.LONG_BOUNDARY}">Long Memory 边界</option><option value="${INJECTION_MODES.LONG}">仅长期记忆</option><option value="${INJECTION_MODES.LONG_CHECKPOINT}">长期记忆 + 阶段记忆</option><option value="${INJECTION_MODES.LONG_CHECKPOINT_RECENT}">长期记忆 + 阶段记忆 + 近期小总结</option></select></label>
                        <div class="cache-memory-note"><i class="fa-solid fa-shield-halved"></i><span>严格模式不注入逐层小总结；Checkpoint / Long Memory 提交后更新一次，其余楼层逐字冻结。Long Memory 边界可替换其覆盖的阶段注入，原始记录仍保留。</span></div>
                        <p class="cache-memory-warning" data-cache-mode-warning></p>
                        <label class="cache-memory-toggle"><span><strong>Cache Debug / 缓存诊断</strong><small>仅记录 hash、过滤来源和字符数；不记录正文</small></span><input type="checkbox" data-setting="cacheDebug"></label>
                        <pre class="cache-memory-continuity" data-cache-debug hidden></pre>
                    </section>

                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="prompts" hidden>
                        <div class="cache-memory-section-heading"><div><h4>提示词</h4><p>分别编辑每一种记忆层使用的系统提示词；不熟悉时保持默认即可。</p></div></div>
                        <details><summary>小总结提示词</summary><textarea rows="12" data-prompt="summary"></textarea><button type="button" class="menu_button" data-reset-prompt="summary"><i class="fa-solid fa-arrow-rotate-left"></i> 恢复默认</button></details>
                        <details><summary>阶段记忆提示词</summary><textarea rows="12" data-prompt="checkpoint"></textarea><button type="button" class="menu_button" data-reset-prompt="checkpoint"><i class="fa-solid fa-arrow-rotate-left"></i> 恢复默认</button></details>
                        <details><summary>长期记忆提示词</summary><textarea rows="10" data-prompt="longMemory"></textarea><button type="button" class="menu_button" data-reset-prompt="longMemory"><i class="fa-solid fa-arrow-rotate-left"></i> 恢复默认</button></details>
                    </section>
                </div>
                <footer class="cache-memory-settings-save">
                    <span data-settings-save-state data-state="saved">已保存</span>
                    <button type="button" class="menu_button cache-memory-primary" data-save-settings><i class="fa-solid fa-floppy-disk"></i> 保存设置</button>
                </footer>
            </div>
            ${['n', 'e', 's', 'w'].map(edge => `<span class="cache-memory-resize-handle" data-resize-edge="${edge}" aria-hidden="true"></span>`).join('')}
            </div>
        </div>`;
}

export class CacheMemoryUI {
    constructor({ getSettings, updateSettings, persistSettings, apiClient, store, summarizer, getChat, updateInjection, persistence, apiCacheAdapter }) {
        this.root = resolveUIRoot();
        this.doc = this.root.document;
        this.getSettings = getSettings;
        this.updateSettings = updateSettings;
        this.persistSettings = persistSettings;
        this.apiClient = apiClient;
        this.store = store;
        this.summarizer = summarizer;
        this.getChat = getChat;
        this.updateInjection = updateInjection;
        this.persistence = persistence;
        this.apiCacheAdapter = apiCacheAdapter;
        this.manager = null;
        this.config = null;
        this.wandObserver = null;
        this.wandSyncQueued = false;
        this.lastFocusedElement = null;
        this.controller = new (this.root.AbortController ?? AbortController)();
        this.destroyed = false;
        this.modelOptions = [];
        this.managerView = 'overview';
        this.managerState = { summaryStatus: 'all', summaryQuery: '', summaryPage: 1, checkpointPage: 1, factStatus: 'active', factPage: 1, keepStatus: 'active', keepQuery: '', keepPage: 1 };
        this.keepSelection = new Set();
        this.managerExpanded = { summaries: new Set(), checkpoints: new Set(), facts: new Set(), keeps: new Set() };
        this.managerEditing = null;
        this.keepBatchMode = false;
        this.settingsDirty = false;
        this.showSummaryHealthDetails = false;
        this.lastMergeReport = null;
        this.missingCheckpointController = null;
        this.missingCheckpointRunId = 0;
        this.missingCheckpointState = { status: 'idle', total: 0, processed: 0, created: 0, skipped: 0, failed: 0, currentRange: null, blocked: [], errors: [] };
        if (summarizer && store && getChat) this.backfill = new HistoryBackfill({
            summarizer, store, getChat, onProgress: state => { this.showTaskProgress({ ...state, phase: '楼层摘要补齐' }); this.renderBackfillProgress(); },
        });
    }

    mountStyles() {
        if (this.root[OWNER_KEY] && this.root[OWNER_KEY] !== this) this.root[OWNER_KEY].destroy();
        this.root[OWNER_KEY] = this;
        if (this.style?.isConnected) return;
        this.doc.getElementById(STYLE_ID)?.remove();
        this.style = this.doc.createElement('link');
        this.style.id = STYLE_ID;
        this.style.rel = 'stylesheet';
        this.style.href = new URL('../style.css?v=1.22.9', import.meta.url).href;
        this.doc.head.append(this.style);
    }

    mountSettings() {
        const host = settingsHost(this.doc);
        if (!host) return false;
        this.doc.getElementById(ROOT_ID)?.remove();
        host.insertAdjacentHTML('beforeend', settingsTemplate());
        const root = this.doc.getElementById(ROOT_ID);
        this.createConfig();
        this.populateSettings();
        this.bindSettings(root);
        this.bindSettings(this.config);
        this.watchWandMenu();
        return true;
    }

    createConfig() {
        this.mountStyles();
        this.config = this.doc.getElementById(CONFIG_ID);
        if (this.config) return;
        this.doc.body.insertAdjacentHTML('beforeend', configTemplate());
        this.config = this.doc.getElementById(CONFIG_ID);
        this.manager = this.config.querySelector(`#${MANAGER_ID}`);
        bindDialogViewport(this.config, this.root, this.controller.signal);
        this.resetConfigDrag = this.bindDialogDrag(this.config);
        this.manager.addEventListener('click', event => this.handleManagerClick(event).catch(error => notify('error', error.message)), { signal: this.controller.signal });
        this.manager.addEventListener('input', event => this.handleManagerInput(event), { signal: this.controller.signal });
        this.manager.addEventListener('change', event => this.handleManagerInput(event), { signal: this.controller.signal });
        this.manager.addEventListener('keydown', event => this.handleManagerKeydown(event), { signal: this.controller.signal });
        this.manager.querySelector('[data-import-merge-file]').addEventListener('change', event => this.importMergeFile(event), { signal: this.controller.signal });
        this.doc.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.config && !this.config.hidden) this.closeSettings();
        }, { signal: this.controller.signal });
    }

    bindDialogDrag(overlay) {
        const panel = overlay.querySelector('.cache-memory-config-frame') ?? overlay.querySelector('.cache-memory-config-panel, .cache-memory-manager-panel');
        const handle = panel.querySelector('.cache-memory-dialog-header');
        const root = this.root;
        let drag = null;
        let frame = null;
        let x = 0, y = 0;
        let width = null, height = null;
        const paint = () => {
            frame = null;
            panel.style.transform = `translate3d(${x}px, ${y}px, 0)`;
            if (width !== null) panel.style.width = `${width}px`;
            if (height !== null) panel.style.height = `${height}px`;
        };
        const queuePaint = () => { if (frame === null) frame = root.requestAnimationFrame(paint); };
        const stop = () => {
            if (frame !== null) { root.cancelAnimationFrame(frame); paint(); }
            if (drag) {
                const id = drag.id;
                const target = drag.target ?? handle;
                drag = null;
                if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
            }
            handle.classList.remove('is-dragging');
            overlay.classList.remove('is-dragging');
            panel.style.removeProperty('will-change');
        };
        const reset = () => { stop(); x = y = 0; panel.style.removeProperty('transform'); };
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button, input, select, textarea, a')) return;
            const view = viewportSize(root);
            if (event.pointerType === 'touch' || view.width <= 650) return;
            const rect = panel.getBoundingClientRect();
            drag = { id: event.pointerId, pointerX: event.clientX, pointerY: event.clientY, x, y,
                minX: view.left - rect.left + x, maxX: view.left + view.width - rect.right + x,
                minY: view.top - rect.top + y, maxY: view.top + view.height - rect.bottom + y };
            handle.setPointerCapture(event.pointerId);
            handle.classList.add('is-dragging');
            overlay.classList.add('is-dragging');
            panel.style.willChange = 'transform';
            event.preventDefault();
        }, { signal: this.controller.signal });
        handle.addEventListener('pointermove', event => {
            if (drag?.id !== event.pointerId) return;
            x = Math.max(drag.minX, Math.min(drag.maxX, drag.x + event.clientX - drag.pointerX));
            y = Math.max(drag.minY, Math.min(drag.maxY, drag.y + event.clientY - drag.pointerY));
            queuePaint();
        }, { signal: this.controller.signal });
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, stop, { signal: this.controller.signal });
        const limits = () => {
            const view = viewportSize(root), padding = root.getComputedStyle?.(overlay);
            return { left: view.left + (parseFloat(padding?.paddingLeft) || 8), right: view.left + view.width - (parseFloat(padding?.paddingRight) || 8),
                top: view.top + (parseFloat(padding?.paddingTop) || 8), bottom: view.top + view.height - (parseFloat(padding?.paddingBottom) || 8) };
        };
        for (const edge of panel.querySelectorAll?.('[data-resize-edge]') ?? []) {
            edge.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                stop();
                drag = { id: event.pointerId, target: edge, edge: edge.dataset.resizeEdge, rect: panel.getBoundingClientRect(),
                    pointerX: event.clientX, pointerY: event.clientY, x, y, bounds: limits() };
                edge.setPointerCapture(event.pointerId);
                panel.style.willChange = 'width, height, transform';
                event.preventDefault();
            }, { signal: this.controller.signal });
            edge.addEventListener('pointermove', event => {
                if (drag?.id !== event.pointerId || drag.target !== edge) return;
                const r = drag.rect, b = drag.bounds, dx = event.clientX - drag.pointerX, dy = event.clientY - drag.pointerY;
                const minWidth = Math.min(320, b.right - b.left), minHeight = Math.min(240, b.bottom - b.top);
                let left = r.left, right = r.right, top = r.top, bottom = r.bottom;
                if (drag.edge === 'w') left = Math.max(b.left, Math.min(right - minWidth, left + dx));
                if (drag.edge === 'e') right = Math.min(b.right, Math.max(left + minWidth, right + dx));
                if (drag.edge === 'n') top = Math.max(b.top, Math.min(bottom - minHeight, top + dy));
                if (drag.edge === 's') bottom = Math.min(b.bottom, Math.max(top + minHeight, bottom + dy));
                width = right - left; height = bottom - top;
                x = drag.x + (left + right - r.left - r.right) / 2;
                y = drag.y + (top + bottom - r.top - r.bottom) / 2;
                queuePaint();
            }, { signal: this.controller.signal });
            for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) edge.addEventListener(name, stop, { signal: this.controller.signal });
        }
        const resize = () => {
            reset();
            const b = limits();
            if (width !== null) { width = Math.min(width, b.right - b.left); panel.style.width = `${width}px`; }
            if (height !== null) { height = Math.min(height, b.bottom - b.top); panel.style.height = `${height}px`; }
        };
        root.addEventListener('resize', resize, { signal: this.controller.signal });
        root.visualViewport?.addEventListener('resize', resize, { signal: this.controller.signal });
        root.visualViewport?.addEventListener('scroll', resize, { signal: this.controller.signal });
        this.controller.signal.addEventListener('abort', stop, { once: true });
        return reset;
    }

    settingsScopes() {
        return [this.doc.getElementById(ROOT_ID), this.config].filter(Boolean);
    }

    populateSettings(root) {
        const settings = this.getSettings();
        const scopes = root ? [root] : this.settingsScopes();
        for (const scope of scopes) {
            const warning = scope.querySelector('[data-cache-mode-warning]');
            if (warning) warning.textContent = settings.strictCacheMode
                ? `近期小总结会每轮改变 Prompt，不适合严格缓存模式。当前实际策略：${effectiveInjectionMode(settings)}；近期模式会自动降级到 Checkpoint 边界。`
                : '严格缓存模式已关闭：当前长期事实、KEEP、近期小总结等动态内容可能逐层改变 Prompt Prefix。';
            for (const element of scope.querySelectorAll('[data-legacy-setting]')) element.hidden = settings.memoryStrategy !== 'legacy';
            for (const element of scope.querySelectorAll('[data-custom-filter]')) element.hidden = settings.summaryFilterMode !== SUMMARY_FILTER_MODES.CUSTOM;
            for (const element of scope.querySelectorAll('[data-setting]')) {
                const key = element.dataset.setting;
                if (element.type === 'checkbox') element.checked = Boolean(settings[key]);
                else element.value = settings[key] ?? '';
            }
            for (const element of scope.querySelectorAll('[data-prompt]')) {
                element.value = settings.prompts[element.dataset.prompt] ?? '';
            }
            const keyState = scope.querySelector('[data-api-key-state]');
            if (keyState) keyState.textContent = this.apiClient.hasApiKey() ? 'API 密钥已保存在本浏览器' : '尚未保存 API 密钥';
            const keyInput = scope.querySelector('[data-api-key]');
            if (keyInput) keyInput.placeholder = this.apiClient.hasApiKey() ? '已保存，留空表示不更改' : '未配置';
            const adapterPolicy = this.apiCacheAdapter?.currentPolicy?.();
            const connection = scope.querySelector('[data-api-cache-connection]');
            if (connection) connection.textContent = adapterPolicy?.label || '默认策略（尚未识别主模型连接）';
            for (const element of scope.querySelectorAll('[data-api-cache-policy]')) {
                const value = adapterPolicy?.policy?.[element.dataset.apiCachePolicy];
                if (element.type === 'checkbox') element.checked = Boolean(value);
                else element.value = value ?? '';
            }
        }
        if (this.apiCacheAdapter?.status) this.setApiCacheAdapterStatus(this.apiCacheAdapter.status);
        this.renderSettingsSaveState();
    }

    renderSettingsSaveState() {
        for (const output of this.config?.querySelectorAll?.('[data-settings-save-state]') ?? []) {
            output.dataset.state = this.settingsDirty ? 'dirty' : 'saved';
            output.textContent = this.settingsDirty ? '有未保存修改' : '已保存';
        }
    }

    markSettingsDirty() {
        this.settingsDirty = true;
        this.renderSettingsSaveState();
    }

    async saveSettingsNow() {
        if (this.persistSettings) await this.persistSettings();
        else this.updateSettings?.({});
        this.settingsDirty = false;
        this.renderSettingsSaveState();
        notify('success', 'Cache Memory 设置已保存');
    }

    bindSettings(root) {
        if (!root || root.dataset.cacheMemoryBound === 'true') return;
        root.dataset.cacheMemoryBound = 'true';
        root.addEventListener('change', event => {
            const cachePolicy = event.target.closest('[data-api-cache-policy]');
            if (cachePolicy) {
                const key = cachePolicy.dataset.apiCachePolicy;
                const value = cachePolicy.type === 'checkbox' ? cachePolicy.checked
                    : key === 'historyDepth' ? Number(cachePolicy.value) : cachePolicy.value;
                this.apiCacheAdapter?.updateCurrentPolicy?.({ [key]: value });
                this.markSettingsDirty();
                this.populateSettings();
                return;
            }
            const modelSelect = event.target.closest('[data-model-select]');
            if (modelSelect) {
                if (!modelSelect.value) return;
                const input = root.querySelector('[data-setting="model"]');
                input.value = modelSelect.value;
                this.updateSettings({ model: input.value });
                this.markSettingsDirty();
                modelSelect.value = '';
                return;
            }
            const element = event.target.closest('[data-setting]');
            if (!element) return;
            const key = element.dataset.setting;
            const numeric = ['checkpointInterval', 'longMemoryInterval', 'summaryMaxLength', 'checkpointMaxLength', 'longMemoryMaxLength', 'recentSummaryCount', 'recentCheckpointCount', 'temperature', 'summaryMaxTokens', 'checkpointMaxTokens', 'longMemoryMaxTokens', 'timeoutMs'];
            const value = element.type === 'checkbox' ? element.checked : numeric.includes(key) ? Number(element.value) : element.value;
            this.updateSettings({ [key]: value, ...(key === 'apiBaseUrl' ? { provider: API_PROVIDERS.OPENAI_COMPATIBLE } : {}) });
            this.markSettingsDirty();
            this.populateSettings();
            if (key === 'showWandButton') this.syncWandEntry();
            if (['enabled', 'strictCacheMode', 'injectionMode', 'recentSummaryCount', 'recentCheckpointCount', 'memoryStrategy'].includes(key)) this.updateInjection('settings changed');
            this.renderMessageMemories();
        }, { signal: this.controller.signal });
        root.addEventListener('input', event => {
            const setting = event.target.closest('[data-setting="model"]');
            if (setting) {
                this.updateSettings({ model: setting.value });
                this.markSettingsDirty();
                return;
            }
            const element = event.target.closest('[data-prompt]');
            if (!element) return;
            this.updateSettings({ prompts: { ...this.getSettings().prompts, [element.dataset.prompt]: element.value } });
            this.markSettingsDirty();
        }, { signal: this.controller.signal });
        root.addEventListener('click', async event => {
            if (event.target === this.config || event.target.closest('[data-settings-close]')) {
                this.closeSettings();
                return;
            }
            if (event.target.closest('[data-open-settings]')) {
                this.openSettings();
                return;
            }
            const tab = event.target.closest('[data-settings-tab]');
            if (tab) {
                this.activateSettingsTab(tab.dataset.settingsTab);
                return;
            }
            if (event.target.closest('[data-save-settings]')) {
                try { await this.saveSettingsNow(); }
                catch (error) { notify('error', `保存设置失败：${error.message}`); }
                return;
            }
            if (event.target.closest('[data-api-cache-probe]')) {
                this.setApiCacheAdapterStatus({ state: 'working', message: '正在检测 SillyTavern 服务端适配器…', preview: null });
                await this.apiCacheAdapter?.probe?.();
                return;
            }
            if (event.target.closest('[data-api-cache-reset]')) {
                this.apiCacheAdapter?.resetCurrentPolicy?.();
                this.markSettingsDirty();
                this.populateSettings();
                return;
            }
            const reset = event.target.closest('[data-reset-prompt]');
            if (reset) {
                const name = reset.dataset.resetPrompt;
                const defaults = this.getSettings().memoryStrategy === 'legacy' ? LEGACY_PROMPTS : DEFAULT_PROMPTS;
                this.updateSettings({ prompts: { ...this.getSettings().prompts, [name]: defaults[name] } });
                this.markSettingsDirty();
                this.populateSettings();
                return;
            }
            if (event.target.closest('[data-save-api-key]')) {
                try {
                    const input = root.querySelector('[data-api-key]');
                    await this.apiClient.saveApiKey(input.value);
                    input.value = '';
                    this.populateSettings();
                    notify('success', 'API 密钥已保存在当前浏览器');
                } catch (error) {
                    notify('error', error.message);
                }
                return;
            }
            if (event.target.closest('[data-clear-api-key]')) {
                if (!await this.showPluginDialog({ title: '清除 API 密钥', message: '清除当前浏览器保存的缓存记忆 API 密钥？', confirmLabel: '确认清除', danger: true })) return;
                this.apiClient.clearApiKey();
                this.populateSettings();
                notify('success', 'API 密钥已清除');
                return;
            }
            if (event.target.closest('[data-list-models]')) {
                const button = event.target.closest('button');
                button.disabled = true;
                this.setStatus('busy', '正在获取模型列表…');
                try {
                    const inputKey = root.querySelector('[data-api-key]')?.value ?? '';
                    const result = await this.apiClient.listModels(inputKey);
                    // Preserve a previously fetched list when a later request fails.
                    if (result.source !== 'unavailable') this.renderModelOptions(result.models);
                    const modelInput = root.querySelector('[data-setting="model"]');
                    if (modelInput && !modelInput.value.trim() && result.models.length) {
                        modelInput.value = result.models[0];
                        this.updateSettings({ model: modelInput.value });
                        this.markSettingsDirty();
                    }
                    const suffix = result.source === 'unavailable'
                        ? formatModelListFailure(result)
                        : `已从${result.source === 'proxy' ? 'SillyTavern 代理' : '接口'}获取 · 共 ${result.models.length} 个`;
                    this.setStatus(result.warning ? 'warning' : 'success', suffix);
                    if (result.source === 'unavailable') {
                        for (const output of this.doc.querySelectorAll('[data-cache-status]')) output.title = '详细诊断已输出到浏览器开发者控制台';
                        console.warn('[Cache Memory] model list failed:', suffix);
                    }
                } catch (error) {
                    const detail = formatModelListFailure({ diagnostics: error.diagnostics, error: error.message });
                    this.setStatus('error', detail);
                    console.warn('[Cache Memory] model list failed:', detail);
                } finally {
                    button.disabled = false;
                }
                return;
            }
            const testButton = event.target.closest('[data-test-api]');
            if (testButton) {
                const button = testButton;
                const stream = button.dataset.testApi === 'stream';
                button.disabled = true;
                this.setStatus('busy', `正在进行${stream ? '极速流式' : '非流式诊断'}测试…`);
                try {
                    const result = await this.apiClient.test({ stream });
                    const firstChunk = result.ttfcMs == null ? '不适用' : `${result.ttfcMs} ms`;
                    this.setStatus('success', `${stream ? '极速流式' : '非流式诊断'}测试成功\n模型：${result.model}\nHTTP：${result.status}\n响应类型：${result.contentType || '未提供'}\n首包时间：${result.ttfbMs} ms\n首 chunk：${firstChunk}\n总耗时：${result.totalMs} ms\n最终文本：${result.content}`);
                } catch (error) {
                    this.setStatus('error', formatConnectionFailure(error));
                } finally {
                    button.disabled = false;
                }
                return;
            }
            if (event.target.closest('[data-open-manager]')) {
                this.openManager();
            }
        }, { signal: this.controller.signal });
    }

    renderModelOptions(models) {
        this.modelOptions = [...models];
        for (const list of this.doc.querySelectorAll('[data-model-list]')) {
            const placeholder = this.doc.createElement('option');
            placeholder.value = '';
            placeholder.textContent = models.length ? `选择模型（共 ${models.length} 个，显示完整列表）` : '获取列表后可在此选择模型';
            list.replaceChildren(placeholder, ...models.map(model => {
                const option = this.doc.createElement('option');
                option.value = model;
                option.textContent = model;
                return option;
            }));
            list.value = '';
        }
    }

    openSettings() {
        this.createConfig();
        this.lastFocusedElement = this.doc.activeElement;
        this.populateSettings();
        this.renderModelOptions(this.modelOptions);
        this.config.hidden = false;
        if (this.debugSnapshot) this.setCacheDebug(this.debugSnapshot);
        this.doc.body.classList.add('cache-memory-config-open');
        this.config.querySelector('[data-settings-close]')?.focus();
    }

    closeSettings() {
        if (!this.config || this.config.hidden) return;
        this.resetConfigDrag?.();
        this.config.hidden = true;
        this.doc.body.classList.remove('cache-memory-config-open');
        this.lastFocusedElement?.focus?.();
    }

    activateSettingsTab(name) {
        if (!this.config) return;
        for (const tab of this.config.querySelectorAll('[data-settings-tab]')) {
            const active = tab.dataset.settingsTab === name;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', String(active));
        }
        for (const panel of this.config.querySelectorAll('[data-settings-panel]')) {
            panel.hidden = panel.dataset.settingsPanel !== name;
        }
        const managerActive = name === 'manager';
        this.config.querySelector('.cache-memory-config-content')?.classList.toggle('is-manager-view', managerActive);
        this.config.querySelector('.cache-memory-config-panel')?.classList.toggle('is-manager-view', managerActive);
        if (managerActive) this.renderManager();
    }

    watchWandMenu() {
        this.syncWandEntry();
        if (this.wandObserver || !this.doc.body) return;
        this.wandObserver = new this.root.MutationObserver(() => {
            if (this.wandSyncQueued) return;
            this.wandSyncQueued = true;
            this.wandFrame = this.root.requestAnimationFrame(() => {
                this.wandFrame = null;
                this.wandSyncQueued = false;
                this.syncWandEntry();
            });
        });
        this.wandObserver.observe(this.doc.body, { childList: true, subtree: true });
    }

    syncWandEntry() {
        if (this.destroyed) return;
        const existing = this.doc.getElementById(WAND_CONTAINER_ID);
        if (!this.getSettings().showWandButton) {
            existing?.remove();
            return;
        }
        if (existing?.isConnected) return;
        const host = this.doc.getElementById('extensionsMenu');
        if (!host) return;
        const container = this.doc.createElement('div');
        container.id = WAND_CONTAINER_ID;
        container.className = 'extension_container';
        const entry = this.doc.createElement('div');
        entry.id = WAND_ENTRY_ID;
        entry.className = 'list-group-item flex-container flexGap5 interactable';
        entry.role = 'button';
        entry.tabIndex = 0;
        entry.innerHTML = '<div class="fa-fw fa-solid fa-brain extensionsMenuExtensionButton" aria-hidden="true"></div><span>缓存记忆</span>';
        const open = () => this.openSettings();
        entry.addEventListener('click', open, { signal: this.controller.signal });
        entry.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            open();
        }, { signal: this.controller.signal });
        container.append(entry);
        host.append(container);
    }

    setCacheDebug(snapshot) {
        this.debugSnapshot = snapshot;
        for (const output of this.doc.querySelectorAll('[data-cache-debug]')) {
            output.hidden = !this.getSettings().cacheDebug;
            output.textContent = `CACHE DEBUG\n${JSON.stringify(snapshot, null, 2)}`;
        }
    }

    setApiCacheAdapterStatus(status = {}) {
        if (this.destroyed) return;
        for (const output of this.doc.querySelectorAll('[data-api-cache-status]')) {
            output.dataset.state = status.state || 'idle';
            output.textContent = status.message || '尚未检测服务端适配器';
        }
        for (const output of this.doc.querySelectorAll('[data-api-cache-preview]')) {
            output.hidden = !status.preview;
            output.textContent = status.preview ? `实际请求结构（脱敏）\n${JSON.stringify(status.preview, null, 2)}` : '';
        }
        const connection = this.config?.querySelector('[data-api-cache-connection]');
        if (connection) connection.textContent = this.apiCacheAdapter?.currentPolicy?.().label || '默认策略（尚未识别主模型连接）';
    }

    setStatus(state, text, error) {
        if (this.destroyed) return;
        if (error?.diagnostics) text += `\n${formatSummaryFailure({ errorCategory: error.category, errorCode: error.code, errorDiagnostics: error.diagnostics, error: error.message })}`;
        for (const output of this.doc.querySelectorAll('[data-cache-status]')) {
            output.dataset.state = state;
            output.textContent = text;
            output.removeAttribute('title');
            if (output.closest?.('.cache-memory-config-panel')) {
                output.hidden = !text || state === 'success' && /^第.*层摘要已冻结$/.test(text);
                const freeze = this.config?.querySelector('[data-freeze-status]');
                if (freeze) freeze.hidden = !output.hidden;
            }
        }
    }

    renderMessageMemories() {
        if (!this.getSettings().enabled) {
            this.doc.querySelectorAll('.cache-memory-message').forEach(element => element.remove());
            return;
        }
        const assistants = getAssistantMessages(this.getChat());
        const store = this.store.current();
        const opened = new Set([...this.doc.querySelectorAll('.cache-memory-message[open]')].map(element => element.dataset.messageId));
        this.doc.querySelectorAll('.cache-memory-message').forEach(element => element.remove());
        for (const entry of assistants) {
            const record = store.summaries[entry.messageId];
            const busy = this.summarizer.isSummarizing(entry.messageId);
            const message = this.doc.querySelector(`#chat .mes[mesid="${entry.messageIndex}"]`);
            const anchor = message?.querySelector('.mes_text');
            if (!anchor) continue;
            const widget = this.doc.createElement('details');
            widget.className = 'cache-memory-message';
            widget.dataset.messageId = entry.messageId;
            widget.open = opened.has(entry.messageId);
            const summary = this.doc.createElement('summary');
            summary.textContent = busy ? '本层记忆 · 正在生成…'
                : !record ? '本层记忆 · 尚未生成'
                : record.status === 'failed'
                ? `本层记忆 · 生成失败`
                : `本层记忆 · ${record.title}`;
            const body = this.doc.createElement('div');
            body.className = 'cache-memory-message-body';
            if (record?.status === 'failed') {
                body.append(this.line('错误', formatSummaryFailure(record)));
            } else if (record) {
                body.append(this.line('剧情日期/时间｜地点', `${record.storyTime || '未提供'}｜${record.location || '未提供'}`),
                    this.line('人物', record.characters), this.line('事件', record.event));
            }
            const actions = this.doc.createElement('div');
            actions.className = 'cache-memory-actions';
            actions.innerHTML = `
                <button type="button" class="menu_button" data-memory-action="regenerate" ${busy ? 'disabled' : ''}><i class="fa-solid fa-rotate"></i> ${!record ? '生成本层记忆' : record.status === 'failed' ? '重试' : '重新生成'}</button>
                ${record && record.status !== 'failed' ? `<button type="button" class="menu_button" data-memory-action="edit" ${busy ? 'disabled' : ''}><i class="fa-solid fa-pen"></i> 编辑</button>` : ''}
                ${record ? `<button type="button" class="menu_button" data-memory-action="delete" ${busy ? 'disabled' : ''}><i class="fa-solid fa-trash"></i> 删除</button>` : ''}`;
            body.append(actions);
            widget.append(summary, body);
            anchor.insertAdjacentElement('afterend', widget);
        }
    }

    line(label, value) {
        const line = this.doc.createElement('p');
        const strong = this.doc.createElement('strong');
        strong.textContent = `${label}：`;
        line.append(strong, this.doc.createTextNode(value || '未提供'));
        return line;
    }

    bindChatActions() {
        this.doc.querySelector('#chat')?.addEventListener('click', async event => {
            const button = event.target.closest('[data-memory-action]');
            const widget = button?.closest('.cache-memory-message');
            if (!button || !widget) return;
            const { messageId } = widget.dataset;
            if (button.dataset.memoryAction === 'delete') {
                const confirmed = await this.showPluginDialog({ title: '删除楼层摘要', message: '删除这条小总结？历史 assistant 正文不会被修改。', confirmLabel: '确认删除', danger: true });
                if (confirmed) this.store.deleteSummary(messageId);
            } else if (button.dataset.memoryAction === 'edit') {
                await this.editSummary(messageId);
            } else if (button.dataset.memoryAction === 'regenerate') {
                const record = this.store.getSummary(messageId);
                if (record && record.status !== 'failed' && !await this.showPluginDialog({ title: '重新生成楼层摘要', message: '重新生成会替换这条摘要，但不会修改原始 assistant 正文。', confirmLabel: '确认重新生成' })) return;
                button.disabled = true;
                try {
                    await this.summarizer.summarizeMessage(messageId, { overwrite: Boolean(record) });
                } catch {}
                button.disabled = false;
            }
            this.renderMessageMemories();
            this.renderManager();
        }, { signal: this.controller.signal });
    }

    showPluginDialog({ title, message = '', fields = [], confirmLabel = '确认', danger = false }) {
        return new Promise(resolve => {
            this.cancelActiveDialog?.();
            this.activeDialog?.remove();
            const overlay = this.element('div', 'cache-memory-modal-overlay');
            const form = this.element('form', 'cache-memory-modal-panel');
            form.setAttribute('role', 'dialog');
            form.setAttribute('aria-modal', 'true');
            const header = this.element('header', 'cache-memory-modal-header');
            header.append(this.element('h3', '', title));
            const close = this.element('button', 'menu_button cache-memory-icon-button', '×');
            close.type = 'button'; close.dataset.dialogClose = '';
            close.title = '关闭'; close.setAttribute('aria-label', '关闭');
            header.append(close);
            const content = this.element('div', 'cache-memory-modal-content');
            if (message) content.append(this.element('p', 'cache-memory-modal-message', message));
            for (const field of fields) {
                const label = this.element('label', 'cache-memory-modal-field');
                label.append(this.element('span', '', field.label));
                const input = this.element(field.options ? 'select' : field.multiline ? 'textarea' : 'input');
                if (field.options) for (const [value, text] of field.options) { const option = this.element('option', '', text); option.value = value; input.append(option); }
                else if (!field.multiline) input.type = 'text';
                else input.rows = field.rows ?? 4;
                input.name = field.key;
                input.value = String(field.value ?? '');
                label.append(input);
                content.append(label);
            }
            const actions = this.element('div', 'cache-memory-modal-actions');
            const cancel = this.element('button', 'menu_button', '取消');
            cancel.type = 'button'; cancel.dataset.dialogCancel = '';
            const confirm = this.element('button', `menu_button cache-memory-primary${danger ? ' cache-memory-danger' : ''}`, confirmLabel);
            confirm.type = 'submit';
            actions.append(cancel, confirm);
            form.append(header, content, actions);
            overlay.append(form);
            this.doc.body.append(overlay);
            const releaseViewport = bindDialogViewport(overlay, this.root, this.controller.signal);
            this.activeDialog = overlay;
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                if (this.activeDialog === overlay) this.activeDialog = null;
                if (this.cancelActiveDialog === cancelDialog) this.cancelActiveDialog = null;
                this.controller.signal.removeEventListener('abort', cancelDialog);
                releaseViewport();
                overlay.remove();
                resolve(value);
            };
            const cancelDialog = () => finish(null);
            this.cancelActiveDialog = cancelDialog;
            this.controller.signal.addEventListener('abort', cancelDialog, { once: true });
            cancel.addEventListener('click', () => finish(null), { once: true });
            close.addEventListener('click', () => finish(null), { once: true });
            overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
            form.addEventListener('submit', event => {
                event.preventDefault();
                finish(Object.fromEntries(new this.root.FormData(form).entries()));
            });
            overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); finish(null); } });
            (form.querySelector('input, textarea, select') ?? close).focus({ preventScroll: true });
        });
    }

    editSummary(messageId) {
        const record = this.store.getSummary(messageId);
        if (!record) return;
        const entries = this.store.syncMessages(this.getChat()).reverse();
        const index = entries.findIndex(entry => entry.messageId === messageId);
        this.managerView = 'summaries';
        this.managerState.summaryStatus = 'all';
        this.managerState.summaryQuery = '';
        this.managerState.summaryPage = Math.floor(Math.max(0, index) / 20) + 1;
        this.managerExpanded.summaries.add(messageId);
        this.managerEditing = { type: 'summary', id: messageId };
        this.openManager();
    }

    openManager() {
        this.openSettings();
        this.activateSettingsTab('manager');
    }

    renderManager() {
        if (!this.manager || this.manager.hidden) return;
        this.renderMemorySaveState();
        for (const tab of this.manager.querySelectorAll('[data-manager-view]')) {
            const active = tab.dataset.managerView === this.managerView;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-current', active ? 'page' : 'false');
        }
        const content = this.manager.querySelector('[data-manager-content]');
        content.replaceChildren();
        if (this.managerView === 'overview') content.append(this.renderOverview());
        else if (this.managerView === 'summaries') content.append(this.renderSummaryPage());
        else if (this.managerView === 'checkpoints') content.append(this.renderCheckpointPage());
        else if (this.managerView === 'long') content.append(this.renderLongMemoryPage());
        else if (this.managerView === 'facts') content.append(this.renderFactPage());
        else if (['threads', 'states'].includes(this.managerView)) content.append(this.renderTrackedPage(this.managerView === 'threads' ? 'thread' : 'state'));
        else content.append(this.renderKeepPage());
        this.renderBackfillProgress();
    }

    renderMemorySaveState() {
        if (!this.manager) return;
        const frozen = Object.values(this.store.current().summaries).filter(isUsableMemory).sort((a, b) => b.floor - a.floor)[0];
        const freezeStatus = this.config?.querySelector('[data-freeze-status]');
        if (freezeStatus) { freezeStatus.hidden = !frozen || !this.config.querySelector('[data-cache-status]').hidden; freezeStatus.textContent = frozen ? `第 ${frozen.floor} 层摘要已冻结` : ''; }
        const status = this.persistence?.getState?.(this.store?.current?.().chatId) ?? { state: 'unknown', detail: '' };
        const labels = {
            pending: '待保存', saving: '保存中', confirmed: '已确认保存', failed: '保存失败',
            unknown: '状态未知', conflict: '跨设备冲突',
        };
        const box = this.manager.querySelector('[data-memory-save-box]');
        const output = this.manager.querySelector('[data-memory-save-status]');
        if (box) box.dataset.state = status.state;
        if (output) {
            output.textContent = `${labels[status.state] ?? '状态未知'}${status.detail ? ` · ${status.detail}` : ''}`;
            output.title = status.at ? `最后更新：${formatDate(status.at)}` : '';
        }
        const conflictActions = this.manager.querySelector('[data-memory-conflict-actions]');
        if (conflictActions) conflictActions.hidden = status.state !== 'conflict';
        const details = this.manager.querySelector('[data-conflict-details]');
        if (details) {
            details.replaceChildren();
            const bundle = this.persistence?.conflictBundle?.(this.store.current().chatId);
            if (bundle && status.state === 'conflict') {
                const report = mergeMemoryStores(bundle.local, bundle.remote, bundle.chatId);
                for (const row of bundle.recordConflicts ?? []) if (!report.conflicts.some(item => item.type === row.type && item.id === row.id)) report.conflicts.push(row);
                const root = this.element('details', 'cache-memory-card');
                root.append(this.element('summary', '', `冲突差异 · ${report.conflicts.length} 个同 ID；无冲突记录可合并`));
                root.append(this.element('p', '', '以本机/服务器为准只选择冲突 ID，保留双方其他记录。选择后重新核对服务器；原生 ST 接口无原子 CAS，无法保证严格跨设备事务。'));
                for (const row of report.conflicts) {
                    const diff = this.element('details'); diff.append(this.element('summary', '', `${row.type} · ${row.id} · 来源 ${row.current?.floor || row.current?.sourceFloor || row.current?.startFloor || '?'} / ${row.incoming?.floor || row.incoming?.sourceFloor || row.incoming?.startFloor || '?'} 层`));
                    diff.append(this.element('pre', '', `本机：\n${JSON.stringify(row.current, null, 2)}\n服务器：\n${JSON.stringify(row.incoming, null, 2)}`)); root.append(diff);
                }
                details.append(root);
            }
        }
    }

    element(tag, className = '', text = '') {
        const element = this.doc.createElement(tag);
        if (className) element.className = className;
        if (text !== '') element.textContent = text;
        return element;
    }

    statusLabel(item) {
        return memoryHealth(item).label;
    }

    renderOverview() {
        const root = this.element('div', 'cache-memory-manager-page');
        const assistants = getAssistantMessages(this.getChat());
        const store = this.store.current();
        const overview = memoryOverviewStats(store, assistants, this.getSettings());
        const stats = [
            ['摘要：已生成 / 应有', `${overview.summaries.generated} / ${overview.summaries.expected}`],
            ['阶段记忆：已生成 / 应有', `${overview.checkpoints.actual} / ${overview.checkpoints.expected}`],
            ['长期记忆：已生成 / 应有', `${overview.longMemories.actual} / ${overview.longMemories.expected}`],
            ['有效 KEEP', overview.activeKeeps],
        ];
        const grid = this.element('div', 'cache-memory-stats');
        for (const [label, value] of stats) {
            const card = this.element('div', 'cache-memory-stat');
            card.append(this.element('strong', '', String(value)), this.element('span', '', label));
            grid.append(card);
        }
        const health = this.element('section', 'cache-memory-health');
        health.dataset.state = overview.issues.length ? 'incomplete' : 'healthy';
        health.append(this.element('h4', '', '记忆状态'));
        health.append(this.element('strong', '', overview.issues.length ? '有待处理问题' : '记忆正常'));
        if (overview.issues.length) {
            const details = this.element('details');
            details.append(this.element('summary', '', `查看 ${overview.issues.length} 类问题`));
            const list = this.element('ul');
            for (const issue of overview.issues) list.append(this.element('li', '', issue));
            details.append(list); health.append(details);
        } else {
            health.append(this.element('p', '', '当前应有的 Summary、Checkpoint 与 Long Memory 均已生成。'));
        }
        const diagnostics = this.manager.querySelector('[data-memory-diagnostics]');
        if (diagnostics) diagnostics.textContent = `存储摘要记录总数 ${overview.storedSummaryRecords} 条 · 当前聊天有效摘要 ${overview.summaries.actual}/${overview.summaries.expected} · 当前注入 CP ${overview.injectedCheckpoints} 条 · 注入估算 ≈${overview.estimatedTokens} tokens（仅供诊断）`;
        if (this.showSummaryHealthDetails) {
            const detailSection = this.element('div', 'cache-memory-summary-health-details');
            detailSection.append(this.element('h5', '', '摘要异常明细'));
            if (!overview.summaryDetails.length) detailSection.append(this.element('p', '', '没有发现缺失、失败、过期或孤立摘要。'));
            else {
                const list = this.element('ul');
                for (const item of overview.summaryDetails) list.append(this.element('li', '', `第 ${item.floor || '未知'} 层 · ${item.label}`));
                detailSection.append(list);
            }
            health.append(detailSection);
        }
        if (this.lastMergeReport) {
            const report = this.element('div', 'cache-memory-merge-report');
            report.append(this.element('strong', '', `最近合并：新增 ${this.lastMergeReport.added.total} 条；冲突 ${this.lastMergeReport.conflicts.length} 条。`));
            for (const conflict of this.lastMergeReport.conflicts.slice(0, 10)) report.append(this.element('p', '', `${conflict.type} ${conflict.id}：同 ID 内容不同，未覆盖当前记录。`));
            health.append(report);
        }
        root.append(grid, health);
        const quick = this.element('div', 'cache-memory-actions');
        quick.innerHTML = '<button type="button" class="menu_button cache-memory-primary" data-backfill-action="missing">补齐缺失摘要</button><button type="button" class="menu_button" data-backfill-action="failed">重试失败摘要</button><button type="button" class="menu_button" data-view-summary-health>查看缺失楼层</button><button type="button" class="menu_button" data-update-checkpoints>更新需处理的阶段记忆</button>';
        const filling = this.isMissingCheckpointBackfillActive();
        quick.innerHTML += `<button type="button" class="menu_button cache-memory-primary" data-fill-all-memories ${filling || this.backfill?.active || this.importingMemory || this.restoringServerMemory ? 'disabled' : ''}>一键补全所有记忆</button><button type="button" class="menu_button" data-cancel-missing-checkpoints ${filling ? '' : 'disabled'}>安全停止补全</button>`;
        if (this.missingCheckpointState.kind === 'all') {
            const state = this.missingCheckpointState;
            const labels = { running: '正在补全', cancelling: '正在停止', completed: '补全完成', cancelled: '已停止', failed: '补全未完成' };
            const range = state.currentRange;
            quick.append(this.element('p', '', `${labels[state.status] ?? state.status} · ${state.phase ?? ''}${range ? ` 第 ${range.startFloor}–${range.endFloor} 层` : ''} · ${state.processed}/${state.total} · 已生成 ${state.created}${state.errors?.length ? `\n${state.errors.at(-1)}` : ''}`));
        }
        root.append(quick, this.backfillPanel(), this.aggregationPanel());
        return root;
    }

    renderTrackedPage(kind) {
        const root = this.element('div', 'cache-memory-manager-page');
        root.append(this.element('p', '', '来源变更的记录标为待核对，不参与当前状态整理。结束事项保留历史；长时间未提及不会自动结束。手动操作不调用模型，原冻结快照在下个既有边界更新。'));
        const rows = projectActiveState(this.store.current()).filter(item => item.kind === kind);
        const active = rows.filter(item => isTrackedActive(item));
        const archived = rows.filter(item => !isTrackedActive(item));
        const formFor = (item = {}) => {
            const form = this.element('form', 'cache-memory-tracked-form');
            const fields = [
                ['entity', '人物完整身份', item.entity ?? ''], ['key', kind === 'thread' ? '稳定事项名称' : '技能/属性/道具名称', item.key ?? ''],
                ['value', kind === 'thread' ? '当前进度 / 结算结果' : '最新确认值', item.value ?? ''],
                ['condition', '完成 / 结束条件', item.condition ?? ''], ['actors', '关联人物（逗号分隔）', (item.actors ?? []).join(', ')],
                ['sourceFloor', '来源楼层（必须已有有效摘要）', item.sourceFloor ?? getAssistantMessages(this.getChat()).at(-1)?.floor ?? 1],
            ];
            for (const [name, title, value] of fields) {
                const label = this.element('label', '', title);
                const input = this.element(name === 'value' || name === 'condition' ? 'textarea' : 'input');
                input.name = name; input.value = String(value); if (name === 'sourceFloor') { input.type = 'number'; input.min = '1'; }
                label.append(input); form.append(label);
            }
            for (const [name, title, options] of [['status', '状态', kind === 'thread' ? [['published', '已发布'], ['active', '进行中'], ['ready', '条件满足待结算'], ['unclaimed', '结算后待领取奖励'], ['completed', '已完成'], ['failed', '失败'], ['cancelled', '已取消']] : [['active', '有效'], ['expired', '已失效']]], ['lifetime', '持续类型', [['permanent', '长期'], ['temporary', '临时']]], ['acquisition', '奖励领取', [['obtained', '已获得 / 不适用'], ['pending', '尚未领取']]]]) {
                const label = this.element('label', '', title), select = this.element('select'); select.name = name;
                for (const [value, text] of options) { const option = this.element('option', '', text); option.value = value; select.append(option); }
                select.value = item[name] ?? (name === 'status' ? 'active' : name === 'acquisition' ? 'obtained' : kind === 'thread' ? 'temporary' : 'permanent');
                label.append(select); form.append(label);
            }
            const button = this.element('button', 'menu_button', item.id ? '保存纠错 / 完成 / 取消' : '添加已确认记录'); button.type = 'submit'; form.append(button);
            form.addEventListener('submit', event => {
                event.preventDefault();
                const updates = Object.fromEntries([...form.querySelectorAll('[name]')].map(input => [input.name, input.value]));
                try { this.store.editTrackedState({ ...updates, id: item.id, kind, actors: updates.actors.split(/[,，]/).map(text => text.trim()).filter(Boolean), sourceFloor: Number(updates.sourceFloor) }); this.renderManager(); }
                catch (error) { notify('error', error.message); }
            }, { signal: this.controller.signal });
            return form;
        };
        const add = this.element('details', 'cache-memory-card'); add.append(this.element('summary', '', '手动添加 / 从旧 Open 字段登记'), formFor()); root.append(add);
        for (const [title, items] of [['当前记录', active], ['已结束 / 历史结果', archived]]) {
            root.append(this.element('h4', '', `${title} · ${items.length}`));
            for (const item of items) {
                const card = this.element('details', 'cache-memory-card');
                card.append(this.element('summary', '', `${item.needsReview ? '⚠ 待核对 · ' : ''}${item.entity} · ${item.key} · ${item.value}`));
                card.append(this.element('p', '', `${item.id} · 来源第 ${item.sourceFloor} 层 · ${item.status} · ${item.lifetime}`));
                card.append(this.element('p', '', `证据：${item.evidence || '用户确认'}；条件：${item.condition || '未提供'}`));
                for (const prior of item.history) card.append(this.element('small', 'cache-memory-state-history', `第 ${prior.sourceFloor} 层：${prior.value} (${prior.status})`));
                card.append(formFor(item)); root.append(card);
            }
        }
        return root;
    }

    backfillPanel() {
        const section = this.element('section', 'cache-memory-backfill');
        section.innerHTML = `<h4>历史楼层补齐</h4><p data-backfill-range></p><div class="cache-memory-grid"><label>开始楼层<input type="number" min="1" value="1" data-backfill-start></label><label>结束楼层<input type="number" min="1" data-backfill-end></label><label>处理模式<select data-backfill-mode><option value="missing-failed">缺失 + 失败</option><option value="missing">仅缺失</option><option value="failed">仅失败</option><option value="all">强制重新生成全部</option></select></label></div><div class="cache-memory-actions"><button type="button" class="menu_button cache-memory-primary" data-backfill-action="start">开始补齐</button><button type="button" class="menu_button" data-backfill-action="pause">暂停</button><button type="button" class="menu_button" data-backfill-action="resume">继续</button><button type="button" class="menu_button" data-backfill-action="cancel">取消</button><button type="button" class="menu_button" data-backfill-action="latest">总结当前最新层</button></div><progress data-backfill-progress max="1" value="0" aria-label="历史补齐进度"></progress><p data-backfill-status role="status" aria-live="polite"></p><small>逐层串行处理；已保存的结果不会被取消。</small>`;
        return section;
    }

    aggregationPanel() {
        const section = this.element('section', 'cache-memory-aggregation');
        const latest = getAssistantMessages(this.getChat()).at(-1)?.floor ?? 0;
        const range = this.summarizer.getNextCheckpointRange();
        const failed = this.store.current().checkpoints.find(item => item.status === 'failed' && item.startFloor === range.startFloor && item.endFloor === range.endFloor);
        section.append(this.element('h4', '', '聚合进度'));
        section.append(this.element('p', '', range.endFloor <= latest
            ? `已聚合至第 ${range.startFloor - 1} 层；下一段为 ${range.startFloor}–${range.endFloor} 层${failed ? '（上次失败）' : ''}。`
            : `已聚合至第 ${range.startFloor - 1} 层；尚未到下一个 Checkpoint 边界。`));
        const plan = this.summarizer.getMissingCheckpointPlan();
        const filling = this.isMissingCheckpointBackfillActive();
        const actions = this.element('div', 'cache-memory-actions cache-memory-aggregate-controls');
        actions.innerHTML = `<label>从指定楼层继续<input type="number" min="1" max="${latest}" value="${range.startFloor}" data-aggregate-start></label><button type="button" class="menu_button" data-aggregate-continue ${range.endFloor > latest || filling || this.backfill?.active ? 'disabled' : ''}>继续聚合</button><button type="button" class="menu_button cache-memory-primary" data-fill-missing-checkpoints title="扫描并补齐当前聊天中缺失的阶段记忆，不覆盖已有内容。" ${!plan.candidates.length || filling || this.backfill?.active ? 'disabled' : ''}>补齐缺失阶段记忆</button><button type="button" class="menu_button" data-cancel-missing-checkpoints ${filling ? '' : 'disabled'}>安全停止</button>`;
        const blocked = plan.blocked.map(item => `第 ${item.startFloor}–${item.endFloor} 层缺 Summary：${item.missingFloors.join('、')}`).join('；');
        const state = this.missingCheckpointState;
        const status = this.element('p', 'cache-memory-checkpoint-backfill-status');
        if (filling || ['completed', 'cancelled', 'failed'].includes(state.status)) {
            const labels = { running: '正在补齐', cancelling: '正在取消', completed: state.created ? '生成成功' : '扫描完成，无需生成', cancelled: '已取消', failed: '补齐失败' };
            const current = state.currentRange ? ` · 当前：第 ${state.currentRange.startFloor}–${state.currentRange.endFloor} 层` : '';
            status.textContent = `${labels[state.status] ?? state.status} · ${state.processed} / ${state.total}${current}\n新增：${state.created} · 跳过：${state.skipped} · 失败：${state.failed}${state.errors?.length ? `\n${state.errors.join('\n')}` : ''}`;
        } else {
            status.textContent = `可补齐 ${plan.candidates.length} 个完整分组；已有 ${plan.existing.length} 个分组。`;
        }
        if (blocked) status.textContent += `\n跳过：${blocked}`;
        const help = this.element('small', 'cache-memory-help', '扫描并补齐当前聊天中缺失的阶段记忆，不覆盖已有内容。不会重新计算已有 Long Memory。');
        section.append(actions, status, help);
        return section;
    }

    isMissingCheckpointBackfillActive() {
        return Boolean(this.missingCheckpointController) || ['running', 'cancelling'].includes(this.missingCheckpointState.status);
    }

    cancelMissingCheckpointBackfill({ discard = false } = {}) {
        if (!this.isMissingCheckpointBackfillActive()) return;
        const controller = this.missingCheckpointController;
        if (discard) {
            this.missingCheckpointRunId++;
            this.missingCheckpointController = null;
            this.missingCheckpointState = { status: 'idle', total: 0, processed: 0, created: 0, skipped: 0, failed: 0, currentRange: null, blocked: [], errors: [] };
        } else {
            this.missingCheckpointState.status = 'cancelling';
        }
        controller?.abort();
        if (discard) this.setStatus('idle', '');
        else { this.showTaskProgress(this.missingCheckpointState); this.renderManager(); }
    }

    async startCheckpointUpdate(ids = null) {
        if (this.isMissingCheckpointBackfillActive() || this.backfill?.active) return;
        if (this.persistence?.getState().state === 'conflict') throw new Error('请先处理跨设备冲突');
        this.store.revalidate(this.getChat());
        const plan = this.summarizer.getCheckpointUpdatePlan(ids);
        if (!plan.length) { this.renderManager(); notify('success', '没有需要处理的阶段记忆；可自行选择记录重新生成'); return; }
        const chatId = this.store.current().chatId, epoch = this.persistence?.epoch;
        const digest = memoryContentDigest(this.store.current());
        if (!await this.showPluginDialog({ title: '更新阶段记忆',
            message: `将更新 ${plan.length} 条阶段记忆（第 ${plan[0].startFloor}–${plan.at(-1).endFloor} 层）。按你的选择替换，失败时停止。`, confirmLabel: '确认更新' })) return;
        if (this.store.current().chatId !== chatId || this.persistence?.epoch !== epoch || memoryContentDigest(this.store.current()) !== digest) throw new Error('确认期间记忆已变化，请重新校验');
        const controller = new AbortController(), runId = ++this.missingCheckpointRunId;
        this.missingCheckpointController = controller;
        this.missingCheckpointState = { status: 'running', total: plan.length, processed: 0, created: 0, skipped: 0, failed: 0, errors: [] };
        this.showTaskProgress(this.missingCheckpointState);
        this.renderManager();
        try {
            const result = await this.summarizer.enqueueForCurrentChat(() => this.summarizer.updateCheckpoints({ ids: plan.map(row => row.id), signal: controller.signal,
                onProgress: progress => { if (runId !== this.missingCheckpointRunId) return; this.missingCheckpointState = { ...progress, status: controller.signal.aborted ? 'cancelling' : 'running' }; this.showTaskProgress(this.missingCheckpointState); this.renderManager(); } }));
            if (runId === this.missingCheckpointRunId) this.missingCheckpointState = { ...result, status: result.failed ? 'failed' : 'completed' };
        } catch (error) {
            if (runId === this.missingCheckpointRunId) this.missingCheckpointState = { ...this.missingCheckpointState, status: ['REQUEST_ABORTED', 'CHAT_CHANGED'].includes(error.code) ? 'cancelled' : 'failed', errors: [...this.missingCheckpointState.errors, error.message] };
        } finally {
            if (runId === this.missingCheckpointRunId) { this.missingCheckpointController = null; this.showTaskProgress(this.missingCheckpointState); this.renderManager(); }
        }
    }

    async startMissingMemoryBackfill({ onlyLong = false } = {}) {
        if (this.isMissingCheckpointBackfillActive() || this.backfill?.active || this.importingMemory || this.restoringServerMemory
            || this.summarizer.inFlight?.size || this.summarizer.pendingSummaries?.size) return;
        const controller = new AbortController(), runId = ++this.missingCheckpointRunId;
        const chatId = this.store.current().chatId, epoch = this.persistence?.epoch;
        this.missingCheckpointController = controller;
        this.missingCheckpointState = { kind: 'all', status: 'running', total: 0, processed: 0, created: 0, failed: 0, skipped: 0, phase: '读取服务器', errors: [] };
        this.renderManager();
        try {
            const saved = await this.persistence.reread(chatId);
            if (runId !== this.missingCheckpointRunId || chatId !== this.store.current().chatId || epoch !== this.persistence.epoch || controller.signal.aborted) return;
            if (saved.state !== 'confirmed') throw new Error(`服务器记忆尚未确认：${saved.detail}`);
            const result = await this.summarizer.fillMissingMemories({ signal: controller.signal, onlyLong,
                onProgress: progress => {
                    if (runId !== this.missingCheckpointRunId) return;
                    this.missingCheckpointState = { ...progress, kind: 'all', status: controller.signal.aborted ? 'cancelling' : 'running' };
                    this.showTaskProgress(this.missingCheckpointState); this.renderManager();
                } });
            if (runId === this.missingCheckpointRunId) {
                this.missingCheckpointState = { ...result, kind: 'all', status: result.failed ? 'failed' : 'completed' };
                const remaining = this.summarizer.getMissingMemoryPlan({ onlyLong });
                const incomplete = remaining.summaries.length + remaining.checkpoints.length + remaining.longMemories.length;
                if (!result.failed && incomplete) {
                    this.missingCheckpointState.status = 'failed';
                    this.missingCheckpointState.errors = [`仍有 ${incomplete} 条记忆未补齐，请查看对应分类`];
                }
                notify(result.failed || incomplete ? 'error' : 'success', result.failed ? result.errors.at(-1) : incomplete ? this.missingCheckpointState.errors[0] : `${onlyLong ? '长期记忆补全' : '补全'}完成：新增 ${result.created} 条记忆，并已从服务器读回确认`);
            }
        } catch (error) {
            if (runId === this.missingCheckpointRunId) this.missingCheckpointState = { ...this.missingCheckpointState,
                status: ['REQUEST_ABORTED', 'CHAT_CHANGED'].includes(error.code) ? 'cancelled' : 'failed', errors: [error.message] };
        } finally {
            if (runId === this.missingCheckpointRunId) {
                if (controller.signal.aborted) this.missingCheckpointState.status = 'cancelled';
                this.missingCheckpointController = null;
                this.showTaskProgress(this.missingCheckpointState); this.renderManager(); this.renderMessageMemories();
            }
        }
    }

    async startMissingCheckpointBackfill() {
        if (this.isMissingCheckpointBackfillActive() || this.backfill?.active) return;
        const plan = this.summarizer.getMissingCheckpointPlan();
        if (!plan.candidates.length) return;
        const controller = new AbortController();
        const runId = ++this.missingCheckpointRunId;
        this.missingCheckpointController = controller;
        this.missingCheckpointState = { status: 'running', total: plan.candidates.length, processed: 0, created: 0, skipped: 0, failed: 0, currentRange: null, blocked: plan.blocked, errors: [] };
        this.showTaskProgress(this.missingCheckpointState);
        this.renderManager();
        try {
            const result = await this.summarizer.enqueueForCurrentChat(() => this.summarizer.fillMissingCheckpoints({
                signal: controller.signal,
                onProgress: progress => {
                    if (runId !== this.missingCheckpointRunId) return;
                    if (this.missingCheckpointState.status !== 'cancelling') this.missingCheckpointState = { ...progress, status: 'running' };
                    this.showTaskProgress(this.missingCheckpointState); this.renderManager();
                },
            }));
            if (runId !== this.missingCheckpointRunId) return;
            this.missingCheckpointState = { ...result, status: result.failed ? 'failed' : 'completed' };
            notify(result.failed ? 'error' : 'success', `阶段记忆${result.failed ? '部分生成失败' : result.created ? '生成成功' : '扫描完成，无需生成'}：新增 ${result.created} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条。`);
        } catch (error) {
            if (runId !== this.missingCheckpointRunId) return;
            if (['REQUEST_ABORTED', 'CHAT_CHANGED'].includes(error.code)) this.missingCheckpointState.status = 'cancelled';
            else {
                this.missingCheckpointState.status = 'failed';
                this.missingCheckpointState.errors = [...(this.missingCheckpointState.errors ?? []), error.message];
                notify('error', `阶段记忆补齐失败：${error.message}`);
            }
        } finally {
            if (runId === this.missingCheckpointRunId) {
                if (this.missingCheckpointController === controller) this.missingCheckpointController = null;
                this.showTaskProgress(this.missingCheckpointState); this.renderManager();
            }
        }
    }

    renderSummaryPage() {
        const root = this.element('div', 'cache-memory-manager-page');
        const controls = this.element('div', 'cache-memory-list-controls');
        controls.innerHTML = '<select data-summary-status aria-label="摘要状态"><option value="all">全部</option><option value="success">成功</option><option value="failed">失败</option><option value="missing">缺失</option></select><input type="search" data-summary-query placeholder="搜索楼层或标题"><button type="button" class="menu_button" data-fold-page="collapse">全部折叠</button><button type="button" class="menu_button" data-fold-page="expand">全部展开</button>';
        controls.querySelector('[data-summary-status]').value = this.managerState.summaryStatus;
        controls.querySelector('[data-summary-query]').value = this.managerState.summaryQuery;
        root.append(controls);
        const store = this.store.current();
        let items = getAssistantMessages(this.getChat()).map(entry => ({ entry, record: store.summaries[entry.messageId] })).reverse();
        items = items.filter(({ record }) => this.managerState.summaryStatus === 'all'
            || (this.managerState.summaryStatus === 'missing' && !record)
            || (this.managerState.summaryStatus === 'failed' && record?.status === 'failed')
            || (this.managerState.summaryStatus === 'success' && record && ['frozen', 'manual-edited'].includes(record.status ?? 'frozen')));
        const query = this.managerState.summaryQuery.trim().toLowerCase();
        if (query) items = items.filter(({ entry, record }) => `${entry.floor} ${record?.title ?? ''} ${record?.storyTime ?? ''} ${record?.location ?? ''} ${this.statusLabel(record)}`.toLowerCase().includes(query));
        const page = this.paginate(items, this.managerState.summaryPage, 20);
        this.managerState.summaryPage = page.page;
        const list = this.element('div', 'cache-memory-card-list');
        for (const item of page.items) list.append(this.summaryCard(item));
        if (!page.items.length) list.append(this.element('p', 'cache-memory-empty', '暂无记忆'));
        root.append(list, this.pagination('summaryPage', page));
        return root;
    }

    renderCheckpointPage() {
        const root = this.element('div', 'cache-memory-manager-page');
        const controls = this.element('div', 'cache-memory-list-controls');
        controls.innerHTML = '<button type="button" class="menu_button" data-fold-page="collapse">全部折叠</button><button type="button" class="menu_button" data-fold-page="expand">全部展开</button>';
        root.append(controls);
        const items = [...this.store.current().checkpoints].sort((a, b) => b.startFloor - a.startFloor);
        const page = this.paginate(items, this.managerState.checkpointPage, 15);
        this.managerState.checkpointPage = page.page;
        const list = this.element('div', 'cache-memory-card-list');
        for (const item of page.items) list.append(this.checkpointCard(item));
        if (!page.items.length) list.append(this.element('p', 'cache-memory-empty', '暂无记忆'));
        root.append(list, this.pagination('checkpointPage', page));
        return root;
    }

    renderFactPage() {
        const root = this.element('div', 'cache-memory-manager-page');
        root.append(this.subtabs('factStatus', [['active', '有效事实'], ['retired', '已退休事实']], this.managerState.factStatus));
        const controls = this.element('div', 'cache-memory-list-controls');
        controls.innerHTML = '<button type="button" class="menu_button" data-fold-page="collapse">全部折叠</button><button type="button" class="menu_button" data-fold-page="expand">全部展开</button>';
        root.append(controls);
        const projection = projectLongFacts(this.store.current(), Infinity, { includeTracked: this.getSettings().activeStateEnabled });
        let items = [...projection.facts, ...projection.legacy.map(item => ({ id: item.id, text: item.content, status: 'active',
            floor: item.endFloor, sourceId: item.id, startFloor: item.startFloor, endFloor: item.endFloor,
            storyStartTime: item.storyStartTime ?? '', storyEndTime: item.storyEndTime ?? '', legacy: true }))];
        items = items.filter(item => this.managerState.factStatus === 'active' ? isTrackedActive(item) : !isTrackedActive(item));
        const page = this.paginate(items.sort((a, b) => (b.floor ?? 0) - (a.floor ?? 0)), this.managerState.factPage, 15);
        this.managerState.factPage = page.page;
        const list = this.element('div', 'cache-memory-card-list');
        for (const item of page.items) list.append(this.factCard(item));
        if (!page.items.length) list.append(this.element('p', 'cache-memory-empty', '暂无记忆'));
        root.append(list, this.pagination('factPage', page));
        return root;
    }

    renderLongMemoryPage() {
        const root = this.element('div', 'cache-memory-manager-page');
        const overview = memoryOverviewStats(this.store.current(), getAssistantMessages(this.getChat()), this.getSettings());
        const plan = this.summarizer.getMissingMemoryPlan({ onlyLong: true });
        root.append(this.element('h4', '', '长期记忆 Long Memory'),
            this.element('p', '', `已生成 / 应有：${overview.longMemories.actual} / ${overview.longMemories.expected}`),
            this.element('p', 'cache-memory-help', `按当前分组规则，每满 ${Math.ceil(Math.max(this.getSettings().checkpointInterval, this.getSettings().longMemoryInterval) / this.getSettings().checkpointInterval) * this.getSettings().checkpointInterval} 层应有一段长期记忆。点击生成会先补齐所需的缺失摘要和阶段记忆，已有记忆保持冻结。`));
        const actions = this.element('div', 'cache-memory-actions');
        const generate = this.element('button', 'menu_button cache-memory-primary', '生成缺失的 Long Memory');
        generate.dataset.fillLongMemories = '';
        generate.disabled = !plan.longMemories.length || this.isMissingCheckpointBackfillActive() || this.backfill?.active || this.importingMemory || this.restoringServerMemory;
        const stop = this.element('button', 'menu_button', '安全停止');
        stop.dataset.cancelMissingCheckpoints = ''; stop.disabled = !this.isMissingCheckpointBackfillActive();
        actions.append(generate, stop); root.append(actions);
        const state = this.missingCheckpointState;
        if (state.kind === 'all') root.append(this.element('p', 'cache-memory-help', `${({ running: '正在生成', cancelling: '正在停止', completed: '本次补全完成', failed: '补全未完成', cancelled: '已停止' })[state.status] ?? ''} · ${state.phase ?? ''} · ${state.processed}/${state.total}${state.errors?.length ? `\n${state.errors.at(-1)}` : ''}`));
        if (plan.longMemories.length) root.append(this.element('p', '', `尚未生成：${compactRanges(plan.longMemories.map(range => [range.startFloor, range.endFloor]))}`));
        if (!this.store.current().longMemories.length) root.append(this.element('p', 'cache-memory-empty', overview.longMemories.expected ? '还没有生成 Long Memory，点击上方按钮即可补全。' : '当前楼层还未满一个长期记忆分组。'));
        root.append(this.element('h4', '', '已保存的 Long Memory（点击展开查看全文）'));
        for (const memory of [...this.store.current().longMemories].sort((a, b) => b.startFloor - a.startFloor)) {
            root.append(this.foldCard({ key: `long:${memory.id}`, group: 'facts', type: 'long', id: memory.id,
                title: `${memory.id}｜${memory.startFloor}–${memory.endFloor}层`, status: memoryHealth(memory).label,
                renderBody: body => {
                    body.append(this.line('有效性', memoryHealth(memory).label), this.element('pre', '', memory.content));
                    const actions = this.element('div', 'cache-memory-actions');
                    if (memory.checkpointIds?.length) {
                        const button = this.element('button', 'menu_button', '查看来源阶段记忆');
                        button.dataset.locateType = 'Checkpoint'; button.dataset.locateId = memory.checkpointIds[0]; actions.append(button);
                    }
                    body.append(actions);
                } }));
        }
        return root;
    }

    renderKeepPage() {
        const root = this.element('div', 'cache-memory-manager-page');
        root.append(this.subtabs('keepStatus', [['active', '有效'], ['resolved', '已解决'], ['superseded', '已替代'], ['invalid', '无效']], this.managerState.keepStatus));
        const controls = this.element('div', 'cache-memory-list-controls');
        controls.innerHTML = `<input type="search" data-keep-query placeholder="搜索 KEEP ID、内容或来源"><button type="button" class="menu_button${this.keepBatchMode ? ' cache-memory-primary' : ''}" data-keep-batch-mode>${this.keepBatchMode ? '退出批量编辑' : '批量编辑'}</button>${this.keepBatchMode ? '<button type="button" class="menu_button" data-keep-select-page>全选当前页</button><button type="button" class="menu_button" data-keep-clear-selection>清空选择</button>' : ''}<button type="button" class="menu_button" data-fold-page="collapse">全部折叠</button><button type="button" class="menu_button" data-fold-page="expand">全部展开</button><button type="button" class="menu_button" data-keep-organize>整理 KEEP</button>`;
        controls.querySelector('[data-keep-query]').value = this.managerState.keepQuery;
        root.append(controls);
        let items = collectKeepItems(this.store.current()).filter(item => item.status === this.managerState.keepStatus);
        const query = this.managerState.keepQuery.trim().toLowerCase();
        if (query) items = items.filter(item => `${item.id} ${item.text} ${item.sourceId} ${item.sourceFloor}`.toLowerCase().includes(query));
        items.sort((a, b) => (b.sourceFloor ?? 0) - (a.sourceFloor ?? 0));
        const page = this.paginate(items, this.managerState.keepPage, 15);
        this.managerState.keepPage = page.page;
        const selectPage = controls.querySelector('[data-keep-select-page]');
        if (selectPage) selectPage.dataset.keepIds = page.items.map(item => item.id).join(',');
        if (this.keepBatchMode) {
            const batch = this.element('div', 'cache-memory-actions cache-memory-keep-batch');
            batch.innerHTML = '<span data-keep-selection-count></span><button type="button" class="menu_button" data-keep-batch="resolved">标记已解决</button><button type="button" class="menu_button" data-keep-batch="superseded">标记已替代</button><button type="button" class="menu_button" data-keep-batch="invalid">标记无效</button><button type="button" class="menu_button" data-keep-batch="active">恢复有效</button>';
            batch.querySelector('[data-keep-selection-count]').textContent = `已选择 ${this.keepSelection.size} 条`;
            root.append(batch);
        }
        const list = this.element('div', 'cache-memory-card-list');
        for (const item of page.items) list.append(this.keepCard(item));
        if (!page.items.length) list.append(this.element('p', 'cache-memory-empty', '暂无记忆'));
        root.append(list, this.pagination('keepPage', page));
        return root;
    }

    subtabs(key, options, selected) {
        const tabs = this.element('div', 'cache-memory-subtabs');
        for (const [value, label] of options) {
            const button = this.element('button', value === selected ? 'is-active' : '', label);
            button.type = 'button';
            button.dataset.managerFilter = key;
            button.dataset.value = value;
            tabs.append(button);
        }
        return tabs;
    }

    paginate(items, requestedPage, pageSize) {
        const pages = Math.max(1, Math.ceil(items.length / pageSize));
        const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
        return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pages, total: items.length };
    }

    pagination(key, page) {
        if (!page.total) return this.doc.createDocumentFragment();
        const nav = this.element('div', 'cache-memory-pagination');
        const first = this.element('button', 'menu_button', '首页');
        first.type = 'button'; first.dataset.pageKey = key; first.dataset.pageValue = '1'; first.disabled = page.page <= 1;
        const previous = this.element('button', 'menu_button', '上一页');
        previous.type = 'button'; previous.dataset.pageKey = key; previous.dataset.pageValue = String(page.page - 1); previous.disabled = page.page <= 1;
        const next = this.element('button', 'menu_button', '下一页');
        next.type = 'button'; next.dataset.pageKey = key; next.dataset.pageValue = String(page.page + 1); next.disabled = page.page >= page.pages;
        const last = this.element('button', 'menu_button', '末页');
        last.type = 'button'; last.dataset.pageKey = key; last.dataset.pageValue = String(page.pages); last.disabled = page.page >= page.pages;
        const jump = this.element('label', 'cache-memory-page-jump');
        jump.append(this.doc.createTextNode('跳到 '));
        const input = this.element('input');
        input.type = 'number'; input.min = '1'; input.max = String(page.pages); input.value = String(page.page);
        input.dataset.pageJumpKey = key;
        input.setAttribute('aria-label', `跳到第几页，共 ${page.pages} 页`);
        jump.append(input, this.doc.createTextNode(' 页 '));
        const go = this.element('button', 'menu_button', '跳转');
        go.type = 'button'; go.dataset.pageJump = key;
        jump.append(go);
        nav.append(first, previous, this.element('span', 'cache-memory-page-status', `第 ${page.page} / ${page.pages} 页 · 共 ${page.total} 条`), next, last, jump);
        return nav;
    }

    foldCard({ key, group, title, status, type, id, renderBody }) {
        const card = this.element('details', 'cache-memory-card cache-memory-fold-card');
        card.dataset.cardKey = key; card.dataset.cardGroup = group;
        if (type) card.dataset.memoryType = type;
        if (id) card.dataset.memoryId = id;
        card.open = this.managerExpanded[group].has(key);
        const summary = this.element('summary', 'cache-memory-card-summary');
        summary.append(this.element('span', 'cache-memory-card-arrow', '▶'), this.element('strong', 'cache-memory-card-title', title), this.element('span', 'cache-memory-card-status', status));
        card.append(summary);
        const materialize = () => {
            card.querySelector('.cache-memory-card-body')?.remove();
            if (!card.open) return;
            const body = this.element('div', 'cache-memory-card-body');
            renderBody(body);
            card.append(body);
        };
        card.addEventListener('toggle', () => {
            if (card.open) this.managerExpanded[group].add(key); else this.managerExpanded[group].delete(key);
            materialize();
        }, { signal: this.controller.signal });
        materialize();
        return card;
    }

    isEditing(type, id) {
        return this.managerEditing?.type === type && this.managerEditing?.id === id;
    }

    inlineEditor(body, fields) {
        const form = this.element('div', 'cache-memory-inline-editor');
        for (const field of fields) {
            const label = this.element('label', 'cache-memory-inline-field');
            label.append(this.element('span', '', field.label));
            let input;
            if (field.options) {
                input = this.element('select');
                for (const [value, text] of field.options) {
                    const option = this.element('option', '', text);
                    option.value = value;
                    input.append(option);
                }
            } else if (field.multiline) {
                input = this.element('textarea');
                input.rows = field.rows ?? 4;
            } else {
                input = this.element('input');
                input.type = 'text';
            }
            input.dataset.editField = field.key;
            input.value = String(field.value ?? '');
            label.append(input);
            form.append(label);
        }
        const actions = this.element('div', 'cache-memory-actions cache-memory-inline-actions');
        actions.innerHTML = '<button type="button" class="menu_button cache-memory-primary" data-manager-edit-save>保存</button><button type="button" class="menu_button" data-manager-edit-cancel>取消</button>';
        form.append(actions);
        body.append(form);
    }

    checkpointDisplay(body, item) {
        const fields = parseCheckpointSections(item.content);
        if (!fields) {
            body.append(this.element('div', 'cache-memory-raw-content', item.status === 'failed' ? item.error || item.content : item.content));
            return;
        }
        const sections = this.element('div', 'cache-memory-structured-sections');
        for (const [key, , label] of CHECKPOINT_SECTIONS) {
            const section = this.element('section', 'cache-memory-structured-section');
            section.append(this.element('h5', '', label), this.element('p', '', fields[key] || '无'));
            sections.append(section);
        }
        body.append(sections);
    }

    summaryCard({ entry, record }) {
        const baseStatus = this.statusLabel(record);
        const count = record && record.status !== 'failed' ? [record.title, record.characters, record.event, record.state, record.open, record.quote, record.keep]
            .map(value => String(value ?? '').trim()).filter(Boolean).join('\n').length : 0;
        const limit = this.getSettings().summaryMaxLength;
        const status = count ? `${baseStatus} · ${count}/${limit} 字${count > limit * 1.15 ? ' · 偏长' : ''}` : baseStatus;
        return this.foldCard({ key: entry.messageId, group: 'summaries', type: 'summary', id: entry.messageId,
            title: `第${entry.floor}层｜${record?.title ?? status}`, status, renderBody: body => {
                if (!record) body.append(this.element('p', '', '该楼层尚未生成 Summary。'));
                else if (record.status === 'failed') body.append(this.element('pre', '', formatSummaryFailure(record)));
                else if (this.isEditing('summary', entry.messageId)) this.inlineEditor(body, [
                    { key: 'title', label: 'Title', value: record.title },
                    { key: 'storyTime', label: '剧情日期/时间 StoryTime', value: record.storyTime },
                    { key: 'location', label: '地点 Location', value: record.location },
                    ...[['characters', 'Characters', 3], ['event', 'Event', 7], ['state', 'State', 5], ['open', 'Open', 5], ['quote', 'Quote', 4], ['keep', 'KEEP', 5]]
                        .map(([key, label, rows]) => ({ key, label, rows, multiline: true, value: record[key] })),
                ]);
                else {
                    body.append(this.line('标题', record.title), this.line('剧情日期/时间｜地点', `${record.storyTime || '未提供'}｜${record.location || '未提供'}`), this.line('人物', record.characters), this.line('事件', record.event),
                        this.line('状态', record.state), this.line('Open', record.open), this.line('原话', record.quote), this.line('KEEP', record.keep));
                }
                if (this.isEditing('summary', entry.messageId)) return;
                const actions = this.element('div', 'cache-memory-actions');
                actions.innerHTML = `<button type="button" class="menu_button" data-manager-action="regenerate">${record?.status === 'failed' ? '重试' : record ? '重新生成' : '生成本层记忆'}</button>${record && record.status !== 'failed' ? '<button type="button" class="menu_button" data-manager-action="edit">编辑</button>' : ''}${record ? '<button type="button" class="menu_button" data-manager-action="delete">删除</button>' : ''}`;
                body.append(actions);
            } });
    }

    checkpointCard(item) {
        const fields = parseCheckpointSections(item.content);
        return this.foldCard({ key: item.id, group: 'checkpoints', type: 'checkpoint', id: item.id,
            title: `${String(item.id).replace(/^checkpoint-/i, 'CP-').toUpperCase()}｜${item.startFloor}–${item.endFloor}层`, status: this.statusLabel(item), renderBody: body => {
                body.append(this.line('有效性', memoryHealth(item).label));
                body.append(this.line('剧情日期/时间范围', item.storyStartTime && item.storyEndTime ? `${item.storyStartTime} → ${item.storyEndTime}` : item.storyStartTime || item.storyEndTime),
                    this.line('当前剧情日期/时间｜地点', `${item.currentStoryTime || '未提供'}｜${item.currentLocation || '未提供'}`));
                if (this.isEditing('checkpoint', item.id)) {
                    this.inlineEditor(body, fields ? CHECKPOINT_SECTIONS.map(([key, section, label]) => ({
                        key, label: `${label} · ${section}`, value: fields[key], multiline: true, rows: 5,
                    })) : [{ key: 'rawContent', label: '原始 Checkpoint（旧格式）', value: item.content, multiline: true, rows: 14 }]);
                    return;
                }
                this.checkpointDisplay(body, item);
                const actions = this.element('div', 'cache-memory-actions');
                actions.innerHTML = '<button type="button" class="menu_button" data-update-checkpoint>更新本条</button><button type="button" class="menu_button" data-manager-action="edit">编辑</button><button type="button" class="menu_button" data-manager-action="delete">删除</button>';
                body.append(actions);
            } });
    }

    factParts(text) {
        const match = String(text ?? '').match(/^【([^|｜】]+)[|｜]([^】]+)】\s*(.*)$/s);
        return match ? { subject: match[1].trim(), category: match[2].trim(), detail: match[3].trim() }
            : { subject: '未分类', category: '长期事实', detail: String(text ?? '').trim() };
    }

    factCard(item) {
        const parts = this.factParts(item.text);
        return this.foldCard({ key: item.id, group: 'facts', type: 'fact', id: item.id, title: `${String(item.id).toUpperCase()}｜${parts.subject}｜${parts.category}`,
            status: isTrackedActive(item) ? '有效' : item.status === 'retired' ? '已退休' : '已替代', renderBody: body => {
                if (this.isEditing('fact', item.id)) {
                    this.inlineEditor(body, item.legacy
                        ? [{ key: 'rawContent', label: '长期记忆原始内容（旧格式）', value: item.text, multiline: true, rows: 14 }]
                        : [{ key: 'subject', label: '事实标题 / 人物 / 主题', value: parts.subject },
                            { key: 'category', label: '类别', value: parts.category },
                            { key: 'detail', label: '事实正文', value: parts.detail, multiline: true, rows: 7 }]);
                    return;
                }
                body.append(this.line('事实', parts.detail), this.line('来源', `${item.sourceId ?? '未知'}${item.startFloor ? ` · 第${item.startFloor}–${item.endFloor}层` : ''}`));
                body.append(this.line('剧情日期/时间范围', item.storyStartTime && item.storyEndTime ? `${item.storyStartTime} → ${item.storyEndTime}` : item.storyStartTime || item.storyEndTime));
                if (item.reason) body.append(this.line('变更原因', item.reason));
                if (item.evidence) body.append(this.line('证据', item.evidence));
                const actions = this.element('div', 'cache-memory-actions');
                actions.innerHTML = item.tracked ? '<button type="button" class="menu_button" data-manager-view="states">查看 / 纠正角色状态</button>' : '<button type="button" class="menu_button" data-manager-action="edit">编辑</button>';
                body.append(actions);
            } });
    }

    keepCategory(text) {
        const value = String(text ?? '');
        if (/秘密|隐瞒|不知道|误以为/.test(value)) return '长期秘密/认知差';
        if (/承诺|答应|约定|誓言/.test(value)) return '重要承诺';
        if (/计划|任务|伏笔/.test(value)) return '长期计划/伏笔';
        if (/物品|伤|债|责任|边界/.test(value)) return '持续影响';
        return '长期事项';
    }

    keepCard(item) {
        const category = this.keepCategory(item.text);
        const short = item.text.length > 32 ? `${item.text.slice(0, 32)}…` : item.text;
        const labels = { active: '有效', resolved: '已解决', superseded: '已替代', invalid: '无效' };
        const wrapper = this.element('div', 'cache-memory-keep-row');
        wrapper.dataset.memoryType = 'keep';
        wrapper.dataset.memoryId = item.id;
        const select = this.element('input', 'cache-memory-keep-select');
        select.type = 'checkbox'; select.checked = this.keepSelection.has(item.id); select.dataset.keepSelect = item.id;
        select.setAttribute('aria-label', `选择 ${item.id}`);
        const card = this.foldCard({ key: item.id, group: 'keeps', type: 'keep', id: item.id, title: `${String(item.id).toUpperCase()}｜${category}｜${short}`,
            status: labels[item.status] ?? item.status, renderBody: body => {
                if (this.isEditing('keep', item.id)) {
                    const status = this.managerEditing?.presetStatus ?? item.status;
                    this.inlineEditor(body, [
                        { key: 'text', label: 'KEEP 内容', value: item.text, multiline: true, rows: 6 },
                        { key: 'status', label: '状态', value: status, options: Object.entries(labels) },
                        { key: 'reason', label: '状态备注 / 原因', value: item.reason, multiline: true, rows: 3 },
                        { key: 'evidence', label: '证据备注', value: item.evidence, multiline: true, rows: 3 },
                        { key: 'replacedBy', label: '替代 KEEP ID', value: item.replacedBy },
                    ]);
                    return;
                }
                body.append(this.line('内容', item.text),
                    this.line('来源', `${item.sourceFloor ? `第 ${item.sourceFloor} 层` : '未知'} · 剧情日期/时间 ${item.sourceStoryTime || '未提供'}｜${item.sourceLocation || '未提供'}`),
                    this.line('来源 ID', item.sourceId || '未知'), this.line('状态', labels[item.status] ?? item.status));
                if (item.resolvedStoryTime) body.append(this.line('解决剧情日期/时间', item.resolvedStoryTime));
                if (item.reason) body.append(this.line('原因', item.reason));
                if (item.evidence) body.append(this.line('证据', item.evidence));
                if (item.replacedBy) body.append(this.line('替代项', item.replacedBy));
                const actions = this.element('div', 'cache-memory-actions');
                actions.innerHTML = '<button type="button" class="menu_button" data-manager-action="edit">编辑</button><button type="button" class="menu_button" data-keep-single-status="resolved">标记已解决</button><button type="button" class="menu_button" data-keep-single-status="superseded">标记已替代</button><button type="button" class="menu_button" data-keep-single-status="invalid">标记无效</button><button type="button" class="menu_button" data-keep-single-status="active">恢复有效</button>';
                body.append(actions);
            } });
        if (!this.keepBatchMode) return card;
        wrapper.append(select, card);
        return wrapper;
    }

    showTaskProgress(state) {
        if (!state || state.status === 'idle') return;
        const generated = state.created ?? state.success ?? 0;
        const done = ['completed', 'failed', 'cancelled'].includes(state.status);
        const failed = state.status === 'failed' || Boolean(state.failed);
        const label = state.status === 'cancelled' ? '已停止' : failed && done ? generated ? '部分生成失败' : '生成失败'
            : done ? generated ? '生成成功' : '扫描完成，无需生成'
            : ({ paused: '已暂停', pausing: '正在暂停', cancelling: '正在停止' }[state.status] ?? '正在处理');
        this.setStatus(done ? failed ? 'error' : 'success' : 'busy', `${label}${state.phase ? ` · ${state.phase}` : ''} · ${state.processed ?? 0}/${state.total ?? 0}\n生成 ${generated} · 跳过 ${state.skipped ?? 0} · 失败 ${state.failed ?? 0}${state.errors?.length ? `\n${state.errors.at(-1)}` : state.error ? `\n${state.error}` : ''}`);
    }

    renderBackfillProgress() {
        if (!this.manager || this.destroyed || !this.manager.querySelector('[data-backfill-range]')) return;
        const assistants = getAssistantMessages(this.getChat());
        const latest = assistants.at(-1)?.floor ?? 0;
        const chatId = this.store.current().chatId;
        if (this.backfill.active && this.backfill.chatId !== chatId) this.backfill.cancel({ discard: true });
        const s = this.backfill.state;
        this.manager.querySelector('[data-backfill-range]').textContent = latest ? `当前正常 assistant 楼层：1–${latest}（共 ${latest} 层）` : '当前聊天没有可总结的 assistant 楼层';
        const start = this.manager.querySelector('[data-backfill-start]');
        const end = this.manager.querySelector('[data-backfill-end]');
        if (this.backfillFormChatId !== chatId || !end.value) { start.value = '1'; end.value = String(latest); this.backfillFormChatId = chatId; }
        for (const field of this.manager.querySelectorAll('[data-backfill-start], [data-backfill-end], [data-backfill-mode]')) field.disabled = this.backfill.active;
        start.max = end.max = String(latest);
        const labels = { idle: '等待开始', running: '正在补齐', pausing: '当前请求结束后暂停', paused: '已暂停', cancelling: '正在取消', aggregating: '正在生成阶段记忆', completed: '已完成', cancelled: '已取消' };
        this.manager.querySelector('[data-backfill-status]').textContent = `${labels[s.status]} · ${s.processed} / ${s.total}${s.currentFloor ? ` · 当前：第 ${s.currentFloor} 层` : ''}\n成功：${s.success} · 失败：${s.failed} · 跳过：${s.skipped} · 重试：${s.retries}${s.error ? `\n${s.error}` : ''}`;
        const progress = this.manager.querySelector('[data-backfill-progress]');
        progress.max = s.total || 1;
        progress.value = s.processed;
        for (const button of this.manager.querySelectorAll('[data-backfill-action]')) {
            const action = button.dataset.backfillAction;
            button.disabled = action === 'pause' ? s.status !== 'running' : action === 'resume' ? !['paused', 'pausing'].includes(s.status)
                : action === 'cancel' ? !['running', 'pausing', 'paused'].includes(s.status) : this.backfill.active || this.isMissingCheckpointBackfillActive() || !latest;
        }
        for (const button of this.manager.querySelectorAll('[data-manager-action], [data-fill-missing], [data-continue-checkpoint], [data-import-merge], [data-fill-missing-checkpoints], [data-aggregate-continue]')) {
            const messageId = button.closest('[data-memory-type="summary"]')?.dataset.memoryId;
            button.disabled = this.backfill.active || this.isMissingCheckpointBackfillActive() || Boolean(messageId && this.summarizer.isSummarizing(messageId));
        }
    }

    async startBackfill(options) {
        if (this.isMissingCheckpointBackfillActive() || this.importingMemory || this.restoringServerMemory) return;
        if (options.mode === 'all' && !await this.showPluginDialog({ title: '强制重新生成', message: '强制重新生成会替换所选范围内已有的小总结，冻结的阶段记忆仍保留。', confirmLabel: '确认重新生成' })) return;
        try { await this.backfill.start(options); }
        catch (error) { notify('error', error.message); }
        this.renderManager();
        this.renderMessageMemories();
    }

    async handleManagerClick(event) {
        if (event.target.closest('[data-fill-long-memories]')) return this.startMissingMemoryBackfill({ onlyLong: true });
        if (event.target.closest('[data-fill-all-memories]')) return this.startMissingMemoryBackfill();
        if (event.target.closest('[data-read-server]')) {
            if (this.restoringServerMemory) return;
            if (this.importingMemory || this.isMissingCheckpointBackfillActive() || this.backfill?.active
                || this.summarizer.inFlight?.size || this.summarizer.pendingSummaries?.size) throw new Error('请先停止正在进行的记忆生成或导入，再从服务器恢复');
            const id = this.store.current().chatId, epoch = this.persistence.epoch;
            this.restoringServerMemory = true;
            const resumeSaves = this.persistence.pauseSaves(id);
            try {
                const prepared = await this.persistence.prepareRestore(id, { requireSaved: true });
                if (this.store.current().chatId !== id || this.persistence.epoch !== epoch) return;
                if (memoryContentDigest(prepared.remote) !== prepared.localDigest || prepared.pending || prepared.conflict) {
                    if (!await this.showPluginDialog({ title: '从服务器恢复记忆',
                        message: `服务器已保存 ${Object.keys(prepared.remote.summaries).length} 条摘要。确认后使用服务器版本替换本机当前记忆及未上传修改。`, confirmLabel: '确认恢复' })) return;
                }
                this.persistence.restoreServerSnapshot(prepared);
                this.summarizer.invalidateContext();
                this.lastMergeReport = null;
                this.updateInjection('chat changed');
                this.renderManager(); this.renderMessageMemories();
                notify('success', '已从服务器恢复当前聊天记忆'); return;
            } finally {
                resumeSaves();
                this.restoringServerMemory = false;
            }
        }
        if (event.target.closest('[data-validate-memory]')) {
            const rows = this.store.revalidate(this.getChat()); this.renderManager();
            notify('success', `本地校验完成：${rows.length} 条阶段记忆仍需处理；没有调用模型。`); return;
        }
        const update = event.target.closest('[data-update-checkpoints], [data-update-checkpoint]');
        if (update) {
            const id = update.closest('[data-memory-id]')?.dataset.memoryId;
            await this.startCheckpointUpdate(id ? [id] : null); return;
        }
        const locate = event.target.closest('[data-locate-type]');
        if (locate) {
            const type = locate.dataset.locateType, id = locate.dataset.locateId, floor = Number(locate.dataset.locateFloor);
            this.managerView = type === 'Summary' ? 'summaries' : type === 'Checkpoint' ? 'checkpoints' : 'long';
            if (type === 'Summary') {
                this.managerState.summaryQuery = String(floor); this.managerState.summaryStatus = 'all'; this.managerState.summaryPage = 1;
                if (id) this.managerExpanded.summaries.add(id);
            } else if (type === 'Checkpoint') {
                const items = [...this.store.current().checkpoints].sort((a, b) => b.startFloor - a.startFloor);
                this.managerState.checkpointPage = Math.floor(Math.max(0, items.findIndex(item => item.id === id)) / 15) + 1;
                if (id) this.managerExpanded.checkpoints.add(id);
            } else if (id) this.managerExpanded.facts.add(`long:${id}`);
            this.renderManager();
            this.root.requestAnimationFrame(() => [...this.manager.querySelectorAll('[data-memory-id]')].find(card => card.dataset.memoryId === id)?.scrollIntoView({ block: 'start' }));
            return;
        }
        if (event.target.closest('[data-view-summary-health]')) {
            this.showSummaryHealthDetails = !this.showSummaryHealthDetails;
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-save-memory]')) {
            if (this.restoringServerMemory) return;
            const chatId = this.store.current().chatId;
            this.persistence?.enqueue(this.store.current(), 'manual save');
            const status = await this.persistence?.flush(chatId);
            this.renderMemorySaveState();
            notify(status?.state === 'confirmed' ? 'success' : 'warning', status?.state === 'confirmed'
                ? '记忆已上传服务器并读回确认'
                : `上传尚未确认：${status?.detail || '状态未知'}`);
            return;
        }
        if (event.target.closest('[data-import-merge]')) {
            this.manager.querySelector('[data-import-merge-file]').click();
            return;
        }
        const conflictAction = event.target.closest('[data-memory-conflict]');
        if (conflictAction) {
            const chatId = this.store.current().chatId, epoch = this.persistence.epoch;
            const bundle = this.persistence?.conflictBundle(chatId);
            if (!bundle) return;
            const action = conflictAction.dataset.memoryConflict;
            if (action === 'export') { downloadJson('cache-memory-conflict.json', bundle, this.doc); return; }
            if (this.isMissingCheckpointBackfillActive() || this.backfill?.active) throw new Error('请先安全停止正在运行的维护');
            if (!await this.showPluginDialog({ title: '确认恢复冲突记忆', message: `将按${action === 'server' ? '服务器' : '本机'}副本处理差异，替换冲突项，并重新核对服务器。`, confirmLabel: '确认恢复', danger: true })) return;
            if (this.store.current().chatId !== chatId || this.persistence.epoch !== epoch) return;
            const result = await (action === 'merge' ? this.persistence.resolveConflictByMerge(chatId) : this.persistence.resolveConflict(chatId, action));
            if (!result) return;
            this.lastMergeReport = result;
            this.store.syncMessages(this.getChat());
            this.renderManager(); this.renderMessageMemories();
            const state = this.persistence.getState(chatId);
            notify(state.state === 'confirmed' ? 'success' : 'warning', state.state === 'confirmed' ? '冲突选择已保存并读回确认' : state.detail);
            return;
        }
        if (event.target.closest('[data-cancel-missing-checkpoints]')) {
            this.cancelMissingCheckpointBackfill();
            return;
        }
        if (event.target.closest('[data-fill-missing-checkpoints]')) {
            await this.startMissingCheckpointBackfill();
            return;
        }
        if (event.target.closest('[data-reinject]')) {
            this.updateInjection('manual reinject');
            notify('success', 'Cache Memory 已重新注入');
            this.renderManager();
            return;
        }
        const editCard = event.target.closest('[data-memory-type]');
        if (editCard && event.target.closest('[data-manager-edit-cancel]')) {
            this.managerEditing = null;
            this.renderManager();
            return;
        }
        if (editCard && event.target.closest('[data-manager-edit-save]')) {
            this.saveInlineEdit(editCard);
            return;
        }
        const clearButton = event.target.closest('[data-clear-current-chat]');
        if (clearButton) {
            const confirmed = await this.showPluginDialog({
                title: '清空当前聊天记忆',
                message: '只会清空当前聊天的 Summary / Checkpoint / Long Memory / KEEP，不影响原聊天正文和插件设置。清空后不能撤销。',
                confirmLabel: '确认清空',
                danger: true,
            });
            if (!confirmed) return;
            clearButton.disabled = true;
            try {
                this.backfill?.cancel({ discard: true });
                this.cancelMissingCheckpointBackfill({ discard: true });
                this.summarizer.invalidateContext();
                this.apiClient.abortAll();
                this.store.clearCurrentChat();
                this.backfill?.reset();
                this.resetManagerTransientState();
                this.updateInjection('current chat cleared');
                this.setStatus('success', '当前聊天的 Cache Memory 已清空；历史摘要不会自动重建。');
                this.renderMessageMemories();
                this.renderManager();
                notify('success', '当前聊天记忆已清空。需要时可手动“补齐缺失摘要”。');
            } catch (error) {
                notify('error', `清空失败：${error.message}`);
            } finally {
                if (clearButton.isConnected) clearButton.disabled = false;
            }
            return;
        }
        const selectPage = event.target.closest('[data-keep-select-page]');
        if (selectPage) {
            for (const id of selectPage.dataset.keepIds.split(',').filter(Boolean)) this.keepSelection.add(id);
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-keep-batch-mode]')) {
            this.keepBatchMode = !this.keepBatchMode;
            this.keepSelection.clear();
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-keep-clear-selection]')) {
            this.keepSelection.clear();
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-keep-organize]')) {
            if (!await this.showPluginDialog({ title: '整理 KEEP', message: '仅在本地规范化 KEEP 文本，并把完全相同的重复项标记为无效；不会调用模型或删除记录。', confirmLabel: '确认整理' })) return;
            const result = this.store.organizeKeepRegistry();
            notify('success', `整理完成：规范化 ${result.normalized} 条，标记精确重复/空白 ${result.duplicates} 条。`);
            this.renderManager();
            return;
        }
        const keepBatch = event.target.closest('[data-keep-batch]');
        if (keepBatch) {
            if (!this.keepSelection.size) { notify('warning', '请先选择 KEEP。'); return; }
            if (this.applyKeepStatus([...this.keepSelection], keepBatch.dataset.keepBatch)) {
                this.keepSelection.clear();
                this.renderManager();
            }
            return;
        }
        const keepRow = event.target.closest('[data-memory-type="keep"]');
        const keepStatus = event.target.closest('[data-keep-single-status]');
        if (keepRow && keepStatus) {
            this.beginInlineEdit('keep', keepRow.dataset.memoryId, { presetStatus: keepStatus.dataset.keepSingleStatus });
            this.renderManager();
            return;
        }
        const view = event.target.closest('[data-manager-view]');
        if (view) { this.managerView = view.dataset.managerView; this.renderManager(); return; }
        const filter = event.target.closest('[data-manager-filter]');
        if (filter) {
            this.managerState[filter.dataset.managerFilter] = filter.dataset.value;
            this.managerState[filter.dataset.managerFilter === 'factStatus' ? 'factPage' : 'keepPage'] = 1;
            this.renderManager();
            return;
        }
        const pageButton = event.target.closest('[data-page-key]');
        if (pageButton && !pageButton.disabled) {
            this.managerState[pageButton.dataset.pageKey] = Number(pageButton.dataset.pageValue);
            this.renderManager();
            return;
        }
        const pageJump = event.target.closest('[data-page-jump]');
        if (pageJump) {
            this.jumpToManagerPage(pageJump.dataset.pageJump);
            return;
        }
        const fold = event.target.closest('[data-fold-page]');
        if (fold) {
            for (const card of this.manager.querySelectorAll('[data-card-key][data-card-group]')) {
                const set = this.managerExpanded[card.dataset.cardGroup];
                if (fold.dataset.foldPage === 'expand') set.add(card.dataset.cardKey); else set.delete(card.dataset.cardKey);
            }
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-reparse-summaries]')) {
            const count = this.store.reparseStructuredSummaries(raw => parseFloorSummary(raw, this.getSettings().summaryMaxLength, { preserveFull: true }));
            notify('success', count ? `已在本地重新解析 ${count} 条结构化摘要，未调用 API。` : '没有可重新解析的结构化摘要。');
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-aggregate-continue]')) {
            if (this.isMissingCheckpointBackfillActive() || this.backfill?.active) return;
            const start = Number(this.manager.querySelector('[data-aggregate-start]')?.value);
            event.target.closest('[data-aggregate-continue]').disabled = true;
            try { await this.summarizer.enqueueForCurrentChat(() => this.summarizer.generateAggregatesFrom(start)); }
            catch (error) { notify('error', error.message); }
            this.renderManager();
            return;
        }
        if (event.target.closest('[data-export]')) {
            const chatId = this.store.current().chatId || 'chat';
            downloadJson(`cache-memory-${chatId}.json`, this.store.current(), this.doc);
            return;
        }
        const batchButton = event.target.closest('[data-backfill-action]');
        if (batchButton) {
            const action = batchButton.dataset.backfillAction;
            if (['pause', 'resume', 'cancel'].includes(action)) return this.backfill[action]();
            const latest = getAssistantMessages(this.getChat()).at(-1);
            if (!latest || this.backfill.active || this.isMissingCheckpointBackfillActive()) return;
            if (action === 'latest') {
                const record = this.store.getSummary(latest.messageId);
                if (record && record.status !== 'failed' && !await this.showPluginDialog({ title: '重新生成最新摘要', message: '重新生成当前最新层摘要？', confirmLabel: '确认重新生成' })) return;
                batchButton.disabled = true;
                try { await this.summarizer.summarizeMessage(latest.messageId, { overwrite: Boolean(record) }); }
                catch (error) { notify('error', error.message); }
                this.renderManager();
                return;
            }
            return this.startBackfill(action === 'start' ? {
                startFloor: Number(this.manager.querySelector('[data-backfill-start]').value),
                endFloor: Number(this.manager.querySelector('[data-backfill-end]').value),
                mode: this.manager.querySelector('[data-backfill-mode]').value,
            } : { startFloor: 1, endFloor: latest.floor, mode: action });
        }
        const fill = event.target.closest('[data-fill-missing]');
        if (fill) {
            const floors = fill.dataset.fillMissing.split(',').map(Number);
            return this.startBackfill({ startFloor: Math.min(...floors), endFloor: Math.max(...floors), mode: 'missing-failed' });
        }
        const continuation = event.target.closest('[data-continue-checkpoint]');
        if (continuation) {
            const [start, end] = continuation.dataset.continueCheckpoint.split(':').map(Number);
            continuation.disabled = true;
            try {
                await this.summarizer.enqueueForCurrentChat(async () => {
                    await this.summarizer.generateCheckpoint(start, end, { allowMissing: true });
                    await this.summarizer.generateDueLongMemories();
                });
            } catch (error) { notify('error', error.message); }
            this.renderManager();
            return;
        }
        const button = event.target.closest('[data-manager-action]');
        const card = button?.closest('[data-memory-type]');
        if (!button || !card) return;
        const type = card.dataset.memoryType;
        const id = card.dataset.memoryId;
        const action = button.dataset.managerAction;
        if (action === 'delete') {
            if (!await this.showPluginDialog({ title: '删除记忆', message: '删除这条记忆？聊天正文不会被修改。', confirmLabel: '确认删除', danger: true })) return;
            if (type === 'summary') this.store.deleteSummary(id);
            else this.store.deleteAggregate(type, id);
        } else if (action === 'edit') {
            this.beginInlineEdit(type, id);
        } else if (action === 'regenerate') {
            const existing = type === 'summary' ? this.store.getSummary(id) : true;
            if (existing && existing.status !== 'failed' && !await this.showPluginDialog({ title: '重新生成记忆', message: '仅按该条记忆的固定来源重新生成并替换它。继续？', confirmLabel: '确认重新生成' })) return;
            button.disabled = true;
            try { await this.regenerate(type, id); } catch (error) { notify('error', error.message); }
        }
        this.renderMessageMemories();
        this.renderManager();
    }

    resetManagerTransientState() {
        this.managerView = 'overview';
        this.managerState = { summaryStatus: 'all', summaryQuery: '', summaryPage: 1, checkpointPage: 1, factStatus: 'active', factPage: 1, keepStatus: 'active', keepQuery: '', keepPage: 1 };
        this.keepSelection.clear();
        this.keepBatchMode = false;
        for (const expanded of Object.values(this.managerExpanded)) expanded.clear();
        this.managerEditing = null;
        this.backfillFormChatId = null;
    }

    handleManagerInput(event) {
        if (event.target.matches('[data-keep-select]')) {
            if (event.target.checked) this.keepSelection.add(event.target.dataset.keepSelect);
            else this.keepSelection.delete(event.target.dataset.keepSelect);
            const count = this.manager.querySelector('[data-keep-selection-count]');
            if (count) count.textContent = `已选择 ${this.keepSelection.size} 条`;
            return;
        }
        if (event.target.matches('[data-keep-query]')) {
            this.managerState.keepQuery = event.target.value;
            this.managerState.keepPage = 1;
            if (event.type === 'input') {
                this.renderManager();
                const input = this.manager.querySelector('[data-keep-query]');
                input?.focus();
                input?.setSelectionRange?.(input.value.length, input.value.length);
            }
            return;
        }
        if (event.target.matches('[data-summary-status]')) {
            this.managerState.summaryStatus = event.target.value;
            this.managerState.summaryPage = 1;
            this.renderManager();
            return;
        }
        if (event.target.matches('[data-summary-query]')) {
            this.managerState.summaryQuery = event.target.value;
            this.managerState.summaryPage = 1;
            if (event.type === 'input') {
                this.renderManager();
                const input = this.manager.querySelector('[data-summary-query]');
                input?.focus();
                input?.setSelectionRange?.(input.value.length, input.value.length);
            }
        }
    }

    handleManagerKeydown(event) {
        if (event.key !== 'Enter' || !event.target.matches('[data-page-jump-key]')) return;
        event.preventDefault();
        this.jumpToManagerPage(event.target.dataset.pageJumpKey);
    }

    jumpToManagerPage(key) {
        const input = this.manager?.querySelector(`[data-page-jump-key="${key}"]`);
        if (!input) return;
        const minimum = Number(input.min) || 1;
        const maximum = Math.max(minimum, Number(input.max) || minimum);
        const requested = Math.round(Number(input.value) || minimum);
        this.managerState[key] = Math.min(maximum, Math.max(minimum, requested));
        this.renderManager();
    }

    applyKeepStatus(ids, status) {
        const labels = { active: '恢复有效', resolved: '标记已解决', superseded: '标记已替代', invalid: '标记无效' };
        if (!labels[status]) return false;
        const reason = status === 'active' ? '' : status === 'invalid' ? '人工整理：不应作为长期 KEEP' : `人工${labels[status]}`;
        this.store.setKeepStatus(ids, status, { reason });
        notify('success', `${labels[status]} ${ids.length} 条 KEEP。`);
        return true;
    }

    beginInlineEdit(type, id, extra = {}) {
        const groups = { summary: 'summaries', checkpoint: 'checkpoints', fact: 'facts', keep: 'keeps' };
        const group = groups[type];
        if (!group) return;
        this.managerExpanded[group].add(id);
        this.managerEditing = { type, id, ...extra };
    }

    inlineEditValues(card) {
        return Object.fromEntries([...card.querySelectorAll('[data-edit-field]')]
            .map(input => [input.dataset.editField, String(input.value ?? '').trim()]));
    }

    saveInlineEdit(card) {
        const type = card.dataset.memoryType;
        const id = card.dataset.memoryId;
        if (!this.isEditing(type, id)) return;
        const values = this.inlineEditValues(card);
        const edited = { manualEdited: true, frozen: true, status: 'manual-edited', editedAt: new Date().toISOString() };
        if (type === 'summary') {
            values.title ||= '未命名摘要';
            const source = getAssistantMessages(this.getChat()).find(item => item.messageId === id);
            this.store.updateSummary(id, { ...values, raw: buildStructuredSummary(values), format: 'structured', ...edited,
                ...(source ? { sourceFingerprint: source.fingerprint, sourceValidity: 'valid' } : {}),
                stateChangesNeedsReview: true,
            });
        } else if (type === 'checkpoint') {
            const content = Object.hasOwn(values, 'rawContent') ? values.rawContent : buildCheckpointContent(values);
            this.store.updateAggregate('checkpoint', id, { content, ...edited });
        } else if (type === 'fact') {
            const legacy = this.store.current().longMemories.find(item => item.id === id && item.memoryKind !== 'facts');
            if (legacy) this.store.updateAggregate('long', id, { content: values.rawContent, ...edited });
            else {
                const subject = values.subject || '未分类';
                const category = values.category || '长期事实';
                const detail = values.detail || '无';
                this.store.updateFact(id, `【${subject}｜${category}】${detail}`);
            }
        } else if (type === 'keep') {
            if (!values.text) {
                notify('warning', 'KEEP 内容不能为空。');
                return;
            }
            const updates = {
                text: values.text,
                status: values.status,
                reason: values.status === 'active' ? '' : values.reason,
                evidence: values.status === 'active' ? '' : values.evidence,
                replacedBy: values.status === 'active' ? '' : values.replacedBy,
            };
            this.store.updateKeep(id, updates);
        }
        this.managerEditing = null;
        this.renderMessageMemories();
        this.renderManager();
    }

    async regenerate(type, id) {
        if (type === 'summary') return this.summarizer.summarizeMessage(id, { overwrite: true });
        if (type === 'checkpoint') {
            const item = this.store.current().checkpoints.find(entry => entry.id === id);
            return this.summarizer.enqueueForCurrentChat(() => this.summarizer.generateCheckpoint(item.startFloor, item.endFloor, { overwrite: true, allowMissing: true }));
        }
        const item = this.store.current().longMemories.find(entry => entry.id === id);
        const checkpoints = this.store.current().checkpoints.filter(entry => item.checkpointIds.includes(entry.id));
        return this.summarizer.enqueueForCurrentChat(() => this.summarizer.generateLongMemory(checkpoints, { overwrite: true }));
    }

    async importMergeFile(event) {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file || this.importingMemory || this.restoringServerMemory) return;
        this.importingMemory = true;
        const chatId = this.store.current().chatId, epoch = this.persistence?.epoch;
        const active = () => this.store.current().chatId === chatId && this.persistence?.epoch === epoch;
        try {
            if (!chatId || !this.persistence) throw new Error('请先打开要恢复的聊天');
            if (this.isMissingCheckpointBackfillActive() || this.backfill?.active || (this.summarizer.inFlight?.size || this.summarizer.pendingSummaries?.size)) throw new Error('请先停止维护队列，再导入');
            const inspected = inspectMemoryImport(JSON.parse(await file.text()), chatId, { assistants: getAssistantMessages(this.getChat()) });
            if (!active()) return;
            const prepared = await this.persistence.prepareRestore(chatId);
            if (!active()) return;
            const before = structuredClone(this.store.current());
            const digest = memoryContentDigest(before);
            if (!await this.showPluginDialog({
                title: '导入记忆 JSON',
                message: `文件与当前聊天匹配。\n${Object.entries(inspected.counts).map(([name, count]) => `${name}：${count}`).join('\n')}\n${inspected.warnings.join('\n')}\n确认后按此文件替换当前聊天记忆。`,
                confirmLabel: '确认导入',
            })) return;
            if (!active()) return;
            if (memoryContentDigest(this.store.current()) !== digest) throw new Error('确认期间当前记忆发生变化，请重新选择文件');
            const result = prepareMemoryImport(before, inspected);
            this.persistence.acceptRestoreBase(prepared);
            // Enqueue with restore intent; persistence checks this exact server
            // baseline again before writing and retains both sides on a race.
            this.summarizer.invalidateContext();
            this.store.replace(result.merged, 'memory import');
            this.store.syncMessages(this.getChat());
            this.lastMergeReport = null;
            const status = await this.persistence.flush(chatId);
            if (!active()) return;
            this.renderManager(); this.renderMessageMemories();
            notify(status.state === 'confirmed' ? 'success' : 'warning', status.state === 'confirmed' ? '导入完成并已从服务器读回确认' : `导入尚未确认，已停止后续写入：${status.detail}`);
        } catch (error) { notify('error', `导入未完成：${error.message}；请检查保存状态后重试`); }
        finally { this.importingMemory = false; }
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.backfill?.cancel({ discard: true });
        this.cancelMissingCheckpointBackfill({ discard: true });
        this.controller.abort();
        if (this.wandFrame != null) this.root.cancelAnimationFrame(this.wandFrame);
        this.style?.remove();
        if (this.root[OWNER_KEY] === this) delete this.root[OWNER_KEY];
        this.wandObserver?.disconnect();
        this.wandObserver = null;
        this.doc.getElementById(ROOT_ID)?.remove();
        this.doc.getElementById(CONFIG_ID)?.remove();
        this.doc.getElementById(WAND_CONTAINER_ID)?.remove();
        this.activeDialog?.remove();
        this.doc.querySelectorAll('.cache-memory-message').forEach(element => element.remove());
        this.doc.body.classList.remove('cache-memory-config-open');
        this.config = null;
        this.manager = null;
    }
}
