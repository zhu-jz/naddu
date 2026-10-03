import {WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, ENPASSANT, KING_SIDE,
  QUEEN_SIDE, WHITE_OO, WHITE_OOO, BLACK_OO, BLACK_OOO, NORTH, SOUTH, NORTH_EAST,
  NORTH_WEST, SOUTH_EAST, SOUTH_WEST, make_move, make_promotion, make_enpassant,
  make_castling, make_castling_right} from './constants.mjs';
import {AllSquares, Rank1BB, Rank2BB, Rank3BB, Rank6BB, Rank7BB, Rank8BB, PawnAttacks,
  PseudoAttacks, BetweenBB, sq_bb, file_bb_s, shift_bb, lsb, more_than_one,
  attacks_bb_bishop, attacks_bb_rook, attacks_bb_queen} from './bitboard.mjs';
import {is_legal} from './position.mjs';
export const CAPTURES = 0, QUIETS = 1, QUIET_CHECKS = 2, EVASIONS = 3, NON_EVASIONS = 4, LEGAL = 5;
export class ExtMove { constructor(move = 0,value = 0) { this.move = move; this.value = value; } }
export function make_promotions(list,to,kind,d) {
  if ([CAPTURES,EVASIONS,NON_EVASIONS].includes(kind)) list.push(new ExtMove(make_promotion(to-d,to,QUEEN)));
  if ([QUIETS,EVASIONS,NON_EVASIONS].includes(kind)) for (const pt of [ROOK,BISHOP,KNIGHT]) list.push(new ExtMove(make_promotion(to-d,to,pt)));
}
export function generate_pawn_moves(pos,list,target,us,kind) {
  const st = pos.st, them = us === WHITE ? BLACK : WHITE, pawnAttacks = PawnAttacks[them];
  const rank8 = us === WHITE ? Rank8BB : Rank1BB, rank7 = us === WHITE ? Rank7BB : Rank2BB;
  const rank3 = us === WHITE ? Rank3BB : Rank6BB, up = us === WHITE ? NORTH : SOUTH;
  const right = us === WHITE ? NORTH_EAST : SOUTH_WEST, left = us === WHITE ? NORTH_WEST : SOUTH_EAST;
  const empty = ~pos.byTypeBB[0] & AllSquares, enemies = kind === EVASIONS ? st.checkersBB : pos.byColorBB[them];
  const pawns = pos.byTypeBB[PAWN] & pos.byColorBB[us], on7 = pawns & rank7, not7 = pawns ^ on7;
  const append = (b,d) => { while (b) { const to = lsb(b); b &= b-1n; list.push(new ExtMove(make_move(to-d,to))); } };
  if (kind !== CAPTURES) {
    let b1 = shift_bb(up,not7) & empty, b2 = shift_bb(up,b1 & rank3) & empty;
    if (kind === EVASIONS) { b1 &= target; b2 &= target; }
    if (kind === QUIET_CHECKS) {
      const dc = st.blockersForKing[them] & (~file_bb_s(st.ksq) & AllSquares);
      b1 &= pawnAttacks[st.ksq] | shift_bb(up,dc); b2 &= pawnAttacks[st.ksq] | shift_bb(up+up,dc);
    }
    append(b1,up); append(b2,up+up);
  }
  if (on7 && (kind !== EVASIONS || (target & rank8))) {
    let b1 = shift_bb(right,on7) & enemies, b2 = shift_bb(left,on7) & enemies, b3 = shift_bb(up,on7) & empty;
    if (kind === EVASIONS) b3 &= target;
    for (const [initial,d] of [[b1,right],[b2,left],[b3,up]]) {
      let b = initial; while (b) { const to = lsb(b); b &= b-1n; make_promotions(list,to,kind,d); }
    }
  }
  if ([CAPTURES,EVASIONS,NON_EVASIONS].includes(kind)) {
    append(shift_bb(right,not7) & enemies,right); append(shift_bb(left,not7) & enemies,left);
    const ep = st.epSquare;
    if (ep !== 0) {
      if (kind === EVASIONS && (target & sq_bb(ep+up))) return;
      let b = not7 & pawnAttacks[ep];
      while (b) { const from = lsb(b); b &= b-1n; list.push(new ExtMove(make_enpassant(from,ep))); }
    }
  }
}
export function generate_moves(pos,list,target,us,pt,checks) {
  const pieces = pos.byTypeBB, occupied = pieces[0], blockers = pos.st.blockersForKing[1-us], checkSquares = pos.st.checkSquares[pt];
  let bb = pieces[pt] & pos.byColorBB[us]; const attack = pt === BISHOP ? attacks_bb_bishop : pt === ROOK ? attacks_bb_rook : attacks_bb_queen;
  while (bb) {
    const from = lsb(bb); bb &= bb-1n;
    let b = (pt === KNIGHT ? PseudoAttacks[KNIGHT][from] : attack(from,occupied)) & target;
    if (checks && (pt === QUEEN || !(blockers & sq_bb(from)))) b &= checkSquares;
    while (b) { const to = lsb(b); b &= b-1n; list.push(new ExtMove((from<<6)|to)); }
  }
}
export function generate(pos,kind) {
  if (kind === LEGAL) return generate_legal(pos);
  const list = [], us = pos.sideToMove, checks = kind === QUIET_CHECKS, occupied = pos.byTypeBB[0];
  const ours = pos.byColorBB[us], theirs = pos.byColorBB[1-us], kings = pos.byTypeBB[KING], ksq = lsb(kings & ours);
  let target = 0n;
  if (kind !== EVASIONS || !more_than_one(pos.st.checkersBB)) {
    target = kind === EVASIONS ? BetweenBB[ksq][lsb(pos.st.checkersBB)] : kind === NON_EVASIONS ? ~ours & AllSquares : kind === CAPTURES ? theirs : ~occupied & AllSquares;
    generate_pawn_moves(pos,list,target,us,kind);
    for (const pt of [KNIGHT,BISHOP,ROOK,QUEEN]) generate_moves(pos,list,target,us,pt,checks);
  }
  if (!checks || (pos.st.blockersForKing[1-us] & sq_bb(ksq))) {
    let b = PseudoAttacks[KING][ksq] & (kind === EVASIONS ? ~ours : target) & AllSquares;
    if (checks) b &= ~PseudoAttacks[QUEEN][lsb(kings & theirs)] & AllSquares;
    while (b) { const to = lsb(b); b &= b-1n; list.push(new ExtMove((ksq<<6)|to)); }
    if ((kind === QUIETS || kind === NON_EVASIONS) && (pos.st.castlingRights & (us === WHITE ? WHITE_OO|WHITE_OOO : BLACK_OO|BLACK_OOO))) {
      for (const side of [KING_SIDE,QUEEN_SIDE]) {
        const cr = make_castling_right(us,side);
        if ((pos.st.castlingRights & cr) && !(pos.castlingPath[cr] & occupied)) list.push(new ExtMove(make_castling(ksq,pos.castlingRookSquare[cr])));
      }
    }
  }
  return list;
}
export function generate_captures(pos) { return generate(pos,CAPTURES); }
export function generate_quiets(pos) { return generate(pos,QUIETS); }
export function generate_evasions(pos) { return generate(pos,EVASIONS); }
export function generate_quiet_checks(pos) { return generate(pos,QUIET_CHECKS); }
export function generate_non_evasions(pos) { return generate(pos,NON_EVASIONS); }
export function generate_legal(pos) {
  const us = pos.sideToMove, ours = pos.byColorBB[us], pinned = pos.st.blockersForKing[us] & ours, ksq = lsb(pos.byTypeBB[KING] & ours);
  const moves = pos.st.checkersBB ? generate_evasions(pos) : generate_non_evasions(pos); let cur = 0, end = moves.length;
  while (cur !== end) {
    const m = moves[cur].move, from = (m>>6)&63;
    if ((pinned & sq_bb(from)) || from === ksq || (m>>14) === ENPASSANT) {
      if (!is_legal(pos,m)) { end--; moves[cur] = moves[end]; continue; }
    }
    cur++;
  }
  moves.length = end; return moves;
}
