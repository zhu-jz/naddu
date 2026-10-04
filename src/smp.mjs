import {MAX_PLY} from './constants.mjs';
import {Threads,Limits,EngineOptions,set_stop_signal,set_output} from './control.mjs';
import {Position,create_counter_move_history} from './position.mjs';
import {clear_histories} from './history.mjs';
import {tt_set_shared,tt_shared_descriptor,tt_attach_shared} from './tt.mjs';
import {Time} from './timeman.mjs';
import {thread_search,prepare_worker_root} from './search.mjs';

export const MAX_THREADS = 16;
const SMP_STRIDE = 4, SMP_RESULT_SIZE = MAX_PLY+16, SMP_ERROR_SIZE = 1024;
function smp_status(stats,index,value) { Atomics.store(stats,index*SMP_STRIDE,value); Atomics.notify(stats,index*SMP_STRIDE); }
function smp_bind_changes(pos,stats,index) {
  Object.defineProperty(pos,'bestMoveChanges',{configurable:true,
    get() { return Atomics.load(stats,index*SMP_STRIDE+1); },
    set(value) { Atomics.store(stats,index*SMP_STRIDE+1,value); }});
}
function smp_failure(shared,index,error) {
  const message=String(error.stack || error), start=index*SMP_ERROR_SIZE;
  shared.errors.fill(0,start,start+SMP_ERROR_SIZE);
  for(let i=0;i<Math.min(message.length,SMP_ERROR_SIZE-1);i++) shared.errors[start+i]=message.charCodeAt(i);
  Atomics.store(shared.signal,0,1); smp_status(shared.stats,index,-1);
}
export function report_smp_helper_error(descriptor,error) {
  smp_failure({signal:new Int32Array(descriptor.signal),stats:new Int32Array(descriptor.stats),
    errors:new Uint16Array(descriptor.errors)},descriptor.index,error);
}
function smp_wait(shared,index,wanted) {
  const deadline=Date.now()+10000, slot=index*SMP_STRIDE;
  while(Atomics.load(shared.stats,slot)!==wanted) {
    const status=Atomics.load(shared.stats,slot);
    if(status===wanted) break;
    if(status===-1) {
      let message=''; for(let i=index*SMP_ERROR_SIZE;i<(index+1)*SMP_ERROR_SIZE && shared.errors[i];i++) message+=String.fromCharCode(shared.errors[i]);
      throw new Error(`SMP worker ${index} failed: ${message}`);
    }
    if(Date.now()>deadline) throw new Error(`SMP worker ${index} timed out waiting for state ${wanted}`);
    Atomics.wait(shared.stats,slot,status,50);
  }
}
function smp_publish_result(pos,shared,index) {
  const result=shared.results.subarray(index*SMP_RESULT_SIZE,(index+1)*SMP_RESULT_SIZE), rm=pos.rootMoves.move[0];
  result[0]=pos.completedDepth; result[1]=pos.rootDepth; result[2]=pos.multiPV; result[3]=pos.pvIdx;
  result[4]=pos.rootMoves.size; result[5]=rm.score; result[6]=rm.previousScore; result[7]=rm.averageScore;
  result[8]=rm.selDepth; result[9]=rm.pvSize;
  result.fill(0,10); result.set(rm.pv.slice(0,rm.pvSize),10);
}
function smp_read_result(worker,shared,index) {
  const result=shared.results.subarray(index*SMP_RESULT_SIZE,(index+1)*SMP_RESULT_SIZE), pos=worker.pos;
  pos.completedDepth=result[0]; pos.rootDepth=result[1]; pos.multiPV=result[2]; pos.pvIdx=result[3];
  pos.rootMoves={size:result[4],move:[{score:result[5],previousScore:result[6],averageScore:result[7],
    selDepth:result[8],pvSize:result[9],pv:Array.from(result.subarray(10,10+MAX_PLY+1))}]};
}
export function create_smp_pool(factory,signal) {
  const shared={signal,stats:new Int32Array(new SharedArrayBuffer(MAX_THREADS*SMP_STRIDE*4)),
    nodes:new BigUint64Array(new SharedArrayBuffer(MAX_THREADS*8)),
    results:new Int32Array(new SharedArrayBuffer(MAX_THREADS*SMP_RESULT_SIZE*4)),
    errors:new Uint16Array(new SharedArrayBuffer(MAX_THREADS*SMP_ERROR_SIZE*2))};
  const historyBuffer=new SharedArrayBuffer(16*64*1024), helpers=[];
  const pool={history:create_counter_move_history(historyBuffer,true),root:null,running:false,
    resize(num) {
      if(!Number.isInteger(num) || num<1 || num>MAX_THREADS) throw new RangeError('Threads must be between 1 and 16');
      smp_bind_changes(Threads.workers[0].pos,shared.stats,0);
      while(helpers.length>num-1) {
        const helper=helpers.pop(); helper.send({kind:'exit'}); smp_wait(shared,helper.index,9); helper.terminate(); Threads.workers.pop();
      }
      try {
        while(helpers.length<num-1) {
          const index=helpers.length+1; smp_status(shared.stats,index,1);
          const helper=factory(index,{index,signal:signal.buffer,history:historyBuffer,stats:shared.stats.buffer,
            nodes:shared.nodes.buffer,results:shared.results.buffer,errors:shared.errors.buffer});
          helper.index=index; helpers.push(helper);
          const pos={threadIdx:index,completedDepth:0,rootMoves:null};
          Object.defineProperty(pos,'nodes',{get(){return Number(Atomics.load(shared.nodes,index));}});
          smp_bind_changes(pos,shared.stats,index); Threads.workers.push({pos,remote:true});
          smp_wait(shared,index,0);
        }
        tt_set_shared(num>1); Threads.sharedNodes=num>1 ? shared.nodes : null;
      } catch(error) { this.shutdown(); throw error; }
    },
    start_helpers(pos) {
      if(!helpers.length) return;
      shared.nodes.fill(0n); this.running=true;
      const legal=pos.rootMoves.move.slice(0,pos.rootMoves.size).map(rm=>({move:rm.pv[0]}));
      try {
        for(const helper of helpers) {
          smp_status(shared.stats,helper.index,1); Atomics.store(shared.stats,helper.index*SMP_STRIDE+2,0);
          helper.send({kind:'search',root:this.root,legal,limits:Limits,options:EngineOptions,time:Time,
            tt:tt_shared_descriptor(),numThreads:Threads.numThreads,ponder:Threads.ponder});
        }
        for(const helper of helpers) smp_wait(shared,helper.index,2);
      } catch(error) { Threads.request_stop(); throw error; }
      finally {
        for(const helper of helpers) { Atomics.store(shared.stats,helper.index*SMP_STRIDE+2,1); Atomics.notify(shared.stats,helper.index*SMP_STRIDE+2); }
      }
    },
    wait_helpers() {
      if(!this.running) return;
      let failure=null;
      for(const helper of helpers) {
        try { smp_wait(shared,helper.index,0); smp_read_result(Threads.workers[helper.index],shared,helper.index); }
        catch(error) { failure ||= error; }
      }
      this.running=false; if(failure) throw failure;
    },
    clear_helpers() {
      for(const helper of helpers) { smp_status(shared.stats,helper.index,1); helper.send({kind:'clear'}); }
      for(const helper of helpers) smp_wait(shared,helper.index,0);
    },
    shutdown() {
      Threads.request_stop();
      for(const helper of helpers) {
        Atomics.store(shared.stats,helper.index*SMP_STRIDE+2,1); Atomics.notify(shared.stats,helper.index*SMP_STRIDE+2);
        helper.terminate();
      }
      helpers.length=0; Threads.workers.splice(1); Threads.sharedNodes=null;
      Threads.backend=null; Threads.maxThreads=1; this.running=false;
    }
  };
  Threads.backend=pool; Threads.maxThreads=MAX_THREADS;
  return pool;
}
export function install_smp_helper(descriptor) {
  const index=descriptor.index, shared={signal:new Int32Array(descriptor.signal),stats:new Int32Array(descriptor.stats),
    nodes:new BigUint64Array(descriptor.nodes),results:new Int32Array(descriptor.results),errors:new Uint16Array(descriptor.errors)};
  set_stop_signal(shared.signal,true); set_output(()=>{});
  let pos;
  try {
    const history=create_counter_move_history(descriptor.history); pos=new Position(true,history); pos.threadIdx=index;
    Threads.counterMoveHistory=history; smp_bind_changes(pos,shared.stats,index); smp_status(shared.stats,index,0);
  } catch(error) { smp_failure(shared,index,error); return ()=>true; }
  return message=>{
    try {
      if(message.kind==='exit') { smp_status(shared.stats,index,9); return true; }
      if(message.kind==='clear') { clear_histories(pos); smp_status(shared.stats,index,0); return false; }
      if(message.kind!=='search') throw new Error('Unknown SMP helper command');
      Object.assign(EngineOptions,message.options); Object.assign(Limits,message.limits); Object.assign(Time,message.time);
      Threads.workers=Array.from({length:message.numThreads},()=>({pos:{}})); Threads.workers[index]={pos};
      Threads.sharedNodes=shared.nodes; Threads._stop=false; Threads._ponder=message.ponder;
      tt_attach_shared(message.tt); prepare_worker_root(pos,message.root,message.legal);
      Atomics.store(shared.nodes,index,0n); pos.bestMoveChanges=0; smp_status(shared.stats,index,2);
      const goSlot=index*SMP_STRIDE+2;
      while(!Atomics.load(shared.stats,goSlot)) Atomics.wait(shared.stats,goSlot,0);
      smp_status(shared.stats,index,3); thread_search(pos);
      smp_publish_result(pos,shared,index); smp_status(shared.stats,index,0);
    } catch(error) { smp_failure(shared,index,error); }
    return false;
  };
}
