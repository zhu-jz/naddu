# Naddu

Naddu is a JavaScript UCI chess engine that replicates
[Minifish](https://github.com/linrock/minifish) by linrock. Its single-thread core
is a faithful port of the supplied `minifish-python` reference, including its
embedded NNUE network, move ordering, clustered TT, histories, pruning,
extensions and reductions.

It can be easily deployed in your web pages.

All you need is `naddu.js` from the repo root.

The release has no runtime dependencies or separate network file. Edit the
modules in `src/` and run `npm run build` to regenerate `naddu.js`.

## Hello world

```
const naddu = new Worker('naddu.js');
const ucioutput = document.getElementById('ucioutput');

naddu.onmessage = function(e) {
  ucioutput.textContent += e.data + '\n'; // naddu reponds with text as per UCI 
};

naddu.postMessage('uci');
naddu.postMessage('ucinewgame');
naddu.postMessage('position startpos');
naddu.postMessage('board');
naddu.postMessage('eval');
naddu.postMessage('go depth 8');
naddu.postMessage('go movetime 1000')
```

Try this example here: https://op12no2.github.io/naddu/examples/hello_world.html

## More examples

- [mates](https://op12no2.github.io/naddu/examples/mates.html) - finds mates and checks the reported mate distance.
- [console](https://op12no2.github.io/naddu/examples/console.html) - a console, type UCI commands and see the replies, `?` lists them.
- [play](https://op12no2.github.io/naddu/examples/play.html) - play against Naddu at five strength levels, or watch Naddu play itself.
- [endgames](https://op12no2.github.io/naddu/examples/endgames.html) - plays out random K+Q v K and K+R v K positions and checks white mates.
- [analysis](https://op12no2.github.io/naddu/examples/analysis.html) - set up a position by dragging pieces, presets or FEN, then analyse it.
- [openings](https://op12no2.github.io/naddu/examples/openings.html) - twenty workers search each first move deeper and deeper, then rank them.
- [perft](https://op12no2.github.io/naddu/examples/perft.html) - move generator node counts against the known values, plus your own.
- [bk](https://op12no2.github.io/naddu/examples/bk.html) - the Bratko-Kopec test at a search time of your choice.
- [symmetry](https://op12no2.github.io/naddu/examples/symmetry.html) - eight workers play random games and check every position evals the same when colour flipped.

## UCI protocol

Naddu implements the following [UCI](https://backscattering.de/chess/uci/) commands: `uci`, `uciok`, `isready`, `readyok`, `ucinewgame|u`, `setoption`, `position|p`, `go|g` and `quit|q`.

Node uses a persistent search worker and a responsive UCI receiver. `stop`,
`ponderhit` and `quit` work during search, preserving search state across calls.
Browser Workers also support these controls on pages with cross-origin isolation
(`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`). On ordinary pages, a synchronous
search blocks command reception; interrupt it by terminating the Worker:

```
naddu.terminate();
naddu = new Worker('naddu.js');
```

## UCI extensions

- `board|b` - show the current position.
- `moves|m` - list the legal moves, or `checkmate` or `stalemate` if there are none.
- `eval|e` - static eval of the current position from the side to move's perspective.
- `perft|f <depth>` - leaf node count.
- `bench|h [hash=16] [threads=1] [limit=13] [default|current|fen-file] [depth|time]` - run Python's 47-position benchmark, report nodes and nps. FEN files are supported in Node.
- `help|?` - list commands.

## Command line

Start Naddu from a command line with Node:

```
node naddu.js
```

Or give it commands:-

```
node naddu.js uci ucinewgame "position startpos" "go depth 8"
node naddu.js "bench 16 1 13"
```

## Reference parity and development

`Threads` is restricted to one search thread. `MultiPV`, `Ponder`, `Hash` and
`UCI_Chess960` follow the reference options. The supplied reference fixes its TT
at 28,672 clusters regardless of `Hash`; changing `Hash` still reallocates it.
Its UCI position parser also hard-codes orthodox castling interpretation even
when `UCI_Chess960` is set. These behaviors are retained for parity.

Exact comparisons include internal scores, completed depth, selective depth,
PVs, bestmove/ponder and move counts, with persistent TT/history/root state.
Elapsed time and NPS depend on the runtime. Real-time searches can stop at
different nodes; deterministic clock tests verify the time-control logic.

Naddu's time manager uses a 50-move horizon and a `0.05` low-clock factor,
instead of the reference's 25 moves and `0.025`. The 10 ms overhead and other
time-management formulas are retained. This is an intentional time-control
variation; fixed-depth search parity is preserved. The clock tests use the Python
oracle with these two constants changed in memory (`npm run reference -- controls50`).

Keep the supplied Python source in `minifish-python/` to regenerate fixtures or
run live differential checks. Its SHA-256 manifest is pinned; the source is
never modified by the harness. Set `PYTHON` to your Python executable, or install
Python through `uv` for the default offline runner.

```
npm run build
npm test
npm run parity -- 13
npm run parity:benchmark
npm run test:browser
```

The browser check uses an installed Chromium browser (`CHROME` can select its
executable). See the [port plan](docs/minifish-port-plan.md) for the acceptance
contract and implementation milestones, and the
[validation report](docs/minifish-port-validation.md) for the exact benchmark
results, branch coverage and reproduction commands.
