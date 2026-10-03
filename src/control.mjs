export const EngineOptions = {Hash: 1, Threads: 1, Ponder: false, MultiPV: 1, UCI_Chess960: false};
export class LimitsType {
  constructor() { this.reset(); }
  reset() { this.time = [0,0]; this.inc = [0,0]; this.depth = 0; this.movetime = 0; this.nodes = 0; this.infinite = false; this.startTime = 0; }
}
export const Limits = new LimitsType();
let stopSignal = null;
export function set_stop_signal(signal) { stopSignal = signal; }
export const Threads = {
  workers: [], _stop: false, _ponder: false, stopOnPonderhit: false, increaseDepth: true,
  get stop() { return this._stop || !!(stopSignal && (Atomics.load(stopSignal,0) || (Atomics.load(stopSignal,1) && this.stopOnPonderhit))); },
  set stop(value) { this._stop = value; },
  get ponder() { return this._ponder && !(stopSignal && Atomics.load(stopSignal,1)); },
  set ponder(value) { this._ponder = value; },
  searching: false, sleeping: false, counterMoveHistory: null,
  get numThreads() { return this.workers.length; },
  nodes_searched() { return this.workers.reduce((sum,w)=>sum+w.pos.nodes,0); },
  request_stop() { this.stop = true; }
};
export const mainThread = {previousScore: 32001, bestPreviousAverageScore: 32001, previousTimeReduction: 1, iterValue: [0,0,0,0]};
let engineOutput = () => {};
export function set_output(output) { engineOutput = output; }
export function emit_output(line) { engineOutput(line); }
