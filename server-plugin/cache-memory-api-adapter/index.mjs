import { createHash } from 'node:crypto';

export const info = Object.freeze({
    id: 'cache-memory-api-adapter',
    name: 'Cache Memory API Adapter',
    description: 'Server-side prompt cache breakpoint adapter for SillyTavern Cache Memory.',
});

const VERSION = '1.0.0';
const CACHE_MEMORY_PATTERN = /\[(?:CACHE_MEMORY|LONG_MEMORY|CHECKPOINT|KEEP)(?:_|\]|\s|$)/i;
const STATIC_NAMES = new Set(['main', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'nsfw']);
let coreRouter = null;
let nativeClaudeConfig = null;

function textParts(message) {
    if (typeof message?.content === 'string') return message.content.trim() ? [{ index: 0, text: message.content }] : [];
    if (!Array.isArray(message?.content)) return [];
    return message.content.flatMap((part, index) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim()
        ? [{ index, text: part.text }] : []);
}

function textProjection(messages) {
    return messages.map(message => ({
        role: message?.role,
        text: textParts(message).map(part => part.text),
    }));
}

function containsCacheControl(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Object.hasOwn(value, 'cache_control')) return true;
    return Object.values(value).some(child => containsCacheControl(child, seen));
}

function existingRewrite(body) {
    if (containsCacheControl(body.messages)) return 'messages 已含 cache_control';
    if (/cache[_-]?control|prompt[_-]?cach/i.test(String(body.custom_include_body || ''))) return 'New API 附加参数已包含缓存改写';
    if (/prompt-caching|extended-cache-ttl/i.test(String(body.custom_include_headers || ''))) return 'New API 附加请求头已包含缓存配置';
    return '';
}

function supportsPolicy(body, policy) {
    const source = String(body.chat_completion_source || '').toLowerCase();
    const model = String(body.model || '').toLowerCase();
    if (source === 'claude') return { supported: false, reason: 'Claude 原生源由 ST 服务端 config.yaml 管理；适配器不覆盖官方策略' };
    if (policy.compatibility === 'anthropic-blocks') return { supported: ['custom', 'openrouter'].includes(source), reason: '手动兼容模式仅支持 Custom / OpenRouter Chat Completion' };
    if (source === 'openrouter' && /^anthropic\/claude/.test(model)) return { supported: true, reason: '' };
    return { supported: false, reason: '自动检测未确认接口支持 Anthropic cache_control 内容块，已安全旁路' };
}

function candidateIndexes(messages, policy) {
    const candidates = [];
    if (policy.cacheStatic) {
        const leadingSystem = [];
        for (let index = 0; index < messages.length && messages[index]?.role === 'system'; index += 1) leadingSystem.push(index);
        const named = leadingSystem.find(index => STATIC_NAMES.has(messages[index]?.name) && textParts(messages[index]).length);
        const firstNonEmpty = leadingSystem.find(index => textParts(messages[index]).length);
        const index = named ?? firstNonEmpty;
        if (index !== undefined) candidates.push({ index, kind: 'fixed-settings' });
    }
    if (policy.cacheMemory) {
        const index = messages.findIndex(message => textParts(message).some(part => CACHE_MEMORY_PATTERN.test(part.text)));
        if (index >= 0) candidates.push({ index, kind: 'frozen-memory' });
    }
    if (policy.cacheHistory) {
        const usable = messages.map((message, index) => ({ message, index }))
            .filter(({ message }) => ['user', 'assistant'].includes(message?.role) && textParts(message).length);
        const tailIndex = usable.at(-1)?.index;
        const history = usable.filter(item => item.index !== tailIndex);
        const index = history.at(-Math.max(1, Number(policy.historyDepth) || 4))?.index;
        if (index !== undefined) candidates.push({ index, kind: 'rolling-history' });
    }
    return candidates.filter((candidate, index, all) => all.findIndex(item => item.index === candidate.index) === index).slice(0, 4);
}

function markMessage(message, cacheControl) {
    const parts = textParts(message);
    const target = parts.at(-1);
    if (!target) return null;
    if (typeof message.content === 'string') {
        message.content = [{ type: 'text', text: message.content, cache_control: cacheControl }];
        return 0;
    }
    message.content[target.index] = { ...message.content[target.index], cache_control: cacheControl };
    return target.index;
}

