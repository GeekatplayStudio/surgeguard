class OutboxEvent < ApplicationRecord
  scope :pending,
    -> { where(published_at: nil) }

  validates :event_type,
    presence: true
  validates :aggregate_type,
    presence: true
  validates :aggregate_id,
    presence: true
end
