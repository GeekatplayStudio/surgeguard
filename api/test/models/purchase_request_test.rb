require "test_helper"

class PurchaseRequestTest < ActiveSupport::TestCase
  def valid_attributes
    {
      idempotency_key: "key-#{SecureRandom.hex(8)}",
      customer_ref: "customer-1",
      amount_cents: 1999
    }
  end

  test "valid with required attributes" do
    assert PurchaseRequest.new(valid_attributes).valid?
  end

  test "requires idempotency_key" do
    purchase = PurchaseRequest.new(valid_attributes.merge(idempotency_key: nil))
    assert_not purchase.valid?
    assert_includes purchase.errors[:idempotency_key], "can't be blank"
  end

  # idempotency_key uniqueness is intentionally enforced only by the DB unique
  # index (see the model), not an in-app uniqueness validation - so a duplicate
  # is valid at the model level but rejected by the database on save. This is
  # what lets the controller distinguish "same payload, replay" (200) from
  # "different payload, conflict" (409) via ActiveRecord::RecordNotUnique
  # instead of a generic validation error.
  test "the database rejects a duplicate idempotency_key even though the model considers it valid" do
    attributes = valid_attributes
    PurchaseRequest.create!(attributes)
    duplicate = PurchaseRequest.new(attributes.merge(customer_ref: "customer-2"))

    assert duplicate.valid?
    assert_raises(ActiveRecord::RecordNotUnique) { duplicate.save! }
  end

  test "requires customer_ref" do
    purchase = PurchaseRequest.new(valid_attributes.merge(customer_ref: nil))
    assert_not purchase.valid?
    assert_includes purchase.errors[:customer_ref], "can't be blank"
  end

  test "requires amount_cents to be a positive integer" do
    purchase = PurchaseRequest.new(valid_attributes.merge(amount_cents: 0))
    assert_not purchase.valid?
    assert_includes purchase.errors[:amount_cents], "must be greater than 0"
  end

  test "rejects non-integer amount_cents" do
    purchase = PurchaseRequest.new(valid_attributes.merge(amount_cents: 19.99))
    assert_not purchase.valid?
    assert_includes purchase.errors[:amount_cents], "must be an integer"
  end

  test "defaults to queued status" do
    purchase = PurchaseRequest.create!(valid_attributes)
    assert purchase.queued?
  end

  test "amount_dollars converts cents to a decimal amount" do
    purchase = PurchaseRequest.new(valid_attributes.merge(amount_cents: 1999))
    assert_equal 19.99, purchase.amount_dollars
  end
end