function shortHash(text) {
    return createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

function makePreview(body, points, { applied, reason, conflict = false } = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const roles = messages.reduce((result, message) => {
        const role = String(message?.role || 'unknown');
        result[role] = (result[role] || 0) + 1;
        return result;
    }, {});
    const textChars = messages.reduce((sum, message) => sum + textParts(message).reduce((partSum, part) => partSum + part.text.length, 0), 0);
    return {
        version: VERSION,
        applied,
        conflict,
        summary: applied ? `服务端已添加 ${points.length} 个独立消息块缓存断点` : reason,
        source: String(body.chat_completion_source || 'unknown'),
        model: String(body.model || 'unknown'),
        messageCount: messages.length,
        roles,
        textChars,
        cachePoints: points.map(point => ({
            kind: point.kind,
            messageIndex: point.index,
            blockIndex: point.blockIndex,
            role: messages[point.index]?.role,
            chars: textParts(messages[point.index]).reduce((sum, part) => sum + part.text.length, 0),
            sha256: shortHash(textParts(messages[point.index]).map(part => part.text).join('')),
            ttl: point.ttl,
        })),
    };
}

export function transformRequest(inputBody, inputPolicy = {}) {
    const original = inputBody && typeof inputBody === 'object' ? inputBody : {};
    const body = structuredClone(original);
    delete body.cache_memory_adapter;
    const policy = {
        enabled: inputPolicy.enabled === true,
        ttl: inputPolicy.ttl === '1h' ? '1h' : '5m',
        cacheStatic: inputPolicy.cacheStatic !== false,
        cacheMemory: inputPolicy.cacheMemory !== false,
        cacheHistory: inputPolicy.cacheHistory !== false,
        historyDepth: Math.min(64, Math.max(1, Math.round(Number(inputPolicy.historyDepth) || 4))),
        compatibility: inputPolicy.compatibility === 'anthropic-blocks' ? 'anthropic-blocks' : 'auto',
    };
    if (!policy.enabled) return { body, preview: makePreview(body, [], { applied: false, reason: '此连接的缓存策略已关闭' }) };
    if (!Array.isArray(body.messages)) return { body, preview: makePreview(body, [], { applied: false, reason: '请求没有可处理的 messages 数组' }) };
    const conflictReason = existingRewrite(body);
    if (conflictReason) return { body, preview: makePreview(body, [], { applied: false, conflict: true, reason: `${conflictReason}；为避免重复策略已旁路` }) };
    const capability = supportsPolicy(body, policy);
    if (!capability.supported) return { body, preview: makePreview(body, [], { applied: false, reason: capability.reason }) };

    const before = textProjection(body.messages);
    const cacheControl = { type: 'ephemeral', ttl: policy.ttl };
    const points = candidateIndexes(body.messages, policy).flatMap(candidate => {
        const blockIndex = markMessage(body.messages[candidate.index], cacheControl);
        return blockIndex === null ? [] : [{ ...candidate, blockIndex, ttl: policy.ttl }];
    });
    if (JSON.stringify(before) !== JSON.stringify(textProjection(body.messages))) {
        const safeBody = structuredClone(original);
        delete safeBody.cache_memory_adapter;
        return { body: safeBody, preview: makePreview(safeBody, [], { applied: false, reason: '正文完整性校验失败，已恢复原始请求' }) };
    }
    return { body, preview: makePreview(body, points, { applied: points.length > 0, reason: '没有找到非空、可独立标记的文本块' }) };
}

function previewHeader(preview) {
    return encodeURIComponent(JSON.stringify(preview));
}

export async function init(router) {
    try {
        const core = await import(new URL('../../src/endpoints/backends/chat-completions.js', import.meta.url));
        const util = await import(new URL('../../src/util.js', import.meta.url));
        coreRouter = core.router;
        nativeClaudeConfig = {
            enableSystemPromptCache: util.getConfigValue('claude.enableSystemPromptCache', false, 'boolean'),
            cachingAtDepth: util.getConfigValue('claude.cachingAtDepth', -1, 'number'),
            ttl: util.getConfigValue('claude.extendedTTL', false, 'boolean') ? '1h' : '5m',
        };
    } catch (error) {
        console.error('[Cache Memory API Adapter] Failed to load ST chat completion router:', error);
    }

    router.get('/status', (_request, response) => response.json({
        id: info.id,
        version: VERSION,
        coreDelegation: Boolean(coreRouter),
        nativeClaude: nativeClaudeConfig,
        modes: ['openrouter-claude-auto', 'custom-anthropic-blocks'],
    }));

    router.post('/generate', (request, response, next) => {
        if (!coreRouter) return response.status(503).json({ error: 'SillyTavern Chat Completion router unavailable' });
        const metadata = request.body?.cache_memory_adapter;
        const { body, preview } = transformRequest(request.body, metadata?.policy);
        request.body = body;
        response.setHeader('x-cache-memory-adapter-preview', previewHeader(preview));
        const previousUrl = request.url;
        request.url = '/generate';
        return coreRouter.handle(request, response, error => {
            request.url = previousUrl;
            if (error) return next(error);
            if (!response.headersSent) return response.status(404).json({ error: 'SillyTavern Chat Completion handler unavailable' });
        });
    });
}

export async function exit() {
    coreRouter = null;
    nativeClaudeConfig = null;
}
