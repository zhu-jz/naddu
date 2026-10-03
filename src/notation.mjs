import {WHITE, BLACK, PawnValue, VALUE_MATE_IN_MAX_PLY, VALUE_MATE, CASTLING, PROMOTION,
  MOVE_NULL, FILE_G, FILE_C, rank_of, file_of, make_square, from_sq, to_sq, type_of_m,
  promotion_type, c_div} from './constants.mjs';
import {generate_legal} from './movegen.mjs';
import {do_move, gives_check} from './position.mjs';
export const StartFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export function uci_value(v) {
  if (Math.abs(v) < VALUE_MATE_IN_MAX_PLY) return `cp ${c_div(v*100,PawnValue)}`;
  return 'mate '+(v > 0 ? Math.floor((VALUE_MATE-v+1)/2) : Math.floor((-VALUE_MATE-v)/2));
}
export function uci_square(s) { return String.fromCharCode(97+(s&7))+String(1+(s>>3)); }
export function uci_move(m,chess960 = 0) {
  if (!m) return '(none)'; if (m === MOVE_NULL) return '0000';
  const from = from_sq(m), mt = type_of_m(m); let to = to_sq(m);
  if (mt === CASTLING && !chess960) to = make_square(to>from ? FILE_G : FILE_C,rank_of(from));
  return uci_square(from)+uci_square(to)+(mt === PROMOTION ? ' pnbrqk'[promotion_type(m)] : '');
}
export function uci_to_move(pos,string) {
  if (string.length === 5) string = string.slice(0,4)+string[4].toLowerCase();
  for (const ext of generate_legal(pos)) if (string === uci_move(ext.move,pos.chess960)) return ext.move;
  return 0;
}
export function set_position(pos,string) {
  const parts = string.split(' moves '), head = parts[0].trim(); let fen;
  if (head.startsWith('position fen')) fen = head.slice('position fen'.length).trim();
  else if (head.startsWith('position startpos')) fen = StartFEN;
  else if (head.startsWith('fen')) fen = head.slice(3).trim();
  else if (head.startsWith('startpos')) fen = StartFEN;
  else return;
  pos.set(fen,0);
  if (parts.length > 1) for (const str of parts[1].trim().split(/\s+/)) {
    const move = uci_to_move(pos,str); if (!move) break;
    do_move(pos,move,gives_check(pos,pos.st,move)); pos.gamePly++;
  }
  if (pos.st.pliesFromNull > 99) pos.st.pliesFromNull = 99;
  pos.rootKeyFlip = pos.st.key; pos.hasRepeated = false;
  const plies = pos.st.pliesFromNull, root = pos.st_idx;
  for (let k = 0; k <= plies; k++) {
    const st = pos.stack[root-k], key = st.key; let repeat = false;
    for (let l = k+4; l <= plies; l += 2) if (key === pos.stack[root-l].key) { repeat = true; break; }
    if (repeat) pos.hasRepeated = true; else st.key = 0n;
  }
  pos.rootKeyFlip ^= pos.st.key; pos.st.key ^= pos.rootKeyFlip;
}
