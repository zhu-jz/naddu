# MultiPV and Python-style SMP

The supplied `minifish-python` source remains the read-only reference. Keep
Naddu's name, configurable Hash and requested 50-move time horizon. Commit each
implementation step and sync the finished work to the configured remote.

1. Expand exact one-thread MultiPV fixtures beyond the existing three-PV tests:
   warm searches, option changes, 256 requested PVs, few legal moves and terminal
   roots. Port and test Python's completed-depth final-worker selection rules.
2. Add shared packed TT storage with striped writer locks and coherent entry
   snapshots, plus shared continuation-history backing. Preserve the current
   one-thread fast path and prove both storage modes have the same TT semantics.
3. Add persistent helper workers for Node and cross-origin-isolated browser
   Workers. Helpers run the reference's full iterative-deepening search, share
   global stop/ponder/depth-growth flags, publish move counters and results,
   and retain their private histories and root averages across searches.
4. Wire Threads=1..16, MultiPV, deferred settings, benchmarks, stop/ponderhit,
   worker errors and shutdown through the UCI transport. Ordinary browser pages
   without shared-memory support expose one thread and report the limitation.
5. Validate real 2/4-thread searches, MultiPV, node/time limits, new games,
   resizing, readiness during search, replacement, failure and shutdown. Run
   real browser checks and repeat the complete one-thread reference benchmark.

The Python algorithm does not diversify helper depths or divide root moves.
Only worker zero obeys a requested fixed depth and manages the soft clock budget;
all workers contribute to the move counter. Helpers are joined before bestmove
selection. MultiPV and fixed-depth searches always report the main worker's
result. For other searches, use the exact reference vote and mate guard.

Parallel thread scheduling is not deterministic across Python and JavaScript.
Compare deterministic selection/storage fixtures exactly, retain exact
one-thread parity, and validate live SMP behavior and lifecycle independently.
