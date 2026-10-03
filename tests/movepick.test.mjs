import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Position,is_capture} from '../src/position.mjs';
import {generate_legal,ExtMove} from '../src/movegen.mjs';
import {make_move,to_sq} from '../src/constants.mjs';
import {mp_init,mp_init_q,mp_init_probcut,next_move,partial_insertion_sort} from '../src/movepick.mjs';
const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/pickers.json',import.meta.url)));
test('staged move pickers match Python with seeded histories, killers, TT and skipped quiets', () => {
  for (const fixture of expected.pickers) {
    const pos = new Position(); pos.set(fixture.fen); pos.st.ply = 3;
    for (let c = 0; c < 2; c++) for (let i = 0; i < 4096; i++) pos.mainHistory[c][i] = ((i*13+c*31)%255)-128;
    for (let i = 0; i < 7; i++) {
      const row = pos.counterMoveHistory[i+1][i];
      for (let j = 0; j < 1024; j++) row[j] = ((j*11+i*29)%255)-128;
      pos.stack[i].history = row; pos.stack[i].currentMove = make_move(8+i,16+i);
    }
    for (let pc = 0; pc < 16; pc++) for (let s = 0; s < 64; s++) for (let t = 0; t < 8; t++) pos.captureHistory[pc][s][t] = ((pc*1103+s*117+t*101)%60000)-30000;
    const legal = generate_legal(pos).map(e=>e.move), quiets = legal.filter(m=>!is_capture(pos,m));
    pos.killers[3] = [...quiets,0,0].slice(0,2);
    const prevSq = to_sq(pos.stack[pos.st_idx-1].currentMove); pos.counterMoves[pos.board[prevSq]][prevSq] = quiets.at(-1)||0;
    const ttm = fixture.tt_choice === 0 ? 0 : legal.length && fixture.tt_choice === 1 ? legal[0] : 65535;
    if (fixture.kind === 'main') mp_init(pos,ttm,fixture.depth,3);
    else if (fixture.kind === 'qs') mp_init_q(pos,ttm,fixture.depth,legal.length ? to_sq(legal[0]) : 64);
    else mp_init_probcut(pos,ttm,fixture.depth);
    const order = [];
    while (true) {
      const move = next_move(pos,order.length >= fixture.skip_after); if (!move) break;
      order.push([move,pos.st.stage,pos.st.cur_idx]); assert.ok(order.length <= 256);
    }
    assert.deepEqual(order,fixture.order,`${fixture.fen} ${fixture.kind} ${fixture.depth} ${fixture.tt_choice}`);
  }
});
test('partial insertion sorting preserves Python ties and below-limit rearrangements', () => {
  for (const fixture of expected.sorts) {
    const moves = [0,-30,20,20,-5,30,0,20].map((v,i)=>new ExtMove(i+1,v));
    partial_insertion_sort(moves,fixture.limit); assert.deepEqual(moves.map(m=>[m.move,m.value]),fixture.order);
  }
});
