import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {root} from './reference.mjs';
import {bundle,CORE_FILES,CORE_NAMES} from './build.mjs';

// Instrument only the test bundle. Production search has no tracing overhead.
export function traced_bundle() {
  let source=bundle(CORE_FILES,CORE_NAMES);
  const replace=(from,to)=>{
    assert.ok(source.includes(from),'Trace insertion no longer matches: '+from);
    source=source.replace(from,to);
  };
  const cut=(label)=>`__trace(['cut','${label}',pos.nodes,st.ply,depth,alpha,beta]);`;
  source=source.replaceAll('return ttValue;',`{ ${cut('tt')} return ttValue; }`);
  replace('return evalValue;',`{ ${cut('rfp')} return evalValue; }`);
  replace('return qsearch_node(pos,alpha-1,alpha,0,NonPV,false);',`{ ${cut('razoring')} return qsearch_node(pos,alpha-1,alpha,0,NonPV,false); }`);
  replace('return bestValue;',cut('stand_pat')+' return bestValue;');
  source=source.replaceAll('return nullValue;',`{ ${cut('null')} return nullValue; }`);
  replace('return val-(probBeta-beta);',cut('probcut')+' return val-(probBeta-beta);');
  replace('return checkedProbBeta;',`{ ${cut('checked_probcut')} return checkedProbBeta; }`);
  replace('value<VALUE_TB_WIN_IN_MAX_PLY) return value;',`value<VALUE_TB_WIN_IN_MAX_PLY) { ${cut('singular')} return value; }`);
  for (const [condition,label] of [
    ['board[to]!==0 && !check && !PvNode && lmrDepth<7 && !inCheck && st.staticEval+424+138*lmrDepth+PieceValue[board[to]]+c_div(captureHistory[movedPiece][to][type_of_p(board[to])],7)<alpha','capture_futility'],
    ['!see_test(pos,move,-214*depth)','capture_see'],['lmrDepth<4 && hist < -3875*(depth-1)','quiet_history'],
    ['!inCheck && lmrDepth<11 && futility<=alpha','quiet_futility'],['!see_test(pos,move,-25*lmrDepth*lmrDepth)','quiet_see'],
    ['moveCount>2','qs_count'],['PIECE_TO_HISTORY_GRAIN*cmh[hidx] < CounterMovePruneThreshold && PIECE_TO_HISTORY_GRAIN*fmh[hidx] < CounterMovePruneThreshold','qs_history'],
    ['!see_test(pos,move,-83)','qs_see']]) {
    replace(`if (${condition}) continue;`,`if (${condition}) { __trace(['prune','${label}',pos.nodes,st.ply,move,depth]); continue; }`);
  }
  replace('bestValue = Math.max(bestValue,futility); continue;',"bestValue = Math.max(bestValue,futility); __trace(['prune','qs_futility',pos.nodes,st.ply,move,depth]); continue;");
  replace('bestValue = Math.max(bestValue,futilityBase); continue;',"bestValue = Math.max(bestValue,futilityBase); __trace(['prune','qs_futility_see',pos.nodes,st.ply,move,depth]); continue;");
  replace('pos.nmpMinPly = st.ply+c_div(3*(depth-R),4);',"__trace(['verified_null',pos.nodes,st.ply,depth,R]); pos.nmpMinPly = st.ply+c_div(3*(depth-R),4);");
  replace('st.excludedMove = move; const cm',"__trace(['singular',pos.nodes,st.ply,move,singularBeta,singularDepth]); st.excludedMove = move; const cm");
  replace('newDepth += extension;',"__trace(['extension',pos.nodes,st.ply,move,extension,depth,newDepth,r]); newDepth += extension;");
  replace('else if (check && depth>8) extension = 1;',"else if (check && depth>8) { __trace(['deep_check',pos.nodes,st.ply,move,depth]); extension = 1; }");
  replace('const d = clamp(newDepth-c_div(r,1024),1,newDepth+1); val',"const d = clamp(newDepth-c_div(r,1024),1,newDepth+1); __trace(['lmr',pos.nodes,st.ply,move,newDepth,d,r]); val");
  replace('newDepth += Number(val>bestValue+42+2*newDepth)-Number(val<bestValue+newDepth);',"newDepth += Number(val>bestValue+42+2*newDepth)-Number(val<bestValue+newDepth); __trace(['lmr_research',pos.nodes,st.ply,move,newDepth,d,val]);");
  const instrumentation=`
let tracePosition=null;
globalThis.getTracePosition=()=>tracePosition;
function traced(name,original) {
  return function(...args) {
    if (name==='search_node' || name==='qsearch_node') {
      const [pos,a,b,d,x,y]=args, kind=name==='search_node' ? 'main' : 'qs';
      const previous=tracePosition; tracePosition=pos;
      try {
        __trace(['enter',kind,pos.nodes,pos.st.ply,a,b,d,Boolean(kind==='main' ? x : y),kind==='main' ? y : x,pos.st.excludedMove,String(pos.st.key)]);
        const value=original(...args); __trace(['return',kind,pos.nodes,pos.st.ply,value]); return value;
      } finally { tracePosition=previous; }
    }
    if (['do_move','undo_move','do_null_move','undo_null_move'].includes(name)) {
      const pos=args[0];
      __trace([name,pos.nodes,pos.st.ply,...(name==='do_move' ? [args[1],Boolean(args[2])] : name==='undo_move' ? [args[1]] : [])]);
    }
    const value=original(...args);
    if (name==='tt_probe') { const [hit,tte]=value; __trace(['probe',String(args[0]),Boolean(hit),tte.slot,String(tte.packed)]); }
    else if (name==='tte_save') { const [tte,key,v,pv,bound,depth,move,ev]=args; __trace(['save',String(key),v,Boolean(pv),bound,depth,move,ev,tte.slot,String(tte.packed)]); }
    else if (name==='next_move') { const [pos,skip]=args; __trace(['pick',pos.nodes,pos.st.ply,value,pos.st.stage,pos.st.cur_idx,Boolean(skip)]); }
    else if (name==='mp_init_probcut') { const [pos,move,threshold]=args; __trace(['probcut',pos.nodes,pos.st.ply,move,threshold]); }
    else if (name==='history_update') { const [table,c,m,v]=args; __trace([name,c,m,v,table[c][m&4095]]); }
    else if (name==='continuation_history_update') { const [row,index,v]=args; __trace([name,index,v,row[index]]); }
    else if (name==='capture_history_update') { const [table,pc,to,captured,v]=args; __trace([name,pc,to,captured,v,table[pc][to][captured]]); }
    else if (name==='correction_history_update') { const [table,c,pos,v]=args,index=Number(pos.st.pawnKey&16383n); __trace([name,c,index,v,table[c][index]]); }
    else if (name==='non_pawn_correction_history_update') { const [table,c,stm,pos,v]=args,index=Number(pos.st.nonPawnKey[c]&8191n); __trace([name,c,stm,index,v,table[c][stm][index]]); }
    return value;
  };
}
${['search_node','qsearch_node','tt_probe','tte_save','next_move','mp_init_probcut','do_move','undo_move','do_null_move','undo_null_move','history_update','continuation_history_update','capture_history_update','correction_history_update','non_pawn_correction_history_update'].map(name=>`${name}=traced('${name}',${name});`).join('\n')}
set_clock(()=>0); ensure_search_worker();
globalThis.runCase=function(spec) {
  tt_allocate(1); search_clear(); Limits.reset(); Limits.startTime=0; Threads.stop=false;
  const root=new Position(false); set_position(root,'position fen '+spec.fen); let pos,value,output=[];
  set_output(line=>{ if ((line.startsWith('info depth') && line.includes(' score ')) || line.startsWith('bestmove')) output.push(line.replace(/ (?:time|nps|hashfull) \\d+/g,'')); });
  if (spec.type==='root') {
    __resetTrace();
    for (let i=0;i<(spec.repeat || 1);i++) { Limits.reset(); Limits.depth=spec.depth; Limits.startTime=0; start_thinking(root,false); }
    pos=Threads.workers[0].pos; value=pos.rootMoves.move[0].score;
  } else {
    pos=new Position(); pos.copy_root_from(root); pos.st.ply=spec.ply || 1; pos.rootDepth=spec.depth; pos.rootDelta=64002;
    init_search_sentinels(pos); time_init(0,0,Limits);
    if (spec.tt) { const move=uci_to_move(pos,spec.tt.move); if (!move) throw new Error('Illegal seed move'); const [,entry]=tt_probe(pos.st.key); tte_save(entry,pos.st.key,spec.tt.value,false,2,spec.depth-3,move,32002); }
    __resetTrace(); value=search_node(pos,spec.alpha,spec.beta,spec.depth,spec.cut || false,0);
  }
  return {value,nodes:pos.nodes,selDepth:pos.selDepth,pos,output,table:TT.table};
};
globalThis.positionSnapshot=function(pos) {
  const st=pos.st;
  const result={fen:pos_fen(pos),board:Array.from(pos.board),side:pos.sideToMove,pieceCount:Array.from(pos.pieceCount),
    key:String(st.key),pawnKey:String(st.pawnKey),materialKey:String(st.materialKey),nonPawnKey:st.nonPawnKey.map(String),
    nonPawn:st.nonPawn,rights:st.castlingRights,ep:st.epSquare,rule50:st.rule50,pliesFromNull:st.pliesFromNull,
    checkers:String(st.checkersBB),blockers:st.blockersForKing.map(String),pinners:st.pinnersForKing.map(String),
    checkSquares:st.checkSquares.map(String),ksq:st.ksq,captured:st.capturedPiece,
    accumulator:st.accumulator.colors.map(row=>Array.from(row)),raw_nnue:nnue_evaluate(st.accumulator,pos.sideToMove),eval:evaluate(pos)};
  result.game={rootKeyFlip:String(pos.rootKeyFlip),gamePly:pos.gamePly,hasRepeated:pos.hasRepeated,chess960:pos.chess960,
    byTypeBB:pos.byTypeBB.map(String),byColorBB:pos.byColorBB.map(String),castlingRightsMask:Array.from(pos.castlingRightsMask),
    castlingRookSquare:Array.from(pos.castlingRookSquare),castlingPath:pos.castlingPath.map(String)};
  result.search={};
  for (const name of ['nodes','selDepth','rootDepth','rootDelta','completedDepth','pvIdx','pvLast','multiPV','nmpMinPly','st_idx','optimism','killers','statScore','doubleExtensions','cutoffCnt','ttPv','pvArray']) result.search[name]=pos[name];
  result.frames=pos.stack.slice(0,pos.st_idx+1).map(st=>{
    const frame={}; for (const name of ['ply','staticEval','currentMove','excludedMove','moveCount','ttHit']) frame[name]=st[name];
    frame.key=String(st.key); frame.checkers=String(st.checkersBB); frame.history=st.history===null ? null : Array.from(st.history); return frame;
  });
  result.tt={generation:TT.generation8,entries:[]}; for (let i=0;i<TT.table.length;i++) if (TT.table[i]) result.tt.entries.push([i,String(TT.table[i])]);
  result.rootMoves=pos.rootMoves===null ? null : {size:pos.rootMoves.size,move:pos.rootMoves.move.map(rm=>{
    const record={}; for (const name of ['score','previousScore','averageScore','selDepth','pvSize','pv']) record[name]=rm[name]; return record;
  })};
  const lists=value=>typeof value==='number' ? value : Array.from(value,lists); result.histories={};
  for (const name of ['mainHistory','correctionHistory','counterMoveHistory','captureHistory','nonPawnCorrectionHistory','counterMoves']) result.histories[name]=lists(pos[name]);
  return result;
};
`;
  return source.replace('\nglobalThis.NadduCore =',instrumentation+'\nglobalThis.NadduCore =');
}
function historyDigest(pos) {
  const digest=createHash('sha256'), bytes=row=>digest.update(new Uint8Array(row.buffer,row.byteOffset,row.byteLength));
  const i16row=row=>{ const data=Buffer.alloc(row.length*2); for (let i=0;i<row.length;i++) data.writeInt16LE(row[i],i*2); digest.update(data); };
  for (const table of [pos.mainHistory,pos.correctionHistory]) for (const row of table) bytes(row);
  for (const piece of pos.counterMoveHistory) for (const row of piece) bytes(row);
  for (const table of [pos.captureHistory,pos.nonPawnCorrectionHistory]) for (const rows of table) for (const row of rows) i16row(row);
  for (const row of pos.counterMoves) { const data=Buffer.alloc(row.length*2); for (let i=0;i<row.length;i++) data.writeUInt16LE(row[i],i*2); digest.update(data); }
  return digest.digest('hex');
}
export function runTraces(specs,{eventDirectory,snapshotTarget} = {}) {
  let digest,events,counts,log=null,caseId=null;
  if (eventDirectory) fs.mkdirSync(eventDirectory,{recursive:true});
  const reset=()=>{
    if (log!==null) fs.closeSync(log);
    log=eventDirectory && caseId ? fs.openSync(path.join(eventDirectory,`case-${caseId}.jsonl`),'w') : null;
    digest=createHash('sha256'); events=0; counts={};
  };
  reset();
  const context=vm.createContext({atob,__resetTrace:reset,__trace(event) {
    const line=JSON.stringify(event)+'\n'; digest.update(line); if (log!==null) fs.writeSync(log,line);
    events++; counts[event[0]]=(counts[event[0]] || 0)+1;
    if (event[0]==='extension') { const label='extension_'+event[4]; counts[label]=(counts[label] || 0)+1; }
    if (event[0]==='prune' || event[0]==='cut') { const label=event[0]+'_'+event[1]; counts[label]=(counts[label] || 0)+1; }
    if (snapshotTarget && caseId===snapshotTarget.case && events===snapshotTarget.event) {
      const pos=context.getTracePosition();
      if (pos) fs.writeFileSync(path.join(eventDirectory,`case-${caseId}-state.json`),JSON.stringify(context.positionSnapshot(pos)));
    }
  }});
  vm.runInContext(traced_bundle(),context);
  try { return specs.map((spec,index)=>{
    caseId=index+1; reset();
    const {value,nodes,selDepth,pos,output,table}=context.runCase(spec);
    const entries=[]; for (let i=0;i<table.length;i++) if (table[i]) entries.push([i,String(table[i])]);
    return {spec,value,nodes,selDepth,events,digest:digest.copy().digest('hex'),counts:{...counts},
      tt:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),histories:historyDigest(pos),output:Array.from(output)};
  }); } finally { if (log!==null) fs.closeSync(log); }
}
export async function firstTraceDifference(expectedFile,actualFile) {
  const expected=createInterface({input:fs.createReadStream(expectedFile),crlfDelay:Infinity});
  const actual=createInterface({input:fs.createReadStream(actualFile),crlfDelay:Infinity});
  const a=expected[Symbol.asyncIterator](),b=actual[Symbol.asyncIterator](); let index=0,context=null;
  try {
    while (true) {
      const [left,right]=await Promise.all([a.next(),b.next()]); index++;
      if (left.done && right.done) return null;
      if (left.value!==right.value) return {event:index,context,expected:left.value ? JSON.parse(left.value) : null,actual:right.value ? JSON.parse(right.value) : null};
      const event=JSON.parse(left.value); if (event[0]==='enter') context=event;
    }
  } finally { expected.close(); actual.close(); expected.input.destroy(); actual.input.destroy(); }
}
if (process.argv[1]===fileURLToPath(import.meta.url)) {
  const expected=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/search-traces.json')));
  const eventDirectory=process.argv.includes('--events') ? path.join(root,'build/trace-js') : undefined;
  const actual=runTraces(expected.map(r=>r.spec),{eventDirectory});
  for (let i=0;i<expected.length;i++) {
    try { assert.deepEqual(actual[i],expected[i],'trace case '+(i+1)); }
    catch (error) {
      const pythonLog=path.join(root,`build/trace-python/case-${i+1}.jsonl`);
      if (eventDirectory && fs.existsSync(pythonLog)) {
        const difference=await firstTraceDifference(pythonLog,path.join(eventDirectory,`case-${i+1}.jsonl`)); console.error(difference);
        if (difference) {
          const target={case:i+1,event:difference.event}; fs.writeFileSync(path.join(root,'build/trace-target.json'),JSON.stringify(target));
          runTraces(expected.map(r=>r.spec),{eventDirectory,snapshotTarget:target});
        }
      }
      throw error;
    }
  }
  console.log('Exact search decision digests: '+actual.reduce((sum,r)=>sum+r.events,0)+' events.');
  console.log(JSON.stringify(actual.reduce((counts,r)=>{ for (const [label,n] of Object.entries(r.counts)) counts[label]=(counts[label] || 0)+n; return counts; },{})));
}
