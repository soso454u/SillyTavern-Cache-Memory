import { withGlobalPrompt } from './defaults.js?v=1.22.12';
import { clampText, getAssistantMessages, replacePromptVariables } from './utils.js?v=1.22.12';
import { collectKeepItems, formatKeepItems, formatLongFacts, hasAggregateContent, isUsableMemory, parseFactUpdates, previousState, projectLongFacts, readSection, resolveKeepItems, summaryText } from './continuity.js?v=1.22.12';
import { buildStructuredSummary, parseStructuredSummary, stripStructuredSections } from './summary-format.js?v=1.22.12';
import { extractSummarySource } from './summary-source.js?v=1.22.12';
import { extractStoryMetadata, storyMetadataRange, summarySourceWithMetadata } from './story-metadata.js?v=1.22.12';
import { summaryVersion, aggregateVersion, summaryMatchesEntry } from './memory-store.js?v=1.22.12';
import { parseStateChanges, projectActiveState, stateContext, deduplicateCheckpoint, reconcileTrackedCheckpoint, trackedFactUpdates, trackedLines, isTrackedActive, activeStateVersion, STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES } from './active-state.js?v=1.22.12';

function pad(value) {
    return String(value).padStart(3, '0');
}

function trackedContext(store, settings, floor) {
    if (!settings.activeStateEnabled) return '';
    const context = stateContext(store, floor);
    return context === '无' ? '' : `\n\n[CURRENT_TRACKED_STATE]\n${context}`;
}

function nextSequenceId(prefix, items) {
    const maximum = items.reduce((current, item) => {
        const match = String(item.id ?? '').match(new RegExp(`^${prefix}-(\\d+)$`));
        return Math.max(current, Number(match?.[1]) || 0);
    }, 0);
    return `${prefix}-${pad(maximum + 1)}`;
}

function chatChangedError(kind) {
    const error = new Error(`聊天已切换，已丢弃旧聊天的 ${kind} 响应`);
    error.code = 'CHAT_CHANGED';
    return error;
}

function metadataValue(value) {
    const text = String(value ?? '').trim();
    return /^(?:无|未知|未提供|不详|none|null|n\/a)[。.]?$/i.test(text) ? '' : text;
}

export function parseFloorSummary(text, maxLength, { preserveFull = false } = {}) {
    const source = String(text ?? '').trim();
    const read = tag => source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.trim() ?? '';
    const structured = parseStructuredSummary(source);
    if (structured) return {
        title: structured.title || '未命名摘要',
        characters: structured.characters || '未明确',
        storyTime: metadataValue(structured.storyTime),
        location: metadataValue(structured.location),
        event: structured.event,
        state: structured.state,
        open: structured.open,
        quote: structured.quote,
        keep: structured.keep,
        changes: structured.changes ?? '',
        raw: structured.raw,
        format: 'structured',
    };
    const title = read('title') || readSection(source, 'Title') || '未命名摘要';
    const characters = read('characters') || readSection(source, 'Characters') || '未明确';
    const storyTime = metadataValue(read('storyTime') || read('story_time') || readSection(source, 'StoryTime'));
    const location = metadataValue(read('location') || readSection(source, 'Location'));
    const event = read('event') || source;
    // maxLength is a generation target, never a client-side truncation rule.
    return { title, characters, storyTime, location, event, state: '', open: '', quote: '', keep: '', raw: source, format: 'legacy' };
}

export class MemorySummarizer {
    constructor({ store, apiClient, getSettings, getChat, getPersistenceState = () => ({}), flushMemory = async () => ({ state: 'confirmed' }), commitMemory = async mutate => mutate(), onStatus = () => {} }) {
        this.store = store;
        this.getPersistenceState = getPersistenceState;
        this.flushMemory = flushMemory;
        this.commitMemory = commitMemory;
        this.apiClient = apiClient;
        this.getSettings = getSettings;
        this.getChat = getChat;
        this.onStatus = onStatus;
        this.queue = Promise.resolve();
        this.inFlight = new Set();
        this.pendingSummaries = new Map();
        this.aggregateDeferrals = 0;
        this.contextRevision = 0;
    }

    invalidateContext() { this.contextRevision++; }

    generationStore() {
        const store = this.store.current();
        return { ...store, summaries: Object.fromEntries(this.store.currentSummaries(this.getChat()).map(item => [item.messageId, item])),
            checkpoints: store.checkpoints.filter(item => !item.sourceReplaced),
            longMemories: store.longMemories.filter(item => !item.sourceReplaced) };
    }

    assertUnambiguousPrevious(startFloor, includeCheckpoints = true) {
        const store = this.generationStore(), ranges = new Map();
        for (const [type, rows] of [['Checkpoint', includeCheckpoints ? store.checkpoints : []], ['Long Memory', store.longMemories]]) for (const item of rows) {
            if (!isUsableMemory(item) || !(item.endFloor < startFloor)) continue;
            const key = `${type}:${item.startFloor}:${item.endFloor}`;
            const version = aggregateVersion({ ...item, id: '' });
            if (ranges.has(key) && ranges.get(key) !== version) throw new Error(`前序第 ${item.startFloor}–${item.endFloor} 层有无法确认的不同记录，请先重新生成该范围`);
            ranges.set(key, version);
        }
    }

    isSummarizing(messageId) {
        const key = `${this.store.current().chatId}:${messageId}`;
        return this.inFlight.has(key) || this.pendingSummaries.has(key);
    }

