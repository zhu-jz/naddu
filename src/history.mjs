import {WHITE, BLACK, clamp, from_sq, to_sq, c_div} from './constants.mjs';
export const PIECE_TO_HISTORY_GRAIN = 128, PAWN_CORR_HIST_GRAIN = 8, CounterMovePruneThreshold = 0;
export function stat_bonus(depth) { return depth >= 7 ? 2121 : 388*depth-421; }
export function stat_malus(depth) { return depth >= 5 ? 1580 : 416*depth-284; }
export function correction_value(pos) {
  const st = pos.st, us = pos.sideToMove;
  const pcv = PAWN_CORR_HIST_GRAIN*pos.correctionHistory[us][Number(st.pawnKey&16383n)];
  const w = pos.nonPawnCorrectionHistory[WHITE][us][Number(st.nonPawnKey[WHITE]&8191n)];
  const b = pos.nonPawnCorrectionHistory[BLACK][us][Number(st.nonPawnKey[BLACK]&8191n)];
  return c_div(10*pcv+8*(w+b),128);
}
export function continuation_history_update(cms,idx,v) {
  const scaled = PIECE_TO_HISTORY_GRAIN*cms[idx];
  cms[idx] = clamp(c_div(scaled+v-c_div(scaled*Math.abs(v),50000),PIECE_TO_HISTORY_GRAIN),-128,127);
}
export function history_update(history,c,m,v) {
  m &= 4095; const row = history[c], scaled = 64*row[m];
  row[m] = clamp(c_div(scaled+v-c_div(scaled*Math.abs(v),7183),64),-128,127);
}
export function update_continuation_histories(pos,pc,s,bonus,offset = 0) {
  const idx = pos.st_idx-1-offset, historyIdx = pc*64+s;
  const update = (delta,scaledBonus) => {
    const index = idx-delta;
    if (index >= 0 && from_sq(pos.stack[index].currentMove) !== to_sq(pos.stack[index].currentMove)) continuation_history_update(pos.stack[index].history,historyIdx,scaledBonus);
  };
  update(0,c_div(bonus*949,1024)); update(1,c_div(bonus*1003,1024));
  const checkers = idx+1 < pos.st_idx ? pos.stack[idx+1].checkersBB : pos.st.checkersBB; if (checkers) return;
  update(2,c_div(bonus*149,256)); update(3,c_div(bonus*1001,1024)); update(4,c_div(bonus*122,1024)); update(5,c_div(bonus*977,1024));
}
export function update_quiet_histories(pos,move,bonus) {
  const killers = pos.killers[pos.st.ply]; if (killers[0] !== move) { killers[1] = killers[0]; killers[0] = move; }
  history_update(pos.mainHistory,pos.sideToMove,move,bonus);
  update_continuation_histories(pos,pos.board[from_sq(move)],to_sq(move),bonus,0);
  const prev = pos.stack[pos.st_idx-1].currentMove, square = to_sq(prev);
  if (from_sq(prev) !== square) pos.counterMoves[pos.board[square]][square] = move;
}
export function capture_history_update(history,pc,to,captured,v) {
  const row = history[pc][to], current = row[captured];
  const val = current+v-c_div(current*Math.abs(v),10692); row[captured] = ((val&65535)^32768)-32768;
}
export function correction_history_update(history,c,pos,v) {
  const idx = Number(pos.st.pawnKey&16383n), scaled = PAWN_CORR_HIST_GRAIN*history[c][idx];
  history[c][idx] = clamp(c_div(scaled+v-c_div(scaled*Math.abs(v),1024),PAWN_CORR_HIST_GRAIN),-128,127);
}
export function non_pawn_correction_history_update(history,c,stm,pos,v) {
  const idx = Number(pos.st.nonPawnKey[c]&8191n), row = history[c][stm], current = row[idx];
  const val = current+v-c_div(current*Math.abs(v),1024); row[idx] = ((val&65535)^32768)-32768;
}
export function clear_histories(pos) {
  for (const rows of [pos.counterMoves,pos.mainHistory,pos.correctionHistory]) for (const row of rows) row.fill(0);
  for (const table of [pos.captureHistory,pos.nonPawnCorrectionHistory]) for (const rows of table) for (const row of rows) row.fill(0);
}
