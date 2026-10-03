import {PAWN, KNIGHT, BISHOP, ROOK, QUEEN, DEPTH_QS_NO_CHECKS, DEPTH_QS_RECAPTURES, c_div, to_sq} from './constants.mjs';
import {attacks_by, PieceValue, see_test, is_pseudo_legal, is_capture} from './position.mjs';
import {sq_bb} from './bitboard.mjs';
import {generate_captures, generate_quiets, generate_evasions, generate_quiet_checks} from './movegen.mjs';
import {PIECE_TO_HISTORY_GRAIN} from './history.mjs';
export const ST_MAIN_SEARCH = 0, ST_CAPTURES_INIT = 1, ST_GOOD_CAPTURES = 2;
export const ST_KILLERS = 3, ST_KILLERS_2 = 4, ST_QUIET_INIT = 5, ST_QUIET = 6, ST_BAD_CAPTURES = 7;
export const ST_EVASION = 8, ST_EVASIONS_INIT = 9, ST_ALL_EVASIONS = 10;
export const ST_QSEARCH = 11, ST_QCAPTURES_INIT = 12, ST_QCAPTURES = 13, ST_QCHECKS = 14;
export const ST_PROBCUT = 15, ST_PROBCUT_INIT = 16, ST_PROBCUT_2 = 17;
export function mp_init(pos,ttm,d,ply) {
  const st = pos.st; st.depth = d;
  const prevSq = to_sq(pos.stack[pos.st_idx-1].currentMove);
  st.countermove = pos.counterMoves[pos.board[prevSq]][prevSq]; st.mpKillers[0] = pos.killers[ply][0]; st.mpKillers[1] = pos.killers[ply][1];
  st.ttMove = ttm; st.stage = st.checkersBB ? ST_EVASION : ST_MAIN_SEARCH;
  if (!ttm || !is_pseudo_legal(pos,ttm)) st.stage++;
}
export function mp_init_q(pos,ttm,d,s) {
  const st = pos.st; st.ttMove = ttm; st.stage = st.checkersBB ? ST_EVASION : ST_QSEARCH;
  if (!(ttm && is_pseudo_legal(pos,ttm))) st.stage++;
  st.depth = d; st.recaptureSquare = s;
}
export function mp_init_probcut(pos,ttm,threshold) {
  const st = pos.st; st.threshold = threshold; st.ttMove = ttm; st.stage = ST_PROBCUT;
  if (!(ttm && is_pseudo_legal(pos,ttm) && is_capture(pos,ttm) && see_test(pos,ttm,threshold))) st.stage++;
}
export function partial_insertion_sort(moves,limit) {
  let sortedEnd = 0;
  for (let i = 1; i < moves.length; i++) {
    const tmp = moves[i], value = tmp.value;
    if (value >= limit) {
      sortedEnd++; moves[i] = moves[sortedEnd]; let j = sortedEnd;
      while (j > 0 && moves[j-1].value < value) { moves[j] = moves[j-1]; j--; }
      moves[j] = tmp;
    }
  }
}
export function pick_best(moves,cur) {
  let best = cur, value = moves[cur].value;
  for (let i = cur+1; i < moves.length; i++) if (moves[i].value > value) { value = moves[i].value; best = i; }
  [moves[cur],moves[best]] = [moves[best],moves[cur]]; return moves[cur].move;
}
export function score_captures(pos) {
  const history = pos.captureHistory, board = pos.board;
  for (const ext of pos.st.moves) {
    const move = ext.move, to = move&63, pc = board[to], moved = board[(move>>6)&63];
    ext.value = c_div(7*PieceValue[pc]+history[moved][to][pc&7],16);
  }
}
export function score_quiets(pos) {
  const st = pos.st, idx = pos.st_idx;
  const cmh = pos.stack[idx-1].history, fmh = pos.stack[idx-2].history, fmh2 = pos.stack[idx-4].history, fmh3 = pos.stack[idx-6].history;
  const c = pos.sideToMove, history = pos.mainHistory[c], board = pos.board, them = 1-c, pieces = pos.byTypeBB, ours = pos.byColorBB[c];
  const pawnThreats = attacks_by(pos,PAWN,them), minorThreats = attacks_by(pos,KNIGHT,them) | attacks_by(pos,BISHOP,them) | pawnThreats;
  const rookThreats = attacks_by(pos,ROOK,them) | minorThreats;
  const threatened = ours & ((pieces[QUEEN] & rookThreats) | (pieces[ROOK] & minorThreats) | ((pieces[KNIGHT] | pieces[BISHOP]) & pawnThreats));
  for (const ext of st.moves) {
    const m = ext.move, to = m&63, from = (m>>6)&63, pc = board[from], hidx = pc*64+to;
    ext.value = 2*64*history[m&4095]+PIECE_TO_HISTORY_GRAIN*(2*cmh[hidx]+fmh[hidx]+fmh2[hidx]+fmh3[hidx]);
    if (threatened & sq_bb(from)) {
      const toBB = sq_bb(to), pt = pc&7;
      if (pt === QUEEN && !(toBB & rookThreats)) ext.value += 51700;
      else if (pt === ROOK && !(toBB & minorThreats)) ext.value += 25600;
      else if (!(toBB & pawnThreats)) ext.value += 14450;
    }
  }
}
export function score_evasions(pos) {
  const cmh = pos.stack[pos.st_idx-1].history, history = pos.mainHistory[pos.sideToMove], board = pos.board;
  for (const ext of pos.st.moves) {
    const m = ext.move, to = m&63, pc = board[(m>>6)&63];
    ext.value = is_capture(pos,m) ? PieceValue[board[to]]-(pc&7)+(1<<28) : 64*history[m&4095]+PIECE_TO_HISTORY_GRAIN*cmh[pc*64+to];
  }
}
export function next_move(pos,skipQuiets) {
  const st = pos.st;
  while (true) {
    switch (st.stage) {
      case ST_MAIN_SEARCH: case ST_EVASION: case ST_QSEARCH: case ST_PROBCUT:
        st.stage++; return st.ttMove;
      case ST_CAPTURES_INIT:
        st.badCaptures = []; st.moves = generate_captures(pos); score_captures(pos); st.cur_idx = 0; st.stage++; break;
      case ST_GOOD_CAPTURES: {
        while (st.cur_idx < st.moves.length) {
          const move = pick_best(st.moves,st.cur_idx); st.cur_idx++;
          if (move !== st.ttMove) {
            if (see_test(pos,move,-st.moves[st.cur_idx-1].value)) return move;
            st.badCaptures.push(st.moves[st.cur_idx-1]);
          }
        }
        st.stage++; const move = st.mpKillers[0];
        if (move && move !== st.ttMove && is_pseudo_legal(pos,move) && !is_capture(pos,move)) return move;
        break;
      }
      case ST_KILLERS: {
        st.stage++; const move = st.mpKillers[1];
        if (move && move !== st.ttMove && is_pseudo_legal(pos,move) && !is_capture(pos,move)) return move;
        break;
      }
      case ST_KILLERS_2: {
        st.stage++; const move = st.countermove;
        if (move && move !== st.ttMove && move !== st.mpKillers[0] && move !== st.mpKillers[1] && is_pseudo_legal(pos,move) && !is_capture(pos,move)) return move;
        break;
      }
      case ST_QUIET_INIT:
        if (!skipQuiets) { st.moves = generate_quiets(pos); score_quiets(pos); partial_insertion_sort(st.moves,-3000*st.depth); st.cur_idx = 0; }
        st.stage++; break;
      case ST_QUIET:
        if (!skipQuiets) while (st.cur_idx < st.moves.length) {
          const move = st.moves[st.cur_idx++].move;
          if (move !== st.ttMove && move !== st.mpKillers[0] && move !== st.mpKillers[1] && move !== st.countermove) return move;
        }
        st.stage++; st.cur_idx = 0; break;
      case ST_BAD_CAPTURES:
        return st.cur_idx < st.badCaptures.length ? st.badCaptures[st.cur_idx++].move : 0;
      case ST_EVASIONS_INIT:
        st.moves = generate_evasions(pos); score_evasions(pos); st.cur_idx = 0; st.stage++; break;
      case ST_ALL_EVASIONS:
        while (st.cur_idx < st.moves.length) {
          const move = pick_best(st.moves,st.cur_idx++); if (move !== st.ttMove) return move;
        }
        return 0;
      case ST_QCAPTURES_INIT:
        st.moves = generate_captures(pos); score_captures(pos); st.cur_idx = 0; st.stage++; break;
      case ST_QCAPTURES:
        while (st.cur_idx < st.moves.length) {
          const move = pick_best(st.moves,st.cur_idx++);
          if (move !== st.ttMove && (st.depth > DEPTH_QS_RECAPTURES || to_sq(move) === st.recaptureSquare)) return move;
        }
        if (st.depth <= DEPTH_QS_NO_CHECKS) return 0;
        st.moves = generate_quiet_checks(pos); st.cur_idx = 0; st.stage++; break;
      case ST_QCHECKS:
        while (st.cur_idx < st.moves.length) { const move = st.moves[st.cur_idx++].move; if (move !== st.ttMove) return move; }
        return 0;
      case ST_PROBCUT_INIT:
        st.moves = generate_captures(pos); score_captures(pos); st.cur_idx = 0; st.stage++; break;
      case ST_PROBCUT_2:
        while (st.cur_idx < st.moves.length) {
          const move = pick_best(st.moves,st.cur_idx++); if (move !== st.ttMove && see_test(pos,move,st.threshold)) return move;
        }
        return 0;
      default: return 0;
    }
  }
}
