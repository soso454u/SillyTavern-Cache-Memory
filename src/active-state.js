import { fnv1a } from './utils.js?v=1.24.1';

export const ACTIVE_THREAD_STATUSES = ['published', 'active', 'ready', 'unclaimed'];
export const isTrackedActive = item => item?.kind === 'thread' ? ACTIVE_THREAD_STATUSES.includes(item.status) : item?.status === 'active';
const clean = value => String(value ?? '').trim();
const validSummary = item => item && item.frozen !== false && !['failed', 'orphaned'].includes(item.status);

export function threadKey(value) {
    const key = clean(value);
    const named = key.match(/^(?:(?:新手|突发)?任务\s*[:：]?\s*)?【([^【】]+)】(?:剧情判定|判定|任务|进度|状态)?$/u);
    return named?.[1].trim() ?? key.replace(/^(?:新手|突发)?任务\s*[:：]\s*/u, '').trim();
}

// This suffix names the same displayed measurement, not a second attribute.
// Other slash-separated fields may be independent and are not merged.
const attributeKey = value => clean(value).replace(/\s*[/／]\s*红字数值$/u, '');
const subjectKey = item => item.kind === 'thread' ? threadKey(item.key)
    : item.category === 'attribute' ? attributeKey(item.key) : clean(item.key);
const sameSubject = (a, b) => a.kind === b.kind && a.entity === b.entity
    && subjectKey(a) === subjectKey({ ...b, category: b.category || a.category });

export function stateId(item) {
    return `${item.kind === 'thread' ? 'thread' : 'state'}-${fnv1a(JSON.stringify([clean(item.entity), subjectKey(item)]))}`;
}

