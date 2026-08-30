// A pixel-art warehouse-tavern that acts the whole pipeline out in miniature.
// Every station on screen is one real stage of the system, wearing a sign:
//
//   door bouncer            -> per-IP rate limiter (429)
//   five cashiers           -> intake endpoints returning 202
//   the inspector           -> idempotency check (200 replay / 409 conflict)
//   boxes stacked in back   -> queued backlog (outbox + queued purchases)
//   the loader + conveyor   -> OutboxDispatchJob claiming events
//   the machine, 5 slots    -> Solid Queue transactions pool (5 threads)
//   the sweeper robot       -> ReconcileStuckPurchasesJob
//
// The simulation runs the same rules as the API: bounded processing, retries
// back to the stack, duplicates resolved before any box reaches the belt.

export const W = 960;
export const H = 600;

const COUNTER_Y = 400;
const LANES = [200, 340, 480, 620, 760];
const QUEUE_START_Y = 452;
const QUEUE_GAP = 32;
const DEFAULT_CROWD_CAP = 35;

// Single source of truth for the two tunable ranges, shared with the HUD
// buttons in TavernGame.tsx - step()'s clamp and the +/- buttons' disabled
// state used to hardcode these bounds independently in both files, which
// meant a range change (e.g. raising max threads) had to be made in two
// places and silently drifted if one was missed.
export const THREAD_BOUNDS = { min: 1, max: 5 } as const;
export const DOOR_CAP_BOUNDS = { min: 3, max: 60, step: 5 } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const INSPECT = { x: 118, y: 330 };
const SHRED = { x: 46, y: 314 };
const BOOTH = { x: 650, y: 66 };
const LUNCH = { x: 66, y: 152 };
const VLAD_SPOT = { x: 328, y: 330 };
const VLAD_BUTTON = { x: W - 178, y: H - 26, w: 168, h: 20 };
const TABLE = { x: 170, y: 212, w: 130, h: 34 };
const STACK = { x: 368, y: 246, cols: 8, colGap: 28, boxH: 14, maxPerCol: 6 };
const BELT = { x1: 400, x2: 688, y: 168, speed: 95, cap: 7 };
const MACHINE = { x: 696, y: 82, w: 232, h: 138 };
const PALLET = { x: 780, y: 266 };
const DOOR = { x: 96, y: 592 };
const EXIT = { x: 920, y: 592 };

const SERVICE_TIME = 0.7;
const PROCESS_MIN = 1.3;
const PROCESS_MAX = 2.1;
const DISPATCH_EVERY = 1.0;
const RECONCILE_EVERY = 10;
const STUCK_CHANCE = 0.02;
const FAIL_CHANCE = 0.28;
const DUP_SAME_CHANCE = 0.14;
const DUP_DIFF_CHANCE = 0.05;

const TAGS = [
  "#e0b350",
  "#5aa9d6",
  "#c76fb0",
  "#7bc86e",
  "#e0784a",
  "#9a8cf0",
  "#d6c95a",
  "#6fd0c0",
];

const SKINS = ["#e8b98a", "#c98d5f", "#a06a42", "#f0cba3", "#8a5a3a"];
const SHIRTS = [
  "#7a4a8f",
  "#3c6e9f",
  "#9f3c4c",
  "#3c8f5f",
  "#8f6e3c",
  "#4a4a8f",
  "#a05a2a",
];
const PANTS = ["#3a3a4a", "#4a3626", "#2a4a5a", "#4a2a3a"];
const HAIRS = ["#2a1a0f", "#5a3a1a", "#8a6a2a", "#3a3a3a", "#7a2a1a"];

interface Person {
  x: number;
  y: number;
  skin: string;
  shirt: string;
  pants: string;
  hair: string;
  frame: number;
  moving: boolean;
}

// What each actor truthfully does in the real stack - shown as chatter.
const CASHIER_MSGS = [
  "POST /purchase_requests - I just INSERT",
  "202 Accepted! Provider comes later",
  "One txn: purchase + outbox event",
  "No Idempotency-Key? That's a 400",
  "RecordNotUnique? I replay, not crash",
  "Intake is one DB write - always fast",
  "I never await the payment provider",
  "Bad amount -> 422, nothing saved",
  "Puma thread here - Rails controller",
];

const INSPECTOR_MSGS = [
  "The unique index decides, not me",
  "App-level checks race. Postgres won't",
  "Same key + same payload = 200",
  "Same key + new payload = 409",
  "One key, one purchase. Ever.",
];

const RUNNER_MSGS = [
  "Outbox row committed with the purchase",
  "published_at NULL = still pending",
  "Backlog is a table - query it in SQL",
  "202 means it's already on disk",
  "No crash window between row and job",
];

const LOADER_MSGS = [
  "SELECT ... FOR UPDATE SKIP LOCKED",
  "I claim a batch every second",
  "Locked row? Skip it. Next!",
  "perform_later -> transactions queue",
  "Two of us, zero double-claims",
  "Solid Queue dispatcher on duty",
];

const ROBOT_MSGS = [
  "Scanning for stuck processing rows...",
  "A worker died mid-job... again",
  "attempt_count++ ... I keep receipts",
  "Nothing stays abandoned on my shift",
  "Deploys kill workers, not work",
  "Every 10s I sweep. Every. 10s.",
];

const ROBOT_REDRIVE_MSGS = [
  "Stuck 2 min in processing - redrive!",
  "Back to queued + fresh outbox event",
  "Found you! Re-queueing this one",
];

const BOUNCER_MSGS = [
  "Redis Lua: INCR + EXPIRE, atomic",
  "200 per IP per 10s. House rules",
  "Redis down? I fail open - come in",
  "Token bucket at the door",
];

const BOSS_ANGRY_MSGS = [
  "WORK FASTER!",
  "BACKLOG AGE IS RISING!",
  "THE METRICS SEE EVERYTHING!",
  "SCALE OUT, PEOPLE!",
  "QUEUE DEPTH! MY DASHBOARD!",
];

const BOSS_HAPPY_MSGS = [
  "Great pace, team!",
  "Queue is draining nicely!",
  "Bonuses for everyone!",
  "The metrics look beautiful!",
  "Opa! Keep it up!",
];

const LUNCH_MSGS = [
  "On lunch - back in 5!",
  "Coffee first, queues later",
  "Even workers need a break",
];

interface Bubble {
  text: string;
  t: number;
  bang: boolean;
}

interface Customer extends Person {
  id: number;
  state: "enter" | "queue" | "served" | "leave" | "bounced";
  lane: number;
  key: number;
  dup: "none" | "same" | "diff";
  timer: number;
  bubble: Bubble | null;
  bang: number;
  invalid: boolean;
}

interface Box {
  id: number;
  x: number;
  y: number;
  tag: string;
  state:
    | "toInspect"
    | "inspecting"
    | "toTable"
    | "table"
    | "carried"
    | "stacked"
    | "belt"
    | "machine"
    | "toPallet"
    | "ejected"
    | "rejected";
  attempts: number;
  timer: number;
  slot: number;
  col: number;
  row: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  stuck: boolean;
  marked: boolean;
  customerId: number;
}

interface WorkerBubbleCarrier {
  bubble: Bubble | null;
}

interface Worker extends Person, WorkerBubbleCarrier {
  lunch: boolean;
  role: "runner" | "loader" | "robot";
  homeX: number;
  homeY: number;
  carrying: Box | null;
  targetX: number;
  targetY: number;
  busy: boolean;
  phase: number;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  t: number;
}

interface Slot {
  box: Box | null;
}

export interface Stats {
  accepted: number;
  replayed: number;
  conflicts: number;
  limited: number;
  queued: number;
  processing: number;
  processed: number;
  retries: number;
  reconciled: number;
  crowd: number;
  invalid: number;
}

export const ZERO_STATS: Stats = {
  accepted: 0,
  replayed: 0,
  conflicts: 0,
  limited: 0,
  queued: 0,
  processing: 0,
  processed: 0,
  retries: 0,
  reconciled: 0,
  crowd: 0,
  invalid: 0,
};

function rnd<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function makePerson(x: number, y: number): Person {
  return {
    x,
    y,
    skin: rnd(SKINS),
    shirt: rnd(SHIRTS),
    pants: rnd(PANTS),
    hair: rnd(HAIRS),
    frame: Math.random() * 10,
    moving: false,
  };
}

function moveToward(
  p: { x: number; y: number },
  tx: number,
  ty: number,
  dist: number,
): boolean {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || len <= dist) {
    p.x = tx;
    p.y = ty;
    return true;
  }
  p.x += (dx / len) * dist;
  p.y += (dy / len) * dist;
  return false;
}

export interface SignRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  key: string;
}

export interface PersonRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "cashier" | "worker";
  index: number;
}

// A very rare visitor. He skewers a few crates, gloats, puts them back.
interface Vlad {
  phase: "away" | "appear" | "raise" | "gloat" | "lower" | "vanish";
  x: number;
  y: number;
  dir: number;
  next: number;
  timer: number;
  frame: number;
  taken: Box[];
}

interface Boss {
  on: boolean;
  x: number;
  y: number;
  dir: number;
  next: number;
  frame: number;
}

export interface Sim {
  customers: Customer[];
  boxes: Box[];
  workers: Worker[];
  floaters: Floater[];
  slots: Slot[];
  cashierBusy: number[];
  cashierBob: number[];
  inspectQueue: Box[];
  rejectPile: number;
  stackCount: number;
  stackGrid: (Box | null)[][];
  stats: Stats;
  nextId: number;
  spawnAcc: number;
  dispatchAcc: number;
  dispatchAllowance: number;
  reconcileAcc: number;
  recentKeys: number[];
  keyCounter: number;
  time: number;
  inspectorStamp: number;
  bouncerWave: number;
  threads: number;
  boss: Boss;
  bossMsg: string;
  cashierBubbles: (Bubble | null)[];
  cashier422: number[];
  cashierLunch: boolean[];
  crowdCap: number;
  bossMood: "happy" | "angry";
  bossDance: number;
  debris: number;
  shredT: number;
  shredTag: string;
  shredEmit: number;
  moneyEmit: number;
  vlad: Vlad;
  signRegions: SignRegion[];
  personRegions: PersonRegion[];
  smoke: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    t: number;
    r: number;
  }[];
  particles: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    t: number;
    c: string;
  }[];
  palletCount: number;
  palletShip: number;
  inspectorBubble: Bubble | null;
  bouncerBubble: Bubble | null;
  chatterNext: number;
}

export function newSim(): Sim {
  const workers: Worker[] = [
    {
      ...makePerson(230, 268),
      role: "runner",
      homeX: 230,
      homeY: 268,
      carrying: null,
      targetX: 230,
      targetY: 268,
      busy: false,
      phase: 0,
      bubble: null,
      lunch: false,
    },
    {
      ...makePerson(300, 272),
      role: "runner",
      homeX: 300,
      homeY: 272,
      carrying: null,
      targetX: 300,
      targetY: 272,
      busy: false,
      phase: 0,
      bubble: null,
      lunch: false,
    },
    {
      ...makePerson(365, 200),
      role: "loader",
      homeX: 365,
      homeY: 200,
      carrying: null,
      targetX: 365,
      targetY: 200,
      busy: false,
      phase: 0,
      bubble: null,
      lunch: false,
    },
    {
      ...makePerson(430, 215),
      role: "loader",
      homeX: 430,
      homeY: 215,
      carrying: null,
      targetX: 430,
      targetY: 215,
      busy: false,
      phase: 0,
      bubble: null,
      lunch: false,
    },
    {
      ...makePerson(BOOTH.x, BOOTH.y + 26),
      role: "robot",
      homeX: BOOTH.x,
      homeY: BOOTH.y + 26,
      carrying: null,
      targetX: BOOTH.x,
      targetY: BOOTH.y + 26,
      busy: false,
      phase: 0,
      bubble: null,
      lunch: false,
    },
  ];
  const sim: Sim = {
    customers: [],
    boxes: [],
    workers,
    floaters: [],
    slots: Array.from({ length: 5 }, () => ({ box: null })),
    cashierBusy: [0, 0, 0, 0, 0],
    cashierBob: [0, 1, 2, 3, 4],
    inspectQueue: [],
    rejectPile: 0,
    stackCount: 0,
    stackGrid: Array.from({ length: STACK.cols }, () =>
      Array.from({ length: STACK.maxPerCol }, () => null),
    ),
    stats: { ...ZERO_STATS },
    nextId: 1,
    spawnAcc: 0,
    dispatchAcc: 0,
    dispatchAllowance: 0,
    reconcileAcc: 0,
    recentKeys: [],
    keyCounter: 0,
    time: 0,
    inspectorStamp: 0,
    bouncerWave: 0,
    threads: 5,
    boss: { on: false, x: -60, y: 210, dir: 1, next: 7, frame: 0 },
    bossMsg: BOSS_HAPPY_MSGS[0],
    cashierBubbles: [null, null, null, null, null],
    cashier422: [0, 0, 0, 0, 0],
    cashierLunch: [false, false, false, false, false],
    crowdCap: DEFAULT_CROWD_CAP,
    bossMood: "happy",
    bossDance: 0,
    debris: 0,
    shredT: 0,
    shredTag: "#b98c56",
    shredEmit: 0,
    moneyEmit: 0,
    signRegions: [],
    personRegions: [],
    smoke: [],
    vlad: {
      phase: "away",
      x: -60,
      y: 300,
      dir: 1,
      next: 55 + Math.random() * 60,
      timer: 0,
      frame: 0,
      taken: [],
    },
    particles: [],
    palletCount: 0,
    palletShip: 0,
    inspectorBubble: null,
    bouncerBubble: null,
    chatterNext: 3,
  };
  return sim;
}

