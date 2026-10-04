# MultiPV and SMP validation

Implemented and validated on 2026-10-04 against the unchanged, pinned
`minifish-python` source. Naddu retains its name, configurable Hash and requested
50-move time horizon. Threads and MultiPV both default to one.

## Implementation

- MultiPV retains the exact reference aspiration windows, stable root ordering,
  earlier-PV exclusion, optimism, root-average persistence, per-line reporting
  and best-line time management. Requested lines are clamped to legal root moves.
- Threads supports 1–16 persistent search workers in Node and isolated browser
  Workers. Helpers run the reference's complete iterative-deepening search.
  Root moves are not divided between workers and helper depths are not staggered.
- Workers share one TT and one packed continuation-history table. Other
  histories, stacks, boards, NNUE accumulators and root averages remain private.
  Coherent TT snapshots and 1,024 striped writer locks preserve entry semantics.
- Shared controls propagate stop, ponderhit, depth-growth and ponder-stop flags.
  Every counted move is published to an atomic per-worker counter. Global node
  limits and UCI node counts sum all workers.
- Only worker zero obeys a requested fixed depth and manages the soft clock
  budget. Helpers stop and unwind before final-worker selection and bestmove.
- The exact Python completed-depth vote and helper-only mate guard apply to
  non-fixed-depth, single-PV searches. Fixed-depth and MultiPV keep the main result.
- Browser helpers are created by the responsive receiver. This allows their
  startup event loops to run while the compute worker waits for shared readiness.
- External stop requests use a separate shared slot from internal helper stops.
  An early stop/quit cannot be erased when a search starts, and benchmark roots
  can reset their internal stop state without erasing external cancellation.

## Verification

- All 55 automated tests pass, including the original NNUE, history, search
  trace, UCI and benchmark checks.
- Exact one-thread MultiPV comparison covers 5 and 256 requested lines, warm
  searches, option changes, few legal moves, terminal roots and public UCI output.
- All 72 synthetic final-worker selections match the live Python oracle,
  including completed-depth votes, ties, invalid/incomplete candidates, fixed
  depth, MultiPV and the helper-only mate guard.
- Both local and shared TT storage match Python's scripted save/probe/aging/
  replacement fixtures. Concurrent real worker writes produce coherent snapshots.
- Real 2/4-thread tests verify persistent identities, shared counters and TT,
  repeated roots, repetition history, pool growth/shrink, MultiPV, node/time
  limits, ponderhit, infinite readiness, stop, deferred Hash/Threads changes,
  new games, terminal roots, helper errors and clean process exit.
- An immediate CLI stop/quit and an unbounded CLI search ending at EOF both
  complete without losing cancellation during compute-worker startup.
- A live 16-thread node-limited search completed successfully through `naddu.js`.
- The supplied Python public benchmark completed all 47 positions at depth 5
  with both 2 and 4 threads. Its observed move totals were 44,720 and 97,816;
  SMP totals depend on scheduling and are not equality targets.
- Real Chromium validates ordinary-page capability reporting and isolated
  4-thread SMP, MultiPV, global node limits, movetime, infinite readiness, stop,
  ponderhit, resizing, new games, restoration to one thread and early stop
  during compute-worker startup.
- The complete one-thread core and public depth-13 benchmark retain exact
  equality across all 47 positions and all 2,526,355 counted moves in reference
  TT mode. The supplied Python manifest remains unchanged.

Parallel scheduling makes SMP output nondeterministic across runtimes. Exact
checks cover the deterministic storage, selection and one-thread search rules;
live SMP checks cover behavior and lifecycle rather than identical move totals.

## Reproduction

```
npm run build
npm test
npm run parity:captured
npm run test:browser
node naddu.js "bench 1 2 5"
node naddu.js "setoption name Threads value 4" "setoption name MultiPV value 3" "position startpos" "go depth 8"
```

Keep the supplied Python source to regenerate `multipv` and `selection` fixtures
with `scripts/reference.py`. The harness never modifies that source. Node uses
[worker threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html).
Browser SMP requires the [shared-memory isolation conditions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
and uses blocking Atomics only inside compute/helper Workers.

The staged implementation is recorded in [the plan](multipv-smp-plan.md):
`b920e9c` adds MultiPV fixtures and exact voting, `80bfc8f` adds shared storage,
and `dc8f7a4` adds the persistent SMP runtime and UCI integration. Follow-up
validation includes browser coverage and the early-cancellation regression.
