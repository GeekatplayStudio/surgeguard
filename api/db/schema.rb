# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_08_20_182455) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "outbox_events", force: :cascade do |t|
    t.bigint "aggregate_id", null: false
    t.string "aggregate_type", null: false
    t.integer "attempt_count", default: 0, null: false
    t.datetime "created_at", null: false
    t.string "event_type", null: false
    t.text "last_error"
    t.jsonb "payload", default: {}, null: false
    t.datetime "published_at"
    t.datetime "updated_at", null: false
    t.index ["aggregate_type", "aggregate_id"], name: "index_outbox_events_on_aggregate_type_and_aggregate_id"
    t.index ["published_at"], name: "index_outbox_events_on_published_at"
  end

  create_table "purchase_requests", force: :cascade do |t|
    t.integer "amount_cents", null: false
    t.integer "attempt_count", default: 0, null: false
    t.datetime "created_at", null: false
    t.string "customer_ref", null: false
    t.string "idempotency_key", null: false
    t.text "last_error"
    t.datetime "processed_at"
    t.datetime "processing_started_at"
    t.integer "status", default: 0, null: false
    t.datetime "updated_at", null: false
    t.index ["idempotency_key"], name: "index_purchase_requests_on_idempotency_key", unique: true
    t.index ["status"], name: "index_purchase_requests_on_status"
    t.check_constraint "amount_cents > 0", name: "purchase_requests_amount_positive"
  end
end
