// Preferences only. Records keep their existing stateChanges / stateOverrides
// storage and evidence history; disabling a table never deletes its records.
export const CHARACTER_TABLES = Object.freeze([
    { key: 'characters', label: '人物档案', description: '身份、能力、重要经历与持续状态' },
    { key: 'relationships', label: '人物关系', description: '明确关系、边界与变化' },
    { key: 'knowledge', label: '秘密与认知', description: '逐人区分已知、未知、误信与隐瞒' },
    { key: 'tasks', label: '任务与承诺', description: '未完成条件、奖励与明确结算' },
]);
export function normalizeCharacterTables(value = {}) {
    return Object.fromEntries(CHARACTER_TABLES.map(table => [table.key,
        typeof value?.[table.key] === 'boolean' ? value[table.key] : table.key === 'characters']));
}
export function tableForRecord(item) {
    if (item.kind === 'thread' || ['task', 'plan', 'promise'].includes(item.category)) return 'tasks';
    if (item.category === 'knowledge') return 'knowledge';
    if (item.category === 'relationship') return 'relationships';
    return 'characters';
}
export function selectedTableRecords(rows, settings) {
    const selected = normalizeCharacterTables(settings.characterTables);
    return rows.filter(item => selected[tableForRecord(item)]);
}
export function characterTablesEnabled(store, settings) {
    return ['advanced', 'ensemble'].includes(store?.summaryMode) && settings.activeStateEnabled !== false;
}
