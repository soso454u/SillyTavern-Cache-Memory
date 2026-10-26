import { parseStructuredSummary } from './summary-format.js?v=1.27.7';
import { fnv1a } from './utils.js?v=1.27.7';

export const ACTIVE_THREAD_STATUSES = ['published', 'active', 'ready', 'unclaimed'];
export const isTrackedActive = item => item?.kind === 'thread' ? ACTIVE_THREAD_STATUSES.includes(item.status) : item?.status === 'active';
const clean = value => String(value ?? '').trim();
const validSummary = item => item && item.frozen !== false && item.status !== 'failed';

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

// Only explicit results are replayed. No expiry by age, elapsed deadline or omission.
const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unresolved = /(?:尚未|未能|没有|还没|待确认|待结算|是否|如果|假如|计划|预计|将|准备|打算|可能|才能|即可|完成条件|完成度|完成与否)/u;
export const hasLastingResult = item => item.kind === 'state' && item.lifetime === 'permanent'
    || /(?:永久|不可逆|终身|身份|股权|股份|通行权|解锁|技能|能力|控制度|韧性|偏执值|执念值|承诺|权限|关系|伤残|债务)/u.test(item.value);

function summaryResultText(summary) {
    const parsed = parseStructuredSummary(summary.raw);
    return [summary.event || parsed?.event, summary.state || parsed?.state].filter(Boolean).join('\n');
}

function explicitSummaryResult(item, summary, peers, resultText) {
    if (!isTrackedActive(item) || item.kind === 'state' && item.lifetime !== 'temporary' || item.manual || !validSummary(summary) || summary.floor < item.sourceFloor) return null;
    const text = resultText ?? summaryResultText(summary);
    const clauses = text.split(/(?<=[。；;\n])/u);
    const key = item.kind === 'thread' ? threadKey(item.key) : item.key.replace(/^(?:明早|明日|今日|今晚|当前)/u, '').replace(/计划$/u, '');
    if (!key || key.length < 2) return null;
    const named = escapePattern(key);
    for (const clause of clauses) {
        // An unnamed result is unsafe when two people track the same task.
        const holders = peers.filter(peer => peer.kind === item.kind && subjectKey(peer) === subjectKey(item));
        if (!clause.includes(item.entity) && (holders.some(peer => peer.entity !== item.entity)
            || ![text, summary.characters || ''].some(value => value.includes(item.entity)))) continue;
        const title = `(?:【|「|“|"|‘)?${named}(?:】|」|”|"|’)?`;
        if (holders.some(peer => peer.entity !== item.entity)
            && !new RegExp(`${escapePattern(item.entity)}(?:的)?(?:已|已经)?(?:完成|结算)?(?:任务)?${title}`, 'u').test(clause)) continue;
        const planComplete = item.kind === 'state' && item.category === 'plan'
            && new RegExp(`${escapePattern(item.entity)}[^。；;\\n]*已完成[^。；;\\n]*${named}`, 'u').test(clause);
        const completed = new RegExp(`(?:${title}(?:任务)?(?:已|已经)?(?:完成|结算|兑现|执行完毕)|(?:结算|完成)(?:了)?(?:任务)?${title})`, 'u');
        if (!(planComplete || completed.test(clause)) || unresolved.test(clause)) continue;
        return { ...item, status: item.kind === 'thread' ? 'completed' : 'expired', value: clause.trim(), evidence: clause.trim(), derived: true };
    }
    return null;
}

export function stateSummaryResults(store, throughFloor) {
    const known = projectActiveState(store, throughFloor);
    const keys = known.map(item => item.kind === 'thread' ? threadKey(item.key)
        : item.key.replace(/^(?:明早|明日|今日|今晚|当前)/u, '').replace(/计划$/u, ''));
    return Object.values(store.summaries ?? {}).filter(summary => validSummary(summary) && summary.floor <= throughFloor
        && keys.some(key => key && summaryResultText(summary).includes(key)))
        .sort((a, b) => a.floor - b.floor).map(summary => `[第${summary.floor}层]\n${summaryResultText(summary)}`).join('\n\n') || '无';
}

// Existing CP generation can reconcile semantic changes in its SAME request.
// Persist the evidence rows inside the new CP content; validate on every replay.
// No mutation of Summary, no stateOverrides write and no new model request.
function checkpointResolutions(checkpoint, summaries, known) {
    const text = String(checkpoint.content ?? '').match(/(?:^|\n)\[STATE_RESOLUTIONS\]\s*\n([\s\S]*?)(?=\n\[[^\]\n]+\]|$)/u)?.[1];
    if (!text) return [];
    const source = summaries.filter(row => validSummary(row) && row.floor <= checkpoint.endFloor).map(summaryResultText).join('\n');
    return parseStateChanges(text, source, known, { advanced: true }).filter(row => {
        const old = known.find(item => item.id === row.id);
        return old && !old.manual && summaries.some(summary => validSummary(summary) && summary.floor >= old.sourceFloor
            && summary.floor <= checkpoint.endFloor && summaryResultText(summary).includes(row.evidence)) && (row.status === 'expired' || row.kind === 'thread' && !isTrackedActive(row)
            || row.status === 'active');
    });
}

