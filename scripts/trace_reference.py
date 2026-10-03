"""Instrument reference functions in memory; never edit the pinned source."""
import ast
import contextlib
import hashlib
import io
import json
import sys
from collections import Counter
from pathlib import Path
from reference import ROOT, REFERENCE, verify_reference, initialize, normalized, history_digest, state


def snapshot(pos):
    import tt
    result = state(pos)
    result["game"] = {"rootKeyFlip":str(pos.rootKeyFlip),"gamePly":pos.gamePly,"hasRepeated":pos.hasRepeated,"chess960":pos.chess960,
        "byTypeBB":list(map(str,pos.byTypeBB)),"byColorBB":list(map(str,pos.byColorBB)),
        "castlingRightsMask":list(pos.castlingRightsMask),"castlingRookSquare":list(pos.castlingRookSquare),"castlingPath":list(map(str,pos.castlingPath))}
    result["search"] = {name:getattr(pos,name) for name in ("nodes","selDepth","rootDepth","rootDelta",
        "completedDepth","pvIdx","pvLast","multiPV","nmpMinPly","st_idx","optimism","killers",
        "statScore","doubleExtensions","cutoffCnt","ttPv","pvArray")}
    result["frames"] = [{**{name:getattr(st,name) for name in ("ply","staticEval","currentMove","excludedMove","moveCount","ttHit")},
        "key":str(st.key),"checkers":str(st.checkersBB),"history":list(st.history) if st.history is not None else None}
        for st in pos.stack[:pos.st_idx+1]]
    result["tt"] = {"generation":tt.TT.generation8,"entries":[[i,str(p)] for i,p in enumerate(tt.TT.table) if p]}
    result["rootMoves"] = None if pos.rootMoves is None else {"size":pos.rootMoves.size,
        "move":[{name:getattr(rm,name) for name in ("score","previousScore","averageScore","selDepth","pvSize","pv")} for rm in pos.rootMoves.move]}
    result["histories"] = {}
    def lists(value): return [lists(v) for v in value] if not isinstance(value,int) else value
    for name in ("mainHistory","correctionHistory","counterMoveHistory","captureHistory","nonPawnCorrectionHistory","counterMoves"):
        result["histories"][name] = lists(getattr(pos,name))
    return result


class Trace:
    def __init__(self):
        self.log = None
        self.output_dir = None
        self.case = None
        self.position = None
        self.target = None
        self.reset()
    def reset(self):
        if self.log: self.log.close()
        if self.output_dir and self.case:
            self.output_dir.mkdir(parents=True,exist_ok=True)
            self.log = (self.output_dir / f"case-{self.case}.jsonl").open("w",encoding="utf-8",newline="\n")
        self.digest = hashlib.sha256()
        self.counts = Counter()
        self.events = 0
    def __call__(self, event):
        line = json.dumps(event,separators=(",",":"))+"\n"
        self.digest.update(line.encode())
        if self.log: self.log.write(line)
        self.events += 1
        self.counts[event[0]] += 1
        if event[0] == "extension": self.counts[f"extension_{event[4]}"] += 1
        if event[0] in ("prune","cut"): self.counts[f"{event[0]}_{event[1]}"] += 1
        if self.target and self.case == self.target["case"] and self.events == self.target["event"] and self.position:
            (self.output_dir / f"case-{self.case}-state.json").write_text(json.dumps(snapshot(self.position),separators=(",",":")))


