import { API_PROVIDERS, DEFAULT_PROMPTS, LEGACY_PROMPTS, INJECTION_MODES } from './defaults.js?v=1.4.0';
import { downloadJson, formatDate, getAssistantMessages } from './utils.js?v=1.4.0';
import { collectKeepItems, formatKeepItems, formatLongFacts, projectLongFacts } from './continuity.js?v=1.4.0';

const ROOT_ID = 'cache-memory-settings';
const CONFIG_ID = 'cache-memory-config';
const MANAGER_ID = 'cache-memory-manager';
const WAND_CONTAINER_ID = 'cache-memory-wand-container';
const WAND_ENTRY_ID = 'cache-memory-wand-entry';

function notify(type, message) {
    const toaster = globalThis.toastr;
    if (toaster?.[type]) toaster[type](message, 'Cache Memory');
    else console[type === 'error' ? 'error' : 'info']('[Cache Memory]', message);
}

export function formatModelListFailure(result) {
    const diagnostics = result?.diagnostics ?? {};
    const lines = [
        '模型列表获取失败',
        `URL: ${diagnostics.endpoint || '未知'}`,
        `状态: ${diagnostics.direct || '未知'}`,
    ];
    if (diagnostics.directBody) lines.push(`响应（前 500 字）: ${diagnostics.directBody}`);
    if (diagnostics.directException) lines.push(`错误: ${diagnostics.directException}`);
    lines.push(diagnostics.suspectedCors
        ? '疑似 CORS: 是（可能是 CORS 或网络限制，浏览器无法确定）'
        : '疑似 CORS: 否（未检测到相关迹象）');
    if (diagnostics.proxyEndpoint) lines.push(`代理 URL: ${diagnostics.proxyEndpoint}`);
    if (diagnostics.proxy && diagnostics.proxy !== '未请求') lines.push(`代理状态: ${diagnostics.proxy}`);
    if (diagnostics.proxyBody) lines.push(`代理响应（前 500 字）: ${diagnostics.proxyBody}`);
    if (diagnostics.proxyException) lines.push(`代理错误: ${diagnostics.proxyException}`);
    const repeatedBody = /^HTTP \d+:/.test(result?.error ?? '')
        && [diagnostics.directBody, diagnostics.proxyBody].some(body => body && result.error.endsWith(body));
    if (result?.error && !repeatedBody && result.error !== diagnostics.directException && result.error !== diagnostics.proxyException) {
        lines.push(`错误: ${result.error}`);
    }
    return lines.join('\n');
}

