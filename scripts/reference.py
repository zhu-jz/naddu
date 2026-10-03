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
                 if s.startswith("info depth") or s.startswith("bestmove")]
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("manifest", "fixtures", "primitives", "search", "benchmark"))
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
            elif args.mode == "benchmark":
                from benchmark import Defaults
                result = run_searches(["ucinewgame"] + [s if s.startswith("setoption") else "position fen " + s for s in Defaults], args.depth)
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
