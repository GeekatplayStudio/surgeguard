# SurgeGuard on AWS

How each piece of the local stack (`docker-compose.yml`) maps onto AWS, and which
parts move unchanged versus which need adaptation.

## Topology

```
                        ┌─────────────────────┐
   browser ────────────▶│ CloudFront          │
                        │  ├── S3 (dashboard) │  static React build
                        │  └── /api/* ──┐     │
                        └───────────────┼─────┘
                                        ▼
                                ┌──────────────┐
                                │ ALB (HTTPS)  │
                                └──────┬───────┘
                                       ▼
                   ┌───────────────────────────────────┐
                   │ ECS Fargate service: api (Puma)   │  N tasks, scaled on RPS/CPU
                   └───────────────┬───────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌────────────────┐        ┌────────────────┐         ┌──────────────────┐
│ RDS PostgreSQL │        │  ElastiCache   │         │   CloudWatch     │
│  (Multi-AZ)    │        │ (Valkey/Redis) │         │ logs + metrics   │
└───────┬────────┘        └────────────────┘         └──────────────────┘
        │  same DB: purchase_requests, outbox_events, solid_queue_*
        ▼
┌────────────────────────────────────────┐
│ ECS Fargate service: worker (bin/jobs) │  scaled on outbox/queue depth
└────────────────────────────────────────┘
```

## Service-by-service mapping

| Local (compose)              | AWS                                        | Notes |
| ---------------------------- | ------------------------------------------ | ----- |
| `dashboard` (Vite dev server)| **S3 + CloudFront**                        | Production is a static `npm run build` artifact, not a container — hence `dashboard/Dockerfile.dev` only. `VITE_API_BASE` is baked at build time. |
| `api` (Puma)                 | **ALB → ECS Fargate service**              | Built from the existing production `api/Dockerfile` (Thruster + Puma, non-root, `RAILS_ENV=production`). Health check target: `GET /up`. |
| `worker` (`bin/jobs start`)  | **ECS Fargate service (same image)**       | Same task image, `command` overridden to `bin/jobs start`. Separate service so it scales independently of web traffic. |
| `postgres`                   | **RDS for PostgreSQL** (Multi-AZ)          | 1:1. `DATABASE_URL` / `QUEUE_DATABASE_URL` point at the RDS endpoint; credentials from Secrets Manager. |
| `redis`                      | **ElastiCache (Valkey or Redis OSS)**      | 1:1. Only used by `RequestRateLimiter`, which fails open if unreachable — so an ElastiCache blip degrades rate limiting rather than taking intake down. |
| container stdout             | **CloudWatch Logs** (`awslogs` log driver) | `RAILS_LOG_TO_STDOUT=1`; Rails 8 emits structured logs with query-log tags already enabled. |
| `GET /api/v1/metrics`        | **CloudWatch custom metrics**              | Backlog/queue-depth gauges; see autoscaling below. |

## What moves unchanged

The durability design is deliberately built on plain Postgres primitives, so
none of it needs rewriting for AWS:

- **Idempotent intake** — a unique index on `purchase_requests.idempotency_key`
  plus `rescue ActiveRecord::RecordNotUnique`. This is a database constraint,
  so it holds across any number of ECS tasks; there is no in-process state to
  make sticky and no coordination service to add.
- **Transactional outbox** — the purchase row and its `outbox_events` row are
  written in one transaction, so accepted work can never be lost between
  "HTTP 202 returned" and "job enqueued".
- **`SELECT ... FOR UPDATE SKIP LOCKED`** in `OutboxDispatchJob` works
  identically on RDS. Multiple worker tasks can dispatch concurrently without
  double-claiming rows — this is what makes the worker service horizontally
  scalable.
- **`limits_concurrency(to: 1, key: purchase_request_id)`** in
  `ProcessPurchaseJob` is enforced by Solid Queue in the database, not per
  process, so per-purchase serialization survives running many worker tasks.
- **Stuck-work recovery** — `ReconcileStuckPurchasesJob` runs on a Solid Queue
  recurring schedule and redrives purchases abandoned mid-flight. On ECS this
  is what covers a task being killed by a deploy, a scale-in event, or a spot
  interruption.

