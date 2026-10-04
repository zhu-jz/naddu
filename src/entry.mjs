import {EngineUCI, canonical_command} from './uci.mjs';
import {set_stop_signal} from './control.mjs';
import {create_smp_pool,install_smp_helper,report_smp_helper_error} from './smp.mjs';

// The receiver stays responsive while one persistent worker searches. Shared
// flags interrupt recursion without restarting the engine or losing histories.
export function create_receiver(send,output,shutdown,signal) {
  const queue=[]; let active=null, quitting=false, ended=false;
  function pump() {
    if (active || !queue.length) {
      if (!active && !queue.length && ended && !quitting) submit('quit');
      return;
    }
    active=queue.shift();
    if (/^(go|bench)\b/.test(active)) { Atomics.store(signal,0,0); Atomics.store(signal,1,0); }
    send(active);
  }
  function submit(command) {
    command=canonical_command(command); if (!command || quitting) return;
    const token=command.split(' ')[0];
    if (token==='stop' || token==='quit') Atomics.store(signal,0,1);
    if (token==='ucinewgame' && active && /^go\b/.test(active)) Atomics.store(signal,0,1);
    if (token==='go' && active && /^go\b/.test(active)
      && (/\b(infinite|ponder)\b/.test(active) || !/\b(depth|nodes|movetime|wtime|btime)\b/.test(active))) Atomics.store(signal,0,1);
    if (token==='isready' && active && /^go\b/.test(active)
      && queue.some(s=>/^setoption name (?:Hash|ReferenceTT|Threads)\b/i.test(s))) Atomics.store(signal,0,1);
    if (token==='ponderhit') Atomics.store(signal,1,1);
    // With no pending setting changes, UCI readiness does not wait for search.
    if (token==='isready' && active && /^go\b/.test(active) && !queue.length) { output('readyok'); return; }
    if (token==='quit') { quitting=true; queue.length=0; }
    queue.push(command); pump();
  }
  return {
    submit,
    done(message) {
      active=null;
      if (message.quit) { shutdown(); return; }
      pump();
    },
    end() {
      ended=true;
      // An unbounded search must be interrupted when its input disappears.
      if (active && /^go\b/.test(active) && (!/\b(depth|nodes|movetime|wtime|btime)\b/.test(active) || /\b(infinite|ponder)\b/.test(active))) submit('quit');
      else pump();
    }
  };
}

