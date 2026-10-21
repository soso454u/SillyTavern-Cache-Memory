import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory-store.js';
import { normalizeSettings } from '../src/defaults.js';
import { MemorySummarizer } from '../src/summarizer.js';
import { getAssistantMessages } from '../src/utils.js';
import { getOpeningSource, publishedOpeningCoverage, stageStartLabel } from '../src/opening-source.js';
import { refreshSnapshot } from '../src/cache-control.js';
import { filterCoveredHistory } from '../src/history-handoff.js';

function fixture(is_user = false) {
    const chat = [{name:'开场角色',is_user,send_date:'opening',mes:'<content>旅人已把铜钥匙交给守卫，约定天亮归还。医师不知道这件事。</content>'}];
    for(let n=1;n<=55;n++) chat.push({name:'旅人',is_user:true,send_date:`u${n}`,mes:`请求${n}`},
        {name:'守卫',gen_started:`g${n}`,send_date:`a${n}`,mes:`答复${n}`});
    const metadata = {}, settings = normalizeSettings({historyHandoff:true,activeStateEnabled:false});
    const store = new MemoryStore({getMetadata:()=>metadata,getChatId:()=> 'opening-test',saveMetadata:()=>{}});
    for(const entry of getAssistantMessages(chat)) store.addSummary({messageId:entry.messageId,floor:entry.floor,
        sourceContentFingerprint:entry.contentFingerprint,event:`楼层事件${entry.floor}`,status:'frozen'});
    const requests=[];
    const apiClient={complete:async request=>{requests.push(request);return {finishReason:'stop',content:
        request.userContent.includes('[CHECKPOINT_STATE]') ? '[STORY_ARC]\n旅人与守卫履行归还铜钥匙的约定，医师始终不知情。' : '[CHECKPOINT]\n[Stage Story]\n开场已交铜钥匙，约定天亮归还；接下来双方继续往来，医师仍不知情。'};}};
    const summarizer=new MemorySummarizer({store,getChat:()=>chat,getSettings:()=>settings,apiClient});
    return {chat,store,settings,requests,apiClient,summarizer};
}

for(const role of [false,true]) test(`opening joins only the first CP, then Long replaces it without a permanent opening block (user=${role})`,async()=>{
    const f=fixture(role), original=structuredClone(f.chat);
    const first=await f.summarizer.generateCheckpoint(1,5);
    assert.equal(f.requests.length,1);
    assert.match(f.requests[0].userContent,/第0层 · 开场白原始事实[\s\S]*铜钥匙[\s\S]*第1层/);
    assert.equal(first.openingContentFingerprint,getOpeningSource(f.chat).contentFingerprint);
    assert.equal(stageStartLabel(first),0);
    assert.deepEqual([first.startFloor,first.endFloor],[1,5]); // stable stored floor numbering
    assert.equal(first.summaryIds.length,5);
    assert.equal(getAssistantMessages(f.chat)[0].floor,1);
    assert.deepEqual(f.summarizer.getNextCheckpointRange(),{startFloor:6,endFloor:10});
    const second=await f.summarizer.generateCheckpoint(6,10);
    assert.equal(second.openingContentFingerprint,undefined);
    const fresh=f.requests[1].userContent.split('[NEW_SUMMARIES]')[1];
    assert.doesNotMatch(fresh,/第0层|开场白原始事实/);
    refreshSnapshot(f.store.current(),f.settings,'manual reinject');
    let snapshot=f.store.current().injectionSnapshot;
    assert.match(snapshot.value,/第0–5层/);
    assert.equal(snapshot.blocks.filter(row=>row.openingContentFingerprint).length,1);
    assert.ok(publishedOpeningCoverage(f.chat,snapshot,snapshot.value));
    const filtered=filterCoveredHistory(structuredClone(f.chat),f.chat,snapshot,snapshot.value,{lastUserOnly:true,summaries:f.store.current().summaries});
    assert.equal(filtered.messages.some(row=>row.send_date==='opening'),false);
    // An old Long without opening provenance cannot silently hide its only raw source.
    f.store.addLongMemory({id:'long-001',startFloor:1,endFloor:10,status:'frozen',content:'[STORY_ARC]\n旧长期剧情。'});
    refreshSnapshot(f.store.current(),f.settings,'manual reinject');
    snapshot=f.store.current().injectionSnapshot;
    assert.equal(publishedOpeningCoverage(f.chat,snapshot,snapshot.value),false);
    const rebuilt=await f.summarizer.generateLongMemory([first,second],{overwrite:true});
    assert.equal(rebuilt.openingContentFingerprint,first.openingContentFingerprint);
    assert.match(f.requests.at(-1).systemPrompt,/第0层/);
    refreshSnapshot(f.store.current(),f.settings,'new long memory');
    snapshot=f.store.current().injectionSnapshot;
    assert.equal(snapshot.blocks.filter(row=>row.type==='checkpoint').length,0);
    assert.equal(snapshot.blocks.filter(row=>row.openingContentFingerprint).length,1);
    assert.match(snapshot.value,/LONG_STORY_0_10/);
    assert.equal(snapshot.blocks.some(row=>row.type==='opening'),false);
    assert.deepEqual(f.chat,original);
});

for(const role of [false,true]) test(`old first CP is untouched until explicit regeneration; unpublished opening stays (user=${role})`,async()=>{
    const f=fixture(role);
    const old={id:'checkpoint-001',startFloor:1,endFloor:5,status:'frozen',content:'[Stage Story]\n旧首段。',manualEdited:true};
    f.store.addCheckpoint(old);
    assert.deepEqual(await f.summarizer.generateCheckpoint(1,5),f.store.current().checkpoints[0]);
    assert.equal(f.requests.length,0);
    refreshSnapshot(f.store.current(),f.settings,'manual reinject');
    let snapshot=f.store.current().injectionSnapshot;
    const pending=filterCoveredHistory(structuredClone(f.chat),f.chat,snapshot,snapshot.value,
        {lastUserOnly:true,summaries:f.store.current().summaries});
    assert.ok(pending.messages.some(row=>row.send_date==='opening'));
    assert.equal(pending.messages.some(row=>row.send_date==='a1'),false);
    const rebuilt=await f.summarizer.generateCheckpoint(1,5,{overwrite:true});
    assert.equal(rebuilt.id,old.id);
    assert.equal(f.store.current().checkpoints.length,1);
    assert.equal(publishedOpeningCoverage(f.chat,snapshot,snapshot.value),false);
    refreshSnapshot(f.store.current(),f.settings,'manual reinject');
    snapshot=f.store.current().injectionSnapshot;
    assert.ok(publishedOpeningCoverage(f.chat,snapshot,snapshot.value));
    assert.equal(publishedOpeningCoverage(f.chat,snapshot,'未发送的记忆'),false);
    f.chat[0].mes='开场事实已编辑';
    assert.equal(publishedOpeningCoverage(f.chat,snapshot,snapshot.value),false);
});

test('opening changes during aggregation reject the response and keep the old first CP',async()=>{
    const f=fixture();
    const first=await f.summarizer.generateCheckpoint(1,5);
    const before=structuredClone(first);
    f.apiClient.complete=async()=>{f.chat[0].mes='改后的开场白';return {finishReason:'stop',content:'[Stage Story]\n过期结果'};};
    await assert.rejects(f.summarizer.generateCheckpoint(1,5,{overwrite:true}),error=>error.code==='SOURCE_CHANGED');
    assert.deepEqual(f.store.current().checkpoints[0],before);
});
