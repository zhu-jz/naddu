"""Read-only, deterministic oracle for the supplied Minifish engine.

Use -B to avoid changing the reference directory. Search output is normalized
without elapsed time/NPS; internal values and persistent state remain visible.
"""
import argparse
import contextlib
import hashlib
import io
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "minifish-python"
sys.path.insert(0, str(REFERENCE))


def manifest():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(REFERENCE.glob("*.py"))}


def verify_reference():
    expected = json.loads((ROOT / "tests/reference-manifest.json").read_text())
    actual = manifest()
    if actual != expected:
        raise RuntimeError("Python reference changed; review and update its manifest explicitly")


def initialize():
    from nnue import nnue_init
    from uci import options_init, process_delayed_settings
    nnue_init()
    options_init()
    process_delayed_settings()


def normalized(line):
    parts = line.split()
    out = []
    i = 0
    while i < len(parts):
        if parts[i] in ("time", "nps", "hashfull"):
            i += 2
        else:
            out.append(parts[i])
            i += 1
    return " ".join(out)


def run_searches(commands, depth):
    from position import Position
    from search import Threads, search_clear
    from uci import position, go, setoption, process_delayed_settings
    root = Position(search_worker=False)
    results = []
    for command in commands:
        if command == "ucinewgame":
            search_clear()
            continue
        if command.startswith("setoption"):
            setoption(command)
            process_delayed_settings()
            continue
        position(root, command)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            go(root, f"go depth {depth}")
            Threads.wait_for_search_finished()
        worker = Threads.workers[0].pos
        # Sample the move counter at the same point as the completed info line.
        lines = [normalized(s) for s in output.getvalue().splitlines()
                 if (s.startswith("info depth") and " score " in s) or s.startswith("bestmove")]
        results.append({"command": command, "depth": worker.completedDepth,
                        "score": worker.rootMoves.move[0].score,
                        "nodes_after_reporting": worker.nodes, "output": lines})
    return results


def state(pos):
    from position import pos_fen
    from nnue import nnue_evaluate
    from evaluate import evaluate
    st = pos.st
    return {"fen": pos_fen(pos), "board": pos.board[:], "side": pos.sideToMove,
            "pieceCount": pos.pieceCount[:], "key": str(st.key),
            "pawnKey": str(st.pawnKey), "materialKey": str(st.materialKey),
            "nonPawnKey": list(map(str, st.nonPawnKey)), "nonPawn": st.nonPawn,
            "rights": st.castlingRights, "ep": st.epSquare, "rule50": st.rule50,
            "pliesFromNull": st.pliesFromNull, "checkers": str(st.checkersBB),
            "blockers": list(map(str, st.blockersForKing)),
            "pinners": list(map(str, st.pinnersForKing)),
            "checkSquares": list(map(str, st.checkSquares)), "ksq": st.ksq,
            "captured": st.capturedPiece, "accumulator": [r[:] for r in st.accumulator.colors],
            "raw_nnue": nnue_evaluate(st.accumulator, pos.sideToMove), "eval": evaluate(pos)}


def position_fixture(fen):
    from position import Position, do_move, undo_move, gives_check, see_test, is_legal, do_null_move, undo_null_move
    from movegen import generate, generate_legal
    from uci import uci_move
    pos = Position(search_worker=False)
    pos.set(fen)
    result = {"fen": fen, "state": state(pos), "generation": [], "children": []}
    for kind in range(5):
        result["generation"].append(None if kind == 3 and not pos.st.checkersBB
                                    else [m.move for m in generate(pos, kind)])
    moves = generate_legal(pos)
    result["legal"] = [m.move for m in moves]
    for ext in moves:
        move = ext.move
        check = gives_check(pos, pos.st, move)
        thresholds = [-1024, -214, -83, -1, 0, 1, 208, 825]
        child = {"move": move, "uci": uci_move(move), "check": check,
                 "see": [bool(see_test(pos, move, t)) for t in thresholds]}
        do_move(pos, move, check)
        child["state"] = state(pos)
        undo_move(pos, move)
        assert state(pos) == result["state"]
        result["children"].append(child)
    if not pos.st.checkersBB:
        do_null_move(pos)
        result["null"] = state(pos)
        undo_null_move(pos)
        assert state(pos) == result["state"]
    return result


