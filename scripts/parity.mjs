import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {root,reference} from './reference.mjs';
import {Position} from '../src/position.mjs';
import {set_position} from '../src/notation.mjs';
import {Threads,Limits,EngineOptions,mainThread,set_output} from '../src/control.mjs';
import {tt_allocate} from '../src/tt.mjs';
import {search_clear,ensure_search_worker,start_thinking} from '../src/search.mjs';
import {now} from '../src/timeman.mjs';
import {BENCH_POSITIONS} from '../src/generated/benchmark.mjs';

export function resetEngine() {
  Threads.workers = []; Threads.counterMoveHistory = null; Threads.stop = false; Threads.searching = false;
  Object.assign(EngineOptions,{Hash:1,Threads:1,Ponder:false,MultiPV:1,UCI_Chess960:false});
  tt_allocate(1); ensure_search_worker(); search_clear(); Limits.reset();
}
export function normalized(line) { return line.replace(/ (?:time|nps|hashfull) \d+/g,''); }
export function runJavaScript(commands,depth = 5) {
  resetEngine(); const rootPos = new Position(false), results = []; let output = [];
  set_output(line=>{ if ((line.startsWith('info depth') && line.includes(' score ')) || line.startsWith('bestmove')) output.push(normalized(line)); });
  for (const command of commands) {
    if (command === 'ucinewgame') { search_clear(); continue; }
    if (command.startsWith('setoption')) {
      const [,name,value] = /^setoption name (.+) value (.+)$/.exec(command);
      const parsed = name==='Ponder' || name==='UCI_Chess960' ? value==='true' : Number(value);
      if (name==='Hash' && parsed!==EngineOptions.Hash) tt_allocate(parsed);
      EngineOptions[name] = parsed; continue;
    }
    set_position(rootPos,command); Limits.reset(); Limits.depth = depth; Limits.startTime = now(); output = [];
    start_thinking(rootPos,false); const pos = Threads.workers[0].pos;
    results.push({command,depth:pos.completedDepth,score:pos.rootMoves.move[0].score,nodes_after_reporting:pos.nodes,output});
  }
  set_output(()=>{}); return results;
}
export function benchmarkCommands() { return ['ucinewgame',...BENCH_POSITIONS.map(s=>s.startsWith('setoption') ? s : 'position fen '+s)]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const depth = Number(process.argv[2]||13), expected = reference('benchmark',{depth});
  const actual = runJavaScript(benchmarkCommands(),depth);
  for (let i = 0; i < expected.length; i++) {
    try { assert.deepEqual(actual[i],expected[i]); }
    catch (error) {
      fs.mkdirSync(path.join(root,'build'),{recursive:true});
      fs.writeFileSync(path.join(root,'build/parity-mismatch.json'),JSON.stringify({index:i+1,expected:expected[i],actual:actual[i]},null,2));
      throw new Error(`Benchmark position ${i+1} differs; see build/parity-mismatch.json`,{cause:error});
    }
  }
  assert.equal(actual.length,expected.length);
  console.log(`Exact parity: ${actual.length} benchmark positions at depth ${depth}, ${actual.reduce((n,r)=>n+r.nodes_after_reporting,0)} moves counted after reporting.`);
}
