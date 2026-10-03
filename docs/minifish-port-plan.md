# Minifish single-thread parity plan

Investigated on 2026-10-03. Naddu baseline: `3bbb097adc492881811c8c2b0d21af042071d687`.
Runtime checks used Node 24.11.0 and CPython 3.14.7.

## Objective and acceptance contract

Make Naddu execute the supplied `minifish-python` engine's NNUE evaluation and
single-thread search in JavaScript. The supplied Python files are the reference,
including their current quirks. Preserve Naddu's `node naddu.js` and
`new Worker('naddu.js')` entry points and text UCI interface.

Exact parity means that, with the same position, preceding command sequence,
reference table capacity, and initial state, both engines produce the same:

- Ordered generated moves, legality decisions, check information, SEE decisions,
  position transitions, hash keys, and repetition/cycle decisions.
- NNUE accumulators for both perspectives, raw network output, scaled evaluation,
  corrected evaluation, and all history-table updates.
- Search decisions and return values, completed iteration scores, PVs, selected
  best moves, selective depths, and reference node counts.
- Persistent state across searches and `ucinewgame`, including root-move averages
  and TT generation behavior.

Start with `Threads=1`, `MultiPV=1`, orthodox chess, fresh-engine fixed-depth runs.
Then cover warm TT/history searches, new-game sequences, MultiPV, node limits,
and clock/ponder behavior. The Python UCI position parser currently hard-codes
`pos.set(fen, 0)` despite exposing `UCI_Chess960`; do not advertise broader
Chess960 compatibility than the reference actually implements.

Elapsed time and NPS are not equality targets. Different runtimes can reach
different nodes before a real-time deadline even with identical search logic.
Compare time-management formulas and stop checks with an injected clock, then
test actual deadlines and protocol responsiveness separately.

## What differs today

| Area | Naddu | Supplied Minifish Python |
| --- | --- | --- |
| Board and moves | 0x88 board, mutable piece-list order, flagged 32-bit moves | 64-square board, bitboards, 16-bit moves; castling targets the rook square internally |
| Stack | Board copy per ply; maximum ply 64 | Make/unmake state stack, seven sentinel frames, maximum ply 128, spare lookahead frames |
| Evaluation | PeSTO tapered evaluation, tempo, mop-up, material-draw shortcut | Embedded NNUE, material scaling, root optimism, rule-50 damping, correction history |
| Hashing/draws | Different PRNG and Zobrist tables, flat repetition history | Seeded 64-bit keys, pawn/material/non-pawn keys, filtered game-history keys, root key flip, cuckoo cycle detection |
| TT | Direct mapped, full key, always replace, configurable capacity | Three-entry clusters, 16-bit key tags, generation/depth/PV replacement; fixed logical capacity |
| Histories | Piece-to-square history and one killer | Main from-to, continuation, capture, pawn correction, non-pawn correction, countermoves, two killers |
| Move picker | One ranked list, selection sort | Staged captures/killers/countermove/quiets/bad captures, threat bonuses, partial insertion sort, dedicated evasion/QS/ProbCut stages |
| Quiescence | Captures, stand pat, losing-capture rejection | PV/non-PV distinctions, evasions, quiet checks, recapture restriction, depth-aware TT, correction/history/futility/SEE pruning |
| Main search | Basic PVS, RFP, null move, quiet futility and LMR | Additional razoring, verified null move, ProbCut, history/SEE/move-count pruning, singular extensions, dynamic LMR and re-search rules |
| Root loop | Previous-score aspiration and early mate stop | Persistent root averages, root optimism, stable root sorting, failure-dependent depth, MultiPV and dynamic time allocation |
| Node count | Counts search and QS calls | Counts `do_move()` calls; null moves do not increment it |

The main dependency chain is position/move semantics -> NNUE and keys -> TT and
histories -> move picker -> quiescence -> main search -> root driver. Merely
replacing `evaluate()` cannot make the tree identical.

## NNUE details

The weights already exist in `minifish-python/nnue_weights.py`; there is no
external `.nnue` file to fetch. The transformer contains 49,152 integers in
`[relative color][piece type][square][lane]` order: `2 x 6 x 64 x 64`. There are
64 transformer biases, 128 output weights, and an output bias of 2132. Measured
transformer weights range from -200 to 132.

Use an exact, deterministic export into embedded signed 16-bit data. The whole
network occupies 98,690 bytes when all weights and biases are packed as int16,
before transport encoding. Preserve explicit byte order in the decoder and
compare every exported integer against the Python source.

Each perspective has 64 accumulator lanes. The feature square transform is
`(pov * 56) ^ (7 if kingSquare & 4 else 0)`, and relative piece color is
`pov ^ (piece >> 3)`. Crossing the king's d/e-file boundary requires refreshing
that perspective; ordinary moves update the accumulator incrementally.
Captures, en passant, promotions, castling, null moves, and undo all need separate
fixtures.

