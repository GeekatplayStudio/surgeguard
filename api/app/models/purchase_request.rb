class PurchaseRequest < ApplicationRecord
  enum :status, {
    queued: 0,
    processing: 1,
    processed: 2,
    failed: 3
  }

  # Uniqueness is enforced by the DB unique index on idempotency_key, not a
  # presence/uniqueness validation: Rails' in-app uniqueness check is a
  # check-then-insert race and would intercept concurrent/duplicate requests
  # before the controller's ActiveRecord::RecordNotUnique-based idempotency
  # handling (see PurchaseRequestsController#handle_duplicate_request) ever runs.
  validates :idempotency_key,
    presence: true
  validates :customer_ref,
    presence: true
  validates :amount_cents,
    numericality: {
      only_integer: true,
      greater_than: 0
    }

  def amount_dollars
    amount_cents / 100.0
  end
end
