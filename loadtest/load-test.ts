const API_URL = "http://localhost:3000/api/v1/purchase_requests";
const totalRequests = Number.parseInt(process.argv[2] ?? "500", 10);
const concurrency = Number.parseInt(process.argv[3] ?? "50", 10);
const runId = crypto.randomUUID();
let nextRequest = 0;
let accepted = 0;
let rateLimited = 0;
let failed = 0;
const startedAt = performance.now();
async function worker(workerId: number): Promise<void> {
  while (true) {
    const index = nextRequest++;
    if (index >= totalRequests) {
      return;
    }
    const idempotencyKey = `load-${runId}-${index}`;
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          purchase: {
            customer_ref: `customer-${index % 100}`,
            amount_cents: 1000 + (index % 5000),
          },
        }),
      });
      if (response.status === 202 || response.status === 200) {
        accepted++;
      } else if (response.status === 429) {
        rateLimited++;
      } else {
        failed++;
        console.error(`Worker ${workerId}: HTTP ${response.status}`);
      }
    } catch (error) {
      failed++;
      console.error(`Worker ${workerId}:`, error);
    }
  }
}
const workers = Array.from(
  {
    length: concurrency,
  },
  (_, index) => worker(index),
);
await Promise.all(workers);
const elapsedMs = performance.now() - startedAt;
const elapsedSeconds = elapsedMs / 1000;
console.log("");
console.log("SurgeGuard Load Test");
console.log("--------------------");
console.log(`Requests: ${totalRequests}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Accepted: ${accepted}`);
console.log(`Rate limited: ${rateLimited}`);
console.log(`Failed: ${failed}`);
console.log(`Duration: ${elapsedSeconds.toFixed(2)} sec`);
console.log(
  `Throughput: ${(totalRequests / elapsedSeconds).toFixed(2)} req/sec`,
);
