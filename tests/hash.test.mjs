import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as T from '../src/tt.mjs';
import {BOUND_EXACT} from '../src/constants.mjs';
import {EngineOptions} from '../src/control.mjs';
import {EngineUCI} from '../src/uci.mjs';
import {generate_legal} from '../src/movegen.mjs';
import {uci_move} from '../src/notation.mjs';

test('larger Hash retains positions that collide in the smaller table',()=>{
  const keys=[1n,2n,3n,(1n<<48n)+4n];
  for (const [mb,retained] of [[1,3],[2,4]]) {
    T.tt_allocate(mb);
    for (const key of keys) {
      const [,entry]=T.tt_probe(key);
      T.tte_save(entry,key,100,false,BOUND_EXACT,8,1234,-200);
    }
    assert.equal(keys.filter(key=>T.tt_probe(key)[0]).length,retained);
  }
});

test('resizing resets entries and generation, and indexes the full configured capacity',()=>{
  for (const [mb,clusters,entries] of [[1,32768,98304],[3,98304,294912],[16,524288,1572864]]) {
    T.tt_allocate(mb);
    assert.equal(T.TT.clusterCount,clusters); assert.equal(T.TT.table.length,entries);
    assert.equal(T.TT.generation8,0); assert.ok(T.TT.table.every(value=>value===0n));
    const key=0xffffffffffffffffn, [hit,entry]=T.tt_probe(key);
    assert.equal(hit,false); assert.equal(entry.slot,entries-3);
    T.tte_save(entry,key,-123,true,BOUND_EXACT,8,2345,-456);
    T.tt_new_search();
    const [found,saved]=T.tt_probe(key);
    assert.equal(found,true); assert.equal(T.tte_value(saved),-123); assert.equal(T.tte_eval(saved),-456);
    assert.equal(T.tte_move(saved),2345); assert.equal(T.tte_depth(saved),8);
    const table=T.TT.table; T.tt_clear();
    assert.equal(T.TT.table,table); assert.equal(T.TT.generation8,8); assert.equal(T.tt_probe(key)[0],false);
  }
  const table=T.TT.table;
  for (const invalid of [0,-1,1.5,NaN,Infinity,T.MAX_HASH_MB+1]) {
    assert.throws(()=>T.tt_allocate(invalid),RangeError); assert.equal(T.TT.table,table);
  }
  T.tt_allocate(16,true); assert.equal(T.TT.clusterCount,28672); assert.equal(T.TT.table.length,86016);
});

test('UCI applies Hash and reference mode, rejects invalid sizes and searches after resize',()=>{
  Object.assign(EngineOptions,{Hash:1,ReferenceTT:false,Ponder:false,MultiPV:1,UCI_Chess960:false});
  const output=[], engine=new EngineUCI(line=>output.push(line));
  assert.equal(T.TT.table.length,98304);
  engine.execute('setoption name Hash value 3'); engine.execute('isready');
  assert.equal(T.TT.table.length,294912);
  engine.execute('setoption name ReferenceTT value true'); engine.execute('isready');
  assert.equal(T.TT.table.length,86016);
  engine.execute('setoption name Hash value 16'); engine.execute('isready');
  assert.equal(T.TT.table.length,86016);
  engine.execute('setoption name ReferenceTT value false'); engine.execute('isready');
  assert.equal(T.TT.table.length,1572864);
  for (const value of ['0','-1','1.5',String(T.MAX_HASH_MB+1)]) {
    engine.execute('setoption name Hash value '+value); engine.execute('isready');
    assert.equal(EngineOptions.Hash,16); assert.equal(T.TT.table.length,1572864);
  }
  const table=T.TT.table; engine.execute('bench 0 1 5');
  assert.equal(T.TT.table,table); assert.ok(output.some(line=>line.startsWith('Benchmark Hash must be')));
  engine.execute('position startpos');
  const legal=generate_legal(engine.root).map(({move})=>uci_move(move,engine.root.chess960));
  engine.execute('go depth 6');
  assert.ok(legal.includes(output.findLast(line=>line.startsWith('bestmove ')).split(' ')[1]));
});

test('released classic Worker applies configurable Hash and reference mode and recovers a failed resize',()=>{
  const source=fs.readFileSync(new URL('../naddu.js',import.meta.url),'utf8'), lines=[];
  const context=vm.createContext({atob,postMessage:line=>lines.push(line),close(){}});
  vm.runInContext(source,context);
  const send=data=>context.onmessage({data});
  send('setoption name Hash value 3'); send('isready');
  assert.equal(context.NadduCore.TT.table.length,294912);
  send('setoption name ReferenceTT value true'); send('isready');
  assert.equal(context.NadduCore.TT.table.length,86016);
  send('setoption name ReferenceTT value false'); send('isready');
  assert.equal(context.NadduCore.TT.table.length,294912);
  const table=context.NadduCore.TT.table;
  context.Array=()=>{ throw new RangeError('simulated allocation failure'); };
  send('setoption name Hash value 4'); send('isready');
  assert.equal(context.NadduCore.TT.table,table); assert.equal(context.NadduCore.EngineOptions.Hash,3);
  assert.ok(lines.includes('info string Hash allocation failed: simulated allocation failure'));
  delete context.Array;
  send('position startpos'); send('go depth 5');
  assert.ok(lines.some(line=>line.startsWith('bestmove ')));
});
