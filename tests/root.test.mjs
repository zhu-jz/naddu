import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runJavaScript,benchmarkCommands} from '../scripts/parity.mjs';
import {Threads,Limits} from '../src/control.mjs';
import {select_best_thread} from '../src/search.mjs';
test('complete root loop reproduces the cold depth-5 starting-position baseline', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/start-depth5.json',import.meta.url)));
  assert.deepEqual(runJavaScript(['ucinewgame','position startpos'],5),expected);
});
test('complete benchmark root sequence matches all captured Python iterations', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/bench-depth5.json',import.meta.url)));
  assert.deepEqual(runJavaScript(benchmarkCommands(),5),expected);
});
test('warm searches, new games, MultiPV and terminal roots match Python lifecycle behavior', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/lifecycle-depth5.json',import.meta.url)));
  assert.deepEqual(runJavaScript(expected.commands,5),expected.results);
});

test('MultiPV option changes, maximum requested PVs, warm roots and few legal moves match Python', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/multipv-depth4.json',import.meta.url)));
  assert.deepEqual(runJavaScript(expected.commands,4),expected.results);
});

test('SMP final-worker voting, depth/MultiPV exclusions and helper-mate guard match Python',()=>{
  const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/worker-selection.json',import.meta.url))), workers=Threads.workers;
  try {
    for (const spec of expected) {
      Limits.reset(); Limits.depth=spec.limitDepth || 0;
      const positions=spec.positions.map(([score,completedDepth,move])=>({completedDepth,multiPV:spec.multiPV || 1,
        rootMoves:{size:1,move:[{score,pv:[move]}]}}));
      Threads.workers=positions.map(pos=>({pos}));
      assert.equal(positions.indexOf(select_best_thread(positions[0])),spec.selected,JSON.stringify(spec));
    }
  } finally { Threads.workers=workers; Limits.reset(); }
});