def fixtures():
    from uci import StartFEN
    fens = [StartFEN,
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 10",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 11",
        "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
        "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1",
        "4k3/P7/8/8/8/8/7p/4K3 w - - 0 1",
        "1r2k3/P7/8/8/8/8/7p/4K3 w - - 0 1",
        "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
        "4k3/8/8/r4pPK/8/8/8/8 w - f6 0 1",
        "4k3/8/8/8/8/8/4r3/4K3 w - - 99 1",
        "k7/8/8/8/1b6/8/4r3/4K3 w - - 100 1",
        "7k/6Q1/5K2/8/8/8/8/8 b - - 100 1",
        "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1"]
    return [position_fixture(fen) for fen in fens]


def primitives():
    import bitboard as bb
    from constants import c_div, make_key
    from position import PRNG, zob, cuckoo, cuckooMove
    rng = PRNG(1070372)
    tables = {name: [[str(v) for v in row] for row in getattr(bb, name)]
              for name in ("PawnAttacks", "PseudoAttacks", "BetweenBB", "LineBB")}
    sliding = {}
    for kind in ("Rook", "Bishop"):
        digest = hashlib.sha256()
        count = 0
        attack = bb.attacks_bb_rook if kind == "Rook" else bb.attacks_bb_bishop
        for sq, mask in enumerate(getattr(bb, kind + "Masks")):
            occ = 0
            while True:
                value = attack(sq, occ)
                assert value == bb.sliding_attack(bb.RookDirs if kind == "Rook" else bb.BishopDirs, sq, occ)
                digest.update(f"{sq}:{occ}:{value}\n".encode())
                count += 1
                occ = (occ - mask) & mask
                if not occ:
                    break
        sliding[kind] = {"count": count, "sha256": digest.hexdigest()}
    return {"division": [[a, b, c_div(a, b)] for a in (-1000001, -1, 0, 1, 1000001) for b in (1, 3, 128)],
            "keys": [[s, str(make_key(s))] for s in (0, 1, 65, 65535)],
            "prng": [str(rng.rand()) for _ in range(32)], "tables": tables,
            "zob": {"psq": [[str(v) for v in row] for row in zob.psq],
                    "ep": list(map(str, zob.enpassant)), "castling": list(map(str, zob.castling)),
                    "side": str(zob.side), "noPawns": str(zob.noPawns)},
            "cuckoo": list(map(str, cuckoo)), "cuckooMove": cuckooMove, "sliding": sliding}


def sequences():
    from position import Position, do_move, undo_move, gives_check, is_draw, has_game_cycle
    from movegen import generate_legal
    from uci import StartFEN, position
    rng = random.Random(1070372)
    pos = Position(search_worker=False)
    pos.set(StartFEN)
    steps = []
    for _ in range(200):
        moves = generate_legal(pos)
        if not moves:
            pos.set(StartFEN)
            steps.append({"reset": True})
            continue
        move = rng.choice(moves).move
        before = state(pos)
        check = gives_check(pos, pos.st, move)
        do_move(pos, move, check)
        after = state(pos)
        undo_move(pos, move)
        assert state(pos) == before
        do_move(pos, move, check)
        assert state(pos) == after
        steps.append({"move": move, "check": check, "legal": [m.move for m in moves], "state": after})
    commands = [
        "position startpos",
        "position startpos moves g1f3 g8f6 f3g1 f6g8",
        "position startpos moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8",
        "position startpos moves e2e4 a7a6 e4e5 d7d5 e5d6 c7d6",
        "position fen 7k/6Q1/5K2/8/8/8/8/8 b - - 100 1",
        "position fen 4k3/8/8/8/8/8/4r3/4K3 w - - 100 1",
        "position fen 4k3/8/8/8/8/8/8/4K3 w - - 100 1",
    ]
    roots = []
    for command in commands:
        position(pos, command)
        roots.append({"command": command, "state": state(pos), "hasRepeated": pos.hasRepeated,
                      "rootKeyFlip": str(pos.rootKeyFlip), "keys": [str(s.key) for s in pos.stack[:pos.st_idx+1]],
                      "draw": is_draw(pos), "cycles": [has_game_cycle(pos, ply) for ply in (0, 1, 4, 8)]})
    return {"steps": steps, "roots": roots}


