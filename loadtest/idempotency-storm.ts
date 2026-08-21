const API_BASE = "http://localhost:3000/api/v1";
const requestCount = Number.parseInt(process.argv[2] ?? "100", 10);
const idempotencyKey = `storm-${crypto.randomUUID()}`;

async function fireRequest(): Promise<number> {
  const response = await fetch(`${API_BASE}/purchase_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      purchase: {
        customer_ref: "idempotency-storm",
        amount_cents: 2500,
      },
    }),
  });
  return response.status;
}

interface PurchasesPage {
  purchases: Array<{ idempotency_key: string }>;
}

console.log("");
console.log("SurgeGuard Idempotency Storm");
console.log("----------------------------");
console.log(`Requests: ${requestCount}`);
console.log(`Idempotency key: ${idempotencyKey}`);

// Scenario: one hundred simultaneous requests with the same idempotency key
// must create exactly one purchase.
const statuses = await Promise.all(
  Array.from({ length: requestCount }, () => fireRequest()),
);

const tally = new Map<number, number>();
for (const status of statuses) {
  tally.set(status, (tally.get(status) ?? 0) + 1);
}
for (const [status, count] of tally) {
  console.log(`  HTTP ${status}: ${count}`);
}

const listResponse = await fetch(`${API_BASE}/purchase_requests?per_page=200`);
if (!listResponse.ok) {
  throw new Error(`Failed to list purchases: ${listResponse.status}`);
}
const body = (await listResponse.json()) as PurchasesPage;
const matches = body.purchases.filter(
  (purchase) => purchase.idempotency_key === idempotencyKey,
);

console.log(`Matching purchases created: ${matches.length}`);
if (matches.length === 1) {
  console.log("PASS: exactly one purchase was created for the storm.");
} else {
  console.error(`FAIL: expected exactly 1 purchase, found ${matches.length}.`);
  process.exitCode = 1;
}