// Only a small, evidenced delta is extracted in the existing Summary request.
// Legacy Open/State prose is retained, never guessed into a completed task.
export function parseStateChanges(text, source, known = [], { advanced = false } = {}) {
    let rows;
    try { rows = JSON.parse(clean(text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return []; }
    if (!Array.isArray(rows)) return [];
    const byId = new Map(known.map(item => [item.id, item]));
    return rows.slice(0, advanced ? 96 : 24).flatMap(row => {
        if (!row || !['thread', 'state'].includes(row.kind) || row.confirmed !== true) return [];
        const entity = clean(row.entity), key = clean(row.key), value = clean(row.value), evidence = clean(row.evidence);
        if (!entity || !key || !value || evidence.length < 4 || !String(source).includes(evidence)) return [];
        // Stable traits need an explicit statement, not an inferred one-off action.
        if (advanced && ['personality', 'preference', 'clothing'].includes(clean(row.category))
            && !/(?:性格|性子|生性|天性|素来|平时|通常|一贯|向来|总是|喜欢|喜爱|偏好|爱好|讨厌|厌恶|不喜欢|习惯|personality|temperament|by nature|introvert|extrovert|always|usually|prefers?|likes?|loves?|hates?|dislikes?|favourite|favorite)/iu.test(evidence)) return [];
        const requested = byId.get(clean(row.id));
        if (row.id && (!requested || !sameSubject(requested, { ...row, entity, key }))) return [];
        const id = requested?.id ?? known.find(item => sameSubject(item, { ...row, entity, key }))?.id ?? stateId({ ...row, entity, key });
        const status = clean(row.status) || 'active';
        if (!(row.kind === 'thread' ? [...ACTIVE_THREAD_STATUSES, 'completed', 'failed', 'cancelled'] : ['active', 'expired']).includes(status)) return [];
        if (!(row.kind === 'thread' ? ACTIVE_THREAD_STATUSES : ['active']).includes(status) && !byId.has(id)) {
            // Completion may be the first observed delta, e.g. older summaries
            // predate Changes. Require explicit settlement evidence in that case.
            if (row.kind !== 'thread' || status !== 'completed'
                || !/(?:任务.{0,12}(?:已完成|完成了|完成[，。！!；;]|结算完成)|已完成|已结算|结算完成|已领取|领取了)/u.test(evidence)
                || /(?:未|没有|尚未|还没)(?:完成|结算|领取)/u.test(evidence)) return [];
        }
        return [{ id, kind: row.kind, entity, key, value, evidence, status,
            actors: Array.isArray(row.actors) ? row.actors.map(clean).filter(Boolean) : [entity],
            category: clean(row.category || byId.get(id)?.category), acquisition: ['pending', 'obtained'].includes(row.acquisition) ? row.acquisition : byId.get(id)?.acquisition ?? (row.category === 'reward' ? 'pending' : 'obtained'),
            condition: clean(row.condition), lifetime: ['temporary', 'permanent'].includes(row.lifetime) ? row.lifetime : byId.get(id)?.lifetime ?? 'permanent' }];
    });
}

export function projectActiveState(store, throughFloor = Infinity) {
    const records = new Map();
    const aggregateSources = new Set();
    const replay = (change, source) => {
        if (!change?.id || !['thread', 'state'].includes(change.kind)) return;
        const recordKey = stateId(change);
        const old = records.get(recordKey);
        // A frozen Long may be the only retained, verified settlement after a
        // Summary version switch. Use its explicit structured result only as
        // a fallback, preserving a real Summary result and manual correction.
        if (source.aggregate && old && !old.needsReview && (old.manual || !isTrackedActive(old))) return;
        if (!change.manual && old && !old.needsReview) {
            if (source.needsReview) return;
            if (old.kind === 'thread' && (old.status === 'completed' && change.status !== 'completed'
                || !isTrackedActive(old) && isTrackedActive(change))) return;
        }
        const history = old ? [...old.history, { key: old.key, value: old.value, status: old.status, sourceId: old.sourceId, sourceFloor: old.sourceFloor }] : [];
        records.set(recordKey, { ...old, ...change, manual: Boolean(change.manual), id: old?.id ?? change.id, ...source, history, originSourceId: change.manual ? change.sourceId : source.aggregate ? source.sourceId : old?.originSourceId ?? source.sourceId,
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
    for (const memory of store.longMemories ?? []) {
        if (!validSummary(memory) || !['frozen', 'manual-edited', 'stale'].includes(memory.status ?? 'frozen')
            || memory.sourceReplaced || !(memory.endFloor <= throughFloor)) continue;
        for (const line of String(memory.continuityState ?? '').split('\n')) {
            const match = line.match(/^\s*-\s*已结束\s+([^·\n]+)\s·\s((?:(?:新手|突发)?任务\s*[:：]\s*)?[^：:\n]+)[：:]\s*(.+)\s\((completed|failed|cancelled)，(?:仅作)?历史结果\)\s*$/u);
            if (!match) continue;
            const [, entity, key, value, status] = match;
            const change = { kind: 'thread', entity: entity.trim(), key: key.trim(), value: value.trim(), status, evidence: line.trim() };
            change.id = stateId(change);
            aggregateSources.add(memory.id);
            events.push({ change, floor: memory.endFloor, sequence: 0, source: { sourceId: memory.id, sourceFloor: memory.endFloor, needsReview: false, aggregate: true } });
        }
    }
    events.sort((a, b) => a.floor - b.floor || a.sequence - b.sequence);
    for (const event of events) replay(event.change, event.source);
    // A later progress report cannot repair an erased/edited task announcement.
    for (const item of records.values()) if (!aggregateSources.has(item.originSourceId) && !validSummary(store.summaries?.[item.originSourceId])) item.needsReview = true;
    return [...records.values()];
}

export function stateContext(store, throughFloor = Infinity) {
    // Ended tasks are still needed to prevent later summaries reopening them.
    return projectActiveState(store, throughFloor).filter(item => !item.needsReview)
        .map(({ id, kind, entity, key, value, status, condition, lifetime, acquisition, sourceFloor }) => JSON.stringify({ id, kind, entity, key, value, status, condition, lifetime, acquisition, sourceFloor })).join('\n') || '无';
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
    if (fact.stateId && fact.stateId === item.id) return true;
    const text = String(fact.text ?? '').replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim();
    // Both the observer and the exact subject must match, including knowledge.
    const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = `^(?:已结束\\s+)?(?:【)?${escape(item.entity)}\\s*(?:[·|｜:：的]\\s*)?`;
    const keys = [...new Set([item.key, ...(item.history ?? []).map(old => old.key).filter(Boolean), subjectKey(item)])];
    if (keys.some(key => new RegExp(`${prefix}${escape(key)}(?:[：:】\\s]|$)`).test(text))) return true;
    if (item.kind === 'thread') return new RegExp(`${prefix}(?:(?:新手|突发)?任务\\s*[:：]?\\s*)?(?:【${escape(threadKey(item.key))}】(?:剧情判定|判定|任务|进度|状态)?|${escape(threadKey(item.key))})(?:[：:\\s]|$)`).test(text);
    return item.category === 'attribute' && new RegExp(`${prefix}${escape(attributeKey(item.key))}(?:\\s*[/／]\\s*红字数值)?(?:[：:】\\s]|$)`).test(text);
}

export function reconcileTrackedCheckpoint(content, store, throughFloor, startFloor = 1) {
    let result = String(content);
    const rows = projectActiveState(store, throughFloor).filter(item => !item.needsReview);
    const sectionFor = item => item.kind === 'thread' ? 'Open Threads' : item.category === 'knowledge' ? 'Secrets & Knowledge'
        : item.category === 'identity' ? 'Characters' : 'Current State';
    // Reconcile only current-state sections. Historical causes and relationship
    // events in Story So Far must survive a later change of value.
    for (const section of ['Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks']) {
        if (!rows.length) continue;
        const marker = new RegExp(`(^|\\n)\\[${section}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[[^\\]\\n]+\\]|$)`);
        const existing = result.match(marker);
        const retained = (existing?.[2] ?? '').split('\n').filter(line => !rows.some(item => matchesTrackedFact({ text: line }, item)));
        const lines = rows.filter(item => sectionFor(item) === section && isTrackedActive(item)
            && !(item.category === 'knowledge' && item.sourceFloor < startFloor && retained.some(line => line.trim() && !/^无[。.]?$/.test(line.trim()))))
            .map(item => `- ${item.entity} · ${item.key}：${item.value}${item.acquisition === 'pending' ? '（尚未领取）' : ''}${item.condition ? `；条件：${item.condition}` : ''}`);
        lines.push(...rows.filter(item => sectionFor(item) === section && !isTrackedActive(item) && item.sourceFloor >= startFloor)
            .map(item => `- 已结束 ${item.entity} · ${item.key}：${item.value} (${item.status}，仅作历史结果)`));
        if (!existing && !lines.length) continue;
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

export function omitRepeatedStateLines(content, previous, { omit = true } = {}) {
    let current = false;
    let character = '';
    let sectionName = '';
    return String(content).split('\n').filter(line => {
        const section = line.match(/^\s*\[([^\]\n]+)\]\s*$/)?.[1];
        if (section) { sectionName = section; character = ''; current = ['Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks'].includes(section); return true; }
        if (!current) return true;
        const text = line.replace(/^\s*[-*•]\s*/, '').trim();
        if (sectionName === 'Characters' && /^[^：:\n]+[：:]$/.test(text)) { character = text.slice(0, -1); return true; }
        const field = character && /^\s*[-*•]/.test(line) ? text.match(/^([^：:\n]+)[：:]/)?.[1] : '';
        const subject = text.match(/^([^：:\n]+\s·\s[^：:\n]+)[：:]/)?.[1] ?? (field ? `${sectionName}:${character}:${field}` : '');
        if (!subject) return true;
        const repeated = previous.get(subject) === text;
        previous.set(subject, text);
        return !omit || !repeated;
    }).join('\n');
}

export function trackedFactUpdates(updates, store, throughFloor, existingFacts = []) {
    const states = projectActiveState(store, throughFloor).filter(item => item.kind === 'state' && !item.needsReview && item.lifetime !== 'temporary' && item.acquisition !== 'pending'
        && !existingFacts.some(fact => fact.status === 'active' && fact.floor > item.sourceFloor && matchesTrackedFact(fact, item)));
    return [...updates.filter(update => !states.some(item => matchesTrackedFact(update, item))),
        ...states.flatMap(item => {
            const matches = existingFacts.filter(fact => fact.status === 'active' && matchesTrackedFact(fact, item));
            const id = matches[0]?.id ?? item.id;
            const retire = fact => ({ action: 'retire', id: fact.id, previousId: fact.id, stateId: item.id, reason: item.value, evidence: item.evidence });
            if (!isTrackedActive(item)) return matches.length ? matches.map(retire) : [retire({ id })];
            const text = `${item.entity} · ${item.key}：${item.value}`;
            const unchanged = matches[0]?.text === text;
            return [...(unchanged ? [] : [{ action: matches.length ? 'replace' : 'add', id, ...(matches.length ? { previousId: id } : {}), stateId: item.id,
                text, evidence: item.evidence }]), ...matches.slice(1).map(retire)];
        })];
}

export const STATE_EXTRACTION_RULES = `\n【持续状态增量】
沿用 Summary 的 Open 和 State 叙述，在最后可附 [Changes]，值为 JSON 数组，无变化写 []。只输出本层明确变化，禁止整张角色卡。
每项字段：kind(thread/state), id(更新已有事项必须复用上下文 ID；新增省略), entity(完整角色身份；同名 NPC 用剧情身份区分), key(稳定任务名或技能/属性名，等级不能作为 key), value(当前进度/最新确认值), status(published已发布/active进行中/ready条件满足待结算/unclaimed结算后待领取/completed已完成/failed失败/cancelled取消；state 为 active/expired), category(skill/attribute/reward/item/identity/knowledge/effect), acquisition(obtained/pending), condition(完成或失效条件), lifetime(permanent/temporary), actors(人物数组), evidence(本层原文连续引句，至少4字), confirmed:true。
世界书候选任务、计划获取能力禁止提取；已正式发布的待领取奖励记 acquisition:pending，不能当作已获得的长期能力。任务正式发布后长期未提及仍 active；只凭剧情明确完成或系统结算才能 completed。已完成且领取的任务禁止恢复为进行中或待领取；后续重复任务须有明确重新发布的证据并使用区别于旧任务的新 key。首次看到的明确完成/领取结果也应记录，不依赖旧层已有 Changes。维持到入睡前等条件未满足不得提前完成。升级只更新同一技能当前等级，属性记最新确认数值，临时效果保留结束条件。NPC 认知、关系变化必须有明确证据。KEEP 仅强调关键事实，不堆放全部任务和技能。JSON 与正文合计遵守现有输出上限。`;

export const STATE_AGGREGATION_RULES = `\n[CURRENT_TRACKED_STATE] 是截至本区间的已确认事项与角色状态，sourceFloor 表示最后确认楼层；NEW_SUMMARIES 或更晚 Checkpoint 中的明确变化优先于旧来源状态。已完成任务及已领取奖励不得复活为未完成/未领取；任务名称外的“任务：”“剧情判定”等格式不构成另一项任务。将仍有意义的任务进度/完成条件精简融入原 Open Threads、Current State 栏目；未提及不等于结束。区分历史事件和当前值，同一任务、属性、技能、物品或计划在当前状态中只保留一条最新确认值；旧计划被明确替代时移出当前计划，必要原因可留在原历史栏目。不得把同一条状态复制到多个栏目；人物认知差、重要 NPC 与尚未解决事项继续保留，不能因未提及而删除。同一技能仅呈现最新等级。Long Memory 只留长期能力、重要变化及必要历史结果，短期已结算任务不再作为活跃事项。无需回显 JSON，不重复 KEEP/已有 Long Facts，遵守原长度目标。`;

export const ADVANCED_EXTRACTION_RULES = `
【复杂进阶总结（可选）】
仍沿用原 Summary 格式和 [Changes]，不增加请求。重要 NPC 按完整人物身份分别记录，已有事实未提及也保留；只输出本层新确认或明确变化。
复用现有 kind:state，category 可为 identity/relationship/personality/preference/clothing/knowledge/history/skill/effect。记录明确身份、人物关系、稳定性格、喜好、穿搭偏好、秘密、各自认知差、重要经历、技能及当前状态。
性格、喜好、穿搭偏好必须在 evidence 中有直接陈述或明确总结长期习惯的原文，禁止从单次行为、单次穿着或情绪推断；缺乏证据则省略。其他字段同样需要本层连续原文证据。
重新登场先继承 CURRENT_TRACKED_STATE 与 EXISTING_LONG_FACTS 的已知事实。关系、技能、喜好、身份、状态明确变化时复用同人物同字段的稳定 key 和已有 ID，只记录最新确认值；key 不包含等级或当前值，不拆出矛盾的重复字段。知识以知情者为 entity，不能把读者知道的秘密写成角色已知。临时状态标 temporary 和失效条件，长期事实标 permanent。遵守现有输出预算，优先重要人物和变化，不回显整张资料表。`;

export const ADVANCED_AGGREGATION_RULES = `
【复杂进阶总结（可选）】
沿用原 Checkpoint / Long Memory 栏目和输出预算，分别保留重要人物的身份、关系、稳定性格、明确喜好与穿搭偏好、秘密与认知差、重要经历、技能和当前状态，不将多个重要 NPC 长期合成一句话。
只整理已有证据，禁止从单次行为推测稳定性格或喜好。人物久未登场不等于失效，继承仍长期有效的既有事实；新证据明确变化才更新同人物同字段当前版本，必要经历放在历史叙述，避免新旧矛盾并列。复用 Characters / Current State / Secrets & Knowledge 及已有 Long Facts，不增加资料表或额外注入栏目。`;