Net effect: **no application code changes** are required to move from compose
to ECS. The delta is environment variables (`DATABASE_URL`,
`QUEUE_DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS`, `RAILS_MASTER_KEY`) and the
task/service definitions.

## What needs adaptation

- **Recurring jobs must run in exactly one place.** `config/recurring.yml`
  schedules outbox dispatch every second and reconciliation every 30 seconds.
  Solid Queue's scheduler will elect a single supervisor, but the safe
  configuration is a dedicated single-task ECS service running the scheduler
  (`bin/jobs start` with a scheduler-only `config/queue.yml` profile), with the
  autoscaled worker service running worker pools only. Otherwise every scaled
  worker task re-registers the same recurring tasks.
- **`config/queue.yml` thread counts become a capacity contract.** Downstream
  concurrency is `transactions_threads × worker_task_count` (currently 5 per
  task). This is the bound that `loadtest/backlog-check.ts` asserts, and it is
  what protects the payment provider from a surge — it must be set with the
  provider's rate limit in mind, not just the database's.
- **CORS/origins.** `CORS_ORIGINS` moves from `http://localhost:5173` to the
  CloudFront domain. Alternatively, route `/api/*` through the same CloudFront
  distribution to the ALB (shown in the diagram) so the dashboard and API are
  same-origin and CORS drops out entirely.
- **Database connection budget.** `RAILS_MAX_THREADS` × api tasks + worker
  threads × worker tasks must stay under the RDS `max_connections` for the
  instance class. Past a couple dozen tasks this wants RDS Proxy in front.
- **Secrets.** `config/master.key` is a local file; in ECS it becomes a Secrets
  Manager secret injected as `RAILS_MASTER_KEY` via the task definition's
  `secrets` block (never `environment`).

## Autoscaling signals

The `/api/v1/metrics` endpoint already exposes exactly the right signals; ship
them to CloudWatch and drive Application Auto Scaling target-tracking policies:

| Metric (from `/metrics`)      | Scales            | Why |
| ----------------------------- | ----------------- | --- |
| `outbox.pending`              | worker service    | Direct measure of undispatched accepted work. |
| `outbox.oldest_age_seconds`   | worker service    | Catches a small-but-stalled backlog that a count alone hides — the better alarm of the two. |
| `purchases.queued`            | worker service    | Depth of work waiting on the `transactions` pool. |
| ALB `RequestCountPerTarget`   | api service       | Intake is cheap and non-blocking, so it scales on traffic, not on backlog. |
| `purchases.failed` (rate)     | *alarm, not scale*| Rising failures mean the downstream provider is unhealthy; adding workers makes that worse. |

That last row is the point of the whole design: intake scales on traffic while
processing scales on backlog, and the two are decoupled by the outbox — which
is why a surge produces a queue rather than an outage.

## Optional: SQS instead of the DB-backed queue

The outbox pattern is intentionally queue-agnostic. To move off Solid Queue:

- Keep `purchase_requests` and `outbox_events` in RDS exactly as they are — the
  transactional-write guarantee is the part worth keeping, and it depends on the
  outbox table living in the same database as the business data.
- Replace only `OutboxDispatchJob#publish`, so instead of
  `ProcessPurchaseJob.perform_later` it calls `sqs.send_message`. The
  `FOR UPDATE SKIP LOCKED` claim loop stays; it is now the SQS *producer*.
- Consumers read from SQS with a visibility timeout ≥ the payment-provider
  timeout, and a redrive policy to a DLQ after N receives.
- **Trade-off:** SQS gives at-least-once delivery but no equivalent of
  `limits_concurrency(to: 1, key: ...)`. Per-purchase serialization would have to
  be rebuilt with an SQS FIFO queue using `purchase_request_id` as the message
  group ID, or with a conditional write/lock. The existing
  `return if purchase.processed?` guard in `ProcessPurchaseJob` already makes
  redelivery safe, so at-least-once is tolerable either way.

The honest recommendation for this system's scale: stay on Solid Queue. It is
one fewer service to operate, the backlog is queryable with SQL, and Postgres
is already a hard dependency. SQS earns its place when queue throughput starts
competing with transactional load for database IO.