function spawnCustomer(sim: Sim) {
  const crowd = sim.customers.filter(
    (c) => c.state === "enter" || c.state === "queue",
  ).length;
  if (crowd >= sim.crowdCap) {
    // Bouncer: the token bucket turns the customer away at the door.
    sim.stats.limited += 1;
    sim.bouncerWave = 0.5;
    const c: Customer = {
      ...makePerson(DOOR.x, DOOR.y),
      id: sim.nextId++,
      state: "bounced",
      lane: 0,
      key: -1,
      dup: "none",
      timer: 0.4,
      invalid: false,
      bubble: null,
      bang: 2.2,
    };
    sim.customers.push(c);
    sim.bouncerBubble = {
      text: "429 - rate limited, come back!",
      t: 2.6,
      bang: false,
    };
    sim.floaters.push({
      x: DOOR.x + 10,
      y: DOOR.y - 60,
      text: "429",
      color: "#e08a3c",
      t: 1.2,
    });
    return;
  }
  const roll = Math.random();
  let dup: Customer["dup"] = "none";
  let key: number;
  if (sim.recentKeys.length > 3 && roll < DUP_SAME_CHANCE) {
    dup = "same";
    key = rnd(sim.recentKeys);
  } else if (
    sim.recentKeys.length > 3 &&
    roll < DUP_SAME_CHANCE + DUP_DIFF_CHANCE
  ) {
    dup = "diff";
    key = rnd(sim.recentKeys);
  } else {
    key = sim.keyCounter++;
  }
  // join a random shortest OPEN line, so the crowd spreads evenly
  const counts = LANES.map(
    (_, i) =>
      sim.customers.filter(
        (c) => (c.state === "queue" || c.state === "enter") && c.lane === i,
      ).length,
  );
  const open = counts.map((_, i) => i).filter((i) => !sim.cashierLunch[i]);
  const pool = open.length > 0 ? open : counts.map((_, i) => i);
  const minCount = Math.min(...pool.map((i) => counts[i]));
  const lane = rnd(pool.filter((i) => counts[i] === minCount));
  sim.customers.push({
    ...makePerson(DOOR.x + (Math.random() * 30 - 15), DOOR.y),
    id: sim.nextId++,
    state: "enter",
    lane,
    key,
    dup,
    timer: 0,
    bubble: null,
    bang: 0,
    // some walk up with a broken form: bad amount, missing fields
    invalid: dup === "none" && Math.random() < 0.08,
  });
}

function stackPut(sim: Sim, box: Box): boolean {
  for (let col = 0; col < STACK.cols; col++) {
    for (let row = 0; row < STACK.maxPerCol; row++) {
      if (!sim.stackGrid[col][row]) {
        sim.stackGrid[col][row] = box;
        box.col = col;
        box.row = row;
        box.state = "stacked";
        box.x = STACK.x + col * STACK.colGap;
        box.y = STACK.y - row * STACK.boxH;
        sim.stackCount++;
        return true;
      }
    }
  }
  // Overflow: the backlog is deeper than the visible stack; keep it counted.
  box.col = -1;
  box.row = -1;
  box.state = "stacked";
  box.x = STACK.x + STACK.cols * STACK.colGap + 8;
  box.y = STACK.y;
  sim.stackCount++;
  return false;
}

function stackTake(sim: Sim): Box | null {
  const hidden = sim.boxes.find((b) => b.state === "stacked" && b.col === -1);
  if (hidden) {
    sim.stackCount--;
    return hidden;
  }
  for (let col = STACK.cols - 1; col >= 0; col--) {
    for (let row = STACK.maxPerCol - 1; row >= 0; row--) {
      const box = sim.stackGrid[col][row];
      if (box) {
        sim.stackGrid[col][row] = null;
        sim.stackCount--;
        return box;
      }
    }
  }
  return null;
}

// Accepted work waiting its turn: stacked crates plus anything already in
// motion toward the machine. Shared by the end-of-frame stat (sim.stats.queued)
// and the boss's mood check, so mood always reads the current backlog rather
// than whatever sim.stats.queued was left at by the end of the *previous*
// frame.
function backlogDepth(sim: Sim): number {
  return (
    sim.stackCount +
    sim.boxes.filter(
      (b) =>
        b.state === "belt" ||
        b.state === "table" ||
        b.state === "toTable" ||
        b.state === "carried",
    ).length
  );
}