export function projectActiveState(store, throughFloor = Infinity) {
    const records = new Map();
    const replay = (change, source) => {
        if (!change?.id || !['thread', 'state'].includes(change.kind)) return;
        if (change.kind === 'state' && !change.manual && change.status === 'active' && change.lifetime === 'temporary'
            && change.category === 'history' && /^(?:已成功开箱|已实际抵达|已抵达|已完成|已兑现|已执行完毕)/u.test(change.value)
            && !unresolved.test(change.value)) change = { ...change, status: 'expired', derived: true };
        if (change.kind === 'thread' && change.status === 'completed' && change.acquisition === 'pending'
            && /(?:已完成并领取|已领取奖励|奖励[^。；;]*(?:已发放|已到账)|(?:积分|命运点)[^。；;]*到账)/u.test(change.value)
            && !/(?:奖励[^。；;]*(?:未领取|尚未|待领取))/u.test(change.value)) change = { ...change, acquisition: 'obtained' };
        const recordKey = stateId(change);
        const old = records.get(recordKey);
        // A frozen Long may retain an explicit settlement absent from the
        // Summary records. Use its explicit structured result only as
        // a fallback, preserving a real Summary result and manual correction.
        if (source.aggregate && old && !old.needsReview && (old.manual || !isTrackedActive(old))) return;
        if (!change.manual && old && !old.needsReview) {
            if (source.needsReview) return;
            if (old.kind === 'thread' && (old.status === 'completed' && change.status !== 'completed'
                || !isTrackedActive(old) && isTrackedActive(change))) return;
        }
        const history = old ? [...old.history, { key: old.key, value: old.value, status: old.status, condition: old.condition, acquisition: old.acquisition, sourceId: old.sourceId, sourceFloor: old.sourceFloor }] : [];
        records.set(recordKey, { ...old, ...change, manual: Boolean(change.manual), id: old?.id ?? change.id, ...source, history, originSourceId: change.manual ? change.sourceId : source.aggregate ? source.sourceId : old?.originSourceId ?? source.sourceId,
            condition: change.condition || old?.condition || '', actors: change.actors?.length ? change.actors : old?.actors ?? [] });
    };
    const events = [];
    const summaries = Object.values(store.summaries ?? {}).filter(item => item.floor <= throughFloor);
    for (const summary of summaries) {
        for (const change of summary.stateChanges ?? []) events.push({ change, floor: summary.floor, sequence: 0, source: {
            sourceId: summary.messageId, sourceFloor: summary.floor, sourceFingerprint: summary.sourceFingerprint,
            needsReview: !validSummary(summary),
        } });
    }
    for (const override of Object.values(store.stateOverrides ?? {}).sort((a, b) => a.sourceFloor - b.sourceFloor || a.sequence - b.sequence)) {
        if (override.sourceFloor > throughFloor) continue;
        events.push({ change: override, floor: override.sourceFloor, sequence: override.sequence || 1,
            source: { needsReview: false } });
    }
    for (const memory of store.longMemories ?? []) {
        if (!validSummary(memory) || !['frozen', 'manual-edited', 'stale', 'orphaned'].includes(memory.status ?? 'frozen')
            || !(memory.endFloor <= throughFloor)) continue;
        for (const line of String(memory.continuityState ?? '').split('\n')) {
            const match = line.match(/^\s*-\s*已结束\s+([^·\n]+)\s·\s((?:(?:新手|突发)?任务\s*[:：]\s*)?[^：:\n]+)[：:]\s*(.+)\s\((completed|failed|cancelled)，(?:仅作)?历史结果\)\s*$/u);
            if (!match) continue;
            const [, entity, key, value, status] = match;
            const change = { kind: 'thread', entity: entity.trim(), key: key.trim(), value: value.trim(), status, evidence: line.trim() };
            change.id = stateId(change);
            events.push({ change, floor: memory.endFloor, sequence: 0, source: { sourceId: memory.id, sourceFloor: memory.endFloor, needsReview: false, aggregate: true } });
        }
    }
    for (const summary of summaries.filter(validSummary)) events.push({ summary, floor: summary.floor, sequence: 0.5 });
    for (const checkpoint of store.checkpoints ?? []) {
        if (!validSummary(checkpoint) || checkpoint.endFloor > throughFloor) continue;
        events.push({ checkpoint, floor: checkpoint.endFloor, sequence: 0.75 });
    }
    events.sort((a, b) => a.floor - b.floor || a.sequence - b.sequence);
    for (const event of events) {
        if (event.summary) {
            const known = [...records.values()];
            const resultText = summaryResultText(event.summary);
            for (const item of known) {
                const change = explicitSummaryResult(item, event.summary, known, resultText);
                if (change) replay(change, { sourceId: event.summary.messageId, sourceFloor: event.floor, needsReview: false });
            }
        } else if (event.checkpoint) {
            for (const change of checkpointResolutions(event.checkpoint, summaries, [...records.values()]))
                replay(change, { sourceId: event.checkpoint.id, sourceFloor: event.floor, needsReview: false });
        } else replay(event.change, event.source);
    }
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

// Exact complete state entries only. A shared subject or a substring of a
// value cannot justify deleting a compound fact, secret or historical cause.
export function matchesTrackedValue(text, item, value, key = item.key) {
    if (!value) return false;
    const body = String(text ?? '').replace(/^\s*[-*•]\s*/, '').trim();
    const keys = [...new Set([key || item.key, subjectKey({ ...item, key: key || item.key })])];
    const conditions = [...new Set(['', item.condition, ...(item.history ?? []).map(row => row.condition)].filter(value => value !== undefined))];
    const suffixes = conditions.flatMap(condition => ['', '（尚未领取）'].map(pending => `${pending}${condition ? `；条件：${condition}` : ''}`));
    return keys.some(name => [`${item.entity} · ${name}：${value}`, `【${item.entity}｜${name}】${value}`,
        `${item.entity}：${name}：${value}`].some(rendered => suffixes.some(suffix => body === rendered + suffix)));
}

export function isAtomicTrackedEntry(text, item) {
    if (!item.evidence || !matchesTrackedFact({ text }, item)) return false;
    const body = String(text).replace(/^\s*[-*•]\s*/, '').trim();
    // A complete, explicitly named task field is its current progress. Numeric
    // fields have a closed grammar; prose with independent consequences stays.
    if (/^已结束\s/u.test(body)) return false;
    const value = body.match(/[：:】]([^：:】]+)$/u)?.[1]?.trim();
    if (!value) return false;
    return item.kind === 'thread' ? !/[，,；;。\n]/u.test(value)
        : /^(?:Lv\.?\s*\d+|\d+(?:\.\d+)?(?:点|级|枚|个|金币|银币|%|％)?)$/i.test(value);
}

export function reconcileTrackedCheckpoint(content, store, throughFloor, startFloor = 1) {
    let result = String(content);
    const rows = projectActiveState(store, throughFloor).filter(item => !item.needsReview);
    const sectionFor = item => item.kind === 'thread' ? 'Open Threads' : item.category === 'knowledge' ? 'Secrets & Knowledge'
        : item.category === 'identity' ? 'Characters' : item.category === 'history' ? 'Story So Far' : 'Current State';
    // Reconcile only current-state sections. Historical causes and relationship
    // events in Story So Far must survive a later change of value.
    for (const section of ['Characters', 'Current State', 'Secrets & Knowledge', 'Open Threads', 'Continuity Locks']) {
        if (!rows.length) continue;
        const marker = new RegExp(`(^|\\n)\\[${section}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[[^\\]\\n]+\\]|$)`);
        const existing = result.match(marker);
        const retained = (existing?.[2] ?? '').split('\n').filter(line => !rows.some(item =>
            /^\s*-?\s*已结束\s/u.test(line) && matchesTrackedFact({ text: line }, item)
            // A settled task's explicitly named field cannot remain open merely
            // because its old progress also lists conditions or rewards.
            || section === 'Open Threads' && item.kind === 'thread' && !isTrackedActive(item)
                && matchesTrackedFact({ text: line }, item)
            || isAtomicTrackedEntry(line, item) && (item.sourceFloor >= throughFloor || !isTrackedActive(item))
            || [...item.history, item].some(old => matchesTrackedValue(line, item, old.value, old.key))));
        // Model prose may carry newer Summary evidence; don't overwrite it with
        // an older tracked value. Exact flat fields are replaced once, observers stay separate.
        const lines = rows.filter(item => sectionFor(item) === section && isTrackedActive(item)
            && !(item.sourceFloor < startFloor && retained.some(line => matchesTrackedFact({ text: line }, item))))
            .map(item => `- ${item.entity} · ${item.key}：${item.value}${item.acquisition === 'pending' ? '（尚未领取）' : ''}${item.condition ? `；条件：${item.condition}` : ''}`);
        if (section === 'Current State') lines.push(...rows.filter(item => item.kind === 'thread' && !isTrackedActive(item) && item.acquisition === 'pending')
            .map(item => `- ${item.entity} · ${item.key}奖励：${item.value}（任务已结束，奖励尚未领取）`));
        if (!existing && !lines.length) continue;
        const replacement = `[${section}]\n${[...retained.filter(line => line.trim() && !/^无[。.]?$/.test(line.trim())), ...lines].join('\n') || '无'}`;
        result = existing ? result.replace(marker, `${existing[1]}${replacement}`) : `${result}\n${replacement}`;
    }
    // Keep settlement tombstones in the projection, but never in Open Threads.
    // Ordinary completed actions remain available in their original Summary.
    const historical = rows.filter(item => (item.kind === 'state' && item.category === 'history' && isTrackedActive(item) || !isTrackedActive(item))
        && hasLastingResult(item)).map(item => `- ${item.entity} · ${item.key}：${item.value}${!isTrackedActive(item) ? ` (${item.status}，历史结果)` : ''}`);
    if (historical.length) {
        const marker = /(^|\n)\[Story So Far\]\s*\n([\s\S]*?)(?=\n\[[^\]\n]+\]|$)/u;
        const old = result.match(marker);
        result = old ? result.replace(marker, (_, prefix, body) => `${prefix}[Story So Far]\n${body.trim()}\n${historical.join('\n')}`)
            : `${result}\n[Story So Far]\n${historical.join('\n')}`;
    }
    return deduplicateCheckpoint(result);
}

