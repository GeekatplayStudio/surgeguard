export type PurchaseStatus = "queued" | "processing" | "processed" | "failed";
export interface PurchaseRequest {
  id: number;
  idempotency_key: string;
  customer_ref: string;
  amount_cents: number;
  amount_dollars: number;
  status: PurchaseStatus;
  attempt_count: number;
  processing_started_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
}
export interface PurchasesPage {
  purchases: PurchaseRequest[];
  page: number;
  per_page: number;
  total: number;
  has_more: boolean;
}

export interface Metrics {
  purchases: {
    total: number;
    queued: number;
    processing: number;
    processed: number;
    failed: number;
  };
  outbox: {
    pending: number;
    oldest_age_seconds: number;
  };
  server_time: string;
}
