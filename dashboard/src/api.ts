import type { Metrics, PurchaseRequest, PurchasesPage } from "./types";
// Overridable so the containerized dashboard can be pointed at a different
// API origin (compose, staging, CloudFront-fronted ALB) at build time.
const API_BASE =
  import.meta.env.VITE_API_BASE ?? "http://localhost:3000/api/v1";
export async function getMetrics(): Promise<Metrics> {
  const response = await fetch(`${API_BASE}/metrics`);
  if (!response.ok) {
    throw new Error(`Metrics request failed: ${response.status}`);
  }
  return response.json();
}
export async function getPurchases(
  page: number = 1,
  perPage: number = 50,
): Promise<PurchasesPage> {
  const response = await fetch(
    `${API_BASE}/purchase_requests?page=${page}&per_page=${perPage}`,
  );
  if (!response.ok) {
    throw new Error(`Purchase request failed: ${response.status}`);
  }
  return response.json();
}
export async function createPurchase(
  customerRef: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<PurchaseRequest> {
  const response = await fetch(`${API_BASE}/purchase_requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      purchase: {
        customer_ref: customerRef,
        amount_cents: amountCents,
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return body;
}
