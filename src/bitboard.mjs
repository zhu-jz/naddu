import {WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, NORTH, SOUTH, EAST, WEST,
  NORTH_EAST, NORTH_WEST, SOUTH_EAST, SOUTH_WEST, file_of, rank_of, square_is_ok} from './constants.mjs';
import {BISHOP_MAGICS, ROOK_MAGICS} from './generated/magics.mjs';

export const AllSquares = 0xffffffffffffffffn;
export const DarkSquares = 0xaa55aa55aa55aa55n, LightSquares = ~DarkSquares & AllSquares;
export const FileABB = 0x0101010101010101n;
export const FileBBB = FileABB << 1n, FileCBB = FileABB << 2n, FileDBB = FileABB << 3n;
export const FileEBB = FileABB << 4n, FileFBB = FileABB << 5n, FileGBB = FileABB << 6n, FileHBB = FileABB << 7n;
export const NOT_FileABB = ~FileABB & AllSquares, NOT_FileHBB = ~FileHBB & AllSquares;
export const Rank1BB = 0xffn, Rank2BB = Rank1BB << 8n, Rank3BB = Rank1BB << 16n, Rank4BB = Rank1BB << 24n;
export const Rank5BB = Rank1BB << 32n, Rank6BB = Rank1BB << 40n, Rank7BB = Rank1BB << 48n, Rank8BB = Rank1BB << 56n;
export const QueenSide = FileABB | FileBBB | FileCBB | FileDBB;
export const CenterFiles = FileCBB | FileDBB | FileEBB | FileFBB;
export const KingSide = FileEBB | FileFBB | FileGBB | FileHBB;
export const Center = (FileDBB | FileEBB) & (Rank4BB | Rank5BB);
export const SquareDistance = Array.from({length: 64}, () => new Uint8Array(64));
export const FileBB = Array.from({length: 8}, (_, f) => FileABB << BigInt(f));
export const RankBB = Array.from({length: 8}, (_, r) => Rank1BB << BigInt(r * 8));
export const BetweenBB = Array.from({length: 64}, () => Array(64).fill(0n));
export const LineBB = Array.from({length: 64}, () => Array(64).fill(0n));
export const PseudoAttacks = Array.from({length: 8}, () => Array(64).fill(0n));
export const PawnAttacks = Array.from({length: 2}, () => Array(64).fill(0n));
export const RookMasks = Array(64).fill(0n), RookMagics = ROOK_MAGICS;
export const RookAttacks = Array.from({length: 64}, () => new BigUint64Array(4096));
export const BishopMasks = Array(64).fill(0n), BishopMagics = BISHOP_MAGICS;
export const BishopAttacks = Array.from({length: 64}, () => new BigUint64Array(512));
export const RookDirs = [NORTH, EAST, SOUTH, WEST];
export const BishopDirs = [NORTH_EAST, SOUTH_EAST, SOUTH_WEST, NORTH_WEST];
const squareBits = Array.from({length: 64}, (_, s) => 1n << BigInt(s));
export function sq_bb(s) { return squareBits[s] ?? ((1n << BigInt(s)) & AllSquares); }
export function more_than_one(b) { return (b & (b - 1n)) !== 0n; }
export function rank_bb_s(s) { return RankBB[rank_of(s)]; }
export function file_bb_s(s) { return FileBB[file_of(s)]; }
export function shift_bb(d, b) {
  switch (d) {
    case NORTH: return (b << 8n) & AllSquares;
    case SOUTH: return b >> 8n;
    case NORTH_EAST: return ((b & NOT_FileHBB) << 9n) & AllSquares;
    case SOUTH_EAST: return (b & NOT_FileHBB) >> 7n;
    case NORTH_WEST: return ((b & NOT_FileABB) << 7n) & AllSquares;
    case SOUTH_WEST: return (b & NOT_FileABB) >> 9n;
    case EAST: return ((b & NOT_FileHBB) << 1n) & AllSquares;
    case WEST: return (b & NOT_FileABB) >> 1n;
    case 16: return (b << 16n) & AllSquares;
    case -16: return b >> 16n;
    default: return 0n;
  }
}
export function pawn_attacks_bb(b, c) {
  return c === WHITE ? (((b & NOT_FileABB) << 7n) | ((b & NOT_FileHBB) << 9n)) & AllSquares
    : ((b & NOT_FileABB) >> 9n) | ((b & NOT_FileHBB) >> 7n);
}
export function aligned(m, s) { return (LineBB[(m >> 6) & 63][m & 63] & sq_bb(s)) !== 0n; }
export function distance(x, y) { return SquareDistance[x][y]; }
export function distance_f(x, y) { return Math.abs(file_of(x) - file_of(y)); }
export function distance_r(x, y) { return Math.abs(rank_of(x) - rank_of(y)); }
export function attacks_bb_bishop(s, occupied) {
  return BishopAttacks[s][Number((((occupied & BishopMasks[s]) * BishopMagics[s]) & AllSquares) >> 55n)];
}
export function attacks_bb_rook(s, occupied) {
  return RookAttacks[s][Number((((occupied & RookMasks[s]) * RookMagics[s]) & AllSquares) >> 52n)];
}
export function attacks_bb_queen(s, occupied) { return attacks_bb_bishop(s, occupied) | attacks_bb_rook(s, occupied); }
export function attacks_bb(pt, s, occupied) {
  return pt === BISHOP ? attacks_bb_bishop(s, occupied) : pt === ROOK ? attacks_bb_rook(s, occupied)
    : pt === QUEEN ? attacks_bb_queen(s, occupied) : PseudoAttacks[pt][s];
}
export function lsb(b) {
  const lo = Number(b & 0xffffffffn);
  if (lo) return 31 - Math.clz32(lo & -lo);
  const hi = Number(b >> 32n);
  return hi ? 63 - Math.clz32(hi & -hi) : -1;
}
export function pop_lsb(b) { return [lsb(b), b & (b - 1n)]; }
export function sliding_attack(dirs, square, occupied) {
  let attack = 0n;
  for (const d of dirs) {
    let s = square + d;
    while (square_is_ok(s) && distance(s, s - d) === 1) {
      attack |= sq_bb(s);
      if (occupied & sq_bb(s)) break;
      s += d;
    }
  }
  return attack;
}
function init_magics(magics, attacks, masks, dirs, shift) {
  for (let s = 0; s < 64; s++) {
    const edges = ((Rank1BB | Rank8BB) & ~rank_bb_s(s)) | ((FileABB | FileHBB) & ~file_bb_s(s));
    const mask = masks[s] = sliding_attack(dirs, s, 0n) & ~edges;
    let b = 0n;
    do {
      const index = Number(((b * magics[s]) & AllSquares) >> BigInt(shift));
      attacks[s][index] = sliding_attack(dirs, s, b);
      b = (b - mask) & mask;
    } while (b);
  }
}
export function bitboards_init() {
  for (let s1 = 0; s1 < 64; s1++) for (let s2 = 0; s2 < 64; s2++) {
    SquareDistance[s1][s2] = Math.max(distance_f(s1, s2), distance_r(s1, s2));
  }
  const steps = [[], [7,9], [6,10,15,17], [], [], [], [1,7,8,9]];
  for (let c = 0; c < 2; c++) for (let pt = PAWN; pt <= KING; pt++) for (let s = 0; s < 64; s++) {
    for (const step of steps[pt]) {
      const to = s + (c === WHITE ? step : -step);
      if (square_is_ok(to) && distance(s, to) < 3) {
        if (pt === PAWN) PawnAttacks[c][s] |= sq_bb(to);
        else PseudoAttacks[pt][s] |= sq_bb(to);
      }
    }
  }
  init_magics(RookMagics, RookAttacks, RookMasks, RookDirs, 52);
  init_magics(BishopMagics, BishopAttacks, BishopMasks, BishopDirs, 55);
  for (let s1 = 0; s1 < 64; s1++) {
    PseudoAttacks[BISHOP][s1] = attacks_bb_bishop(s1, 0n);
    PseudoAttacks[ROOK][s1] = attacks_bb_rook(s1, 0n);
    PseudoAttacks[QUEEN][s1] = PseudoAttacks[BISHOP][s1] | PseudoAttacks[ROOK][s1];
    for (let s2 = 0; s2 < 64; s2++) {
      BetweenBB[s1][s2] = sq_bb(s2);
      for (let pt = BISHOP; pt <= ROOK; pt++) {
        if (!(PseudoAttacks[pt][s1] & sq_bb(s2))) continue;
        LineBB[s1][s2] = (attacks_bb(pt, s1, 0n) & attacks_bb(pt, s2, 0n)) | sq_bb(s1) | sq_bb(s2);
        BetweenBB[s1][s2] |= attacks_bb(pt, s1, sq_bb(s2)) & attacks_bb(pt, s2, sq_bb(s1));
      }
    }
  }
}
bitboards_init();
