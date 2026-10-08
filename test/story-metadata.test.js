import test from 'node:test';
import assert from 'node:assert/strict';

import { extractStoryMetadata, storyMetadataRange, summarySourceWithMetadata } from '../src/story-metadata.js';

test('extracts only explicit story metadata from the complete assistant message', () => {
    const message = '<context>隐藏资料</context><div>剧情时间：2025/01/02 10:35｜地点：湖畔酒店</div><content>姜梨走进大堂。</content>';
    assert.deepEqual(extractStoryMetadata(message), { storyTime: '2025/01/02 10:35', location: '湖畔酒店' });
    assert.deepEqual(extractStoryMetadata('[StoryTime]\n2025/01/02 12:24\n[Location]\n酒店露台'), { storyTime: '2025/01/02 12:24', location: '酒店露台' });
    assert.deepEqual(extractStoryMetadata('<content>2025/01/02 10:35，姜梨走进大堂。</content>'), { storyTime: '2025/01/02 10:35', location: '' });
    assert.deepEqual(extractStoryMetadata('<content>很多年前，她可能去过某处。</content>'), { storyTime: '', location: '' });
});

test('filtered summary source receives extracted metadata without exposing the complete message', () => {
    const input = summarySourceWithMetadata('只保留的正文', { storyTime: '2025/01/02 10:35', location: '湖畔酒店' });
    assert.match(input, /^\[SOURCE_METADATA\]/);
    assert.match(input, /\[SUMMARY_SOURCE\]\n只保留的正文$/);
    assert.doesNotMatch(input, /隐藏资料/);
    assert.equal(summarySourceWithMetadata('原正文', { storyTime: '', location: '' }), '原正文');
});

test('story ranges use the first and last explicit values while leaving missing legacy data empty', () => {
    assert.deepEqual(storyMetadataRange([{ floor: 1 }, { floor: 2 }]), {
        storyStartTime: '', storyEndTime: '', currentStoryTime: '', currentLocation: '',
    });
    assert.deepEqual(storyMetadataRange([
        { floor: 3, storyTime: '12:24', location: '露台' },
        { floor: 1, storyTime: '09:16', location: '酒店' },
        { floor: 2, storyTime: '', location: '' },
    ]), { storyStartTime: '09:16', storyEndTime: '12:24', currentStoryTime: '12:24', currentLocation: '露台' });
});
