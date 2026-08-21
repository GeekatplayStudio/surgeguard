# SurgeGuard

A transaction-intake system built to stay correct and available when traffic
arrives in bursts rather than a steady stream — the holiday-surge problem, where
the failure mode is not "the site is slow" but "we took the customer's money
twice" or "we returned 202 and then lost the work."

SurgeGuard accepts purchase requests over HTTP, durably records each one, and
processes them asynchronously against a (simulated) downstream payment provider.
The whole design follows from one rule: **accepting work and doing work are
separate concerns with separate capacity.** Intake is cheap, non-blocking, and
scales with traffic. Processing is expensive, strictly bounded, and scales with
backlog. Between them sits a transactional outbox, which is what makes a surge
produce a queue instead of an outage.

---

## Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Guarantees, and what enforces them](#guarantees-and-what-enforces-them)
- [Repository layout](#repository-layout)
- [API reference](#api-reference)
- [The dashboard](#the-dashboard)
- [Load scripts](#load-scripts)
- [Running it](#running-it)
- [Configuration](#configuration)
- [Deployment](#deployment)

---

## The problem

A naive intake endpoint does the payment call inline. Under a surge that gives
you three failures at once:

1. **Unbounded downstream concurrency.** 500 concurrent requests become 500
   concurrent calls to the payment provider, which rate-limits or falls over.
2. **Lost work.** The request thread dies mid-flight — deploy, OOM, timeout —
   and the accepted purchase simply evaporates. The customer saw a success.
3. **Duplicate charges.** The client retries a request whose response it never
   received, and gets charged twice.

Retries and a job queue alone don't fix these. A job queue introduces a fourth
problem: the gap between "row committed" and "job enqueued," where a crash
loses work that the database says was accepted.

SurgeGuard closes all four.

## How it works

```
  POST /api/v1/purchase_requests
  (Idempotency-Key: <key>)
            │
            ▼
  ┌──────────────────────────────────────────────┐
  │  ONE database transaction                    │
  │    purchase_requests row   (status: queued)  │
  │    outbox_events row       (purchase.created)│
  └──────────────────────────────────────────────┘
            │
            │  202 Accepted — returns immediately,
            │  never waits on the payment provider
            ▼
  ┌──────────────────────────────────────────────┐
  │  OutboxDispatchJob   (every 1s)              │
  │  claims pending events with                  │
  │  SELECT … FOR UPDATE SKIP LOCKED             │
  └──────────────────────────────────────────────┘
            │
            ▼
  ┌──────────────────────────────────────────────┐
  │  ProcessPurchaseJob                          │
  │  bounded worker pool (5 threads/worker)      │
  │  serialized per purchase_request_id          │
  │    queued → processing → processed           │
  └──────────────────────────────────────────────┘
            │
            │  on failure: back to queued,
            │  last_error recorded, retried
            ▼
  ┌──────────────────────────────────────────────┐
  │  ReconcileStuckPurchasesJob   (every 30s)    │
  │  redrives anything abandoned mid-flight      │
  └──────────────────────────────────────────────┘
```

**Intake.** `POST /purchase_requests` requires an `Idempotency-Key` header. The
purchase row and its outbox event are written in a *single transaction*, then
the request returns `202 Accepted`. It never calls the payment provider, so
intake latency is a database write regardless of how backed-up processing is.

**Dispatch.** A recurring job claims pending outbox events with
`SELECT … FOR UPDATE SKIP LOCKED` and turns each into a `ProcessPurchaseJob`.
Because the claim is a row-level lock that concurrent claimants skip rather than
block on, any number of dispatcher processes can run at once without two of them
ever claiming the same event.

**Processing.** `ProcessPurchaseJob` moves the purchase through
`queued → processing → processed`, stamping `processing_started_at` and
`processed_at`. Failures roll the purchase back to `queued` with `last_error`
populated, then re-raise so the queue's exponential backoff takes over.

**Recovery.** If a worker dies while a purchase is `processing`, nothing else
would ever touch that row. `ReconcileStuckPurchasesJob` finds purchases stuck in
`processing` past a threshold, returns them to `queued`, and emits a fresh
outbox event to redrive them.

## Guarantees, and what enforces them

Each property is enforced by a database primitive rather than application
bookkeeping, which is what makes them hold across many processes and machines:

| Guarantee | Mechanism |
| --- | --- |
| A given `Idempotency-Key` creates **exactly one** purchase, no matter how many concurrent requests carry it | Unique index on `purchase_requests.idempotency_key`, plus `rescue ActiveRecord::RecordNotUnique` in the controller, which returns the *existing* record. Deliberately **not** a Rails uniqueness validation — that is a check-then-insert race that would intercept duplicates before the database ever adjudicated them. |
| Reusing a key with a **different payload** is rejected rather than silently returning the wrong record | The duplicate handler compares `customer_ref` and `amount_cents` against the stored row and returns `409 Conflict` on mismatch. |
| Accepted work is **never lost** between HTTP response and job execution | The outbox event is written in the same transaction as the purchase. If the process dies before dispatch, the event is still there; if the transaction rolls back, neither exists. There is no window where one is true and the other isn't. |
| Concurrent dispatchers **never double-claim** an event | `FOR UPDATE SKIP LOCKED`. |
| A purchase is **never processed twice concurrently**, and a retry never re-charges a completed purchase | `limits_concurrency(to: 1, key: purchase_request_id)` serializes per purchase at the queue level; an early `return if purchase.processed?` guard makes redelivery a no-op. |
| A surge produces a **bounded backlog**, not unbounded downstream load | Downstream concurrency is exactly `transactions` pool threads × worker count (5 per worker by default). Everything else waits in `queued`. Intake is unaffected. |
| Work abandoned mid-flight is **recovered automatically** | `ReconcileStuckPurchasesJob`, on a recurring schedule. |
| A single client cannot monopolize intake | A Redis token-bucket rate limiter, applied per IP. It **fails open** if Redis is unreachable — losing rate limiting is strictly better than losing intake. |
| Listing purchases **cannot** be made to return an unbounded result set | `page`/`per_page` with a server-side hard cap, applied regardless of what the client asks for. |

## Repository layout

```
surgeguard/
├── api/                 Rails 8.1 API (Ruby 3.4) — intake, jobs, metrics
│   ├── app/
│   │   ├── controllers/api/v1/   purchase_requests, metrics
│   │   └── models/               PurchaseRequest, OutboxEvent
│   ├── jobs/                     ProcessPurchaseJob, OutboxDispatchJob,
│   │                             ReconcileStuckPurchasesJob
│   ├── services/                 RequestRateLimiter (Redis token bucket)
│   └── config/
│       ├── queue.yml             Solid Queue pools — the concurrency bound
│       └── recurring.yml         outbox dispatch + reconciliation schedules
├── dashboard/           React 19 + TypeScript + Vite operations dashboard
├── loadtest/            TypeScript scripts that generate real surges
├── docs/
│   └── aws-architecture.md       Production topology and AWS mapping
└── docker-compose.yml   Full local stack: postgres, redis, api, worker, dashboard
```

Two details worth knowing:

- **`api/jobs/` and `api/services/` sit outside `app/`** and are added to the
  autoload paths in `config/application.rb`. Jobs and the rate limiter are the
  substance of this system, not incidental plumbing, so they are surfaced at the
  top level rather than buried.
- **Solid Queue runs on a separate `queue` database** (`QUEUE_DATABASE_URL`), so
  queue churn doesn't compete with transactional data for the same tables.

## API reference

### `POST /api/v1/purchase_requests`

Creates a purchase. Requires an `Idempotency-Key` header.

```bash
curl -X POST http://localhost:3000/api/v1/purchase_requests \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{"purchase":{"customer_ref":"customer-1","amount_cents":1999}}'
```

| Status | Meaning |
| --- | --- |
| `202 Accepted` | Created and queued. |
| `200 OK` | Key already seen with an identical payload — the original record is returned. Safe to retry indefinitely. |
| `400 Bad Request` | `Idempotency-Key` header missing. |
| `409 Conflict` | Key already used with a *different* payload. |
| `422 Unprocessable Entity` | Validation failed (e.g. non-positive amount). |
| `429 Too Many Requests` | Rate limit exceeded for this IP. |

### `GET /api/v1/purchase_requests`

Paginated listing, newest first. Accepts `page` (default `1`) and `per_page`
(default `50`, hard-capped at `200` server-side). Returns
`{ purchases, page, per_page, total, has_more }`.

### `GET /api/v1/metrics`

Operational snapshot — purchase counts by status, pending outbox depth, and the
age of the oldest unpublished event. These are the autoscaling signals: backlog
*age* is the honest measure of whether processing is keeping up, since a small
but stalled backlog is worse than a large one that's draining.

### `GET /up`

Rails health check, used as the container/load-balancer probe.

## The dashboard

A React operations console that polls `/metrics` and the purchase list once a
second, showing live counts by status, outbox backlog depth and age, and a table
of recent purchases with their status and attempt counts.

It also submits purchases, with the idempotency key exposed as an **editable
field**. That is the point of the UI, not a debug affordance: you can resubmit
the same key and watch the API return the original record instead of creating a
second one, or change the amount and watch it return `409`. The table is paged
via "Load more" rather than loading everything, so it stays bounded no matter how
many purchases exist.

## Load scripts

Three TypeScript scripts in `loadtest/` that drive a *running* stack. They exist
because the interesting properties here are about real concurrency and real
queue behaviour, which can only be observed against live processes:

| Script | What it demonstrates |
| --- | --- |
| `load-test.ts` | Sustained throughput at a chosen concurrency; reports accepted / rate-limited / failed and elapsed time. |
| `idempotency-storm.ts` | Fires N simultaneous requests all sharing **one** idempotency key, then verifies exactly one purchase exists. |
| `backlog-check.ts` | Bursts a large batch, then polls `/metrics` to show `processing` staying pinned to the worker-pool size while `queued` absorbs the surge — the controlled-backlog property, observed rather than asserted in theory. |

```bash
cd loadtest
npx tsx load-test.ts 500 50          # 500 requests, 50 concurrent
npx tsx idempotency-storm.ts 100     # 100 requests, one shared key
npx tsx backlog-check.ts 300 10      # 300-request burst, expect processing ≤ 10
```

Note that `backlog-check.ts` will report rate-limited requests separately —
bursting past `RATE_LIMIT_MAX` trips the limiter, which is correct behaviour
rather than a failure. Raise it to burst harder.

## Running it

### With Docker (everything at once)

```bash
docker compose up --build
```

Brings up Postgres, Redis, the API, a Solid Queue worker, and the dashboard.
Dashboard on <http://localhost:5173>, API on <http://localhost:3000>.

The `api` and `worker` services run the **same image** with different commands —
mirroring production, where Puma and the queue workers are separate services
scaled on different signals.

### Natively

Requires Ruby 3.4, Node 22, PostgreSQL, and Redis running locally.

```bash
# API
cd api
bundle install
bin/rails db:prepare
bin/rails server                 # http://localhost:3000

# Worker — in a second terminal. Nothing is processed without this:
cd api && bin/jobs start

# Dashboard — in a third terminal
cd dashboard
npm install
npm run dev                      # http://localhost:5173
```

The worker is not optional. Without it, purchases are accepted and durably
stored but stay `queued` forever, since dispatch and processing both run through
Solid Queue.

## Configuration

All configuration is environment variables, so nothing differs between local,
compose, and production except their values.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | local socket | Primary Postgres database. |
| `QUEUE_DATABASE_URL` | local socket | Solid Queue's separate database. |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Rate limiter backend. |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins. |
| `RAILS_MAX_THREADS` | `5` | Puma threads / DB pool size. |
| `RATE_LIMIT_MAX` | `200` | Requests per IP per 10-second window. |
| `PAYMENT_LATENCY_MS` | `250` | Simulated downstream latency. |
| `PAYMENT_FAILURE_RATE` | `0` | Simulated failure probability, `0`–`1`. Set to e.g. `0.3` to watch retry and recovery behaviour under a flaky provider. |
| `VITE_API_BASE` | `http://localhost:3000/api/v1` | API origin baked into the dashboard build. |

Downstream concurrency is set in `api/config/queue.yml` (the `transactions` pool
thread count), and the recurring dispatch/reconciliation schedules live in
`api/config/recurring.yml`.

## Deployment

[`docs/aws-architecture.md`](docs/aws-architecture.md) maps every local service
onto AWS — CloudFront/S3, ALB, ECS Fargate, RDS, ElastiCache, CloudWatch — and
covers which autoscaling signals drive which service, what carries over
unchanged, and what has to be adapted.

The short version: because the guarantees are enforced by Postgres primitives
rather than in-process state, moving to AWS requires **no application code
changes** — only environment variables and task definitions.
