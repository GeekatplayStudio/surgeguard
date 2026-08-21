import { useCallback, useEffect, useState } from "react";
import { createPurchase, getMetrics, getPurchases } from "./api";
import type { Metrics, PurchaseRequest } from "./types";
import "./App.css";
const PER_PAGE = 50;
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
function App() {
  const [customerRef, setCustomerRef] = useState("customer-100");
  const [amount, setAmount] = useState("19.99");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey());
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRequest[]>([]);
  const [loadedPages, setLoadedPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const pageRequests = Array.from({ length: loadedPages }, (_, index) =>
        getPurchases(index + 1, PER_PAGE),
      );
      const [nextMetrics, pages] = await Promise.all([
        getMetrics(),
        Promise.all(pageRequests),
      ]);
      setMetrics(nextMetrics);
      setPurchases(pages.flatMap((page) => page.purchases));
      const lastPage = pages[pages.length - 1];
      setTotal(lastPage.total);
      setHasMore(lastPage.has_more);
    } catch (error) {
      console.error(error);
    }
  }, [loadedPages]);
  function loadMorePurchases() {
    setLoadedPages((current) => current + 1);
  }
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);
  async function submitPurchase() {
    const amountNumber = Number.parseFloat(amount);
    if (Number.isNaN(amountNumber) || amountNumber <= 0) {
      setMessage("Enter a valid positive amount.");
      return;
    }
    const amountCents = Math.round(amountNumber * 100);
    setSubmitting(true);
    setMessage("");
    try {
      const purchase = await createPurchase(
        customerRef,
        amountCents,
        idempotencyKey,
      );
      setMessage(`Accepted purchase #${purchase.id}`);
      setIdempotencyKey(newIdempotencyKey());
      await refresh();
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message);
      } else {
        setMessage("Unknown error");
      }
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <main className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">SurgeGuard</p>
          <h1>Holiday Transaction Operations</h1>
          <p className="subtitle">
            Durable intake, controlled concurrency, idempotent processing, and
            queue recovery.
          </p>
        </div>
      </header>
      <section className="metrics-grid">
        <MetricCard label="Total" value={metrics?.purchases.total ?? 0} />
        <MetricCard label="Queued" value={metrics?.purchases.queued ?? 0} />
        <MetricCard
          label="Processing"
          value={metrics?.purchases.processing ?? 0}
        />
        <MetricCard
          label="Processed"
          value={metrics?.purchases.processed ?? 0}
        />
        <MetricCard
          label="Outbox backlog"
          value={metrics?.outbox.pending ?? 0}
        />
        <MetricCard
          label="Oldest backlog"
          value={`${metrics?.outbox.oldest_age_seconds ?? 0} sec`}
        />
      </section>
      <section className="panel">
        <h2>Create purchase</h2>
        <div className="form-grid">
          <label>
            Customer
            <input
              value={customerRef}
              onChange={(event) => setCustomerRef(event.target.value)}
            />
          </label>
          <label>
            Amount
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="wide">
            Idempotency key
            <input
              value={idempotencyKey}
              onChange={(event) => setIdempotencyKey(event.target.value)}
            />
          </label>
        </div>
        <div className="button-row">
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              void submitPurchase();
            }}
          >
            {submitting ? "Submitting..." : "Submit purchase"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setIdempotencyKey(newIdempotencyKey())}
          >
            New idempotency key
          </button>
        </div>
        {message && <p className="message">{message}</p>}
      </section>
      <section className="panel">
        <div className="table-header">
          <h2>Latest purchases</h2>
          <span>
            Showing {purchases.length} of {total}
          </span>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((purchase) => (
                <tr key={purchase.id}>
                  <td>{purchase.id}</td>
                  <td>{purchase.customer_ref}</td>
                  <td>${purchase.amount_dollars.toFixed(2)}</td>
                  <td>
                    <StatusBadge status={purchase.status} />
                  </td>
                  <td>{purchase.attempt_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={loadMorePurchases}
            >
              Load more
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
interface MetricCardProps {
  label: string;
  value: number | string;
}
function MetricCard({ label, value }: MetricCardProps) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
interface StatusBadgeProps {
  status: "queued" | "processing" | "processed" | "failed";
}
function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`status status-${status}`}>{status}</span>;
}
export default App;
