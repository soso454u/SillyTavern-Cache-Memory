import { CHARACTER_TABLES, normalizeCharacterTables } from './character-tables.js?v=1.27.3';
import { withGlobalPrompt, NORMAL_SUMMARY_LENGTH_RULES } from './defaults.js?v=1.27.3';
import { STATE_EXTRACTION_RULES } from './active-state.js?v=1.27.3';

export const NORMAL_STATE_EXTRACTION_RULES = STATE_EXTRACTION_RULES
    .replace('category(skill/attribute/reward/item/identity/knowledge/effect)',
        'category(skill/attribute/reward/item/identity/relationship/personality/preference/history/knowledge/effect)')
    + `
普通模式只提取值得跨场景继承或需要明确结算的变化；重要性由实际剧情与持续后果决定，user／char 与 NPC 使用同一证据门槛。重要人物的身份、明确性格、关系、经历、立场和各自认知差有新证据时可记录，但不要展开整张人物档案。
Changes 不是 State 的逐项抄录：情绪、姿势、临时衣着、普通物品位置和无后续作用的生活动作留在 Summary，不新建追踪项；若明确构成任务条件、持续伤势、重要线索或行动限制则保留。性格／偏好必须有明确长期特征的直接陈述，不能由单次行为推断。跨场景有效的身份、性格、关系、经历与认知差标 permanent，不能因人物暂时退场就标 temporary；temporary 用于阶段性状态；结束条件仅在正文明确时填写，否则留空，禁止自造“等待后续再次确认”作为失效条件。与上下文相同的状态不再次输出，未知不猜。只追踪明确未完成且有后续影响的任务、承诺、重要计划、伏笔、冲突与秘密；已结算任务只更新完成结果和重要奖励，不重建活跃事项。
正文明确出现任务完成／失败／取消／结算时，[Changes] 必须同步输出对应 kind:thread 的状态变化：完成用 completed，失败用 failed，取消用 cancelled；复用 CURRENT_TRACKED_STATE 中同一任务的 id、entity、key，没有旧记录也可记录明确完成。不能只在 Event 写完成、只新建“奖励发放”状态而遗漏任务闭环；证据直接摘录本层原文连续至少4字，不拼接、不引用旧摘要。奖励明确发放才标 obtained，否则 pending；不把奖励增量当属性总值。收尾自查 Open、Changes 与正文完成结果一致。`;

// A single short story contract. Optional table deltas share the same existing
// Summary response and are parsed into stateChanges, never shown as story prose.
export function generationPrompt(settings, stage) {
    const prompt = settings.prompts[stage] ?? '';
    const selected = CHARACTER_TABLES.filter(table => normalizeCharacterTables(settings.characterTables)[table.key]);
    const tableRules = ['advanced', 'ensemble'].includes(settings.summaryMode) && settings.activeStateEnabled && selected.length
        ? `\n【角色表格，仅更新已勾选项目】\n${selected.map(table => `${table.label}：${table.description}；${({ characters: 'state 类别 identity/skill/attribute/item/effect/history/personality/preference', relationships: 'state 类别 relationship', knowledge: 'state 类别 knowledge，entity 必须是知情者', tasks: '任务或承诺用 kind:thread，计划可用 state 类别 plan' })[table.key]}`).join('\n')}
只维护这些表，其他表不要输出。${settings.prompts.state ?? ''}
${STATE_EXTRACTION_RULES.replace('沿用 Summary 的 Open 和 State 叙述，在最后可附 [Changes]，值为 JSON 数组，无变化写 []。', '在简短事件之后附 [Changes]，值为 JSON 数组，无变化写 []。不另写 Open 或 State 叙述。')}
[Changes] 只写本层新确认或明确变化的字段；不回显整张表，不在 Event 重复表格，不另写 State/Open。角色知识以知情者为 entity。正文中的关键动作、原话与结果仍需在 Event 完整表达，不能用表格代替故事。`
        : '';
    if (stage === 'state') return withGlobalPrompt(settings, tableRules || '角色表格未开启。');
    if (stage === 'summary') return withGlobalPrompt(settings,
        prompt + (prompt.includes(NORMAL_SUMMARY_LENGTH_RULES) ? '' : `\n${NORMAL_SUMMARY_LENGTH_RULES}`) + tableRules);
    // Narrative aggregates never expand into the optional role tables.
    return withGlobalPrompt(settings, prompt);
}
