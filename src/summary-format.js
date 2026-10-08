export const SUMMARY_SECTION_NAMES = Object.freeze(['Title', 'Characters', 'Event', 'State', 'Open', 'Quote', 'KEEP']);

const SUMMARY_MARKER = /^\s*\[SUMMARY\]\s*$/gim;
const SECTION_MARKER = /^\s*\[(Title|Characters|Event|State|Open|Quote|KEEP)\]\s*$/gim;

export function selectFinalSummaryBlock(value) {
    const text = String(value ?? '').trim();
    const markers = [...text.matchAll(SUMMARY_MARKER)];
    if (!markers.length) return '';
    for (let index = markers.length - 1; index >= 0; index -= 1) {
        const start = markers[index].index;
        const end = markers[index + 1]?.index ?? text.length;
        const candidate = text.slice(start, end).trim();
        if ([...candidate.matchAll(SECTION_MARKER)].some(match => match[1].toLowerCase() === 'event')) return candidate;
    }
    return '';
}

export function parseStructuredSummary(value) {
    const raw = selectFinalSummaryBlock(value);
    if (!raw) return null;
    const sections = Object.fromEntries(SUMMARY_SECTION_NAMES.map(name => [name.toLowerCase(), '']));
    const markers = [...raw.matchAll(SECTION_MARKER)];
    for (let index = 0; index < markers.length; index += 1) {
        const name = markers[index][1].toLowerCase();
        const start = markers[index].index + markers[index][0].length;
        const end = markers[index + 1]?.index ?? raw.length;
        sections[name] = raw.slice(start, end).trim();
    }
    return { ...sections, raw, format: 'structured' };
}

export function buildStructuredSummary(fields = {}) {
    return ['[SUMMARY]', ...SUMMARY_SECTION_NAMES.flatMap(name => [`[${name}]`, String(fields[name.toLowerCase()] ?? '').trim() || '无'])].join('\n');
}

export function stripStructuredSections(value, names) {
    const blocked = new Set(names.map(name => String(name).toLowerCase()));
    const text = String(value ?? '');
    const marker = /^\s*\[([^\]\n]+)\]\s*$/gim;
    const matches = [...text.matchAll(marker)];
    if (!matches.length) return text.trim();
    const chunks = [];
    if (matches[0].index > 0) chunks.push(text.slice(0, matches[0].index).trim());
    for (let index = 0; index < matches.length; index += 1) {
        const name = matches[index][1].trim().toLowerCase();
        const start = matches[index].index;
        const end = matches[index + 1]?.index ?? text.length;
        if (!blocked.has(name)) chunks.push(text.slice(start, end).trim());
    }
    return chunks.filter(Boolean).join('\n').trim();
}
