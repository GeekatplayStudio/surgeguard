class ReconcileStuckPurchasesJob < ApplicationJob
  queue_as :maintenance

  STUCK_AFTER = 2.minutes

  def perform
    cutoff = Time.current - STUCK_AFTER

    PurchaseRequest
      .processing
      .where(
        "processing_started_at < ?",
        cutoff
      )
      .find_each do |purchase|
        purchase.update!(
          status: :queued,
          processing_started_at: nil,
          last_error: "Recovered from stale processing state"
        )

        OutboxEvent.create!(
          event_type: "purchase.created",
          aggregate_type: "PurchaseRequest",
          aggregate_id: purchase.id,
          payload: {
            purchase_request_id: purchase.id,
            recovery: true
          }
        )
      end
  end
end