def table_fixtures():
    import tt
    from constants import VALUE_NONE
    tt.tt_allocate(128)
    operations = []
    for i in range(100):
        if i % 7 == 0:
            tt.tt_new_search()
            operations.append({"kind": "generation", "generation": tt.TT.generation8})
        if i == 80:
            tt.tt_clear()
            operations.append({"kind": "clear", "generation": tt.TT.generation8})
        key = [0, 1, 2, 3, 4, 5, 6, (1 << 64)-1, (1 << 64)-2][i % 9]
        hit, entry = tt.tt_probe(key)
        before = {"hit": hit, "slot": entry.slot, "packed": str(entry.packed)}
        value = [-32000, VALUE_NONE, 65535, 31744, -32769, i*1024][i % 6]
        pv, bound, depth, move, ev = bool(i % 2), i % 4, [-6, 1, 20, 2, 15][i % 5], [0, 65, 65535, 12][i % 4], -i*731
        tt.tte_save(entry, key, value, pv, bound, depth, move, ev)
        after = {"packed": str(entry.packed), "move": tt.tte_move(entry), "value": tt.tte_value(entry),
                 "eval": tt.tte_eval(entry), "depth": tt.tte_depth(entry), "pv": tt.tte_is_pv(entry),
                 "bound": tt.tte_bound(entry), "hashfull": tt.tt_hashfull()}
        operations.append({"kind": "save", "key": str(key), "args": [value,pv,bound,depth,move,ev], "before": before, "after": after})
    conversions = []
    for v in [32002,32000,31999,31872,31744,31743,-32000,-31999,-31872,-31744,-31743,0]:
        for ply in (0,3,127):
            for r50 in (0,90,99,100):
                conversions.append([v,ply,r50,tt.value_to_tt(v,ply),tt.value_from_tt(v,ply,r50)])
    from position import Position, do_move, gives_check
    from uci import StartFEN, uci_to_move
    from constants import from_sq, to_sq
    import history as h
    pos = Position()
    pos.set(StartFEN)
    for text in ("e2e4","e7e5","g1f3","b8c6","f1b5","a7a6"):
        m = uci_to_move(pos,text)
        pos.st.currentMove = m
        pos.st.history = pos.counterMoveHistory[pos.board[from_sq(m)]][to_sq(m)]
        do_move(pos,m,gives_check(pos,pos.st,m))
    histories = []
    for v in (-100000,-50000,-7183,-1024,-1,0,1,1024,7183,50000,100000,256,-256):
        h.history_update(pos.mainHistory,0,1234,v)
        h.continuation_history_update(pos.counterMoveHistory[2][12],512,v)
        h.capture_history_update(pos.captureHistory,2,12,5,v)
        h.correction_history_update(pos.correctionHistory,0,pos,v)
        h.non_pawn_correction_history_update(pos.nonPawnCorrectionHistory,0,0,pos,v)
        h.non_pawn_correction_history_update(pos.nonPawnCorrectionHistory,1,0,pos,-v)
        h.update_continuation_histories(pos,2,12,v)
        move = uci_to_move(pos,"b5c6")
        h.update_quiet_histories(pos,move,v)
        histories.append({"bonus": v, "values": [pos.mainHistory[0][1234],pos.counterMoveHistory[2][12][512],
                pos.captureHistory[2][12][5],pos.correctionHistory[0][pos.st.pawnKey&16383],
                pos.nonPawnCorrectionHistory[0][0][pos.st.nonPawnKey[0]&8191],
                pos.nonPawnCorrectionHistory[1][0][pos.st.nonPawnKey[1]&8191], h.correction_value(pos)],
                "killers": pos.killers[pos.st.ply][:], "countermove": pos.counterMoves[pos.board[to_sq(pos.stack[pos.st_idx-1].currentMove)]][to_sq(pos.stack[pos.st_idx-1].currentMove)],
                "continuations": [pos.stack[pos.st_idx-1-i].history[2*64+12] for i in range(6)],
                "main_quiet": pos.mainHistory[0][move&4095]})
    return {"tt": operations, "conversions": conversions, "histories": histories,
            "stat": [[d,h.stat_bonus(d),h.stat_malus(d)] for d in range(16)]}


