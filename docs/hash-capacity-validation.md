# Configurable TT validation

Validated on 2026-10-04 with Node 24.11.0. Naddu's `Hash` option now allocates
the requested logical capacity in MiB, from 1 to 256. The default is 1 MiB
(32,768 clusters / 98,304 entries). Each cluster retains three entries and the
original lookup, replacement, aging and packed-field rules.

`ReferenceTT=true` restores the supplied Python reference's fixed 896 KiB
capacity (28,672 clusters / 86,016 entries), regardless of `Hash`. This option
defaults to false. The parity tools enable it explicitly. JavaScript array and
`BigInt` overhead means actual process memory exceeds the logical capacity.

## Verification

- All 42 tests passed, including collision retention at different capacities,
  non-power-of-two capacity, indexing at the last cluster, resizing, clearing,
  invalid sizes, UCI settings and resizing after an active search.
- A focused follow-up check simulated an allocation failure in the released
  Worker. It retained the old table and settings and completed the next search.
- The complete core and released depth-13 benchmark matched all 47 captured
  Python positions with `ReferenceTT=true`, including every normalized iteration
  and all 2,526,355 counted moves.
- Real Chromium direct and cross-origin-isolated nested Workers passed Hash
  resizing, reference-capacity restoration, reference search parity and their
  existing lifecycle checks.
- The supplied Python source remains unchanged and matches its pinned manifest.

## Capacity measurements

Each row is one sequential run of the public 47-position benchmark at depth 13,
with `ReferenceTT=false`. These are local timing samples, not playing-strength
measurements. A larger table changes collisions and the search tree; this
benchmark does not show a consistent speed improvement as capacity increases.

| Hash (MiB logical) | Entries | Counted moves | Time (ms) | Moves/second |
| --- | ---: | ---: | ---: | ---: |
| 1 | 98,304 | 2,259,644 | 19,178 | 117,824 |
| 16 | 1,572,864 | 2,279,538 | 19,793 | 115,168 |
| 64 | 6,291,456 | 2,241,073 | 18,605 | 120,455 |

## Reproduction

```
npm run build
npm test
npm run parity:captured
npm run test:browser
node naddu.js "bench 1 1 13"
node naddu.js "bench 16 1 13"
node naddu.js "bench 64 1 13"
```

The browser check needs an installed Chromium browser. The parity commands
compare normalized scores, bounds, depths, selective depths, move counts, PVs,
bestmoves and ponder moves; elapsed time and NPS depend on the runtime.
