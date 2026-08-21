import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import * as api from "./api";
import type { Metrics, PurchaseRequest, PurchasesPage } from "./types";

vi.mock("./api");

const mockedApi = vi.mocked(api);

function makeMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    purchases: { total: 0, queued: 0, processing: 0, processed: 0, failed: 0 },
    outbox: { pending: 0, oldest_age_seconds: 0 },
    server_time: new Date().toISOString(),
    ...overrides,
  };
}

function makePurchase(
  overrides: Partial<PurchaseRequest> = {},
): PurchaseRequest {
  return {
    id: 1,
    idempotency_key: "key-1",
    customer_ref: "customer-1",
    amount_cents: 1999,
    amount_dollars: 19.99,
    status: "queued",
    attempt_count: 0,
    processing_started_at: null,
    processed_at: null,
    last_error: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePage(
  purchases: PurchaseRequest[],
  overrides: Partial<PurchasesPage> = {},
): PurchasesPage {
  return {
    purchases,
    page: 1,
    per_page: 50,
    total: purchases.length,
    has_more: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockedApi.getMetrics.mockResolvedValue(makeMetrics());
  mockedApi.getPurchases.mockResolvedValue(makePage([]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App", () => {
  it("submits a purchase using the entered values and the current idempotency key", async () => {
    const user = userEvent.setup();
    mockedApi.createPurchase.mockResolvedValue(makePurchase({ id: 42 }));

    render(<App />);
    await screen.findByLabelText(/idempotency key/i);

    const idempotencyInput = screen.getByLabelText(
      /idempotency key/i,
    ) as HTMLInputElement;
    const key = idempotencyInput.value;

    await user.clear(screen.getByLabelText(/^customer$/i));
    await user.type(screen.getByLabelText(/^customer$/i), "customer-42");
    await user.clear(screen.getByLabelText(/^amount$/i));
    await user.type(screen.getByLabelText(/^amount$/i), "42.50");

    await user.click(screen.getByRole("button", { name: /submit purchase/i }));

    expect(mockedApi.createPurchase).toHaveBeenCalledWith(
      "customer-42",
      4250,
      key,
    );
    expect(
      await screen.findByText(/accepted purchase #42/i),
    ).toBeInTheDocument();
  });

  // Scenario 9 (frontend half): a purchase's status as displayed by the
  // dashboard reflects processing progressing to completion, driven by the
  // same 1s poll the app uses against the real API.
  it("reflects a purchase transitioning from queued to processed as it polls", async () => {
    const purchase = makePurchase({ id: 7, status: "queued" });
    mockedApi.getPurchases.mockResolvedValueOnce(makePage([purchase]));

    render(<App />);

    expect(await screen.findByText("queued")).toBeInTheDocument();

    mockedApi.getPurchases.mockResolvedValueOnce(
      makePage([{ ...purchase, status: "processed" }]),
    );

    // The dashboard polls every 1s; wait out one real interval tick rather
    // than fighting fake timers against findBy*'s real-timer-based polling.
    expect(
      await screen.findByText("processed", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
  }, 10000);

  // Scenario 8 (frontend half): the table is bounded by the API's page size,
  // and "Load more" is how additional pages are fetched, not an unlimited load.
  it("never renders more rows than the API page size and Load more requests the next page", async () => {
    const pageOne = Array.from({ length: 50 }, (_, i) =>
      makePurchase({ id: i + 1 }),
    );
    const pageTwo = Array.from({ length: 10 }, (_, i) =>
      makePurchase({ id: i + 51 }),
    );
    mockedApi.getPurchases.mockImplementation((page = 1) =>
      Promise.resolve(
        page === 1
          ? makePage(pageOne, { page: 1, total: 60, has_more: true })
          : makePage(pageTwo, { page: 2, total: 60, has_more: false }),
      ),
    );

    render(<App />);

    expect(await screen.findByText(/showing 50 of 60/i)).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(51); // header + 50 rows

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText(/showing 60 of 60/i)).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(61);
    expect(
      screen.queryByRole("button", { name: /load more/i }),
    ).not.toBeInTheDocument();
  });
});