function settingsHost() {
    return document.querySelector('#extensions_settings2')
        ?? document.querySelector('#extensions_settings')
        ?? document.querySelector('#extensions_settings_block');
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
            </div>
        </div>`;
}

function configTemplate() {
    return `
        <div id="${CONFIG_ID}" class="cache-memory-overlay" hidden>
            <div class="cache-memory-config-panel" role="dialog" aria-modal="true" aria-labelledby="cache-memory-config-title">
                <header class="cache-memory-dialog-header">
                    <div class="cache-memory-dialog-title" title="拖动标题栏移动弹窗">
                        <i class="fa-solid fa-brain" aria-hidden="true"></i>
                        <div><h3 id="cache-memory-config-title">缓存记忆</h3><small>自动整理剧情，保留关键细节 · 可拖动标题栏</small></div>
                    </div>
                    <button type="button" class="menu_button cache-memory-icon-button" data-settings-close title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
                </header>
                <div class="cache-memory-config-status cache-memory-status" data-cache-status data-state="idle">等待生成</div>
                <nav class="cache-memory-tabs" role="tablist" aria-label="Cache Memory 设置">
                    <button type="button" class="cache-memory-tab is-active" role="tab" aria-selected="true" data-settings-tab="general"><i class="fa-solid fa-layer-group"></i><span>常规</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="api"><i class="fa-solid fa-key"></i><span>模型接口</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="injection"><i class="fa-solid fa-syringe"></i><span>记忆注入</span></button>
                    <button type="button" class="cache-memory-tab" role="tab" aria-selected="false" data-settings-tab="prompts"><i class="fa-solid fa-file-lines"></i><span>提示词</span></button>
                </nav>
                <div class="cache-memory-config-content">
                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="general">
                        <div class="cache-memory-section-heading"><div><h4>运行与分层</h4><p>控制摘要生成和冻结记忆的楼层范围。</p></div><button type="button" class="menu_button" data-open-manager><i class="fa-solid fa-box-archive"></i> 记忆管理</button></div>
                        <div class="cache-memory-switches">
                            <label class="cache-memory-toggle"><span><strong>启用插件</strong><small>显示楼层记忆并启用处理流程</small></span><input type="checkbox" data-setting="enabled"></label>
                            <label class="cache-memory-toggle"><span><strong>自动生成小总结</strong><small>正常回复结束后自动排队</small></span><input type="checkbox" data-setting="autoSummarize"></label>
                            <label class="cache-memory-toggle"><span><strong>使用独立模型接口</strong><small>不占用 SillyTavern 当前聊天模型</small></span><input type="checkbox" data-setting="independentApi"></label>
                            <label class="cache-memory-toggle"><span><strong>严格缓存模式</strong><small>只追加新记忆，不自动改写旧内容</small></span><input type="checkbox" data-setting="strictCacheMode"></label>
                            <label class="cache-memory-toggle"><span><strong>魔法棒菜单入口</strong><small>在输入框旁的扩展菜单中显示</small></span><input type="checkbox" data-setting="showWandButton"></label>
                        </div>
                        <div class="cache-memory-grid">
                            <label>记忆策略<select data-setting="memoryStrategy"><option value="incremental">增量状态 + 长期事实 + KEEP</option><option value="legacy">兼容旧版分段摘要</option></select></label>
                            <label>阶段记忆间隔（层）<input type="number" min="1" max="1000" data-setting="checkpointInterval"></label>
                            <label data-legacy-setting>旧版长期记忆间隔（层）<input type="number" min="1" max="10000" data-setting="longMemoryInterval"></label>
                            <label>小总结目标长度<input type="number" min="50" data-setting="summaryMaxLength"></label>
                            <label>阶段状态目标长度<input type="number" min="100" data-setting="checkpointMaxLength"></label>
                            <label>长期事实目标长度<input type="number" min="200" data-setting="longMemoryMaxLength"></label>
                            <label data-legacy-setting>旧版近期小总结数量<input type="number" min="0" data-setting="recentSummaryCount"></label>
                            <label data-legacy-setting>旧版近期阶段记忆数量<input type="number" min="0" data-setting="recentCheckpointCount"></label>
                        </div>
                        <small class="cache-memory-help">增量策略在每个新 Checkpoint 后检查长期事实，仅追加新增或有明确证据的变更；长度是软目标，KEEP 不因遗漏而丢弃。旧数据和自定义设置会保留。</small>
                    </section>

                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="api" hidden>
                        <div class="cache-memory-section-heading"><div><h4>模型接口</h4><p>统一使用 OpenAI 兼容接口。</p></div></div>
                        <div class="cache-memory-api-guide"><i class="fa-solid fa-circle-info"></i><span><strong>设置顺序：</strong>填写接口地址 → 保存密钥 → 获取模型或手动填写 → 测试连接。密钥只保存在当前浏览器。</span></div>
                        <div class="cache-memory-grid">
                            <label>接口类型<input type="text" value="OpenAI 兼容接口" readonly></label>
                            <label>接口地址<input type="url" data-setting="apiBaseUrl" placeholder="例如：https://example.com/v1"></label>
                            <label>API 密钥<input type="password" data-api-key autocomplete="off" placeholder="未配置"></label>
                            <label>摘要模型<input type="text" data-setting="model" placeholder="可手动填写模型名称"><select data-model-list data-model-select aria-label="从完整模型列表选择"><option value="">获取列表后可在此选择模型</option></select></label>
                            <label>创造性（0 更稳定）<input type="number" min="0" max="2" step="0.05" data-setting="temperature"></label>
                            <label>最大输出长度<input type="number" min="32" data-setting="maxTokens"></label>
                            <label>超时时间（毫秒）<input type="number" min="1000" step="1000" data-setting="timeoutMs"></label>
                        </div>
                        <div class="cache-memory-actions">
                            <button type="button" class="menu_button" data-save-api-key><i class="fa-solid fa-key"></i> 保存密钥</button>
                            <button type="button" class="menu_button cache-memory-primary" data-list-models><i class="fa-solid fa-arrows-rotate"></i> 获取模型列表</button>
                            <button type="button" class="menu_button" data-test-api><i class="fa-solid fa-plug"></i> 测试连接</button>
                            <button type="button" class="menu_button" data-clear-api-key><i class="fa-solid fa-trash"></i> 清除密钥</button>
                        </div>
                        <small class="cache-memory-key-state" data-api-key-state></small>
                        <small class="cache-memory-warning">安全提示：API 密钥只保存在当前浏览器，不会写入聊天记录。接口还需要允许浏览器跨域访问。</small>
                        <small class="cache-memory-help">模型输入框支持手动填写和下拉选择；获取列表失败时不会影响手动填写与测试连接。</small>
                    </section>

                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="injection" hidden>
                        <div class="cache-memory-section-heading"><div><h4>记忆注入</h4><p>选择发送请求时附加到上下文的冻结记忆层。</p></div></div>
                        <label class="cache-memory-field">注入范围<select data-setting="injectionMode"><option value="${INJECTION_MODES.NONE}">不注入</option><option value="${INJECTION_MODES.LONG}">仅长期记忆</option><option value="${INJECTION_MODES.LONG_CHECKPOINT}">长期记忆 + 阶段记忆</option><option value="${INJECTION_MODES.LONG_CHECKPOINT_RECENT}">长期记忆 + 阶段记忆 + 近期小总结</option></select></label>
                        <div class="cache-memory-note"><i class="fa-solid fa-shield-halved"></i><span>增量策略组合当前长期事实、有效 KEEP、最新阶段状态与该状态之后的全部小总结。内容按固定顺序注入，已有冻结历史仍保留。</span></div>
                    </section>

                    <section class="cache-memory-tab-panel" role="tabpanel" data-settings-panel="prompts" hidden>
                        <div class="cache-memory-section-heading"><div><h4>提示词</h4><p>分别编辑每一种记忆层使用的系统提示词；不熟悉时保持默认即可。</p></div></div>
                        <details><summary>小总结提示词</summary><textarea rows="12" data-prompt="summary"></textarea><button type="button" class="menu_button" data-reset-prompt="summary"><i class="fa-solid fa-arrow-rotate-left"></i> 恢复默认</button></details>
                        <details><summary>阶段记忆提示词</summary><textarea rows="12" data-prompt="checkpoint"></textarea><button type="button" class="menu_button" data-reset-prompt="checkpoint"><i class="fa-solid fa-arrow-rotate-left"></i> 恢复默认</button></details>
                        <details><summary>长期记忆提示词</summary><textarea rows="10" data-prompt="longMemory"></textarea><button type="button" class="menu_button" data-reset-prompt="longMemory"><i class="fa-solid fa-arrow-rotate-left"></i> 恢复默认</button></details>
                    </section>
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
        this.config = null;
        this.wandObserver = null;
        this.wandSyncQueued = false;
        this.lastFocusedElement = null;
        this.controller = new AbortController();
        this.destroyed = false;
        this.modelOptions = [];
    }

    mountSettings() {
        const host = settingsHost();
        if (!host) return false;
        document.getElementById(ROOT_ID)?.remove();
        host.insertAdjacentHTML('beforeend', settingsTemplate());
        const root = document.getElementById(ROOT_ID);
        this.createConfig();
        this.populateSettings();
        this.bindSettings(root);
        this.bindSettings(this.config);
        this.watchWandMenu();
        return true;
    }

    createConfig() {
        this.config = document.getElementById(CONFIG_ID);
        if (this.config) return;
        document.body.insertAdjacentHTML('beforeend', configTemplate());
        this.config = document.getElementById(CONFIG_ID);
        this.bindDialogDrag(this.config);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.config && !this.config.hidden) this.closeSettings();
        }, { signal: this.controller.signal });
    }

    bindDialogDrag(overlay) {
        const panel = overlay.querySelector('.cache-memory-config-panel');
        const handle = panel.querySelector('.cache-memory-dialog-header');
        const viewport = overlay.ownerDocument.defaultView;
        let drag = null;
        const constrain = (left, top) => {
            const rect = panel.getBoundingClientRect();
            const bounds = overlay.getBoundingClientRect();
            const x = Math.max(bounds.left, Math.min(left, bounds.right - rect.width));
            const y = Math.max(bounds.top, Math.min(top, bounds.bottom - rect.height));
            panel.style.width = `${rect.width}px`;
            panel.style.position = 'absolute';
            panel.style.left = `${x - bounds.left}px`;
            panel.style.top = `${y - bounds.top}px`;
        };
        const stop = () => {
            if (!drag) return;
            const id = drag.id;
            drag = null;
            if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
            handle.classList.remove('is-dragging');
        };
        this.stopConfigDrag = stop;
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button, input, select, textarea, a')) return;
            const rect = panel.getBoundingClientRect();
            drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
            handle.setPointerCapture(event.pointerId);
            handle.classList.add('is-dragging');
            event.preventDefault();
        }, { signal: this.controller.signal });
        handle.addEventListener('pointermove', event => {
            if (drag?.id !== event.pointerId) return;
            constrain(event.clientX - drag.x, event.clientY - drag.y);
        }, { signal: this.controller.signal });
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            handle.addEventListener(name, stop, { signal: this.controller.signal });
        }
        viewport.addEventListener('resize', () => {
            stop();
            if (overlay.hidden || !panel.style.left) return;
            const rect = panel.getBoundingClientRect();
            constrain(rect.left, rect.top);
        }, { signal: this.controller.signal });
        this.controller.signal.addEventListener('abort', stop, { once: true });
    }

    settingsScopes() {
        return [document.getElementById(ROOT_ID), this.config].filter(Boolean);
    }

    populateSettings(root) {
        const settings = this.getSettings();
        const scopes = root ? [root] : this.settingsScopes();
        for (const scope of scopes) {
            for (const element of scope.querySelectorAll('[data-legacy-setting]')) element.hidden = settings.memoryStrategy !== 'legacy';
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
        }
    }

    bindSettings(root) {
        if (!root || root.dataset.cacheMemoryBound === 'true') return;
        root.dataset.cacheMemoryBound = 'true';
        root.addEventListener('change', event => {
            const modelSelect = event.target.closest('[data-model-select]');
            if (modelSelect) {
                if (!modelSelect.value) return;
                const input = root.querySelector('[data-setting="model"]');
                input.value = modelSelect.value;
                this.updateSettings({ model: input.value });
                modelSelect.value = '';
                return;
            }
            const element = event.target.closest('[data-setting]');
            if (!element) return;
            const key = element.dataset.setting;
            const numeric = ['checkpointInterval', 'longMemoryInterval', 'summaryMaxLength', 'checkpointMaxLength', 'longMemoryMaxLength', 'recentSummaryCount', 'recentCheckpointCount', 'temperature', 'maxTokens', 'timeoutMs'];
            const value = element.type === 'checkbox' ? element.checked : numeric.includes(key) ? Number(element.value) : element.value;
            this.updateSettings({ [key]: value, ...(key === 'apiBaseUrl' ? { provider: API_PROVIDERS.OPENAI_COMPATIBLE } : {}) });
            this.populateSettings();
            if (key === 'showWandButton') this.syncWandEntry();
            this.updateInjection();
            this.renderMessageMemories();
        }, { signal: this.controller.signal });
        root.addEventListener('input', event => {
            const setting = event.target.closest('[data-setting="model"]');
            if (setting) {
                this.updateSettings({ model: setting.value });
                return;
            }
            const element = event.target.closest('[data-prompt]');
            if (!element) return;
            this.updateSettings({ prompts: { ...this.getSettings().prompts, [element.dataset.prompt]: element.value } });
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
            const reset = event.target.closest('[data-reset-prompt]');
            if (reset) {
                const name = reset.dataset.resetPrompt;
                const defaults = this.getSettings().memoryStrategy === 'legacy' ? LEGACY_PROMPTS : DEFAULT_PROMPTS;
                this.updateSettings({ prompts: { ...this.getSettings().prompts, [name]: defaults[name] } });
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
                if (!confirm('清除当前浏览器保存的缓存记忆 API 密钥？')) return;
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
                    }
                    const suffix = result.source === 'unavailable'
                        ? formatModelListFailure(result)
                        : `已从${result.source === 'proxy' ? 'SillyTavern 代理' : '接口'}获取 · 共 ${result.models.length} 个`;
                    this.setStatus(result.warning ? 'warning' : 'success', suffix);
                    if (result.source === 'unavailable') {
                        for (const output of document.querySelectorAll('[data-cache-status]')) output.title = '详细诊断已输出到浏览器开发者控制台';
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
            if (event.target.closest('[data-test-api]')) {
                const button = event.target.closest('button');
                button.disabled = true;
                this.setStatus('busy', '正在测试模型连接…');
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
            if (event.target.closest('[data-open-manager]')) {
                this.closeSettings();
                this.openManager();
            }
        }, { signal: this.controller.signal });
    }

    renderModelOptions(models) {
        this.modelOptions = [...models];
        for (const list of document.querySelectorAll('[data-model-list]')) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = models.length ? `选择模型（共 ${models.length} 个，显示完整列表）` : '获取列表后可在此选择模型';
            list.replaceChildren(placeholder, ...models.map(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                return option;
            }));
            list.value = '';
        }
    }

    openSettings() {
        this.createConfig();
        this.lastFocusedElement = document.activeElement;
        this.populateSettings();
        this.renderModelOptions(this.modelOptions);
        this.config.hidden = false;
        document.body.classList.add('cache-memory-config-open');
        this.config.querySelector('[data-settings-close]')?.focus();
    }

    closeSettings() {
        if (!this.config || this.config.hidden) return;
        this.stopConfigDrag?.();
        this.config.hidden = true;
        const panel = this.config.querySelector('.cache-memory-config-panel');
        for (const property of ['position', 'left', 'top', 'width']) panel.style.removeProperty(property);
        document.body.classList.remove('cache-memory-config-open');
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
    }

    watchWandMenu() {
        this.syncWandEntry();
        if (this.wandObserver || !document.body) return;
        this.wandObserver = new MutationObserver(() => {
            if (this.wandSyncQueued) return;
            this.wandSyncQueued = true;
            requestAnimationFrame(() => {
                this.wandSyncQueued = false;
                this.syncWandEntry();
            });
        });
        this.wandObserver.observe(document.body, { childList: true, subtree: true });
    }

    syncWandEntry() {
        if (this.destroyed) return;
        const existing = document.getElementById(WAND_CONTAINER_ID);
        if (!this.getSettings().showWandButton) {
            existing?.remove();
            return;
        }
        if (existing?.isConnected) return;
        const host = document.getElementById('extensionsMenu');
        if (!host) return;
        const container = document.createElement('div');
        container.id = WAND_CONTAINER_ID;
        container.className = 'extension_container';
        const entry = document.createElement('div');
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

    setStatus(state, text) {
        for (const output of document.querySelectorAll('[data-cache-status]')) {
            output.dataset.state = state;
            output.textContent = text;
            output.removeAttribute('title');
        }
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
                ? `本层记忆 · 生成失败`
                : `本层记忆 · ${record.title}`;
            const body = document.createElement('div');
            body.className = 'cache-memory-message-body';
            if (record.status === 'failed') {
                body.append(this.line('错误', record.error || '未知错误'));
            } else {
                body.append(this.line('人物', record.characters), this.line('事件', record.event));
                if (record.status === 'stale') body.append(this.line('状态', '原消息已编辑或切换了备选回复，请手动重新生成'));
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
        }, { signal: this.controller.signal });
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
            <div class="cache-memory-manager-panel" role="dialog" aria-modal="true" aria-label="记忆管理">
                <header><div><h3>记忆管理</h3><small>查看和整理当前聊天的冻结记忆</small></div><button type="button" class="menu_button" data-manager-close title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button></header>
                <div class="cache-memory-manager-toolbar">
                    <button type="button" class="menu_button" data-export><i class="fa-solid fa-download"></i> 导出 JSON</button>
                    <button type="button" class="menu_button" data-import><i class="fa-solid fa-upload"></i> 导入 JSON</button>
                    <input type="file" accept="application/json,.json" data-import-file hidden>
                </div>
                <div class="cache-memory-manager-content" data-manager-content></div>
            </div>`;
        document.body.append(overlay);
        this.manager = overlay;
        overlay.addEventListener('click', event => this.handleManagerClick(event), { signal: this.controller.signal });
        overlay.querySelector('[data-import-file]').addEventListener('change', event => this.importFile(event), { signal: this.controller.signal });
    }

    renderManager() {
        if (!this.manager || this.manager.hidden) return;
        const content = this.manager.querySelector('[data-manager-content]');
        content.replaceChildren();
        const store = this.store.current();
        const summaries = Object.values(store.summaries).sort((a, b) => a.floor - b.floor);
        content.append(this.managerSection('楼层小总结', summaries, 'summary'));
        content.append(this.pendingCheckpoint());
        content.append(this.managerSection('阶段记忆', store.checkpoints, 'checkpoint'));
        content.append(this.managerSection('长期记忆', store.longMemories, 'long'));
        content.append(this.continuitySection('当前长期事实', formatLongFacts(projectLongFacts(store))));
        content.append(this.continuitySection('有效 KEEP · 不可丢失事项', formatKeepItems(collectKeepItems(store))));
    }

    continuitySection(title, text) {
        const section = document.createElement('section');
        section.className = 'cache-memory-manager-section';
        const heading = document.createElement('h4');
        heading.textContent = title;
        const body = document.createElement('pre');
        body.className = 'cache-memory-continuity';
        body.textContent = text;
        section.append(heading, body);
        return section;
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
        status.textContent = item.status === 'manual-edited' || item.manualEdited ? '手动编辑' : item.status === 'failed' ? '生成失败' : item.status === 'stale' ? '需要更新' : item.status === 'orphaned' ? '原文已删除' : '已冻结';
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
        actions.innerHTML = `<button type="button" class="menu_button" data-fill-missing="${missing.join(',')}">先补齐缺失摘要</button><button type="button" class="menu_button" data-continue-checkpoint="${range.startFloor}:${range.endFloor}">继续生成阶段记忆</button>`;
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

    destroy() {
        this.destroyed = true;
        this.controller.abort();
        this.wandObserver?.disconnect();
        this.wandObserver = null;
        document.getElementById(ROOT_ID)?.remove();
        document.getElementById(CONFIG_ID)?.remove();
        document.getElementById(MANAGER_ID)?.remove();
        document.getElementById(WAND_CONTAINER_ID)?.remove();
        document.querySelectorAll('.cache-memory-message').forEach(element => element.remove());
        document.body.classList.remove('cache-memory-config-open', 'cache-memory-manager-open');
        this.config = null;
        this.manager = null;
    }
}
