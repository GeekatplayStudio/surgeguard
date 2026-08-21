const API_BASE = "http://localhost:3000/api/v1";
const burstSize = Number.parseInt(process.argv[2] ?? "300", 10);
const maxProcessingAllowed = Number.parseInt(process.argv[3] ?? "10", 10);
const pollWindowMs = Number.parseInt(process.argv[4] ?? "5000", 10);

interface Metrics {
  purchases: {
    total: number;
    queued: number;
    processing: number;
    processed: number;
    failed: number;
  };
  outbox: { pending: number; oldest_age_seconds: number };
}

async function createPurchase(index: number): Promise<number> {
  const response = await fetch(`${API_BASE}/purchase_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `backlog-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      purchase: {
        customer_ref: `backlog-${index}`,
        amount_cents: 1000 + (index % 5000),
      },
    }),
  });
  return response.status;
}

async function getMetrics(): Promise<Metrics> {
  const response = await fetch(`${API_BASE}/metrics`);
  if (!response.ok) {
    throw new Error(`Metrics request failed: ${response.status}`);
  }
  return response.json();
}

console.log("");
console.log("SurgeGuard Backlog Check");
console.log("-------------------------");
console.log(`Bursting ${burstSize} purchase requests...`);

// Scenario: a large burst should create a controlled backlog instead of
// unconstrained downstream concurrency. Intake must never block on, or
// eagerly spawn, downstream processing capacity - it should accumulate a
// queued backlog while `processing` stays bounded by the worker pool
// (config/queue.yml's `transactions` queue thread count).
const startedAt = performance.now();
const statuses = await Promise.all(
  Array.from({ length: burstSize }, (_, index) => createPurchase(index)),
);
const tally = new Map<number, number>();
for (const status of statuses) {
  tally.set(status, (tally.get(status) ?? 0) + 1);
}
const rateLimited = tally.get(429) ?? 0;
const unexpectedFailures = statuses.filter(
  (status) => status !== 200 && status !== 202 && status !== 429,
).length;
console.log(
  `Intake finished in ${((performance.now() - startedAt) / 1000).toFixed(2)}s`,
);
for (const [status, count] of tally) {
  console.log(`  HTTP ${status}: ${count}`);
}
if (rateLimited > 0) {
  console.log(
    `  (${rateLimited} were rate-limited by RequestRateLimiter, not backlog-related - ` +
      "raise RATE_LIMIT_MAX to burst harder without tripping it)",
  );
}
if (unexpectedFailures > 0) {
  console.error(`${unexpectedFailures} intake requests failed unexpectedly.`);
}

let maxProcessing = 0;
let sawProcessed = false;
const deadline = Date.now() + pollWindowMs;

while (Date.now() < deadline) {
  const metrics = await getMetrics();
  maxProcessing = Math.max(maxProcessing, metrics.purchases.processing);
  if (metrics.purchases.processed > 0) {
    sawProcessed = true;
  }
  console.log(
    `  queued=${metrics.purchases.queued} processing=${metrics.purchases.processing} ` +
      `processed=${metrics.purchases.processed} outbox_pending=${metrics.outbox.pending}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.log(`Peak concurrent processing observed: ${maxProcessing}`);

if (unexpectedFailures > 0) {
  console.error("FAIL: intake had unexpected failures (see above).");
  process.exitCode = 1;
} else if (maxProcessing > maxProcessingAllowed) {
  console.error(
    `FAIL: processing concurrency (${maxProcessing}) exceeded the configured bound ` +
      `(${maxProcessingAllowed}); the burst is not backlogging safely.`,
  );
  process.exitCode = 1;
} else if (!sawProcessed) {
  console.error(
    "FAIL: no purchases were processed during the observation window - is a Solid Queue worker running?",
  );
  process.exitCode = 1;
} else {
  console.log(
    `PASS: burst absorbed as a controlled backlog (processing stayed <= ${maxProcessingAllowed}).`,
  );
}
