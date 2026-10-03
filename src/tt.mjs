import {BOUND_EXACT, DEPTH_OFFSET, VALUE_NONE, VALUE_MATE, VALUE_MATE_IN_MAX_PLY,
  VALUE_MATED_IN_MAX_PLY, VALUE_TB_WIN_IN_MAX_PLY, VALUE_TB_LOSS_IN_MAX_PLY} from './constants.mjs';
export const CLUSTER_SIZE = 3, CLUSTER_BYTES = 32;
export const TT = {clusterCount: 0, table: [], generation8: 0};
export class TTEntry { constructor(slot = -1,packed = 0n) { this.slot = slot; this.packed = packed; } }
export function i16(x) { return ((Number(x)&65535)^32768)-32768; }
function pack_tt(key,depth,gen,move,value,evalValue) {
  return BigInt(key&65535) | (BigInt(depth&255)<<16n) | (BigInt(gen&255)<<24n)
    | (BigInt(move&65535)<<32n) | (BigInt(value&65535)<<48n) | (BigInt(evalValue&65535)<<64n);
}
export function tte_save(tte,key,value,pv,bound,depth,move,evalValue) {
  const slot = tte.slot, current = TT.table[slot], tag = Number(key&65535n);
  const different = tag !== Number(current&65535n); let oldMove = Number((current>>32n)&65535n);
  const updateMove = !!(move || different); if (updateMove) oldMove = move&65535;
  if (different || depth-DEPTH_OFFSET+2*Number(pv) > Number((current>>16n)&255n)-4 || bound === BOUND_EXACT) {
    tte.packed = TT.table[slot] = pack_tt(tag,depth-DEPTH_OFFSET,TT.generation8 | (Number(pv)<<2) | bound,oldMove,value,evalValue);
  } else if (updateMove) tte.packed = TT.table[slot] = (current & ~(65535n<<32n)) | (BigInt(oldMove)<<32n);
}
export function tte_move(tte) { return Number((tte.packed>>32n)&65535n); }
export function tte_value(tte) { return i16(tte.packed>>48n); }
export function tte_eval(tte) { return i16(tte.packed>>64n); }
export function tte_depth(tte) { return Number((tte.packed>>16n)&255n)+DEPTH_OFFSET; }
export function tte_is_pv(tte) { return !!(tte.packed & (4n<<24n)); }
export function tte_bound(tte) { return Number((tte.packed>>24n)&3n); }
export function value_to_tt(v,ply) {
  if (v === VALUE_NONE) return v;
  if (v >= VALUE_TB_WIN_IN_MAX_PLY) return v+ply;
  if (v <= VALUE_TB_LOSS_IN_MAX_PLY) return v-ply;
  return v;
}
export function value_from_tt(v,ply,r50) {
  if (v === VALUE_NONE) return v;
  if (v >= VALUE_TB_WIN_IN_MAX_PLY) {
    if (v >= VALUE_MATE_IN_MAX_PLY && VALUE_MATE-v > 99-r50) return VALUE_MATE_IN_MAX_PLY-1;
    return v-ply;
  }
  if (v <= VALUE_TB_LOSS_IN_MAX_PLY) {
    if (v <= VALUE_MATED_IN_MAX_PLY && VALUE_MATE+v > 99-r50) return VALUE_MATED_IN_MAX_PLY+1;
    return v+ply;
  }
  return v;
}
export function tt_free() { TT.table = []; TT.clusterCount = 0; }
export function tt_new_search() { TT.generation8 = (TT.generation8+8)&255; }
export function tt_probe(key) {
  const idx = Number(((key & 0xffffffffffffffffn)*BigInt(TT.clusterCount))>>64n)*CLUSTER_SIZE;
  const tag = key&65535n, table = TT.table;
  for (let offset = 0; offset < CLUSTER_SIZE; offset++) {
    const slot = idx+offset; let packed = table[slot]; const depth = Number((packed>>16n)&255n);
    if ((packed&65535n) === tag || !depth) {
      if (depth) packed = table[slot] = (packed & ~(248n<<24n)) | (BigInt(TT.generation8)<<24n);
      return [depth !== 0,new TTEntry(slot,packed)];
    }
  }
  const replacementValue = packed => Number((packed>>16n)&255n)-((263+TT.generation8-Number((packed>>24n)&255n))&248);
  let slot = idx, packed = table[idx], value = replacementValue(packed);
  for (let offset = 1; offset < CLUSTER_SIZE; offset++) {
    const candidate = table[idx+offset], candidateValue = replacementValue(candidate);
    if (candidateValue < value) { slot = idx+offset; packed = candidate; value = candidateValue; }
  }
  return [false,new TTEntry(slot,packed)];
}
export function tt_allocate(_mb) { tt_free(); TT.clusterCount = 896*1024/CLUSTER_BYTES; TT.table = Array(TT.clusterCount*CLUSTER_SIZE).fill(0n); TT.generation8 = 0; }
export function tt_clear() { if (TT.table.length) TT.table = Array(TT.table.length).fill(0n); }
export function tt_hashfull() {
  if (!TT.clusterCount) return 0;
  const samples = Math.min(Math.floor(1000/CLUSTER_SIZE),TT.clusterCount); let used = 0;
  for (let slot = 0; slot < samples*CLUSTER_SIZE; slot++) {
    const packed = TT.table[slot];
    if (((packed>>16n)&255n) && Number((packed>>24n)&248n) === TT.generation8) used++;
  }
  return Math.floor(used*1000/(CLUSTER_SIZE*samples));
}
