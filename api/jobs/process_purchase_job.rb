class ProcessPurchaseJob < ApplicationJob
  queue_as :transactions

  limits_concurrency(
    to: 1,
    key: ->(purchase_request_id) { purchase_request_id },
    duration: 5.minutes
  )

  retry_on StandardError,
    wait: :polynomially_longer,
    attempts: 5

  def perform(purchase_request_id)
    purchase = PurchaseRequest.find(
      purchase_request_id
    )

    return if purchase.processed?

    purchase.update!(
      status: :processing,
      attempt_count: purchase.attempt_count + 1,
      processing_started_at: Time.current,
      last_error: nil
    )

    simulate_payment_provider!

    purchase.update!(
      status: :processed,
      processed_at: Time.current,
      processing_started_at: nil,
      last_error: nil
    )
  rescue StandardError => error
    if purchase
      purchase.update!(
        status: :queued,
        processing_started_at: nil,
        last_error: error.message
      )
    end

    raise
  end

  private

  def simulate_payment_provider!
    latency_ms = ENV.fetch(
      "PAYMENT_LATENCY_MS",
      250
    ).to_i

    sleep(latency_ms / 1000.0)

    failure_rate = ENV.fetch(
      "PAYMENT_FAILURE_RATE",
      "0"
    ).to_f

    if rand < failure_rate
      raise "Simulated downstream payment provider failure"
    end
  end
end
