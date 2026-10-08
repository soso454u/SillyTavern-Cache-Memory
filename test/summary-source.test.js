import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSummarySource, extractTagBlocks, parseSummarySourceTags } from '../src/summary-source.js';

test('default summary filtering prefers every non-empty content block over context', () => {
    const source = '<context>备用</context>\n<CONTENT type="story">第一段</CONTENT>\n<content>\n第二段\n</content>';
    assert.deepEqual(extractSummarySource(source), { text: '第一段\n第二段', source: 'content' });
    assert.deepEqual(extractSummarySource('<context>\n备用正文\n</context>'), { text: '备用正文', source: 'context' });
});

test('custom tags are ordered, safely escaped and fall back to the untouched full message', () => {
    assert.deepEqual(parseSummarySourceTags('story, content\nSTORY'), ['story', 'content']);
    assert.deepEqual(extractSummarySource('<content>后备</content><story>正文</story>', { summaryFilterMode: 'custom', summaryFilterTags: 'story, content' }), { text: '正文', source: 'custom:story' });
    assert.deepEqual(extractTagBlocks('<a+b>不执行正则</a+b>', 'a+b'), ['不执行正则']);
    const full = '<content>保留标签</content>';
    assert.deepEqual(extractSummarySource(full, { summaryFilterMode: 'full' }), { text: full, source: 'full' });
    assert.deepEqual(extractSummarySource(full, { summaryFilterMode: 'custom', summaryFilterTags: 'missing' }), { text: full, source: 'full' });
});
