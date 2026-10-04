import {WHITE, BLACK, MAX_PLY, WHITE_OO, WHITE_OOO, BLACK_OO, BLACK_OOO} from './constants.mjs';
import {Position, PieceToChar, pos_fen, do_move, undo_move, gives_check} from './position.mjs';
import {generate_legal} from './movegen.mjs';
import {lsb} from './bitboard.mjs';
import {StartFEN, set_position, uci_move, uci_square} from './notation.mjs';
import {evaluate} from './evaluate.mjs';
import {TT, CLUSTER_BYTES, MAX_HASH_MB, tt_allocate} from './tt.mjs';
import {EngineOptions, Limits, Threads, set_output} from './control.mjs';
import {now} from './timeman.mjs';
import {ensure_search_worker, search_clear, start_thinking, finish_reporting} from './search.mjs';
import {BENCH_POSITIONS} from './generated/benchmark.mjs';

export const UCI_OPTIONS = [
  ['Threads','spin',1,1,1], ['Hash','spin',1,1,MAX_HASH_MB], ['ReferenceTT','check',false],
  ['Ponder','check',false], ['MultiPV','spin',1,1,256], ['UCI_Chess960','check',false]
];
export function uci_identify(output) {
  output('id name Naddu 1'); output('id author Colin Jenkins and Claude');
  for (const [name,type,value,min,max] of UCI_OPTIONS)
    output(`option name ${name} type ${type} default ${value}`+(type==='spin' ? ` min ${min} max ${max}` : ''));
  output('uciok');
}
export function perft_count(pos,depth) {
  if (!depth) return 1;
  let nodes = 0;
  for (const {move} of generate_legal(pos)) {
    do_move(pos,move,gives_check(pos,pos.st,move));
    nodes += perft_count(pos,depth-1); undo_move(pos,move);
  }
  return nodes;
}
export function canonical_command(command) {
  const tokens = String(command).trim().split(/\s+/);
  const aliases = {u:'ucinewgame',p:'position',g:'go',q:'quit',b:'board',m:'moves',e:'eval',f:'perft',h:'bench','?':'help'};
  tokens[0] = aliases[tokens[0]] || tokens[0];
  if (tokens[0]==='position') { if (tokens[1]==='s') tokens[1]='startpos'; else if (tokens[1]==='f') tokens[1]='fen'; }
  if (tokens[0]==='go') {
    const limits = {d:'depth',m:'movetime',n:'nodes'};
    for (let i=1;i<tokens.length;i++) tokens[i] = limits[tokens[i]] || tokens[i];
  }
  return tokens.join(' ');
}
// One EngineUCI owns the process-wide search tables. The transport queues
// commands and uses a shared stop flag while this synchronous search executes.
export class EngineUCI {
  constructor(output,error = output,readFile = null) {
    this.output = output; this.error = error; this.readFile = readFile;
    this.appliedHash = EngineOptions.Hash; this.appliedReferenceTT = EngineOptions.ReferenceTT;
    tt_allocate(this.appliedHash,this.appliedReferenceTT); ensure_search_worker(); search_clear();
    this.root = new Position(false); this.root.set(StartFEN); set_output(output);
  }
  process_settings() {
    if (this.appliedHash!==EngineOptions.Hash || this.appliedReferenceTT!==EngineOptions.ReferenceTT) {
      if (Threads.sleeping) finish_reporting();
      try { tt_allocate(EngineOptions.Hash,EngineOptions.ReferenceTT); }
      catch (error) {
        EngineOptions.Hash=this.appliedHash; EngineOptions.ReferenceTT=this.appliedReferenceTT;
        this.output('info string Hash allocation failed: '+error.message); return;
      }
      this.appliedHash=EngineOptions.Hash; this.appliedReferenceTT=EngineOptions.ReferenceTT;
      this.output(`info string Hash: ${TT.clusterCount*CLUSTER_BYTES/1024} KiB logical, ${TT.table.length} entries`);
    }
  }
  setoption(command) {
    const match = /^setoption\s+name\s+(.+?)(?:\s+value\s+(.*))?$/i.exec(command);
    if (!match) { this.output('No such option'); return; }
    const option = UCI_OPTIONS.find(o=>o[0].toLowerCase()===match[1].toLowerCase());
    if (!option) { this.output('No such option: '+match[1]); return; }
    const [name,type,,min,max] = option, value = match[2]===undefined ? 'true' : match[2];
    if (type==='check') { if (value==='true' || value==='false') EngineOptions[name]=value==='true'; }
    else if (/^[+-]?\d+$/.test(value) && Number(value)>=min && Number(value)<=max) EngineOptions[name]=Number(value);
  }
  go(command) {
    if (Threads.sleeping) finish_reporting();
    this.process_settings(); Limits.reset(); Limits.startTime=now();
    const tokens=command.split(' '); let ponder=false;
    for (let i=1;i<tokens.length;i++) {
      const token=tokens[i];
      if (['wtime','btime','winc','binc','depth','movetime','nodes'].includes(token)) {
        if (i+1===tokens.length) break;
        const value=Number(tokens[++i]); if (!Number.isSafeInteger(value)) continue;
        if (token==='wtime' || token==='btime') Limits.time[Number(token[0]==='b')]=value;
        else if (token==='winc' || token==='binc') Limits.inc[Number(token[0]==='b')]=value;
        else Limits[token]=value;
      } else if (token==='infinite') Limits.infinite=true;
      else if (token==='ponder') ponder=true;
    }
    start_thinking(this.root,ponder);
  }
  board() {
    this.output('');
    for (let rank=7;rank>=0;rank--) {
      let row=`${rank+1}  `;
      for (let file=0;file<8;file++) row += (PieceToChar[this.root.board[rank*8+file]].trim() || '.')+' ';
      this.output(row);
    }
    this.output(''); this.output('   a b c d e f g h'); this.output('');
    this.output(`kings: white=${uci_square(lsb(this.root.pieces(6,WHITE)))} black=${uci_square(lsb(this.root.pieces(6,BLACK)))}`);
    const rights = [[WHITE_OO,'K'],[WHITE_OOO,'Q'],[BLACK_OO,'k'],[BLACK_OOO,'q']].filter(([bit])=>this.root.st.castlingRights&bit).map(([,c])=>c).join('');
    this.output('rights: '+(rights || '-')); this.output('stm: '+(this.root.sideToMove===WHITE ? 'white' : 'black')); this.output('');
  }
  benchmark(command) {
    const tokens=command.split(' '), hash=Number(tokens[1]||16), threads=Number(tokens[2]||1), limit=Number(tokens[3]||13);
    const fenFile=tokens[4]||'default', limitType=tokens[5]||'depth';
    if (threads!==1 || !Number.isSafeInteger(limit) || limit<1) { this.error('Benchmark requires one thread and a positive integer limit'); return; }
    if (!Number.isInteger(hash) || hash<1 || hash>MAX_HASH_MB) { this.error(`Benchmark Hash must be between 1 and ${MAX_HASH_MB} MiB`); return; }
    EngineOptions.Hash=hash; this.process_settings(); search_clear(); Limits.reset();
    if (limitType==='time') Limits.movetime=limit; else Limits.depth=limit;
    let fens;
    if (fenFile.toLowerCase()==='default') fens=BENCH_POSITIONS;
    else if (fenFile.toLowerCase()==='current') fens=[pos_fen(this.root)];
    else {
      try { fens=this.readFile(fenFile).split(/\r?\n/).map(s=>s.trim()).filter(Boolean); }
      catch { this.error('Unable to open file '+fenFile); return; }
    }
    const pos=new Position(false), total=fens.filter(s=>!s.startsWith('setoption ')).length;
    let nodes=0,index=0; const started=now();
    for (const fen of fens) {
      if (fen.startsWith('setoption ')) { this.setoption(fen); continue; }
      set_position(pos,'position fen '+fen); this.error(`\nPosition: ${++index}/${total}`); this.output('position fen '+fen);
      Limits.startTime=now(); start_thinking(pos,false); nodes+=Threads.nodes_searched();
    }
    const elapsed=now()-started+1;
    this.error('\n==========================='); this.error('Total time (ms) : '+elapsed);
    this.error('Nodes searched  : '+nodes); this.error('Nodes/second    : '+Math.floor(1000*nodes/elapsed));
  }
  execute(command) {
    command=canonical_command(command); if (!command) return false;
    const tokens=command.split(' ');
    switch (tokens[0]) {
      case 'uci': uci_identify(this.output); break;
      case 'isready': this.process_settings(); this.output('readyok'); break;
      case 'setoption': this.setoption(command); break;
      case 'ucinewgame': this.process_settings(); search_clear(); break;
      case 'position': set_position(this.root,command); break;
      case 'go': this.go(command); break;
      case 'stop': case 'quit':
        Threads.request_stop(); if (Threads.sleeping) finish_reporting(); return tokens[0]==='quit';
      case 'ponderhit':
        Threads.ponder=false; if (Threads.stopOnPonderhit || Threads.sleeping) Threads.request_stop();
        if (Threads.sleeping) finish_reporting(); break;
      case 'board': this.board(); break;
      case 'moves': {
        const moves=generate_legal(this.root);
        this.output(moves.length ? moves.map(({move})=>uci_move(move,this.root.chess960)).join(' ') : this.root.st.checkersBB ? 'checkmate' : 'stalemate'); break;
      }
      case 'eval': this.output(String(evaluate(this.root))); break;
      case 'perft': {
        const depth=Number(tokens[1]);
        if (!Number.isInteger(depth) || depth<0 || depth>=MAX_PLY) { this.output('Invalid perft depth'); break; }
        const started=now(), nodes=perft_count(this.root,depth), elapsed=Math.max(1,now()-started);
        this.output(`nodes ${nodes} elapsed ${elapsed} nps ${Math.floor(nodes*1000/elapsed)}`); break;
      }
      case 'bench': this.benchmark(command); break;
      case 'help':
        for (const line of ['uci | isready | ucinewgame (u) | setoption name <name> value <value>',
          'position (p) startpos | fen <fen> [moves <moves>]',
          'go (g) [depth (d) <n> | nodes (n) <n> | movetime (m) <ms> | wtime <ms> btime <ms> winc <ms> binc <ms> | infinite] [ponder]',
          'stop | ponderhit | quit (q)', 'board (b) | moves (m) | eval (e) | perft (f) <depth>',
          'bench (h) [hash=16] [threads=1] [limit=13] [default|current|fen-file] [depth|time]']) this.output(line);
        break;
      default: this.output('Unknown: '+command);
    }
    return false;
  }
}