export function step(
  sim: Sim,
  dt: number,
  holiday: boolean,
  flaky: boolean,
  threads = 5,
  crowdCap = DEFAULT_CROWD_CAP,
) {
  sim.time += dt;
  sim.threads = clamp(threads, THREAD_BOUNDS.min, THREAD_BOUNDS.max);
  sim.crowdCap = clamp(crowdCap, DOOR_CAP_BOUNDS.min, DOOR_CAP_BOUNDS.max);
  sim.inspectorStamp = Math.max(0, sim.inspectorStamp - dt);
  sim.bouncerWave = Math.max(0, sim.bouncerWave - dt);

  // --- arrivals -----------------------------------------------------------
  const rate = holiday ? 5.2 : 0.8;
  sim.spawnAcc += dt * rate;
  while (sim.spawnAcc >= 1) {
    sim.spawnAcc -= 1;
    spawnCustomer(sim);
  }

  // --- customers ----------------------------------------------------------
  for (const c of sim.customers) {
    c.frame += dt * 8;
    if (c.bubble) {
      c.bubble.t -= dt;
      if (c.bubble.t <= 0) c.bubble = null;
    }
    if (c.bang > 0) c.bang -= dt;
    if (c.state === "bounced") {
      c.timer -= dt;
      c.moving = c.timer <= 0;
      if (c.timer <= 0) moveToward(c, DOOR.x - 160, DOOR.y + 40, dt * 70);
      continue;
    }
    if (c.state === "enter") {
      const ahead = sim.customers.filter(
        (o) => o.state === "queue" && o.lane === c.lane,
      ).length;
      const tx = LANES[c.lane];
      const ty = QUEUE_START_Y + ahead * QUEUE_GAP;
      c.moving = true;
      if (moveToward(c, tx, ty, dt * 85)) {
        c.state = "queue";
        c.moving = false;
      }
    } else if (c.state === "queue") {
      if (sim.cashierLunch[c.lane]) {
        const openLanes = LANES.map((_, i) => i).filter(
          (i) => !sim.cashierLunch[i],
        );
        if (openLanes.length > 0) {
          c.lane = rnd(openLanes);
        }
      }
      const line = sim.customers
        .filter((o) => o.state === "queue" && o.lane === c.lane)
        .sort((a, b) => a.y - b.y);
      const pos = line.indexOf(c);
      const ty = QUEUE_START_Y + pos * QUEUE_GAP;
      c.moving = Math.abs(c.y - ty) > 1;
      moveToward(c, LANES[c.lane], ty, dt * 70);
      if (
        pos === 0 &&
        Math.abs(c.y - QUEUE_START_Y) < 2 &&
        sim.cashierBusy[c.lane] <= 0 &&
        !sim.cashierLunch[c.lane]
      ) {
        sim.cashierBusy[c.lane] = SERVICE_TIME;
        c.state = "served";
        c.timer = SERVICE_TIME;
      }
    } else if (c.state === "served") {
      c.timer -= dt;
      c.moving = false;
      if (c.timer <= 0 && c.invalid) {
        // Rails validation says no: 422, nothing is written at all.
        sim.stats.invalid += 1;
        sim.cashier422[c.lane] = 2.4;
        sim.cashierBubbles[c.lane] = {
          text: "Invalid form! 422 - fix it, please!",
          t: 3.4,
          bang: true,
        };
        c.bang = 2.6;
        c.state = "leave";
        sim.floaters.push({
          x: LANES[c.lane],
          y: COUNTER_Y - 40,
          text: "422",
          color: "#e08a3c",
          t: 1.4,
        });
      } else if (c.timer <= 0) {
        // Cashier writes the box; it travels to the inspector.
        const box: Box = {
          id: sim.nextId++,
          x: LANES[c.lane],
          y: COUNTER_Y - 24,
          tag: TAGS[c.key % TAGS.length],
          state: "toInspect",
          attempts: 0,
          timer: 0,
          slot: -1,
          col: -1,
          row: -1,
          fromX: LANES[c.lane],
          fromY: COUNTER_Y - 24,
          toX: INSPECT.x + 26,
          toY: INSPECT.y - 6,
          stuck: false,
          marked: false,
          customerId: c.id,
        };
        (box as Box & { key: number; dup: string }).key = c.key;
        (box as Box & { key: number; dup: string }).dup = c.dup;
        sim.boxes.push(box);
        if (c.dup === "none") sim.recentKeys.push(c.key);
        if (sim.recentKeys.length > 24) sim.recentKeys.shift();
        c.state = "leave";
      }
    } else if (c.state === "leave") {
      c.moving = true;
      moveToward(c, EXIT.x + 70, EXIT.y + 40, dt * 95);
    }
  }
  sim.customers = sim.customers.filter(
    (c) =>
      !(
        (c.state === "leave" || c.state === "bounced") &&
        (c.x > W + 10 || c.x < -10 || c.y > H + 10)
      ),
  );
  for (let i = 0; i < 5; i++) {
    sim.cashierBusy[i] = Math.max(0, sim.cashierBusy[i] - dt);
    sim.cashier422[i] = Math.max(0, sim.cashier422[i] - dt);
  }

  // --- boxes in flight ----------------------------------------------------
  for (const box of sim.boxes) {
    if (box.state === "toInspect") {
      if (moveToward(box, box.toX, box.toY, dt * 220)) {
        box.state = "inspecting";
        box.timer = 0.28;
      }
    } else if (box.state === "inspecting") {
      box.timer -= dt;
      if (box.timer <= 0) {
        sim.inspectorStamp = 0.25;
        const dup = (box as Box & { dup: string }).dup;
        const owner = sim.customers.find((c) => c.id === box.customerId);
        if (dup === "same") {
          sim.stats.replayed += 1;
          sim.inspectorBubble = {
            text: "Same key, same data - 200 replay",
            t: 3.2,
            bang: false,
          };
          if (owner) owner.bang = 0;
          sim.floaters.push({
            x: box.x,
            y: box.y - 14,
            text: "200 replay",
            color: "#5fbf6a",
            t: 1.4,
          });
          box.state = "rejected";
          box.timer = -1; // merged with the original: vanish quietly
        } else if (dup === "diff") {
          sim.stats.conflicts += 1;
          sim.inspectorBubble = {
            text: "Same key, DIFFERENT data - 409!",
            t: 4,
            bang: true,
          };
          if (owner) owner.bang = 3.5;
          sim.floaters.push({
            x: box.x,
            y: box.y - 14,
            text: "409",
            color: "#d5504a",
            t: 1.4,
          });
          box.state = "rejected";
          box.fromX = box.x;
          box.fromY = box.y;
          box.toX = SHRED.x + 2;
          box.toY = SHRED.y - 16;
          box.timer = 0.35;
        } else {
          sim.stats.accepted += 1;
          sim.floaters.push({
            x: box.x,
            y: box.y - 14,
            text: "202",
            color: "#e0b350",
            t: 1.2,
          });
          // stamped: the crate is slid over to the outbox table
          box.state = "toTable";
          box.fromX = box.x;
          box.fromY = box.y;
          box.toX = TABLE.x + 8 + Math.random() * (TABLE.w - 24);
          box.toY = TABLE.y + 4 + Math.random() * (TABLE.h - 16);
          box.timer = 0.55;
        }
      }
    } else if (box.state === "toTable") {
      box.timer -= dt;
      const k = 1 - Math.max(box.timer, 0) / 0.55;
      box.x = box.fromX + (box.toX - box.fromX) * k;
      box.y =
        box.fromY + (box.toY - box.fromY) * k - Math.sin(k * Math.PI) * 22;
      if (box.timer <= 0) {
        box.state = "table";
        box.timer = 0;
      }
    } else if (box.state === "table") {
      box.timer += dt;
      if (box.timer > 1.4) stackPut(sim, box);
    } else if (box.state === "rejected" && box.timer > 0) {
      box.timer -= dt;
      const k = 1 - Math.max(box.timer, 0) / 0.35;
      box.x = box.fromX + (box.toX - box.fromX) * k;
      box.y =
        box.fromY + (box.toY - box.fromY) * k - Math.sin(k * Math.PI) * 26;
      if (box.timer <= 0) {
        // into the shredder: it grinds for a moment, spitting pieces
        sim.shredT = 1.0;
        sim.shredTag = box.tag;
        sim.debris = Math.min(sim.debris + 1, 14);
        box.timer = -1; // gone - only confetti remains
      }
    } else if (box.state === "belt") {
      box.x += BELT.speed * dt;
      const aheadX = Math.min(
        ...sim.boxes
          .filter((b) => b.state === "belt" && b.x > box.x)
          .map((b) => b.x),
        BELT.x2 + 100,
      );
      if (box.x > aheadX - 27) box.x = aheadX - 27;
      if (box.x >= BELT.x2 - 8) {
        const free = sim.slots.findIndex(
          (s, idx) => !s.box && idx < sim.threads,
        );
        if (free >= 0) {
          sim.slots[free].box = box;
          box.state = "machine";
          box.slot = free;
          box.timer = PROCESS_MIN + Math.random() * (PROCESS_MAX - PROCESS_MIN);
          box.stuck = Math.random() < STUCK_CHANCE;
          box.attempts += 1;
          box.x = MACHINE.x + 34;
          box.y = MACHINE.y + 30 + free * 22;
        } else {
          box.x = BELT.x2 - 8; // full machine: the belt waits, backpressure made visible
        }
      }
    } else if (box.state === "machine") {
      if (!box.stuck) box.timer -= dt;
      if (box.timer <= 0 && !box.stuck) {
        sim.slots[box.slot].box = null;
        if (flaky && Math.random() < FAIL_CHANCE) {
          sim.stats.retries += 1;
          box.marked = true;
          box.state = "ejected";
          box.fromX = box.x;
          box.fromY = box.y;
          box.timer = 0.5;
          sim.floaters.push({
            x: box.x,
            y: box.y - 12,
            text: "retry",
            color: "#d5504a",
            t: 1.3,
          });
        } else {
          sim.stats.processed += 1;
          sim.palletCount += 1;
          if (sim.palletCount >= 18) {
            // full pallet: ship it out and start a fresh one
            sim.palletCount = 0;
            sim.palletShip = 1.5;
            sim.floaters.push({
              x: PALLET.x + 60,
              y: PALLET.y - 30,
              text: "shipped!",
              color: "#7bd88a",
              t: 1.6,
            });
          }
          box.state = "toPallet";
          box.fromX = box.x;
          box.fromY = box.y;
          box.toX = PALLET.x + (sim.stats.processed % 6) * 18;
          box.toY =
            PALLET.y + 10 - Math.floor((sim.stats.processed % 24) / 6) * 12;
          box.timer = 0.45;
        }
      }
    } else if (box.state === "ejected") {
      box.timer -= dt;
      const k = 1 - Math.max(box.timer, 0) / 0.5;
      const tx = STACK.x + STACK.cols * STACK.colGap * 0.5;
      const ty = STACK.y - 40;
      box.x = box.fromX + (tx - box.fromX) * k;
      box.y = box.fromY + (ty - box.fromY) * k - Math.sin(k * Math.PI) * 40;
      if (box.timer <= 0) stackPut(sim, box);
    } else if (box.state === "toPallet") {
      box.timer -= dt;
      const k = 1 - Math.max(box.timer, 0) / 0.45;
      box.x = box.fromX + (box.toX - box.fromX) * k;
      box.y =
        box.fromY + (box.toY - box.fromY) * k - Math.sin(k * Math.PI) * 20;
    }
  }
  sim.boxes = sim.boxes.filter((b) => {
    if (b.state === "rejected") return b.timer > -0.5 && b.timer !== -1;
    if (b.state === "toPallet") return b.timer > -6;
    return true;
  });

  // --- the boss: struts through the backstock, everyone hustles -----------
  sim.boss.next -= dt;
  sim.boss.frame += dt * 9;
  if (!sim.boss.on && sim.boss.next <= 0) {
    sim.boss.on = true;
    sim.boss.dir = Math.random() < 0.5 ? 1 : -1;
    sim.boss.x = sim.boss.dir > 0 ? -40 : W + 40;
    sim.boss.y = 195 + Math.random() * 65;
    // mood follows the backlog: a pile of crates makes an angry boss
    sim.bossMood = backlogDepth(sim) > 30 ? "angry" : "happy";
    sim.bossMsg = rnd(
      sim.bossMood === "angry" ? BOSS_ANGRY_MSGS : BOSS_HAPPY_MSGS,
    );
    sim.bossDance = 0;
  }
  if (sim.boss.on) {
    if (sim.bossMood === "happy") {
      // strolls, pauses to jump for joy - tossing money in the air
      sim.bossDance -= dt;
      if (sim.bossDance <= -2.6) sim.bossDance = 1.4;
      if (sim.bossDance <= 0) {
        sim.boss.x += sim.boss.dir * 70 * dt;
      } else {
        sim.moneyEmit -= dt;
        while (sim.moneyEmit <= 0) {
          sim.moneyEmit += 0.09;
          sim.particles.push({
            x: sim.boss.x + (Math.random() * 20 - 10),
            y: sim.boss.y - 40,
            vx: (Math.random() - 0.5) * 130,
            vy: -150 - Math.random() * 90,
            t: 1.6 + Math.random() * 0.7,
            c: Math.random() < 0.75 ? "#5fbf6a" : "#8fdc8a",
          });
        }
      }
    } else {
      sim.boss.x += sim.boss.dir * 145 * dt;
    }
    if (sim.boss.x < -60 || sim.boss.x > W + 60) {
      sim.boss.on = false;
      sim.boss.next = 12 + Math.random() * 18;
    }
  }
  const pace = sim.boss.on && sim.bossMood === "angry" ? 1.45 : 1;

  // --- ambient chatter: everyone explains their real job ------------------
  const decay = (b: Bubble | null) => {
    if (!b) return null;
    b.t -= dt;
    return b.t > 0 ? b : null;
  };
  sim.inspectorBubble = decay(sim.inspectorBubble);
  sim.bouncerBubble = decay(sim.bouncerBubble);
  for (let i = 0; i < 5; i++)
    sim.cashierBubbles[i] = decay(sim.cashierBubbles[i]);
  for (const w of sim.workers) w.bubble = decay(w.bubble);

  sim.chatterNext -= dt;
  if (sim.chatterNext <= 0) {
    sim.chatterNext = 2.4 + Math.random() * 2.6;
    const active =
      (sim.inspectorBubble ? 1 : 0) +
      (sim.bouncerBubble ? 1 : 0) +
      sim.cashierBubbles.filter(Boolean).length +
      sim.workers.filter((w) => w.bubble).length;
    if (active < 2) {
      const roll = Math.random();
      const say = (text: string): Bubble => ({ text, t: 3.6, bang: false });
      if (roll < 0.34) {
        sim.cashierBubbles[Math.floor(Math.random() * 5)] = say(
          rnd(CASHIER_MSGS),
        );
      } else if (roll < 0.48) {
        sim.inspectorBubble = say(rnd(INSPECTOR_MSGS));
      } else if (roll < 0.62) {
        const runners = sim.workers.filter((w) => w.role === "runner");
        const r = rnd(runners);
        r.bubble = say(rnd(r.lunch ? LUNCH_MSGS : RUNNER_MSGS));
      } else if (roll < 0.78) {
        const loaders = sim.workers.filter((w) => w.role === "loader");
        const l = rnd(loaders);
        l.bubble = say(rnd(l.lunch ? LUNCH_MSGS : LOADER_MSGS));
      } else if (roll < 0.9) {
        const robot = sim.workers.find((w) => w.role === "robot");
        if (robot && !robot.bubble) robot.bubble = say(rnd(ROBOT_MSGS));
      } else {
        sim.bouncerBubble = say(rnd(BOUNCER_MSGS));
      }
    }
  }

  // --- Vlad the Impaler: summoned by name, arrives in a puff of smoke -----
  const vlad = sim.vlad;
  vlad.frame += dt * 9;
  if (vlad.phase === "appear") {
    vlad.timer -= dt;
    if (vlad.timer <= 0) {
      // skewer up to three crates straight off the stack
      for (let i = 0; i < 3; i++) {
        const box = stackTake(sim);
        if (box) {
          box.state = "carried";
          vlad.taken.push(box);
        }
      }
      vlad.phase = "raise";
      vlad.timer = 0.45;
    }
  } else if (vlad.phase === "raise") {
    vlad.timer -= dt;
    if (vlad.timer <= 0) {
      vlad.phase = "gloat";
      vlad.timer = 3.4;
    }
  } else if (vlad.phase === "gloat") {
    vlad.timer -= dt;
    if (vlad.timer <= 0) {
      vlad.phase = "lower";
      vlad.timer = 0.5;
    }
  } else if (vlad.phase === "lower") {
    vlad.timer -= dt;
    if (vlad.timer <= 0) {
      // crates go back on the stack, none are lost
      for (const box of vlad.taken) stackPut(sim, box);
      vlad.taken = [];
      vlad.phase = "vanish";
      vlad.timer = 0.5;
      puff(sim, vlad.x, vlad.y);
    }
  } else if (vlad.phase === "vanish") {
    vlad.timer -= dt;
    if (vlad.timer <= 0) vlad.phase = "away";
  }
  // carried crates ride the pike above his head
  if (vlad.phase !== "away") {
    const lift =
      vlad.phase === "raise"
        ? 1 - Math.max(vlad.timer, 0) / 0.45
        : vlad.phase === "gloat"
          ? 1
          : vlad.phase === "lower"
            ? Math.max(vlad.timer, 0) / 0.5
            : 0;
    const hop =
      vlad.phase === "gloat" && Math.floor(vlad.frame) % 2 === 0 ? -8 : 0;
    const shake =
      vlad.phase === "gloat" ? (Math.floor(vlad.frame) % 2 === 0 ? 3 : -3) : 0;
    vlad.taken.forEach((box, i) => {
      box.x = vlad.x + 20 + shake + (i % 2 === 0 ? -1 : 1);
      box.y = vlad.y - 58 - lift * (72 + i * 17) + hop;
    });
  }

  // --- smoke puffs --------------------------------------------------------
  for (const sm of sim.smoke) {
    sm.x += sm.vx * dt;
    sm.y += sm.vy * dt;
    sm.vy -= 26 * dt; // smoke rises
    sm.vx *= 0.94;
    sm.t -= dt;
  }
  sim.smoke = sim.smoke.filter((sm) => sm.t > 0);

  // --- warehouse runners: table -> stack ---------------------------------
  for (const w of sim.workers) {
    w.frame += dt * 8;
    if (
      (w.role === "runner" || w.role === "loader") &&
      w.lunch &&
      !w.carrying
    ) {
      w.busy = false;
      (w as Worker & { claim?: Box }).claim = undefined;
      w.moving = !moveToward(
        w,
        LUNCH.x + 20 + (sim.workers.indexOf(w) % 3) * 26,
        LUNCH.y + 40,
        dt * 80,
      );
      continue;
    }
    if (w.role === "runner") {
      if (!w.busy) {
        const target = sim.boxes.find(
          (b) =>
            b.state === "table" &&
            !sim.workers.some(
              (o) =>
                o.carrying === b || (o as Worker & { claim?: Box }).claim === b,
            ),
        );
        if (target) {
          (w as Worker & { claim?: Box }).claim = target;
          w.busy = true;
          w.targetX = target.x;
          w.targetY = target.y + 14;
        } else {
          w.moving = !moveToward(w, w.homeX, w.homeY, dt * 60 * pace);
        }
      } else if (!w.carrying) {
        const claim = (w as Worker & { claim?: Box }).claim;
        if (!claim || claim.state !== "table") {
          w.busy = false;
          (w as Worker & { claim?: Box }).claim = undefined;
        } else {
          w.moving = true;
          if (moveToward(w, w.targetX, w.targetY, dt * 88 * pace)) {
            w.carrying = claim;
            claim.state = "carried";
            (w as Worker & { claim?: Box }).claim = undefined;
            w.targetX =
              STACK.x +
              Math.min(sim.stackCount % STACK.cols, STACK.cols - 1) *
                STACK.colGap;
            w.targetY = STACK.y + 22;
          }
        }
      } else {
        w.moving = true;
        w.carrying.x = w.x;
        w.carrying.y = w.y - 18;
        if (moveToward(w, w.targetX, w.targetY, dt * 88 * pace)) {
          stackPut(sim, w.carrying);
          w.carrying = null;
          w.busy = false;
          w.moving = false;
        }
      }
    }
  }

  // --- dispatcher: stack -> belt, once a second --------------------------
  sim.dispatchAcc += dt;
  if (sim.dispatchAcc >= DISPATCH_EVERY) {
    sim.dispatchAcc -= DISPATCH_EVERY;
    sim.dispatchAllowance = 3;
  }
  for (const loader of sim.workers) {
    if (loader.role !== "loader") continue;
    if (loader.lunch && !loader.carrying) continue;
    const beltCount = sim.boxes.filter((b) => b.state === "belt").length;
    if (
      !loader.busy &&
      sim.dispatchAllowance > 0 &&
      beltCount < BELT.cap &&
      sim.stackCount > 0
    ) {
      const box = stackTake(sim);
      if (box) {
        sim.dispatchAllowance -= 1;
        loader.carrying = box;
        box.state = "carried";
        loader.busy = true;
        loader.targetX = BELT.x1 + 6;
        loader.targetY = BELT.y + 24;
      }
    }
    if (loader.busy && loader.carrying) {
      loader.moving = true;
      loader.carrying.x = loader.x;
      loader.carrying.y = loader.y - 18;
      if (moveToward(loader, loader.targetX, loader.targetY, dt * 120 * pace)) {
        loader.carrying.state = "belt";
        loader.carrying.x = BELT.x1 + 4;
        loader.carrying.y = BELT.y - 4;
        loader.carrying = null;
        loader.busy = false;
      }
    } else if (!loader.busy) {
      loader.moving = !moveToward(
        loader,
        loader.homeX,
        loader.homeY,
        dt * 80 * pace,
      );
    }
  }

  // --- reconciler robot ---------------------------------------------------
  sim.reconcileAcc += dt;
  const robot = sim.workers.find((w) => w.role === "robot");
  if (robot) {
    if (sim.reconcileAcc >= RECONCILE_EVERY && !robot.busy) {
      sim.reconcileAcc = 0;
      robot.busy = true;
      robot.targetX = MACHINE.x - 18;
      robot.targetY = MACHINE.y + 60;
    }
    if (robot.busy && !robot.carrying) {
      robot.moving = true;
      if (moveToward(robot, robot.targetX, robot.targetY, dt * 110)) {
        const stuckBox = sim.boxes.find(
          (b) => b.state === "machine" && b.stuck,
        );
        if (stuckBox) {
          sim.slots[stuckBox.slot].box = null;
          stuckBox.stuck = false;
          stuckBox.state = "carried";
          robot.carrying = stuckBox;
          robot.targetX = STACK.x + 40;
          robot.targetY = STACK.y + 24;
          sim.stats.reconciled += 1;
          robot.bubble = { text: rnd(ROBOT_REDRIVE_MSGS), t: 3.2, bang: false };
          sim.floaters.push({
            x: robot.x,
            y: robot.y - 22,
            text: "redrive",
            color: "#9a8cf0",
            t: 1.4,
          });
        } else {
          robot.busy = false;
        }
      }
    } else if (robot.busy && robot.carrying) {
      robot.moving = true;
      robot.carrying.x = robot.x;
      robot.carrying.y = robot.y - 18;
      if (moveToward(robot, robot.targetX, robot.targetY, dt * 110)) {
        stackPut(sim, robot.carrying);
        robot.carrying = null;
        // A stuck box freezes its machine slot until someone frees it, and
        // the stuck roll fires on every box regardless of the flaky-provider
        // toggle - so more than one can pile up between sweeps. Keep working
        // the machine until it is clear, rather than going idle after one
        // box and leaving the rest frozen for a full RECONCILE_EVERY wait.
        const moreStuck = sim.boxes.some(
          (b) => b.state === "machine" && b.stuck,
        );
        if (moreStuck) {
          robot.targetX = MACHINE.x - 18;
          robot.targetY = MACHINE.y + 60;
        } else {
          robot.busy = false;
        }
      }
    } else {
      robot.moving = !moveToward(robot, robot.homeX, robot.homeY, dt * 70);
    }
  }

  sim.palletShip = Math.max(0, sim.palletShip - dt);

  // --- shredder confetti: a steady spray out of the chute while grinding --
  if (sim.shredT > 0) {
    sim.shredEmit -= dt;
    while (sim.shredEmit <= 0) {
      sim.shredEmit += 0.04;
      sim.particles.push({
        x: SHRED.x - 18,
        y: SHRED.y + 2,
        vx: -30 - Math.random() * 110,
        vy: -40 - Math.random() * 110,
        t: 0.8 + Math.random() * 0.6,
        c:
          Math.random() < 0.4
            ? sim.shredTag
            : Math.random() < 0.5
              ? "#b98c56"
              : "#8a5e34",
      });
    }
  }
  sim.shredT = Math.max(0, sim.shredT - dt);
  for (const pt of sim.particles) {
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += 320 * dt;
    pt.t -= dt;
  }
  sim.particles = sim.particles.filter((pt) => pt.t > 0);

  // --- floaters -----------------------------------------------------------
  for (const f of sim.floaters) {
    f.t -= dt;
    f.y -= dt * 22;
  }
  sim.floaters = sim.floaters.filter((f) => f.t > 0);

  sim.stats.queued = backlogDepth(sim);
  sim.stats.processing = sim.slots.filter((s) => s.box).length;
  sim.stats.crowd = sim.customers.filter(
    (c) => c.state === "queue" || c.state === "enter",
  ).length;
}