def instrument(trace):
    import search, tt, position, movepick, history
    source = (REFERENCE / "search.py").read_text()
    parsed = ast.parse(source)
    parents = {child:node for node in ast.walk(parsed) for child in ast.iter_child_nodes(node)}
    class Branches(ast.NodeTransformer):
        def visit(self, node):
            result = super().visit(node)
            if not isinstance(result, ast.stmt): return result
            line = source.splitlines()[node.lineno-1].strip()
            event = None
            if isinstance(node,ast.Continue):
                parent = parents[node]
                if isinstance(parent,ast.If):
                    condition = ast.unparse(parent.test)
                    label = None
                    for needle,reason in [("captureHistory","capture_futility"),("-214 * depth","capture_see"),
                            ("history_val <","quiet_history"),("lmrDepth < 11","quiet_futility"),
                            ("-25 * lmrDepth","quiet_see"),("moveCount > 2","qs_count"),
                            ("futilityValue <= alpha","qs_futility"),("futilityBase <= alpha","qs_futility_see"),
                            ("PIECE_TO_HISTORY_GRAIN * hist1","qs_history"),("-83","qs_see")]:
                        if needle in condition:
                            label = reason
                            break
                    if label: event = f"['prune','{label}',pos.nodes,st.ply,move,depth]"
            elif isinstance(node,ast.Return):
                expression = ast.unparse(node.value)
                label = {"ttValue":"tt","eval_val":"rfp","nullValue":"null", "probCutBeta":"checked_probcut","value":"singular"}.get(expression)
                if expression.startswith("qsearch_node(pos, alpha - 1"): label = "razoring"
                if expression == "val - (probCutBeta - beta)": label = "probcut"
                parent = parents[node]
                if expression == "bestValue" and isinstance(parent,ast.If) and ast.unparse(parent.test) == "bestValue >= beta": label = "stand_pat"
                if label: event = f"['cut','{label}',pos.nodes,st.ply,depth,alpha,beta]"
            elif line.startswith("pos.nmpMinPly = st.ply +"):
                event = "['verified_null',pos.nodes,st.ply,depth,R]"
            elif line == "st.excludedMove = move":
                event = "['singular',pos.nodes,st.ply,move,singularBeta,singularDepth]"
            elif line == "newDepth += extension":
                event = "['extension',pos.nodes,st.ply,move,extension,depth,newDepth,r]"
            elif line.startswith("d = clamp(newDepth"):
                # This event observes d after the assignment.
                return [result, ast.copy_location(ast.parse("__trace(['lmr',pos.nodes,st.ply,move,newDepth,d,r])").body[0],node)]
            elif line.startswith("newDepth += (val >"):
                return [result, ast.copy_location(ast.parse("__trace(['lmr_research',pos.nodes,st.ply,move,newDepth,d,val])").body[0],node)]
            elif line == "elif givesCheck and depth > 8:":
                result.body.insert(0,ast.copy_location(ast.parse("__trace(['deep_check',pos.nodes,st.ply,move,depth])").body[0],node))
            if event:
                return [ast.copy_location(ast.parse("__trace("+event+")").body[0],node),result]
            return result
    functions = [node for node in parsed.body if isinstance(node,ast.FunctionDef) and node.name in ("search_node","qsearch_node")]
    tree = ast.fix_missing_locations(Branches().visit(ast.Module(body=functions,type_ignores=[])))
    search.__dict__["__trace"] = trace
    exec(compile(tree,str(REFERENCE / "search.py"),"exec"),search.__dict__)

    def wrap(name, original):
        def wrapped(*args, **kwargs):
            if name in ("search_node","qsearch_node"):
                pos,a,b,d,x,y = args
                kind = "main" if name == "search_node" else "qs"
                previous = trace.position
                trace.position = pos
                try:
                    trace(["enter",kind,pos.nodes,pos.st.ply,a,b,d,bool(x if kind=="main" else y),y if kind=="main" else x,pos.st.excludedMove,str(pos.st.key)])
                    value = original(*args,**kwargs)
                    trace(["return",kind,pos.nodes,pos.st.ply,value])
                    return value
                finally: trace.position = previous
            if name in ("do_move","undo_move","do_null_move","undo_null_move"):
                pos = args[0]
                trace([name,pos.nodes,pos.st.ply]+([args[1],bool(args[2])] if name=="do_move" else [args[1]] if name=="undo_move" else []))
            value = original(*args,**kwargs)
            if name == "tt_probe":
                hit,tte = value
                trace(["probe",str(args[0]),bool(hit),tte.slot,str(tte.packed)])
            elif name == "tte_save":
                tte,key,v,pv,bound,depth,move,ev = args
                trace(["save",str(key),v,bool(pv),bound,depth,move,ev,tte.slot,str(tte.packed)])
            elif name == "next_move":
                pos,skip = args
                trace(["pick",pos.nodes,pos.st.ply,value,pos.st.stage,pos.st.cur_idx,bool(skip)])
            elif name == "mp_init_probcut":
                pos,move,threshold = args
                trace(["probcut",pos.nodes,pos.st.ply,move,threshold])
            elif name == "history_update":
                table,c,m,v = args
                trace([name,c,m,v,table[c][m&4095]])
            elif name == "continuation_history_update":
                row,index,v = args
                trace([name,index,v,row[index]])
            elif name == "capture_history_update":
                table,pc,to,captured,v = args
                trace([name,pc,to,captured,v,table[pc][to][captured]])
            elif name == "correction_history_update":
                table,c,pos,v = args
                index = pos.st.pawnKey&16383
                trace([name,c,index,v,table[c][index]])
            elif name == "non_pawn_correction_history_update":
                table,c,stm,pos,v = args
                index = pos.st.nonPawnKey[c]&8191
                trace([name,c,stm,index,v,table[c][stm][index]])
            return value
        return wrapped
    for module,name in [(search,"search_node"),(search,"qsearch_node"),(tt,"tt_probe"),(tt,"tte_save"),
            (movepick,"next_move"),(movepick,"mp_init_probcut"),(position,"do_move"),(position,"undo_move"),(position,"do_null_move"),(position,"undo_null_move")]+[(history,name) for name in ("history_update","continuation_history_update","capture_history_update","correction_history_update","non_pawn_correction_history_update")]:
        original = getattr(module,name)
        wrapped = wrap(name,original)
        for imported in list(sys.modules.values()):
            if imported and getattr(imported,name,None) is original: setattr(imported,name,wrapped)


