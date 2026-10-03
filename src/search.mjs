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
import {EngineOptions, Limits, Threads, mainThread, emit_output} from './control.mjs';
import {time_init, time_elapsed, time_optimum, time_maximum} from './timeman.mjs';
import {uci_move, uci_value} from './notation.mjs';
export const Reductions = Array(MAX_MOVES).fill(0), NonPV = 0, PV = 1;
export class RootMove {
  constructor(move = 0) { this.pv = Array(MAX_PLY+1).fill(0); this.averageScore = 0; this.reset_for_search(move); }
  reset_for_search(move) { this.pvSize = 1; this.pv[0] = move; this.score = -VALUE_INFINITE; this.previousScore = -VALUE_INFINITE; this.selDepth = 0; }
}
export class RootMoves { constructor() { this.size = 0; this.move = Array.from({length:MAX_MOVES},()=>new RootMove()); } }
export function init_search_sentinels(pos) {
  const history = pos.counterMoveHistory[0][0];
  for (let i = pos.st_idx-7; i < pos.st_idx; i++) {
    const st = pos.stack[i]; st.history = history; st.staticEval = VALUE_NONE; st.checkersBB = 0n;
    st.currentMove = 0; st.moveCount = 0; st.excludedMove = 0; st.ttHit = false;
  }
}
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
export function use_time_management() { return Limits.time[WHITE]>0 || Limits.time[BLACK]>0; }
export function check_time() {
  const elapsed = time_elapsed(); if (Threads.ponder) return;
  if ((use_time_management() && elapsed > time_maximum()-10) || (Limits.movetime && elapsed >= Limits.movetime)
    || (Limits.nodes && Threads.nodes_searched() >= Limits.nodes)) Threads.request_stop();
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
    const val = -qsearch_node(pos,-beta,PvNode ? -alpha : -beta+1,depth-1,PvNode ? PV : NonPV,!!pos.st.checkersBB) || 0;
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
export function search_node(pos,alpha,beta,depth,cutNode,NT) {
  const PvNode = NT === PV, st = pos.st, prev = pos.stack[pos.st_idx-1], inCheck = !!st.checkersBB;
  const rootNode = PvNode && st.ply === 0;
  if (st.pliesFromNull>=3 && alpha < VALUE_DRAW && !rootNode && has_game_cycle(pos,st.ply)) {
    alpha = value_draw(pos); if (alpha >= beta) return alpha;
  }
  if (depth<=0) return qsearch_node(pos,alpha,beta,0,NT,inCheck);
  let bestValue = -VALUE_INFINITE, maxValue = VALUE_INFINITE, bestMove = 0, moveCount = 0;
  st.moveCount = 0;
  if (pos.resetCalls) { pos.resetCalls = false; pos.callsCnt = 64; }
  pos.callsCnt--; if (pos.callsCnt<=0) { pos.resetCalls = true; check_time(); }
  if (PvNode && pos.selDepth < st.ply) pos.selDepth = st.ply;
  if (rootNode) pos.rootDelta = beta-alpha;
  if (!rootNode) {
    if (Threads.stop || is_draw(pos) || st.ply>=MAX_PLY) return st.ply>=MAX_PLY && !inCheck ? evaluate(pos) : value_draw(pos);
    if (PvNode) { alpha = Math.max(mated_in(st.ply),alpha); beta = Math.min(mate_in(st.ply+1),beta); if (alpha>=beta) return alpha; }
    else { if (alpha<mated_in(st.ply)) return mated_in(st.ply); if (alpha>=mate_in(st.ply+1)) return alpha; }
  }
  pos.ttPv[st.ply+1] = false; pos.killers[st.ply+2][0] = pos.killers[st.ply+2][1] = 0; pos.cutoffCnt[st.ply+2] = 0;
  pos.doubleExtensions[st.ply] = at(pos.doubleExtensions,st.ply-1); if (!rootNode) pos.statScore[st.ply+2] = 0;
  const excluded = st.excludedMove;
  let posKey = st.rule50<14 ? st.key : st.key ^ make_key(Math.floor((st.rule50-14)/8)); if (excluded) posKey ^= make_key(excluded);
  const [ttHit,tte] = tt_probe(posKey); st.ttHit = ttHit;
  const ttValue = ttHit ? value_from_tt(tte_value(tte),st.ply,st.rule50) : VALUE_NONE;
  const ttMove = rootNode && pos.rootMoves.size>0 ? pos.rootMoves.move[pos.pvIdx].pv[0] : ttHit ? tte_move(tte) : 0;
  let ttCapture = !!(ttMove && is_capture_or_promotion(pos,ttMove));
  const ttDepth = ttHit ? tte_depth(tte) : 0, ttBound = ttHit ? tte_bound(tte) : 0;
  if (!excluded) pos.ttPv[st.ply] = PvNode || (ttHit && tte_is_pv(tte));
  if (!PvNode && !excluded && ttHit && ttDepth > depth-Number(ttValue<=beta) && ttValue !== VALUE_NONE) {
    if ((ttValue>=beta && (ttBound & BOUND_LOWER)) || (ttValue<beta && (ttBound & BOUND_UPPER))) {
      if (ttMove && ttValue>=beta) {
        if (!ttCapture) update_quiet_histories(pos,ttMove,c_div(stat_bonus(depth)*1124,1024));
        const prevSq = to_sq(prev.currentMove);
        if (prevSq!==64 && prev.moveCount<=2 && !st.capturedPiece) update_continuation_histories(pos,pos.board[prevSq],prevSq,c_div(-stat_malus(depth)*1840,1024),1);
      }
      if (st.rule50<90) return ttValue;
    }
  }
  let unadjusted = VALUE_NONE, evalValue, improving; const cv = correction_value(pos);
  if (inCheck) { evalValue = st.staticEval = pos.stack[pos.st_idx-2].staticEval; improving = false; }
  else if (ttHit) {
    unadjusted = tte_eval(tte); if (unadjusted === VALUE_NONE) unadjusted = evaluate(pos);
    st.staticEval = evalValue = to_corrected_static_eval(unadjusted,cv); if (evalValue === VALUE_DRAW) evalValue = value_draw(pos);
    if (ttValue !== VALUE_NONE && (ttBound & (ttValue>evalValue ? BOUND_LOWER : BOUND_UPPER))) evalValue = ttValue;
  } else {
    unadjusted = evaluate(pos); st.staticEval = evalValue = to_corrected_static_eval(unadjusted,cv);
    if (!excluded) tte_save(tte,posKey,VALUE_NONE,pos.ttPv[st.ply],BOUND_NONE,DEPTH_NONE,0,unadjusted);
  }
  let opponentWorsening = false; const ownNonPawn = Math.floor(st.nonPawn/(2**(16*pos.sideToMove)))&65535;
  if (!inCheck) {
    if (from_sq(prev.currentMove)!==to_sq(prev.currentMove) && !prev.checkersBB && !st.capturedPiece) {
      const bonus = clamp(-16*(prev.staticEval+st.staticEval),-2000,2000); history_update(pos.mainHistory,1-pos.sideToMove,prev.currentMove,bonus);
    }
    improving = st.staticEval>pos.stack[pos.st_idx-2].staticEval; opponentWorsening = st.staticEval+prev.staticEval>2;
    if (!PvNode && evalValue<alpha-469-307*depth*depth) return qsearch_node(pos,alpha-1,alpha,0,NonPV,false);
    if (!pos.ttPv[st.ply] && depth<8 && evalValue-futility_margin(depth,improving,opponentWorsening)-c_div(at(pos.statScore,st.ply-1),256)-Math.abs(cv)>=beta && evalValue>=beta && evalValue<22266) return evalValue;
    if (!PvNode && prev.currentMove!==MOVE_NULL && at(pos.statScore,st.ply-1)<15075 && evalValue>=beta && evalValue>=st.staticEval
      && st.staticEval>=beta-23*depth+201-5*Number(improving) && !excluded && ownNonPawn && st.ply>=pos.nmpMinPly) {
      const R = Math.min(c_div(evalValue-beta,189),6)+Math.floor(depth/3)+4;
      st.currentMove = MOVE_NULL; st.history = pos.counterMoveHistory[0][0]; do_null_move(pos);
      let nullValue = -search_node(pos,-beta,-beta+1,depth-R,!cutNode,NonPV) || 0; undo_null_move(pos);
      if (nullValue>=beta) {
        nullValue = Math.min(nullValue,VALUE_TB_WIN_IN_MAX_PLY-1);
        if (pos.nmpMinPly || depth<14) return nullValue;
        pos.nmpMinPly = st.ply+c_div(3*(depth-R),4);
        const value = search_node(pos,beta-1,beta,depth-R,false,NonPV); pos.nmpMinPly = 0;
        if (value>=beta) return nullValue;
      }
    }
    const probBeta = beta+170-53*Number(improving)-30*Number(opponentWorsening);
    if (!PvNode && depth>3 && Math.abs(beta)<VALUE_TB_WIN_IN_MAX_PLY && !(ttHit && ttDepth>=depth-3 && ttValue!==VALUE_NONE && ttValue<probBeta)) {
      mp_init_probcut(pos,ttMove,probBeta-st.staticEval);
      while (true) {
        const move = next_move(pos,false); if (!move) break;
        if (move!==excluded && is_legal(pos,move)) {
          st.currentMove = move; st.history = pos.counterMoveHistory[pos.board[from_sq(move)]][to_sq(move)];
          const check = gives_check(pos,st,move); do_move(pos,move,check);
          let val = -qsearch_node(pos,-probBeta,-probBeta+1,0,NonPV,!!pos.st.checkersBB) || 0;
          if (val>=probBeta) val = -search_node(pos,-probBeta,-probBeta+1,depth-4,!cutNode,NonPV) || 0;
          undo_move(pos,move);
          if (val>=probBeta) { tte_save(tte,posKey,value_to_tt(val,st.ply),pos.ttPv[st.ply],BOUND_LOWER,depth-3,move,unadjusted); return val-(probBeta-beta); }
        }
      }
    }
    if (PvNode && !ttMove) depth--;
    // This forced-check fallback is part of the pinned Python behavior.
    if (depth<=0) return qsearch_node(pos,alpha,beta,0,PV,true);
    if (cutNode && depth>=8 && !ttMove) depth--;
  }
  const checkedProbBeta = beta+401;
  if (inCheck && !PvNode && ttCapture && ttHit && (ttBound & BOUND_LOWER) && ttDepth>=depth-4 && ttValue>=checkedProbBeta && Math.abs(ttValue)<=VALUE_KNOWN_WIN && Math.abs(beta)<=VALUE_KNOWN_WIN) return checkedProbBeta;
  mp_init(pos,ttMove,depth,st.ply); let moveCountPruning = false;
  const likelyFailLow = !!(PvNode && ttMove && ttHit && (ttBound & BOUND_UPPER) && ttDepth>=depth);
  const cmh = prev.history, fmh = pos.stack[pos.st_idx-2].history, fmh2 = pos.stack[pos.st_idx-4].history;
  const board = pos.board, mainHistory = pos.mainHistory[pos.sideToMove], captureHistory = pos.captureHistory, counterHistory = pos.counterMoveHistory;
  const capturesSearched = [], quietsSearched = [], rootByMove = new Map();
  if (rootNode) for (let i = pos.pvIdx; i < pos.pvLast; i++) { const rm = pos.rootMoves.move[i]; rootByMove.set(rm.pv[0],rm); }
  while (true) {
    const move = next_move(pos,moveCountPruning); if (!move) break; if (move===excluded) continue;
    let rm; if (rootNode) { rm = rootByMove.get(move); if (!rm) continue; }
    if (!rootNode && !is_legal(pos,move)) continue;
    moveCount++; st.moveCount = moveCount; if (PvNode) pos.pvArray[st.ply+1] = null;
    if (rootNode && pos.threadIdx===0 && time_elapsed()>3000) emit_output(`info depth ${depth} currmove ${uci_move(move,pos.chess960)} currmovenumber ${moveCount+pos.pvIdx}`);
    const from = (move>>6)&63, to = move&63, captureOrPromotion = is_capture_or_promotion(pos,move), movedPiece = board[from], hidx = movedPiece*64+to;
    const check = gives_check(pos,st,move); let newDepth = depth-1, r = reduction(improving,depth,moveCount,beta-alpha,pos.rootDelta);
    if (!rootNode && ownNonPawn && bestValue>VALUE_TB_LOSS_IN_MAX_PLY) {
      if (!moveCountPruning) moveCountPruning = moveCount>=futility_move_count(improving,depth);
      let lmrDepth = Math.max(newDepth-c_div(r,1024),0);
      if (captureOrPromotion || check) {
        if (board[to]!==0 && !check && !PvNode && lmrDepth<7 && !inCheck && st.staticEval+424+138*lmrDepth+PieceValue[board[to]]+c_div(captureHistory[movedPiece][to][type_of_p(board[to])],7)<alpha) continue;
        if (!see_test(pos,move,-214*depth)) continue;
      } else {
        let hist = PIECE_TO_HISTORY_GRAIN*(cmh[hidx]+fmh[hidx]+fmh2[hidx]);
        if (lmrDepth<4 && hist < -3875*(depth-1)) continue;
        hist += 2*64*mainHistory[move&4095]; lmrDepth += c_div(hist,16384);
        const futility = st.staticEval+(bestMove ? 147 : 237)+125*lmrDepth+c_div(hist,64);
        if (!inCheck && lmrDepth<11 && futility<=alpha) continue;
        lmrDepth = Math.max(lmrDepth,0); if (!see_test(pos,move,-25*lmrDepth*lmrDepth)) continue;
      }
    }
    let extension = 0;
    if (st.ply<pos.rootDepth*2) {
      if (depth>=6+2*Number(PvNode && tte_is_pv(tte)) && move===ttMove && !rootNode && !excluded
        && Math.abs(ttValue)<VALUE_KNOWN_WIN && (ttBound & BOUND_LOWER) && ttDepth>=depth-3) {
        const singularBeta = ttValue-(3+Number(pos.ttPv[st.ply] && !PvNode))*depth, singularDepth = Math.floor((depth-1)/2);
        st.excludedMove = move; const cm = st.countermove, k1 = st.mpKillers[0], k2 = st.mpKillers[1];
        const value = search_node(pos,singularBeta-1,singularBeta,singularDepth,cutNode,NonPV); st.excludedMove = 0;
        if (value<singularBeta) {
          extension = 1;
          if (!PvNode && value<singularBeta-32 && pos.doubleExtensions[st.ply]<=10) {
            ttCapture = !!(ttMove && is_capture_or_promotion(pos,ttMove)); extension = 2+Number(value<singularBeta-200 && !ttCapture); depth += Number(depth<12);
          }
        } else if (value>=beta && value>VALUE_TB_LOSS_IN_MAX_PLY && value<VALUE_TB_WIN_IN_MAX_PLY) return value;
        else if (ttValue>=beta) extension = -2;
        else if (ttValue<=alpha || cutNode) extension = -1;
        mp_init(pos,ttMove,depth,st.ply); st.stage++; st.countermove = cm; st.mpKillers[0] = k1; st.mpKillers[1] = k2;
      } else if (check && depth>8) extension = 1;
    }
    newDepth += extension; pos.doubleExtensions[st.ply] = at(pos.doubleExtensions,st.ply-1)+Number(extension>=2);
    const prevMoveCount = prev.moveCount; st.currentMove = move; st.history = counterHistory[movedPiece][to]; do_move(pos,move,check);
    if (rootNode) pos.stack[pos.st_idx-1].key ^= pos.rootKeyFlip;
    if (pos.cutoffCnt[st.ply+1]>3) r += 1024;
    if (pos.ttPv[st.ply] && !likelyFailLow) r -= 2048;
    if (prevMoveCount>7) r -= 1024;
    r -= Math.abs(cv)*4; if (cutNode) r += 2048; if (ttCapture) r += 1024; if (PvNode) r -= 1024;
    const statScore = 2*PIECE_TO_HISTORY_GRAIN*cmh[hidx]+PIECE_TO_HISTORY_GRAIN*fmh[hidx]+PIECE_TO_HISTORY_GRAIN*fmh2[hidx]+64*mainHistory[move&4095]-4123;
    pos.statScore[st.ply] = statScore; r -= c_div(statScore,10500+4500*Number(depth>7 && depth<19))*1024;
    let val;
    if (depth>=2 && moveCount>1+Number(PvNode && st.ply<=1) && (!pos.ttPv[st.ply] || !captureOrPromotion || (cutNode && prevMoveCount>1))) {
      const d = clamp(newDepth-c_div(r,1024),1,newDepth+1); val = -search_node(pos,-(alpha+1),-alpha,d,true,NonPV) || 0;
      if (val>alpha && d<newDepth) {
        newDepth += Number(val>bestValue+42+2*newDepth)-Number(val<bestValue+newDepth);
        if (newDepth>d) val = -search_node(pos,-(alpha+1),-alpha,newDepth,!cutNode,NonPV) || 0;
        const bonus = val<=alpha ? -stat_malus(newDepth) : val>=beta ? stat_bonus(newDepth) : 0;
        update_continuation_histories(pos,movedPiece,to,bonus,1);
      }
    } else if (!PvNode || moveCount>1) val = -search_node(pos,-(alpha+1),-alpha,newDepth,!cutNode,NonPV) || 0;
    if (PvNode && (moveCount===1 || (val>alpha && (rootNode || val<beta)))) {
      pos.pvArray[st.ply+1] = [0]; val = -search_node(pos,-beta,-alpha,newDepth,false,PV) || 0;
    }
    if (rootNode) pos.stack[pos.st_idx-1].key ^= pos.rootKeyFlip;
    undo_move(pos,move); if (Threads.stop) return 0;
    if (rootNode) {
      rm.averageScore = rm.averageScore!==-VALUE_INFINITE ? c_div(2*val+rm.averageScore,3) : val;
      if (moveCount===1 || val>alpha) {
        rm.score = val; rm.selDepth = pos.selDepth; rm.pvSize = 1;
        if (pos.pvArray[st.ply+1] !== null) for (const m of pos.pvArray[st.ply+1]) { if (!m) break; if (rm.pvSize<rm.pv.length) rm.pv[rm.pvSize++] = m; }
        if (moveCount>1) pos.bestMoveChanges++;
      } else rm.score = -VALUE_INFINITE;
    }
    if (val>bestValue) {
      bestValue = val;
      if (val>alpha) {
        bestMove = move; if (PvNode && !rootNode) update_pv(pos.pvArray[st.ply],move,pos.pvArray[st.ply+1]);
        if (val>=beta) { if (pos.cutoffCnt[st.ply]<254) pos.cutoffCnt[st.ply] += 1+Number(!ttMove); break; }
        if (depth>1 && beta<12535 && val>-12535) depth--; alpha = val;
      }
    }
    if (move!==bestMove && moveCount<=32) (captureOrPromotion ? capturesSearched : quietsSearched).push(move);
  }
  const prevSq = to_sq(prev.currentMove), bestCapture = !!(bestMove && is_capture_or_promotion(pos,bestMove));
  if (!moveCount) bestValue = excluded ? alpha : inCheck ? mated_in(st.ply) : VALUE_DRAW;
  else if (bestMove) {
    const bestTo = to_sq(bestMove);
    if (!bestCapture) {
      const bonusDepth = depth+Number(bestValue>beta+140), bonus = stat_bonus(bonusDepth), malus = stat_malus(bonusDepth);
      update_quiet_histories(pos,bestMove,c_div(bonus*873,1024));
      const quietMalus = c_div(-malus*1185,1024), continuationMalus = c_div(-malus*1189,1024);
      for (const m of quietsSearched) { history_update(pos.mainHistory,pos.sideToMove,m,quietMalus); update_continuation_histories(pos,board[from_sq(m)],to_sq(m),continuationMalus,0); }
    }
    const bonus = stat_bonus(depth), malus = stat_malus(depth);
    if (bestCapture) capture_history_update(captureHistory,board[from_sq(bestMove)],bestTo,type_of_p(board[bestTo]),c_div(bonus*839,1024));
    if ((prev.moveCount===1+Number(prev.ttHit) || prev.currentMove===at(pos.killers,st.ply-1)[0]) && !st.capturedPiece) update_continuation_histories(pos,board[prevSq],prevSq,c_div(-malus*993,1024),1);
    const captureMalus = c_div(-malus*1040,1024);
    for (const m of capturesSearched) capture_history_update(captureHistory,board[from_sq(m)],to_sq(m),type_of_p(board[to_sq(m)]),captureMalus);
  } else if (!st.capturedPiece && prevSq!==64) {
    let b = 117*Number(depth>5)+39*Number(PvNode || cutNode)+168*Number(prev.moveCount>8)
      +115*Number(!st.checkersBB && bestValue<=st.staticEval-108)+119*Number(!prev.checkersBB && bestValue<=-prev.staticEval-83);
    b += Math.min(c_div(-at(pos.statScore,st.ply-1),113),300); b = Math.max(b,0);
    update_continuation_histories(pos,board[prevSq],prevSq,c_div(stat_bonus(depth)*b,160),1);
    history_update(pos.mainHistory,1-pos.sideToMove,prev.currentMove,c_div(stat_bonus(depth)*b,307));
  }
  if (PvNode) bestValue = Math.min(bestValue,maxValue);
  if (bestValue<=alpha) pos.ttPv[st.ply] = pos.ttPv[st.ply] || at(pos.ttPv,st.ply-1);
  else if (depth>3) pos.ttPv[st.ply] = pos.ttPv[st.ply] && pos.ttPv[st.ply+1];
  if (!excluded && !(rootNode && pos.pvIdx)) tte_save(tte,posKey,value_to_tt(bestValue,st.ply),pos.ttPv[st.ply],bestValue>=beta ? BOUND_LOWER : PvNode && bestMove ? BOUND_EXACT : BOUND_UPPER,depth,bestMove,unadjusted);
  if (!inCheck && !bestCapture && !(bestValue>=beta && bestValue<=st.staticEval) && !(!bestMove && bestValue>=st.staticEval)) {
    const bonus = clamp(c_div((bestValue-st.staticEval)*depth,8),-256,256);
    correction_history_update(pos.correctionHistory,pos.sideToMove,pos,bonus);
    non_pawn_correction_history_update(pos.nonPawnCorrectionHistory,WHITE,pos.sideToMove,pos,bonus);
    non_pawn_correction_history_update(pos.nonPawnCorrectionHistory,BLACK,pos.sideToMove,pos,bonus);
  }
  return bestValue;
}
search_init();
