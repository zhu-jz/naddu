import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import * as T from '../src/tt.mjs';
import {BOUND_EXACT} from '../src/constants.mjs';
import {create_counter_move_history,clear_counter_move_history} from '../src/position.mjs';

test('TT storage transitions preserve every entry and generation',()=>{
  T.tt_allocate(1,false,false); T.tt_new_search();
  const key=0xfedcba9876543210n, [,entry]=T.tt_probe(key);
  T.tte_save(entry,key,-111,true,BOUND_EXACT,8,222,-333);
  const before=entry.packed;
  T.tt_set_shared(true);
  assert.equal(T.TT.generation8,8); assert.equal(T.tt_probe(key)[1].packed,before);
  const descriptor=T.tt_shared_descriptor(); T.tt_attach_shared(descriptor);
  assert.equal(T.tt_probe(key)[1].packed,before);
  T.tt_set_shared(false);
  assert.equal(T.TT.generation8,8); assert.equal(T.tt_probe(key)[1].packed,before);
});

test('shared continuation rows retain aliases, sentinel values and cross-view updates',()=>{
  const buffer=new SharedArrayBuffer(16*64*1024), first=create_counter_move_history(buffer,true);
  first[2][12][345]=99;
  const second=create_counter_move_history(buffer);
  assert.equal(second[2][12][345],99); assert.equal(second[0][0][512],-1);
  second[2][12][345]=-77; assert.equal(first[2][12][345],-77);
  const row=first[2][12]; clear_counter_move_history(second);
  assert.equal(first[2][12],row); assert.equal(row[345],0); assert.equal(first[0][0][512],-1);
});

test('concurrent TT writers publish coherent packed snapshots',async t=>{
  T.tt_allocate(1,true,true);
  const control=new Int32Array(new SharedArrayBuffer(6*4)), moduleURL=new URL('../src/tt.mjs',import.meta.url).href;
  const source=`import {parentPort,workerData} from 'node:worker_threads';
    import {tt_attach_shared,tt_probe,tte_save} from ${JSON.stringify(moduleURL)};
    const state=new Int32Array(workerData.control); tt_attach_shared(workerData.tt);
    parentPort.postMessage('ready'); Atomics.wait(state,0,0);
    for(let i=1;i<=2000;i++) {
      const value=1+(i+workerData.idx*2000)%30000, [,entry]=tt_probe(123n);
      tte_save(entry,123n,value,false,3,8,value,-value);
    }
    Atomics.store(state,workerData.idx+1,1); parentPort.close();`;
  const workers=[];
  const ready=[], exited=[];
  for (let idx=0;idx<4;idx++) {
    const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{workerData:{idx,tt:T.tt_shared_descriptor(),control:control.buffer}});
    workers.push(worker); ready.push(new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));
    exited.push(new Promise((resolve,reject)=>{worker.once('exit',code=>code===0 ? resolve() : reject(new Error('Writer exited '+code)));worker.once('error',reject);}));
  }
  t.after(()=>{for(const worker of workers) worker.terminate(); T.tt_set_shared(false);});
  await Promise.all(ready); Atomics.store(control,0,1); Atomics.notify(control,0);
  let samples=0; const deadline=Date.now()+10000;
  while (!workers.every((_,idx)=>Atomics.load(control,idx+1))) {
    assert.ok(Date.now()<deadline,'TT writers stalled');
    const [hit,entry]=T.tt_probe(123n);
    if (hit) { assert.equal(T.tte_eval(entry),-T.tte_value(entry)); assert.equal(T.tte_move(entry),T.tte_value(entry)); samples++; }
  }
  assert.ok(samples>0); await Promise.all(exited);
});
