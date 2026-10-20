import { withGlobalPrompt, NORMAL_SUMMARY_LENGTH_RULES } from './defaults.js?v=1.24.16';
import { STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES } from './active-state.js?v=1.24.14';

export const NORMAL_STATE_EXTRACTION_RULES = STATE_EXTRACTION_RULES
    .replace('category(skill/attribute/reward/item/identity/knowledge/effect)',
        'category(skill/attribute/reward/item/identity/relationship/personality/preference/history/knowledge/effect)')
    + `
普通模式只提取值得跨场景继承或需要明确结算的变化；重要性由实际剧情与持续后果决定，user／char 与 NPC 使用同一证据门槛。重要人物的身份、明确性格、关系、经历、立场和各自认知差有新证据时可记录，但不要展开整张人物档案。
Changes 不是 State 的逐项抄录：情绪、姿势、临时衣着、普通物品位置和无后续作用的生活动作留在 Summary，不新建追踪项；若明确构成任务条件、持续伤势、重要线索或行动限制则保留。性格／偏好必须有明确长期特征的直接陈述，不能由单次行为推断。跨场景有效的身份、性格、关系、经历与认知差标 permanent，不能因人物暂时退场就标 temporary；temporary 用于阶段性状态；结束条件仅在正文明确时填写，否则留空，禁止自造“等待后续再次确认”作为失效条件。与上下文相同的状态不再次输出，未知不猜。只追踪明确未完成且有后续影响的任务、承诺、重要计划、伏笔、冲突与秘密；已结算任务只更新完成结果和重要奖励，不重建活跃事项。`;

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
    return withGlobalPrompt(settings, prompt + budget + rules);
}
