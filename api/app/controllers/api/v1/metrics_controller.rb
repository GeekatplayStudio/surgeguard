module Api
  module V1
    class MetricsController < ApplicationController
      def show
        oldest_event = OutboxEvent
          .pending
          .order(:created_at)
          .first

        oldest_age =
          if oldest_event
            (Time.current - oldest_event.created_at).round
          else
            0
          end

        render json: {
          purchases: {
            total: PurchaseRequest.count,
            queued: PurchaseRequest.queued.count,
            processing: PurchaseRequest.processing.count,
            processed: PurchaseRequest.processed.count,
            failed: PurchaseRequest.failed.count
          },
          outbox: {
            pending: OutboxEvent.pending.count,
            oldest_age_seconds: oldest_age
          },
          server_time: Time.current
        }
      end
    end
  end
end
