import {BOUND_EXACT, DEPTH_OFFSET, VALUE_NONE, VALUE_MATE, VALUE_MATE_IN_MAX_PLY,
  VALUE_MATED_IN_MAX_PLY, VALUE_TB_WIN_IN_MAX_PLY, VALUE_TB_LOSS_IN_MAX_PLY} from './constants.mjs';
export const CLUSTER_SIZE = 3, CLUSTER_BYTES = 32;
export const MAX_HASH_MB = 256;
export const TT_LOCK_STRIPES = 1024;
export const TT = {clusterCount: 0, table: [], generation8: 0, shared: null};
export class TTEntry { constructor(slot = -1,packed = 0n) { this.slot = slot; this.packed = packed; } }
export function i16(x) { return ((Number(x)&65535)^32768)-32768; }
function pack_tt(key,depth,gen,move,value,evalValue) {
  return BigInt(key&65535) | (BigInt(depth&255)<<16n) | (BigInt(gen&255)<<24n)
    | (BigInt(move&65535)<<32n) | (BigInt(value&65535)<<48n) | (BigInt(evalValue&65535)<<64n);
}
function tt_lock(slot) {
  const stripe = Math.floor(slot/CLUSTER_SIZE)&(TT_LOCK_STRIPES-1), locks = TT.shared.locks;
  while (Atomics.compareExchange(locks,stripe,0,1)!==0) Atomics.wait(locks,stripe,1);
  return stripe;
}
function tt_unlock(stripe) { Atomics.store(TT.shared.locks,stripe,0); Atomics.notify(TT.shared.locks,stripe,1); }
function tt_read_unlocked(slot) { return TT.shared.low[slot] | (BigInt(TT.shared.eval[slot])<<64n); }
function tt_write_unlocked(slot,packed) { TT.shared.low[slot] = BigInt.asUintN(64,packed); TT.shared.eval[slot] = Number((packed>>64n)&65535n); }
export function tt_read(slot) {
  if (!TT.shared) return TT.table[slot];
  const stripe = tt_lock(slot);
  try { return tt_read_unlocked(slot); } finally { tt_unlock(stripe); }
}
function save_tt_entry(tte,key,value,pv,bound,depth,move,evalValue) {
  const slot = tte.slot, current = TT.shared ? tt_read_unlocked(slot) : TT.table[slot], tag = Number(key&65535n);
  const different = tag !== Number(current&65535n); let oldMove = Number((current>>32n)&65535n);
  const updateMove = !!(move || different); if (updateMove) oldMove = move&65535;
  if (different || depth-DEPTH_OFFSET+2*Number(pv) > Number((current>>16n)&255n)-4 || bound === BOUND_EXACT) {
    tte.packed = pack_tt(tag,depth-DEPTH_OFFSET,TT.generation8 | (Number(pv)<<2) | bound,oldMove,value,evalValue);
  } else if (updateMove) tte.packed = (current & ~(65535n<<32n)) | (BigInt(oldMove)<<32n);
  else return;
  if (TT.shared) tt_write_unlocked(slot,tte.packed); else TT.table[slot] = tte.packed;
}
export function tte_save(tte,key,value,pv,bound,depth,move,evalValue) {
  if (!TT.shared) return save_tt_entry(tte,key,value,pv,bound,depth,move,evalValue);
  const stripe = tt_lock(tte.slot);
  try { save_tt_entry(tte,key,value,pv,bound,depth,move,evalValue); } finally { tt_unlock(stripe); }
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
export function tt_free() { TT.table = []; TT.clusterCount = 0; TT.shared = null; }
export function tt_new_search() { TT.generation8 = (TT.generation8+8)&255; }
export function tt_probe(key) {
  if (TT.shared) return tt_probe_shared(key);
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
function tt_probe_shared(key) {
  const idx = Number(((key & 0xffffffffffffffffn)*BigInt(TT.clusterCount))>>64n)*CLUSTER_SIZE, tag = key&65535n;
  for (let offset = 0; offset<CLUSTER_SIZE; offset++) {
    const slot = idx+offset; let packed = tt_read(slot), depth = Number((packed>>16n)&255n);
    if ((packed&65535n)===tag || !depth) {
      let found = depth!==0;
      if (found) {
        const stripe = tt_lock(slot);
        try {
          packed = tt_read_unlocked(slot);
          if ((packed&65535n)===tag && ((packed>>16n)&255n)) {
            packed = (packed & ~(248n<<24n)) | (BigInt(TT.generation8)<<24n);
            tt_write_unlocked(slot,packed);
          } else found = false;
        } finally { tt_unlock(stripe); }
      }
      return [found,new TTEntry(slot,packed)];
    }
  }
  let replacementSlot = idx, replacementPacked = 0n, replacementValue = Infinity;
  for (let offset = 0; offset<CLUSTER_SIZE; offset++) {
    const slot = idx+offset, packed = tt_read(slot), depth = Number((packed>>16n)&255n);
    const value = depth-((263+TT.generation8-Number((packed>>24n)&255n))&248);
    if (value<replacementValue) { replacementSlot = slot; replacementPacked = packed; replacementValue = value; }
  }
  return [false,new TTEntry(replacementSlot,replacementPacked)];
}
function new_shared_tt(clusterCount) {
  const entries = clusterCount*CLUSTER_SIZE;
  return {clusterCount,generation8:0,lowBuffer:new SharedArrayBuffer(entries*8),
    evalBuffer:new SharedArrayBuffer(entries*2),lockBuffer:new SharedArrayBuffer(TT_LOCK_STRIPES*4)};
}
export function tt_attach_shared(descriptor) {
  TT.shared = {low:new BigUint64Array(descriptor.lowBuffer),eval:new Uint16Array(descriptor.evalBuffer),locks:new Int32Array(descriptor.lockBuffer)};
  TT.clusterCount = descriptor.clusterCount; TT.generation8 = descriptor.generation8;
  TT.table = new Proxy({length:TT.clusterCount*CLUSTER_SIZE},{get(target,name) {
    if (typeof name==='string' && /^\d+$/.test(name)) return tt_read(Number(name));
    return target[name];
  }});
}
export function tt_shared_descriptor() {
  return TT.shared && {clusterCount:TT.clusterCount,generation8:TT.generation8,lowBuffer:TT.shared.low.buffer,
    evalBuffer:TT.shared.eval.buffer,lockBuffer:TT.shared.locks.buffer};
}
export function tt_set_shared(shared) {
  if (shared===!!TT.shared) return;
  if (shared) {
    const descriptor = new_shared_tt(TT.clusterCount), low = new BigUint64Array(descriptor.lowBuffer), evals = new Uint16Array(descriptor.evalBuffer);
    for (let i = 0; i<TT.table.length; i++) { low[i] = BigInt.asUintN(64,TT.table[i]); evals[i] = Number((TT.table[i]>>64n)&65535n); }
    descriptor.generation8 = TT.generation8; tt_attach_shared(descriptor);
  } else {
    const table = Array(TT.table.length);
    for (let i = 0; i<table.length; i++) table[i] = tt_read(i);
    TT.table = table; TT.shared = null;
  }
}
export function tt_allocate(mb,reference = false,shared = !!TT.shared) {
  if (!Number.isInteger(mb) || mb<1 || mb>MAX_HASH_MB) throw new RangeError(`Hash must be between 1 and ${MAX_HASH_MB} MiB`);
  const clusterCount = Math.floor((reference ? 896*1024 : mb*1024*1024)/CLUSTER_BYTES);
  // Allocate before publishing so a failed resize leaves the current TT intact.
  if (shared) tt_attach_shared(new_shared_tt(clusterCount));
  else {
    const table = Array(clusterCount*CLUSTER_SIZE).fill(0n);
    TT.table = table; TT.clusterCount = clusterCount; TT.generation8 = 0; TT.shared = null;
  }
}
export function tt_clear() {
  if (TT.shared) { TT.shared.low.fill(0n); TT.shared.eval.fill(0); }
  else TT.table.fill(0n);
}
export function tt_hashfull() {
  if (!TT.clusterCount) return 0;
  const samples = Math.min(Math.floor(1000/CLUSTER_SIZE),TT.clusterCount); let used = 0;
  for (let slot = 0; slot < samples*CLUSTER_SIZE; slot++) {
    const packed = tt_read(slot);
    if (((packed>>16n)&255n) && Number((packed>>24n)&248n) === TT.generation8) used++;
  }
  return Math.floor(used*1000/(CLUSTER_SIZE*samples));
}