The activation is squared clipped ReLU with QA=101, QB=160, scale=340. Preserve
the two distinct truncating divisions in network inference and all subsequent
material/optimism/rule-50 scaling. The raw network score is not the final search
evaluation or the UCI centipawn score. UCI scales internal values by `100/208`.

## Recommended implementation structure

Add a testable JavaScript core under `src/` with modules corresponding to the
Python files. Keep the existing Naddu engine operational while the new core is
being validated. Switch the public entry point after the complete reference
root search passes the parity suite.

Use 64-square indexing, Python's color/move encoding, and BigInt bitboards/keys
for the initial faithful implementation. Use ordinary Numbers for scores and
indices, and typed arrays where the reference specifies signed widths. A small
dependency-free build script can produce the single-file `naddu.js` artifact,
including the network, for Node/Bun and classic Web Workers. Do not require the
browser to fetch Python files, weights, or a runtime package.

BigInt provides exact masked 64-bit PRNG/magic multiplication and TT indexing.
Avoid converting full keys or products to Number, and apply unsigned masks at
the same points as Python. Implement truncation toward zero, floor division,
and signed 8/16-bit wrapping separately; JavaScript bitwise coercion is not a
general replacement for Python integer arithmetic. Verify Number intermediate
bounds before assigning values to typed arrays.

Keep Python's stack reuse and sentinel initialization semantics. Several search
fields intentionally survive `do_move()`/`do_null_move()`; clearing all child
state would change search. Preserve the meaning of negative array indices used
by the Python per-ply arrays at the root rather than relying on JS negative
property access.

First get parity with clear code. Optimize BigInt operations, allocations, or
representation only in later commits that retain the same search trace.

## Commit sequence and gates

Each numbered step is a separate implementation milestone. Split a milestone
into smaller commits when necessary; keep each commit runnable, document its
validation, and commit every change made for this task.

| Step | Intended commit | Work and required gate |
| --- | --- | --- |
| 0 | `docs: record Minifish parity investigation and port plan` | This investigation, measured baselines, source fingerprints, and acceptance criteria. No engine behavior changes. |
| 1 | `test: add deterministic Python reference and parity fixtures` | Add an oracle runner, source-manifest verification, fixture export, and Node comparison tools. Capture ordered moves, state, accumulators, evaluations, histories, TT operations, and normalized iteration output. Reference files remain unchanged. Repeated fresh runs must match. |
| 2 | `build: add a testable core and single-file engine bundle` | Add the module/build/test structure without switching the production engine. Require reproducible bundle output and smoke-test the Node and classic Worker paths. |
| 3 | `feat: port Minifish integer primitives and bitboards` | Constants, 16-bit moves, C-style division, masks, seeded PRNG, attacks, magic indexing, line/between tables. Match primitive fixtures and exhaustively compare sliding attacks over each square's relevant occupancy subsets. |
| 4 | `feat: port position state and ordered move generation` | Board/stack, FEN, make/unmake/null moves, keys, check/pin state, all generation modes, legality, SEE, root-history filtering and cycle detection. Match ordered lists and state after each transition; pass perft and special-move fixtures. Separate position and move-generation commits if needed. |
| 5 | `feat: embed Minifish weights and port NNUE evaluation` | Deterministic network export, inference, accumulator refresh/update/undo, material scaling, optimism input, rule-50 damping and clamps. Match every exported weight, both accumulator perspectives, and every evaluation layer. Separate data, inference, and incremental integration commits as useful. |
| 6 | `feat: port clustered transposition-table semantics` | Exactly 28,672 clusters / 86,016 entries, index calculation, 16-bit tags, generation updates, replacement, move retention, bound/depth/PV fields, eval caching and mate/rule-50 conversion. Match scripted probe/save/collision/aging traces. |
| 7 | `feat: port Minifish histories and continuation state` | Main, continuation, capture, correction, non-pawn correction, countermoves, two killers, sentinel rows and reset/persistence rules. Match positive/negative/saturating/wrapping updates and attached stack history rows. |
| 8 | `feat: port staged Minifish move picking` | Main, evasion, QS, and ProbCut stages; capture-history scoring, threat bonuses, continuation scoring, equal-score tie handling, partial insertion sorting and duplicate suppression. Match complete move-picker sequences with seeded tables, including `skipQuiets`. |
| 9 | `feat: port Minifish quiescence search` | PV/non-PV paths, check flags, stand pat, QS TT depth/bounds, draws/cycles, null-parent eval reuse, recaptures, quiet checks, futility, history and SEE filters. Match isolated QS return values and decision traces. |
| 10 | `feat: port Minifish main-search pruning` | Mate bounds, TT cutoffs and history effects, corrected static eval, improving/opponent worsening, razoring, RFP, verified null move, ProbCut and pre-extension move pruning. Compare controlled searches against equivalently gated Python fixtures; never label partial-search results as final parity. |
| 11 | `feat: port Minifish extensions and dynamic reductions` | Singular verification/excluded-move keys, double/triple/negative extensions, deep-check extensions, picker restoration, fixed-point LMR adjustments, dynamic re-search depth, PVS and post-search histories/TT/correction updates. Match instrumented branch traces that actually exercise each feature. |
| 12 | `feat: port iterative deepening and persistent root behavior` | Root-move records/averages, stable ordering, aspiration failures, optimism, root key flip, PV propagation and MultiPV. Fresh, warm, new-game and mixed-position fixed-depth results must match iteration by iteration. |
| 13 | `feat: integrate the Minifish core with Naddu UCI` | Make the validated core the default, port node/time limits and time allocation, and preserve useful Naddu commands/examples. Match UCI score conversion and deterministic control fixtures; smoke-test Node/Bun where available and browser Workers. Handle command reception during search explicitly for stop/ponder; a synchronous JS search blocks its receiver's callbacks. |
| 14 | `test: verify complete single-thread search parity` | Run the full Python benchmark position/command corpus, selected deeper tactical/extension cases, warm-state sequences, special moves and terminal/draw positions. Require exact deterministic results and decision digests, then record performance separately. Subsequent performance changes each receive their own verified commit. |

