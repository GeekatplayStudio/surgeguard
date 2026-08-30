import { expect, test } from "vitest";
import {
  drawScene,
  newSim,
  personAt,
  signAt,
  step,
  summonVlad,
  togglePerson,
} from "./engine";

function stubCtx(): CanvasRenderingContext2D {
  const target = {
    font: "",
    fillStyle: "",
    globalAlpha: 1,
    fillRect: () => {},
    fillText: () => {},
    measureText: (t: string) => ({ width: t.length * 8 }),
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop as keyof typeof obj];
      return () => {};
    },
    set(obj, prop, value) {
      (obj as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

test(
  "the pipeline flows end to end and drawing never throws",
  { timeout: 30000 },
  () => {
    const ctx = stubCtx();
    const sim = newSim();
    let bossSeen = false;
    // 60 simulated seconds covering rush, flaky provider, and a thread cut
    for (let i = 0; i < 60 * 60; i++) {
      const rush = i > 600;
      const flaky = i > 1800;
      const threads = i > 2400 ? 2 : 5;
      step(sim, 1 / 60, rush, flaky, threads);
      drawScene(ctx, sim, rush, flaky);
      if (sim.boss.on) bossSeen = true;
      // In-flight boxes drain via their normal ~1.3-2.1s process timer after
      // a thread cut - except a box that also rolled STUCK_CHANCE (2%,
      // unconditional, independent of `flaky`) doesn't drain on a timer at
      // all; it sits frozen until the reconciler's ~10s sweep personally
      // clears it. So the grace window has to cover that worst case
      // (one full RECONCILE_EVERY cycle plus travel time), not just normal
      // completion, or this flakes on the rare run where the 2% roll lands
      // right at the cutback boundary.
      if (i < 2400 || i > 3400) {
        expect(sim.stats.processing).toBeLessThanOrEqual(threads);
      }
    }
    expect(sim.stats.processed).toBeGreaterThan(5);
    expect(sim.stats.accepted).toBeGreaterThan(20);
    expect(bossSeen).toBe(true);
    // departed customers must be freed, not parked off-screen forever
    expect(sim.customers.length).toBeLessThan(60);
    expect(
      sim.customers.filter((c) => c.state === "leave" && c.x >= 900).length,
    ).toBeLessThan(10);
    // accepted work is conserved: everything is queued, in flight, or done
    // (a few boxes may be mid-hop between stations on the final frame)
    const accounted =
      sim.stats.queued + sim.stats.processing + sim.stats.processed;
    expect(Math.abs(accounted - sim.stats.accepted)).toBeLessThanOrEqual(4);
  },
);

test(
  "lunch breaks close tills and a low door cap trips the 429 bouncer",
  { timeout: 30000 },
  () => {
    const ctx = stubCtx();
    const sim = newSim();
    // close four of the five tills and send both runners to lunch
    for (let i = 0; i < 4; i++) togglePerson(sim, "cashier", i);
    togglePerson(sim, "worker", 0);
    for (let i = 0; i < 30 * 60; i++) {
      step(sim, 1 / 60, true, false, 5, 8); // rush against a tiny door cap
      drawScene(ctx, sim, true, false);
    }
    expect(sim.stats.limited).toBeGreaterThan(5);
    // nobody should be queued at a closed till
    for (const c of sim.customers) {
      if (c.state === "queue") expect(sim.cashierLunch[c.lane]).toBe(false);
    }
    expect(sim.crowdCap).toBe(8);
  },
);

test(
  "the reconciler clears every stuck box in one sweep, not just one",
  { timeout: 30000 },
  () => {
    // Regression test for a real bug: the robot used to grab a single
    // random(b.stuck) box per 10s sweep and go idle, so if 2+ machine
    // slots were stuck at once (the stuck roll fires on every box
    // regardless of the flaky-provider toggle, so this can happen even
    // in the calm default mode) only one was ever freed per sweep and
    // the rest sat frozen indefinitely - "processing: 5/5" would look
    // busy while throughput had actually stalled.
    const sim = newSim();
    // holiday mode warm-up so several boxes reach the machine quickly
    for (let i = 0; i < 12 * 60; i++) step(sim, 1 / 60, true, false, 5, 60);

    const machineBoxes = sim.boxes.filter((b) => b.state === "machine");
    expect(machineBoxes.length).toBeGreaterThanOrEqual(2);
    // force every occupied slot stuck at once, deterministically
    for (const box of machineBoxes) box.stuck = true;
    const forcedIds = new Set(machineBoxes.map((b) => b.id));
    const stuckCount = machineBoxes.length;
    const reconciledBefore = sim.stats.reconciled;

    // Up to ~10s to wait for the next scheduled sweep, plus a full
    // walk-there/drop-off/walk-back round trip (~2.5-3s) per stuck box the
    // robot has to work through in that one sweep. Holiday mode stays on,
    // so new boxes keep entering the machine and can organically roll
    // stuck again in this window - the final assertion only tracks the
    // originally-forced set, not "zero stuck boxes system-wide".
    for (let i = 0; i < 40 * 60; i++) step(sim, 1 / 60, true, false, 5, 60);

    expect(sim.stats.reconciled - reconciledBefore).toBeGreaterThanOrEqual(
      stuckCount,
    );
    const stillStuck = sim.boxes.filter(
      (b) => forcedIds.has(b.id) && b.state === "machine" && b.stuck,
    );
    expect(stillStuck).toHaveLength(0);
  },
);

test("the boss jumps for joy, gets angry under load, and the shredder sprays", () => {
  const sim = newSim();
  let jumpFrames = 0;
  let happySeen = false;
  let angrySeen = false;
  let maxParticles = 0;
  for (let i = 0; i < 180 * 60; i++) {
    // calm first, then a heavy rush on a single thread to pile up the backlog
    step(sim, 1 / 60, i > 5400, false, i > 5400 ? 1 : 5, 60);
    if (sim.boss.on) {
      if (sim.bossMood === "happy") {
        happySeen = true;
        if (sim.bossDance > 0) jumpFrames++;
      } else {
        angrySeen = true;
      }
    }
    maxParticles = Math.max(maxParticles, sim.particles.length);
  }
  expect(happySeen).toBe(true);
  expect(angrySeen).toBe(true);
  expect(jumpFrames).toBeGreaterThan(60);
  // 409s get shredded into a spray of cardboard
  expect(sim.stats.conflicts).toBeGreaterThan(0);
  expect(maxParticles).toBeGreaterThan(8);
  expect(sim.particles.length).toBeLessThan(400);
});

test(
  "Vlad appears when summoned, puffs away, and never loses a crate",
  { timeout: 30000 },
  () => {
    const ctx = stubCtx();
    const sim = newSim();
    const phases = new Set<string>();
    let maxTaken = 0;
    let maxSmoke = 0;
    // build up a backlog he can skewer
    for (let i = 0; i < 40 * 60; i++) step(sim, 1 / 60, true, false, 1, 60);
    expect(sim.vlad.phase).toBe("away"); // he never shows up uninvited

    summonVlad(sim);
    for (let i = 0; i < 20 * 60; i++) {
      step(sim, 1 / 60, true, false, 1, 60);
      if (i % 5 === 0) drawScene(ctx, sim, true, false);
      phases.add(sim.vlad.phase);
      maxTaken = Math.max(maxTaken, sim.vlad.taken.length);
      maxSmoke = Math.max(maxSmoke, sim.smoke.length);
    }

    for (const phase of ["appear", "raise", "gloat", "lower", "vanish"]) {
      expect(phases.has(phase)).toBe(true);
    }
    expect(maxSmoke).toBeGreaterThan(10); // arrives and leaves in smoke
    expect(maxTaken).toBeGreaterThan(0);
    expect(maxTaken).toBeLessThanOrEqual(3);
    // every skewered crate goes back on the stack - work is never destroyed
    expect(sim.vlad.taken.length).toBe(0);
    expect(sim.vlad.phase).toBe("away");
    expect(sim.smoke.length).toBe(0);
    const accounted =
      sim.stats.queued + sim.stats.processing + sim.stats.processed;
    expect(Math.abs(accounted - sim.stats.accepted)).toBeLessThanOrEqual(4);
  },
);

test("every clickable sign and person resolves to a hit region after a frame renders", () => {
  const ctx = stubCtx();
  const sim = newSim();
  step(sim, 1 / 60, false, false);
  drawScene(ctx, sim, false, false);

  // the nine stations documented in the popup content must all be clickable
  const expectedKeys = [
    "intake",
    "idempotency",
    "outbox",
    "backlog",
    "dispatch",
    "db",
    "processed",
    "ratelimit",
    "reconciler",
  ];
  for (const key of expectedKeys) {
    const region = sim.signRegions.find((r) => r.key === key);
    expect(region, `missing sign region for "${key}"`).toBeTruthy();
    const cx = region!.x + region!.w / 2;
    const cy = region!.y + region!.h / 2;
    expect(signAt(sim, cx, cy)?.key).toBe(key);
  }

  // all 5 cashiers and both non-robot warehouse workers are clickable
  expect(sim.personRegions.filter((r) => r.kind === "cashier").length).toBe(5);
  // 2 runners + 2 loaders = 4 clickable warehouse workers (robot excluded)
  expect(sim.personRegions.filter((r) => r.kind === "worker").length).toBe(4);
  const cashier = sim.personRegions.find((r) => r.kind === "cashier")!;
  expect(
    personAt(sim, cashier.x + cashier.w / 2, cashier.y + cashier.h / 2)?.kind,
  ).toBe("cashier");

  // a point far outside the yard hits nothing
  expect(signAt(sim, -500, -500)).toBeNull();
  expect(personAt(sim, -500, -500)).toBeNull();
});

test("regions belong to the sim, not module state - two sims never cross-contaminate hit-testing", () => {
  const ctxA = stubCtx();
  const ctxB = stubCtx();
  const simA = newSim();
  const simB = newSim();
  step(simA, 1 / 60, false, false);
  step(simB, 1 / 60, true, false);
  drawScene(ctxA, simA, false, false);
  drawScene(ctxB, simB, true, false);

  // both sims recorded their own regions independently
  expect(simA.signRegions.length).toBeGreaterThan(0);
  expect(simB.signRegions.length).toBeGreaterThan(0);
  expect(simA.signRegions).not.toBe(simB.signRegions);

  const regionA = simA.signRegions.find((r) => r.key === "ratelimit")!;
  // hit-testing simB at simA's coordinates must not accidentally succeed
  // just because a stale shared array happened to still hold the region -
  // this is the exact class of bug that broke sign clicks in the game.
  simB.signRegions = [];
  expect(signAt(simB, regionA.x + 1, regionA.y + 1)).toBeNull();
  expect(signAt(simA, regionA.x + 1, regionA.y + 1)?.key).toBe("ratelimit");
});
