import { hasLastingResult } from './active-state.js?v=1.27.10';
// Normal-mode generation only. Never replay these selectors over saved memory
// or use them in injection: omitted deltas remain in the new Summary narrative.
const clean = value => String(value ?? '').trim();
const activeThread = status => ['published', 'active', 'ready', 'unclaimed'].includes(status);
const stableTrait = /(?:性格|性子|性情|个性|为人|脾气|生性|天性|素来|平时|通常|一贯|向来|总是|喜欢|喜爱|偏好|爱好|讨厌|厌恶|不喜欢|习惯|personality|temperament|by nature|always|usually|prefers?|likes?|hates?)/iu;
const momentaryField = /^(?:(?:当前|此刻|本层|实时)的?)?(?:位置|所在地|姿势|坐姿|站姿|睡姿|衣着|穿着|表情|情绪|情绪灰条|心情|门轴响动)$|(?:物品|名牌|手卡|纸包|手机)(?:位置|持握状态)$/u;
const shortDone = /(?:已成功开箱|已打开行李箱|已完成收拾|已经抵达|已收起便利贴|已经塞进手机壳)/u;
const lastingConsequence = /(?:任务|期限|承诺|约定|秘密|隐瞒|不知情|知情|误信|调查|线索|证据|身份|关系|伤势|受伤|中毒|昏迷|失踪|监禁|禁令|权限|封锁|限制|威胁|债务|损失|过敏|手术)/u;

export function selectNormalChanges(changes, known = []) {
    const previous = new Map(known.map(item => [item.id, item]));
    const selected = new Map();
    for (const row of changes) {
        const old = selected.get(row.id) ?? previous.get(row.id);
        // Keep evidenced closure of old transient records, so existing tracked
        // tasks can still settle. A settled task cannot become active again.
        if (row.kind === 'thread' && old && !activeThread(old.status) && activeThread(row.status)) continue;
        const ended = row.kind === 'thread' ? !activeThread(row.status) : row.status === 'expired';
        if (!ended) {
            if (row.kind === 'state' && row.lifetime === 'temporary' && shortDone.test(row.value)
                && !lastingConsequence.test([row.key, row.value, row.condition].join(' '))) continue;
            if (['personality', 'preference', 'clothing'].includes(row.category) && !stableTrait.test(row.evidence)) continue;
            if (row.kind === 'state' && momentaryField.test(row.key)
                && !lastingConsequence.test([row.key, row.value, row.evidence, row.condition].join(' '))) continue;
        }
        const signature = item => JSON.stringify([clean(item.value), item.status, item.category || old?.category || '',
            item.acquisition || 'obtained', item.lifetime || old?.lifetime || 'permanent', item.condition || old?.condition || '',
            [...new Set(item.actors?.length ? item.actors : [item.entity])].sort()]);
        if (old && signature(row) === signature(old)) continue;
        selected.set(row.id, row);
    }
    return [...selected.values()];
}

// Existing reconciliation deliberately retains settlement markers for replay.
// Move only its exact generated markers in a NEW normal aggregate out of active fields;
// untouched prose, historical causes and separate observers are not guessed away.
export function normalCheckpointHistory(content, tracked, startFloor) {
    const ended = tracked.filter(item => !item.needsReview && (item.kind === 'thread' ? !activeThread(item.status) : item.status === 'expired'));
    const render = item => `- 已结束 ${item.entity} · ${item.key}：${item.value} (${item.status}，仅作历史结果)`;
    const markers = new Set(ended.flatMap(item => [render(item), render(item).replace('仅作历史结果', '历史结果')]));
    const currentSections = new Set(['Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks']);
    let section = '';
    let result = String(content).split('\n').filter(line => {
        const heading = line.match(/^\s*\[([^\]\n]+)\]\s*$/)?.[1];
        if (heading) section = heading;
        return !currentSections.has(section) || !markers.has(line.trim());
    }).join('\n');
    const history = ended.filter(item => item.sourceFloor >= startFloor && hasLastingResult(item))
        .map(render).filter(line => !result.split('\n').some(existing => existing.trim() === line));
    if (!history.length) return result;
    const sectionPattern = /(\[Story So Far\]\n)([\s\S]*?)(?=\n\[[^\]\n]+\]|$)/u;
    if (sectionPattern.test(result)) result = result.replace(sectionPattern, (_, heading, body) =>
        `${heading}${[body.trim() === '无' ? '' : body.trim(), ...history].filter(Boolean).join('\n')}`);
    else result += `\n[Story So Far]\n${history.join('\n')}`;
    return result;
}

export function selectNormalFactUpdates(updates, existingFacts) {
    // Decoration/whitespace equality only: different wording, knowledge holders,
    // compound causes and still-important historical consequences stay distinct.
    const key = value => clean(value).replace(/^[-*•]\s*/u, '').replace(/\s+/gu, ' ');
    const existing = new Map(existingFacts.filter(item => item.status === 'active').map(item => [item.id, item]));
    const adding = new Set([...existing.values()].map(item => key(item.text)));
    return updates.filter(update => {
        if (update.action === 'add') {
            const text = key(update.text);
            if (adding.has(text)) return false;
            adding.add(text);
        }
        if (update.action === 'replace' && key(update.text) === key(existing.get(update.previousId)?.text)) return false;
        return true;
    });
}
