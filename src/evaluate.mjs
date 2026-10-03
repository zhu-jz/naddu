import {W_PAWN, B_PAWN, VALUE_TB_LOSS_IN_MAX_PLY, VALUE_TB_WIN_IN_MAX_PLY, c_div, clamp} from './constants.mjs';
import {nnue_evaluate} from './nnue.mjs';
export function evaluate(pos) {
  const st = pos.st, us = pos.sideToMove, counts = pos.pieceCount;
  const nnue = nnue_evaluate(st.accumulator, us);
  const material = 592 * (counts[W_PAWN] + counts[B_PAWN]) + (st.nonPawn & 65535) + Math.floor(st.nonPawn / 65536);
  let v = c_div(nnue * (77045 + material) + pos.optimism[us] * (7446 + material), 88903);
  v -= c_div(v * st.rule50, 256);
  return clamp(v, VALUE_TB_LOSS_IN_MAX_PLY + 1, VALUE_TB_WIN_IN_MAX_PLY - 1);
}