// Pure hit-testers over the sim's per-frame regions - HMR-safe because the
// regions live on the sim object, not in module state.
export function signAt(sim: Sim, x: number, y: number): SignRegion | null {
  return (
    sim.signRegions.find(
      (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h,
    ) ?? null
  );
}

export function personAt(sim: Sim, x: number, y: number): PersonRegion | null {
  return (
    sim.personRegions.find(
      (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h,
    ) ?? null
  );
}

export function overVladButton(x: number, y: number): boolean {
  const r = VLAD_BUTTON;
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// A puff of smoke at a point - used for arrivals and departures.
function puff(sim: Sim, x: number, y: number) {
  for (let i = 0; i < 26; i++) {
    const angle = (i / 26) * Math.PI * 2;
    const speed = 20 + Math.random() * 70;
    sim.smoke.push({
      x: x + (Math.random() * 20 - 10),
      y: y - 10 + (Math.random() * 24 - 12),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.5 - 24,
      t: 0.7 + Math.random() * 0.6,
      r: 5 + Math.random() * 8,
    });
  }
}

// Summoned by name from the corner of the yard. Ignored if he is already here.
export function summonVlad(sim: Sim) {
  const vlad = sim.vlad;
  if (vlad.phase !== "away") return;
  vlad.x = VLAD_SPOT.x;
  vlad.y = VLAD_SPOT.y;
  vlad.phase = "appear";
  vlad.timer = 0.55;
  puff(sim, vlad.x, vlad.y);
}

// Click handling: send a cashier or warehouse worker to lunch (and back).
export function togglePerson(sim: Sim, kind: string, index: number) {
  if (kind === "cashier") {
    sim.cashierLunch[index] = !sim.cashierLunch[index];
    sim.cashierBubbles[index] = {
      text: sim.cashierLunch[index] ? "Gone to lunch!" : "Back to work!",
      t: 2.4,
      bang: false,
    };
    return;
  }
  const w = sim.workers[index];
  if (w && (w.role === "runner" || w.role === "loader")) {
    w.lunch = !w.lunch;
    w.bubble = {
      text: w.lunch ? "Lunch time!" : "Back to work!",
      t: 2.4,
      bang: false,
    };
  }
}

// --------------------------------------------------------------------------
// Rendering - chunky outlined pixel art in a 3/4 top-down camp style.
// One art pixel is a 2x2 canvas block; sprites are string maps painted
// through a palette, everything gets a dark outline and a soft shadow,
// and movable things are painter-sorted by their feet.
//
// Stryker disable all: this block is pure pixel-pushing (colors, shapes,
// sprite offsets) with no behavioral assertion anywhere that could ever
// catch a mutated fill color or a shifted decorative rectangle - mutating
// it only produces noise. drawSign() and drawScene() below are restored,
// since they also compute click hit-regions and layering order, which is
// exactly the class of real bug (see CHANGELOG.md) unit tests do cover.
// --------------------------------------------------------------------------

const PXS = 2;
const OUT = "#241c26";

type Pal = Record<string, string>;

function drawSprite(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  pal: Pal,
  x: number,
  y: number,
) {
  const sx = Math.round(x / PXS) * PXS;
  const sy = Math.round(y / PXS) * PXS;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let c0 = -1;
    let cur = "";
    for (let c = 0; c <= row.length; c++) {
      const col = c < row.length ? pal[row[c]] : undefined;
      if (col !== cur || col === undefined) {
        if (cur) {
          ctx.fillStyle = cur;
          ctx.fillRect(sx + c0 * PXS, sy + r * PXS, (c - c0) * PXS, PXS);
        }
        cur = col ?? "";
        c0 = c;
      }
    }
  }
}

function rect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(
    Math.round(x / PXS) * PXS,
    Math.round(y / PXS) * PXS,
    Math.round(w / PXS) * PXS,
    Math.round(h / PXS) * PXS,
  );
}

// Filled rect with a 1-art-pixel dark outline.
function orect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  rect(ctx, x, y, w, h, OUT);
  rect(ctx, x + PXS, y + PXS, w - 2 * PXS, h - 2 * PXS, color);
}

function shadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
) {
  ctx.fillStyle = "rgba(30, 22, 30, 0.28)";
  const sx = Math.round(x / PXS) * PXS;
  const sy = Math.round(y / PXS) * PXS;
  ctx.fillRect(sx - w / 2 + PXS, sy, w - 2 * PXS, PXS * 2);
  ctx.fillRect(sx - w / 2, sy + PXS, w, PXS);
}

// --- characters: chibi proportions, half head, big eyes -------------------

const CHAR_STAND = [
  "...gggggg...",
  "..ghhhhhhg..",
  ".ghhhhhhhhg.",
  ".ghhhhhhhhg.",
  ".ghhshhshhg.",
  ".gssssssssg.",
  ".gsWWssWWsg.",
  ".gsPWssPWsg.",
  ".gssssssssg.",
  "..gssssssg..",
  "..gccccccg..",
  ".gsccccccsg.",
  ".gsccccccsg.",
  "..gddddddg..",
  "..gll..llg..",
  "..gbb..bbg..",
];

const CHAR_WALK = [
  "...gggggg...",
  "..ghhhhhhg..",
  ".ghhhhhhhhg.",
  ".ghhhhhhhhg.",
  ".ghhshhshhg.",
  ".gssssssssg.",
  ".gsWWssWWsg.",
  ".gsPWssPWsg.",
  ".gssssssssg.",
  "..gssssssg..",
  "..gccccccg..",
  ".gsccccccsg.",
  ".gsccccccsg.",
  "..gddddddg..",
  ".gll....llg.",
  ".gbb....bbg.",
];

const CHAR_W = 12 * PXS;
const CHAR_H = 16 * PXS;

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = ch(n >> 16);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function personPal(p: Person): Pal {
  return {
    g: OUT,
    h: p.hair,
    s: p.skin,
    W: "#f4f0e6",
    P: "#2a222c",
    c: p.shirt,
    d: shade(p.shirt, 0.72),
    l: p.pants,
    b: shade(p.pants, 0.6),
  };
}

function drawPerson(ctx: CanvasRenderingContext2D, p: Person) {
  const walking = p.moving && Math.floor(p.frame) % 2 === 1;
  // standing still: a slow breathing bob so nobody looks frozen
  const breathing = !p.moving && Math.floor(p.frame / 5) % 2 === 1;
  const bob = walking || breathing ? -PXS : 0;
  const x = p.x - CHAR_W / 2;
  const y = p.y - CHAR_H;
  shadow(ctx, p.x, p.y - PXS, CHAR_W - 4);
  drawSprite(ctx, walking ? CHAR_WALK : CHAR_STAND, personPal(p), x, y + bob);
  // an occasional blink
  if (Math.floor(p.frame / 6) % 8 === 7) {
    rect(ctx, x + 6, y + bob + 12, 4, 4, p.skin);
    rect(ctx, x + 14, y + bob + 12, 4, 4, p.skin);
  }
}

