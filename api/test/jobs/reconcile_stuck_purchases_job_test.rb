require "test_helper"

class ReconcileStuckPurchasesJobTest < ActiveJob::TestCase
  def create_purchase(processing_started_at:)
    PurchaseRequest.create!(
      idempotency_key: "key-#{SecureRandom.hex(8)}",
      customer_ref: "customer-1",
      amount_cents: 1999,
      status: :processing,
      processing_started_at: processing_started_at
    )
  end

  # Scenario: stale processing records must be reconciled.
  test "resets purchases stuck in processing past the cutoff and redrives them" do
    stuck = create_purchase(processing_started_at: 3.minutes.ago)

    ReconcileStuckPurchasesJob.new.perform

    stuck.reload
    assert stuck.queued?
    assert_nil stuck.processing_started_at
    assert_equal "Recovered from stale processing state", stuck.last_error

    event = OutboxEvent.find_by(aggregate_type: "PurchaseRequest", aggregate_id: stuck.id)
    assert_not_nil event
    assert_equal "purchase.created", event.event_type
    assert event.payload["recovery"]
  end

  test "leaves recently-started processing purchases untouched" do
    recent = create_purchase(processing_started_at: 30.seconds.ago)

    ReconcileStuckPurchasesJob.new.perform

    recent.reload
    assert recent.processing?
    assert_nil recent.last_error
    assert_not OutboxEvent.exists?(aggregate_type: "PurchaseRequest", aggregate_id: recent.id)
  end
end
