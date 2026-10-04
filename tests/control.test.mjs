import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resetEngine,normalized} from '../scripts/parity.mjs';
import {EngineUCI} from '../src/uci.mjs';
import {Time,time_init,set_clock} from '../src/timeman.mjs';
import {EngineOptions,Limits,Threads,mainThread} from '../src/control.mjs';
import {search_clear} from '../src/search.mjs';
const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/controls-horizon50.json',import.meta.url)));
test('50-move time allocation matches the modified Python oracle including low clocks and ponder bonus',()=>{
  for (const f of expected.formulas) {
    EngineOptions.Ponder=f.ponder; Limits.reset(); Limits.startTime=12345;
    Limits.time[f.us]=f.time; Limits.inc[f.us]=f.inc; time_init(f.us,f.ply,Limits);
    assert.deepEqual(Time,{startTime:12345,optimumTime:f.optimum,maximumTime:f.maximum},JSON.stringify(f));
  }
});
test('node limits and deterministic clocks match the 50-move Python oracle stop checks and completed iterations',()=>{
  resetEngine(); let output=[];
  const engine=new EngineUCI(line=>{ if ((line.startsWith('info depth') && line.includes(' score ')) || line.startsWith('bestmove')) output.push(normalized(line)); });
  try {
    for (const f of expected.cases) {
      search_clear(); engine.execute(f.position); Threads.workers[0].pos.nodes=0;
      set_clock(()=>10000+Math.floor(Threads.nodes_searched()/f.pace)); output=[];
      engine.execute(f.command); const pos=Threads.workers[0].pos;
      assert.deepEqual({position:f.position,command:f.command,pace:f.pace,depth:pos.completedDepth,
        score:pos.rootMoves.move[0].score,nodes:pos.nodes,optimum:Time.optimumTime,maximum:Time.maximumTime,
        previousTimeReduction:mainThread.previousTimeReduction,output},f);
    }
  } finally { set_clock(()=>Date.now()); }
});