const ROBOT_MAP = [
  ".....aa.....",
  ".....gg.....",
  ".ggggggggggg",
  ".gmmmmmmmmg.",
  ".gmEEmmEEmg.",
  ".gmmmmmmmmg.",
  ".gnnnnnnnng.",
  ".gggggggggg.",
  "..gmmmmmmg..",
  ".gnmmmmmmng.",
  ".gnmmmmmmng.",
  "..gmmmmmmg..",
  "..gggggggg..",
  "..gtt..ttg..",
  "..gtt..ttg..",
  "...gggggg...",
];

function drawRobot(ctx: CanvasRenderingContext2D, p: Person, t: number) {
  const blink = Math.floor(t * 3) % 2 === 0;
  const pal: Pal = {
    g: OUT,
    a: blink ? "#ffd25a" : "#8a6a2a",
    m: "#9aa0ad",
    n: "#6d7380",
    E: blink ? "#7bd8ff" : "#31586a",
    t: "#4a4f5a",
  };
  shadow(ctx, p.x, p.y - PXS, CHAR_W - 2);
  drawSprite(ctx, ROBOT_MAP, pal, p.x - CHAR_W / 2, p.y - CHAR_H);
}

// --- crates ---------------------------------------------------------------

const CRATE_MAP = [
  ".gggggggggg.",
  "gttttttttttg",
  "gtuuuuuuuutg",
  "gggggggggggg",
  "gfpffffffpfg",
  "gfpfKKKffpfg",
  "gfpfKKKffpfg",
  "gfpffffffpfg",
  "gqqqqqqqqqqg",
  ".gggggggggg.",
];

const CRATE_W = 12 * PXS;
const CRATE_H = 10 * PXS;

function drawCrate(ctx: CanvasRenderingContext2D, b: Box, green = false) {
  const wood = green ? "#5f9a52" : "#b98c56";
  const pal: Pal = {
    g: OUT,
    t: green ? "#7cb46a" : "#cfa268",
    u: green ? "#6aa45c" : "#c2955e",
    f: wood,
    p: shade(wood, 0.72),
    q: shade(wood, 0.6),
    K: b.tag,
  };
  const x = b.x - CRATE_W / 2;
  const y = b.y - CRATE_H + 4;
  shadow(ctx, b.x, b.y + 2, CRATE_W - 4);
  drawSprite(ctx, CRATE_MAP, pal, x, y);
  if (b.marked) {
    rect(ctx, x + 16, y + 10, 6, 2, "#d5504a");
    rect(ctx, x + 18, y + 8, 2, 6, "#d5504a");
  }
  if (b.stuck) {
    rect(ctx, b.x - 2, y - 10, 4, 6, "#ffd25a");
    rect(ctx, b.x - 2, y - 2, 4, 2, "#ffd25a");
  }
}

// --- greenery + ground ----------------------------------------------------

const BUSH_MAP = [
  "....gggg......",
  "..ggbbbbgg....",
  ".gbbBbbbbbgg..",
  "gbbBBbbbbbbbg.",
  "gbbbbbbBBbbbg.",
  ".gbbbbbBBbbbg.",
  ".gdbbbbbbbddg.",
  "..gddbbbdddg..",
  "...ggggggg....",
];

const STONE_MAP = ["..gggg..", ".gmmmmg.", "gmmMMmmg", "gdmmmmdg", ".gggggg."];

// Deterministic speckle field so the ground doesn't shimmer between frames.
function seeded(seed: number): () => number {
  let v = seed;
  return () => {
    v = (v * 1103515245 + 12345) & 0x7fffffff;
    return v / 0x7fffffff;
  };
}

interface Speck {
  x: number;
  y: number;
  c: number;
}

const GRASS_SPECKS: Speck[] = [];
const DIRT_SPECKS: Speck[] = [];
{
  const r = seeded(7);
  for (let i = 0; i < 420; i++)
    GRASS_SPECKS.push({
      x: Math.floor(r() * 480) * 2,
      y: Math.floor(r() * 300) * 2,
      c: r() < 0.5 ? 0 : 1,
    });
  for (let i = 0; i < 300; i++)
    DIRT_SPECKS.push({
      x: Math.floor(r() * 480) * 2,
      y: Math.floor(r() * 300) * 2,
      c: r() < 0.5 ? 0 : 1,
    });
}

function dirtInset(y: number): number {
  return 44 + Math.sin(y * 0.028) * 12 + Math.sin(y * 0.011 + 2) * 8;
}

function insideDirt(x: number, y: number): boolean {
  if (y < 40 || y > H - 34) return false;
  const inset = dirtInset(y);
  return x > inset && x < W - inset * 0.7;
}

function drawGround(ctx: CanvasRenderingContext2D) {
  // grass base
  rect(ctx, 0, 0, W, H, "#6f9a52");
  for (const sp of GRASS_SPECKS) {
    if (!insideDirt(sp.x, sp.y))
      rect(ctx, sp.x, sp.y, 2, 2, sp.c === 0 ? "#5c8544" : "#86af64");
  }
  // dirt camp floor with a wavy organic edge
  for (let y = 40; y < H - 34; y += PXS) {
    const inset = dirtInset(y);
    rect(ctx, inset, y, W - inset * 1.7, PXS, "#c9a06a");
  }
  for (const sp of DIRT_SPECKS) {
    if (insideDirt(sp.x, sp.y))
      rect(ctx, sp.x, sp.y, 2, 2, sp.c === 0 ? "#b08a58" : "#d8b47e");
  }
  // dirt edge shading
  for (let y = 40; y < H - 34; y += PXS * 2) {
    const inset = dirtInset(y);
    rect(ctx, inset, y, 4, PXS * 2, "#9a7448");
    rect(ctx, W - inset * 0.7 - 4, y, 4, PXS * 2, "#9a7448");
  }

  const bushPal: Pal = { g: OUT, b: "#4f7a3e", B: "#6c9a52", d: "#3d6130" };
  const stonePal: Pal = { g: OUT, m: "#a8a094", M: "#c2bab0", d: "#7e7568" };
  const bushes = [
    [10, 26],
    [210, 8],
    [420, 16],
    [640, 6],
    [860, 20],
    [6, 200],
    [4, 420],
    [922, 330],
    [918, 480],
    [340, 566],
    [700, 570],
    [40, 560],
  ];
  for (const [bx, by] of bushes) drawSprite(ctx, BUSH_MAP, bushPal, bx, by);
  const stones = [
    [120, 60],
    [560, 40],
    [900, 120],
    [60, 320],
    [910, 420],
    [520, 568],
  ];
  for (const [sx2, sy2] of stones)
    drawSprite(ctx, STONE_MAP, stonePal, sx2, sy2);

  // ground tarp under the backlog stacks (like the camp mats)
  orect(
    ctx,
    STACK.x - 24,
    STACK.y - STACK.maxPerCol * STACK.boxH - 26,
    STACK.cols * STACK.colGap + 44,
    STACK.maxPerCol * STACK.boxH + 66,
    "#8a4a52",
  );
  rect(
    ctx,
    STACK.x - 18,
    STACK.y - STACK.maxPerCol * STACK.boxH - 20,
    STACK.cols * STACK.colGap + 32,
    4,
    "#a2606a",
  );
  rect(
    ctx,
    STACK.x - 18,
    STACK.y + 28,
    STACK.cols * STACK.colGap + 32,
    4,
    "#6e3a42",
  );

  // wooden platform under the machine
  orect(
    ctx,
    MACHINE.x - 14,
    MACHINE.y - 12,
    MACHINE.w + 28,
    MACHINE.h + 40,
    "#96683c",
  );
  for (let px2 = MACHINE.x - 8; px2 < MACHINE.x + MACHINE.w + 8; px2 += 22) {
    rect(ctx, px2, MACHINE.y - 8, 2, MACHINE.h + 32, "#7a5330");
  }

  // trampled path from the door to the counter
  for (let y = COUNTER_Y + 44; y < H - 20; y += PXS) {
    rect(ctx, DOOR.x - 20 + (y - COUNTER_Y) * 0.15, y, 46, PXS, "#b8925e");
  }
}

// --- props ----------------------------------------------------------------

function drawStall(ctx: CanvasRenderingContext2D, cx: number, scheme: number) {
  const stripes =
    scheme === 0 ? ["#b5493f", "#e8dcc0"] : ["#3f6e5a", "#e8dcc0"];
  const w = 88;
  const x = cx - w / 2;
  const topY = COUNTER_Y - 78;
  // poles
  orect(ctx, x + 2, topY + 14, 6, COUNTER_Y - topY - 8, "#6e4a2a");
  orect(ctx, x + w - 8, topY + 14, 6, COUNTER_Y - topY - 8, "#6e4a2a");
  // canopy: striped roof with a scalloped hem
  rect(ctx, x - 4, topY - 2, w + 8, 22, OUT);
  for (let i = 0; i < (w + 4) / 8; i++) {
    rect(ctx, x - 2 + i * 8, topY, 8, 18, stripes[i % 2]);
  }
  rect(ctx, x - 2, topY, w + 4, 4, "rgba(255,255,255,0.25)");
  for (let i = 0; i < (w + 4) / 8; i++) {
    rect(ctx, x - 2 + i * 8, topY + 18, 8, i % 2 === 0 ? 4 : 2, stripes[i % 2]);
    rect(ctx, x - 2 + i * 8, topY + (i % 2 === 0 ? 22 : 20), 8, 2, OUT);
  }
}

function drawCounter(ctx: CanvasRenderingContext2D) {
  orect(ctx, 104, COUNTER_Y, 752, 32, "#96683c");
  rect(ctx, 106, COUNTER_Y + 2, 748, 10, "#cfa268");
  rect(ctx, 106, COUNTER_Y + 12, 748, 2, "#6e4a2a");
  for (let x = 130; x < 850; x += 46)
    rect(ctx, x, COUNTER_Y + 16, 2, 12, "#7a5330");
  for (const lx of LANES) {
    rect(ctx, lx - 6, COUNTER_Y + 4, 12, 6, "#e3b955");
    rect(ctx, lx - 6, COUNTER_Y + 4, 12, 2, "#f2d485");
  }
}

function drawTable(ctx: CanvasRenderingContext2D) {
  orect(ctx, TABLE.x - 6, TABLE.y - 6, TABLE.w + 12, TABLE.h + 22, "#96683c");
  rect(ctx, TABLE.x - 4, TABLE.y - 4, TABLE.w + 8, 14, "#cfa268");
  rect(ctx, TABLE.x - 4, TABLE.y + 10, TABLE.w + 8, 2, "#6e4a2a");
  orect(ctx, TABLE.x - 2, TABLE.y + TABLE.h + 8, 8, 10, "#6e4a2a");
  orect(ctx, TABLE.x + TABLE.w - 6, TABLE.y + TABLE.h + 8, 8, 10, "#6e4a2a");
}

function drawInspectorDesk(
  ctx: CanvasRenderingContext2D,
  stamp: number,
  time: number,
) {
  orect(ctx, INSPECT.x - 24, INSPECT.y - 12, 60, 34, "#96683c");
  rect(ctx, INSPECT.x - 22, INSPECT.y - 10, 56, 12, "#cfa268");
  rect(ctx, INSPECT.x - 22, INSPECT.y + 2, 56, 2, "#6e4a2a");
  // key-lookup console: three buttons the inspector keeps hammering
  orect(ctx, INSPECT.x - 20, INSPECT.y - 26, 46, 16, "#454a55");
  for (let i = 0; i < 3; i++) {
    const lit = Math.floor(time * 5 + i * 1.7) % 3 === 0;
    rect(
      ctx,
      INSPECT.x - 16 + i * 14,
      INSPECT.y - 22 + (lit ? 2 : 0),
      8,
      lit ? 6 : 8,
      lit ? "#7bd88a" : "#9aa0ad",
    );
  }
  if (stamp > 0) orect(ctx, INSPECT.x + 18, INSPECT.y - 24, 12, 10, "#d5504a");
}