def picker_fixtures():
    from position import Position, is_capture
    from movegen import generate_legal, ExtMove
    from constants import make_move, to_sq
    import movepick as mp
    fens = [s["fen"] for s in json.loads((ROOT / "tests/fixtures/positions.json").read_text())]
    result = []
    for fen in fens:
        for kind, depth, skip_after in [("main",1,999),("main",5,3),("qs",0,999),("qs",-1,999),("qs",-5,999),("probcut",-208,999),("probcut",825,999)]:
            for tt_choice in (0,1,2):
                pos = Position()
                pos.set(fen)
                pos.st.ply = 3
                for c in range(2):
                    pos.mainHistory[c][:] = [((i*13+c*31)%255)-128 for i in range(4096)]
                for i in range(7):
                    row = pos.counterMoveHistory[i+1][i]
                    row[:] = type(row)("b", [((j*11+i*29)%255)-128 for j in range(1024)])
                    pos.stack[i].history = row
                    pos.stack[i].currentMove = make_move(8+i,16+i)
                for pc in range(16):
                    for s in range(64):
                        pos.captureHistory[pc][s][:] = [((pc*1103+s*117+t*101)%60000)-30000 for t in range(8)]
                legal = [e.move for e in generate_legal(pos)]
                quiets = [m for m in legal if not is_capture(pos,m)]
                pos.killers[3][:] = (quiets+[0,0])[:2]
                prev_sq = to_sq(pos.stack[pos.st_idx-1].currentMove)
                pos.counterMoves[pos.board[prev_sq]][prev_sq] = quiets[-1] if quiets else 0
                ttm = 0 if tt_choice == 0 else (legal[0] if legal and tt_choice == 1 else 65535)
                if kind == "main": mp.mp_init(pos,ttm,depth,3)
                elif kind == "qs": mp.mp_init_q(pos,ttm,depth, to_sq(legal[0]) if legal else 64)
                else: mp.mp_init_probcut(pos,ttm,depth)
                order = []
                while True:
                    move = mp.next_move(pos,len(order) >= skip_after)
                    if not move: break
                    order.append([move,pos.st.stage,pos.st.cur_idx])
                    if len(order) > 256: raise RuntimeError("Move picker did not terminate")
                result.append({"fen": fen,"kind": kind,"depth": depth,"skip_after": skip_after,"tt_choice": tt_choice,"order": order})
    sorts = []
    for limit in (-20,0,20):
        moves = [ExtMove(i+1,v) for i,v in enumerate([0,-30,20,20,-5,30,0,20])]
        mp.partial_insertion_sort(moves,limit)
        sorts.append({"limit": limit,"order": [[m.move,m.value] for m in moves]})
    return {"pickers": result,"sorts": sorts}


def qsearch_fixtures():
    from position import Position
    from search import qsearch_node
    from constants import VALUE_NONE
    import tt
    fens = [s["fen"] for s in json.loads((ROOT / "tests/fixtures/positions.json").read_text())]
    cases = []
    for fen in fens:
        for depth, nt, alpha, beta, forced_check, warm in [
            (0,1,-32001,32001,None,False),(-1,1,-32001,32001,None,False),
            (-5,0,-1,0,None,False),(0,0,100,101,None,False),
            (0,1,-32001,32001,True,False),(0,0,100,101,None,True)]:
            tt.tt_allocate(1)
            pos = Position()
            pos.set(fen)
            in_check = bool(pos.st.checkersBB) if forced_check is None else forced_check
            if warm:
                qsearch_node(pos,-32001,32001,0,1,bool(pos.st.checkersBB))
                pos.nodes = 0
            value = qsearch_node(pos,alpha,beta,depth,nt,in_check)
            entries = [[i,str(packed)] for i,packed in enumerate(tt.TT.table) if packed]
            cases.append({"fen":fen,"depth":depth,"nt":nt,"alpha":alpha,"beta":beta,
                          "forced_check":forced_check,"warm":warm,"value":value,"nodes":pos.nodes,
                          "pv":pos.pvArray[0],"staticEval":pos.st.staticEval,"tt":entries})
    return cases


def history_digest(pos):
    import struct
    digest = hashlib.sha256()
    for table in (pos.mainHistory,pos.correctionHistory):
        for row in table:
            digest.update(struct.pack("<"+"b"*len(row),*row))
    for piece in pos.counterMoveHistory:
        for row in piece:
            digest.update(bytes(row))
    for table in (pos.captureHistory,pos.nonPawnCorrectionHistory):
        for rows in table:
            for row in rows:
                digest.update(struct.pack("<"+"h"*len(row),*row))
    for row in pos.counterMoves:
        digest.update(struct.pack("<"+"H"*len(row),*row))
    return digest.hexdigest()


