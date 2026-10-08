import { clampText, getAssistantMessages, replacePromptVariables } from './utils.js?v=1.11.0';
import { collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, parseFactUpdates, previousState, projectLongFacts, readSection, resolveKeepItems, summaryText } from './continuity.js?v=1.11.0';
import { parseStructuredSummary, stripStructuredSections } from './summary-format.js?v=1.11.0';
import { extractSummarySource } from './summary-source.js?v=1.11.0';

function pad(value) {
    return String(value).padStart(3, '0');
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

export function parseFloorSummary(text, maxLength, { preserveFull = false } = {}) {
    const source = String(text ?? '').trim();
    const read = tag => source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.trim() ?? '';
    const structured = parseStructuredSummary(source);
    if (structured) return {
        title: structured.title || '未命名摘要',
        characters: structured.characters || '未明确',
        event: structured.event,
        state: structured.state,
        open: structured.open,
        quote: structured.quote,
        keep: structured.keep,
        raw: structured.raw,
        format: 'structured',
    };
    const title = read('title') || readSection(source, 'Title') || '未命名摘要';
    const characters = read('characters') || readSection(source, 'Characters') || '未明确';
    const event = read('event') || source;
    // maxLength is a generation target, never a client-side truncation rule.
    return { title, characters, event, state: '', open: '', quote: '', keep: '', raw: source, format: 'legacy' };
}

export class MemorySummarizer {
    constructor({ store, apiClient, getSettings, getChat, onStatus = () => {} }) {
        this.store = store;
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
        if (!latest || this.store.getSummary(latest.messageId) || this.isSummarizing(latest.messageId)) return null;
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
        const existing = this.store.getSummary(entry.messageId);
        if (existing && existing.status !== 'failed' && !overwrite) return existing;
        overwrite ||= existing?.status === 'failed';
        const flightKey = `${this.store.current().chatId}:${entry.messageId}`;
        if (this.inFlight.has(flightKey)) return null;
        this.inFlight.add(flightKey);
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
        const revision = this.contextRevision;
        const assertContext = () => {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('摘要');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            const current = getAssistantMessages(this.getChat()).find(item => item.messageId === entry.messageId);
            if (!current || current.fingerprint !== entry.fingerprint || current.floor !== entry.floor) {
                throw Object.assign(new Error('请求期间原文已编辑、删除或切换备选回复，请重试本层'), { code: 'SOURCE_CHANGED' });
            }
        };
        this.onStatus('busy', `正在总结第 ${entry.floor} 层`);
        try {
            assertContext();
            const systemPrompt = replacePromptVariables(settings.prompts.summary, {
                maxLength: settings.summaryMaxLength,
                floor: entry.floor,
            });
            const summarySource = extractSummarySource(entry.message.mes, settings);
            if (settings.cacheDebug) console.info('[Cache Memory] SUMMARY SOURCE', {
                strategy: settings.summaryFilterMode,
                source: summarySource.source,
                originalChars: String(entry.message.mes ?? '').length,
                inputChars: summarySource.text.length,
            });
            const result = await this.apiClient.complete({
                systemPrompt,
                userContent: summarySource.text,
                maxTokens: settings.summaryMaxTokens,
                signal,
            });
            if (result.finishReason === 'length') throw new Error('模型输出达到 token 上限，请提高最大输出长度后重试');
            const parsed = parseFloorSummary(result.content, settings.summaryMaxLength, { preserveFull: settings.memoryStrategy !== 'legacy' });
            assertContext();
            const record = {
                floor: entry.floor,
                messageIndex: entry.messageIndex,
                messageId: entry.messageId,
                sourceFingerprint: entry.fingerprint,
                title: parsed.title,
                characters: parsed.characters,
                event: parsed.event,
                state: parsed.state,
                open: parsed.open,
                quote: parsed.quote,
                keep: parsed.keep,
                raw: parsed.raw,
                format: parsed.format,
                createdAt: new Date().toISOString(),
                manualEdited: false,
                frozen: true,
                status: 'frozen',
            };
            this.store.addSummary(record, { overwrite, background: deferAggregates || this.aggregateDeferrals > 0 });
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
            if (['CHAT_CHANGED', 'REQUEST_ABORTED', 'SOURCE_CHANGED'].includes(error.code)) {
                this.onStatus('warning', error.message);
                throw error;
            }
            if (!existing || existing.frozen === false || existing.status === 'failed') this.store.addSummary({
                floor: entry.floor,
                messageIndex: entry.messageIndex,
                messageId: entry.messageId,
                sourceFingerprint: entry.fingerprint,
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
        const summaries = Object.values(this.store.current().summaries)
            .filter(item => item.floor >= startFloor && item.floor <= endFloor && ['frozen', 'manual-edited'].includes(item.status))
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
        if (existing && isUsableMemory(existing) && !overwrite) return existing;
        const id = checkpoints.find(item => item.startFloor === startFloor && item.endFloor === endFloor)?.id
            ?? nextSequenceId('checkpoint', checkpoints);
        const newSummaries = summaries.map(item => `[第${item.floor}层]\n${summaryText(item)}`).join('\n\n');
        const incremental = settings.memoryStrategy !== 'legacy';
        const state = previousState(this.store.current(), startFloor);
        const keeps = collectKeepItems(this.store.current(), endFloor);
        const userContent = incremental
            ? `[PREVIOUS_STATE]\n${state.content}\n\n[LONG_FACTS]\n${formatLongFacts(projectLongFacts(this.store.current(), startFloor - 1))}\n\n[ACTIVE_KEEP]\n${formatKeepItems(keeps)}\n\n[NEW_SUMMARIES]\n${newSummaries}`
            : newSummaries;
        const systemPrompt = replacePromptVariables(settings.prompts.checkpoint, {
            startFloor,
            endFloor,
            maxLength: settings.checkpointMaxLength,
        });
        try {
            const result = await this.apiClient.complete({ systemPrompt, userContent, maxTokens: settings.checkpointMaxTokens, signal });
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Checkpoint');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            if (result.finishReason === 'length') throw new Error('Checkpoint 输出达到 token 上限，请提高最大输出长度后重试');
            const record = {
                id,
                startFloor,
                endFloor,
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
            if (incremental) this.store.applyKeepItems(resolveKeepItems(keeps, result.content, newSummaries), { persist: false });
            this.store.addCheckpoint(record, { overwrite: overwrite || Boolean(existing && !isUsableMemory(existing)) });
            return record;
        } catch (error) {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Checkpoint');
            if (error.code === 'CHAT_CHANGED' || error.code === 'REQUEST_ABORTED') throw error;
            if (!existing || !isUsableMemory(existing)) this.store.addCheckpoint({
                id,
                startFloor,
                endFloor,
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
            .filter(item => item.startFloor > usedThrough && item.frozen !== false && item.status !== 'failed')
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
        const sorted = [...checkpoints].sort((a, b) => a.startFloor - b.startFloor);
        const startFloor = sorted[0].startFloor;
        const endFloor = sorted.at(-1).endFloor;
        const longMemories = this.store.current().longMemories;
        const existing = longMemories.find(item => item.startFloor === startFloor && item.endFloor === endFloor);
        if (existing && isUsableMemory(existing) && !overwrite) return existing;
        const id = longMemories.find(item => item.startFloor === startFloor && item.endFloor === endFloor)?.id
            ?? nextSequenceId('long', longMemories);
        const systemPrompt = replacePromptVariables(settings.prompts.longMemory, {
            startFloor,
            endFloor,
            maxLength: settings.longMemoryMaxLength,
        });
        const incremental = settings.memoryStrategy !== 'legacy';
        const projection = projectLongFacts(this.store.current(), startFloor - 1);
        const newSummaries = Object.values(this.store.current().summaries)
            .filter(item => isUsableMemory(item) && item.floor >= startFloor && item.floor <= endFloor)
            .sort((a, b) => a.floor - b.floor).map(item => `[第${item.floor}层]\n${summaryText(item)}`).join('\n\n');
        const checkpointText = sorted.map(item => `[${item.id.toUpperCase()} | 第${item.startFloor}-${item.endFloor}层]\n${item.content}`).join('\n\n');
        const userContent = incremental ? `[EXISTING_LONG_FACTS]\n${formatLongFacts(projection)}\n\n[CHECKPOINT_STATE]\n${checkpointText}\n\n[NEW_SUMMARIES]\n${newSummaries}` : checkpointText;
        try {
            const result = await this.apiClient.complete({ systemPrompt, userContent, maxTokens: settings.longMemoryMaxTokens, signal });
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Long Memory');
            if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'REQUEST_ABORTED' });
            if (result.finishReason === 'length') throw new Error('长期事实输出达到 token 上限，请提高最大输出长度后重试');
            const record = {
                id,
                startFloor,
                endFloor,
                checkpointIds: sorted.map(item => item.id),
                content: incremental ? result.content.trim() : clampText(result.content, settings.longMemoryMaxLength),
                ...(incremental ? { memoryKind: 'facts', factUpdates: parseFactUpdates(result.content, projection, newSummaries) } : {}),
                createdAt: new Date().toISOString(),
                frozen: true,
                manualEdited: false,
                status: 'frozen',
            };
            this.store.addLongMemory(record, { overwrite: overwrite || Boolean(existing && !isUsableMemory(existing)) });
            return record;
        } catch (error) {
            if (this.store.current().chatId !== chatId || revision !== this.contextRevision) throw chatChangedError('Long Memory');
            if (error.code === 'CHAT_CHANGED' || error.code === 'REQUEST_ABORTED') throw error;
            if (!existing || !isUsableMemory(existing)) this.store.addLongMemory({
                id,
                startFloor,
                endFloor,
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
