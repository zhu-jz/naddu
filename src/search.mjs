import {WHITE, BLACK, MAX_MOVES, MAX_PLY, MOVE_NULL, PROMOTION, BOUND_NONE, BOUND_UPPER,
  BOUND_LOWER, BOUND_EXACT, DEPTH_NONE, DEPTH_QS_CHECKS, DEPTH_QS_NO_CHECKS,
  VALUE_ZERO, VALUE_DRAW, VALUE_NONE, VALUE_INFINITE, VALUE_KNOWN_WIN, VALUE_MATE,
  VALUE_TB_WIN_IN_MAX_PLY, VALUE_TB_LOSS_IN_MAX_PLY, c_div, clamp, make_key,
  mate_in, mated_in, from_sq, to_sq, type_of_m, type_of_p, at} from './constants.mjs';
import {Position, PieceValue, create_counter_move_history, clear_counter_move_history,
  is_capture_or_promotion, gives_check, see_test, do_move, undo_move, do_null_move,
  undo_null_move, is_legal, is_draw, has_game_cycle} from './position.mjs';
import {generate_legal} from './movegen.mjs';
import {mp_init, mp_init_q, mp_init_probcut, next_move} from './movepick.mjs';
import {PIECE_TO_HISTORY_GRAIN, CounterMovePruneThreshold, history_update,
  capture_history_update, correction_value, correction_history_update,
  non_pawn_correction_history_update, stat_bonus, stat_malus, update_continuation_histories,
  update_quiet_histories, clear_histories} from './history.mjs';
import {tt_probe, tte_save, tte_value, tte_move, tte_eval, tte_depth, tte_is_pv,
  tte_bound, tt_new_search, tt_clear, value_to_tt, value_from_tt} from './tt.mjs';
