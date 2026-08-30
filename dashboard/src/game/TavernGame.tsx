import { useEffect, useRef, useState } from "react";
import {
  DOOR_CAP_BOUNDS,
  drawScene,
  H,
  newSim,
  overVladButton,
  personAt,
  signAt,
  step,
  summonVlad,
  THREAD_BOUNDS,
  togglePerson,
  W,
  ZERO_STATS,
} from "./engine";
import type { Sim, Stats } from "./engine";
import "./game.css";

const STATION_INFO: Record<
  string,
  { title: string; what: string; why: string }
> = {
  react: {
    title: "Dashboard kiosk - React 19",
    what: "This page is the React part of the stack. useState holds the HUD stats and toggles; useEffect starts the game loop (and the real dashboard's 1-second /metrics polling) and cleans both up on unmount; useRef carries the simulation so 60fps mutation never re-renders React; useMemo and React.memo trim re-renders of derived values and stat tiles.",
    why: "React repaints only what changed - a handful of numbers, 4 times a second - while the canvas animates independently. UI stays cheap even when the scene is chaos.",
  },
  intake: {
    title: "Cashiers - intake API (202)",
    what: "Each cashier is a web worker answering POST /purchase_requests. They write the order down, hand back a receipt, and never call the payment provider themselves. Response codes: 202 accepted, 200 repeat, 409 conflict, 400 no key, 429 rate limited.",
    why: "Intake stays a cheap database write no matter how backed up processing is. A traffic surge makes the line longer, not the answer slower - a queue instead of an outage.",
  },
  idempotency: {
    title: "Inspector - idempotency check",
    what: "Every order must carry an Idempotency-Key. A repeat with identical data gets the original order back (200). The same key with different data is refused (409) and binned. This is enforced by a unique database index, not an application check - only the database can judge two simultaneous requests.",
    why: "A client whose response got lost can retry forever without ever being charged twice - the most expensive bug in payments, gone.",
  },
  outbox: {
    title: "Outbox table - one transaction",
    what: "The purchase row and its outbox event are written in a single database transaction: the box and its shipping slip appear in one motion, or not at all.",
    why: "Closes the crash window where a customer got a 202 but the job was never enqueued. If the commit happened, the work is both recorded and scheduled.",
  },
  backlog: {
    title: "Crate stacks - queued backlog",
    what: "Accepted work waiting its turn: queued purchases plus pending outbox events. It grows during a rush and drains afterwards.",
    why: "The backlog is what absorbs a surge so the payment provider never sees more than the worker pool. Its depth and age are the honest autoscaling signals.",
  },
  dispatch: {
    title: "Loaders - OutboxDispatchJob",
    what: "Every second the dispatcher claims a batch of pending outbox events with SELECT ... FOR UPDATE SKIP LOCKED and puts each one on the belt as a processing job.",
    why: "Competing dispatchers skip locked rows instead of fighting over them, so any number can run at once and no event is ever claimed twice.",
  },
  db: {
    title: "The machine - bounded worker pool",
    what: "ProcessPurchaseJob calls the (simulated) payment provider using exactly N threads - change N with the DB THREADS buttons. Each purchase is serialized (limits_concurrency to 1) and a finished purchase is never reprocessed.",
    why: "Downstream concurrency is a number you choose, not one the traffic chooses. Fewer threads = slower drain but the same guarantee: the surge waits in the stack.",
  },
  processed: {
    title: "Green crates - processed",
    what: "Purchases that finished the provider call, stamped processed_at. This pallet is the only exit from the pipeline.",
    why: "Everything that is not here is either waiting, working, or being retried - nothing is silently dropped.",
  },
  ratelimit: {
    title: "Bouncer - rate limiter (429)",
    what: "A Redis token bucket per client IP: 200 requests per 10-second window by default. When the crowd is over the cap, newcomers are turned away with 429. If Redis is down it fails open and lets everyone in.",
    why: "One noisy client cannot monopolize intake - and losing the limiter is strictly better than losing intake.",
  },
  reconciler: {
    title: "Robot - ReconcileStuckPurchasesJob",
    what: "On a recurring schedule (30s in the real system, 10s here) it finds purchases stuck in processing past a threshold, returns them to the queue, and writes a fresh outbox event to redrive them.",
    why: "A worker killed mid-job - deploy, crash, scale-in - would otherwise strand that purchase forever. The robot guarantees abandonment is temporary.",
  },
};