def run_case(spec,trace):
    import search, tt, uci, timeman
    from position import Position
    tt.tt_allocate(1)
    search.search_clear()
    search.Limits.reset()
    search.Limits.startTime = 0
    timeman.now = uci.now = lambda: 0
    search.Threads.stop = False
    root = Position(search_worker=False)
    uci.position(root,"position fen "+spec["fen"])
    output = io.StringIO()
    if spec["type"] == "root":
        trace.reset()
        with contextlib.redirect_stdout(output):
            for _ in range(spec.get("repeat",1)):
                uci.go(root,f"go depth {spec['depth']}")
                search.Threads.wait_for_search_finished()
        pos = search.Threads.workers[0].pos
        value = pos.rootMoves.move[0].score
    else:
        pos = Position()
        pos.copy_root_from(root)
        pos.st.ply = spec.get("ply",1)
        pos.rootDepth = spec["depth"]
        pos.rootDelta = 64002
        search.init_search_sentinels(pos)
        timeman.time_init(0,0,search.Limits)
        if spec.get("tt"):
            seed = spec["tt"]
            move = uci.uci_to_move(pos,seed["move"])
            assert move
            _,entry = tt.tt_probe(pos.st.key)
            tt.tte_save(entry,pos.st.key,seed["value"],False,2,spec["depth"]-3,move,32002)
        trace.reset()
        value = search.search_node(pos,spec["alpha"],spec["beta"],spec["depth"],spec.get("cut",False),0)
    entries = [[i,str(p)] for i,p in enumerate(tt.TT.table) if p]
    return {"spec":spec,"value":value,"nodes":pos.nodes,"selDepth":pos.selDepth,
        "events":trace.events,"digest":trace.digest.hexdigest(),"counts":dict(trace.counts),
        "tt":hashlib.sha256(json.dumps(entries,separators=(",",":")).encode()).hexdigest(),
        "histories":history_digest(pos),"output":[normalized(s) for s in output.getvalue().splitlines()
            if (s.startswith("info depth") and " score " in s) or s.startswith("bestmove")]}


if __name__ == "__main__":
    verify_reference()
    initialize()
    trace = Trace()
    if len(sys.argv)>3: trace.output_dir = Path(sys.argv[3])
    if len(sys.argv)>4: trace.target = json.loads(Path(sys.argv[4]).read_text())
    instrument(trace)
    specs = json.loads(Path(sys.argv[1]).read_text())
    try:
        results = []
        for i,spec in enumerate(specs):
            trace.case = i+1
            trace.reset()
            results.append(run_case(spec,trace))
        encoded = json.dumps(results,separators=(",",":"))+"\n"
        if len(sys.argv)>2: Path(sys.argv[2]).write_text(encoded)
        else: print(encoded,end="")
    finally:
        from search import Threads
        Threads.shutdown()
        if trace.log: trace.log.close()
