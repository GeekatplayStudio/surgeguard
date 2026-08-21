require "test_helper"

class ProcessPurchaseJobTest < ActiveJob::TestCase
  setup do
    @original_latency = ENV["PAYMENT_LATENCY_MS"]
    @original_failure_rate = ENV["PAYMENT_FAILURE_RATE"]
    ENV["PAYMENT_LATENCY_MS"] = "0"
  end

  teardown do
    ENV["PAYMENT_LATENCY_MS"] = @original_latency
    ENV["PAYMENT_FAILURE_RATE"] = @original_failure_rate
  end

  def create_purchase(status: :queued)
    PurchaseRequest.create!(
      idempotency_key: "key-#{SecureRandom.hex(8)}",
      customer_ref: "customer-1",
      amount_cents: 1999,
      status: status
    )
  end

  test "processes a queued purchase through to processed" do
    ENV["PAYMENT_FAILURE_RATE"] = "0"
    purchase = create_purchase

    ProcessPurchaseJob.perform_now(purchase.id)

    purchase.reload
    assert purchase.processed?
    assert_equal 1, purchase.attempt_count
    assert_nil purchase.processing_started_at
    assert_nil purchase.last_error
    assert_not_nil purchase.processed_at
  end

  # Scenario: a worker retry must not process an already completed purchase again.
  test "does not reprocess an already processed purchase" do
    purchase = create_purchase(status: :processed)
    purchase.update!(processed_at: 1.hour.ago, attempt_count: 3)

    ProcessPurchaseJob.perform_now(purchase.id)

    purchase.reload
    assert purchase.processed?
    assert_equal 3, purchase.attempt_count, "a retry on an already-processed purchase must not run side effects again"
  end

  # Scenario: a simulated worker failure must leave enough durable information to
  # recover accepted work.
  test "a simulated downstream failure reverts the purchase to queued with the error recorded and schedules a retry" do
    ENV["PAYMENT_FAILURE_RATE"] = "1"
    purchase = create_purchase

    ProcessPurchaseJob.perform_now(purchase.id)

    purchase.reload
    assert purchase.queued?, "purchase must remain durably recoverable, not stuck in processing"
    assert_equal 1, purchase.attempt_count
    assert_nil purchase.processing_started_at
    assert_equal "Simulated downstream payment provider failure", purchase.last_error

    assert_enqueued_with(job: ProcessPurchaseJob, args: [ purchase.id ])
  end
end
