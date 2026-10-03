import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Position} from '../src/position.mjs';
import {generate_legal} from '../src/movegen.mjs';
import {set_position} from '../src/notation.mjs';
import {TT,tt_allocate} from '../src/tt.mjs';
import {Limits,Threads} from '../src/control.mjs';
import {now,time_init} from '../src/timeman.mjs';
import {search_node,RootMoves,init_search_sentinels} from '../src/search.mjs';
const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/mainsearch.json',import.meta.url)));
function historyDigest(pos) {
  const digest = createHash('sha256');
  const bytes = row=>digest.update(new Uint8Array(row.buffer,row.byteOffset,row.byteLength));
  const i16row = row=>{
    const data = Buffer.alloc(row.length*2);
    for (let i = 0; i < row.length; i++) data.writeInt16LE(row[i],i*2);
    digest.update(data);
  };
  for (const table of [pos.mainHistory,pos.correctionHistory]) for (const row of table) bytes(row);
  for (const piece of pos.counterMoveHistory) for (const row of piece) bytes(row);
  for (const table of [pos.captureHistory,pos.nonPawnCorrectionHistory]) for (const rows of table) for (const row of rows) i16row(row);
  for (const row of pos.counterMoves) {
    const data = Buffer.alloc(row.length*2); for (let i = 0; i < row.length; i++) data.writeUInt16LE(row[i],i*2); digest.update(data);
  }
  return digest.digest('hex');
}
test('main search matches Python values, moves, selective depths, all TT writes and complete histories', () => {
  for (const f of expected) {
    tt_allocate(1); Limits.reset(); Limits.startTime = now(); time_init(0,0,Limits); Threads.stop = false;
    const root = new Position(false); set_position(root,'position fen '+f.fen);
    const pos = new Position(); pos.copy_root_from(root); pos.rootMoves = new RootMoves();
    const legal = generate_legal(root); pos.rootMoves.size = legal.length;
    for (let i = 0; i < legal.length; i++) pos.rootMoves.move[i].reset_for_search(legal[i].move);
    pos.pvLast = legal.length; pos.rootDepth = f.depth; pos.rootDelta = 64002; init_search_sentinels(pos);
    for (let i = pos.st_idx; i < pos.st_idx+3; i++) {
      const st = pos.stack[i]; st.currentMove = st.excludedMove = st.moveCount = 0; st.ttHit = false; st.staticEval = 0; st.history = null;
    }
    if (f.warm) search_node(pos,-32001,32001,6,false,1);
    const value = search_node(pos,f.alpha,f.beta,f.depth,f.cut,f.nt);
    const label = `${f.fen} depth ${f.depth} nt ${f.nt} warm ${f.warm}`;
    assert.equal(value,f.value,label+' value'); assert.equal(pos.nodes,f.nodes,label+' nodes'); assert.equal(pos.selDepth,f.selDepth,label+' seldepth');
    assert.deepEqual(pos.pvArray[0],f.pv,label+' pv');
    assert.deepEqual(pos.rootMoves.move.slice(0,pos.rootMoves.size).map(rm=>[rm.pv.slice(0,rm.pvSize),rm.score,rm.averageScore,rm.selDepth]),f.rootMoves,label+' roots');
    const entries = []; for (let i = 0; i < TT.table.length; i++) if (TT.table[i]) entries.push([i,String(TT.table[i])]);
    assert.deepEqual(entries,f.tt,label+' TT'); assert.equal(historyDigest(pos),f.histories,label+' histories');
  }
});
