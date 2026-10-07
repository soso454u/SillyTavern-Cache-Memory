import { DEFAULT_PROMPTS, INJECTION_MODES } from './defaults.js';
import { downloadJson, formatDate, getAssistantMessages } from './utils.js';

const ROOT_ID = 'cache-memory-settings';
const MANAGER_ID = 'cache-memory-manager';

function notify(type, message) {
    const toaster = globalThis.toastr;
    if (toaster?.[type]) toaster[type](message, 'Cache Memory');
    else console[type === 'error' ? 'error' : 'info']('[Cache Memory]', message);
}

function settingsHost() {
    return document.querySelector('#extensions_settings2')
        ?? document.querySelector('#extensions_settings')
        ?? document.querySelector('#extensions_settings_block');
}

function fieldValue(root, name) {
    const element = root.querySelector(`[data-setting="${name}"]`);
    return element?.type === 'checkbox' ? element.checked : element?.value;
}

function settingsTemplate() {
    return `
        <div id="${ROOT_ID}" class="inline-drawer cache-memory-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Cache Memory</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cache-memory-status" data-cache-status data-state="idle">等待生成</div>

                <section class="cache-memory-section">
                    <h4>状态与分层</h4>
                    <div class="cache-memory-switches">
                        <label class="checkbox_label"><input type="checkbox" data-setting="enabled"><span>启用插件</span></label>
                        <label class="checkbox_label"><input type="checkbox" data-setting="autoSummarize"><span>自动生成小总结</span></label>
                        <label class="checkbox_label"><input type="checkbox" data-setting="independentApi"><span>使用独立总结 API</span></label>
                        <label class="checkbox_label"><input type="checkbox" data-setting="strictCacheMode"><span>Strict Cache Mode</span></label>
                    </div>
                    <div class="cache-memory-grid">
                        <label>Checkpoint 间隔<input type="number" min="1" max="1000" data-setting="checkpointInterval"></label>
                        <label>Long Memory 间隔<input type="number" min="1" max="10000" data-setting="longMemoryInterval"></label>
                        <label>小总结最大长度<input type="number" min="50" data-setting="summaryMaxLength"></label>
                        <label>Checkpoint 最大长度<input type="number" min="100" data-setting="checkpointMaxLength"></label>
                        <label>Long Memory 最大长度<input type="number" min="200" data-setting="longMemoryMaxLength"></label>
                        <label>近期小总结数量<input type="number" min="0" data-setting="recentSummaryCount"></label>
                        <label>近期 Checkpoint 数量<input type="number" min="0" data-setting="recentCheckpointCount"></label>
                    </div>
                    <small>Long Memory 间隔会自动向上调整为 Checkpoint 间隔的整数倍。</small>
                </section>

                <section class="cache-memory-section">
                    <h4>记忆注入</h4>
                    <select data-setting="injectionMode">
                        <option value="${INJECTION_MODES.NONE}">不注入</option>
                        <option value="${INJECTION_MODES.LONG}">Long Memory</option>
                        <option value="${INJECTION_MODES.LONG_CHECKPOINT}">Long + Checkpoint</option>
                        <option value="${INJECTION_MODES.LONG_CHECKPOINT_RECENT}">Long + Checkpoint + Recent</option>
                    </select>
                    <small>固定位置、固定楼层顺序；不做语义检索、相关度选择或随机召回。</small>
                </section>

                <section class="cache-memory-section">
                    <h4>独立总结 API</h4>
                    <div class="cache-memory-grid">
                        <label>API Provider
                            <select data-setting="provider">
                                <option value="openai-compatible">OpenAI Compatible</option>
                                <option value="custom">Custom</option>
                            </select>
                        </label>
                        <label>API Base URL<input type="url" data-setting="apiBaseUrl" placeholder="https://example.com/v1"></label>
                        <label>API Key<input type="password" data-api-key autocomplete="off" placeholder="未配置"></label>
                        <label>Model<input type="text" data-setting="model" placeholder="model-name"></label>
                        <label>Temperature<input type="number" min="0" max="2" step="0.05" data-setting="temperature"></label>
                        <label>Max Tokens<input type="number" min="32" data-setting="maxTokens"></label>
                        <label>Timeout (ms)<input type="number" min="1000" step="1000" data-setting="timeoutMs"></label>
                    </div>
                    <div class="cache-memory-actions">
                        <button type="button" class="menu_button" data-save-api-key><i class="fa-solid fa-key"></i> 保存 Key</button>
                        <button type="button" class="menu_button" data-clear-api-key><i class="fa-solid fa-trash"></i> 清除 Key</button>
                        <button type="button" class="menu_button" data-test-api><i class="fa-solid fa-plug"></i> 测试 API</button>
                    </div>
                    <small data-api-key-state></small>
                    <small class="cache-memory-warning">API Key 单独保存在当前浏览器 localStorage，不写入聊天或 SillyTavern 自带 API 设置。网页脚本可读取它；目标 API 还必须允许跨域请求。</small>
                </section>

                <section class="cache-memory-section">
                    <h4>Prompts</h4>
                    <details><summary>小总结 Prompt</summary><textarea rows="12" data-prompt="summary"></textarea><button type="button" class="menu_button" data-reset-prompt="summary">恢复默认</button></details>
                    <details><summary>Checkpoint Prompt</summary><textarea rows="12" data-prompt="checkpoint"></textarea><button type="button" class="menu_button" data-reset-prompt="checkpoint">恢复默认</button></details>
                    <details><summary>Long Memory Prompt</summary><textarea rows="10" data-prompt="longMemory"></textarea><button type="button" class="menu_button" data-reset-prompt="longMemory">恢复默认</button></details>
                </section>

                <div class="cache-memory-actions">
                    <button type="button" class="menu_button" data-open-manager><i class="fa-solid fa-box-archive"></i> Memory Manager</button>
                </div>
            </div>
        </div>`;
}

