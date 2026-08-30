#!/usr/bin/env bash
#
# Launches the whole SurgeGuard stack natively:
#   Rails API (http://localhost:3000), the Solid Queue worker,
#   and the dashboard (http://localhost:5173).
#
# Requires Ruby 3.4, Node 22, and PostgreSQL + Redis already running.
# Stop everything with Ctrl+C.

set -euo pipefail
cd "$(dirname "$0")"

pids=()
cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== Checking services =="
if command -v pg_isready >/dev/null && ! pg_isready -q; then
  echo "PostgreSQL is not reachable. Start it and re-run." >&2
  exit 1
fi
if command -v redis-cli >/dev/null && ! redis-cli ping >/dev/null 2>&1; then
  echo "warning: Redis is not reachable - the rate limiter will fail open." >&2
fi

echo "== API setup =="
(cd api && bundle check >/dev/null 2>&1 || bundle install)
(cd api && bin/rails db:prepare)

if [ ! -d dashboard/node_modules ]; then
  echo "== Dashboard dependencies =="
  (cd dashboard && npm install)
fi

echo "== Starting API on :3000 =="
(cd api && bin/rails server -p 3000) &
pids+=($!)

echo "== Starting Solid Queue worker =="
(cd api && bin/jobs start) &
pids+=($!)

echo "== Starting dashboard on :5173 =="
(cd dashboard && npm run dev) &
pids+=($!)

echo ""
echo "  dashboard  http://localhost:5173   (Tavern demo lives in the header toggle)"
echo "  api        http://localhost:3000"
echo ""
wait
