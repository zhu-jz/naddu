# Minifish port validation

Completed on 2026-10-04 in the supplied workspace, using Node 24.11.0,
CPython 3.14.7 and Chromium 154.0.8037.58. The public `naddu.js` now runs the
ported NNUE and complete single-thread search. All authored changes are committed
in the implementation sequence recorded below. The supplied Python folder is
unchanged and retains its original untracked status.

This report records the original port acceptance. Naddu subsequently added a
configurable TT, the requested 50-move time horizon and Python-style SMP.
Reproduce the fixed-depth results with `Threads=1` and `ReferenceTT=true`; the
parity scripts enable those settings automatically. See the
[MultiPV/SMP validation](multipv-smp-validation.md) for the subsequent work.

## Benchmark acceptance

Both actual public entry points were originally run with their default `bench`
command. The equivalent commands for the current release are:

```powershell
& $env:PYTHON -B minifish-python/__main__.py bench
node naddu.js "setoption name ReferenceTT value true" bench
```

Both matched all 47 benchmark positions at depth 13 and reported **2,526,355
counted moves**. The comparison checks every depth/seldepth, score and bound,
node count, PV, bestmove and ponder move. Only elapsed time, NPS and hashfull
are removed. The core comparison additionally checks internal final scores,
completed depth and counters after bestmove reporting, which can include a move
made for TT ponder extraction. TT, histories and root averages persist through
the complete position/option sequence.

The captured Python records are in
[`bench-depth13.json`](../tests/fixtures/bench-depth13.json). The live public
comparison report is in [`benchmark-validation.json`](benchmark-validation.json),
including the release and reference-manifest fingerprints. The normalized public
output has SHA-256
`a578d597642a65d71eb8d2b9bc3a93c8397ab5341bc2489825548b983c6d5ff8`.

One observed public benchmark run took 208,025 ms in Python and 19,696 ms in
JavaScript, with reported rates of 12,144 and 128,267 moves/second respectively.
These measurements describe this machine and run; timing is separate from the
deterministic equality checks.

## Completion audit

| Plan step | Delivered implementation | Authoritative verification |
| --- | --- | --- |
| 0: investigation | `58896f0`, [port plan](minifish-port-plan.md) | Measured baselines, acceptance contract and fingerprints of all 15 Python files |
| 1: oracle and fixtures | `adaf2b6`, `scripts/reference.py` | Manifest guard and captured reference results; reference source still matches every pinned SHA-256 |
| 2: build and core | `4b18e67`, `scripts/build.mjs` | Reproducible dependency-free release, Node and real classic Worker execution; explicit LF build inputs on Windows |
| 3: integers/bitboards | `4b18e67`, `src/constants.mjs`, `src/bitboard.mjs` | Full masks/attacks/line/between tables, PRNG/keys, and 102,400 rook plus 5,248 bishop occupancy subsets |
| 4: position/moves | `d6b9dc6`, `src/position.mjs`, `src/movegen.mjs` | Ordered generation, legality, SEE, check/pin state, transitions/undo/null, FEN, keys, filtered repetition/cycles; 200 seeded steps; start perft 4 = 197,281, Kiwipete perft 3 = 97,862, rook endgame perft 3 = 2,812 |
| 5: NNUE/evaluation | `392bc73`, `d6b9dc6`, `src/nnue.mjs`, `src/evaluate.mjs` | Independently packed Python network fingerprint matches all 49,345 int16 values / 98,690 bytes; both accumulator perspectives, incremental/refresh/undo, raw and scaled evaluation |
| 6: clustered TT | `ba93fee`, `src/tt.mjs` | Exact capacity, packed entries, collisions, snapshots, replacement, aging, move retention, signed widths and mate/rule-50 conversion; all search writes and event digests |
| 7: histories | `ba93fee`, `src/history.mjs` | Main, continuation, capture and both correction families, countermoves, killers, sentinels, saturation/wrapping, clears/persistence; complete table digests and updates |
| 8: move picker | `36eeb6f`, `src/movepick.mjs` | 273 seeded picker configurations; stages, scores, order, ties, skipped quiets, evasions, QS and ProbCut |
| 9: quiescence | `b1c3150`, `src/search.mjs` | Isolated return values, PVs, move counts, cached evaluations and every TT entry; full recursive/ordering/pruning traces |
| 10: main pruning | `e56821f`, `src/search.mjs` | Controlled PV/non-PV windows and warm TT cases; full TT/history comparisons; explicit razoring, RFP, null, ProbCut, futility/history/SEE decisions |
| 11: extensions/reductions | `e56821f`, trace suite | Actual single/double/triple/negative extensions, singular verification/restoration, deep-check extensions, verified null move, LMR and re-searches; matching event digests |
| 12: root lifecycle | `7d5df96`, `src/search.mjs` | Every benchmark iteration, repeated roots, warm searches, new games, mixed positions, aspiration, stable ordering, optimism, root averages and MultiPV |
| 13: public UCI | `c5ea40f`, `3c93111`, `src/uci.mjs`, `src/entry.mjs` | Public Node benchmark/lifecycle/options; readiness during search, stop, ponderhit, replacement and quit; deterministic limits/clocks; real Chromium direct and nested Workers; board/moves/eval/perft aliases |
| 14: full parity | Captured depth-13 benchmark, trace suite and public comparison | Live supplied Python benchmark versus public JS benchmark, deeper/warm/controlled traces, complete test suite, unchanged manifest and committed release |

