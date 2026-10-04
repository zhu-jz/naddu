import {WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, W_KING, B_KING,
  PawnValue, KnightValue, BishopValue, RookValue, QueenValue, MAX_PLY, VALUE_NONE,
  NORMAL, PROMOTION, ENPASSANT, CASTLING, KING_SIDE, QUEEN_SIDE, WHITE_OO,
  WHITE_OOO, BLACK_OO, BLACK_OOO, FILE_D, RANK_2, RANK_3, RANK_6, SQ_A1, SQ_A8,
  SQ_C1, SQ_D1, SQ_F1, SQ_G1, SQ_H1, EAST, WEST, make_castling_right, make_move,
  make_piece, make_square, pawn_push, color_of, file_of, rank_of, relative_rank,
  relative_square, from_sq, to_sq, type_of_m, type_of_p, promotion_type, at} from './constants.mjs';
import {AllSquares, PawnAttacks, PseudoAttacks, BetweenBB, sq_bb, aligned, lsb,
  more_than_one, attacks_bb, attacks_bb_bishop, attacks_bb_rook, attacks_bb_queen,
  pawn_attacks_bb} from './bitboard.mjs';
import {NNUEAccumulator, DirtyPieces, DP_NORMAL, DP_CAPTURE, DP_CASTLING,
  nnue_accumulator_refresh, nnue_accumulator_update} from './nnue.mjs';
import {generate_quiets, generate_legal} from './movegen.mjs';
import {publish_nodes} from './control.mjs';

export class PRNG {
  constructor(seed) { this.s = BigInt(seed); }
  rand() {
    let s = this.s;
    s = (s ^ (s >> 12n)) & AllSquares;
    s = (s ^ (s << 25n)) & AllSquares;
    s = (s ^ (s >> 27n)) & AllSquares;
    this.s = s;
    return (s * 2685821657736338717n) & AllSquares;
  }
}
export const zob = {psq: Array.from({length: 16}, () => Array(64).fill(0n)),
  enpassant: Array(8).fill(0n), castling: Array(16).fill(0n), side: 0n, noPawns: 0n};
export const matKey = [0n,0x5ced000000000101n,0xe173000000001001n,0xd64d000000010001n,
  0xab88000000100001n,0x680b000001000001n,1n,0n,0n,0xf219000010000001n,
  0xbb14000100000001n,0x58df001000000001n,0xa15f010000000001n,0x7c94100000000001n,1n,0n];
export const PieceValue = [0,PawnValue,KnightValue,BishopValue,RookValue,QueenValue,0,0,
  0,PawnValue,KnightValue,BishopValue,RookValue,QueenValue,0,0];
