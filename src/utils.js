export function fnv1a(value) {
    let hash = 0x811c9dc5;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function isNormalAssistant(message) {
    return Boolean(message)
        && message.is_user !== true
        && message.is_system !== true
        && message.extra?.type !== 'narrator'
        && message.extra?.isSmallSys !== true
        && !Array.isArray(message.extra?.tool_invocations)
        && typeof message.mes === 'string'
        && message.mes.trim().length > 0;
}

export function messageIdentity(message) {
    const parts = [
        message?.name ?? '',
        message?.send_date ?? '',
        message?.gen_started ?? '',
        message?.extra?.gen_id ?? '',
    ];
    if (!parts.slice(1).some(Boolean)) parts.push(message?.mes ?? '');
    const stable = parts.join('\u001f');
    return `message-${fnv1a(stable)}`;
}

export function messageFingerprint(message) {
    return fnv1a([
        messageIdentity(message),
        message?.swipe_id ?? 0,
        message?.mes ?? '',
    ].join('\u001f'));
}

export const messageContentFingerprint = message => fnv1a(String(message?.mes ?? '').replace(/\s+/gu, ' ').trim());

export function getAssistantMessages(chat) {
    let floor = 0;
    return (Array.isArray(chat) ? chat : []).flatMap((message, messageIndex) => {
        if (!isNormalAssistant(message)) return [];
        const isUngeneratedGreeting = messageIndex === 0
            && !message.gen_started
            && !message.gen_finished
            && !message.extra?.api
            && !message.extra?.model;
        if (isUngeneratedGreeting) return [];
        floor += 1;
        return [{
            floor,
            messageIndex,
            message,
            messageId: messageIdentity(message),
            fingerprint: messageFingerprint(message),
            contentFingerprint: messageContentFingerprint(message),
        }];
    });
}

export function replacePromptVariables(template, values) {
    return Object.entries(values).reduce(
        (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value ?? '')),
        String(template ?? ''),
    );
}

export function clampText(text, maxLength) {
    const value = String(text ?? '').trim();
    const limit = Math.max(1, Number(maxLength) || value.length);
    return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function formatDate(iso) {
    if (!iso) return '未知';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

export function downloadJson(filename, data, doc = document) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
