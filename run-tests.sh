#!/usr/bin/env bash
#
# Runs every test suite in the repo:
#   api        Rails tests (needs PostgreSQL; Redis exercises the rate limiter)
#   dashboard  format check, oxlint, ESLint, typecheck+build, Vitest, Playwright
#   loadtest   format check + typecheck
#
# The dashboard's Playwright suite (e2e/) starts its own dev server - no need
# to run ./start.sh first. It needs Chromium's system libraries installed once:
#   cd dashboard && npx playwright install --with-deps chromium
#
# Flags:
#   --load       also fire the live load scripts against a running stack
#                (start it first with ./start.sh)
#   --mutation   also run mutation testing on the tavern engine (Stryker,
#                ~15-20 minutes - not run by default because of that)
#   ./run-tests.sh --load --mutation

set -euo pipefail
cd "$(dirname "$0")"

run_load=false
run_mutation=false
for arg in "$@"; do
  [ "$arg" = "--load" ] && run_load=true
  [ "$arg" = "--mutation" ] && run_mutation=true
done

echo "==== api ===="
(cd api && bundle check >/dev/null 2>&1 || bundle install)
(cd api && RAILS_ENV=test bin/rails db:test:prepare test)

echo ""
echo "==== dashboard ===="
[ -d dashboard/node_modules ] || (cd dashboard && npm install)
(cd dashboard && npm run format:check && npm run lint && npm run lint:eslint && npm run build && npm run test)

echo ""
echo "==== dashboard: end-to-end (Playwright) ===="
(cd dashboard && npm run e2e)

echo ""
echo "==== loadtest ===="
[ -d loadtest/node_modules ] || (cd loadtest && npm install)
(cd loadtest && npm run format:check && npm run typecheck)

if $run_mutation; then
  echo ""
  echo "==== dashboard: mutation testing (Stryker, scoped to the tavern engine) ===="
  (cd dashboard && npm run mutation)
fi

if $run_load; then
  echo ""
  echo "==== live load scripts (stack must be running) ===="
  (cd loadtest && npx tsx load-test.ts 200 25)
  (cd loadtest && npx tsx idempotency-storm.ts 100)
  (cd loadtest && npx tsx backlog-check.ts 300 10)
fi

echo ""
echo "All suites passed."
