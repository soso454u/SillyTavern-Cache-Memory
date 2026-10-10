import { withGlobalPrompt } from './defaults.js?v=1.24.0';
import { STATE_EXTRACTION_RULES, STATE_AGGREGATION_RULES } from './active-state.js?v=1.24.0';

// Complete ensemble defaults already contain the extraction/aggregation contract.
// Custom Summary templates without Changes still receive the original parser contract.
export function generationPrompt(settings, stage) {
    const prompt = settings.prompts[stage];
    const completeEnsemble = settings.summaryMode === 'ensemble'
        && (stage !== 'summary' || /\[Changes\]/i.test(prompt));
    const rules = settings.activeStateEnabled && !completeEnsemble
        ? stage === 'summary' ? STATE_EXTRACTION_RULES : STATE_AGGREGATION_RULES : '';
    return withGlobalPrompt(settings, prompt + rules);
}
