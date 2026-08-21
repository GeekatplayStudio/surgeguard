require "test_helper"

class PurchaseLifecycleTest < ActionDispatch::IntegrationTest
  setup do
    ENV["PAYMENT_LATENCY_MS"] = "0"
    ENV["PAYMENT_FAILURE_RATE"] = "0"
    @original_allowed = RequestRateLimiter.method(:allowed?)
    RequestRateLimiter.define_singleton_method(:allowed?) { |_key| true }
  end

  teardown do
    RequestRateLimiter.define_singleton_method(:allowed?, @original_allowed)
  end

  # Scenario: end-to-end tests should cover the path from HTTP intake through
  # processing and displayed status.
  test "a purchase moves from HTTP intake through processing to a processed status the API reports" do
    post "/api/v1/purchase_requests",
      params: { purchase: { customer_ref: "customer-e2e", amount_cents: 2500 } },
      headers: { "Idempotency-Key" => "e2e-#{SecureRandom.hex(8)}" },
      as: :json
    assert_response :accepted
    purchase_id = JSON.parse(response.body)["id"]

    get "/api/v1/metrics"
    metrics_before = JSON.parse(response.body)
    assert_equal 1, metrics_before["outbox"]["pending"]
    assert_equal 1, metrics_before["purchases"]["queued"]

    # The recurring OutboxDispatchJob claims the event and enqueues processing.
    OutboxDispatchJob.new.perform
    perform_enqueued_jobs

    get "/api/v1/purchase_requests"
    purchase = JSON.parse(response.body)["purchases"].find { |row| row["id"] == purchase_id }
    assert_equal "processed", purchase["status"]
    assert_equal 25.0, purchase["amount_dollars"]

    get "/api/v1/metrics"
    metrics_after = JSON.parse(response.body)
    assert_equal 0, metrics_after["outbox"]["pending"]
    assert_equal 1, metrics_after["purchases"]["processed"]
    assert_equal 0, metrics_after["purchases"]["queued"]
  end

  # Scenario: a large burst should create a controlled backlog instead of
  # unconstrained downstream concurrency. Intake (HTTP -> DB -> outbox dispatch)
  # must never block on, or eagerly spawn, downstream processing capacity: it
  # should just accumulate a queued backlog.
  test "a burst of intake enqueues processing work without running any of it inline" do
    burst_size = 150

    burst_size.times do |n|
      post "/api/v1/purchase_requests",
        params: { purchase: { customer_ref: "customer-burst-#{n}", amount_cents: 1000 + n } },
        headers: { "Idempotency-Key" => "burst-#{SecureRandom.hex(8)}" },
        as: :json
      assert_response :accepted
    end

    assert_equal burst_size, PurchaseRequest.queued.count
    assert_equal 0, PurchaseRequest.processing.count
    assert_equal 0, PurchaseRequest.processed.count

    while OutboxEvent.pending.exists?
      OutboxDispatchJob.new.perform
    end

    # Dispatch enqueues processing jobs but never executes them inline -
    # they only backlog into the job queue, bounded by config/queue.yml's
    # worker thread count, not by however large the burst was.
    assert_equal burst_size, enqueued_jobs.count { |job| job[:job] == ProcessPurchaseJob }
    assert_equal burst_size, PurchaseRequest.queued.count
    assert_equal 0, PurchaseRequest.processing.count
  end
end
