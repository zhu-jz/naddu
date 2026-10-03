import {c_div, clamp} from './constants.mjs';
import {lsb} from './bitboard.mjs';
import {NETWORK_BASE64} from './generated/nnue.mjs';

export const HIDDEN_WIDTH = 64, NETWORK_SCALE = 340, NETWORK_QA = 101, NETWORK_QB = 160;
export const DP_NORMAL = 0, DP_CAPTURE = 1, DP_CASTLING = 2;
export class SquarePiece { constructor(sq = 0, pc = 0) { this.sq = sq; this.pc = pc; } }
export class DirtyPieces {
  constructor() {
    this.sub0 = new SquarePiece(); this.add0 = new SquarePiece();
    this.sub1 = new SquarePiece(); this.add1 = new SquarePiece(); this.type = DP_NORMAL;
  }
}
export class NNUEAccumulator {
  constructor() { this.colors = [new Int32Array(64), new Int32Array(64)]; }
}
export const NNUE = {weights: null, featureTransformerBiases: null, outputWeights: null, outputBias: 0};
export function nnue_init() {
  const raw = atob(NETWORK_BASE64);
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const values = new Int16Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true);
  NNUE.weights = values.subarray(0, 49152);
  NNUE.featureTransformerBiases = values.subarray(49152, 49216);
  NNUE.outputWeights = [values.subarray(49216, 49280), values.subarray(49280, 49344)];
  NNUE.outputBias = values[49344];
}
export function NNUEfeatureAddress(squareXor, pov, pc, sq) {
  const offset = (((pov ^ (pc >> 3)) * 6 + ((pc & 7) - 1)) * 64 + (sq ^ squareXor)) * HIDDEN_WIDTH;
  return NNUE.weights.subarray(offset, offset + HIDDEN_WIDTH);
}
export function nnue_accumulator_refresh(accumulator, pos, pov, kingSquare) {
  const acc = accumulator.colors[pov];
  acc.set(NNUE.featureTransformerBiases);
  const xor = (pov * 56) ^ ((kingSquare & 4) ? 7 : 0);
  let b = pos.byTypeBB[0];
  while (b) {
    const square = lsb(b); b &= b - 1n;
    const feature = NNUEfeatureAddress(xor, pov, pos.board[square], square);
    for (let i = 0; i < HIDDEN_WIDTH; i++) acc[i] += feature[i];
  }
}
export function nnue_accumulator_update(accumulator, kingSquare, side, dp, previous) {
  const old = previous.colors[side], acc = accumulator.colors[side];
  const xor = (side * 56) ^ ((kingSquare & 4) ? 7 : 0);
  const from = NNUEfeatureAddress(xor, side, dp.sub0.pc, dp.sub0.sq);
  const to = NNUEfeatureAddress(xor, side, dp.add0.pc, dp.add0.sq);
  const sub = dp.type !== DP_NORMAL ? NNUEfeatureAddress(xor, side, dp.sub1.pc, dp.sub1.sq) : null;
  const add = dp.type === DP_CASTLING ? NNUEfeatureAddress(xor, side, dp.add1.pc, dp.add1.sq) : null;
  for (let i = 0; i < HIDDEN_WIDTH; i++) acc[i] = old[i] + to[i] - from[i] - (sub ? sub[i] : 0) + (add ? add[i] : 0);
}
export function nnue_evaluate(accumulator, side) {
  const ours = accumulator.colors[side], theirs = accumulator.colors[1 - side];
  const [ourWeights, theirWeights] = NNUE.outputWeights;
  let sum = 0;
  for (let i = 0; i < HIDDEN_WIDTH; i++) {
    const a = clamp(ours[i], 0, NETWORK_QA), b = clamp(theirs[i], 0, NETWORK_QA);
    sum += a * a * ourWeights[i] + b * b * theirWeights[i];
  }
  const unsquared = c_div(sum, NETWORK_QA) + NNUE.outputBias;
  return c_div(unsquared * NETWORK_SCALE, NETWORK_QA * NETWORK_QB);
}
nnue_init();
