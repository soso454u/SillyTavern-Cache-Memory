import { fnv1a } from './utils.js?v=1.22.6';

export const ACTIVE_THREAD_STATUSES = ['published', 'active', 'ready', 'unclaimed'];
export const isTrackedActive = item => item?.kind === 'thread' ? ACTIVE_THREAD_STATUSES.includes(item.status) : item?.status === 'active';
const clean = value => String(value ?? '').trim();
const validSummary = item => item && item.frozen !== false && !['failed', 'orphaned'].includes(item.status);

export function stateId(item) {
    return `${item.kind === 'thread' ? 'thread' : 'state'}-${fnv1a(JSON.stringify([clean(item.entity), clean(item.key)]))}`;
}

// Only a small, evidenced delta is extracted in the existing Summary request.
// Legacy Open/State prose is retained, never guessed into a completed task.
export function parseStateChanges(text, source, known = []) {
    let rows;
    try { rows = JSON.parse(clean(text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return []; }
    if (!Array.isArray(rows)) return [];
    const byId = new Map(known.map(item => [item.id, item]));
    return rows.slice(0, 24).flatMap(row => {
        if (!row || !['thread', 'state'].includes(row.kind) || row.confirmed !== true) return [];
        const entity = clean(row.entity), key = clean(row.key), value = clean(row.value), evidence = clean(row.evidence);
        if (!entity || !key || !value || evidence.length < 4 || !String(source).includes(evidence)) return [];
        const requested = byId.get(clean(row.id));
        if (row.id && (!requested || requested.kind !== row.kind || requested.entity !== entity || requested.key !== key)) return [];
        const id = requested?.id ?? stateId({ ...row, entity, key });
        const status = clean(row.status) || 'active';
        if (!(row.kind === 'thread' ? [...ACTIVE_THREAD_STATUSES, 'completed', 'failed', 'cancelled'] : ['active', 'expired']).includes(status)) return [];
        if (!(row.kind === 'thread' ? ACTIVE_THREAD_STATUSES : ['active']).includes(status) && !byId.has(id)) return [];
        return [{ id, kind: row.kind, entity, key, value, evidence, status,
            actors: Array.isArray(row.actors) ? row.actors.map(clean).filter(Boolean) : [entity],
            category: clean(row.category || byId.get(id)?.category), acquisition: ['pending', 'obtained'].includes(row.acquisition) ? row.acquisition : byId.get(id)?.acquisition ?? (row.category === 'reward' ? 'pending' : 'obtained'),
            condition: clean(row.condition), lifetime: ['temporary', 'permanent'].includes(row.lifetime) ? row.lifetime : byId.get(id)?.lifetime ?? 'permanent' }];
    });
}

export function projectActiveState(store, throughFloor = Infinity) {
    const records = new Map();
    const replay = (change, source) => {
        if (!change?.id || !['thread', 'state'].includes(change.kind)) return;
        const old = records.get(change.id);
        const history = old ? [...old.history, { value: old.value, status: old.status, sourceId: old.sourceId, sourceFloor: old.sourceFloor }] : [];
        records.set(change.id, { ...old, ...change, ...source, history, originSourceId: change.manual ? change.sourceId : old?.originSourceId ?? source.sourceId,
            condition: change.condition || old?.condition || '', actors: change.actors?.length ? change.actors : old?.actors ?? [] });
    };
    const events = [];
    for (const summary of Object.values(store.summaries ?? {}).filter(item => item.floor <= throughFloor)) {
        for (const change of summary.stateChanges ?? []) events.push({ change, floor: summary.floor, sequence: 0, source: {
            sourceId: summary.messageId, sourceFloor: summary.floor, sourceFingerprint: summary.sourceFingerprint,
            needsReview: !validSummary(summary) || Boolean(summary.stateChangesNeedsReview),
        } });
    }
    for (const override of Object.values(store.stateOverrides ?? {}).sort((a, b) => a.sourceFloor - b.sourceFloor || a.sequence - b.sequence)) {
        if (override.sourceFloor > throughFloor) continue;
        const source = store.summaries?.[override.sourceId];
        events.push({ change: override, floor: override.sourceFloor, sequence: override.sequence || 1,
            source: { needsReview: !validSummary(source) || source.sourceFingerprint !== override.sourceFingerprint } });
    }
    events.sort((a, b) => a.floor - b.floor || a.sequence - b.sequence);
    for (const event of events) replay(event.change, event.source);
    // A later progress report cannot repair an erased/edited task announcement.
    for (const item of records.values()) if (!validSummary(store.summaries?.[item.originSourceId])) item.needsReview = true;
    return [...records.values()];
}

export function stateContext(store, throughFloor = Infinity) {
    return projectActiveState(store, throughFloor).filter(item => !item.needsReview && isTrackedActive(item))
        .map(({ id, kind, entity, key, value, status, condition, lifetime, acquisition }) => JSON.stringify({ id, kind, entity, key, value, status, condition, lifetime, acquisition })).join('\n') || '无';
}

export function activeStateVersion(store, throughFloor) {
    return fnv1a(JSON.stringify(projectActiveState(store, throughFloor).sort((a, b) => a.id.localeCompare(b.id))
        .map(item => [item.id, item.entity, item.key, item.value, item.status, item.condition, item.lifetime, item.acquisition, item.needsReview])));
}

export function trackedLines(store, throughFloor, kind) {
    return projectActiveState(store, throughFloor).filter(item => item.kind === kind && !item.needsReview && isTrackedActive(item))
        .map(item => `- ${item.entity} · ${item.key}：${item.value}${item.acquisition === 'pending' ? '（尚未领取）' : ''}${item.condition ? `；条件：${item.condition}` : ''}`);
}

export function matchesTrackedFact(fact, item) {
    if (fact.stateId) return fact.stateId === item.id;
    const text = String(fact.text ?? '').replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim();
    // Observer knowledge and someone else's possessions are separate facts.
    if (/不知道|不知|知道|以为|认为|隐瞒|秘密|得知|知晓|听说/.test(text)) return false;
    const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^(?:【)?${escape(item.entity)}\\s*(?:[·|｜:：的]\\s*)?${escape(item.key)}(?:[：:】\\s]|$)`).test(text);
}

export function reconcileTrackedCheckpoint(content, store, throughFloor, startFloor = 1) {
    let result = String(content);
    for (const [kind, section] of [['thread', 'Open Threads'], ['state', 'Current State']]) {
        const rows = projectActiveState(store, throughFloor).filter(item => item.kind === kind && !item.needsReview);
        if (!rows.length) continue;
        const marker = new RegExp(`(^|\\n)\\[${section}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[[^\\]\\n]+\\]|$)`);
        const existing = result.match(marker);
        const retained = (existing?.[2] ?? '').split('\n').filter(line => !rows.some(item => matchesTrackedFact({ text: line }, item)));
        const lines = trackedLines(store, throughFloor, kind);
        lines.push(...rows.filter(item => !isTrackedActive(item) && item.sourceFloor >= startFloor)
            .map(item => `- 已结束 ${item.entity} · ${item.key}：${item.value} (${item.status}，仅作历史结果)`));
        const replacement = `[${section}]\n${[...retained.filter(line => line.trim() && !/^无[。.]?$/.test(line.trim())), ...lines].join('\n') || '无'}`;
        result = existing ? result.replace(marker, `${existing[1]}${replacement}`) : `${result}\n${replacement}`;
    }
    return deduplicateCheckpoint(result);
}

export function deduplicateCheckpoint(content) {
    // Remove only exact repeated entries within a section. Similar prose may
    // encode different observers or historical facts and must remain intact.
    const seen = new Set();
    return String(content).split('\n').filter(line => {
        if (/^\s*\[[^\]\n]+\]\s*$/.test(line)) { seen.clear(); return true; }
        const key = line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').replace(/\s+/g, ' ').trim();
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    }).join('\n');
}

export function trackedFactUpdates(updates, store, throughFloor, existingFacts = []) {
    const states = projectActiveState(store, throughFloor).filter(item => item.kind === 'state' && !item.needsReview && item.lifetime !== 'temporary' && item.acquisition !== 'pending');
    return [...updates.filter(update => !states.some(item => matchesTrackedFact(update, item))),
        ...states.flatMap(item => {
            const matches = existingFacts.filter(fact => fact.status === 'active' && matchesTrackedFact(fact, item));
            const id = matches[0]?.id ?? item.id;
            const retire = fact => ({ action: 'retire', id: fact.id, previousId: fact.id, stateId: item.id, reason: item.value, evidence: item.evidence });
            if (!isTrackedActive(item)) return matches.length ? matches.map(retire) : [retire({ id })];
            return [{ action: matches.length ? 'replace' : 'add', id, ...(matches.length ? { previousId: id } : {}), stateId: item.id,
                text: `${item.entity} · ${item.key}：${item.value}`, evidence: item.evidence }, ...matches.slice(1).map(retire)];
        })];
}

export const STATE_EXTRACTION_RULES = `\n【持续状态增量】
沿用 Summary 的 Open 和 State 叙述，在最后可附 [Changes]，值为 JSON 数组，无变化写 []。只输出本层明确变化，禁止整张角色卡。
每项字段：kind(thread/state), id(更新已有事项必须复用上下文 ID；新增省略), entity(完整角色身份；同名 NPC 用剧情身份区分), key(稳定任务名或技能/属性名，等级不能作为 key), value(当前进度/最新确认值), status(published已发布/active进行中/ready条件满足待结算/unclaimed结算后待领取/completed已完成/failed失败/cancelled取消；state 为 active/expired), category(skill/attribute/reward/item/identity/knowledge/effect), acquisition(obtained/pending), condition(完成或失效条件), lifetime(permanent/temporary), actors(人物数组), evidence(本层原文连续引句，至少4字), confirmed:true。
世界书候选任务、计划获取能力禁止提取；已正式发布的待领取奖励记 acquisition:pending，不能当作已获得的长期能力。任务正式发布后长期未提及仍 active；只凭剧情明确完成或系统结算才能 completed。维持到入睡前等条件未满足不得提前完成。升级只更新同一技能当前等级，属性记最新确认数值，临时效果保留结束条件。NPC 认知、关系变化必须有明确证据。KEEP 仅强调关键事实，不堆放全部任务和技能。JSON 与正文合计遵守现有输出上限。`;

export const STATE_AGGREGATION_RULES = `\n[CURRENT_TRACKED_STATE] 是截至本区间的已确认事项与角色状态。将仍有意义的任务进度/完成条件精简融入原 Open Threads、Current State 栏目；未提及不等于结束。区分历史事件和当前值，同一任务、属性、技能、物品或计划在当前状态中只保留一条最新确认值；旧计划被明确替代时移出当前计划，必要原因可留在原历史栏目。不得把同一条状态复制到多个栏目；人物认知差、重要 NPC 与尚未解决事项继续保留，不能因未提及而删除。同一技能仅呈现最新等级。Long Memory 只留长期能力、重要变化及必要历史结果，短期已结算任务不再作为活跃事项。无需回显 JSON，不重复 KEEP/已有 Long Facts，遵守原长度目标。`;
