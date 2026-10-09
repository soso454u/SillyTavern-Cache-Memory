// Local estimate, not a claim about an upstream tokenizer or cache billing.
export function estimateMemoryTokens(value) {
    let tokens = 0, ascii = 0;
    for (const character of String(value ?? '')) {
        if (character.codePointAt(0) <= 0x7f) ascii++;
        else { tokens += Math.ceil(ascii / 4) + 1; ascii = 0; }
    }
    return tokens + Math.ceil(ascii / 4);
}

export function budgetFrozenBlocks(blocks, limit) {
    const budget = Math.max(128, Number(limit) || 2800) - 100; // Tags and instructions.
    if (estimateMemoryTokens(blocks.map(block => block.text).join('\n\n')) <= budget) return { blocks, omitted: 0, clipped: 0 };
    // Only called at an already permitted publish boundary. Stored memories stay intact.
    const keep = blocks.filter(block => block.type === 'keep');
    const latest = blocks.filter(block => block.type === 'checkpoint').sort((a, b) => b.endFloor - a.endFloor);
    const longs = blocks.filter(block => block.type === 'long').sort((a, b) => b.endFloor - a.endFloor);
    const order = [...latest.slice(0, 1), ...keep, ...longs, ...latest.slice(1)];
    let remaining = budget, clipped = 0;
    const selected = new Map();
    for (const block of order) {
        if (remaining < 40) continue;
        const cost = estimateMemoryTokens(block.text) + 2;
        if (cost <= remaining) { selected.set(block.id, block); remaining -= cost; continue; }
        // Whole lines where possible, bounded prefix for a single oversized line.
        let text = '';
        for (const line of block.text.split('\n')) {
            if (estimateMemoryTokens(`${text}${line}\n…`) > remaining - 2) break;
            text += `${line}\n`;
        }
        if (!text.trim() || text.trim() === block.text.split('\n')[0]) {
            text = '';
            for (const char of block.text) { if (estimateMemoryTokens(`${text}${char}…`) > remaining - 4) break; text += char; }
        }
        if (text.trim()) { selected.set(block.id, { ...block, text: `${text.trimEnd()}…` }); remaining -= estimateMemoryTokens(text) + 4; clipped++; }
    }
    return { blocks: blocks.filter(block => selected.has(block.id)).map(block => selected.get(block.id)), omitted: blocks.length - selected.size, clipped };
}
