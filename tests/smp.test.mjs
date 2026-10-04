import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {create_smp_pool} from '../src/smp.mjs';
import {EngineUCI} from '../src/uci.mjs';
import {EngineOptions,Threads,set_stop_signal} from '../src/control.mjs';
import {TT,tt_set_shared} from '../src/tt.mjs';
import {generate_legal} from '../src/movegen.mjs';
import {uci_move} from '../src/notation.mjs';

function setup(t,fail=false) {
  Object.assign(EngineOptions,{Hash:1,ReferenceTT:true,Threads:1,MultiPV:1,Ponder:false,UCI_Chess960:false});
  Threads.workers=[]; Threads.counterMoveHistory=null; Threads.stop=false;
  const signal=new Int32Array(new SharedArrayBuffer(20)); set_stop_signal(signal);
  const created=[], output=[];
  const pool=create_smp_pool((index,descriptor)=>{
    const worker=new Worker(new URL('../naddu.js',import.meta.url),{workerData:{nadduHelper:descriptor}});
    created.push(worker);
    return {send(message){worker.postMessage(fail && message.kind==='search' ? {kind:'invalid'} : message);},
      terminate(){worker.terminate();worker.unref();}};
  },signal);
  t.after(()=>{pool.shutdown();set_stop_signal(null);tt_set_shared(false);});
  const engine=new EngineUCI(line=>output.push(line));
  return {pool,engine,created,output};
}
test('persistent SMP workers share counters and TT, retain their identities and resize correctly',t=>{
  const {pool,engine,created,output}=setup(t);
  for (const num of [2,4]) {
    engine.execute('setoption name Threads value '+num); engine.execute('isready');
    assert.equal(Threads.numThreads,num); assert.ok(TT.shared);
    assert.equal(Threads.workers[0].pos.counterMoveHistory,pool.history);
    for (const command of ['position startpos','position startpos moves g1f3 g8f6 f3g1 f6g8']) {
      engine.execute(command);
      const legal=generate_legal(engine.root).map(({move})=>uci_move(move,engine.root.chess960));
      engine.execute('go nodes 20000');
      assert.ok(legal.includes(output.findLast(line=>line.startsWith('bestmove ')).split(' ')[1]));
      assert.ok(Threads.nodes_searched()>=20000);
      assert.equal(Threads.nodes_searched(),Threads.workers.reduce((sum,worker)=>sum+worker.pos.nodes,0));
      for (const worker of Threads.workers) {assert.ok(worker.pos.nodes>0);assert.ok(worker.pos.completedDepth>0);}
      assert.equal(created.length,num-1,'Warm search recreated a persistent worker');
    }
  }
  const survivor=Threads.workers[1];
  engine.execute('ucinewgame');
  engine.execute('setoption name Threads value 2'); engine.execute('isready');
  assert.equal(Threads.workers[1],survivor); assert.equal(created.length,3);
  engine.execute('setoption name Threads value 1'); engine.execute('isready');
  assert.equal(Threads.numThreads,1); assert.equal(TT.shared,null);
  engine.execute('position startpos'); engine.execute('go depth 5');
  assert.ok(output.findLast(line=>line.startsWith('bestmove ')));
});

test('helper errors set the global stop flag and reach the coordinator without hanging',t=>{
  const {engine}=setup(t,true);
  engine.execute('setoption name Threads value 2'); engine.execute('isready'); engine.execute('position startpos');
  assert.throws(()=>engine.execute('go nodes 20000'),/SMP worker 1 failed:.*Unknown SMP helper command/s);
  assert.equal(Threads.stop,true);
});
