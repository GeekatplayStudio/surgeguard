# Changelog — dashboard / tavern demo

This log exists because the tavern demo (`src/game/`) grew fast, through many
rounds of visual and behavioral requests, and it is easy for a change that
fixes one thing to silently break another (a sign gets nudged and its click
region goes stale; a helper gets refactored and a dead export gets left
behind). Each entry below records what changed, _why_, and — where the change
was a bug fix — how it was verified and what regression test now guards it.

## 2026-08-30 — Test infrastructure, independent review pass, and four real bugs

### The incident this entry exists to explain

A user report — "click on the boxes for info stop working" — could not be
reproduced from a fresh page load; clicking a sign opened its popup fine. The
most likely explanation: `SIGN_REGIONS`/`PERSON_REGIONS` were, at the time,
**module-level mutable arrays** in `engine.ts`, written by `drawScene()` and
read by the click handler in `TavernGame.tsx` via a plain import. Under Vite's
dev-server hot-module-reload — which was firing constantly during the session,
since `engine.ts` was being edited live — a new module instance can replace
the old one while a component's closures still reference exports from the
stale instance. A click handler holding a stale `SIGN_REGIONS` reference would
read an empty or outdated array and silently do nothing. This is a real,
known class of Vite HMR bug, not confirmed with a captured stack trace, but
structurally eliminated rather than patched around:

**Fix:** `signRegions`/`personRegions` moved off module state and onto the
`Sim` object itself (`engine.ts`), rebuilt every frame inside `drawScene()`.
The click handler reads them through `simRef.current` — the same live sim
object the render loop owns — so there is no module-level array left to go
stale. `signAt()`/`personAt()` are now pure functions over `(sim, x, y)`
rather than closures over module state.

**Verified by:**

- `TavernGame.test.ts` — _"every clickable sign and person resolves to a hit
  region after a frame renders"_: all 9 station signs and every cashier/worker
  are independently confirmed clickable from a fresh sim.
- `TavernGame.test.ts` — _"regions belong to the sim, not module state - two
  sims never cross-contaminate hit-testing"_: two independent `Sim` instances
  are stepped and drawn, and hit-testing one at the other's coordinates is
  confirmed to find nothing — the exact failure mode module-level arrays would
  produce.
- A new Playwright E2E suite (`e2e/tavern.spec.ts`) drives a real browser
  against the real dev server and clicks every sign for real, which unit
  tests running against a stubbed canvas context cannot honestly do.

### A second, smaller version of the same class of bug — found writing the E2E suite

