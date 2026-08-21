class OutboxDispatchJob < ApplicationJob
  queue_as :maintenance

  BATCH_SIZE = 100

  def perform
    OutboxEvent.transaction do
      events = OutboxEvent
        .pending
        .order(:id)
        .limit(BATCH_SIZE)
        .lock("FOR UPDATE SKIP LOCKED")

      events.each do |event|
        publish(event)
      end
    end
  end

  private

  def publish(event)
    case event.event_type
    when "purchase.created"
      ProcessPurchaseJob.perform_later(
        event.aggregate_id
      )
    else
      raise "Unknown outbox event: #{event.event_type}"
    end

    event.update!(
      published_at: Time.current,
      attempt_count: event.attempt_count + 1,
      last_error: nil
    )
  rescue StandardError => error
    event.update!(
      attempt_count: event.attempt_count + 1,
      last_error: error.message
    )

    Rails.logger.error(
      "Outbox publish failed for event #{event.id}: #{error.message}"
    )
  end
end
