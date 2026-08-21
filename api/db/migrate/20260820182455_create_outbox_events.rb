class CreateOutboxEvents < ActiveRecord::Migration[8.1]
  def change
    create_table :outbox_events do |t|
      t.string :event_type, null: false
      t.string :aggregate_type, null: false
      t.bigint :aggregate_id, null: false
      t.jsonb :payload,
        null: false,
        default: {}
      t.datetime :published_at
      t.integer :attempt_count,
        null: false,
        default: 0
      t.text :last_error
      t.timestamps
    end

    add_index :outbox_events,
      :published_at
    add_index :outbox_events,
      [ :aggregate_type, :aggregate_id ]
  end
end