export class CacheMemoryUI {
    constructor({ getSettings, updateSettings, apiClient, store, summarizer, getChat, updateInjection }) {
        this.getSettings = getSettings;
        this.updateSettings = updateSettings;
        this.apiClient = apiClient;
        this.store = store;
        this.summarizer = summarizer;
        this.getChat = getChat;
        this.updateInjection = updateInjection;
        this.manager = null;
    }

    mountSettings() {
        const host = settingsHost();
        if (!host) return false;
        document.getElementById(ROOT_ID)?.remove();
        host.insertAdjacentHTML('beforeend', settingsTemplate());
        const root = document.getElementById(ROOT_ID);
        this.populateSettings(root);
        this.bindSettings(root);
        return true;
    }

    populateSettings(root = document.getElementById(ROOT_ID)) {
        if (!root) return;
        const settings = this.getSettings();
        for (const element of root.querySelectorAll('[data-setting]')) {
            const key = element.dataset.setting;
            if (element.type === 'checkbox') element.checked = Boolean(settings[key]);
            else element.value = settings[key] ?? '';
        }
        for (const element of root.querySelectorAll('[data-prompt]')) {
            element.value = settings.prompts[element.dataset.prompt] ?? '';
        }
        const keyState = root.querySelector('[data-api-key-state]');
        keyState.textContent = this.apiClient.hasApiKey() ? 'API Key 已在本浏览器配置' : 'API Key 未配置';
        root.querySelector('[data-api-key]').placeholder = this.apiClient.hasApiKey() ? '已保存，留空表示不更改' : '未配置';
    }

    bindSettings(root) {
        root.addEventListener('change', event => {
            const element = event.target.closest('[data-setting]');
            if (!element) return;
            const key = element.dataset.setting;
            const numeric = ['checkpointInterval', 'longMemoryInterval', 'summaryMaxLength', 'checkpointMaxLength', 'longMemoryMaxLength', 'recentSummaryCount', 'recentCheckpointCount', 'temperature', 'maxTokens', 'timeoutMs'];
            const value = element.type === 'checkbox' ? element.checked : numeric.includes(key) ? Number(element.value) : element.value;
            this.updateSettings({ [key]: value });
            this.populateSettings(root);
            this.updateInjection();
            this.renderMessageMemories();
        });
        root.addEventListener('input', event => {
            const element = event.target.closest('[data-prompt]');
            if (!element) return;
            this.updateSettings({ prompts: { ...this.getSettings().prompts, [element.dataset.prompt]: element.value } });
        });
        root.addEventListener('click', async event => {
            const reset = event.target.closest('[data-reset-prompt]');
            if (reset) {
                const name = reset.dataset.resetPrompt;
                this.updateSettings({ prompts: { ...this.getSettings().prompts, [name]: DEFAULT_PROMPTS[name] } });
                this.populateSettings(root);
                return;
            }
            if (event.target.closest('[data-save-api-key]')) {
                try {
                    const input = root.querySelector('[data-api-key]');
                    await this.apiClient.saveApiKey(input.value);
                    input.value = '';
                    this.populateSettings(root);
                    notify('success', '独立 API Key 已保存在当前浏览器');
                } catch (error) {
                    notify('error', error.message);
                }
                return;
            }
            if (event.target.closest('[data-clear-api-key]')) {
                if (!confirm('清除当前浏览器保存的 Cache Memory API Key？')) return;
                this.apiClient.clearApiKey();
                this.populateSettings(root);
                notify('success', 'API Key 已清除');
                return;
            }
            if (event.target.closest('[data-test-api]')) {
                const button = event.target.closest('button');
                button.disabled = true;
                this.setStatus('busy', '正在测试独立 API');
                try {
                    const result = await this.apiClient.test();
                    this.setStatus('success', `连接成功 · 模型 ${result.model} · HTTP ${result.status} · ${result.latencyMs} ms`);
                } catch (error) {
                    this.setStatus('error', `连接失败 · ${error.message}`);
                } finally {
                    button.disabled = false;
                }
                return;
            }
            if (event.target.closest('[data-open-manager]')) this.openManager();
        });
    }