import {evaluate} from './evaluate.mjs';
export const Reductions = Array(MAX_MOVES).fill(0), NonPV = 0, PV = 1;
export function search_init() { for (let i = 1; i < MAX_MOVES; i++) Reductions[i] = Math.trunc(21.14*Math.log(i)); }
export function futility_margin(d,improving,opponentWorsening) {
  return 180*d-Math.floor(180*Number(improving)/2)-Math.floor(180*Number(opponentWorsening)/3);
}
export function reduction(improving,d,mn,delta,rootDelta) {
  const scale = Reductions[d]*Reductions[mn];
  return scale+1239-c_div(delta*795,rootDelta)+Number(!improving && scale>1341)*1135;
}
export function futility_move_count(improving,depth) { return improving ? 3+depth*depth : Math.floor((3+depth*depth)/2); }
export function to_corrected_static_eval(v,cv) { return clamp(v+cv,VALUE_TB_LOSS_IN_MAX_PLY+1,VALUE_TB_WIN_IN_MAX_PLY-1); }
export function value_draw(pos) { return VALUE_DRAW+2*(pos.nodes&1)-1; }
export function update_pv(pv,move,child) {
  pv.length = 0; pv.push(move);
  if (child) for (const m of child) { if (!m) break; pv.push(m); }
  pv.push(0);
}
export function qsearch_node(pos,alpha,beta,depth,NT,InCheck) {
  const PvNode = NT === PV, st = pos.st, prev = pos.stack[pos.st_idx-1], prevMove = pos.st_idx>7 ? prev.currentMove : 0;
  if (depth < 0 && st.rule50 >= 3 && alpha < VALUE_DRAW && has_game_cycle(pos,st.ply)) {
    alpha = value_draw(pos); if (alpha >= beta) return alpha;
  }
  if (PvNode) { pos.pvArray[st.ply+1] = [0]; pos.pvArray[st.ply][0] = 0; }
  let bestMove = 0, moveCount = 0;
  if (is_draw(pos) || st.ply >= MAX_PLY) return st.ply >= MAX_PLY && !InCheck ? evaluate(pos) : VALUE_DRAW;
  const ttDepth = InCheck || depth >= DEPTH_QS_CHECKS ? DEPTH_QS_CHECKS : DEPTH_QS_NO_CHECKS;
  const posKey = st.rule50 < 14 ? st.key : st.key ^ make_key(Math.floor((st.rule50-14)/8));
  const [ttHit,tte] = tt_probe(posKey); st.ttHit = ttHit;
  const ttValue = ttHit ? value_from_tt(tte_value(tte),st.ply,st.rule50) : VALUE_NONE;
  const ttMove = ttHit ? tte_move(tte) : 0, pvHit = ttHit && tte_is_pv(tte), ttBound = ttHit ? tte_bound(tte) : 0;
  if (!PvNode && ttHit && tte_depth(tte) >= ttDepth && ttValue !== VALUE_NONE) {
    if ((ttValue >= beta && (ttBound & BOUND_LOWER)) || (ttValue < beta && (ttBound & BOUND_UPPER))) return ttValue;
  }
  let unadjusted = VALUE_NONE, bestValue, futilityBase; const cv = correction_value(pos);
  if (InCheck) bestValue = futilityBase = -VALUE_INFINITE;
  else {
    if (ttHit) {
      unadjusted = tte_eval(tte); if (unadjusted === VALUE_NONE) unadjusted = evaluate(pos);
      st.staticEval = bestValue = to_corrected_static_eval(unadjusted,cv);
      if (ttValue !== VALUE_NONE && (ttBound & (ttValue>bestValue ? BOUND_LOWER : BOUND_UPPER))) bestValue = ttValue;
    } else {
      unadjusted = prevMove !== MOVE_NULL ? evaluate(pos) : pos.st_idx>7 ? -prev.staticEval : evaluate(pos);
      st.staticEval = bestValue = to_corrected_static_eval(unadjusted,cv);
    }
    if (bestValue >= beta) {
      if (!ttHit) tte_save(tte,posKey,value_to_tt(bestValue,st.ply),false,BOUND_LOWER,DEPTH_NONE,0,unadjusted);
      return bestValue;
    }
    if (bestValue > alpha) alpha = bestValue;
    futilityBase = st.staticEval+139;
  }
  st.history = pos.counterMoveHistory[0][0];
  const prevSq = prevMove && from_sq(prevMove) !== to_sq(prevMove) ? to_sq(prevMove) : 64;
  mp_init_q(pos,ttMove,depth,prevSq);
  const board = pos.board, counterHistory = pos.counterMoveHistory, cmh = prev.history, fmh = pos.stack[pos.st_idx-2].history;
  while (true) {
    const move = next_move(pos,false); if (!move) break; if (!is_legal(pos,move)) continue;
    const check = gives_check(pos,st,move); moveCount++; const to = move&63, movedPiece = board[(move>>6)&63];
    if (bestValue > VALUE_TB_LOSS_IN_MAX_PLY && !check && to !== prevSq && futilityBase > -VALUE_KNOWN_WIN && type_of_m(move) !== PROMOTION) {
      if (moveCount>2) continue;
      const futility = futilityBase+PieceValue[board[to]];
      if (futility <= alpha) { bestValue = Math.max(bestValue,futility); continue; }
      if (futilityBase <= alpha && !see_test(pos,move,1)) { bestValue = Math.max(bestValue,futilityBase); continue; }
    }
    if (!is_capture_or_promotion(pos,move)) {
      const hidx = movedPiece*64+to;
      if (PIECE_TO_HISTORY_GRAIN*cmh[hidx] < CounterMovePruneThreshold && PIECE_TO_HISTORY_GRAIN*fmh[hidx] < CounterMovePruneThreshold) continue;
    }
    if (!see_test(pos,move,-83)) continue;
    st.currentMove = move; st.history = counterHistory[movedPiece][to]; do_move(pos,move,check);
    const val = -qsearch_node(pos,-beta,PvNode ? -alpha : -beta+1,depth-1,PvNode ? PV : NonPV,!!pos.st.checkersBB);
    undo_move(pos,move);
    if (val > bestValue) {
      bestValue = val;
      if (val > alpha) {
        bestMove = move;
        if (PvNode) update_pv(pos.pvArray[st.ply],move,pos.pvArray[st.ply+1]);
        if (val < beta) alpha = val; else break;
      }
    }
  }
  if (InCheck && bestValue === -VALUE_INFINITE) return mated_in(st.ply);
  tte_save(tte,posKey,value_to_tt(bestValue,st.ply),pvHit,bestValue>=beta ? BOUND_LOWER : BOUND_UPPER,ttDepth,bestMove,unadjusted);
  return bestValue;
}
search_init();
