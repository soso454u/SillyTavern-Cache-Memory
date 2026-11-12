function cleanValue(value) {
    const cleaned = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .replace(/^[\s:：|｜·—-]+|[\s|｜]+$/g, '')
        .trim();
    return /^(?:无|未知|未提供|不详|none|null|n\/a)[。.]?$/i.test(cleaned) ? '' : cleaned;
}

function lastTaggedValue(text, names) {
    const pattern = new RegExp(`<\\s*(?:${names.join('|')})(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*(?:${names.join('|')})\\s*>`, 'gi');
    return [...String(text ?? '').matchAll(pattern)].map(match => cleanValue(match[1])).filter(Boolean).at(-1) ?? '';
}

function plainText(value) {
    return String(value ?? '')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\/?(?:p|div|section|article|li|tr|h[1-6])(?:\s[^>]*)?>/gi, '\n')
        .replace(/<\/[^>]+>/g, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function lastLabeledValue(text, labels) {
    const alternatives = labels.join('|');
    const pattern = new RegExp(`(?:^|[\\n\\r|｜;；【\\[])[ \\t]*(?:${alternatives})[ \\t]*[:：][ \\t]*([^\\n\\r|｜;；】\\]]{1,100})`, 'gim');
    return [...plainText(text).matchAll(pattern)].map(match => cleanValue(match[1])).filter(Boolean).at(-1) ?? '';
}

function lastBracketValue(text, labels) {
    const pattern = new RegExp(`^\\s*\\[(?:${labels.join('|')})\\]\\s*\\r?\\n\\s*([^\\n\\r]{1,100})`, 'gim');
    return [...plainText(text).matchAll(pattern)].map(match => cleanValue(match[1])).filter(Boolean).at(-1) ?? '';
}

function lastExplicitTime(text) {
    const source = plainText(text);
    const patterns = [
        /(?:\d{4}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日)\s*周[一二三四五六日天]\s*(?:上午|下午|晚上|凌晨|清晨|中午|傍晚)?\s*\d{1,2}\s*(?::|：|点)\s*\d{0,2}\s*分?/g,
        /(?:\d{4}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日)\s*(?:上午|下午|晚上|凌晨|清晨|中午|傍晚)?\s*\d{1,2}\s*(?::|：|点)\s*\d{0,2}\s*分?/g,
        /(?:\d{4}\s*[年/.\-]\s*\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\s*周[一二三四五六日天])?/g,
        /(?:上午|下午|晚上|凌晨|清晨|中午|傍晚)?\s*\d{1,2}\s*(?::|：)\s*\d{2}/g,
    ];
    for (const pattern of patterns) {
        const matches = [...source.matchAll(pattern)].map(match => cleanValue(match[0])).filter(Boolean);
        if (matches.length) return matches.at(-1);
    }
    return '';
}

function lastStatusBarLocation(text) {
    const candidates = plainText(text).split(/[\n\r]+/).map(line => line.trim()).filter(Boolean);
    for (const line of candidates.reverse()) {
        const parts = line.split(/[|｜]/);
        if (parts.length < 2 || !lastExplicitTime(parts[0])) continue;
        const location = cleanValue(parts[1])
            .replace(/^(?:剧情地点|故事地点|Scene[ _-]?Location|Location|地点|场所)\s*[:：]\s*/i, '')
            .replace(/^[「『【\[]+|[」』】\]]+$/g, '')
            .trim();
        if (location) return location;
    }
    return '';
}

export function extractStoryMetadata(message) {
    const text = String(message ?? '');
    const storyTime = lastTaggedValue(text, ['storytime', 'story_time', 'story-time', 'datetime', 'date', 'time'])
        || lastBracketValue(text, ['Story[ _-]?Time', '剧情时间', '故事时间', '日期', '时间'])
        || lastLabeledValue(text, ['剧情时间', '故事时间', 'Story[ _-]?Time', '日期', '时间'])
        || lastExplicitTime(text);
    const location = lastTaggedValue(text, ['location', 'place', 'scene_location', 'scene-location'])
        || lastBracketValue(text, ['Scene[ _-]?Location', 'Location', '剧情地点', '故事地点', '地点', '场所'])
        || lastLabeledValue(text, ['剧情地点', '故事地点', 'Scene[ _-]?Location', 'Location', '地点', '场所'])
        || lastStatusBarLocation(text);
    return { storyTime, location };
}

// Character panels and proposed next scenes are separate from the scene
// being summarized. Keep the older header convention for plain messages.
export function summaryTurnMetadata(message, narration, userText) {
    const full = String(message ?? '');
    const ignored = /<(choices|options|prewrite|status|character[-_]status|character[-_]panel)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
    const choices = [...full.matchAll(/<(choices|options)\b[^>]*>[\s\S]*?<\/\1\s*>/giu)].at(-1);
    const cleaned = full.replace(ignored, '');
    const header = (choices ? full.slice(0, choices.index) : full).replace(ignored, '');
    const selected = String(narration ?? '');
    const embedded = [...full.matchAll(/<(content|context)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu)];
    const content = embedded.filter(block => block[1].toLowerCase() === 'content');
    const narrativeBlocks = selected !== full ? [selected] : (content.length ? content : embedded).map(block => block[2]);
    const prose = (narrativeBlocks.join('\n') || header).replace(ignored, '');
    const locations = new Set(narrativeBlocks.map(block => extractStoryMetadata(block.replace(ignored, '')).location).filter(Boolean));
    const user = extractStoryMetadata(String(userText ?? '').replace(ignored, ''));
    const scene = [...header.matchAll(/^\s*\[Scene\]\s*\r?\n\s*([^\n\r<]+)/gim)].at(-1)?.[1] ?? '';
    const explicitScene = lastTaggedValue(cleaned, ['scene_location', 'scene-location'])
        || lastBracketValue(cleaned, ['Scene[ _-]?Location', '剧情地点', '故事地点'])
        || lastLabeledValue(cleaned, ['Scene[ _-]?Location', '剧情地点', '故事地点']);
    return {
        storyTime: lastExplicitTime(scene.split(/[|｜]/u)[0])
            || extractStoryMetadata(full.replace(/<(choices|options|prewrite)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')).storyTime || user.storyTime,
        location: locations.size > 1 ? '' : extractStoryMetadata(prose).location || explicitScene || lastStatusBarLocation(scene)
            || extractStoryMetadata(header).location || user.location,
        locationSource: prose,
    };
}

export function locationFromNarration(value, narration) {
    const candidate = cleanValue(value);
    const text = plainText(narration).replace(/\s+/gu, '');
    return candidate.length >= 2 && candidate.length <= 100 && text.includes(candidate.replace(/\s+/gu, '')) ? candidate : '';
}

export function summarySourceWithMetadata(source, metadata) {
    const storyTime = cleanValue(metadata?.storyTime);
    const location = cleanValue(metadata?.location);
    if (!storyTime && !location) return String(source ?? '');
    return `[SOURCE_METADATA]\n[StoryTime]\n${storyTime || '无'}\n[Location]\n${location || '无'}\n\n[SUMMARY_SOURCE]\n${String(source ?? '')}`;
}

export function storyMetadataRange(items) {
    const sorted = [...(items ?? [])].sort((left, right) => (Number(left.floor ?? left.startFloor) || 0) - (Number(right.floor ?? right.startFloor) || 0));
    const times = sorted.map(item => cleanValue(item.storyTime || item.storyStartTime || item.storyEndTime)).filter(Boolean);
    const endTimes = sorted.map(item => cleanValue(item.storyEndTime || item.storyTime || item.storyStartTime)).filter(Boolean);
    const locations = sorted.map(item => cleanValue(item.location || item.currentLocation)).filter(Boolean);
    return {
        storyStartTime: times[0] ?? '',
        storyEndTime: endTimes.at(-1) ?? '',
        currentStoryTime: endTimes.at(-1) ?? '',
        currentLocation: locations.at(-1) ?? '',
    };
}

export function storyTimeForEvidence(summaries, evidence) {
    const needle = String(evidence ?? '').trim();
    if (!needle) return '';
    return [...(summaries ?? [])].reverse().find(item => String(item.raw ?? item.event ?? '').includes(needle))?.storyTime ?? '';
}
