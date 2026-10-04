import {EngineOptions} from './control.mjs';
let engineClock = () => Date.now();
export function set_clock(clock) { engineClock = clock; }
export function now() { return Math.trunc(engineClock()); }
export const Time = {startTime: 0,optimumTime: 0,maximumTime: 0};
export function time_init(us,ply,limits) {
  const overhead = 10; let mtg = 50;
  if (limits.time[us]<1000 && limits.time[us]>0 && mtg/limits.time[us]>0.05) mtg = Math.trunc(limits.time[us]*0.05);
  Time.startTime = limits.startTime;
  const timeLeft = Math.max(1,limits.time[us]+limits.inc[us]*(mtg-1)-overhead*(2+mtg));
  let extra = 1;
  if (limits.time[us]>0) extra = Math.max(1,Math.min(1.12,1+12*limits.inc[us]/limits.time[us]));
  const optScale = Math.min(0.0120+Math.pow(ply+3,0.45)*0.0039,0.2*limits.time[us]/timeLeft)*extra;
  const maxScale = Math.min(7,4+ply/12);
  Time.optimumTime = Math.trunc(optScale*timeLeft);
  Time.maximumTime = Math.trunc(Math.min(0.8*limits.time[us]-overhead,maxScale*Time.optimumTime));
  if (EngineOptions.Ponder) Time.optimumTime += Math.floor(Time.optimumTime/3);
}
export function time_optimum() { return Time.optimumTime; }
export function time_maximum() { return Time.maximumTime; }
export function time_elapsed() { return now()-Time.startTime; }