function drawShredder(ctx: CanvasRenderingContext2D, sim: Sim) {
  const shake = sim.shredT > 0 ? (Math.floor(sim.time * 20) % 2) * 2 : 0;
  const x = SHRED.x + shake;
  // debris pile below the side chute
  for (let i = 0; i < Math.min(sim.debris, 14); i++) {
    const dx = x - 40 + ((i * 7) % 26);
    const dy = SHRED.y + 16 - Math.floor(i / 5) * 4;
    rect(
      ctx,
      dx,
      dy,
      5,
      3,
      i % 3 === 0 ? "#b98c56" : i % 3 === 1 ? "#8a5e34" : "#c76fb0",
    );
  }
  // body
  orect(ctx, x - 14, SHRED.y - 8, 34, 26, "#6d7380");
  rect(ctx, x - 12, SHRED.y - 6, 30, 6, "#9aa0ad");
  // hopper funnel on top
  rect(ctx, x - 12, SHRED.y - 20, 4, 12, OUT);
  rect(ctx, x + 12, SHRED.y - 20, 4, 12, OUT);
  rect(ctx, x - 8, SHRED.y - 18, 20, 10, "#454a55");
  // grinding teeth flicker while shredding
  if (sim.shredT > 0) {
    const gap = Math.floor(sim.time * 16) % 2 === 0 ? 0 : 3;
    for (let i = 0; i < 3; i++) {
      rect(ctx, x - 6 + i * 8 + gap, SHRED.y - 14, 4, 6, "#e3b955");
    }
  }
  // side chute pointing left
  orect(ctx, x - 26, SHRED.y - 2, 14, 10, "#454a55");
  // warning stripe
  rect(ctx, x - 12, SHRED.y + 12, 30, 4, "#e3b955");
  rect(ctx, x - 6, SHRED.y + 12, 6, 4, OUT);
  rect(ctx, x + 8, SHRED.y + 12, 6, 4, OUT);
}

function drawBooth(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  robotHome: boolean,
) {
  // border-style guard booth for the reconciler
  orect(ctx, BOOTH.x - 22, BOOTH.y - 34, 44, 66, "#8a8e99");
  rect(ctx, BOOTH.x - 26, BOOTH.y - 40, 52, 8, OUT);
  rect(ctx, BOOTH.x - 24, BOOTH.y - 38, 48, 4, "#b3b7c2");
  // red/white barrier stripes
  for (let i = 0; i < 5; i++) {
    rect(
      ctx,
      BOOTH.x - 20 + i * 8,
      BOOTH.y + 22,
      8,
      6,
      i % 2 === 0 ? "#b5493f" : "#e8dcc0",
    );
  }
  // window - the robot peeks out while parked
  orect(ctx, BOOTH.x - 14, BOOTH.y - 26, 28, 22, "#0f2a33");
  if (robotHome) {
    const blink = Math.floor(sim.time * 3) % 2 === 0;
    rect(ctx, BOOTH.x - 8, BOOTH.y - 20, 16, 12, "#9aa0ad");
    rect(ctx, BOOTH.x - 5, BOOTH.y - 17, 3, 3, blink ? "#7bd8ff" : "#2a5a6a");
    rect(ctx, BOOTH.x + 2, BOOTH.y - 17, 3, 3, blink ? "#7bd8ff" : "#2a5a6a");
  }
}

function drawLunchTable(ctx: CanvasRenderingContext2D) {
  orect(ctx, LUNCH.x - 8, LUNCH.y + 10, 76, 16, "#96683c");
  rect(ctx, LUNCH.x - 4, LUNCH.y + 12, 68, 5, "#cfa268");
  orect(ctx, LUNCH.x - 2, LUNCH.y + 26, 8, 8, "#6e4a2a");
  orect(ctx, LUNCH.x + 54, LUNCH.y + 26, 8, 8, "#6e4a2a");
  // coffee mugs
  rect(ctx, LUNCH.x + 10, LUNCH.y + 6, 7, 7, "#e8dcc0");
  rect(ctx, LUNCH.x + 12, LUNCH.y + 4, 3, 2, "#8a5e34");
  rect(ctx, LUNCH.x + 38, LUNCH.y + 6, 7, 7, "#7bc86e");
}

function drawBelt(ctx: CanvasRenderingContext2D, time: number) {
  orect(ctx, BELT.x1 - 10, BELT.y - 2, BELT.x2 - BELT.x1 + 20, 30, "#5d616e");
  rect(ctx, BELT.x1 - 6, BELT.y, BELT.x2 - BELT.x1 + 12, 16, "#454a55");
  // treads scroll left-to-right, the same way the crates travel into the machine
  const off = (Math.floor((time * BELT.speed) / PXS) * PXS) % 24;
  for (let x = BELT.x1 - 28 + off; x < BELT.x2 + 4; x += 24) {
    if (x < BELT.x1 - 4) continue;
    rect(ctx, x, BELT.y + 2, 4, 12, "#6d7380");
    rect(ctx, x + 4, BELT.y + 2, 2, 12, "#31353f");
  }
  // arrows on the frame, pointing at the machine
  for (let x = BELT.x1 + 20; x < BELT.x2 - 10; x += 60) {
    rect(ctx, x, BELT.y + 18, 8, 4, "#7d8390");
    rect(ctx, x + 8, BELT.y + 16, 2, 8, "#7d8390");
    rect(ctx, x + 10, BELT.y + 18, 2, 4, "#7d8390");
  }
  rect(ctx, BELT.x1 - 6, BELT.y + 16, BELT.x2 - BELT.x1 + 12, 8, "#383c46");
  orect(ctx, BELT.x1 - 14, BELT.y + 2, 10, 12, "#8a8e99");
  orect(ctx, BELT.x2 + 4, BELT.y + 2, 10, 12, "#8a8e99");
  // legs
  orect(ctx, BELT.x1 + 8, BELT.y + 22, 8, 12, "#31353f");
  orect(ctx, BELT.x2 - 18, BELT.y + 22, 8, 12, "#31353f");
}

function drawMachine(ctx: CanvasRenderingContext2D, sim: Sim) {
  const m = MACHINE;
  // chimney with smoke
  orect(ctx, m.x + m.w - 44, m.y - 26, 16, 30, "#6d7380");
  rect(ctx, m.x + m.w - 46, m.y - 28, 20, 4, OUT);
  const puff = Math.floor(sim.time * 2) % 3;
  ctx.fillStyle = "rgba(220, 220, 226, 0.5)";
  ctx.fillRect(
    m.x + m.w - 44 + puff * 3,
    m.y - 40 - puff * 6,
    10 - puff * 2,
    8 - puff * 2,
  );
  ctx.fillRect(
    m.x + m.w - 50 - puff * 2,
    m.y - 52 - puff * 8,
    8 - puff,
    6 - puff,
  );
  // body
  orect(ctx, m.x, m.y, m.w, m.h, "#8a8e99");
  rect(ctx, m.x + 2, m.y + 2, m.w - 4, 12, "#b3b7c2");
  rect(ctx, m.x + 2, m.y + 14, m.w - 4, 2, "#5d616e");
  // intake mouth on the belt side
  orect(ctx, m.x - 8, m.y + 22, 20, 24, "#31353f");
  // slot bays
  for (let i = 0; i < 5; i++) {
    const sy = m.y + 20 + i * 22;
    if (i >= sim.threads && !sim.slots[i].box) {
      // powered-down bay: hatch closed, no lamp
      orect(ctx, m.x + 20, sy, 132, 20, "#454a55");
      rect(ctx, m.x + 24, sy + 8, 124, 4, "#383c46");
      orect(ctx, m.x + 158, sy + 4, 12, 12, "#2a2a32");
      continue;
    }
    orect(ctx, m.x + 20, sy, 132, 20, "#6d7380");
    rect(ctx, m.x + 22, sy + 2, 128, 4, "#7d8390");
    rect(ctx, m.x + 24, sy + 14, 4, 4, "#e3b955");
    rect(ctx, m.x + 144, sy + 14, 4, 4, "#e3b955");
    const slotBox = sim.slots[i].box;
    const on = slotBox ? Math.floor(sim.time * 6) % 2 === 0 : false;
    const light = slotBox
      ? slotBox.stuck
        ? "#ffd25a"
        : on
          ? "#7bd88a"
          : "#2e6a3a"
      : "#383c46";
    orect(ctx, m.x + 158, sy + 4, 12, 12, light);
  }
  // gear housing
  const spin = Math.floor(sim.time * 4) % 2;
  for (let g = 0; g < 2; g++) {
    const gx = m.x + 196;
    const gy = m.y + 40 + g * 56;
    orect(ctx, gx - 14, gy - 14, 28, 28, "#454a55");
    rect(ctx, gx - 8, gy - 8, 16, 16, "#9aa0ad");
    rect(ctx, gx - 3, gy - 3, 6, 6, "#454a55");
    if (spin === 0) {
      rect(ctx, gx - 14, gy - 3, 6, 6, "#9aa0ad");
      rect(ctx, gx + 8, gy - 3, 6, 6, "#9aa0ad");
    } else {
      rect(ctx, gx - 3, gy - 14, 6, 6, "#9aa0ad");
      rect(ctx, gx - 3, gy + 8, 6, 6, "#9aa0ad");
    }
  }
  // out chute toward the pallet
  orect(ctx, m.x + 60, m.y + m.h - 2, 48, 16, "#5d616e");
}

function drawPallet(ctx: CanvasRenderingContext2D, sim: Sim) {
  orect(ctx, PALLET.x - 18, PALLET.y + 12, 160, 14, "#96683c");
  rect(ctx, PALLET.x - 14, PALLET.y + 14, 152, 4, "#cfa268");
  for (let x = PALLET.x - 8; x < PALLET.x + 136; x += 26)
    rect(ctx, x, PALLET.y + 20, 12, 4, "#6e4a2a");
  const crate = (bx: number, by: number) =>
    drawCrate(
      ctx,
      { x: bx, y: by, tag: "#e6f2da", marked: false, stuck: false } as Box,
      true,
    );
  // a just-filled pallet slides off screen to the right
  if (sim.palletShip > 0) {
    const slide = (1.5 - sim.palletShip) * 340;
    for (let i = 0; i < 18; i++) {
      crate(
        PALLET.x + (i % 6) * 24 + slide,
        PALLET.y + 4 - Math.floor(i / 6) * 14,
      );
    }
  }
  for (let i = 0; i < Math.min(sim.palletCount, 18); i++) {
    crate(PALLET.x + (i % 6) * 24, PALLET.y + 4 - Math.floor(i / 6) * 14);
  }
}

const KIOSK = { x: 806, y: 520 };

function drawKiosk(ctx: CanvasRenderingContext2D, sim: Sim) {
  // desk
  orect(ctx, KIOSK.x - 6, KIOSK.y + 26, 96, 18, "#96683c");
  rect(ctx, KIOSK.x - 2, KIOSK.y + 28, 88, 6, "#cfa268");
  // monitor
  orect(ctx, KIOSK.x + 8, KIOSK.y - 14, 68, 44, "#33333f");
  rect(ctx, KIOSK.x + 12, KIOSK.y - 10, 60, 32, "#0f2a33");
  // live bars - the HUD numbers, re-rendered 4x a second
  const bars = [
    sim.stats.queued,
    sim.stats.processing * 8,
    sim.stats.processed,
    sim.stats.crowd,
  ];
  bars.forEach((v, i) => {
    const h = Math.max(4, Math.min(24, Math.round(v / 3) * 2));
    rect(ctx, KIOSK.x + 18 + i * 14, KIOSK.y + 18 - h, 8, h, "#4fd8e8");
  });
  const blink = Math.floor(sim.time * 2) % 2 === 0;
  rect(ctx, KIOSK.x + 62, KIOSK.y - 6, 6, 4, blink ? "#4fd8e8" : "#1e4a55");
  // stand
  rect(ctx, KIOSK.x + 36, KIOSK.y + 30, 10, 4, "#241c26");
}

function drawDoor(ctx: CanvasRenderingContext2D) {
  orect(ctx, DOOR.x - 30, H - 14, 72, 14, "#96683c");
  rect(ctx, DOOR.x - 26, H - 12, 64, 4, "#cfa268");
  orect(ctx, DOOR.x - 34, H - 46, 8, 40, "#6e4a2a");
  orect(ctx, DOOR.x + 38, H - 46, 8, 40, "#6e4a2a");
  orect(ctx, DOOR.x - 34, H - 52, 80, 10, "#6e4a2a");
}

const BOSS_MAP = [
  "....gggggg....",
  "...ghhhhhhg...",
  "..ghhhhhhhhg..",
  "..ghhshhshhg..",
  "..gssssssssg..",
  "..gsWWssWWsg..",
  "..gsPWssPWsg..",
  "..gsssmmsssg..",
  "...gssssssg...",
  "..gjjwtwwjjg..",
  ".gjjjwtwwjjjg.",
  "gsjjjwwwwjjjsg",
  "gsjjjjjjjjjjsg",
  ".gjjjjjjjjjjg.",
  "..gll....llg..",
  "..gbb....bbg..",
];

