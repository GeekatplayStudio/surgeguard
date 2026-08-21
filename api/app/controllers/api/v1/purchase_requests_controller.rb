module Api
  module V1
    class PurchaseRequestsController < ApplicationController
      before_action :apply_rate_limit!,
        only: [ :create ]

      DEFAULT_PER_PAGE = 50
      MAX_PER_PAGE = 200

      def index
        page = [ params[:page].to_i, 1 ].max
        per_page = params[:per_page].presence&.to_i || DEFAULT_PER_PAGE
        per_page = per_page.clamp(1, MAX_PER_PAGE)

        total = PurchaseRequest.count
        purchases = PurchaseRequest
          .order(created_at: :desc)
          .offset((page - 1) * per_page)
          .limit(per_page)

        render json: {
          purchases: purchases.map { |purchase| serialize_purchase(purchase) },
          page: page,
          per_page: per_page,
          total: total,
          has_more: page * per_page < total
        }
      end

      def create
        idempotency_key =
          request.headers["Idempotency-Key"]

        if idempotency_key.blank?
          return render json: {
            error: "Idempotency-Key header is required"
          }, status: :bad_request
        end

        customer_ref =
          purchase_params[:customer_ref]
        amount_cents =
          purchase_params[:amount_cents]

        purchase = nil

        PurchaseRequest.transaction do
          purchase = PurchaseRequest.create!(
            idempotency_key: idempotency_key,
            customer_ref: customer_ref,
            amount_cents: amount_cents,
            status: :queued
          )

          OutboxEvent.create!(
            event_type: "purchase.created",
            aggregate_type: "PurchaseRequest",
            aggregate_id: purchase.id,
            payload: {
              purchase_request_id: purchase.id
            }
          )
        end

        render json: serialize_purchase(purchase),
          status: :accepted
      rescue ActiveRecord::RecordNotUnique
        handle_duplicate_request(
          idempotency_key,
          customer_ref,
          amount_cents
        )
      rescue ActiveRecord::RecordInvalid => error
        render json: {
          error: "Validation failed",
          details: error.record.errors.full_messages
        }, status: :unprocessable_entity
      end

      private

      def purchase_params
        params.require(:purchase).permit(
          :customer_ref,
          :amount_cents
        )
      end

      def handle_duplicate_request(
        idempotency_key,
        customer_ref,
        amount_cents
      )
        existing = PurchaseRequest.find_by!(
          idempotency_key: idempotency_key
        )

        same_request =
          existing.customer_ref == customer_ref &&
          existing.amount_cents == amount_cents.to_i

        unless same_request
          return render json: {
            error: "Idempotency key was already used with different data"
          }, status: :conflict
        end

        render json: serialize_purchase(existing),
          status: :ok
      end

      def apply_rate_limit!
        key = [
          "surgeguard",
          "purchase",
          request.remote_ip
        ].join(":")

        return if RequestRateLimiter.allowed?(key)

        render json: {
          error: "Rate limit exceeded. Please retry shortly."
        }, status: :too_many_requests
      end

      def serialize_purchase(purchase)
        {
          id: purchase.id,
          idempotency_key: purchase.idempotency_key,
          customer_ref: purchase.customer_ref,
          amount_cents: purchase.amount_cents,
          amount_dollars: purchase.amount_dollars,
          status: purchase.status,
          attempt_count: purchase.attempt_count,
          processing_started_at: purchase.processing_started_at,
          processed_at: purchase.processed_at,
          last_error: purchase.last_error,
          created_at: purchase.created_at
        }
      end
    end
  end
end