    setStatus(state, text) {
        const output = document.querySelector(`#${ROOT_ID} [data-cache-status]`);
        if (!output) return;
        output.dataset.state = state;
        output.textContent = text;
    }

    renderMessageMemories() {
        if (!this.getSettings().enabled) {
            document.querySelectorAll('.cache-memory-message').forEach(element => element.remove());
            return;
        }
        const assistants = this.store.syncMessages(this.getChat());
        const store = this.store.current();
        document.querySelectorAll('.cache-memory-message').forEach(element => element.remove());
        for (const entry of assistants) {
            const record = store.summaries[entry.messageId];
            if (!record) continue;
            const message = document.querySelector(`#chat .mes[mesid="${entry.messageIndex}"]`);
            const anchor = message?.querySelector('.mes_text');
            if (!anchor) continue;
            const widget = document.createElement('details');
            widget.className = 'cache-memory-message';
            widget.dataset.messageId = entry.messageId;
            const summary = document.createElement('summary');
            summary.textContent = record.status === 'failed'
                ? `本层记忆 · Summary failed`
                : `本层记忆 · ${record.title}`;
            const body = document.createElement('div');
            body.className = 'cache-memory-message-body';
            if (record.status === 'failed') {
                body.append(this.line('错误', record.error || '未知错误'));
            } else {
                body.append(this.line('人物', record.characters), this.line('事件', record.event));
                if (record.status === 'stale') body.append(this.line('状态', '原消息已编辑或切换 swipe，请手动重新生成'));
            }
            const actions = document.createElement('div');
            actions.className = 'cache-memory-actions';
            actions.innerHTML = `
                <button type="button" class="menu_button" data-memory-action="regenerate"><i class="fa-solid fa-rotate"></i> ${record.status === 'failed' ? '重试' : '重新生成'}</button>
                <button type="button" class="menu_button" data-memory-action="edit"><i class="fa-solid fa-pen"></i> 编辑</button>
                <button type="button" class="menu_button" data-memory-action="delete"><i class="fa-solid fa-trash"></i> 删除</button>`;
            body.append(actions);
            widget.append(summary, body);
            anchor.insertAdjacentElement('afterend', widget);
        }
    }

    line(label, value) {
        const line = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = `${label}：`;
        line.append(strong, document.createTextNode(value || '未提供'));
        return line;
    }

    bindChatActions() {
        document.querySelector('#chat')?.addEventListener('click', async event => {
            const button = event.target.closest('[data-memory-action]');
            const widget = button?.closest('.cache-memory-message');
            if (!button || !widget) return;
            const { messageId } = widget.dataset;
            if (button.dataset.memoryAction === 'delete') {
                if (confirm('删除这条小总结？历史 assistant 正文不会被修改。')) this.store.deleteSummary(messageId);
            } else if (button.dataset.memoryAction === 'edit') {
                this.editSummary(messageId);
            } else if (button.dataset.memoryAction === 'regenerate') {
                if (!confirm('重新生成会替换这条摘要，但不会修改原始 assistant 正文。继续？')) return;
                button.disabled = true;
                try {
                    await this.summarizer.summarizeMessage(messageId, { overwrite: true });
                } catch {}
                button.disabled = false;
            }
            this.renderMessageMemories();
            this.renderManager();
            this.updateInjection();
        });
    }

    editSummary(messageId) {
        const record = this.store.getSummary(messageId);
        if (!record) return;
        const title = prompt('摘要标题', record.title);
        if (title === null) return;
        const characters = prompt('实际出现的人物', record.characters);
        if (characters === null) return;
        const event = prompt('事件', record.event);
        if (event === null) return;
        this.store.updateSummary(messageId, {
            title: title.trim() || '未命名摘要',
            characters: characters.trim(),
            event: event.trim(),
            raw: `<title>${title.trim()}</title>\n<characters>${characters.trim()}</characters>\n<event>${event.trim()}</event>`,
            manualEdited: true,
            frozen: true,
            status: 'manual-edited',
            editedAt: new Date().toISOString(),
        });
    }

