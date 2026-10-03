export const MAX_MOVES = 256, MAX_PLY = 128;
export const MOVE_NONE = 0, MOVE_NULL = 65;
export const NORMAL = 0, PROMOTION = 1, ENPASSANT = 2, CASTLING = 3;
export const WHITE = 0, BLACK = 1, COLOR_NB = 2;
export const KING_SIDE = 0, QUEEN_SIDE = 1;
export const NO_CASTLING = 0, WHITE_OO = 1, WHITE_OOO = 2, BLACK_OO = 4, BLACK_OOO = 8, ANY_CASTLING = 15;
export function make_castling_right(c, s) { return c === WHITE ? (s === QUEEN_SIDE ? WHITE_OOO : WHITE_OO) : (s === QUEEN_SIDE ? BLACK_OOO : BLACK_OO); }
export const PHASE_ENDGAME = 0, PHASE_MIDGAME = 128, MG = 0, EG = 1;
export const SCALE_FACTOR_DRAW = 0, SCALE_FACTOR_NORMAL = 64, SCALE_FACTOR_MAX = 128, SCALE_FACTOR_NONE = 255;
export const BOUND_NONE = 0, BOUND_UPPER = 1, BOUND_LOWER = 2, BOUND_EXACT = 3;
export const VALUE_ZERO = 0, VALUE_DRAW = 0, VALUE_KNOWN_WIN = 10000;
export const VALUE_MATE = 32000, VALUE_INFINITE = 32001, VALUE_NONE = 32002;
export const MAX_MATE_PLY = MAX_PLY;
export const VALUE_TB_WIN_IN_MAX_PLY = VALUE_MATE - 2 * MAX_PLY;
export const VALUE_TB_LOSS_IN_MAX_PLY = -VALUE_MATE + 2 * MAX_PLY;
export const VALUE_MATE_IN_MAX_PLY = VALUE_MATE - MAX_PLY;
export const VALUE_MATED_IN_MAX_PLY = -VALUE_MATE + MAX_PLY;
export const PawnValue = 208, KnightValue = 781, BishopValue = 825, RookValue = 1276, QueenValue = 2538;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const W_PAWN = 1, W_KNIGHT = 2, W_BISHOP = 3, W_ROOK = 4, W_QUEEN = 5, W_KING = 6;
export const B_PAWN = 9, B_KNIGHT = 10, B_BISHOP = 11, B_ROOK = 12, B_QUEEN = 13, B_KING = 14;
export const PIECE_NB = 16;
export const DEPTH_QS_CHECKS = 0, DEPTH_QS_NO_CHECKS = -1, DEPTH_QS_RECAPTURES = -5, DEPTH_NONE = -6, DEPTH_OFFSET = -7;
export const [SQ_A1, SQ_B1, SQ_C1, SQ_D1, SQ_E1, SQ_F1, SQ_G1, SQ_H1,
  SQ_A2, SQ_B2, SQ_C2, SQ_D2, SQ_E2, SQ_F2, SQ_G2, SQ_H2,
  SQ_A3, SQ_B3, SQ_C3, SQ_D3, SQ_E3, SQ_F3, SQ_G3, SQ_H3,
  SQ_A4, SQ_B4, SQ_C4, SQ_D4, SQ_E4, SQ_F4, SQ_G4, SQ_H4,
  SQ_A5, SQ_B5, SQ_C5, SQ_D5, SQ_E5, SQ_F5, SQ_G5, SQ_H5,
  SQ_A6, SQ_B6, SQ_C6, SQ_D6, SQ_E6, SQ_F6, SQ_G6, SQ_H6,
  SQ_A7, SQ_B7, SQ_C7, SQ_D7, SQ_E7, SQ_F7, SQ_G7, SQ_H7,
  SQ_A8, SQ_B8, SQ_C8, SQ_D8, SQ_E8, SQ_F8, SQ_G8, SQ_H8] = Array.from({length: 64}, (_, i) => i);
export const SQ_NONE = 64, SQUARE_NB = 64;
export const NORTH = 8, EAST = 1, SOUTH = -8, WEST = -1;
export const NORTH_EAST = 9, SOUTH_EAST = -7, NORTH_WEST = 7, SOUTH_WEST = -9;
export const [FILE_A, FILE_B, FILE_C, FILE_D, FILE_E, FILE_F, FILE_G, FILE_H] = [0,1,2,3,4,5,6,7];
export const [RANK_1, RANK_2, RANK_3, RANK_4, RANK_5, RANK_6, RANK_7, RANK_8] = [0,1,2,3,4,5,6,7];
export function mate_in(ply) { return VALUE_MATE - ply; }
export function mated_in(ply) { return -VALUE_MATE + ply; }
export function make_square(f, r) { return (r << 3) + f; }
export function make_piece(c, pt) { return (c << 3) + pt; }
export function type_of_p(p) { return p & 7; }
export function color_of(p) { return p >> 3; }
export function square_is_ok(s) { return s >= 0 && s <= SQ_H8; }
export function file_of(s) { return s & 7; }
export function rank_of(s) { return s >> 3; }
export function relative_square(c, s) { return s ^ (c * 56); }
export function relative_rank(c, r) { return r ^ (c * 7); }
export function pawn_push(c) { return c === WHITE ? 8 : -8; }
export function from_sq(m) { return (m >> 6) & 63; }
export function to_sq(m) { return m & 63; }
export function type_of_m(m) { return m >> 14; }
export function promotion_type(m) { return ((m >> 12) & 3) + KNIGHT; }
export function make_move(from, to) { return to | (from << 6); }
export function make_promotion(from, to, pt) { return to | (from << 6) | (PROMOTION << 14) | ((pt - KNIGHT) << 12); }
export function make_enpassant(from, to) { return to | (from << 6) | (ENPASSANT << 14); }
export function make_castling(from, to) { return to | (from << 6) | (CASTLING << 14); }
export function c_div(a, b) { return Math.trunc(a / b) || 0; }
export function floor_div(a, b) { return Math.floor(a / b); }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function make_key(seed) { return (BigInt(seed) * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; }
// Python sequence indexing wraps negative indices; JS array properties do not.
export function at(values, i) { return values[i < 0 ? values.length + i : i]; }
