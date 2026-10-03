import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as P from '../src/position.mjs';
import * as G from '../src/movegen.mjs';
import {uci_move, StartFEN, set_position} from '../src/notation.mjs';
import {KING} from '../src/constants.mjs';
import {lsb} from '../src/bitboard.mjs';
import {NNUEAccumulator,nnue_evaluate,nnue_accumulator_refresh} from '../src/nnue.mjs';
import {evaluate} from '../src/evaluate.mjs';
import {bundle} from '../scripts/build.mjs';
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/positions.json', import.meta.url)));
const primitives = JSON.parse(fs.readFileSync(new URL('./fixtures/primitives.json', import.meta.url)));
const sequences = JSON.parse(fs.readFileSync(new URL('./fixtures/sequences.json', import.meta.url)));

function state(pos) {
  const st = pos.st;
  return {fen:P.pos_fen(pos),board:Array.from(pos.board),side:pos.sideToMove,pieceCount:Array.from(pos.pieceCount),
    key:String(st.key),pawnKey:String(st.pawnKey),materialKey:String(st.materialKey),nonPawnKey:st.nonPawnKey.map(String),
    nonPawn:st.nonPawn,rights:st.castlingRights,ep:st.epSquare,rule50:st.rule50,pliesFromNull:st.pliesFromNull,
    checkers:String(st.checkersBB),blockers:st.blockersForKing.map(String),pinners:st.pinnersForKing.map(String),
    checkSquares:st.checkSquares.map(String),ksq:st.ksq,captured:st.capturedPiece,
    accumulator:st.accumulator.colors.map(row => Array.from(row)),raw_nnue:nnue_evaluate(st.accumulator,pos.sideToMove),eval:evaluate(pos)};
}
function compareState(pos,expected,label) {
  const actual = state(pos);
  for (const key of Object.keys(expected)) assert.deepEqual(actual[key],expected[key],`${label}: ${key}`);
}
function refreshCheck(pos) {
  for (let side = 0; side < 2; side++) {
    const acc = new NNUEAccumulator(); nnue_accumulator_refresh(acc,pos,side,lsb(pos.pieces(KING,side)));
    assert.deepEqual(acc.colors[side],pos.st.accumulator.colors[side]);
  }
}
test('PRNG, all Zobrist keys and full cuckoo tables match Python', () => {
  const rng = new P.PRNG(1070372);
  assert.deepEqual(Array.from({length:32},()=>String(rng.rand())),primitives.prng);
  assert.deepEqual(P.zob.psq.map(row=>row.map(String)),primitives.zob.psq);
  assert.deepEqual(P.zob.enpassant.map(String),primitives.zob.ep);
  assert.deepEqual(P.zob.castling.map(String),primitives.zob.castling);
  assert.equal(String(P.zob.side),primitives.zob.side); assert.equal(String(P.zob.noPawns),primitives.zob.noPawns);
  assert.deepEqual(P.cuckoo.map(String),primitives.cuckoo); assert.deepEqual(Array.from(P.cuckooMove),primitives.cuckooMove);
});
test('position, generation order, SEE, checks, transitions and incremental NNUE match Python', () => {
  const thresholds = [-1024,-214,-83,-1,0,1,208,825];
  for (const fixture of fixtures) {
    const pos = new P.Position(false); pos.set(fixture.fen);
    compareState(pos,fixture.state,fixture.fen);
    for (let kind = 0; kind < 5; kind++) if (fixture.generation[kind]) assert.deepEqual(G.generate(pos,kind).map(e=>e.move),fixture.generation[kind],`${fixture.fen} generation ${kind}`);
    assert.deepEqual(G.generate_legal(pos).map(e=>e.move),fixture.legal);
    for (const child of fixture.children) {
      assert.equal(uci_move(child.move),child.uci);
      assert.equal(P.gives_check(pos,pos.st,child.move),child.check,child.uci);
      assert.deepEqual(thresholds.map(t=>P.see_test(pos,child.move,t)),child.see,child.uci);
      P.do_move(pos,child.move,child.check); compareState(pos,child.state,child.uci); refreshCheck(pos);
      P.undo_move(pos,child.move); compareState(pos,fixture.state,`undo ${child.uci}`);
    }
    if (fixture.null) {
      const nodes = pos.nodes; P.do_null_move(pos); compareState(pos,fixture.null,'null'); assert.equal(pos.nodes,nodes);
      P.undo_null_move(pos); compareState(pos,fixture.state,'undo null');
    }
  }
});
function perft(pos,d) {
  const moves = G.generate_legal(pos); if (d === 1) return moves.length;
  let count = 0;
  for (const ext of moves) { P.do_move(pos,ext.move,P.gives_check(pos,pos.st,ext.move)); count += perft(pos,d-1); P.undo_move(pos,ext.move); }
  return count;
}
test('standard perft cases and final board restoration', () => {
  for (const [index,depth,expected] of [[0,4,197281],[1,3,97862],[2,3,2812]]) {
    const pos = new P.Position(false); pos.set(fixtures[index].fen); const original = state(pos);
    assert.equal(perft(pos,depth),expected); compareState(pos,original,'perft restore');
  }
});
test('root copying keeps worker tables and resets controls without aliasing game state', () => {
  const root = new P.Position(false); set_position(root,'position startpos moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8');
  const worker = new P.Position(); const histories = worker.counterMoveHistory;
  worker.mainHistory[0][22] = 5; worker.nodes = 123; worker.copy_root_from(root);
  compareState(worker,state(root),'copied root'); assert.equal(worker.nodes,0); assert.equal(worker.mainHistory[0][22],5);
  assert.equal(worker.counterMoveHistory,histories); assert.notEqual(worker.st,root.st);
  assert.equal(worker.hasRepeated,true); assert.equal(worker.rootKeyFlip,root.rootKeyFlip);
  worker.st.accumulator.colors[0][0]++; assert.notEqual(worker.st.accumulator.colors[0][0],root.st.accumulator.colors[0][0]);
});
test('200 seeded legal-move steps match Python at every intermediate state', () => {
  const pos = new P.Position(false); pos.set(StartFEN);
  for (const step of sequences.steps) {
    if (step.reset) { pos.set(StartFEN); continue; }
    assert.deepEqual(G.generate_legal(pos).map(e=>e.move),step.legal);
    assert.equal(P.gives_check(pos,pos.st,step.move),step.check);
    const before = state(pos);
    P.do_move(pos,step.move,step.check); compareState(pos,step.state,'sequence move'); refreshCheck(pos);
    P.undo_move(pos,step.move); compareState(pos,before,'sequence undo');
    P.do_move(pos,step.move,step.check); compareState(pos,step.state,'sequence replay');
  }
});
test('UCI preparation, game-history filtering and draw/cycle decisions match Python', () => {
  const pos = new P.Position(false);
  for (const fixture of sequences.roots) {
    set_position(pos,fixture.command); compareState(pos,fixture.state,fixture.command);
    assert.equal(pos.hasRepeated,fixture.hasRepeated);
    assert.equal(String(pos.rootKeyFlip),fixture.rootKeyFlip);
    assert.deepEqual(pos.stack.slice(0,pos.st_idx+1).map(s=>String(s.key)),fixture.keys);
    assert.equal(P.is_draw(pos),fixture.draw);
    assert.deepEqual([0,1,4,8].map(ply=>P.has_game_cycle(pos,ply)),fixture.cycles);
  }
});
test('full position/NNUE/move-generation bundle runs in classic Worker context', () => {
  const source = bundle(['constants.mjs','generated/magics.mjs','bitboard.mjs','generated/nnue.mjs','nnue.mjs',
    'position.mjs','movegen.mjs','evaluate.mjs','notation.mjs'],['Position','generate_legal','StartFEN','evaluate']);
  const sandbox = {atob}; vm.runInNewContext(source,sandbox);
  const pos = new sandbox.NadduCore.Position(false); pos.set(sandbox.NadduCore.StartFEN);
  assert.equal(sandbox.NadduCore.generate_legal(pos).length,20); assert.equal(sandbox.NadduCore.evaluate(pos),62);
});