    enqueue(task) {
        const pending = this.queue.then(task);
        this.queue = pending.catch(() => {});
        return pending;
    }

    enqueueForCurrentChat(task) {
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        return this.enqueue(() => {
            if (chatId !== this.store.current().chatId || revision !== this.contextRevision) throw chatChangedError('记忆');
            return task();
        });
    }

    enqueueLatest() {
        const revision = this.contextRevision;
        const chatId = this.store.current().chatId;
        return this.enqueue(() => {
            if (revision !== this.contextRevision || this.store.current().chatId !== chatId) return null;
            return this.summarizeLatest();
        }).catch(error => this.onStatus('error', error.message));
    }

    async summarizeLatest() {
        const settings = this.getSettings();
        if (!settings.enabled || !settings.autoSummarize || !settings.independentApi) return null;
        const assistants = this.store.syncMessages(this.getChat());
        const latest = assistants.at(-1);
        if (!latest || this.isSummarizing(latest.messageId)) return null;
        return this.summarizeEntry(latest);
    }

    async summarizeMessage(messageId, options = {}) {
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        const key = `${chatId}:${messageId}`;
        if (this.pendingSummaries.has(key)) return this.pendingSummaries.get(key);
        const pending = this.enqueue(() => {
            if (revision !== this.contextRevision || this.store.current().chatId !== chatId) throw chatChangedError('摘要');
            if (options.signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            const entry = getAssistantMessages(this.getChat()).find(item => item.messageId === messageId);
            if (!entry) throw new Error('原文不存在，无法生成');
            if (options.expectedFingerprint && options.expectedFingerprint !== entry.fingerprint) {
                throw Object.assign(new Error('原文已编辑或切换备选回复，请重新选择楼层'), { code: 'SOURCE_CHANGED' });
            }
            return this.summarizeEntry(entry, options);
        }).finally(() => {
            this.pendingSummaries.delete(key);
            this.onStatus('settled', '');
        });
        this.pendingSummaries.set(key, pending);
        this.onStatus('busy', '摘要已排队');
        return pending;
    }

    async summarizeEntry(entry, { overwrite = false, deferAggregates = false, signal } = {}) {
        const existing = this.store.getSummaryForEntry(entry) ?? this.store.summaryCandidates(entry).map(([, item]) => item).find(isUsableMemory);
        // Missing legacy fingerprints cannot prove an edit and must not cause
        // automatic regeneration. They remain stored but are not aggregate inputs.
        if (isUsableMemory(existing) && (summaryMatchesEntry(existing, entry) || !existing.sourceContentFingerprint) && !overwrite) return existing;
        overwrite ||= Boolean(this.store.getSummary(entry.messageId));
        const flightKey = `${this.store.current().chatId}:${entry.messageId}`;
        if (this.inFlight.has(flightKey)) return null;
        this.inFlight.add(flightKey);
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        const targetVersions = () => JSON.stringify(this.store.summaryCandidates(entry).map(([id, item]) => [id, summaryVersion(item)]).sort());
        const expectedTargets = targetVersions();
        const assertContext = () => {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('摘要');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            const current = getAssistantMessages(this.getChat()).find(item => item.messageId === entry.messageId);
            if (!current || current.fingerprint !== entry.fingerprint || current.floor !== entry.floor) {
                throw Object.assign(new Error('请求期间原文已编辑、删除或切换备选回复，请重试本层'), { code: 'SOURCE_CHANGED' });
            }
            if (targetVersions() !== expectedTargets) throw Object.assign(new Error('另一窗口或设备已更新本层记忆，未覆盖较新摘要'), { code: 'SOURCE_CHANGED' });
        };
        this.onStatus('busy', `正在总结第 ${entry.floor} 层`);
        try {
            assertContext();
            const systemPrompt = replacePromptVariables(settings.prompts.summary, {
                maxLength: settings.summaryMaxLength,
                floor: entry.floor,
            });
            const summarySource = extractSummarySource(entry.message.mes, settings);
            const sourceMetadata = extractStoryMetadata(entry.message.mes);
            if (settings.cacheDebug) console.info('[Cache Memory] SUMMARY SOURCE', {
                strategy: settings.summaryFilterMode,
                source: summarySource.source,
                originalChars: String(entry.message.mes ?? '').length,
                inputChars: summarySource.text.length,
                storyTimeFound: Boolean(sourceMetadata.storyTime),
                locationFound: Boolean(sourceMetadata.location),
            });
            const result = await this.apiClient.complete({
                systemPrompt: withGlobalPrompt(settings, systemPrompt + (settings.activeStateEnabled ? STATE_EXTRACTION_RULES : '')),
                userContent: summarySourceWithMetadata(summarySource.text, sourceMetadata)
                    + trackedContext(this.generationStore(), settings, entry.floor - 1),
                maxTokens: settings.summaryMaxTokens,
                signal,
            });
            if (result.finishReason === 'length') throw new Error('模型输出达到 token 上限，请提高最大输出长度后重试');
            const parsed = parseFloorSummary(result.content, settings.summaryMaxLength, { preserveFull: settings.memoryStrategy !== 'legacy' });
            if (!String(parsed.event || parsed.raw || '').trim()) throw new Error('摘要输出为空，原记忆保留');
            parsed.storyTime = sourceMetadata.storyTime;
            parsed.location = sourceMetadata.location;
            if (parsed.format === 'structured') parsed.raw = buildStructuredSummary(parsed);
            assertContext();
            const record = {
                floor: entry.floor,
                messageIndex: entry.messageIndex,
                messageId: entry.messageId,
                sourceFingerprint: entry.fingerprint,
                sourceContentFingerprint: entry.contentFingerprint,
                sourceMessageKey: entry.sourceMessageKey,
                title: parsed.title,
                characters: parsed.characters,
                storyTime: parsed.storyTime,
                location: parsed.location,
                event: parsed.event,
                state: parsed.state,
                open: parsed.open,
                quote: parsed.quote,
                keep: parsed.keep,
                ...(settings.activeStateEnabled ? { stateChanges: parseStateChanges(parsed.changes, summarySource.text, projectActiveState(this.generationStore(), entry.floor - 1)) } : {}),
                raw: parsed.raw,
                format: parsed.format,
                createdAt: new Date().toISOString(),
                manualEdited: false,
                frozen: true,
                status: 'frozen',
            };
            await this.commitMemory(() => this.store.addSummary(record, { overwrite, entry, background: deferAggregates || this.aggregateDeferrals > 0 }), assertContext);
            let aggregateFailure = '';
            try {
                if (!deferAggregates && !this.aggregateDeferrals) await this.generateDueAggregates({ signal });
            } catch (error) {
                if (error.code === 'CHAT_CHANGED') throw error;
                aggregateFailure = error.message;
            }
            this.onStatus(aggregateFailure ? 'warning' : 'success', aggregateFailure
                ? `第 ${entry.floor} 层摘要已冻结，但分层记忆生成失败：${aggregateFailure}`
                : `第 ${entry.floor} 层摘要已冻结`);
            return record;
        } catch (error) {
            // Network failures can arrive after a chat switch or source edit too.
            try { assertContext(); } catch (contextError) { error = contextError; }
            if (['CHAT_CHANGED', 'REQUEST_ABORTED', 'SOURCE_CHANGED', 'SAVE_UNCONFIRMED'].includes(error.code)) {
                this.onStatus('warning', error.message);
                throw error;
            }
            if (!existing || existing.frozen === false || existing.status === 'failed') this.store.addSummary({
                floor: entry.floor,
                messageIndex: entry.messageIndex,
                messageId: entry.messageId,
                sourceFingerprint: entry.fingerprint,
                sourceContentFingerprint: entry.contentFingerprint,
                sourceMessageKey: entry.sourceMessageKey,
                title: '生成失败',
                characters: '',
                event: '',
                raw: '',
                createdAt: new Date().toISOString(),
                manualEdited: false,
                frozen: false,
                status: 'failed',
                error: error.message,
                errorCategory: error.category,
                errorCode: error.code,
                errorDiagnostics: error.diagnostics,
            }, { overwrite: true });
            this.onStatus('error', `第 ${entry.floor} 层摘要失败：${error.message}`, error);
            throw error;
        } finally {
            this.inFlight.delete(flightKey);
            this.onStatus('settled', '');
        }
    }

    getNextCheckpointRange() {
        const settings = this.getSettings();
        const checkpoints = this.store.current().checkpoints.filter(isUsableMemory).sort((a, b) => a.startFloor - b.startFloor);
        let startFloor = 1;
        while (true) {
            const next = checkpoints.find(item => item.startFloor === startFloor && item.endFloor >= item.startFloor);
            if (!next) break;
            startFloor = next.endFloor + 1;
        }
        return { startFloor, endFloor: startFloor + settings.checkpointInterval - 1 };
    }

    getMissingMemoryPlan({ onlyLong = false } = {}) {
        const settings = this.getSettings(), store = this.store.current();
        const assistants = getAssistantMessages(this.getChat());
        const latestFloor = assistants.at(-1)?.floor ?? 0;
        const checkpointInterval = Math.max(1, Number(settings.checkpointInterval) || 5);
        const longSpan = Math.ceil(Math.max(checkpointInterval, Number(settings.longMemoryInterval) || 50) / checkpointInterval) * checkpointInterval;
        const missingRanges = (items, interval) => {
            const ranges = [];
            for (let startFloor = 1; startFloor + interval - 1 <= latestFloor; startFloor += interval) {
                const endFloor = startFloor + interval - 1;
                if (!items.some(item => item.startFloor === startFloor && item.endFloor === endFloor && isUsableMemory(item) && !item.sourceReplaced)) ranges.push({ startFloor, endFloor });
            }
            return ranges;
        };
        const longMemories = missingRanges(store.longMemories, longSpan);
        const needed = floor => !onlyLong || longMemories.some(range => floor >= range.startFloor && floor <= range.endFloor);
        return { latestFloor, summaries: assistants.filter(entry => needed(entry.floor) && (!isUsableMemory(this.store.getSummaryForEntry(entry)) || !summaryMatchesEntry(this.store.getSummaryForEntry(entry), entry))),
            checkpoints: missingRanges(store.checkpoints, checkpointInterval).filter(range => needed(range.startFloor)), longMemories };
    }

    async fillMissingMemories({ signal, onProgress = () => {}, onlyLong = false } = {}) {
        const chatId = this.store.current().chatId, revision = this.contextRevision;
        this.store.syncMessages(this.getChat());
        const plan = this.getMissingMemoryPlan({ onlyLong });
        const result = { total: plan.summaries.length + plan.checkpoints.length + plan.longMemories.length,
            processed: 0, created: 0, skipped: 0, failed: 0, errors: [], currentRange: null, phase: 'Summary' };
        const assertActive = () => {
            if (signal?.aborted) throw Object.assign(new Error('记忆补全已停止'), { code: 'REQUEST_ABORTED' });
            if (chatId !== this.store.current().chatId || revision !== this.contextRevision) throw chatChangedError('记忆补全');
            if (this.getPersistenceState().state === 'conflict') throw new Error('检测到跨设备冲突，补全已停止');
        };
        const save = async () => {
            assertActive();
            const state = await this.flushMemory(chatId);
            assertActive();
            if (state?.state !== 'confirmed') throw new Error(`记忆尚未确认保存，补全已停止：${state?.detail || '状态未知'}`);
        };
        this.aggregateDeferrals++;
        try {
            await this.store.withAggregateBatch(async () => {
                onProgress({ ...result });
                for (const [phase, entries] of [['Summary', plan.summaries], ['Checkpoint', plan.checkpoints], ['Long Memory', plan.longMemories]]) {
                    for (const entry of entries) {
                        assertActive();
                        result.phase = phase;
                        result.currentRange = { startFloor: entry.floor ?? entry.startFloor, endFloor: entry.floor ?? entry.endFloor };
                        onProgress({ ...result });
                        let record;
                        if (phase === 'Summary') {
                            const existing = this.store.getSummary(entry.messageId);
                            if (isUsableMemory(existing) && summaryMatchesEntry(existing, entry)) { result.skipped++; result.processed++; onProgress({ ...result }); continue; }
                            record = await this.summarizeMessage(entry.messageId, { overwrite: Boolean(existing), deferAggregates: true, signal, expectedFingerprint: entry.fingerprint });
                        } else {
                            const items = phase === 'Checkpoint' ? this.store.current().checkpoints : this.store.current().longMemories;
                            const existing = items.find(item => item.startFloor === entry.startFloor && item.endFloor === entry.endFloor);
                            if (isUsableMemory(existing) && !existing.sourceReplaced) { result.skipped++; result.processed++; onProgress({ ...result }); continue; }
                            record = await this.enqueueForCurrentChat(() => {
                                assertActive();
                                if (phase === 'Checkpoint') return this.generateCheckpoint(entry.startFloor, entry.endFloor, { overwrite: Boolean(existing), signal });
                                const sources = this.store.current().checkpoints.filter(item => item.startFloor >= entry.startFloor && item.endFloor <= entry.endFloor && isUsableMemory(item)).sort((a, b) => a.startFloor - b.startFloor);
                                if (sources[0]?.startFloor !== entry.startFloor || sources.at(-1)?.endFloor !== entry.endFloor) throw new Error('Long Memory 的阶段记忆尚未补齐');
                                return this.generateLongMemory(sources, { overwrite: Boolean(existing), signal });
                            });
                        }
                        if (!isUsableMemory(record)) throw new Error(`${phase} 第 ${result.currentRange.startFloor}–${result.currentRange.endFloor} 层未能生成`);
                        await save();
                        result.created++; result.processed++;
                        onProgress({ ...result });
                    }
                }
                result.currentRange = null;
                onProgress({ ...result });
            });
            await save();
            return result;
        } catch (error) {
            if (['REQUEST_ABORTED', 'CHAT_CHANGED'].includes(error.code)) throw error;
            result.failed++; result.errors.push(`${result.phase}${result.currentRange ? ` 第 ${result.currentRange.startFloor}–${result.currentRange.endFloor} 层` : ''}：${error.message}`);
            onProgress({ ...result });
            return result;
        } finally { this.aggregateDeferrals--; }
    }

    getMissingCheckpointPlan() {
        const interval = Math.max(1, Number(this.getSettings().checkpointInterval) || 5);
        const assistants = getAssistantMessages(this.getChat());
        const latestFloor = assistants.at(-1)?.floor ?? 0;
        const byFloor = new Map(assistants.map(entry => [entry.floor, entry]));
        const store = this.store.current();
        const candidates = [];
        const blocked = [];
        const existing = [];
        for (let startFloor = 1; startFloor + interval - 1 <= latestFloor; startFloor += interval) {
            const endFloor = startFloor + interval - 1;
            const range = { startFloor, endFloor };
            const checkpoint = store.checkpoints.find(item => item.startFloor === startFloor && item.endFloor === endFloor);
            if (checkpoint && hasAggregateContent(checkpoint)) {
                existing.push({ ...range, checkpointId: checkpoint.id });
                continue;
            }
            const missingFloors = [];
            for (let floor = startFloor; floor <= endFloor; floor += 1) {
                const entry = byFloor.get(floor);
                const summary = entry ? store.summaries[entry.messageId] : null;
                if (!summary || !isUsableMemory(summary)) missingFloors.push(floor);
            }
            if (missingFloors.length) blocked.push({ ...range, missingFloors });
            else candidates.push(range);
        }
        return { interval, latestFloor, candidates, blocked, existing };
    }

    async fillMissingCheckpoints({ signal, onProgress = () => {} } = {}) {
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        const plan = this.getMissingCheckpointPlan();
        const result = {
            total: plan.candidates.length,
            processed: 0,
            created: 0,
            skipped: 0,
            failed: 0,
            currentRange: null,
            blocked: plan.blocked,
            errors: [],
        };
        const assertActive = () => {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('阶段记忆补齐');
            if (signal?.aborted) throw Object.assign(new Error('阶段记忆补齐已取消'), { code: 'REQUEST_ABORTED' });
        };
        onProgress({ ...result });
        return this.store.withAggregateBatch(async () => {
            for (const range of plan.candidates) {
                assertActive();
                result.currentRange = { ...range };
                onProgress({ ...result });
                const existing = this.store.current().checkpoints.find(item => item.startFloor === range.startFloor && item.endFloor === range.endFloor);
                if (existing && hasAggregateContent(existing)) {
                    result.skipped++;
                } else {
                    try {
                        const created = await this.generateCheckpoint(range.startFloor, range.endFloor, { overwrite: Boolean(existing), signal });
                        if (created) result.created++;
                        else result.skipped++;
                    } catch (error) {
                        if (['CHAT_CHANGED', 'REQUEST_ABORTED'].includes(error.code)) throw error;
                        result.failed++;
                        result.errors.push(`第 ${range.startFloor}–${range.endFloor} 层：${error.message}`);
                    }
                }
                result.processed++;
                onProgress({ ...result });
            }
            result.currentRange = null;
            onProgress({ ...result });
            return result;
        });
    }

    getCheckpointUpdatePlan(ids = null) {
        const store = this.store.current();
        const selected = new Set(ids ?? store.checkpoints.filter(item => !isUsableMemory(item) || item.factCorrection || item.sourceReplaced).map(item => item.id));
        return store.checkpoints.filter(item => selected.has(item.id)).sort((a, b) => a.startFloor - b.startFloor).map(item => ({
            id: item.id, startFloor: item.startFloor, endFloor: item.endFloor,
            missingFloors: Array.from({ length: item.endFloor - item.startFloor + 1 }, (_, i) => item.startFloor + i)
                .filter(floor => !this.store.currentSummaries(this.getChat()).some(summary => summary.floor === floor)),
        }));
    }

    async updateCheckpoints({ ids = null, signal, onProgress = () => {} } = {}) {
        if (this.getPersistenceState().state === 'conflict') throw new Error('请先解决跨设备冲突，再更新阶段记忆');
        const chatId = this.store.current().chatId, revision = this.contextRevision;
        this.store.revalidate(this.getChat());
        const plan = this.getCheckpointUpdatePlan(ids);
        const progress = { total: plan.length, processed: 0, created: 0, skipped: 0, failed: 0, errors: [], currentRange: null };
        this.store.maintenanceDepth = (this.store.maintenanceDepth || 0) + 1;
        try {
            for (const range of plan) {
                if (signal?.aborted) throw Object.assign(new Error('阶段更新已安全停止'), { code: 'REQUEST_ABORTED' });
                if (this.store.current().chatId !== chatId || this.contextRevision !== revision) throw chatChangedError('阶段更新');
                if (this.getPersistenceState().state === 'conflict') throw new Error('检测到跨设备冲突，更新已停止');
                progress.currentRange = range; onProgress({ ...progress });
                const current = this.store.current().checkpoints.find(cp => cp.id === range.id);
                if (!ids && isUsableMemory(current) && !current.factCorrection && !current.sourceReplaced) { progress.skipped++; progress.processed++; onProgress({ ...progress }); continue; }
                try {
                    const created = await this.generateCheckpoint(range.startFloor, range.endFloor, { overwrite: true, signal });
                    if (!created) throw new Error('来源 Summary 尚不可用，请先读取服务器、校验或修复摘要');
                    const saved = await this.flushMemory(chatId);
                    if (saved?.state !== 'confirmed') throw new Error(`更新结果尚未确认保存：${saved?.detail || '状态未知'}`);
                    progress.created++;
                } catch (error) {
                    if (['CHAT_CHANGED', 'REQUEST_ABORTED'].includes(error.code)) throw error;
                    progress.failed++; progress.errors.push(`${range.id}（${range.startFloor}–${range.endFloor}）：${error.message}`);
                    progress.processed++; onProgress({ ...progress });
                    break; // Downstream stages cannot consume a failed/unconfirmed predecessor.
                }
                progress.processed++; onProgress({ ...progress });
            }
        } finally { this.store.maintenanceDepth--; }
        progress.currentRange = null; onProgress({ ...progress });
        return progress;
    }

    async generateAggregatesFrom(startFloor, { signal } = {}) {
        const settings = this.getSettings();
        const latestFloor = getAssistantMessages(this.getChat()).at(-1)?.floor ?? 0;
        let start = Math.max(1, Math.floor(Number(startFloor) || 1));
        return this.store.withAggregateBatch(async () => {
            while (start + settings.checkpointInterval - 1 <= latestFloor) {
                const end = start + settings.checkpointInterval - 1;
                const existing = this.store.current().checkpoints.find(item => item.startFloor === start && item.endFloor === end);
                if (!existing || !isUsableMemory(existing)) {
                    const created = await this.generateCheckpoint(start, end, { overwrite: Boolean(existing), signal });
                    if (!created) break;
                }
                await this.generateDueLongMemories({ signal });
                start = end + 1;
            }
        });
    }

    async generateDueAggregates({ signal } = {}) {
        if (this.aggregateDeferrals) return null;
        return this.store.withAggregateBatch(async () => {
            const assistants = getAssistantMessages(this.getChat());
            const latestFloor = assistants.at(-1)?.floor ?? 0;
            let range = this.getNextCheckpointRange();
            while (range.endFloor <= latestFloor) {
                const created = await this.generateCheckpoint(range.startFloor, range.endFloor, { signal });
                if (!created) break;
                if (this.getSettings().memoryStrategy !== 'legacy') await this.generateDueLongMemories({ signal });
                range = this.getNextCheckpointRange();
            }
            await this.generateDueLongMemories({ signal });
        });
    }

    async generateCheckpoint(startFloor, endFloor, { overwrite = false, allowMissing = false, signal } = {}) {
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        const summaries = this.store.currentSummaries(this.getChat())
            .filter(item => item.floor >= startFloor && item.floor <= endFloor && isUsableMemory(item))
            .sort((a, b) => a.floor - b.floor);
        const missing = [];
        for (let floor = startFloor; floor <= endFloor; floor += 1) {
            if (!summaries.some(item => item.floor === floor)) missing.push(floor);
        }
        if (missing.length && !allowMissing) {
            this.onStatus('warning', `第 ${startFloor}-${endFloor} 层存在 ${missing.length} 条缺失摘要`);
            return null;
        }
        if (!summaries.length) throw new Error('该范围没有可用于 Checkpoint 的小总结');
        const checkpoints = this.store.current().checkpoints;
        const existing = checkpoints.find(item => item.startFloor === startFloor && item.endFloor === endFloor);
        if (existing && isUsableMemory(existing) && !existing.sourceReplaced && !overwrite) return existing;
        this.assertUnambiguousPrevious(startFloor);
        const id = checkpoints.find(item => item.startFloor === startFloor && item.endFloor === endFloor)?.id
            ?? nextSequenceId('checkpoint', checkpoints);
        const newSummaries = summaries.map(item => `[第${item.floor}层]\n${summaryText(item)}`).join('\n\n');
        const incremental = settings.memoryStrategy !== 'legacy';
        const state = previousState(this.generationStore(), startFloor);
        if (incremental && settings.activeStateEnabled && state.id) state.content = reconcileTrackedCheckpoint(state.content, this.generationStore(), startFloor - 1, startFloor);
        const preceding = [...checkpoints].filter(cp => cp.endFloor < startFloor).sort((a, b) => b.endFloor - a.endFloor)[0];
        if (preceding && (!isUsableMemory(preceding) || preceding.sourceReplaced)) throw new Error(`前序 ${preceding.id} 尚无当前来源的可用内容，已停止后续生成`);
        const checkpointVersions = state.id ? { [state.id]: aggregateVersion([...checkpoints, ...this.store.current().longMemories].find(cp => cp.id === state.id)) } : {};
        const keeps = collectKeepItems(this.generationStore(), endFloor);
        const keepVersion = JSON.stringify(this.store.current().keepRegistry);
        const storyMetadata = storyMetadataRange(summaries);
        const trackedStateVersion = settings.activeStateEnabled ? activeStateVersion(this.generationStore(), endFloor) : null;
        const sourceVersions = Object.fromEntries(summaries.map(item => [item.messageId, summaryVersion(item)]));
        const chatVersion = JSON.stringify(getAssistantMessages(this.getChat()).map(item => [item.messageId, item.fingerprint]));
        const targetVersions = () => JSON.stringify(this.store.current().checkpoints.filter(item => item.startFloor === startFloor && item.endFloor === endFloor).map(item => [item.id, aggregateVersion(item)]));
        const expectedTargets = targetVersions();
        const assertSources = () => {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Checkpoint');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            if (targetVersions() !== expectedTargets) throw Object.assign(new Error('阶段记忆已被其他窗口更新，未覆盖较新记录'), { code: 'SOURCE_CHANGED' });
            if (JSON.stringify(this.store.current().keepRegistry) !== keepVersion) throw Object.assign(new Error('KEEP 已变化，未提交过期阶段结果'), { code: 'SOURCE_CHANGED' });
            if (trackedStateVersion && trackedStateVersion !== activeStateVersion(this.generationStore(), endFloor)) throw Object.assign(new Error('聚合期间角色状态已变化，请重新校验'), { code: 'SOURCE_CHANGED' });
            if (Object.entries(checkpointVersions).some(([id, version]) => aggregateVersion([...this.store.current().checkpoints, ...this.store.current().longMemories].find(cp => cp.id === id)) !== version)
                || chatVersion !== JSON.stringify(getAssistantMessages(this.getChat()).map(item => [item.messageId, item.fingerprint]))
                || Object.entries(sourceVersions).some(([id, version]) => !isUsableMemory(this.store.getSummary(id)) || summaryVersion(this.store.getSummary(id)) !== version)) {
                throw Object.assign(new Error('聚合期间来源已改变，未提交过期 Checkpoint'), { code: 'SOURCE_CHANGED' });
            }
        };
        const userContent = incremental
            ? `[PREVIOUS_STATE]\n${state.content}\n\n[LONG_FACTS]\n${formatLongFacts(projectLongFacts(this.generationStore(), startFloor - 1))}\n\n[ACTIVE_KEEP]\n${formatKeepItems(keeps)}\n\n[NEW_SUMMARIES]\n${newSummaries}`
            : newSummaries;
        const systemPrompt = replacePromptVariables(settings.prompts.checkpoint, {
            startFloor,
            endFloor,
            maxLength: settings.checkpointMaxLength,
        });
        try {
            const result = await this.apiClient.complete({ systemPrompt: withGlobalPrompt(settings, systemPrompt + (settings.activeStateEnabled ? STATE_AGGREGATION_RULES : '')), userContent: userContent + (settings.activeStateEnabled ? `\n\n[CURRENT_TRACKED_STATE]\n${stateContext(this.generationStore(), endFloor)}` : ''), maxTokens: settings.checkpointMaxTokens, signal });
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Checkpoint');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            assertSources();
            if (result.finishReason === 'length') throw new Error('Checkpoint 输出达到 token 上限，请提高最大输出长度后重试');
            if (!String(result.content ?? '').trim()) throw new Error('阶段记忆输出为空，原记忆保留');
            const record = {
                id,
                startFloor,
                endFloor,
                ...storyMetadata,
                sourceVersions, checkpointVersions, ...(trackedStateVersion ? { trackedStateVersion } : {}),
                content: incremental ? stripStructuredSections(result.content, ['KEEP', 'RESOLVED_KEEP', 'SUPERSEDED_KEEP']) : clampText(result.content, settings.checkpointMaxLength),
                ...(incremental ? {
                    memoryKind: 'state', previousCheckpointId: state.id,
                    summaryIds: summaries.map(item => item.messageId),
                } : {}),
                createdAt: new Date().toISOString(),
                frozen: true,
                manualEdited: false,
                status: 'frozen',
                missingFloors: missing,
            };
            await this.commitMemory(() => {
                if (incremental) this.store.applyKeepItems(resolveKeepItems(keeps, result.content, newSummaries, summaries), { persist: false });
                record.content = settings.activeStateEnabled ? reconcileTrackedCheckpoint(record.content, this.generationStore(), endFloor, startFloor) : deduplicateCheckpoint(record.content);
                return this.store.addCheckpoint(record, { overwrite: overwrite || Boolean(existing && (!isUsableMemory(existing) || existing.sourceReplaced)) });
            }, assertSources);
            return record;
        } catch (error) {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Checkpoint');
            if (['CHAT_CHANGED', 'REQUEST_ABORTED', 'SOURCE_CHANGED', 'SAVE_UNCONFIRMED'].includes(error.code)) throw error;
            if (!existing || existing.status === 'failed') this.store.addCheckpoint({
                id,
                startFloor,
                endFloor,
                ...storyMetadata,
                content: error.message,
                error: error.message,
                createdAt: new Date().toISOString(),
                frozen: false,
                manualEdited: false,
                status: 'failed',
                missingFloors: missing,
            }, { overwrite: true });
            throw error;
        }
    }

    async generateDueLongMemories({ signal } = {}) {
        const settings = this.getSettings();
        const store = this.store.current();
        const committed = store.longMemories.filter(isUsableMemory);
        const usedThrough = committed.length ? Math.max(...committed.map(item => item.endFloor)) : 0;
        const available = store.checkpoints
            .filter(item => item.startFloor > usedThrough && isUsableMemory(item))
            .sort((a, b) => a.startFloor - b.startFloor);
        let group = [];
        let coveredFloors = 0;
        let expectedStart = usedThrough + 1;
        for (const checkpoint of available) {
            if (checkpoint.startFloor !== expectedStart) break;
            group.push(checkpoint);
            coveredFloors += checkpoint.endFloor - checkpoint.startFloor + 1;
            expectedStart = checkpoint.endFloor + 1;
            if (coveredFloors >= settings.longMemoryInterval) {
                await this.generateLongMemory(group, { overwrite: false, signal });
                group = [];
                coveredFloors = 0;
            }
        }
    }

    async generateLongMemory(checkpoints, { overwrite = false, signal } = {}) {
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        if (!Array.isArray(checkpoints) || !checkpoints.length) throw new Error('没有可用于长期记忆的 Checkpoint');
        if (checkpoints.some(item => !isUsableMemory(item) || item.sourceReplaced)) throw new Error('来源 Checkpoint 尚无可用内容，不能用于长期整理');
        const sorted = [...checkpoints].sort((a, b) => a.startFloor - b.startFloor);
        if (sorted.some((item, i) => i && item.startFloor !== sorted[i - 1].endFloor + 1)) throw new Error('来源 Checkpoint 区间存在缺口，不能作为完整 Long Memory 输入');
        const startFloor = sorted[0].startFloor;
        const endFloor = sorted.at(-1).endFloor;
        const longMemories = this.store.current().longMemories;
        const existing = longMemories.find(item => item.startFloor === startFloor && item.endFloor === endFloor);
        if (existing && isUsableMemory(existing) && !existing.sourceReplaced && !overwrite) return existing;
        this.assertUnambiguousPrevious(startFloor, false);
        const id = longMemories.find(item => item.startFloor === startFloor && item.endFloor === endFloor)?.id
            ?? nextSequenceId('long', longMemories);
        const systemPrompt = replacePromptVariables(settings.prompts.longMemory, {
            startFloor,
            endFloor,
            maxLength: settings.longMemoryMaxLength,
        });
        const incremental = settings.memoryStrategy !== 'legacy';
        const projection = projectLongFacts(this.generationStore(), startFloor - 1);
        const newSummaries = this.store.currentSummaries(this.getChat())
            .filter(item => isUsableMemory(item) && item.floor >= startFloor && item.floor <= endFloor)
            .sort((a, b) => a.floor - b.floor).map(item => `[第${item.floor}层]\n${summaryText(item)}`).join('\n\n');
        const sourceSummaries = this.store.currentSummaries(this.getChat())
            .filter(item => isUsableMemory(item) && item.floor >= startFloor && item.floor <= endFloor);
        const storyMetadata = storyMetadataRange(sourceSummaries);
        const sourceVersions = Object.fromEntries(sourceSummaries.map(item => [item.messageId, summaryVersion(item)]));
        const trackedStateVersion = settings.activeStateEnabled ? activeStateVersion(this.generationStore(), endFloor) : null;
        const checkpointVersions = sorted.map(item => JSON.stringify(item));
        const chatVersion = JSON.stringify(getAssistantMessages(this.getChat()).map(item => [item.messageId, item.fingerprint]));
        const targetVersions = () => JSON.stringify(this.store.current().longMemories.filter(item => item.startFloor === startFloor && item.endFloor === endFloor).map(item => [item.id, aggregateVersion(item)]));
        const expectedTargets = targetVersions();
        const assertSources = () => {
            if (targetVersions() !== expectedTargets) throw Object.assign(new Error('长期记忆已被其他窗口更新，未覆盖较新记录'), { code: 'SOURCE_CHANGED' });
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Long Memory');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            if (trackedStateVersion && trackedStateVersion !== activeStateVersion(this.generationStore(), endFloor)) throw Object.assign(new Error('整理期间角色状态已变化，请重新校验'), { code: 'SOURCE_CHANGED' });
            if (chatVersion !== JSON.stringify(getAssistantMessages(this.getChat()).map(item => [item.messageId, item.fingerprint]))
                || Object.entries(sourceVersions).some(([id, version]) => !isUsableMemory(this.store.getSummary(id)) || summaryVersion(this.store.getSummary(id)) !== version)
                || sorted.some((item, index) => { const current = this.store.current().checkpoints.find(cp => cp.id === item.id); return !isUsableMemory(current) || JSON.stringify(current) !== checkpointVersions[index]; })) {
                throw Object.assign(new Error('聚合期间来源已改变，未提交过期 Long Memory'), { code: 'SOURCE_CHANGED' });
            }
        };
        const checkpointText = sorted.map(item => `[${item.id.toUpperCase()} | 第${item.startFloor}-${item.endFloor}层]\n${item.content}`).join('\n\n');
        const userContent = incremental ? `[EXISTING_LONG_FACTS]\n${formatLongFacts(projection)}\n\n[CHECKPOINT_STATE]\n${checkpointText}\n\n[NEW_SUMMARIES]\n${newSummaries}` : checkpointText;
        try {
            const result = await this.apiClient.complete({ systemPrompt: withGlobalPrompt(settings, systemPrompt + (settings.activeStateEnabled ? STATE_AGGREGATION_RULES : '')), userContent: userContent + (settings.activeStateEnabled ? `\n\n[CURRENT_TRACKED_STATE]\n${stateContext(this.generationStore(), endFloor)}` : ''), maxTokens: settings.longMemoryMaxTokens, signal });
            assertSources();
            if (result.finishReason === 'length') throw new Error('长期事实输出达到 token 上限，请提高最大输出长度后重试');
            if (!String(result.content ?? '').trim()) throw new Error('长期记忆输出为空，原记忆保留');
            const record = {
                id,
                startFloor,
                endFloor,
                storyStartTime: storyMetadata.storyStartTime,
                storyEndTime: storyMetadata.storyEndTime,
                checkpointIds: sorted.map(item => item.id),
                sourceVersions, ...(trackedStateVersion ? { trackedStateVersion } : {}),
                checkpointVersions: Object.fromEntries(sorted.map(cp => [cp.id, aggregateVersion(cp)])),
                content: incremental ? result.content.trim() : clampText(result.content, settings.longMemoryMaxLength),
                ...(incremental ? { memoryKind: 'facts', factUpdates: parseFactUpdates(result.content, projection, newSummaries) } : {}),
                createdAt: new Date().toISOString(),
                frozen: true,
                manualEdited: false,
                status: 'frozen',
            };
            if (settings.activeStateEnabled && incremental) {
                record.factUpdates = trackedFactUpdates(record.factUpdates, this.generationStore(), endFloor, projection.facts);
                const threads = trackedLines(this.generationStore(), endFloor, 'thread');
                threads.push(...projectActiveState(this.generationStore(), endFloor).filter(item => item.kind === 'thread' && !item.needsReview && !isTrackedActive(item) && item.sourceFloor >= startFloor)
                    .map(item => `- 已结束 ${item.entity} · ${item.key}：${item.value} (${item.status}，历史结果)`));
                record.continuityState = threads.length ? `[Open Threads]\n${threads.join('\n')}` : '';
            }
            await this.commitMemory(() => this.store.addLongMemory(record, { overwrite: overwrite || Boolean(existing && (!isUsableMemory(existing) || existing.sourceReplaced)) }), assertSources);
            return record;
        } catch (error) {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Long Memory');
            if (['CHAT_CHANGED', 'REQUEST_ABORTED', 'SOURCE_CHANGED', 'SAVE_UNCONFIRMED'].includes(error.code)) throw error;
            if (!existing || existing.status === 'failed') this.store.addLongMemory({
                id,
                startFloor,
                endFloor,
                storyStartTime: storyMetadata.storyStartTime,
                storyEndTime: storyMetadata.storyEndTime,
                checkpointIds: sorted.map(item => item.id),
                content: error.message,
                error: error.message,
                createdAt: new Date().toISOString(),
                frozen: false,
                manualEdited: false,
                status: 'failed',
            }, { overwrite: true });
            throw error;
        }
    }
}