// 16x23 cells, two cape frames - tall collar, red-lined cloak, gold clasp.
const VLAD_MAP_A = [
  "....gggggggg....",
  "..ggkkkkkkkkgg..",
  "..gkkkkkkkkkkg..",
  "..gkkskkkkskkg..",
  "..gksssssssskg..",
  "..gssRssssRssg..",
  "..gssssssssssg..",
  "..gsmmmmmmmmsg..",
  "...gsskkkkssg...",
  ".gLLggssssggLLg.",
  ".gLvvvvvvvvvvLg.",
  "gLvvvGGGGGGvvvLg",
  "gLvvvvvGGvvvvvLg",
  "gLvvvVvvvvVvvvLg",
  "gLvvvvvvvvvvvvLg",
  "gLvvvvvvvvvvvvLg",
  ".gLvvvvvvvvvvLg.",
  ".gLvvvvvvvvvvLg.",
  "..gvvvvvvvvvvg..",
  "..gvvg....gvvg..",
  "..gnng....gnng..",
  "..gbbg....gbbg..",
  "...gg......gg...",
];

const VLAD_MAP_B = [
  "....gggggggg....",
  "..ggkkkkkkkkgg..",
  "..gkkkkkkkkkkg..",
  "..gkkskkkkskkg..",
  "..gksssssssskg..",
  "..gssRssssRssg..",
  "..gssssssssssg..",
  "..gsmmmmmmmmsg..",
  "...gsskkkkssg...",
  ".gLLggssssggLLg.",
  ".gLvvvvvvvvvvLg.",
  "gLvvvGGGGGGvvvLg",
  "gLvvvvvGGvvvvvLg",
  "gLvvVvvvvvvVvvLg",
  "gLvvvvvvvvvvvLLg",
  "gLLvvvvvvvvvvvLg",
  ".gLvvvvvvvvvLLg.",
  ".gLLvvvvvvvvvLg.",
  "..gvvvvvvvvvvg..",
  "..gvvg....gvvg..",
  "..gnng....gnng..",
  "..gbbg....gbbg..",
  "...gg......gg...",
];

const VLAD_W = 16 * PXS;
const VLAD_H = 23 * PXS;

function drawVlad(ctx: CanvasRenderingContext2D, vlad: Vlad, time: number) {
  if (vlad.phase === "away") return;
  // materialise out of / dissolve into the smoke, rising from the ground
  let riseIn = 0;
  if (vlad.phase === "appear") {
    const k = 1 - Math.max(vlad.timer, 0) / 0.55;
    ctx.globalAlpha = Math.min(1, k);
    riseIn = (1 - k) * 16;
  } else if (vlad.phase === "vanish") {
    const k = Math.max(vlad.timer, 0) / 0.5;
    ctx.globalAlpha = Math.max(0, k);
    riseIn = (1 - k) * 10;
  }

  const beat = Math.floor(vlad.frame) % 2 === 0;
  const gloating = vlad.phase === "gloat";
  const hop = gloating && beat ? -9 : 0;
  const sway =
    vlad.phase === "appear" || vlad.phase === "vanish" ? 0 : beat ? 0 : -PXS;
  const y0 = vlad.y - VLAD_H + hop + sway + riseIn;
  const x0 = vlad.x - VLAD_W / 2;

  const eyesBlaze = gloating || Math.floor(time * 2) % 4 === 0;
  const pal: Pal = {
    g: OUT,
    k: "#141018",
    s: "#ded4ca",
    R: eyesBlaze ? "#ff4838" : "#a02a20",
    m: "#2a2028",
    v: "#241a2e",
    V: "#3c2c4c",
    L: "#8a1f2a",
    G: "#d8a838",
    n: "#1c1822",
    b: "#0f0d14",
  };

  shadow(ctx, vlad.x, vlad.y - PXS, VLAD_W - 8);
  // flowing cape behind, its own slower flutter
  const capeFlick = Math.floor(vlad.frame / 2) % 2 === 0 ? 0 : 4;
  rect(ctx, x0 - 6 - capeFlick, y0 + 18, 10 + capeFlick, 26, "#5a1220");
  rect(ctx, x0 - 4 - capeFlick, y0 + 22, 6 + capeFlick, 18, "#7a1c2c");
  drawSprite(
    ctx,
    Math.floor(vlad.frame / 2) % 2 === 0 ? VLAD_MAP_A : VLAD_MAP_B,
    pal,
    x0,
    y0,
  );

  // the pike, held to his right; his arms rise together with it
  const lift =
    vlad.phase === "raise"
      ? 1 - Math.max(vlad.timer, 0) / 0.45
      : vlad.phase === "gloat"
        ? 1
        : vlad.phase === "lower"
          ? Math.max(vlad.timer, 0) / 0.5
          : 0;
  const shake = gloating ? (beat ? 3 : -3) : 0;
  const shaftX = vlad.x + 18 + shake;
  const gripY = y0 + 24 - lift * 22; // hand slides up as he lifts
  const topY = vlad.y - 52 - lift * 112 + hop;
  // shaft + steel head
  rect(ctx, shaftX, topY, 4, vlad.y - 8 + hop - topY, "#6e4a2a");
  rect(ctx, shaftX + 1, topY, 1, vlad.y - 8 + hop - topY, "#8a6440");
  rect(ctx, shaftX - 2, topY - 12, 8, 14, "#b3b7c2");
  rect(ctx, shaftX, topY - 18, 4, 8, "#e2e6ee");
  rect(ctx, shaftX - 4, topY - 2, 12, 4, "#8a8e99");
  // pike-side arm: shoulder to grip, following the lift
  const shX = x0 + VLAD_W - 8;
  const shY = y0 + 22;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const ax = shX + ((shaftX - 2 - shX) * i) / steps;
    const ay = shY + ((gripY - shY) * i) / steps;
    rect(ctx, ax, ay, 5, 5, "#241a2e");
  }
  rect(ctx, shaftX - 2, gripY, 7, 6, pal.s);
  // free arm rises in triumph while gloating
  if (lift > 0.15) {
    const fx = x0 + 2;
    const raise = lift * 18;
    rect(ctx, fx - 2, y0 + 26 - raise * 0.4, 5, 8, "#241a2e");
    rect(ctx, fx - 5, y0 + 20 - raise, 5, 9, "#241a2e");
    rect(ctx, fx - 6, y0 + 14 - raise, 6, 6, pal.s);
  }

  ctx.globalAlpha = 1;
}
function drawBoss(
  ctx: CanvasRenderingContext2D,
  boss: Boss,
  mood: "happy" | "angry" = "angry",
  jumping = false,
) {
  const pal: Pal = {
    g: OUT,
    h: "#4a4642",
    s: "#e8b98a",
    W: "#f4f0e6",
    P: "#2a222c",
    m: "#c98d5f",
    j: "#33333f",
    w: "#e8e4da",
    t: "#9f3c4c",
    l: "#26262e",
    b: "#1a1a20",
  };
  // angry: furious shaking hops; happy: strolls, pauses to jump for joy
  const beat = Math.floor(boss.frame) % 2 === 0;
  let bob = beat ? 0 : -PXS;
  if (mood === "angry") bob = beat ? 0 : -7;
  if (jumping) bob = beat ? -14 : -2; // big happy hops
  shadow(ctx, boss.x, boss.y - PXS, 14 * PXS - 2);
  drawSprite(ctx, BOSS_MAP, pal, boss.x - 7 * PXS, boss.y - 16 * PXS + bob);
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  bottomY: number,
  text: string,
  accent = "#2a222c",
) {
  ctx.font = "8px 'Press Start 2P', monospace";
  const tw = ctx.measureText(text).width;
  const w = tw + 16;
  const h = 22;
  const x = Math.max(6, Math.min(cx - w / 2, W - w - 6));
  const y = bottomY - h - 10;
  orect(ctx, x, y, w, h, "#f4f0e6");
  rect(ctx, cx - 4, y + h - 2, 8, 4, "#f4f0e6");
  rect(ctx, cx - 6, y + h, 2, 6, OUT);
  rect(ctx, cx - 4, y + h + 2, 4, 2, OUT);
  rect(ctx, cx + 4, y + h, 2, 4, OUT);
  ctx.fillStyle = accent;
  ctx.fillText(text, x + 8, y + 15);
}

function drawBang(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  t: number,
) {
  ctx.font = "10px 'Press Start 2P', monospace";
  const bounce = Math.floor(t * 6) % 2 === 0 ? 0 : -2;
  ctx.fillStyle = OUT;
  ctx.fillText("!!!", cx - 13, topY + bounce + 1);
  ctx.fillStyle = "#d5504a";
  ctx.fillText("!!!", cx - 14, topY + bounce);
}

// Which piece of the real stack runs each station - shown as a chip.
const SIGN_TECH: Record<string, { label: string; color: string }> = {
  react: { label: "REACT", color: "#2a6a7f" },
  intake: { label: "RAILS", color: "#9f3c4c" },
  idempotency: { label: "POSTGRES", color: "#33608f" },
  outbox: { label: "POSTGRES", color: "#33608f" },
  backlog: { label: "POSTGRES", color: "#33608f" },
  dispatch: { label: "SOLID QUEUE", color: "#6a4a9f" },
  db: { label: "SOLID QUEUE", color: "#6a4a9f" },
  processed: { label: "POSTGRES", color: "#33608f" },
  ratelimit: { label: "REDIS", color: "#a3402a" },
  reconciler: { label: "SOLID QUEUE", color: "#6a4a9f" },
};

const SIGN_KEYS: Record<string, string> = {
  DASHBOARD: "react",
  "INTAKE / 202": "intake",
  IDEMPOTENCY: "idempotency",
  "OUTBOX WRITE": "outbox",
  "QUEUED BACKLOG": "backlog",
  "DISPATCH 1s": "dispatch",
  "DB x5 THREADS": "db",
  PROCESSED: "processed",
  "RATE LIMIT": "ratelimit",
  "RECONCILER 10s": "reconciler",
};
// Stryker restore all

function drawSign(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  cx: number,
  y: number,
  label: string,
  value: string,
) {
  ctx.font = "8px 'Press Start 2P', monospace";
  const wl = ctx.measureText(label).width;
  const wv = ctx.measureText(value).width;
  const w = Math.max(wl, wv) + 16;
  const x = Math.round((cx - w / 2) / PXS) * PXS;
  // hanging strings
  rect(ctx, x + 8, y - 6, 2, 6, OUT);
  rect(ctx, x + w - 10, y - 6, 2, 6, OUT);
  orect(ctx, x, y, w, 30, "#6e4a2a");
  rect(ctx, x + 2, y + 2, w - 4, 4, "#8a6440");
  ctx.fillStyle = "#f0dcb0";
  ctx.fillText(label, x + 8, y + 13);
  ctx.fillStyle = "#ffd25a";
  ctx.fillText(value, x + 8, y + 25);
  const key = SIGN_KEYS[label];
  if (key) {
    // corner tick: marks the sign as clickable
    rect(ctx, x + w - 8, y + 4, 4, 4, "#7bd8ff");
    const tech = SIGN_TECH[key];
    let h = 36;
    if (tech) {
      ctx.font = "7px 'Press Start 2P', monospace";
      const tw = ctx.measureText(tech.label).width + 10;
      orect(ctx, x, y + 30, tw, 15, tech.color);
      ctx.fillStyle = "#f4f0e6";
      ctx.fillText(tech.label, x + 5, y + 41);
      h = 51;
    }
    sim.signRegions.push({ x, y: y - 6, w, h, key });
  }
}