The first draft of the E2E popup test hardcoded canvas-space click coordinates
as percentages (`{ xPct: 0.175, yPct: 0.24 }` for the idempotency sign). It
passed until an earlier, unrelated request ("move the idempotency sign
slightly up") shifted that sign's real position — at which point the
hardcoded percentage silently stopped matching the sign's actual click region,
and the test started failing. **This is exactly the bug class described
above, just caught by a test this time instead of a user.**

**Fix:** rewrote the test to read each sign's _actual_ region from
`window.__surgeguardDebug.sim.signRegions` (ground truth — the same data the
real click handler uses) and click its true center, rather than a
hand-maintained coordinate guess. Repositioning a sign in `engine.ts` can now
never desync this test again.

### `window.__surgeguardDebug` was an unconditional, mutable, production-shipped global

Added earlier to give the E2E suite a way to assert on simulation state
(canvas pixels aren't inspectable), it was wired unconditionally in
`TavernGame.tsx` and shipped in every production build, with a comment
claiming it was "read-only" when it was in fact the live `Sim` object mutated
60 times a second by `step()`/`drawScene()` — a real control surface, not a
debug read.

**Fix:** gated behind `import.meta.env.DEV` (true under Playwright's
dev-server-backed test run, false under `vite build`). Confirmed absent from
the production bundle: `grep -c "__surgeguardDebug" dist/assets/*.js` returns
0 after a production build, vs. present and functional under `npm run dev` /
the Playwright suite.

### The dashboard kept polling the real API once a second while hidden behind the tavern view

`App.tsx`'s `useEffect` starting the `/metrics` + `/purchase_requests` polling
interval had no dependency on which view (`dashboard` vs. `tavern`) was
showing, and the dashboard section is kept mounted (just CSS-`hidden`) so its
form inputs survive switching views. Net effect: opening the tavern demo and
leaving it open generated continuous real backend traffic for a view nobody
was looking at — mildly ironic for a system whose whole premise is being
resilient to unnecessary load.

**Fix:** the effect now checks `view !== "dashboard"` and skips scheduling
entirely (dependency array gained `view`), so polling starts/stops with
visibility rather than running for the component's entire lifetime.

### The reconciler robot cleared only one stuck box per sweep, even when several were stuck at once

`ReconcileStuckPurchasesJob`'s in-game counterpart used `sim.boxes.find(...)`
— singular — to locate a stuck box on each 10-second sweep, then went idle
after carrying that one box back to the stack. The random "stuck" roll fires
on _every_ box entering the machine regardless of the flaky-provider toggle
(only the separate retry-failure roll is gated by that), so over a long enough
run, two or more machine slots can genuinely be stuck at the same time — and
the second one onward would sit frozen for a full extra 10-second wait per
box, with `sim.stats.processing` still reporting "5/5 busy" the whole time,
looking healthy while throughput had actually stalled.

**Fix:** after dropping off a stuck box, the robot now checks whether any
other machine slot is still stuck and, if so, goes straight back for it
instead of going idle — clearing every currently-stuck box in one continuous
sweep.

**Verified by:** a new test, _"the reconciler clears every stuck box in one
sweep, not just one"_ — forces every occupied machine slot stuck at once
(deterministic, not relying on the random roll), then confirms
`sim.stats.reconciled` climbs by at least that many within one sweep window,
and that none of the originally-forced boxes are still stuck afterward.

### The boss's mood read last frame's backlog, not this frame's

`sim.bossMood` was set from `sim.stats.queued` at the point the boss spawns —
but `sim.stats.queued` isn't recomputed until the very end of the _same_
`step()` call, so the mood decision always used the previous frame's value.
Low severity (one frame of lag, self-corrects on the boss's next appearance)
but a genuine read-before-write ordering bug.

**Fix:** extracted `backlogDepth(sim)`, called both by the boss's mood check
and by the end-of-frame `sim.stats.queued` assignment, so there is exactly one
place backlog depth is computed and the boss always reads the current value.
This also removed a duplicated formula (see below).

### A pre-existing 1-in-many-runs test flake, found while re-verifying the reconciler fix

Running the full local verification pass one extra time (after the reconciler
and boss-mood fixes above) turned up a real, if rare, flake in an unrelated
pre-existing test: _"the pipeline flows end to end and drawing never
throws"_'s post-thread-cut assertion allowed only a 5-second grace window for
`sim.stats.processing` to drain down to the new (lower) thread count. That
window is correct for a box draining via its normal ~1.3-2.1s process timer,
but a box that also happens to roll `STUCK_CHANCE` (2%, unconditional, same
mechanism the reconciler fix above is about) doesn't drain on a timer at all
— it sits frozen until the reconciler's ~10-second sweep personally clears
it, which can exceed a 5-second grace window. Not a regression from the
reconciler fix (if anything, that fix clears stuck boxes _faster_ than
before); a latent gap in the test's timing assumptions that a ~2% roll
happened to hit on one run out of the many this file has been run across
this session.

**Fix:** widened the grace window from 5s to ~16.7s (one full
`RECONCILE_EVERY` cycle plus travel time) so it covers the stuck-and-cleared
case, not just normal completion. Verified by running the test 12 times in a
row after the fix (previously reproducible as a failure; 12/12 clean after).

### Dead code and duplicated bounds removed

- **`debugHandles` export** (`engine.ts`) — an unused, second debug-handle
  mechanism left behind after `window.__surgeguardDebug` replaced it as the
  actual mechanism everything reads. Nothing imported it; deleted rather than
  wired up, since the window-global path already covers the need and is
  gated to dev builds.
- **Thread-count and door-cap bounds** were hardcoded independently in two
  places: `step()`'s clamp in `engine.ts`, and the +/- button handlers'
  `Math.max`/`Math.min` calls and `disabled` checks in `TavernGame.tsx`. A
  future range change (e.g. raising max threads) would have needed editing
  both, silently drifting if one was missed. Extracted `THREAD_BOUNDS` and
  `DOOR_CAP_BOUNDS` in `engine.ts`, exported and reused by both files.

### Test-infrastructure fixes: two tools were picking up files that weren't theirs

- **Vitest** was running Playwright's `e2e/tavern.spec.ts` (different `test`/
  `expect` API — guaranteed to fail) whenever it matched Vitest's default
  glob, and would also pick up any leftover Stryker mutation-testing sandbox
  under `.stryker-tmp/` (a full project mirror per worker, test files
  included) if one existed. Fixed with an explicit `test.exclude` in
  `vite.config.ts`.
- **ESLint** had the same problem via its own default glob, with the added
  failure mode that a Stryker sandbox carries its own `tsconfig`, which
  collides with the real one ("multiple candidate TSConfigRootDirs"). Fixed
  with `globalIgnores([".stryker-tmp", "reports"])` in `eslint.config.js`.

### New: end-to-end tests (Playwright)

`e2e/tavern.spec.ts`, 5 tests against a real Chromium instance and the real
dev server: every station sign's popup opens with the right content; the
rate-limit sign renders at the same size as its neighbours (a regression guard
for a real earlier bug where it rendered visibly smaller); clicking a cashier
sends them to lunch and closes their till; clicking the "Vladimir Chopine"
credit line summons him; switching between the dashboard and tavern views
preserves the dashboard's form inputs.

Playwright needs system libraries (`libnspr4`, `libnss3`, etc.) that this WSL
distribution doesn't have installed and `sudo` isn't available non-interactively
for; run locally with those libraries on `LD_LIBRARY_PATH`, or rely on CI
(`npx playwright install --with-deps chromium`, which has root).

### New: mutation testing (Stryker), scoped to the simulation logic

`stryker.config.json` mutates only `src/game/engine.ts`, and even within that
file excludes the ~1450-line pixel-rendering section (sprite maps, colors,
shape offsets) via inline `// Stryker disable all` / `// Stryker restore all`
markers — no unit test asserts on a fill color or a decorative rectangle's
position, so mutating that code only produces noise, not signal. `drawSign()`
and `drawScene()` stay mutated, since they compute the click hit-regions and
draw layering that real bugs above were about.

Running Stryker in this WSL environment surfaced its own hazard worth noting:
**Stryker cannot share a `.stryker-tmp/` working directory with a concurrent
Stryker run** — two invocations racing in the same directory corrupted one
run's coverage data badly enough to report a 0.16% mutation score against a
codebase that, run cleanly and alone, scores far higher. If mutation score
numbers ever look implausible, check for a second `stryker run` process before
trusting the number.

**Result on this codebase:** a clean, solitary run (2273 mutants, 26m35s)
scored **34.05%** (727 killed, 47 timed out, 1438 survived, 61 no-coverage;
`reports/mutation/index.html` for the full breakdown). Reported honestly
rather than tuned away: this is a real, unglamorous number, not a corrupted
one. Breaking it down by where survivors land in the file explains it without
excusing it —

- Only 41 of 1438 survivors (under 3%) are in the flavor-text message pools
  (`CASHIER_MSGS`, `BOSS_HAPPY_MSGS`, etc.) — the one place a surviving
  mutant is _expected_, since no test should assert on the exact wording of
  a random chatter line. This was checked, not assumed: it would have been
  the easy, comfortable explanation for a low score, and it is not the real
  one.
- ~850 survivors sit inside `step()`'s own state-machine logic — the bulk of
  the score, and the honest signal: a ~1000-line hand-authored simulation
  covered by 10 tests asserting high-level invariants (thread caps, work
  conservation, sweep completeness) has plenty of individual branches,
  per-frame timers, and numeric offsets that those invariants don't happen
  to pin down.
- ~440 survivors are inside `drawScene()`, which is deliberately still
  mutated (see above) but whose only test coverage checks that click regions
  _exist_ and _hit-test back to the right key_ — not that they sit at an
  exact expected coordinate. A mutant that nudges a sign's x/y by a few
  pixels usually still hit-tests correctly at its own (now slightly wrong)
  center, so it survives without indicating a real correctness gap the way
  a step()-logic survivor would.

`stryker.config.json`'s thresholds were set from this measured baseline
(`break: 30`, a few points below 34.05 for run-to-run timeout noise; `low`/
`high` at 40/60 as near-term ratchet targets) rather than left at a number
that would fail on every run regardless of code quality — which is what the
review pass below caught the original `break: 55` threshold would have done.

### CI

- `dashboard` job: added an "Install Playwright browsers" + "Run end-to-end
  tests" step after the existing Vitest step, with the HTML report uploaded
  as an artifact on failure.
- New `mutation` job: runs after `dashboard` succeeds (mutation testing's
  purpose is catching weak _tests_, not broken code, so it doesn't block the
  fast gates), uploads the HTML mutation report as an artifact.

### How this pass was reviewed

Rather than trusting my own read of the diff, a set of independent review
passes ran over the changed and pre-existing code, each looking through a
different lens, with no visibility into each other's findings:

- **Line-by-line correctness** — found the reconciler single-box bug and the
  boss mood staleness bug above, by tracing `step()`'s control flow against
  what the code claims to do.
- **Reuse / duplication** — found the `THREAD_BOUNDS`/`DOOR_CAP_BOUNDS` split
  and several smaller repeated formulas (see _Identified but not fixed_
  below).
- **Cross-file tracing of every exported symbol** — found `debugHandles` was
  dead, independently, three separate times across different review angles.
- **Removed-behavior audit** (diffing old vs. new `App.tsx` field-by-field) —
  confirmed the dashboard-view refactor dropped no existing form field, table
  column, or handler.
- **Altitude / integration-design review** — found the unconditional
  production debug-global and the polling-while-hidden bug, both independently
  reproduced by a second, separate efficiency-focused pass as well.
- **Efficiency scan of the hot loop** — found real O(n²)-shaped patterns (see
  below); triaged as acceptable at this demo's scale rather than fixed now.

Every finding reported above as fixed was independently reproduced or directly
verified (by running the actual code, not just reading it) before being acted
on. Two review-run collisions happened along the way — the mutation-testing
collision noted above, and this same concurrent-execution pattern briefly
made ESLint/Vitest report false failures from a leftover `.stryker-tmp`
sandbox — both diagnosed and fixed at the tooling-config level rather than
worked around.

### Identified but not fixed in this pass

Recorded here rather than silently dropped, so they don't need rediscovering:

- **The "Press Start 2P" Google Font loads unconditionally on every page
  view** (`index.html`), including the default dashboard route where it is
  never rendered — only the tavern view (`game.css`) uses it. Two avoidable
  cross-origin requests on the common case. Low severity, and a real fix
  (load the stylesheet dynamically only when the tavern view is opened)
  is more machinery than the severity currently justifies.
- **`step()`'s hot loop has several O(n²)-shaped patterns**: per-customer
  queue-position recomputation rescans the full customer list; the belt's
  "box ahead of me" check filters+maps the full box array per belt box
  instead of a pre-filtered belt-only list; `beltCount` is recomputed
  separately for each of the 2 loaders instead of once per frame; the
  backlog (`sim.boxes`) has no upper bound, so per-frame scan cost grows
  for as long as a single play session runs a heavy backlog. Real, but the
  demo's `crowdCap` tops out at 60 and sessions are short, so this is
  acceptable at current scale — flagged here for if that scale assumption
  ever changes.
- **`sim.stackCount` is a manually-maintained counter** duplicating what
  `sim.boxes.filter(b => b.state === "stacked").length` would compute —
  currently kept in lockstep correctly by `stackPut`/`stackTake`, but every
  future code path that adds/removes a stacked box must remember to touch it
  too, with no type error if it doesn't.
- **Five near-identical worker object literals** in `newSim()` — a
  `makeWorker(x, y, role)` factory would remove the copy-paste.
  **A `claim?: Box` cast repeated 6 times** on `Worker` instead of a real
  field.
- **The same toss/hop tween formula** (lerp + `-sin(k·π)·amplitude`) is
  hand-copied at 4 box-transition sites with only the duration/amplitude
  differing — a shared `hopArc()` helper would remove the risk of the four
  copies drifting.
- **Long flat `if`/`else if` chains** keyed on customer/box `state` in
  `step()` (5-way and 9-way) — each branch is self-contained, so a
  dispatch-table or per-state function extraction would make each state's
  logic independently readable without behavior change.

None of these are correctness bugs today; they're maintainability debt,
recorded so a future change to this file starts from an accurate picture
of it rather than rediscovering the same tradeoffs.
