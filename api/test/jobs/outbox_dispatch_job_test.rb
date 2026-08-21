require "test_helper"

class OutboxDispatchJobTest < ActiveJob::TestCase
  def create_purchase
    PurchaseRequest.create!(
      idempotency_key: "key-#{SecureRandom.hex(8)}",
      customer_ref: "customer-1",
      amount_cents: 1999
    )
  end

  def create_pending_event(purchase)
    OutboxEvent.create!(
      event_type: "purchase.created",
      aggregate_type: "PurchaseRequest",
      aggregate_id: purchase.id,
      payload: { purchase_request_id: purchase.id }
    )
  end

  test "publishes a pending event and enqueues purchase processing" do
    purchase = create_purchase
    event = create_pending_event(purchase)

    OutboxDispatchJob.new.perform

    event.reload
    assert_not_nil event.published_at
    assert_equal 1, event.attempt_count
    assert_enqueued_with(job: ProcessPurchaseJob, args: [ purchase.id ])
  end

  test "an unknown event type is recorded as an error without raising" do
    purchase = create_purchase
    event = OutboxEvent.create!(
      event_type: "purchase.mystery",
      aggregate_type: "PurchaseRequest",
      aggregate_id: purchase.id
    )

    assert_nothing_raised { OutboxDispatchJob.new.perform }

    event.reload
    assert_nil event.published_at
    assert_equal 1, event.attempt_count
    assert_match(/Unknown outbox event/, event.last_error)
  end

  # Scenario: outbox dispatchers running concurrently must not repeatedly claim the
  # same rows. Runs several real dispatcher instances from separate threads (each
  # gets its own DB connection) against the same batch of pending events, directly
  # exercising the `SELECT ... FOR UPDATE SKIP LOCKED` claim in perform.
  test "concurrent dispatchers do not double-claim the same events" do
    event_count = 40
    dispatcher_count = 8
    events = Array.new(event_count) { create_pending_event(create_purchase) }

    threads = Array.new(dispatcher_count) do
      Thread.new { OutboxDispatchJob.new.perform }
    end
    threads.each(&:join)

    published = OutboxEvent.where(id: events.map(&:id))
    assert_equal event_count, published.where.not(published_at: nil).count
    published.each do |event|
      assert_equal 1, event.attempt_count, "event #{event.id} was claimed more than once"
    end

    enqueued_purchase_ids = enqueued_jobs
      .select { |job| job[:job] == ProcessPurchaseJob }
      .map { |job| job[:args].first }
    assert_equal event_count, enqueued_purchase_ids.size
    assert_equal enqueued_purchase_ids.uniq.size, enqueued_purchase_ids.size,
      "the same purchase was enqueued for processing more than once"
  end
end