export const NonPawnPieceValue = [0,0,781,825,1276,2538,0,0,0,0,51183616,54067200,83623936,166330368,0,0];
export const PieceToChar = ' PNBRQK  pnbrqk';
export const cuckoo = Array(8192).fill(0n), cuckooMove = new Uint16Array(8192);
export function H1(h) { return Number(h & 0x1fffn); }
export function H2(h) { return Number((h >> 16n) & 0x1fffn); }
export function zob_init() {
  const rng = new PRNG(1070372);
  for (let c = 0; c < 2; c++) for (let pt = PAWN; pt <= KING; pt++) for (let s = 0; s < 64; s++) zob.psq[make_piece(c,pt)][s] = rng.rand();
  for (let f = 0; f < 8; f++) zob.enpassant[f] = rng.rand();
  for (let cr = 0; cr < 16; cr++) zob.castling[cr] = rng.rand();
  zob.side = rng.rand(); zob.noPawns = rng.rand();
  cuckoo.fill(0n); cuckooMove.fill(0);
  let count = 0;
  for (let c = 0; c < 2; c++) for (let pt = PAWN; pt <= KING; pt++) {
    const pc = make_piece(c,pt);
    for (let s1 = 0; s1 < 64; s1++) for (let s2 = s1+1; s2 < 64; s2++) {
      if (!(PseudoAttacks[pt][s1] & sq_bb(s2))) continue;
      let move = make_move(s1,s2), key = zob.psq[pc][s1] ^ zob.psq[pc][s2] ^ zob.side, i = H1(key);
      while (true) {
        [key,cuckoo[i]] = [cuckoo[i],key];
        [move,cuckooMove[i]] = [cuckooMove[i],move];
        if (!move) break;
        i = i === H1(key) ? H2(key) : H1(key);
      }
      count++;
    }
  }
  if (count !== 3668) throw new Error('Invalid repetition cuckoo table');
}
export class Stack {
  constructor() {
    this.pawnKey = 0n; this.materialKey = 0n; this.nonPawnKey = [0n,0n]; this.nonPawn = 0;
    this.castlingRights = 0; this.capturedPiece = 0; this.epSquare = 0; this.key = 0n;
    this.checkersBB = 0n; this.pliesFromNull = 0; this.rule50 = 0;
    this.blockersForKing = [0n,0n]; this.pinnersForKing = [0n,0n]; this.checkSquares = Array(7).fill(0n); this.ksq = 0;
    this.accumulator = new NNUEAccumulator(); this.dirtyPieces = new DirtyPieces(); this.history = null;
    this.reset_search_fields();
  }
  reset_search_fields() {
    this.ply = 0; this.depth = 0; this.countermove = 0; this.mpKillers = [0,0];
    this.ttMove = 0; this.stage = 0; this.currentMove = 0; this.moves = []; this.cur_idx = 0;
    this.badCaptures = []; this.threshold = 0; this.recaptureSquare = 0; this.excludedMove = 0;
    this.moveCount = 0; this.staticEval = VALUE_NONE; this.ttHit = false;
  }
}
export function create_counter_move_history(buffer = null,initialize = buffer===null) {
  const history = Array.from({length: 16}, (_,pc) => Array.from({length: 64}, (_,square) =>
    buffer ? new Int8Array(buffer,(pc*64+square)*1024,1024) : new Int8Array(1024)));
  if (initialize) { for (const piece of history) for (const row of piece) row.fill(0); history[0][0].fill(-1); }
  return history;
}
export function clear_counter_move_history(history) {
  for (const piece of history) for (const row of piece) row.fill(0);
  history[0][0].fill(-1);
}
export class Position {
  constructor(search_worker = true, counter_move_history = null) {
    this.search_worker = search_worker;
    this.stack = Array.from({length: search_worker ? MAX_PLY+50 : 8}, () => new Stack());
    this.st_idx = 7; this.st = this.stack[7]; this.byTypeBB = Array(7).fill(0n); this.byColorBB = [0n,0n];
    this.sideToMove = WHITE; this.chess960 = 0; this.optimism = [0,0]; this.board = new Uint8Array(64);
    this.pieceCount = new Int32Array(16); this.castlingRightsMask = new Uint8Array(64);
    this.castlingRookSquare = new Uint8Array(16); this.castlingPath = Array(16).fill(0n);
    this.gamePly = 0; this.rootKeyFlip = 0n; this.threadIdx = 0;
    if (search_worker) {
      this.killers = Array.from({length: MAX_PLY+10}, () => [0,0]);
      this.cutoffCnt = Array(MAX_PLY+10).fill(0); this.statScore = Array(MAX_PLY+10).fill(0);
      this.doubleExtensions = Array(MAX_PLY+10).fill(0); this.ttPv = Array(MAX_PLY+10).fill(false);
      this.pvArray = Array.from({length: MAX_PLY+10}, () => [0]);
      this.correctionHistory = [new Int8Array(16384),new Int8Array(16384)];
      this.nonPawnCorrectionHistory = Array.from({length: 2}, () => [new Int16Array(8192),new Int16Array(8192)]);
      this.counterMoves = Array.from({length: 16}, () => new Uint16Array(64));
      this.counterMoveHistory = counter_move_history ?? create_counter_move_history();
      this.mainHistory = [new Int8Array(4096),new Int8Array(4096)];
      this.captureHistory = Array.from({length: 16}, () => Array.from({length: 64}, () => new Int16Array(8)));
    } else {
      for (const field of ['killers','cutoffCnt','statScore','doubleExtensions','ttPv','pvArray','correctionHistory',
        'nonPawnCorrectionHistory','counterMoves','mainHistory','captureHistory']) this[field] = null;
      this.counterMoveHistory = [[new Int8Array(1024).fill(-1)]];
    }
    for (const st of this.stack) st.history = this.counterMoveHistory[0][0];
    this.rootMoves = null; this.rootDelta = 0; this.reset_search_control(); this.hasRepeated = false;
  }
  reset_search_control() {
    this.nodes = 0; this.selDepth = 0; this.nmpMinPly = 0; this.rootDepth = 0; this.completedDepth = 0;
    this.pvLast = 0; this.pvIdx = 0; this.multiPV = 1; this.bestMoveChanges = 0;
    this.callsCnt = 0; this.resetCalls = false;
  }
  static _copy_root_stack_state(dst, src) {
    for (const name of ['pawnKey','materialKey','nonPawn','castlingRights','capturedPiece','epSquare','key',
      'checkersBB','pliesFromNull','rule50','ksq']) dst[name] = src[name];
    for (const name of ['nonPawnKey','blockersForKing','pinnersForKing','checkSquares']) dst[name] = src[name].slice();
    dst.accumulator.colors[WHITE].set(src.accumulator.colors[WHITE]);
    dst.accumulator.colors[BLACK].set(src.accumulator.colors[BLACK]);
    dst.dirtyPieces = new DirtyPieces(); dst.reset_search_fields();
  }
  copy_root_from(src) {
    this.byTypeBB = src.byTypeBB.slice(); this.byColorBB = src.byColorBB.slice();
    this.sideToMove = src.sideToMove; this.chess960 = src.chess960; this.optimism = [0,0];
    this.board.set(src.board); this.pieceCount.set(src.pieceCount); this.castlingRightsMask.set(src.castlingRightsMask);
    this.castlingRookSquare.set(src.castlingRookSquare); this.castlingPath = src.castlingPath.slice();
    this.gamePly = src.gamePly; this.rootKeyFlip = src.rootKeyFlip; this.hasRepeated = src.hasRepeated;
    const size = Math.min(src.st_idx, Math.max(7,src.st.pliesFromNull)), start = src.st_idx-size;
    this.ensure_stack_index(size);
    for (let i = 0; i <= size; i++) {
      Position._copy_root_stack_state(this.stack[i], src.stack[start+i]);
      this.stack[i].history = this.counterMoveHistory[0][0];
    }
    this.st_idx = size; this.st = this.stack[size]; this.st.history = this.counterMoveHistory[0][0];
    this.reset_search_control();
  }
  ensure_stack_index(i) {
    while (i >= this.stack.length) {
      const st = new Stack(); st.history = this.counterMoveHistory[0][0]; this.stack.push(st);
    }
  }
  pieces(pt = null, c = null) {
    if (pt === null && c === null) return this.byTypeBB[0];
    if (c === null) return this.byTypeBB[pt];
    if (pt === null) return this.byColorBB[c];
    return this.byTypeBB[pt] & this.byColorBB[c];
  }
  put_piece(c, pc, s) {
    this.board[s] = pc; const mask = sq_bb(s);
    this.byTypeBB[0] |= mask; this.byTypeBB[pc & 7] |= mask; this.byColorBB[c] |= mask;
  }
  remove_piece(c, pc, s) {
    const mask = sq_bb(s); this.byTypeBB[0] ^= mask; this.byTypeBB[pc & 7] ^= mask;
    this.byColorBB[c] ^= mask; this.board[s] = 0;
  }
  move_piece(c, pc, from, to) {
    const mask = sq_bb(from) ^ sq_bb(to); this.byTypeBB[0] ^= mask; this.byTypeBB[pc & 7] ^= mask;
    this.byColorBB[c] ^= mask; this.board[from] = 0; this.board[to] = pc;
  }
  set_castling_right(c, rfrom) {
    const kfrom = lsb(this.pieces(KING,c)), cs = kfrom < rfrom ? KING_SIDE : QUEEN_SIDE;
    const cr = WHITE_OO << (Number(cs === QUEEN_SIDE)+2*c);
    const kto = relative_square(c,cs === KING_SIDE ? SQ_G1 : SQ_C1);
    const rto = relative_square(c,cs === KING_SIDE ? SQ_F1 : SQ_D1);
    this.st.castlingRights |= cr; this.castlingRightsMask[kfrom] |= cr; this.castlingRightsMask[rfrom] |= cr;
    this.castlingRookSquare[cr] = rfrom;
    for (let s = Math.min(rfrom,rto); s <= Math.max(rfrom,rto); s++) if (s !== kfrom && s !== rfrom) this.castlingPath[cr] |= sq_bb(s);
    for (let s = Math.min(kfrom,kto); s <= Math.max(kfrom,kto); s++) if (s !== kfrom && s !== rfrom) this.castlingPath[cr] |= sq_bb(s);
  }
  set(fen, chess960 = 0) {
    if (!this.search_worker && this.stack.length > 8) this.stack.length = 8;
    this.st = new Stack(); this.stack[7] = this.st; this.st.history = this.counterMoveHistory[0][0]; this.st_idx = 7;
    for (let i = 0; i < 7; i++) { this.stack[i] = new Stack(); this.stack[i].history = this.counterMoveHistory[0][0]; }
    this.byTypeBB = Array(7).fill(0n); this.byColorBB = [0n,0n]; this.board.fill(0); this.pieceCount.fill(0);
    this.castlingRightsMask.fill(0); this.castlingRookSquare.fill(0); this.castlingPath.fill(0n);
    const parts = fen.trim().split(/\s+/); if (parts.length < 4) return;
    let sq = SQ_A8;
    for (const char of parts[0]) {
      if (char >= '1' && char <= '8') sq += Number(char);
      else if (char === '/') sq -= 16;
      else { const pc = PieceToChar.indexOf(char); this.put_piece(color_of(pc),pc,sq); this.pieceCount[pc]++; sq++; }
    }
    this.sideToMove = parts[1] === 'w' ? WHITE : BLACK;
    if (parts[2] !== '-') for (const char of parts[2]) {
      const c = char === char.toLowerCase() ? BLACK : WHITE, rook = make_piece(c,ROOK), token = char.toUpperCase();
      let rsq;
      if (token === 'K') { rsq = relative_square(c,SQ_H1); while (this.board[rsq] !== rook) rsq--; }
      else if (token === 'Q') { rsq = relative_square(c,SQ_A1); while (this.board[rsq] !== rook) rsq++; }
      else if (token >= 'A' && token <= 'H') rsq = make_square(token.charCodeAt(0)-65,relative_rank(c,0));
      else continue;
      this.set_castling_right(c,rsq);
    }
    if (parts[3] !== '-') {
      this.st.epSquare = make_square(parts[3].charCodeAt(0)-97,Number(parts[3][1])-1);
      if (rank_of(this.st.epSquare) !== (this.sideToMove === WHITE ? RANK_6 : RANK_3)) this.st.epSquare = 0;
      else if (!(attackers_to_occ(this,this.st.epSquare,this.pieces()) & this.pieces(PAWN,this.sideToMove))) this.st.epSquare = 0;
    } else this.st.epSquare = 0;
    this.st.rule50 = parts.length > 4 ? Number(parts[4]) : 0;
    const full = parts.length > 5 ? Number(parts[5]) : 1;
    this.gamePly = Math.max(2*(full-1),0)+Number(this.sideToMove === BLACK);
    this.chess960 = chess960; this.rootKeyFlip = 0n; this.set_state();
  }
  set_state() {
    const st = this.st; st.key = 0n; st.materialKey = 0n; st.pawnKey = zob.noPawns; st.nonPawnKey = [0n,0n]; st.nonPawn = 0;
    const whiteKing = lsb(this.pieces(KING,WHITE)), blackKing = lsb(this.pieces(KING,BLACK));
    st.checkersBB = attackers_to_occ(this,this.sideToMove === WHITE ? whiteKing : blackKing,this.pieces()) & this.pieces(null,1-this.sideToMove);
    this.set_check_info(whiteKing,blackKing);
    let bb = this.pieces();
    while (bb) {
      const s = lsb(bb); bb &= bb-1n; const pc = this.board[s]; st.key ^= zob.psq[pc][s];
      if (type_of_p(pc) === PAWN) st.pawnKey ^= zob.psq[pc][s];
      else if (type_of_p(pc) !== KING) st.nonPawnKey[color_of(pc)] ^= zob.psq[pc][s];
    }
    // Preserve the reference's unconditional no-EP file-a salt.
    st.key ^= zob.enpassant[file_of(st.epSquare)];
    if (this.sideToMove === BLACK) st.key ^= zob.side;
    st.key ^= zob.castling[st.castlingRights];
    for (let pt = PAWN; pt <= KING; pt++) for (let c = 0; c < 2; c++) st.materialKey += BigInt(this.pieceCount[make_piece(c,pt)]) * matKey[make_piece(c,pt)];
    for (let pt = KNIGHT; pt <= QUEEN; pt++) for (let c = 0; c < 2; c++) st.nonPawn += this.pieceCount[make_piece(c,pt)] * NonPawnPieceValue[make_piece(c,pt)];
    nnue_accumulator_refresh(st.accumulator,this,WHITE,whiteKing); nnue_accumulator_refresh(st.accumulator,this,BLACK,blackKing);
  }
  set_check_info(whiteKing, blackKing) {
    const st = this.st, occupied = this.byTypeBB[0], colors = this.byColorBB;
    st.blockersForKing[WHITE] = slider_blockers(this,colors[BLACK],whiteKing,st.pinnersForKing,WHITE);
    st.blockersForKing[BLACK] = slider_blockers(this,colors[WHITE],blackKing,st.pinnersForKing,BLACK);
    const them = 1-this.sideToMove; st.ksq = them === WHITE ? whiteKing : blackKing;
    st.checkSquares[PAWN] = PawnAttacks[them][st.ksq]; st.checkSquares[KNIGHT] = PseudoAttacks[KNIGHT][st.ksq];
    st.checkSquares[BISHOP] = attacks_bb_bishop(st.ksq,occupied); st.checkSquares[ROOK] = attacks_bb_rook(st.ksq,occupied);
    st.checkSquares[QUEEN] = st.checkSquares[BISHOP] | st.checkSquares[ROOK]; st.checkSquares[KING] = 0n;
  }
}
export function slider_blockers(pos, sliders, s, pinners, c) {
  let blockers = 0n; pinners[c] = 0n; const pieces = pos.byTypeBB, friendly = pos.byColorBB[color_of(pos.board[s])];
  let snipers = ((PseudoAttacks[ROOK][s] & (pieces[QUEEN] | pieces[ROOK])) | (PseudoAttacks[BISHOP][s] & (pieces[QUEEN] | pieces[BISHOP]))) & sliders;
  const occupancy = pieces[0] ^ snipers;
  while (snipers) {
    const square = lsb(snipers); snipers &= snipers-1n;
    const b = BetweenBB[s][square] & occupancy;
    if (b && !more_than_one(b)) { blockers |= b; if (b & friendly) pinners[c] |= sq_bb(square); }
  }
  return blockers;
}
export function attackers_to_occ(pos, s, occupied) {
  const p = pos.byTypeBB, c = pos.byColorBB;
  return (PawnAttacks[BLACK][s] & p[PAWN] & c[WHITE]) | (PawnAttacks[WHITE][s] & p[PAWN] & c[BLACK])
    | (PseudoAttacks[KNIGHT][s] & p[KNIGHT]) | (attacks_bb_rook(s,occupied) & (p[ROOK] | p[QUEEN]))
    | (attacks_bb_bishop(s,occupied) & (p[BISHOP] | p[QUEEN])) | (PseudoAttacks[KING][s] & p[KING]);
}
export function is_capture_or_promotion(pos,m) { const mt = type_of_m(m); return mt !== NORMAL ? mt !== CASTLING : pos.board[to_sq(m)] !== 0; }
export function is_capture(pos,m) { const mt = type_of_m(m); return mt === ENPASSANT || (pos.board[to_sq(m)] !== 0 && mt !== CASTLING); }
export function gives_check(pos,st,m) {
  const us = pos.sideToMove, from = from_sq(m), to = to_sq(m), fromBB = sq_bb(from), toBB = sq_bb(to);
  if ((st.blockersForKing[1-us] & fromBB) && !aligned(m,st.ksq)) return true;
  const mt = type_of_m(m);
  if (mt === NORMAL) return !!(st.checkSquares[pos.board[from] & 7] & toBB);
  if (mt === PROMOTION) return !!(attacks_bb(promotion_type(m),to,pos.byTypeBB[0] ^ fromBB) & sq_bb(st.ksq));
  if (mt === ENPASSANT) {
    if (st.checkSquares[PAWN] & toBB) return true;
    const capsq = make_square(file_of(to),rank_of(from)), pieces = pos.byTypeBB, ours = pos.byColorBB[us];
    const b = pieces[0] ^ fromBB ^ toBB ^ sq_bb(capsq);
    return !!((attacks_bb_rook(st.ksq,b) & ours & (pieces[QUEEN] | pieces[ROOK])) | (attacks_bb_bishop(st.ksq,b) & ours & (pieces[QUEEN] | pieces[BISHOP])));
  }
  if (mt === CASTLING) {
    const rto = relative_square(us,to > from ? SQ_F1 : SQ_D1);
    return !!((PseudoAttacks[ROOK][rto] & sq_bb(st.ksq)) && (attacks_bb_rook(rto,pos.byTypeBB[0] ^ fromBB) & sq_bb(st.ksq)));
  }
  return false;
}
export function is_legal(pos,m) {
  const us = pos.sideToMove, from = from_sq(m), to = to_sq(m), fromBB = sq_bb(from), toBB = sq_bb(to), mt = type_of_m(m), st = pos.st;
  const pieces = pos.byTypeBB, ours = pos.byColorBB[us], theirs = pos.byColorBB[1-us]; let occupied = pieces[0];
  if (mt === ENPASSANT) {
    const ksq = lsb(pieces[KING] & ours), capsq = to ^ 8; occupied ^= fromBB ^ sq_bb(capsq) ^ toBB;
    return !((attacks_bb_rook(ksq,occupied) & theirs & (pieces[QUEEN] | pieces[ROOK])) | (attacks_bb_bishop(ksq,occupied) & theirs & (pieces[QUEEN] | pieces[BISHOP])));
  }
  if (mt === CASTLING) {
    const target = relative_square(us,to > from ? SQ_G1 : SQ_C1), step = target > from ? WEST : EAST;
    for (let s = target; s !== from; s += step) if (attackers_to_occ(pos,s,occupied) & theirs) return false;
    return !pos.chess960 || !(st.blockersForKing[us] & toBB);
  }
  if (pieces[KING] & fromBB) return !(attackers_to_occ(pos,to,occupied ^ fromBB) & theirs);
  return !(st.blockersForKing[us] & fromBB) || aligned(m,lsb(pieces[KING] & ours));
}
export function is_pseudo_legal(pos,m) {
  const us = pos.sideToMove, from = from_sq(m), to = to_sq(m), fromBB = sq_bb(from), toBB = sq_bb(to), mt = type_of_m(m), st = pos.st;
  const board = pos.board, pieces = pos.byTypeBB, ours = pos.byColorBB[us], theirs = pos.byColorBB[1-us], occupied = pieces[0];
  if (!(ours & fromBB)) return false;
  if (mt === CASTLING) return !st.checkersBB && generate_quiets(pos).some(e => e.move === m);
  if (ours & toBB) return false;
  const pt = type_of_p(board[from]);
  if (pt !== PAWN) {
    if (mt !== NORMAL) return false;
    if (pt === KNIGHT && !(PseudoAttacks[KNIGHT][from] & toBB)) return false;
    else if (pt === BISHOP && !(attacks_bb_bishop(from,occupied) & toBB)) return false;
    else if (pt === ROOK && !(attacks_bb_rook(from,occupied) & toBB)) return false;
    else if (pt === QUEEN && !(attacks_bb_queen(from,occupied) & toBB)) return false;
    else if (pt === KING) {
      if (!(PseudoAttacks[KING][from] & toBB)) return false;
      if (st.checkersBB && (attackers_to_occ(pos,to,occupied ^ fromBB) & theirs)) return false;
      return true;
    }
  } else {
    const push = pawn_push(us);
    if (mt === NORMAL) {
      if (!((to+8)&48)) return false;
      if (!(PawnAttacks[us][from] & theirs & toBB)) {
        if (!(from+push === to && board[to] === 0) && !(from+2*push === to && rank_of(from) === relative_rank(us,RANK_2) && board[to] === 0 && board[to-push] === 0)) return false;
      }
    } else if (mt === PROMOTION) {
      if (!(PawnAttacks[us][from] & theirs & toBB) && !(from+push === to && board[to] === 0)) return false;
    } else return to === st.epSquare && !!(PawnAttacks[us][from] & toBB);
  }
  if (st.checkersBB) {
    if (more_than_one(st.checkersBB)) return false;
    if (!(BetweenBB[lsb(pieces[KING] & ours)][lsb(st.checkersBB)] & toBB)) return false;
  }
  return true;
}
export function do_move(pos,m,givesCheck) {
  const us = pos.sideToMove, them = 1-us, from = from_sq(m), piece = pos.board[from], mt = type_of_m(m), pt = type_of_p(piece);
  let to = to_sq(m), captured = mt === ENPASSANT ? make_piece(them,PAWN) : pos.board[to];
  const pieces = pos.byTypeBB, colors = pos.byColorBB;
  pos.st_idx++; pos.ensure_stack_index(pos.st_idx); const old = pos.stack[pos.st_idx-1], st = pos.stack[pos.st_idx]; pos.st = st;
  st.pawnKey = old.pawnKey; st.materialKey = old.materialKey; st.nonPawnKey[0] = old.nonPawnKey[0]; st.nonPawnKey[1] = old.nonPawnKey[1];
  st.nonPawn = old.nonPawn; st.pliesFromNull = old.pliesFromNull+1; st.rule50 = old.rule50+1; st.castlingRights = old.castlingRights;
  // Search fields deliberately retain previous contents, exactly like Python.
  st.ply = old.ply+1; const dp = st.dirtyPieces; dp.type = DP_NORMAL; let key = old.key ^ zob.side;
  if (mt === CASTLING) {
    const kingSide = to > from, rfrom = to, rto = relative_square(us,kingSide ? SQ_F1 : SQ_D1); to = relative_square(us,kingSide ? SQ_G1 : SQ_C1);
    dp.type = DP_CASTLING; dp.sub1.sq = rfrom; dp.sub1.pc = captured; dp.add1.sq = rto; dp.add1.pc = captured;
    pos.remove_piece(us,piece,from); pos.remove_piece(us,captured,rfrom); pos.board[from] = pos.board[rfrom] = 0;
    pos.put_piece(us,piece,to); pos.put_piece(us,captured,rto);
    const rookKey = zob.psq[captured][rfrom] ^ zob.psq[captured][rto]; key ^= rookKey; st.nonPawnKey[us] ^= rookKey; captured = 0;
  } else if (captured) {
    let capsq = to; const capturedPsq = zob.psq[captured];
    if (type_of_p(captured) === PAWN) {
      if (mt === ENPASSANT) { capsq ^= 8; pos.board[capsq] = 0; }
      st.pawnKey ^= capturedPsq[capsq];
    } else { st.nonPawn -= NonPawnPieceValue[captured]; st.nonPawnKey[them] ^= capturedPsq[capsq]; }
    dp.type = DP_CAPTURE; dp.sub1.sq = capsq; dp.sub1.pc = captured;
    pos.remove_piece(them,captured,capsq); pos.pieceCount[captured]--; key ^= capturedPsq[capsq];
    st.materialKey -= matKey[captured]; st.rule50 = 0; st.pliesFromNull = 0;
  }
  dp.sub0.sq = from; dp.sub0.pc = piece; dp.add0.sq = to; dp.add0.pc = piece; st.capturedPiece = captured;
  const piecePsq = zob.psq[piece], pieceKey = piecePsq[from] ^ piecePsq[to]; key ^= pieceKey;
  if (old.epSquare !== 0) key ^= zob.enpassant[file_of(old.epSquare)]; st.epSquare = 0;
  const mask = pos.castlingRightsMask[from] | pos.castlingRightsMask[to];
  if (st.castlingRights && mask) { key ^= zob.castling[st.castlingRights]; st.castlingRights &= ~mask; key ^= zob.castling[st.castlingRights]; }
  if (mt !== CASTLING) pos.move_piece(us,piece,from,to);
  // The two separate XOR sites are intentionally preserved.
  if (!captured && mt !== CASTLING) st.nonPawnKey[us] ^= pieceKey;
  if (pt === PAWN) {
    if ((to ^ from) === 16 && (PawnAttacks[us][to ^ 8] & pieces[PAWN] & colors[them])) { st.epSquare = to ^ 8; key ^= zob.enpassant[file_of(st.epSquare)]; }
    else if (mt === PROMOTION) {
      const promotion = make_piece(us,promotion_type(m)); dp.add0.pc = promotion;
      pos.remove_piece(us,piece,to); pos.pieceCount[piece]--; pos.put_piece(us,promotion,to); pos.pieceCount[promotion]++;
      key ^= piecePsq[to] ^ zob.psq[promotion][to]; st.pawnKey ^= piecePsq[to]; st.materialKey += matKey[promotion]-matKey[piece]; st.nonPawn += NonPawnPieceValue[promotion];
    }
    st.pawnKey ^= pieceKey; st.rule50 = 0; st.pliesFromNull = 0;
  } else if (pt !== KING) st.nonPawnKey[us] ^= pieceKey;
  st.key = key;
  const wKing = lsb(pieces[KING] & colors[WHITE]), bKing = lsb(pieces[KING] & colors[BLACK]);
  st.checkersBB = givesCheck ? attackers_to_occ(pos,them === WHITE ? wKing : bKing,pieces[0]) & colors[us] : 0n;
  pos.sideToMove = 1-pos.sideToMove; pos.nodes++; publish_nodes(pos); pos.set_check_info(wKing,bKing);
  if (piece === W_KING && ((file_of(from)>FILE_D) !== (file_of(to)>FILE_D))) nnue_accumulator_refresh(st.accumulator,pos,WHITE,wKing);
  else nnue_accumulator_update(st.accumulator,wKing,WHITE,dp,old.accumulator);
  if (piece === B_KING && ((file_of(from)>FILE_D) !== (file_of(to)>FILE_D))) nnue_accumulator_refresh(st.accumulator,pos,BLACK,bKing);
  else nnue_accumulator_update(st.accumulator,bKing,BLACK,dp,old.accumulator);
}
export function undo_move(pos,m) {
  pos.sideToMove = 1-pos.sideToMove; const us = pos.sideToMove, from = from_sq(m), mt = type_of_m(m);
  let to = to_sq(m), pc = pos.board[to];
  if (mt === PROMOTION) {
    pos.remove_piece(us,pc,to); pos.pieceCount[pc]--; pc = make_piece(us,PAWN); pos.put_piece(us,pc,to); pos.pieceCount[pc]++;
  }
  if (mt === CASTLING) {
    const kingSide = to>from, rfrom = to, rto = relative_square(us,kingSide ? SQ_F1 : SQ_D1); to = relative_square(us,kingSide ? SQ_G1 : SQ_C1);
    const king = make_piece(us,KING), rook = make_piece(us,ROOK);
    pos.remove_piece(us,king,to); pos.remove_piece(us,rook,rto); pos.board[to] = pos.board[rto] = 0;
    pos.put_piece(us,king,from); pos.put_piece(us,rook,rfrom);
  } else {
    pos.move_piece(us,pc,to,from); const captured = pos.st.capturedPiece;
    if (captured) { const capsq = mt === ENPASSANT ? to ^ 8 : to; pos.put_piece(1-us,captured,capsq); pos.pieceCount[captured]++; }
  }
  pos.st_idx--; pos.st = pos.stack[pos.st_idx];
}
export function do_null_move(pos) {
  pos.st_idx++; pos.ensure_stack_index(pos.st_idx); const old = pos.stack[pos.st_idx-1], st = pos.stack[pos.st_idx]; pos.st = st;
  st.pawnKey = old.pawnKey; st.materialKey = old.materialKey; st.nonPawnKey[0] = old.nonPawnKey[0]; st.nonPawnKey[1] = old.nonPawnKey[1];
  st.nonPawn = old.nonPawn; st.pliesFromNull = 0; st.rule50 = old.rule50+1; st.castlingRights = old.castlingRights;
  st.capturedPiece = old.capturedPiece; st.epSquare = old.epSquare; st.key = old.key ^ zob.side; st.checkersBB = old.checkersBB;
  st.accumulator.colors[WHITE].set(old.accumulator.colors[WHITE]); st.accumulator.colors[BLACK].set(old.accumulator.colors[BLACK]); st.ply = old.ply+1;
  if (old.epSquare) { st.key ^= zob.enpassant[file_of(old.epSquare)]; st.epSquare = 0; }
  pos.sideToMove = 1-pos.sideToMove; pos.set_check_info(lsb(pos.pieces(KING,WHITE)),lsb(pos.pieces(KING,BLACK)));
}
export function undo_null_move(pos) { pos.sideToMove = 1-pos.sideToMove; pos.st_idx--; pos.st = pos.stack[pos.st_idx]; }
export function pos_fen(pos) {
  let result = '';
  for (let r = 7; r >= 0; r--) {
    let count = 0;
    for (let f = 0; f < 8; f++) {
      const pc = pos.board[r*8+f]; if (!pc) count++;
      else { if (count) { result += count; count = 0; } result += PieceToChar[pc]; }
    }
    if (count) result += count; if (r) result += '/';
  }
  result += pos.sideToMove === WHITE ? ' w ' : ' b ';
  const cr = pos.st.castlingRights;
  for (const [right,c,side,token] of [[WHITE_OO,WHITE,KING_SIDE,'K'],[WHITE_OOO,WHITE,QUEEN_SIDE,'Q'],[BLACK_OO,BLACK,KING_SIDE,'k'],[BLACK_OOO,BLACK,QUEEN_SIDE,'q']]) {
    if (cr & right) result += pos.chess960 ? String.fromCharCode((c === WHITE ? 65 : 97)+file_of(pos.castlingRookSquare[make_castling_right(c,side)])) : token;
  }
  if (!cr) result += '-';
  result += ' '+(pos.st.epSquare ? String.fromCharCode(97+file_of(pos.st.epSquare))+(1+rank_of(pos.st.epSquare)) : '-');
  return result+` ${pos.st.rule50} ${1+Math.floor((pos.gamePly-Number(pos.sideToMove === BLACK))/2)}`;
}
export function see_test(pos,m,value) {
  if (type_of_m(m) !== NORMAL) return 0 >= value;
  const from = from_sq(m), to = to_sq(m), board = pos.board;
  let swap = PieceValue[board[to]]-value; if (swap < 0) return false;
  swap = PieceValue[board[from]]-swap; if (swap <= 0) return true;
  const pieces = pos.byTypeBB, colors = pos.byColorBB, st = pos.st;
  let occ = pieces[0] ^ sq_bb(from) ^ sq_bb(to), stm = color_of(board[from]), attackers = attackers_to_occ(pos,to,occ), res = true;
  const bishopQueens = pieces[BISHOP] | pieces[QUEEN], rookQueens = pieces[ROOK] | pieces[QUEEN];
  while (true) {
    stm = 1-stm; attackers &= occ; let ours = attackers & colors[stm]; if (!ours) break;
    if ((ours & st.blockersForKing[stm]) && (st.pinnersForKing[stm] & occ)) ours &= ~st.blockersForKing[stm];
    if (!ours) break; res = !res;
    let pt = PAWN; while (pt < KING && !(ours & pieces[pt])) pt++;
    if (pt === KING) return (attackers & ~colors[stm]) ? !res : res;
    const bb = ours & pieces[pt]; swap = PieceValue[pt]-swap; if (swap < Number(res)) break;
    occ ^= bb & -bb;
    if (pt === PAWN || pt === BISHOP || pt === QUEEN) attackers |= attacks_bb_bishop(to,occ) & bishopQueens;
    if (pt === ROOK || pt === QUEEN) attackers |= attacks_bb_rook(to,occ) & rookQueens;
  }
  return res;
}
export function is_draw(pos) {
  const st = pos.st;
  if (st.rule50 > 99) return !st.checkersBB || generate_legal(pos).length > 0;
  const end = st.pliesFromNull-4;
  if (end >= 0) for (let i = 0, index = pos.st_idx-4; i <= end && index >= 0; i += 2, index -= 2) if (pos.stack[index].key === st.key) return true;
  return false;
}
export function has_game_cycle(pos,ply) {
  const end = pos.st.pliesFromNull, original = pos.st.key; let index = pos.st_idx-1;
  for (let i = 3; i <= end; i += 2) {
    index -= 2; if (index < 0) break; const key = original ^ pos.stack[index].key;
    let j = H1(key); if (cuckoo[j] !== key) j = H2(key);
    if (cuckoo[j] === key) {
      const m = cuckooMove[j], from = from_sq(m), to = to_sq(m);
      if (!((BetweenBB[from][to] ^ sq_bb(to)) & pos.pieces())) {
        if (ply > i || color_of(pos.board[pos.board[from] === 0 ? to : from]) === pos.sideToMove) return true;
      }
    }
  }
  return false;
}
export function attacks_by(pos,pt,c) {
  let bb = pos.byTypeBB[pt] & pos.byColorBB[c]; if (pt === PAWN) return pawn_attacks_bb(bb,c);
  let result = 0n; const occupied = pos.byTypeBB[0];
  while (bb) { const s = lsb(bb); bb &= bb-1n; result |= attacks_bb(pt,s,occupied); }
  return result;
}
zob_init();
