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
  assert.match(result.stdout,/option name Threads type spin default 1 min 1 max 1/);
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
      wait.timer=setTimeout(()=>{ waits.delete(wait); reject(new Error('Timed out waiting for UCI output: '+stderr)); },10000);
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
