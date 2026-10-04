import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawn,spawnSync} from 'node:child_process';
import {release_bundle} from '../scripts/build.mjs';
import {normalized} from '../scripts/parity.mjs';
const executable=new URL('../naddu.js',import.meta.url), source=fs.readFileSync(executable,'utf8');
const fixture=name=>JSON.parse(fs.readFileSync(new URL('./fixtures/'+name,import.meta.url)));
const scoreLines=lines=>lines.filter(s=>(s.startsWith('info depth') && s.includes(' score ')) || s.startsWith('bestmove')).map(normalized);
const referenceTT='setoption name ReferenceTT value true';
test('release artifact is reproducible and command-line UCI uses the verified core',()=>{
  assert.equal(source,release_bundle());
  const result=spawnSync(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1'),'uci',referenceTT,'ucinewgame','position startpos','go depth 5'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/option name Threads type spin default 1 min 1 max 16/);
  assert.deepEqual(scoreLines(result.stdout.trim().split(/\r?\n/)),fixture('start-depth5.json')[0].output);
});
test('public benchmark uses all Python positions and preserves warm state',()=>{
  const result=spawnSync(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1'),referenceTT,'bench 16 1 5'],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  const expected=fixture('bench-depth5.json');
  assert.deepEqual(scoreLines(result.stdout.trim().split(/\r?\n/)),expected.flatMap(r=>r.output));
  assert.match(result.stderr,new RegExp('Nodes searched  : '+expected.reduce((sum,r)=>sum+r.nodes_after_reporting,0)+'\\b'));
  assert.equal(result.stdout.split('\n').filter(s=>s.startsWith('position fen')).length,47);
});
test('public UCI preserves warm searches, new games, options and MultiPV',()=>{
  const expected=fixture('lifecycle-depth5.json');
  const commands=expected.commands.flatMap(command=>command.startsWith('position') ? [command,'go depth 5'] : [command]);
  const result=spawnSync(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1'),referenceTT,...commands],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(scoreLines(result.stdout.trim().split(/\r?\n/)),expected.results.flatMap(r=>r.output));
});

test('public MultiPV covers warm roots, all legal moves, clamping and option changes',()=>{
  const expected=fixture('multipv-depth4.json');
  const commands=expected.commands.flatMap(command=>command.startsWith('position') ? [command,'go depth 4'] : [command]);
  const result=spawnSync(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1'),referenceTT,...commands],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(scoreLines(result.stdout.trim().split(/\r?\n/)),expected.results.flatMap(r=>r.output));
});
test('released classic Worker preserves diagnostics, aliases, perft and root search',()=>{
  const lines=[], context=vm.createContext({atob,postMessage:line=>lines.push(line),close(){}});
  vm.runInContext(source,context);
  for (const command of [referenceTT,'u','p s','b','m','e','f 3','g d 5']) context.onmessage({data:command});
  assert.ok(lines.includes('8  r n b q k b n r ')); assert.ok(lines.includes('stm: white'));
  assert.ok(lines.some(s=>/^a2a3 b2b3/.test(s))); assert.ok(lines.includes('62'));
  assert.ok(lines.some(s=>/^nodes 8902 elapsed \d+ nps \d+$/.test(s)));
  assert.deepEqual(scoreLines(lines),fixture('start-depth5.json')[0].output);
});
function interactive(t) {
  const child=spawn(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const lines=[]; let buffer='', stderr=''; const waits=new Set();
  child.stdout.on('data',data=>{
    buffer+=data;
    let end; while ((end=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,end).trimEnd(); buffer=buffer.slice(end+1); lines.push(line);
      for (const wait of waits) if (wait.match(line)) { clearTimeout(wait.timer); waits.delete(wait); wait.resolve(line); }
    }
  });
  child.stderr.on('data',data=>stderr+=data);
  child.on('exit',code=>{ for (const wait of waits) { clearTimeout(wait.timer); wait.reject(new Error(`Engine exited ${code}: ${stderr}`)); } waits.clear(); });
  t.after(()=>child.kill());
  return {child,lines,send:line=>child.stdin.write(line+'\n'),wait(match) {
    return new Promise((resolve,reject)=>{
      const wait={match,resolve,reject,timer:null};
      wait.timer=setTimeout(()=>{ waits.delete(wait); reject(new Error('Timed out waiting for UCI output: '+stderr+'; matcher: '+match+'; last lines: '+lines.slice(-6).join(' | '))); },10000);
      waits.add(wait);
    });
  }};
}
test('Node receiver answers readiness during infinite search and stops without losing the worker',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line==='readyok'); e.send('isready'); await waiting;
  waiting=e.wait(line=>line.startsWith('info depth 8 ')); e.send('position startpos'); e.send('go infinite'); await waiting;
  const ready=e.wait(line=>line==='readyok'); e.send('isready'); await ready;
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('stop'); await waiting;
  const firstBest=e.lines.filter(s=>s.startsWith('bestmove')).length;
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('position startpos'); e.send('go depth 5'); await waiting;
  assert.equal(e.lines.filter(s=>s.startsWith('bestmove')).length,firstBest+1);
  const exited=new Promise(resolve=>e.child.once('exit',resolve)); e.send('quit'); assert.equal(await exited,0);
});
test('completed ponder search defers bestmove until ponderhit and keeps exact output',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line.startsWith('info depth 5 '));
  e.send(referenceTT); e.send('ucinewgame'); e.send('position startpos'); e.send('go ponder depth 5'); await waiting;
  const ready=e.wait(line=>line==='readyok'); e.send('isready'); await ready;
  assert.ok(!e.lines.some(s=>s.startsWith('bestmove')));
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('ponderhit'); await waiting;
  assert.deepEqual(scoreLines(e.lines),fixture('start-depth5.json')[0].output);
  e.send('quit');
});
test('real movetime and a ponderhit during clock search finish promptly',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line==='readyok'); e.send('isready'); await waiting;
  let started=Date.now(); waiting=e.wait(line=>line.startsWith('bestmove '));
  e.send('position startpos'); e.send('go movetime 30'); await waiting;
  assert.ok(Date.now()-started<2000);
  waiting=e.wait(line=>line.startsWith('info depth 5 ')); e.send('go ponder wtime 100 btime 100'); await waiting;
  started=Date.now(); waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('ponderhit'); await waiting;
  assert.ok(Date.now()-started<2000); e.send('quit');
});
test('a new go replaces infinite or sleeping ponder search without dropping its bestmove',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line.startsWith('info depth 8 ')); e.send('position startpos'); e.send('go infinite'); await waiting;
  waiting=e.wait(line=>line.startsWith('bestmove ') && e.lines.filter(s=>s.startsWith('bestmove')).length>=2);
  e.send('position startpos moves e2e4'); e.send('go depth 5'); await waiting;
  waiting=e.wait(line=>line.startsWith('info depth 5 ')); e.send('go ponder depth 5'); await waiting;
  waiting=e.wait(line=>line==='readyok'); e.send('isready'); await waiting;
  const before=e.lines.filter(s=>s.startsWith('bestmove')).length;
  waiting=e.wait(line=>line.startsWith('bestmove ') && e.lines.filter(s=>s.startsWith('bestmove')).length>=before+2); e.send('go depth 5'); await waiting;
  assert.equal(e.lines.filter(s=>s.startsWith('bestmove')).length,before+2);
  e.send('quit');
});