export function install_entry() {
  const isNode=typeof process!=='undefined' && process.versions && process.versions.node;
  if (isNode) {
    const {Worker,isMainThread,workerData,parentPort}=require('node:worker_threads');
    if (!isMainThread && workerData && workerData.nadduHelper) {
      const handle=install_smp_helper(workerData.nadduHelper);
      parentPort.on('message',message=>{if(handle(message)) parentPort.close();}); return;
    }
    if (!isMainThread && workerData && workerData.nadduSearch) {
      const signal=new Int32Array(workerData.signal); set_stop_signal(signal,true);
      const pool=create_smp_pool((index,descriptor)=>{
        const worker=new Worker(__filename,{workerData:{nadduHelper:descriptor}});
        worker.on('error',error=>{report_smp_helper_error(descriptor,error);parentPort.postMessage({failure:error.stack});});
        return {send:message=>worker.postMessage(message),terminate(){worker.terminate();worker.unref();}};
      },signal);
      const engine=new EngineUCI(line=>parentPort.postMessage({line}),line=>parentPort.postMessage({error:line}),file=>require('node:fs').readFileSync(file,'utf8'));
      parentPort.on('message',command=>{
        try {
          const quit=engine.execute(command); parentPort.postMessage({done:true,quit});
          if (quit) { pool.shutdown(); parentPort.close(); }
        } catch (error) { pool.shutdown(); parentPort.postMessage({failure:error.stack}); }
      });
      return;
    }
    const signal=new Int32Array(new SharedArrayBuffer(20));
    const worker=new Worker(__filename,{workerData:{nadduSearch:true,signal:signal.buffer}});
    const output=line=>process.stdout.write(String(line)+'\n'), error=line=>process.stderr.write(String(line)+'\n');
    let input=null;
    const receiver=create_receiver(command=>worker.postMessage(command),output,()=>{ if (input) input.close(); worker.terminate(); },signal);
    process.stdout.on('error',e=>{ if (e.code==='EPIPE') receiver.submit('quit'); else throw e; });
    worker.on('message',message=>{
      if (message.line!==undefined) output(message.line);
      else if (message.error!==undefined) error(message.error);
      else if (message.done) receiver.done(message);
      else if (message.failure) { error(message.failure); process.exitCode=1; if (input) input.close(); worker.terminate(); }
    });
    worker.on('error',e=>{ error(e.stack); process.exitCode=1; if (input) input.close(); });
    process.on('SIGINT',()=>receiver.submit('quit'));
    if (process.argv.length>2) {
      for (const command of process.argv.slice(2)) receiver.submit(command);
      receiver.end();
    } else {
      input=require('node:readline').createInterface({input:process.stdin,terminal:false});
      input.on('line',line=>receiver.submit(line)); input.on('close',()=>receiver.end());
    }
    return;
  }
  if (typeof postMessage!=='function') return;
  let engine=null,receiver=null,pool=null,helper=null;
  globalThis.onmessage=event=>{
    const message=event.data;
    if (message && typeof message==='object' && message.nadduHelper) { helper=install_smp_helper(message.nadduHelper); return; }
    if (helper) { if(helper(message)) close(); return; }
    // A nested classic worker receives its control buffer before commands.
    if (message && typeof message==='object' && message.nadduSearch) {
      const signal=new Int32Array(message.signal); set_stop_signal(signal,true);
      pool=create_smp_pool((index,descriptor)=>{
        // Browser child startup needs a live event loop. The receiver creates
        // helpers while this compute worker waits on their shared ready flags.
        postMessage({helperCreate:descriptor});
        return {send:message=>postMessage({helperCommand:{index,message}}),terminate:()=>postMessage({helperTerminate:index})};
      },signal);
      engine=new EngineUCI(line=>postMessage({line}),line=>postMessage({error:line}));
      return;
    }
    if (engine) {
      try {
        const quit=engine.execute(String(message));
        postMessage({done:true,quit}); if (quit) {pool.shutdown();close();}
      } catch(error) {pool.shutdown();postMessage({failure:error.stack});}
      return;
    }
    if (!receiver) {
      if (typeof SharedArrayBuffer==='function' && typeof Worker==='function') {
        const signal=new Int32Array(new SharedArrayBuffer(20)), worker=new Worker(location.href);
        const helpers=new Map();
        const shutdown=()=>{for(const helper of helpers.values()) helper.terminate();helpers.clear();worker.terminate();close();};
        receiver=create_receiver(command=>worker.postMessage(command),line=>postMessage(line),shutdown,signal);
        worker.onmessage=event=>{
          const data=event.data;
          if (data.helperCreate) {
            const descriptor=data.helperCreate, helper=new Worker(location.href); helpers.set(descriptor.index,helper);
            helper.onerror=event=>{report_smp_helper_error(descriptor,new Error(event.message));event.preventDefault();};
            helper.postMessage({nadduHelper:descriptor});
          } else if (data.helperCommand) {
            const {index,message}=data.helperCommand; helpers.get(index).postMessage(message);
          } else if (data.helperTerminate!==undefined) {
            helpers.get(data.helperTerminate)?.terminate(); helpers.delete(data.helperTerminate);
          } else if (data.line!==undefined) postMessage(data.line);
          else if (data.error!==undefined) postMessage(data.error);
          else if (data.done) receiver.done(data);
          else if (data.failure) { shutdown(); throw new Error(data.failure); }
        };
        worker.onerror=event=>{ throw new Error(event.message); };
        worker.postMessage({nadduSearch:true,signal:signal.buffer});
      } else {
        // Ordinary pages without cross-origin isolation retain Naddu's direct
        // Worker interface. Termination interrupts a search on these pages.
        const direct=new EngineUCI(line=>postMessage(line));
        receiver={submit(command) { if (direct.execute(command)) close(); }};
      }
    }
    receiver.submit(String(message));
  };
}
install_entry();
