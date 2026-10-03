import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as T from '../src/tt.mjs';
import * as H from '../src/history.mjs';
import {Position,do_move,gives_check,clear_counter_move_history} from '../src/position.mjs';
import {StartFEN,uci_to_move} from '../src/notation.mjs';
import {from_sq,to_sq} from '../src/constants.mjs';
const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/tables.json',import.meta.url)));
test('clustered TT probes, snapshots, replacements, widths, aging and clears match Python', () => {
  T.tt_allocate(128); assert.equal(T.TT.clusterCount,28672); assert.equal(T.TT.table.length,86016);
  for (const op of expected.tt) {
    if (op.kind === 'generation') { T.tt_new_search(); assert.equal(T.TT.generation8,op.generation); continue; }
    if (op.kind === 'clear') { T.tt_clear(); assert.equal(T.TT.generation8,op.generation); continue; }
    const key = BigInt(op.key), [hit,entry] = T.tt_probe(key);
    assert.deepEqual({hit,slot:entry.slot,packed:String(entry.packed)},op.before);
    T.tte_save(entry,key,...op.args);
    assert.deepEqual({packed:String(entry.packed),move:T.tte_move(entry),value:T.tte_value(entry),eval:T.tte_eval(entry),
      depth:T.tte_depth(entry),pv:T.tte_is_pv(entry),bound:T.tte_bound(entry),hashfull:T.tt_hashfull()},op.after);
  }
  for (const [v,ply,r50,to,from] of expected.conversions) {
    assert.equal(T.value_to_tt(v,ply),to); assert.equal(T.value_from_tt(v,ply,r50),from);
  }
});
test('all history formulas match Python with negative, saturating and wrapping updates', () => {
  const pos = new Position(); pos.set(StartFEN);
  for (const str of ['e2e4','e7e5','g1f3','b8c6','f1b5','a7a6']) {
    const m = uci_to_move(pos,str); pos.st.currentMove = m;
    pos.st.history = pos.counterMoveHistory[pos.board[from_sq(m)]][to_sq(m)]; do_move(pos,m,gives_check(pos,pos.st,m));
  }
  for (const fixture of expected.histories) {
    const v = fixture.bonus;
    H.history_update(pos.mainHistory,0,1234,v); H.continuation_history_update(pos.counterMoveHistory[2][12],512,v);
    H.capture_history_update(pos.captureHistory,2,12,5,v); H.correction_history_update(pos.correctionHistory,0,pos,v);
    H.non_pawn_correction_history_update(pos.nonPawnCorrectionHistory,0,0,pos,v);
    H.non_pawn_correction_history_update(pos.nonPawnCorrectionHistory,1,0,pos,-v);
    H.update_continuation_histories(pos,2,12,v);
    const move = uci_to_move(pos,'b5c6'); H.update_quiet_histories(pos,move,v);
    assert.deepEqual([pos.mainHistory[0][1234],pos.counterMoveHistory[2][12][512],pos.captureHistory[2][12][5],
      pos.correctionHistory[0][Number(pos.st.pawnKey&16383n)],pos.nonPawnCorrectionHistory[0][0][Number(pos.st.nonPawnKey[0]&8191n)],
      pos.nonPawnCorrectionHistory[1][0][Number(pos.st.nonPawnKey[1]&8191n)],H.correction_value(pos)],fixture.values);
    assert.deepEqual(pos.killers[pos.st.ply],fixture.killers);
    const prev = pos.stack[pos.st_idx-1].currentMove;
    assert.equal(pos.counterMoves[pos.board[to_sq(prev)]][to_sq(prev)],fixture.countermove);
    assert.deepEqual(Array.from({length:6},(_,i)=>pos.stack[pos.st_idx-1-i].history[2*64+12]),fixture.continuations);
    assert.equal(pos.mainHistory[0][move&4095],fixture.main_quiet);
  }
  for (const [d,bonus,malus] of expected.stat) { assert.equal(H.stat_bonus(d),bonus); assert.equal(H.stat_malus(d),malus); }
  const row = pos.counterMoveHistory[2][12]; H.clear_histories(pos); clear_counter_move_history(pos.counterMoveHistory);
  assert.equal(pos.counterMoveHistory[2][12],row); assert.equal(row[512],0); assert.equal(pos.counterMoveHistory[0][0][512],-1);
  assert.equal(pos.captureHistory[2][12][5],0); assert.equal(pos.mainHistory[0][1234],0);
});