test('Hash and ReferenceTT settings resize safely after an active search',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line.startsWith('info depth 8 '));
  e.send('position startpos'); e.send('go infinite'); await waiting;
  waiting=e.wait(line=>line==='readyok');
  e.send('setoption name Hash value 2'); e.send('isready'); await waiting;
  assert.ok(e.lines.some(s=>s.startsWith('bestmove ')));
  assert.ok(e.lines.includes('info string Hash: 2048 KiB logical, 196608 entries'));
  waiting=e.wait(line=>line.startsWith('info depth 8 ')); e.send('go infinite'); await waiting;
  waiting=e.wait(line=>line==='readyok'); e.send(referenceTT); e.send('isready'); await waiting;
  assert.ok(e.lines.includes('info string Hash: 896 KiB logical, 86016 entries'));
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('ucinewgame'); e.send('position startpos'); e.send('go depth 5'); await waiting;
  e.send('quit');
});

test('real 2/4-thread MultiPV searches report distinct main-worker PVs and preserve the worker pool',async t=>{
  const e=interactive(t);
  for (const num of [2,4]) {
    let waiting=e.wait(line=>line==='readyok');
    e.send('setoption name Threads value '+num); e.send('setoption name MultiPV value 3'); e.send('isready'); await waiting;
    assert.ok(e.lines.includes('info string Threads: '+num));
    for (let repeat=0;repeat<2;repeat++) {
      const start=e.lines.length; waiting=e.wait(line=>line.startsWith('bestmove '));
      e.send('position startpos'); e.send('go depth 6'); const best=await waiting;
      const pvs=e.lines.slice(start).filter(line=>line.startsWith('info depth 6 ') && line.includes(' score ')).slice(-3);
      assert.equal(pvs.length,3); assert.deepEqual(pvs.map(line=>Number(/multipv (\d+)/.exec(line)[1])),[1,2,3]);
      const firstMoves=pvs.map(line=>/ pv (\w+)/.exec(line)[1]); assert.equal(new Set(firstMoves).size,3);
      assert.equal(best.split(' ')[1],firstMoves[0]);
    }
  }
  const exited=new Promise(resolve=>e.child.once('exit',resolve)); e.send('quit'); assert.equal(await exited,0);
});

