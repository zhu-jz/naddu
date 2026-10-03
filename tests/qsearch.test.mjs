import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Position} from '../src/position.mjs';
import {TT,tt_allocate} from '../src/tt.mjs';
import {qsearch_node} from '../src/search.mjs';
const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/qsearch.json',import.meta.url)));
test('quiescence returns, move counts, PVs, eval caches and all TT writes match Python', () => {
  for (const fixture of expected) {
    tt_allocate(1); const pos = new Position(); pos.set(fixture.fen);
    if (fixture.warm) { qsearch_node(pos,-32001,32001,0,1,!!pos.st.checkersBB); pos.nodes = 0; }
    const check = fixture.forced_check ?? !!pos.st.checkersBB;
    const value = qsearch_node(pos,fixture.alpha,fixture.beta,fixture.depth,fixture.nt,check);
    const label = `${fixture.fen} depth ${fixture.depth} nt ${fixture.nt} check ${check} warm ${fixture.warm}`;
    assert.equal(value,fixture.value,label); assert.equal(pos.nodes,fixture.nodes,label+' nodes');
    assert.deepEqual(pos.pvArray[0],fixture.pv,label+' pv'); assert.equal(pos.st.staticEval,fixture.staticEval,label+' eval');
    const entries = [];
    for (let i = 0; i < TT.table.length; i++) if (TT.table[i]) entries.push([i,String(TT.table[i])]);
    assert.deepEqual(entries,fixture.tt,label+' TT');
  }
});
