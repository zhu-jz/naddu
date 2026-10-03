import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root} from '../scripts/reference.mjs';
import {runTraces,firstTraceDifference} from '../scripts/trace.mjs';
test('deep and controlled searches match Python event digests and actually exercise rare search features',()=>{
  const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/search-traces.json',import.meta.url)));
  const actual=runTraces(expected.map(r=>r.spec));
  assert.deepEqual(actual,expected);
  const counts=actual.reduce((all,r)=>{ for (const [label,n] of Object.entries(r.counts)) all[label]=(all[label] || 0)+n; return all; },{});
  for (const feature of ['verified_null','probcut','cut_probcut','singular','extension_1','extension_2','extension_3',
    'extension_-1','extension_-2','deep_check','lmr','lmr_research','cut_razoring','cut_rfp']) assert.ok(counts[feature]>0,'Missing branch coverage: '+feature);
});
test('trace diagnostics identify the first differing event and its recursive search context',async t=>{
  const build=path.join(root,'build'); fs.mkdirSync(build,{recursive:true});
  const directory=fs.mkdtempSync(path.join(build,'trace-check-'));
  t.after(()=>{ if (path.dirname(fs.realpathSync(directory))===fs.realpathSync(build)) fs.rmSync(directory,{recursive:true,force:true}); });
  const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/search-traces.json',import.meta.url)))[2];
  assert.deepEqual(runTraces([expected.spec],{eventDirectory:directory,snapshotTarget:{case:1,event:expected.events}}),[expected]);
  const snapshot=JSON.parse(fs.readFileSync(path.join(directory,'case-1-state.json')));
  assert.equal(snapshot.search.nodes,expected.nodes); assert.equal(snapshot.histories.counterMoveHistory.length,16);
  assert.equal(snapshot.frames.length,8); assert.equal(snapshot.accumulator.length,2);
  const actualFile=path.join(directory,'case-1.jsonl'), expectedFile=path.join(directory,'expected.jsonl');
  fs.copyFileSync(actualFile,expectedFile);
  assert.equal(await firstTraceDifference(expectedFile,actualFile),null);
  const lines=fs.readFileSync(actualFile,'utf8').trimEnd().split('\n');
  lines[lines.length-1]='["different"]'; fs.writeFileSync(actualFile,lines.join('\n')+'\n');
  const difference=await firstTraceDifference(expectedFile,actualFile);
  assert.equal(difference.event,expected.events); assert.equal(difference.context[0],'enter');
  assert.deepEqual(difference.actual,['different']); assert.equal(difference.expected[0],'return');
});