test('SMP global node/time limits and ponderhit finish and permit the next search',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line==='readyok'); e.send('setoption name Threads value 4'); e.send('isready'); await waiting;
  for (const command of ['go nodes 20000','go movetime 100','go wtime 1000 btime 1000']) {
    const start=Date.now(); waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('position startpos'); e.send(command); await waiting;
    assert.ok(Date.now()-start<3000,command+' did not stop');
  }
  waiting=e.wait(line=>line.startsWith('info depth 5 ')); e.send('go ponder depth 5'); await waiting;
  waiting=e.wait(line=>line==='readyok'); e.send('isready'); await waiting;
  const previous=e.lines.filter(line=>line.startsWith('bestmove ')).length;
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('ponderhit'); await waiting;
  assert.equal(e.lines.filter(line=>line.startsWith('bestmove ')).length,previous+1);
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('go depth 5'); await waiting; e.send('quit');
});

test('SMP readiness, stop, deferred resizing, new games and terminal roots preserve the receiver',async t=>{
  const e=interactive(t);
  let waiting=e.wait(line=>line==='readyok'); e.send('setoption name Threads value 2'); e.send('isready'); await waiting;
  waiting=e.wait(line=>line.startsWith('info depth 8 ')); e.send('position startpos'); e.send('go infinite'); await waiting;
  waiting=e.wait(line=>line==='readyok'); e.send('isready'); await waiting;
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('stop'); await waiting;
  waiting=e.wait(line=>line.startsWith('info depth 8 ')); e.send('go infinite'); await waiting;
  waiting=e.wait(line=>line==='readyok');
  e.send('setoption name Threads value 4'); e.send('setoption name Hash value 3'); e.send('isready'); await waiting;
  assert.ok(e.lines.includes('info string Threads: 4'));
  assert.ok(e.lines.includes('info string Hash: 3072 KiB logical, 294912 entries'));
  waiting=e.wait(line=>line.startsWith('info depth 8 ')); e.send('go infinite'); await waiting;
  waiting=e.wait(line=>line==='readyok'); e.send('ucinewgame'); e.send('isready'); await waiting;
  waiting=e.wait(line=>line==='bestmove (none)'); e.send('position fen 7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'); e.send('go depth 5'); await waiting;
  waiting=e.wait(line=>line==='readyok'); e.send('setoption name Threads value 1'); e.send('isready'); await waiting;
  waiting=e.wait(line=>line.startsWith('bestmove ')); e.send('position startpos'); e.send('go depth 5'); await waiting;
  const exited=new Promise(resolve=>e.child.once('exit',resolve)); e.send('quit'); assert.equal(await exited,0);
});

test('public SMP benchmark completes all reference positions',()=>{
  const result=spawnSync(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1'),'bench 1 2 5'],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.split('\n').filter(line=>line.startsWith('position fen')).length,47);
  assert.equal(result.stdout.split('\n').filter(line=>line.startsWith('bestmove ')).length,47);
  assert.match(result.stderr,/Nodes searched\s*:\s*[1-9]\d*/);
});

test('an immediate stop/quit or EOF cannot be lost before the compute worker starts',()=>{
  for (const commands of [['go infinite','stop','quit'],['go infinite']]) {
    const result=spawnSync(process.execPath,[executable.pathname.replace(/^\/([A-Z]:)/,'$1'),...commands],{encoding:'utf8',timeout:3000});
    assert.equal(result.status,0,result.error?.message || result.stderr);
    assert.equal(result.stdout.split('\n').filter(line=>line.startsWith('bestmove ')).length,1);
  }
});
