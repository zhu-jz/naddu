export const EngineOptions = {Hash: 1, ReferenceTT: false, Threads: 1, Ponder: false, MultiPV: 1, UCI_Chess960: false};
export class LimitsType {
  constructor() { this.reset(); }
  reset() { this.time = [0,0]; this.inc = [0,0]; this.depth = 0; this.movetime = 0; this.nodes = 0; this.infinite = false; this.startTime = 0; }
}
export const Limits = new LimitsType();
let stopSignal = null;
export function set_stop_signal(signal) { stopSignal = signal; }
export const Threads = {
  workers: [], backend: null, maxThreads: 1, sharedNodes: null, _stop: false, _ponder: false, _stopOnPonderhit: false, _increaseDepth: true,
  get stop() { return this._stop || !!(stopSignal && (Atomics.load(stopSignal,0) || (Atomics.load(stopSignal,1) && this.stopOnPonderhit))); },
  set stop(value) { this._stop = value; if (stopSignal) Atomics.store(stopSignal,0,Number(value)); },
  get ponder() { return this._ponder && !(stopSignal && Atomics.load(stopSignal,1)); },
  set ponder(value) { this._ponder = value; },
  get stopOnPonderhit() { return stopSignal && stopSignal.length>3 ? !!Atomics.load(stopSignal,3) : this._stopOnPonderhit; },
  set stopOnPonderhit(value) { this._stopOnPonderhit = value; if (stopSignal && stopSignal.length>3) Atomics.store(stopSignal,3,Number(value)); },
  get increaseDepth() { return stopSignal && stopSignal.length>2 ? !!Atomics.load(stopSignal,2) : this._increaseDepth; },
  set increaseDepth(value) { this._increaseDepth = value; if (stopSignal && stopSignal.length>2) Atomics.store(stopSignal,2,Number(value)); },
  searching: false, sleeping: false, counterMoveHistory: null,
  get numThreads() { return this.workers.length; },
  nodes_searched() {
    if (this.sharedNodes) { let nodes = 0; for (let i = 0; i<this.numThreads; i++) nodes += Number(Atomics.load(this.sharedNodes,i)); return nodes; }
    return this.workers.reduce((sum,w)=>sum+w.pos.nodes,0);
  },
  request_stop() { this.stop = true; }
};
export function publish_nodes(pos) { if (Threads.sharedNodes) Atomics.store(Threads.sharedNodes,pos.threadIdx,BigInt(pos.nodes)); }
export const mainThread = {previousScore: 32001, bestPreviousAverageScore: 32001, previousTimeReduction: 1, iterValue: [0,0,0,0]};
let engineOutput = () => {};
export function set_output(output) { engineOutput = output; }
export function emit_output(line) { engineOutput(line); }
