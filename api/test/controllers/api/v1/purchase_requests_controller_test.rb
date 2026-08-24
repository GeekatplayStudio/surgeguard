require "test_helper"

module Api
  module V1
    class PurchaseRequestsControllerTest < ActionDispatch::IntegrationTest
      setup do
        # Rate limiting is exercised by RequestRateLimiter's own concerns, not by these
        # tests; stub it out so a burst of concurrent requests in one test method can't
        # flake because of leftover Redis counters from another test in the same window.
        @original_allowed = RequestRateLimiter.method(:allowed?)
        RequestRateLimiter.define_singleton_method(:allowed?) { |_key| true }
      end

      teardown do
        RequestRateLimiter.define_singleton_method(:allowed?, @original_allowed)
      end

      def purchase_payload(customer_ref: "customer-1", amount_cents: 1999)
        { purchase: { customer_ref: customer_ref, amount_cents: amount_cents } }
      end

      test "allows the dashboard when Vite is opened through 127.0.0.1" do
        get "/api/v1/purchase_requests", headers: { "Origin" => "http://127.0.0.1:5173" }

        assert_response :success
        assert_equal "http://127.0.0.1:5173", response.headers["Access-Control-Allow-Origin"]
      end

      test "create requires an Idempotency-Key header" do
        post "/api/v1/purchase_requests", params: purchase_payload, as: :json

        assert_response :bad_request
        assert_equal "Idempotency-Key header is required", JSON.parse(response.body)["error"]
      end

      test "create accepts a purchase and writes an outbox event" do
        post "/api/v1/purchase_requests",
          params: purchase_payload,
          headers: { "Idempotency-Key" => "key-1" },
          as: :json

        assert_response :accepted
        body = JSON.parse(response.body)
        assert_equal "queued", body["status"]

        purchase = PurchaseRequest.find_by!(idempotency_key: "key-1")
        assert_equal 1, OutboxEvent.where(aggregate_type: "PurchaseRequest", aggregate_id: purchase.id).count
      end

      test "reusing an idempotency key with the same payload returns the original purchase" do
        post "/api/v1/purchase_requests",
          params: purchase_payload,
          headers: { "Idempotency-Key" => "key-2" },
          as: :json
        original_id = JSON.parse(response.body)["id"]

        post "/api/v1/purchase_requests",
          params: purchase_payload,
          headers: { "Idempotency-Key" => "key-2" },
          as: :json

        assert_response :ok
        assert_equal original_id, JSON.parse(response.body)["id"]
        assert_equal 1, PurchaseRequest.where(idempotency_key: "key-2").count
      end

      # Scenario: reusing an idempotency key with a different payload must return conflict.
      test "reusing an idempotency key with a different payload returns conflict" do
        post "/api/v1/purchase_requests",
          params: purchase_payload(amount_cents: 1999),
          headers: { "Idempotency-Key" => "key-3" },
          as: :json

        post "/api/v1/purchase_requests",
          params: purchase_payload(amount_cents: 5000),
          headers: { "Idempotency-Key" => "key-3" },
          as: :json

        assert_response :conflict
        assert_equal(
          "Idempotency key was already used with different data",
          JSON.parse(response.body)["error"]
        )
        purchase = PurchaseRequest.find_by!(idempotency_key: "key-3")
        assert_equal 1999, purchase.amount_cents
      end

      # Scenario: one hundred simultaneous requests with the same idempotency key must
      # create exactly one purchase. Each thread gets its own integration session (a
      # single ActionDispatch::IntegrationTest session isn't safe to share across threads),
      # exercising the real DB-unique-index + RecordNotUnique-rescue path under real
      # concurrency rather than serialized calls.
      test "one hundred concurrent requests with the same idempotency key create exactly one purchase" do
        idempotency_key = "storm-#{SecureRandom.hex(8)}"
        request_count = 100
        statuses = Concurrent::Array.new
        bodies = Concurrent::Array.new

        # Warm up route recognition/autoloading before firing many concurrent
        # sessions at once; the first-ever route lookup across many freshly
        # created Integration::Session instances can otherwise race.
        ActionDispatch::Integration::Session.new(Rails.application).post(
          "/api/v1/purchase_requests",
          params: purchase_payload,
          headers: { "Idempotency-Key" => "warmup-#{SecureRandom.hex(8)}" },
          as: :json
        )

        threads = Array.new(request_count) do
          Thread.new do
            session = ActionDispatch::Integration::Session.new(Rails.application)
            session.post "/api/v1/purchase_requests",
              params: purchase_payload,
              headers: { "Idempotency-Key" => idempotency_key },
              as: :json
            statuses << session.response.status
            bodies << session.response.body unless [ 200, 202 ].include?(session.response.status)
          end
        end
        threads.each(&:join)

        assert_equal request_count, statuses.size
        assert statuses.all? { |status| [ 200, 202 ].include?(status) },
          "expected only 200/202 responses, got: #{statuses.tally}\nsample bodies: #{bodies.first(5)}"
        assert_equal 1, PurchaseRequest.where(idempotency_key: idempotency_key).count
      end

      test "index never returns more purchases than the requested page size" do
        260.times do |n|
          PurchaseRequest.create!(
            idempotency_key: "bulk-#{n}",
            customer_ref: "customer-#{n}",
            amount_cents: 1000 + n
          )
        end

        get "/api/v1/purchase_requests"
        assert_response :success
        body = JSON.parse(response.body)
        assert_operator body["purchases"].size, :<=, body["per_page"]

        get "/api/v1/purchase_requests", params: { per_page: 10_000 }
        assert_response :success
        clamped = JSON.parse(response.body)
        assert_operator clamped["per_page"], :<=, 200
        assert_operator clamped["purchases"].size, :<=, clamped["per_page"]
      end
    end
  end
end