Until the public switch, new components are exercised through the parity
harness. Step 4 can expose an accumulator integration hook so NNUE is added in
step 5 without mixing evaluation work into move-generation validation.

## Differential validation strategy

Use the supplied Python engine directly as an oracle. Normalized records must
include internal scores and state, not just centipawns and best moves: UCI
rounding can hide numerical differences, and the same best move can come from
a different tree.

For isolated main-search milestones, use test-only equivalent feature gates in
the oracle runner; preserve the reference files and keep ungated golden runs as
the final acceptance target. Do not accidentally call a partially ported search
"identical" because it shares a few top moves.

Trace key events with deterministic serialization: node entry/window/depth,
TT probe, move-picker choice, prune reason, extension/reduction, recursive return,
history update, and TT save. Compare event digests on larger searches and emit
the first mismatch with full state on failure. Include counters proving that
singular verification, verified null move, ProbCut and each reduction path were
actually reached; shallow start-position tests alone cannot cover them.

Fixtures should cover castling on both sides, en passant and discovered checks,
all promotions/underpromotions, king mirror-boundary crossings, pins/double
checks, terminal roots, rule-50/checkmate interactions, repetition before/after
the root, null moves, collisions/aging, and repeated searches with and without
`ucinewgame`. Use seeded legal-move sequences to compare every intermediate
position and accumulator, and compare incremental NNUE with full refresh.

Keep cold-process tests separate from warm-engine tests. Repeatedly issuing
`ucinewgame` is not equivalent to recreating this reference engine.

## Measured baseline

For each search row below, the Python worker and its persistent state were
freshly initialized and the position was supplied through its UCI preparation
function. `go depth 5` used one search worker. Each Python case was repeated
twice and matched on internal score, normalized iterations, node count, PV and
bestmove/ponder. Naddu used a fresh Node process and `ucinewgame`.

| Position | Python raw NNUE | Python internal final score | Python UCI cp | Python nodes | Python bestmove | Naddu UCI cp | Naddu nodes | Naddu bestmove |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Start position | 54 | 126 | 60 | 431 | `g2g3` | 23 | 1,347 | `g1f3` |
| Kiwipete | 36 | 66 | 31 | 742 | `e2a6` | 8 | 8,670 | `d5e6` |
| Rook endgame | 160 | 492 | 236 | 230 | `b4f4` | 102 | 596 | `b4f4` |
| Opening after `e2e4 e7e5 g1f3 b8c6 f1b5 a7a6` | 3 | 204 | 98 | 215 | `b5c6` | 74 | 938 | `b5c6` |

Kiwipete FEN:
`r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 10`.

Rook endgame FEN:
`8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 11`.

Both engines passed these perft checks during the investigation:

| Position | Depth | Nodes |
| --- | ---: | ---: |
| Start position | 4 | 197,281 |
| Kiwipete | 3 | 97,862 |
| Rook endgame | 3 | 2,812 |

The Python NNUE also passed 398 perspective refresh comparisons in a seeded
200-step legal-move sequence (`random.Random(1070372)`); one step restarted a
terminal position. Make/unmake restored FEN and accumulators, and null moves
preserved/restored accumulator state. This is a useful initial check, not
exhaustive special-move coverage.

## Reference quirks to preserve and test

