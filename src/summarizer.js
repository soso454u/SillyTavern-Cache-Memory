import { clampText, getAssistantMessages, replacePromptVariables } from './utils.js?v=1.4.0';
import { collectKeepItems, formatKeepItems, formatLongFacts, isUsableMemory, parseFactUpdates, previousState, projectLongFacts, readSection, resolveKeepItems, summaryText } from './continuity.js?v=1.4.0';

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
    const structured = /^\s*\[SUMMARY\]/i.test(source);
    const title = read('title') || readSection(source, 'Title') || '未命名摘要';
    const characters = read('characters') || readSection(source, 'Characters') || '未明确';
    const event = structured
        ? ['Event', 'State', 'Open', 'Quote', 'KEEP'].map(name => {
            const value = readSection(source, name);
            return value ? `[${name}]\n${value}` : '';
        }).filter(Boolean).join('\n\n') || source
        : read('event') || source;
    if (preserveFull) return { title, characters, event, raw: source, format: structured ? 'structured' : 'legacy' };
    const budget = Math.max(20, Number(maxLength) || 350);
    const overhead = title.length + characters.length + 10;
    return {
        title: clampText(title, Math.min(80, budget)),
        characters: clampText(characters, Math.min(160, budget)),
        event: clampText(event, Math.max(20, budget - overhead)),
        raw: clampText(source, budget),
    };
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
    }

    enqueueLatest() {
        this.queue = this.queue.then(() => this.summarizeLatest()).catch(error => this.onStatus('error', error.message));
        return this.queue;
    }

    async summarizeLatest() {
        const settings = this.getSettings();
        if (!settings.enabled || !settings.autoSummarize || !settings.independentApi) return null;
        const assistants = this.store.syncMessages(this.getChat());
        const latest = assistants.at(-1);
        if (!latest || this.store.getSummary(latest.messageId) || this.inFlight.has(latest.messageId)) return null;
        return this.summarizeEntry(latest);
    }

    async summarizeMessage(messageId, { overwrite = false } = {}) {
        const entry = getAssistantMessages(this.getChat()).find(item => item.messageId === messageId);
        if (!entry) throw new Error('对应的 assistant 消息已不存在');
        return this.summarizeEntry(entry, { overwrite });
    }

    async summarizeEntry(entry, { overwrite = false } = {}) {
        const existing = this.store.getSummary(entry.messageId);
        if (existing && !overwrite) return existing;
        if (this.inFlight.has(entry.messageId)) return null;
        this.inFlight.add(entry.messageId);
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
        this.onStatus('busy', `正在总结第 ${entry.floor} 层`);
        try {
            const systemPrompt = replacePromptVariables(settings.prompts.summary, {
                maxLength: settings.summaryMaxLength,
                floor: entry.floor,
            });
            const result = await this.apiClient.complete({
                systemPrompt,
                userContent: entry.message.mes,
                maxTokens: settings.maxTokens,
            });
            if (result.finishReason === 'length') throw new Error('模型输出达到 token 上限，请提高最大输出长度后重试');
            const parsed = parseFloorSummary(result.content, settings.summaryMaxLength, { preserveFull: settings.memoryStrategy !== 'legacy' });
            if (this.store.current().chatId !== chatId) throw chatChangedError('摘要');
            const record = {
                floor: entry.floor,
                messageIndex: entry.messageIndex,
                messageId: entry.messageId,
                sourceFingerprint: entry.fingerprint,
                title: parsed.title,
                characters: parsed.characters,
                event: parsed.event,
                raw: parsed.raw,
                format: parsed.format,
                createdAt: new Date().toISOString(),
                manualEdited: false,
                frozen: true,
                status: 'frozen',
            };
            this.store.addSummary(record, { overwrite });
            let aggregateFailure = '';
            try {
                await this.generateDueAggregates();
            } catch (error) {
                if (error.code === 'CHAT_CHANGED') throw error;
                aggregateFailure = error.message;
            }
            this.onStatus(aggregateFailure ? 'warning' : 'success', aggregateFailure
                ? `第 ${entry.floor} 层摘要已冻结，但分层记忆生成失败：${aggregateFailure}`
                : `第 ${entry.floor} 层摘要已冻结`);
            return record;
        } catch (error) {
            if (error.code === 'CHAT_CHANGED' || error.code === 'REQUEST_ABORTED') {
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
            }, { overwrite: true });
            this.onStatus('error', `第 ${entry.floor} 层摘要失败：${error.message}`);
            throw error;
        } finally {
            this.inFlight.delete(entry.messageId);
        }
    }

    getNextCheckpointRange() {
        const settings = this.getSettings();
        const checkpoints = this.store.current().checkpoints.filter(isUsableMemory);
        const startFloor = checkpoints.length ? Math.max(...checkpoints.map(item => item.endFloor)) + 1 : 1;
        return { startFloor, endFloor: startFloor + settings.checkpointInterval - 1 };
    }

    async generateDueAggregates() {
        const assistants = getAssistantMessages(this.getChat());
        const latestFloor = assistants.at(-1)?.floor ?? 0;
        let range = this.getNextCheckpointRange();
        while (range.endFloor <= latestFloor) {
            const created = await this.generateCheckpoint(range.startFloor, range.endFloor);
            if (!created) break;
            if (this.getSettings().memoryStrategy !== 'legacy') await this.generateDueLongMemories();
            range = this.getNextCheckpointRange();
        }
        await this.generateDueLongMemories();
    }

    async generateCheckpoint(startFloor, endFloor, { overwrite = false, allowMissing = false } = {}) {
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
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
            const result = await this.apiClient.complete({ systemPrompt, userContent, maxTokens: settings.maxTokens });
            if (this.store.current().chatId !== chatId) throw chatChangedError('Checkpoint');
            if (result.finishReason === 'length') throw new Error('Checkpoint 输出达到 token 上限，请提高最大输出长度后重试');
            const record = {
                id,
                startFloor,
                endFloor,
                content: incremental ? result.content.trim() : clampText(result.content, settings.checkpointMaxLength),
                ...(incremental ? {
                    memoryKind: 'state', previousCheckpointId: state.id,
                    summaryIds: summaries.map(item => item.messageId),
                    keepItems: resolveKeepItems(keeps, result.content, newSummaries),
                } : {}),
                createdAt: new Date().toISOString(),
                frozen: true,
                manualEdited: false,
                status: 'frozen',
                missingFloors: missing,
            };
            this.store.addCheckpoint(record, { overwrite: overwrite || Boolean(existing && !isUsableMemory(existing)) });
            return record;
        } catch (error) {
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

    async generateDueLongMemories() {
        const settings = this.getSettings();
        const store = this.store.current();
        if (settings.memoryStrategy !== 'legacy') {
            const used = new Set(store.longMemories.filter(isUsableMemory).flatMap(item => item.checkpointIds ?? []));
            const coveredThrough = Math.max(0, ...store.longMemories.filter(item => isUsableMemory(item) && item.memoryKind !== 'facts').map(item => item.endFloor));
            for (const checkpoint of store.checkpoints.filter(isUsableMemory).sort((a, b) => a.endFloor - b.endFloor)) {
                if (used.has(checkpoint.id) || checkpoint.endFloor <= coveredThrough) continue;
                await this.generateLongMemory([checkpoint]);
            }
            return;
        }
        const usedThrough = store.longMemories.length ? Math.max(...store.longMemories.map(item => item.endFloor)) : 0;
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
                await this.generateLongMemory(group, { overwrite: false });
                group = [];
                coveredFloors = 0;
            }
        }
    }

    async generateLongMemory(checkpoints, { overwrite = false } = {}) {
        const settings = this.getSettings();
        const chatId = this.store.current().chatId;
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
            const result = await this.apiClient.complete({ systemPrompt, userContent, maxTokens: settings.maxTokens });
            if (this.store.current().chatId !== chatId) throw chatChangedError('Long Memory');
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
