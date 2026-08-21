require "test_helper"

class OutboxEventTest < ActiveSupport::TestCase
  def valid_attributes
    {
      event_type: "purchase.created",
      aggregate_type: "PurchaseRequest",
      aggregate_id: 1
    }
  end

  test "valid with required attributes" do
    assert OutboxEvent.new(valid_attributes).valid?
  end

  test "requires event_type" do
    event = OutboxEvent.new(valid_attributes.merge(event_type: nil))
    assert_not event.valid?
    assert_includes event.errors[:event_type], "can't be blank"
  end

  test "requires aggregate_type" do
    event = OutboxEvent.new(valid_attributes.merge(aggregate_type: nil))
    assert_not event.valid?
    assert_includes event.errors[:aggregate_type], "can't be blank"
  end

  test "requires aggregate_id" do
    event = OutboxEvent.new(valid_attributes.merge(aggregate_id: nil))
    assert_not event.valid?
    assert_includes event.errors[:aggregate_id], "can't be blank"
  end

  test "pending scope only returns unpublished events" do
    pending = OutboxEvent.create!(valid_attributes)
    published = OutboxEvent.create!(valid_attributes.merge(aggregate_id: 2, published_at: Time.current))

    assert_includes OutboxEvent.pending, pending
    assert_not_includes OutboxEvent.pending, published
  end
end