1. **False mate bound from unchecked quiescence.** Start-position depth-3 output
   reproducibly reports `score mate 1`, PV `e2e4`, nodes 103. In
   `search.py`, the depth-decrement fallback explicitly calls
   `qsearch_node(..., PV, True)` even for unchecked positions. Runtime tracing
   confirmed unchecked calls with `InCheck=True` returning -31999/-31998.
   Reproducing the current reference requires matching this behavior. Correcting
   it would require a separate change to the reference and new golden results.
2. **Fixed TT size.** `tt_allocate()` ignores its MB argument and allocates
   `896 * 1024 // 32 = 28672` clusters. A different capacity changes collisions
   and therefore the tree. Match this first, then make any capacity enhancement
   explicit.
3. **Persistent root averages.** `RootMove.reset_for_search()` deliberately keeps
   `averageScore`. `search_clear()` clears histories and TT but does not recreate
   root records. A start-position depth-5 sequence produced 431 nodes / score 126
   on the first search, 286 / 119 on the second, then 395 / 8 after a clear before
   the third search, with bestmove changing to `d2d3`. New-game fixtures must
   preserve these lifecycle differences.
4. **Incremental state is not always reconstructible from FEN.** After `g1f3`,
   the reference's incremental `nonPawnKey` differs from that obtained by setting
   the resulting FEN. The two XOR sites in `do_move()` cancel for a quiet
   non-king non-pawn move. FEN construction also unconditionally adds an
   en-passant-file key via `zob.enpassant[file_of(st.epSquare)]`, including the
   no-EP sentinel. Port the actual transition rules and compare them directly;
   do not silently replace them with recomputed "clean" keys.
5. **Draw and count semantics.** Main-search draws can return +/-1 based on the
   move counter's parity; QS draw paths can return zero. Python has no equivalent
   of Naddu's `materialDraw()` shortcut in its search/evaluation. Calls made for
   ponder extraction also use `do_move()` and can affect subsequent counter
   inspection. Fixtures must record when a node count was sampled.

These observations identify the behavior being ported. They do not establish
the Python engine's playing strength or the correctness of every chess case.

## Source fingerprints

The supplied `minifish-python/` folder was untracked at the start. This
investigation did not edit or stage it. Verify these SHA-256 values before
generating golden fixtures; a changed reference requires an explicit baseline
update.

| File | SHA-256 |
| --- | --- |
| `__main__.py` | `b5df896561a27466d5c8ca2db2fe482f52cc218cec10074e411fae735d135ecd` |
| `benchmark.py` | `2f9e38257626b63a2bd4b76e019a4bcc34779a26f29075d7e43379abc272076f` |
| `bitboard.py` | `c14e01676d0a8e3428246680bb97a6e4735d3d35f82da36d3aafb76936bfc90d` |
| `constants.py` | `5a9b2c9f0f42c5e6e9eec0e90a334a5c4365e2da7be134371ea8928e9aa5dc84` |
| `evaluate.py` | `67569b409478d7a649b328c459238cce2b7f1044aa2bbf691a30343520128acf` |
| `history.py` | `81ca8b8b1a26b8f1e9fa876f758f5ed1e797271862a8d90a6b585f89a5bd4af8` |
| `movegen.py` | `f4bfa2c9a3f11c091bba510fa8ebef8d92077580aa33e1ebcdbdc9c065d8e2c7` |
| `movepick.py` | `13245dd8c5b2437102b19fd2509438faa8ccd5822597af4d96ea449d25e2c0f4` |
| `nnue.py` | `c877e54582b39b908d3ffd5205c3b6d0e8f4e682b5320c2112631265965e3f98` |
| `nnue_weights.py` | `70737e71dd3f63e9577791dbc334a0e822862ff30e44dc148aa6eb78fbca041a` |
| `position.py` | `78239b9b8df8674118df321379d0cc191c7d3f418b347a0e6d603ab927f08734` |
| `search.py` | `869b79f147cca5f4b07a069e403ba7398c5e3abde50075abd536a740b2642fa0` |
| `timeman.py` | `3e97e9a513d463d99202b779a8972faa0ffc4e1e1b544afa81f841391514a410` |
| `tt.py` | `079c8dac5a20297b7a7ffa0cc97839abc97e8459408cab45ff083bbf6860496b` |
| `uci.py` | `cba98d236ae67e414503317dbd8588e09aba7d60848fda28990c9f9b5bcc4737` |

## Work completed in this investigation

Read and compared both engines' position, move generation, SEE, NNUE,
evaluation, histories, TT, move picker, search, root driver, time management,
benchmark and UCI code. Ran the baseline searches, repetition checks, perft,
accumulator checks and targeted reference tracing described above. Added this
plan only; no implementation stage beyond step 0 has been completed.
