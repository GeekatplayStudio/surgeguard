class CreatePurchaseRequests < ActiveRecord::Migration[8.1]
  def change
    create_table :purchase_requests do |t|
      t.string :idempotency_key, null: false
      t.string :customer_ref, null: false
      t.integer :amount_cents, null: false
      t.integer :status,
        null: false,
        default: 0
      t.integer :attempt_count,
        null: false,
        default: 0
      t.datetime :processing_started_at
      t.datetime :processed_at
      t.text :last_error
      t.timestamps
    end

    add_index :purchase_requests,
      :idempotency_key,
      unique: true
    add_index :purchase_requests,
      :status
    add_check_constraint :purchase_requests,
      "amount_cents > 0",
      name: "purchase_requests_amount_positive"
  end
end