The final suite contains **37 passing tests**. Special-position and transition
fixtures cover castling on both sides, EP and pinned EP, promotions and
underpromotions, king mirror-boundary changes, checks/double checks, terminal
roots, rule-50/checkmate interactions and repetition before/after the root.

## Trace coverage

The six deeper and controlled cases match **1,276,300 events**, including search
entry/windows/depth, recursive returns, TT probes/saves, chosen moves, prune/cut
reasons, history writes, extensions and fixed-point reductions. Final TT and all
history-table digests match too. Instrumentation runs only in memory/test bundles;
the pinned Python files and production search have no trace hooks.

| Feature actually reached | Matching count |
| --- | ---: |
| Singular verification | 623 |
| Single / double / triple extension | 167 / 147 / 5 |
| Negative extension -1 / -2 | 46 / 15 |
| Deep-check extension | 43 |
| Verified null-move search | 1 |
| ProbCut picker / successful cutoff | 4,642 / 2,342 |
| Checked ProbCut cutoff | 161 |
| LMR / dynamic re-search | 32,266 / 1,070 |

Natural depth-12 start-position and Kiwipete searches exercise every extension
value, including the rare triple and negative extensions. Controlled cases also
seed TT entries and use a depth-16 null window to make rare paths reproducible.
These are coverage fixtures; the full benchmark remains ungated.

On a trace mismatch, optional JSONL logs identify the first differing event and
its recursive window/key context. A targeted replay saves the complete position,
NNUE accumulators, predecessor frames, per-ply search arrays, root records, TT
entries and all history tables. A raw-event comparison and complete-state
snapshot comparison were also verified directly against Python.

## Reproduction

Keep the original `minifish-python/` directory in the workspace. Set `PYTHON` to
the reference interpreter, or use the harness's offline `uv` fallback.

```powershell
npm run build
npm test
npm run parity -- 13          # live oracle: internal scores and all iterations
npm run parity:captured       # same core/release checks against saved depth 13
npm run parity:benchmark      # actual Python and JS public bench commands
npm run parity:trace
npm run test:browser
```

To regenerate traces or diagnose a mismatch:

```powershell
& $env:PYTHON -B scripts/trace_reference.py tests/fixtures/trace-cases.json build/search-traces-python.json build/trace-python
node scripts/trace.mjs --events
# If a mismatch created build/trace-target.json, capture Python's state too:
& $env:PYTHON -B scripts/trace_reference.py tests/fixtures/trace-cases.json build/search-traces-python.json build/trace-python build/trace-target.json
```

Real clock deadlines can reach different nodes because the runtimes have
different speeds. The current clock tests match the Python oracle with the
requested 50-move horizon applied in memory; actual deadline responsiveness is
tested separately.
Browser interruption requires cross-origin isolation; ordinary pages retain the
documented terminate/recreate Worker method. Bun was unavailable in this
environment. Python's fixed TT capacity is available through `ReferenceTT`.
Orthodox UCI castling interpretation and other pinned search quirks are retained
as described in the port plan.
