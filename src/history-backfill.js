import { getAssistantMessages } from './utils.js?v=1.27.6';

import { waitForRetry } from './retry.js?v=1.27.6';
export { isRetryableError as isRetryableSummaryError, waitForRetry } from './retry.js?v=1.27.6';

function aborted() {
    return Object.assign(new Error('历史补齐已取消'), { code: 'REQUEST_ABORTED' });
}

function idleState() {
    return { status: 'idle', total: 0, processed: 0, success: 0, failed: 0, skipped: 0, retries: 0, currentFloor: null, error: '' };
}

export class HistoryBackfill {
    constructor({ summarizer, store, getChat, onProgress = () => {}, delay = waitForRetry }) {
        Object.assign(this, { summarizer, store, getChat, onProgress, delay });
        this.state = idleState();
        this.runId = 0;
        this.operationActive = false;
    }

    get active() { return this.operationActive || ['running', 'pausing', 'paused', 'cancelling', 'aggregating'].includes(this.state.status); }
    publish(patch = {}, runId = this.runId) {
        if (runId !== this.runId) return;
        Object.assign(this.state, patch);
        this.onProgress({ ...this.state });
    }

    pause() {
        if (this.state.status === 'running') this.publish({ status: 'pausing' });
    }

    resume() {
        if (!['paused', 'pausing'].includes(this.state.status)) return;
        this.publish({ status: 'running' });
        this.wake?.();
    }

    cancel({ discard = false } = {}) {
        if (!this.active) return;
        this.discard ||= discard;
        this.controller?.abort();
        if (discard) this.aggregateController?.abort();
        this.wake?.();
        if (this.state.status !== 'cancelling') this.publish({ status: 'cancelling' });
    }

    reset() {
        this.runId++;
        this.state = idleState();
        this.chatId = null;
        this.onProgress({ ...this.state });
    }

    async boundary() {
        if (this.store.current().chatId !== this.chatId) this.cancel({ discard: true });
        if (this.state.status === 'pausing') this.publish({ status: 'paused' });
        if (this.state.status === 'paused') await new Promise(resolve => { this.wake = resolve; });
        this.wake = null;
        if (this.controller.signal.aborted) throw aborted();
    }

    async start({ startFloor = 1, endFloor, mode = 'missing-failed' } = {}) {
        if (this.active) throw new Error('历史补齐正在进行，请先暂停或取消');
        const runId = ++this.runId;
        if (!['missing', 'failed', 'missing-failed', 'all'].includes(mode)) throw new Error('未知的历史补齐模式');
        const assistants = this.store.syncMessages(this.getChat());
        endFloor ??= assistants.at(-1)?.floor ?? 0;
        if (!Number.isInteger(startFloor) || !Number.isInteger(endFloor) || startFloor < 1 || endFloor < startFloor || endFloor > (assistants.at(-1)?.floor ?? 0)) {
            throw new Error('请选择当前聊天内有效的开始和结束楼层');
        }
        const entries = assistants.filter(entry => entry.floor >= startFloor && entry.floor <= endFloor);
        this.chatId = this.store.current().chatId;
        this.controller = new AbortController();
        this.aggregateController = new AbortController();
        this.discard = false;
        this.lastFailure = '';
        this.operationActive = true;
        this.state = { status: 'running', total: entries.length, processed: 0, success: 0, failed: 0, skipped: 0, retries: 0, currentFloor: null, error: '' };
        this.summarizer.aggregateDeferrals++;
        this.publish({}, runId);
        try {
            for (const entry of entries) {
                await this.boundary();
                this.publish({ currentFloor: entry.floor }, runId);
                const existing = this.store.getSummaryForEntry(entry);
                const selected = mode === 'all' || (!existing && ['missing', 'missing-failed'].includes(mode))
                    || (existing?.status === 'failed' && ['failed', 'missing-failed'].includes(mode));
                if (!selected) this.state.skipped++;
                else {
                    await this.boundary();
                    try {
                        const record = await this.summarizer.summarizeMessage(entry.messageId, {
                            overwrite: Boolean(existing), deferAggregates: true, signal: this.controller.signal,
                            expectedFingerprint: entry.fingerprint, retryDelay: this.delay,
                            onRetry: ({ attempt, waitMs, error }) => this.publish({ retries: this.state.retries + 1,
                                error: `第 ${entry.floor} 层将在 ${waitMs / 1000} 秒后自动重试 ${attempt}/3：${error.message}` }, runId),
                        });
                        if (record) this.state.success++;
                        else this.state.skipped++;
                        this.state.error = this.lastFailure;
                    } catch (error) {
                        if (['CHAT_CHANGED', 'REQUEST_ABORTED'].includes(error.code)) throw error;
                        this.state.failed++;
                        this.state.error = `第 ${entry.floor} 层：${error.message}`;
                        this.lastFailure = this.state.error;
                    }
                }
                this.publish({ processed: this.state.processed + 1 }, runId);
            }
        } catch (error) {
            if (!['CHAT_CHANGED', 'REQUEST_ABORTED'].includes(error.code)) this.publish({ error: error.message }, runId);
            this.controller.abort();
        } finally {
            this.summarizer.aggregateDeferrals--;
            const cancelled = this.controller.signal.aborted;
            if (!this.discard && this.store.current().chatId === this.chatId && this.state.success > 0) {
                this.publish({ status: 'aggregating' }, runId);
                try {
                    await this.summarizer.enqueue(() => {
                        if (this.discard || this.store.current().chatId !== this.chatId) return;
                        return this.summarizer.generateDueAggregates({ signal: this.aggregateController.signal });
                    });
                }
                catch (error) { if (error.code !== 'REQUEST_ABORTED') this.publish({ error: `阶段记忆生成失败：${error.message}` }, runId); }
            }
            this.operationActive = false;
            if (runId === this.runId) this.publish({ status: cancelled || this.discard ? 'cancelled' : 'completed', currentFloor: null }, runId);
            else this.onProgress({ ...this.state });
        }
        return { ...this.state };
    }
}