def mainsearch_fixtures():
    from position import Position
    from search import search_node, init_search_sentinels, RootMoves, Limits, Threads
    from movegen import generate_legal
    from timeman import now, time_init
    from uci import position
    import tt
    fens = [s["fen"] for s in json.loads((ROOT / "tests/fixtures/positions.json").read_text())]
    result = []
    for fen in fens:
        for depth, nt, alpha, beta, cut, warm in [(1,1,-32001,32001,False,False),(3,1,-32001,32001,False,False),
                (6,1,-32001,32001,False,False),(10,1,-32001,32001,False,False),(6,0,0,1,True,False),(10,0,-1,0,False,True)]:
            tt.tt_allocate(1)
            Limits.reset()
            Limits.startTime = now()
            time_init(0,0,Limits)
            Threads.stop = False
            root = Position(search_worker=False)
            position(root,"position fen "+fen)
            pos = Position()
            pos.copy_root_from(root)
            pos.rootMoves = RootMoves()
            legal = generate_legal(root)
            pos.rootMoves.size = len(legal)
            for i,e in enumerate(legal): pos.rootMoves.move[i].reset_for_search(e.move)
            if not legal: continue
            pos.pvLast = len(legal)
            pos.rootDepth = depth
            pos.rootDelta = 64002
            init_search_sentinels(pos)
            for st in pos.stack[pos.st_idx:pos.st_idx+3]:
                st.currentMove = st.excludedMove = st.moveCount = 0
                st.ttHit = False
                st.staticEval = 0
                st.history = None
            with contextlib.redirect_stdout(io.StringIO()):
                if warm: search_node(pos,-32001,32001,6,False,1)
                value = search_node(pos,alpha,beta,depth,cut,nt)
            result.append({"fen":fen,"depth":depth,"nt":nt,"alpha":alpha,"beta":beta,"cut":cut,"warm":warm,
                    "value":value,"nodes":pos.nodes,"selDepth":pos.selDepth,"pv":pos.pvArray[0],
                    "rootMoves":[[rm.pv[:rm.pvSize],rm.score,rm.averageScore,rm.selDepth] for rm in pos.rootMoves.move[:pos.rootMoves.size]],
                    "tt":[[i,str(p)] for i,p in enumerate(tt.TT.table) if p],"histories":history_digest(pos)})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("manifest", "fixtures", "primitives", "sequences", "tables", "pickers", "qsearch", "mainsearch", "lifecycle", "search", "benchmark"))
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mode == "manifest":
        result = manifest()
    else:
        verify_reference()
        initialize()
        try:
            if args.mode == "fixtures":
                result = fixtures()
            elif args.mode == "primitives":
                result = primitives()
            elif args.mode == "sequences":
                result = sequences()
            elif args.mode == "tables":
                result = table_fixtures()
            elif args.mode == "pickers":
                result = picker_fixtures()
            elif args.mode == "qsearch":
                result = qsearch_fixtures()
            elif args.mode == "mainsearch":
                result = mainsearch_fixtures()
            elif args.mode == "benchmark":
                from benchmark import Defaults
                result = run_searches(["ucinewgame"] + [s if s.startswith("setoption") else "position fen " + s for s in Defaults], args.depth)
            elif args.mode == "lifecycle":
                commands = ["ucinewgame","position startpos","position startpos","ucinewgame","position startpos",
                    "position startpos moves e2e4 e7e5 g1f3 b8c6 f1b5 a7a6",
                    "setoption name MultiPV value 3","position startpos","position startpos",
                    "ucinewgame","position startpos","setoption name MultiPV value 1",
                    "position fen 7k/6Q1/5K2/8/8/8/8/8 b - - 100 1",
                    "position fen 7k/5K2/6Q1/8/8/8/8/8 b - - 0 1"]
                result = {"commands": commands,"results":run_searches(commands,args.depth)}
            else:
                commands = json.load(sys.stdin)
                result = run_searches(commands, args.depth)
        finally:
            from search import Threads
            Threads.shutdown()
    encoded = json.dumps(result, separators=(",", ":")) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.write(encoded)


if __name__ == "__main__":
    main()