    openManager() {
        if (!this.manager) this.createManager();
        this.manager.hidden = false;
        document.body.classList.add('cache-memory-manager-open');
        this.renderManager();
    }

    closeManager() {
        if (this.manager) this.manager.hidden = true;
        document.body.classList.remove('cache-memory-manager-open');
    }

    createManager() {
        const overlay = document.createElement('div');
        overlay.id = MANAGER_ID;
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="cache-memory-manager-panel" role="dialog" aria-modal="true" aria-label="Memory Manager">
                <header><div><h3>Memory Manager</h3><small>当前聊天的冻结记忆</small></div><button type="button" class="menu_button" data-manager-close title="关闭"><i class="fa-solid fa-xmark"></i></button></header>
                <div class="cache-memory-manager-toolbar">
                    <button type="button" class="menu_button" data-export><i class="fa-solid fa-download"></i> 导出 JSON</button>
                    <button type="button" class="menu_button" data-import><i class="fa-solid fa-upload"></i> 导入 JSON</button>
                    <input type="file" accept="application/json,.json" data-import-file hidden>
                </div>
                <div class="cache-memory-manager-content" data-manager-content></div>
            </div>`;
        document.body.append(overlay);
        this.manager = overlay;
        overlay.addEventListener('click', event => this.handleManagerClick(event));
        overlay.querySelector('[data-import-file]').addEventListener('change', event => this.importFile(event));
    }

    renderManager() {
        if (!this.manager || this.manager.hidden) return;
        const content = this.manager.querySelector('[data-manager-content]');
        content.replaceChildren();
        const store = this.store.current();
        const summaries = Object.values(store.summaries).sort((a, b) => a.floor - b.floor);
        content.append(this.managerSection('楼层小总结', summaries, 'summary'));
        content.append(this.pendingCheckpoint());
        content.append(this.managerSection('Checkpoints', store.checkpoints, 'checkpoint'));
        content.append(this.managerSection('Long Memories', store.longMemories, 'long'));
    }

    managerSection(title, items, type) {
        const section = document.createElement('section');
        section.className = 'cache-memory-manager-section';
        const heading = document.createElement('h4');
        heading.textContent = `${title} · ${items.length}`;
        section.append(heading);
        if (!items.length) {
            const empty = document.createElement('p');
            empty.className = 'cache-memory-empty';
            empty.textContent = '暂无记录';
            section.append(empty);
            return section;
        }
        for (const item of items) section.append(this.managerCard(item, type));
        return section;
    }

    managerCard(item, type) {
        const card = document.createElement('article');
        card.className = 'cache-memory-card';
        card.dataset.memoryType = type;
        card.dataset.memoryId = type === 'summary' ? item.messageId : item.id;
        const range = type === 'summary' ? `第 ${item.floor} 层` : `第 ${item.startFloor}-${item.endFloor} 层`;
        const title = type === 'summary' ? item.title : item.id;
        const header = document.createElement('header');
        const name = document.createElement('strong');
        name.textContent = title;
        const status = document.createElement('span');
        status.textContent = item.status === 'manual-edited' || item.manualEdited ? 'Manual Edited' : item.status === 'failed' ? 'Failed' : item.status === 'stale' ? 'Stale' : item.status === 'orphaned' ? 'Orphaned' : 'Frozen';
        header.append(name, status);
        const meta = document.createElement('small');
        meta.textContent = `${range} · ${formatDate(item.createdAt)}`;
        const text = document.createElement('pre');
        text.textContent = type === 'summary'
            ? `人物：${item.characters || '未提供'}\n事件：${item.event || item.error || '未提供'}`
            : item.content;
        const actions = document.createElement('div');
        actions.className = 'cache-memory-actions';
        actions.innerHTML = `
            <button type="button" class="menu_button" data-manager-action="regenerate"><i class="fa-solid fa-rotate"></i> 重新生成</button>
            <button type="button" class="menu_button" data-manager-action="edit"><i class="fa-solid fa-pen"></i> 编辑</button>
            <button type="button" class="menu_button" data-manager-action="delete"><i class="fa-solid fa-trash"></i> 删除</button>`;
        card.append(header, meta, text, actions);
        return card;
    }

    pendingCheckpoint() {
        const holder = document.createElement('div');
        const range = this.summarizer.getNextCheckpointRange();
        const latestFloor = getAssistantMessages(this.getChat()).at(-1)?.floor ?? 0;
        if (range.endFloor > latestFloor) return holder;
        const summaries = Object.values(this.store.current().summaries);
        const missing = [];
        for (let floor = range.startFloor; floor <= range.endFloor; floor += 1) {
            if (!summaries.some(item => item.floor === floor && ['frozen', 'manual-edited'].includes(item.status))) missing.push(floor);
        }
        if (!missing.length) return holder;
        holder.className = 'cache-memory-missing';
        const text = document.createElement('p');
        text.textContent = `第 ${range.startFloor}-${range.endFloor} 层存在 ${missing.length} 条缺失摘要：${missing.join('、')}`;
        const actions = document.createElement('div');
        actions.className = 'cache-memory-actions';
        actions.innerHTML = `<button type="button" class="menu_button" data-fill-missing="${missing.join(',')}">先补齐缺失摘要</button><button type="button" class="menu_button" data-continue-checkpoint="${range.startFloor}:${range.endFloor}">继续生成 Checkpoint</button>`;
        holder.append(text, actions);
        return holder;
    }

    async handleManagerClick(event) {
        if (event.target === this.manager || event.target.closest('[data-manager-close]')) return this.closeManager();
        if (event.target.closest('[data-export]')) {
            const chatId = this.store.current().chatId || 'chat';
            downloadJson(`cache-memory-${chatId}.json`, this.store.current());
            return;
        }
        if (event.target.closest('[data-import]')) return this.manager.querySelector('[data-import-file]').click();
        const fill = event.target.closest('[data-fill-missing]');
        if (fill) {
            fill.disabled = true;
            const floors = fill.dataset.fillMissing.split(',').map(Number);
            const entries = getAssistantMessages(this.getChat());
            for (const floor of floors) {
                const entry = entries.find(item => item.floor === floor);
                if (!entry) continue;
                try { await this.summarizer.summarizeMessage(entry.messageId, { overwrite: true }); } catch {}
            }
            this.renderManager();
            return;
        }
        const continuation = event.target.closest('[data-continue-checkpoint]');
        if (continuation) {
            const [start, end] = continuation.dataset.continueCheckpoint.split(':').map(Number);
            continuation.disabled = true;
            try {
                await this.summarizer.generateCheckpoint(start, end, { allowMissing: true });
                await this.summarizer.generateDueLongMemories();
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
            if (!confirm('删除这条记忆？聊天正文不会被修改。')) return;
            if (type === 'summary') this.store.deleteSummary(id);
            else this.store.deleteAggregate(type, id);
        } else if (action === 'edit') {
            if (type === 'summary') this.editSummary(id);
            else this.editAggregate(type, id);
        } else if (action === 'regenerate') {
            if (!confirm('仅按该条记忆的固定来源重新生成并替换它。继续？')) return;
            button.disabled = true;
            try { await this.regenerate(type, id); } catch (error) { notify('error', error.message); }
        }
        this.renderMessageMemories();
        this.renderManager();
        this.updateInjection();
    }

    editAggregate(type, id) {
        const list = type === 'long' ? this.store.current().longMemories : this.store.current().checkpoints;
        const item = list.find(entry => entry.id === id);
        if (!item) return;
        const content = prompt('记忆内容', item.content);
        if (content === null) return;
        this.store.updateAggregate(type, id, {
            content: content.trim(),
            manualEdited: true,
            frozen: true,
            status: 'manual-edited',
            editedAt: new Date().toISOString(),
        });
    }

    async regenerate(type, id) {
        if (type === 'summary') return this.summarizer.summarizeMessage(id, { overwrite: true });
        if (type === 'checkpoint') {
            const item = this.store.current().checkpoints.find(entry => entry.id === id);
            return this.summarizer.generateCheckpoint(item.startFloor, item.endFloor, { overwrite: true, allowMissing: true });
        }
        const item = this.store.current().longMemories.find(entry => entry.id === id);
        const checkpoints = this.store.current().checkpoints.filter(entry => item.checkpointIds.includes(entry.id));
        return this.summarizer.generateLongMemory(checkpoints, { overwrite: true });
    }

    async importFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (Number(data.version) !== 1 || !data.summaries || !Array.isArray(data.checkpoints) || !Array.isArray(data.longMemories)) {
                throw new Error('不是有效的 Cache Memory v1 JSON');
            }
            if (!confirm('导入将替换当前聊天的 Cache Memory 数据，但不会修改聊天正文。继续？')) return;
            this.store.replace(data);
            this.renderManager();
            this.renderMessageMemories();
            this.updateInjection();
            notify('success', '记忆数据已导入当前聊天');
        } catch (error) {
            notify('error', `导入失败：${error.message}`);
        }
    }
}