interface Renderable {
  y: number;
  draw: () => void;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  holiday: boolean,
  flaky: boolean,
) {
  sim.signRegions.length = 0;
  sim.personRegions.length = 0;
  LANES.forEach((lx, i) =>
    sim.personRegions.push({
      x: lx - 16,
      y: COUNTER_Y - 40,
      w: 32,
      h: 44,
      kind: "cashier",
      index: i,
    }),
  );
  sim.workers.forEach((w, i) => {
    if (w.role === "runner" || w.role === "loader") {
      sim.personRegions.push({
        x: w.x - 16,
        y: w.y - CHAR_H - 4,
        w: 32,
        h: CHAR_H + 8,
        kind: "worker",
        index: i,
      });
    }
  });
  drawGround(ctx);

  // flat-ish furniture drawn before the sorted pass
  drawBelt(ctx, sim.time);
  drawMachine(ctx, sim);
  drawPallet(ctx, sim);
  drawTable(ctx);
  drawInspectorDesk(ctx, sim.inspectorStamp, sim.time);
  drawShredder(ctx, sim);
  drawLunchTable(ctx);
  drawDoor(ctx);
  drawKiosk(ctx, sim);

  // painter-sorted layer: everything that walks or gets carried
  const items: Renderable[] = [];

  let hiddenStacked = 0;
  for (const b of sim.boxes) {
    if (b.state === "toPallet" && b.timer <= 0) continue;
    if (b.state === "stacked" && b.col === -1) {
      hiddenStacked++;
      continue;
    }
    if (sim.vlad.taken.includes(b)) continue; // ride the pike, drawn with Vlad
    const box = b;
    items.push({
      y: box.y + 4,
      draw: () => drawCrate(ctx, box, box.state === "toPallet"),
    });
  }

  const robotWorker = sim.workers.find((w) => w.role === "robot");
  const robotOut =
    !!robotWorker &&
    (robotWorker.busy ||
      !!robotWorker.carrying ||
      Math.abs(robotWorker.x - robotWorker.homeX) +
        Math.abs(robotWorker.y - robotWorker.homeY) >
        6);
  drawBooth(ctx, sim, !robotOut);
  for (const w of sim.workers) {
    const worker = w;
    if (w.role === "robot") {
      if (robotOut)
        items.push({ y: w.y, draw: () => drawRobot(ctx, worker, sim.time) });
    } else {
      items.push({ y: w.y, draw: () => drawPerson(ctx, worker) });
    }
  }

  // cashiers stand behind the counter
  LANES.forEach((lx, i) => {
    let bob =
      sim.cashierBusy[i] > 0 ? (Math.floor(sim.time * 10 + i) % 2) * PXS : 0;
    if (sim.cashier422[i] > 0) {
      // jumping mad about the invalid form
      bob = (Math.floor(sim.time * 12) % 2) * 6;
    }
    if (sim.cashierLunch[i]) {
      // placard on the counter: this till is closed
      items.push({
        y: COUNTER_Y + 32,
        draw: () => {
          orect(ctx, lx - 26, COUNTER_Y - 30, 52, 24, "#e8dcc0");
          ctx.font = "7px 'Press Start 2P', monospace";
          ctx.fillStyle = "#8a3a3a";
          ctx.fillText("LUNCH", lx - 18, COUNTER_Y - 15);
        },
      });
      return;
    }
    const cashier: Person = {
      x: lx,
      y: COUNTER_Y - 2 - bob,
      skin: SKINS[i % SKINS.length],
      shirt: "#8a3a3a",
      pants: "#3a3a4a",
      hair: HAIRS[i % HAIRS.length],
      frame: 0,
      moving: false,
    };
    items.push({ y: cashier.y, draw: () => drawPerson(ctx, cashier) });
    if (sim.cashierBusy[i] > 0) {
      items.push({
        y: cashier.y + 1,
        draw: () => rect(ctx, lx + 12, COUNTER_Y - 44, 6, 6, "#ffd25a"),
      });
    }
  });

  // the counter and stalls sort with everything else so customers pass in front
  items.push({ y: COUNTER_Y + 30, draw: () => drawCounter(ctx) });
  LANES.forEach((lx, i) =>
    items.push({ y: COUNTER_Y + 31, draw: () => drawStall(ctx, lx, i % 2) }),
  );

  // door bouncer
  const bouncer: Person = {
    x: DOOR.x + 56,
    y: H - 22,
    skin: "#c98d5f",
    shirt: "#33333f",
    pants: "#22222c",
    hair: "#1c1c22",
    frame: 0,
    moving: false,
  };
  items.push({ y: bouncer.y, draw: () => drawPerson(ctx, bouncer) });

  // inspector person - always working the console
  const inspector: Person = {
    x: INSPECT.x - 36,
    y: INSPECT.y + 16,
    skin: "#e8b98a",
    shirt: "#8f6e3c",
    pants: "#3a3a4a",
    hair: "#5a3a1a",
    frame: sim.time * 9,
    moving: false,
  };
  items.push({
    y: inspector.y,
    draw: () => {
      drawPerson(ctx, inspector);
      // arm reaching over to hammer the lookup buttons
      const down = Math.floor(sim.time * 5) % 2 === 0;
      rect(
        ctx,
        inspector.x + 10,
        inspector.y - 30 + (down ? 4 : 0),
        14,
        4,
        "#8f6e3c",
      );
      rect(
        ctx,
        inspector.x + 22,
        inspector.y - 28 + (down ? 6 : 0),
        5,
        5,
        inspector.skin,
      );
    },
  });

  for (const c of sim.customers) {
    const cust = c;
    items.push({ y: c.y, draw: () => drawPerson(ctx, cust) });
  }

  if (sim.boss.on) {
    const boss = sim.boss;
    const mood = sim.bossMood;
    const jumping = mood === "happy" && sim.bossDance > 0;
    items.push({
      y: boss.y,
      draw: () => drawBoss(ctx, boss, mood, jumping),
    });
  }

  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();

  if (hiddenStacked > 0) {
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.fillStyle = "#ffd25a";
    ctx.fillText(
      `+${hiddenStacked}`,
      STACK.x + STACK.cols * STACK.colGap + 4,
      STACK.y + 6,
    );
  }

  if (sim.bouncerWave > 0) {
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.fillStyle = "#e08a3c";
    ctx.fillText("FULL!", DOOR.x + 72, H - 52);
  }

  // signs
  drawSign(
    ctx,
    sim,
    480,
    COUNTER_Y - 4,
    "INTAKE / 202",
    `served ${sim.stats.accepted + sim.stats.replayed + sim.stats.conflicts}`,
  );
  drawSign(
    ctx,
    sim,
    INSPECT.x + 10,
    INSPECT.y - 84,
    "IDEMPOTENCY",
    `200:${sim.stats.replayed} 409:${sim.stats.conflicts}`,
  );
  drawSign(
    ctx,
    sim,
    TABLE.x + TABLE.w / 2,
    TABLE.y - 62,
    "OUTBOX WRITE",
    "1 txn",
  );
  drawSign(
    ctx,
    sim,
    STACK.x + 20,
    STACK.y - STACK.maxPerCol * STACK.boxH - 66,
    "QUEUED BACKLOG",
    `${sim.stats.queued}`,
  );
  drawSign(
    ctx,
    sim,
    (BELT.x1 + BELT.x2) / 2 - 30,
    BELT.y - 52,
    "DISPATCH 1s",
    "every 1s",
  );
  drawSign(
    ctx,
    sim,
    MACHINE.x + MACHINE.w / 2,
    MACHINE.y - 64,
    "DB x5 THREADS",
    `busy ${sim.stats.processing}/${sim.threads}`,
  );
  drawSign(
    ctx,
    sim,
    PALLET.x + 60,
    PALLET.y + 38,
    "PROCESSED",
    `${sim.stats.processed}`,
  );
  drawSign(
    ctx,
    sim,
    DOOR.x + 10,
    H - 110,
    "RATE LIMIT",
    `cap:${sim.crowdCap} 429:${sim.stats.limited}`,
  );
  drawSign(
    ctx,
    sim,
    KIOSK.x + 42,
    KIOSK.y - 72,
    "DASHBOARD",
    `polls 1s - ${sim.stats.processed} done`,
  );
  drawSign(
    ctx,
    sim,
    BOOTH.x - 46,
    BOOTH.y - 56,
    "RECONCILER 10s",
    `redriven ${sim.stats.reconciled}`,
  );

  // speech bubbles + emotion marks over everyone's heads
  for (const c of sim.customers) {
    if (c.bubble) {
      drawBubble(
        ctx,
        c.x,
        c.y - CHAR_H,
        c.bubble.text,
        c.bubble.bang ? "#a3312a" : "#2a222c",
      );
      if (c.bubble.bang)
        drawBang(ctx, c.x + CHAR_W, c.y - CHAR_H - 34, sim.time);
    }
  }
  for (const c of sim.customers) {
    if (c.bang > 0) drawBang(ctx, c.x + CHAR_W, c.y - CHAR_H - 8, sim.time);
  }
  for (const w of sim.workers) {
    if (w.bubble) {
      drawBubble(ctx, w.x, w.y - CHAR_H, w.bubble.text, "#2a4a6a");
    }
  }
  sim.cashierBubbles.forEach((b, i) => {
    if (b) drawBubble(ctx, LANES[i], COUNTER_Y - 2 - CHAR_H, b.text, "#6e2a2a");
  });
  for (let i = 0; i < 5; i++) {
    if (sim.cashier422[i] > 0)
      drawBang(ctx, LANES[i] + 22, COUNTER_Y - CHAR_H - 12, sim.time);
  }
  if (sim.inspectorBubble) {
    drawBubble(
      ctx,
      INSPECT.x - 36,
      INSPECT.y + 16 - CHAR_H,
      sim.inspectorBubble.text,
      sim.inspectorBubble.bang ? "#a3312a" : "#2a5a3a",
    );
    if (sim.inspectorBubble.bang)
      drawBang(ctx, INSPECT.x - 6, INSPECT.y - CHAR_H - 2, sim.time);
  }
  if (sim.bouncerBubble) {
    drawBubble(
      ctx,
      DOOR.x + 56,
      H - 22 - CHAR_H,
      sim.bouncerBubble.text,
      "#7a3a1a",
    );
  }
  if (sim.vlad.phase === "gloat") {
    drawBubble(
      ctx,
      sim.vlad.x - 30,
      sim.vlad.y - VLAD_H - 4,
      "I am Vlad the Impaler!",
      "#a3312a",
    );
    drawBang(ctx, sim.vlad.x - 46, sim.vlad.y - VLAD_H + 4, sim.time);
  }

  if (sim.boss.on) {
    drawBubble(
      ctx,
      sim.boss.x,
      sim.boss.y - CHAR_H - 6,
      sim.bossMsg,
      sim.bossMood === "angry" ? "#a3312a" : "#2a6a3a",
    );
    if (sim.bossMood === "angry")
      drawBang(
        ctx,
        sim.boss.x + CHAR_W + 4,
        sim.boss.y - CHAR_H - 40,
        sim.time,
      );
  }

  // trouble callouts: say out loud when a stage is wedged
  const stuckBox = sim.boxes.find((b) => b.state === "machine" && b.stuck);
  if (stuckBox) {
    drawBang(ctx, stuckBox.x + 30, stuckBox.y - 6, sim.time);
    drawBubble(
      ctx,
      MACHINE.x + 60,
      MACHINE.y + 4,
      "Stuck job! Robot will redrive it",
      "#a3312a",
    );
  }
  const beltJam = sim.boxes.some(
    (b) => b.state === "belt" && b.x >= BELT.x2 - 9,
  );
  if (beltJam && sim.stats.processing >= sim.threads) {
    drawBang(ctx, BELT.x2 + 4, BELT.y - 14, sim.time);
    drawBubble(
      ctx,
      BELT.x2 - 60,
      BELT.y - 8,
      "All threads busy - belt waits",
      "#7a4a10",
    );
  }

  // Vlad draws over the whole yard - he must never hide behind the scenery
  drawVlad(ctx, sim.vlad, sim.time);
  for (const box of sim.vlad.taken) drawCrate(ctx, box);

  // smoke puffs around an arrival or departure
  for (const sm of sim.smoke) {
    ctx.globalAlpha = Math.min(0.75, sm.t);
    const size = Math.round(sm.r);
    rect(ctx, sm.x - size / 2, sm.y - size / 2, size, size, "#d8d4dc");
    rect(
      ctx,
      sm.x - size / 2 + 2,
      sm.y - size / 2 + 2,
      size - 4,
      size - 4,
      "#eceaf0",
    );
    ctx.globalAlpha = 1;
  }

  // shredder confetti
  for (const pt of sim.particles) {
    ctx.globalAlpha = Math.min(1, pt.t * 1.6);
    rect(ctx, pt.x, pt.y, 4, 3, pt.c);
    ctx.globalAlpha = 1;
  }

  // floating status texts
  ctx.font = "8px 'Press Start 2P', monospace";
  for (const f of sim.floaters) {
    ctx.globalAlpha = Math.min(1, f.t);
    ctx.fillStyle = OUT;
    ctx.fillText(f.text, f.x + 1, f.y + 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }

  // summon button: a small credit line in the bottom-right corner
  {
    const b = VLAD_BUTTON;
    const busy = sim.vlad.phase !== "away";
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.fillStyle = OUT;
    ctx.fillText("Vladimir Chopine", b.x + 5, b.y + 15);
    ctx.fillStyle = busy ? "#6e5a44" : "#c8b898";
    ctx.fillText("Vladimir Chopine", b.x + 4, b.y + 14);
    if (!busy) rect(ctx, b.x + b.w - 6, b.y + 4, 4, 4, "#a3312a");
  }

  if (holiday) {
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.fillStyle = OUT;
    ctx.fillText("HOLIDAY RUSH!", 17, H - 15);
    ctx.fillStyle = "#ef7a74";
    ctx.fillText("HOLIDAY RUSH!", 16, H - 16);
  }
  if (flaky) {
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.fillStyle = OUT;
    ctx.fillText("FLAKY PROVIDER", 151, H - 15);
    ctx.fillStyle = "#eda45c";
    ctx.fillText("FLAKY PROVIDER", 150, H - 16);
  }
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------