export function deduplicateCheckpoint(content) {
    // Remove only exact repeated entries within a section. Similar prose may
    // encode different observers or historical facts and must remain intact.
    const seen = new Set();
    const lines = String(content).split('\n');
    return lines.filter((line, index) => {
        if (/^\s*\[[^\]\n]+\]\s*$/.test(line)) { seen.clear(); return true; }
        const key = line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').replace(/\s+/g, ' ').trim();
        if (!key) return true;
        // Identical fields under two different NPC headings are not duplicates.
        // Keep multiline entries with their continuation/context intact too.
        if (/^[^：:]+[：:]$/.test(key)) { seen.clear(); return true; }
        if (lines[index + 1]?.trim() && /^\s+\S/.test(lines[index + 1]) && !/^\s*[-*•]/.test(lines[index + 1])) return true;
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
    const states = projectActiveState(store, throughFloor).filter(item => item.kind === 'state' && !item.needsReview && item.acquisition !== 'pending'
        && (item.lifetime !== 'temporary' || !isTrackedActive(item) && existingFacts.some(fact => fact.status === 'active' && matchesTrackedFact(fact, item)))
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

export const CHECKPOINT_LIFECYCLE_RULES = `
【累积世界状态与退出】
每份 Checkpoint 是可独立理解剧情的完整当前状态，注入将只使用最新一份，不会叠加几十份旧 CP。继承仍有效的重要前因、NPC 身份关系、重大经历、承诺、秘密及逐人认知差；人物不按 user/char 排序。HISTORICAL_FACTS 为历史补全候选，结合明确时间与新证据合并，不把历史写成当前。
CURRENT_TRACKED_STATE 是来源记录投影，不高于 Summary 的明确结果。逐项核对 SUMMARY_RESULTS 与 NEW_SUMMARIES：同人物同事项仅留最新有效值；旧地点、旧情绪、已执行计划、开箱成功等结束动作退出当前栏目；未解决事项、长期身份技能关系秘密不能仅因未提及而退出。Current State、Story So Far、Open Threads 分开，已结算任务不进入 Open Threads；永久奖励与结果简记一次，不反复抄任务流程。奖励未领不等于任务未完成。不可按字数硬截断。
在本次 CP 输出最后附 [STATE_RESOLUTIONS]，值为 JSON 数组，无需整理则 []。仅对 CURRENT_TRACKED_STATE 中有明确证据的变更输出，字段沿用 Changes（必须复用 id、kind、entity、key，含 value、status、category、lifetime、actors、evidence、confirmed:true）。临时 state 已完成/失效用 expired，被新状态替代可用 active 并写最新值；thread 完成/失败/取消用 completed/failed/cancelled。evidence 必须逐字复制 SUMMARY_RESULTS 或 NEW_SUMMARIES 的明确结果连续至少4字，不能以时间流逝、未出现或猜测为证据。普通已结束动作不写进 Long 或每份 CP；只有具有长期影响的结果写入历史。`;