// True notes about how this very page is built - the React side of the demo.
const REACT_NOTES = [
  "useRef holds the sim - mutating it never re-renders React",
  "useEffect starts the rAF loop and cleans it up on unmount",
  "useState(stats): the HUD re-renders only 4x per second",
  "The canvas draws at 60fps; React only paints these numbers",
  "React.memo on HudStat would skip unchanged stat tiles",
  "useMemo caches derived values between renders",
  "The real dashboard polls /metrics via useEffect + setInterval",
  "useCallback keeps the poll function stable across renders",
  "Refs bridge React state into the game loop without restarts",
];

function TavernGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holidayRef = useRef(false);
  const flakyRef = useRef(false);
  const threadsRef = useRef(5);
  const capRef = useRef(35);
  const simRef = useRef<Sim | null>(null);
  const [holiday, setHoliday] = useState(
    () => window.location.hash === "#tavern-rush",
  );
  const [flaky, setFlaky] = useState(false);
  const [threads, setThreads] = useState(5);
  const [crowdCap, setCrowdCap] = useState(35);
  const [stats, setStats] = useState<Stats>(ZERO_STATS);
  const [info, setInfo] = useState<string | null>(null);
  const [pointing, setPointing] = useState(false);
  const [noteIndex, setNoteIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNoteIndex((i) => (i + 1) % REACT_NOTES.length),
      5000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    holidayRef.current = holiday;
    flakyRef.current = flaky;
    threadsRef.current = threads;
    capRef.current = crowdCap;
  }, [holiday, flaky, threads, crowdCap]);

  function canvasPoint(event: { clientX: number; clientY: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * W,
      y: ((event.clientY - box.top) / box.height) * H,
    };
  }

  // Hit-testing reads sim.signRegions / sim.personRegions - the regions the
  // most recent drawScene() actually painted this frame. No module-level
  // arrays, so React Fast Refresh / HMR can never leave a click reading a
  // stale sim's boxes (the bug that silently broke sign clicks before).
  function signHit(event: { clientX: number; clientY: number }) {
    const pt = canvasPoint(event);
    const sim = simRef.current;
    if (!pt || !sim) return null;
    return signAt(sim, pt.x, pt.y);
  }

  function overVlad(event: { clientX: number; clientY: number }) {
    const pt = canvasPoint(event);
    return !!pt && overVladButton(pt.x, pt.y);
  }

  function personHit(event: { clientX: number; clientY: number }) {
    const pt = canvasPoint(event);
    const sim = simRef.current;
    if (!pt || !sim) return null;
    return personAt(sim, pt.x, pt.y);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const sim = newSim();
    simRef.current = sim;
    // Exposed only for Playwright E2E assertions (see e2e/tavern.spec.ts) -
    // canvas pixels can't be asserted on directly, so tests read sim state
    // through this hook instead. Gated on import.meta.env.DEV (true for
    // Playwright's dev-mode webServer, false for `vite build`) so Vite
    // tree-shakes this whole assignment out of the production bundle - it
    // is *not* read-only (it is the live object step()/drawScene() mutate
    // every frame), so it must never ship where anything but a trusted test
    // can reach it.
    if (import.meta.env.DEV) {
      (
        window as unknown as { __surgeguardDebug?: { sim: typeof sim } }
      ).__surgeguardDebug = { sim };
    }
    let raf = 0;
    let last = performance.now();
    let hudAcc = 0;

    const tick = (now: number) => {
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;
      step(
        sim,
        dt,
        holidayRef.current,
        flakyRef.current,
        threadsRef.current,
        capRef.current,
      );
      drawScene(ctx, sim, holidayRef.current, flakyRef.current);
      hudAcc += dt;
      if (hudAcc > 0.25) {
        hudAcc = 0;
        setStats({ ...sim.stats });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="tavern">
      <div className="tavern-hud">
        <div className="hud-flow">
          <HudStat label="customers" value={stats.crowd} tone="plain" />
          <span className="hud-arrow">&#9654;</span>
          <HudStat label="202 accepted" value={stats.accepted} tone="gold" />
          <HudStat label="200 replay" value={stats.replayed} tone="green" />
          <HudStat label="409 conflict" value={stats.conflicts} tone="red" />
          <HudStat label="429 limited" value={stats.limited} tone="orange" />
          <HudStat label="422 invalid" value={stats.invalid} tone="orange" />
          <span className="hud-arrow">&#9654;</span>
          <HudStat label="queued" value={stats.queued} tone="gold" />
          <span className="hud-arrow">&#9654;</span>
          <HudStat
            label="processing"
            value={`${stats.processing}/${threads}`}
            tone="plain"
          />
          <span className="hud-arrow">&#9654;</span>
          <HudStat label="processed" value={stats.processed} tone="green" />
          <HudStat label="retries" value={stats.retries} tone="red" />
          <HudStat label="redriven" value={stats.reconciled} tone="purple" />
        </div>
        <div className="hud-react">
          <span className="tech-chip tech-react">REACT</span>
          <span className="hud-react-note">{REACT_NOTES[noteIndex]}</span>
        </div>
        <div className="hud-buttons">
          <button
            type="button"
            className={`pixel-btn ${holiday ? "pixel-btn-on" : ""}`}
            onClick={() => setHoliday((v) => !v)}
          >
            {holiday ? "* HOLIDAY RUSH *" : "Holiday rush"}
          </button>
          <button
            type="button"
            className={`pixel-btn ${flaky ? "pixel-btn-warn" : ""}`}
            onClick={() => setFlaky((v) => !v)}
          >
            {flaky ? "! FLAKY PROVIDER !" : "Flaky provider"}
          </button>
          <div className="thread-control">
            <span>Door cap</span>
            <button
              type="button"
              className="pixel-btn pixel-btn-small"
              onClick={() =>
                setCrowdCap((n) =>
                  Math.max(DOOR_CAP_BOUNDS.min, n - DOOR_CAP_BOUNDS.step),
                )
              }
              disabled={crowdCap <= DOOR_CAP_BOUNDS.min}
            >
              -
            </button>
            <strong>{crowdCap}</strong>
            <button
              type="button"
              className="pixel-btn pixel-btn-small"
              onClick={() =>
                setCrowdCap((n) =>
                  Math.min(DOOR_CAP_BOUNDS.max, n + DOOR_CAP_BOUNDS.step),
                )
              }
              disabled={crowdCap >= DOOR_CAP_BOUNDS.max}
            >
              +
            </button>
          </div>
          <div className="thread-control">
            <span>DB threads</span>
            <button
              type="button"
              className="pixel-btn pixel-btn-small"
              onClick={() =>
                setThreads((n) => Math.max(THREAD_BOUNDS.min, n - 1))
              }
              disabled={threads <= THREAD_BOUNDS.min}
            >
              -
            </button>
            <strong>{threads}</strong>
            <button
              type="button"
              className="pixel-btn pixel-btn-small"
              onClick={() =>
                setThreads((n) => Math.min(THREAD_BOUNDS.max, n + 1))
              }
              disabled={threads >= THREAD_BOUNDS.max}
            >
              +
            </button>
          </div>
        </div>
      </div>
      <div className="tavern-frame">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className={`tavern-canvas ${pointing ? "pointing" : ""}`}
          onClick={(event) => {
            if (overVlad(event) && simRef.current) {
              summonVlad(simRef.current);
              return;
            }
            const hit = signHit(event);
            if (hit) {
              setInfo(hit.key);
              return;
            }
            const person = personHit(event);
            if (person && simRef.current) {
              togglePerson(simRef.current, person.kind, person.index);
              return;
            }
            setInfo(null);
          }}
          onMouseMove={(event) =>
            setPointing(
              signHit(event) !== null ||
                personHit(event) !== null ||
                overVlad(event),
            )
          }
        />
        {info && STATION_INFO[info] && (
          <aside className="tavern-popup">
            <header>
              <h3>{STATION_INFO[info].title}</h3>
              <button type="button" onClick={() => setInfo(null)}>
                X
              </button>
            </header>
            <p>{STATION_INFO[info].what}</p>
            <p className="popup-why">
              <strong>Why it matters:</strong> {STATION_INFO[info].why}
            </p>
          </aside>
        )}
      </div>
      <p className="tavern-legend">
        Cashiers take orders and hand a box to the inspector, who stamps new
        keys (202), waves through repeats (200 replay), and bins mismatches
        (409). The purchase and its outbox slip go on the table in one motion,
        runners stack the backlog, the loaders feed the belt once a second, and
        the machine works a fixed number of boxes at a time - a rush grows the
        stack, never the machine. The robot sweeps out anything stuck and sends
        it round again. Click any hanging sign to learn what that station does
        in the real system - the colored chip under each sign names the tech
        that runs it (Rails, Postgres, Redis, Solid Queue), and the workers
        chatter about what their code really does. Click a cashier or warehouse
        worker to send them to lunch (and click again to bring them back) -
        close enough tills and watch the bouncer start handing out 429s. Lower
        the door cap to trip the Redis rate limiter sooner.
      </p>
    </div>
  );
}

interface HudStatProps {
  label: string;
  value: number | string;
  tone: "plain" | "gold" | "green" | "red" | "orange" | "purple";
}

function HudStat({ label, value, tone }: HudStatProps) {
  return (
    <span className={`hud-stat hud-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

export default TavernGame;
