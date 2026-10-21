import { withGlobalPrompt, NORMAL_SUMMARY_LENGTH_RULES, NORMAL_CONTINUITY_RULES } from './defaults.js?v=1.24.20';
import { STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES, CHECKPOINT_LIFECYCLE_RULES } from './active-state.js?v=1.24.20';

export const NORMAL_STATE_EXTRACTION_RULES = STATE_EXTRACTION_RULES
    .replace('category(skill/attribute/reward/item/identity/knowledge/effect)',
        'category(skill/attribute/reward/item/identity/relationship/personality/preference/history/knowledge/effect)')
    + `
普通模式只提取值得跨场景继承或需要明确结算的变化；重要性由实际剧情与持续后果决定，user／char 与 NPC 使用同一证据门槛。重要人物的身份、明确性格、关系、经历、立场和各自认知差有新证据时可记录，但不要展开整张人物档案。
Changes 不是 State 的逐项抄录：情绪、姿势、临时衣着、普通物品位置和无后续作用的生活动作留在 Summary，不新建追踪项；若明确构成任务条件、持续伤势、重要线索或行动限制则保留。性格／偏好必须有明确长期特征的直接陈述，不能由单次行为推断。跨场景有效的身份、性格、关系、经历与认知差标 permanent，不能因人物暂时退场就标 temporary；temporary 用于阶段性状态；结束条件仅在正文明确时填写，否则留空，禁止自造“等待后续再次确认”作为失效条件。与上下文相同的状态不再次输出，未知不猜。只追踪明确未完成且有后续影响的任务、承诺、重要计划、伏笔、冲突与秘密；已结算任务只更新完成结果和重要奖励，不重建活跃事项。
正文明确出现任务完成／失败／取消／结算时，[Changes] 必须同步输出对应 kind:thread 的状态变化：完成用 completed，失败用 failed，取消用 cancelled；复用 CURRENT_TRACKED_STATE 中同一任务的 id、entity、key，没有旧记录也可记录明确完成。不能只在 Event 写完成、只新建“奖励发放”状态而遗漏任务闭环；证据直接摘录本层原文连续至少4字，不拼接、不引用旧摘要。奖励明确发放才标 obtained，否则 pending；不把奖励增量当属性总值。收尾自查 Open、Changes 与正文完成结果一致。`;

// Complete ensemble defaults already contain the extraction/aggregation contract.
// Custom Summary templates without Changes still receive the original parser contract.
export function generationPrompt(settings, stage) {
    const prompt = settings.prompts[stage];
    const completeEnsemble = settings.summaryMode === 'ensemble'
        && (stage !== 'summary' || /\[Changes\]/i.test(prompt));
    const extractionRules = settings.summaryMode === 'ensemble' ? STATE_EXTRACTION_RULES : NORMAL_STATE_EXTRACTION_RULES;
    const rules = settings.activeStateEnabled && !completeEnsemble
        ? stage === 'summary' ? extractionRules : STATE_AGGREGATION_RULES : '';
    const budget = stage === 'summary' && settings.summaryMode !== 'ensemble' && !prompt.includes(NORMAL_SUMMARY_LENGTH_RULES)
        ? `\n${NORMAL_SUMMARY_LENGTH_RULES}` : '';
    const continuity = settings.summaryMode !== 'ensemble' && !prompt.includes(NORMAL_CONTINUITY_RULES)
        ? `\n${NORMAL_CONTINUITY_RULES}` : '';
    const lifecycle = stage === 'checkpoint' ? CHECKPOINT_LIFECYCLE_RULES : '';
    // Keep custom prompts working; ensure CP/Long output still contains plot.
    const story = stage === 'checkpoint' && !/\[Stage Story\]/i.test(prompt)
        ? '\n[Stage Story] 同次生成中附带本次五层新增剧情的起因、经过和结果；最新状态另行继承，不能遗漏重要 NPC、伤势、秘密、认知差及未完成事项。'
        : stage === 'longMemory' && !/\[STORY_ARC\]/i.test(prompt)
            ? '\n[STORY_ARC] 同次生成中附带本次五十层按时序发展的历史剧情，含重要转折与人物行动；不要只罗列长期事实。'
            : '';
    return withGlobalPrompt(settings, prompt + continuity + budget + rules + lifecycle + story);
}
