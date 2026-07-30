#!/usr/bin/env bash
set -euo pipefail

compose_command=()
if [[ -n "${COMPOSE_BIN:-}" ]]; then
  if [[ ! -x "$COMPOSE_BIN" ]]; then
    printf 'COMPOSE_BIN is not executable: %s\n' "$COMPOSE_BIN" >&2
    exit 1
  fi
  compose_command=("$COMPOSE_BIN")
elif docker compose version >/dev/null 2>&1; then
  compose_command=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_command=(docker-compose)
elif [[ -x /opt/homebrew/opt/docker-compose/bin/docker-compose ]]; then
  compose_command=(/opt/homebrew/opt/docker-compose/bin/docker-compose)
else
  printf 'Docker Compose v2 is required. Set COMPOSE_BIN to a standalone Compose executable when the Docker plugin is unavailable.\n' >&2
  exit 1
fi

run_id="$$_$(date +%s)_${RANDOM}"
project="qintopia-verify-${run_id//_/-}"
app_port="${COMPOSE_VERIFY_APP_PORT:-$((43000 + RANDOM % 8000))}"
postgres_port="${COMPOSE_VERIFY_POSTGRES_PORT:-$((52000 + RANDOM % 8000))}"
postgres_container="${project}-postgres"
workdir="$(mktemp -d)"
cookie_jar="$workdir/cookies.txt"
started=false

compose() {
  "${compose_command[@]}" --project-name "$project" --file compose.yaml "$@"
}

cleanup() {
  if [[ "$started" = "true" ]]; then
    compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

export APP_HOST_PORT="$app_port"
export POSTGRES_HOST_PORT="$postgres_port"
export POSTGRES_CONTAINER_NAME="$postgres_container"
export SESSION_COOKIE_SECURE=false
export SEED_DEMO_DATA=true
export IMPORT_2026_REFERENCE_CATALOG=false

started=true
if ! compose up --build --detach --wait; then
  compose logs --no-color >&2 || true
  exit 1
fi

base_url="http://127.0.0.1:$app_port"
curl --fail --silent --show-error "$base_url/health/live" >/dev/null
curl --fail --silent --show-error "$base_url/health/ready" >/dev/null
curl --fail --silent --show-error "$base_url/" >/dev/null
curl --fail --silent --show-error "$base_url/api/v1/openapi.json" >/dev/null
curl --fail --silent --show-error "$base_url/docs/" >/dev/null
curl --fail --silent --show-error -c "$cookie_jar" -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"demo-pass-2026"}' "$base_url/api/v1/auth/login" >/dev/null
curl --fail --silent --show-error -b "$cookie_jar" "$base_url/api/v1/me" >/dev/null
command_key="compose-quote-${run_id//_/-}"
curl --fail --silent --show-error -b "$cookie_jar" \
  -H "Origin: $base_url" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $command_key" \
  -H "X-Correlation-ID: $command_key" \
  -d '{"propertyId":"prop_qintopia_demo","inventoryUnitId":"unit_room_101","stayType":"FREE","arrivalDate":"2028-12-10","departureDate":"2028-12-12","pricingPolicyVersionId":"policy_free_v1"}' \
  "$base_url/api/v1/quotes" >/dev/null

curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/api/v1/members?propertyId=prop_qintopia_demo" >/dev/null

required_migration_count="$(docker exec "$postgres_container" psql -U qintopia -d qintopia -Atc "SELECT count(*) FROM schema_migrations WHERE name IN ('001_initial.sql','002_immutability.sql','003_active_coverage_uniqueness.sql','004_security_identity_guards.sql','005_core_identity_and_entitlement_guards.sql','006_property_scoped_idempotency.sql','007_reference_catalog.sql','008_reference_catalog_sealing.sql','009_booking_channels_and_transaction_references.sql','010_qintopia_2026_catalog_pricing_and_free_stays.sql','011_core_fact_shape_guards.sql','012_legacy_demo_inventory_catalog_backfill.sql','013_room_status_operations.sql','014_new_order_primary_guest_nickname.sql','015_generated_room_operational_codes.sql','016_member_property_links.sql','017_membership_orders.sql','018_member_stay_identity_and_coverage_guards.sql','019_member_stay_booking_channel_rules.sql','020_whole_room_occupants.sql','021_defer_internal_use.sql','022_order_occupant_corrections.sql','023_collection_fact_pricing_revision.sql','024_free_stay_category_code.sql','025_channel_order_atomic_pricing.sql','026_stage9_stay_change_guards.sql','027_stage10_stay_shortening_guards.sql')")"
demo_subject_count="$(docker exec "$postgres_container" psql -U qintopia -d qintopia -Atc "SELECT count(*) FROM subjects WHERE username = 'operator' AND status = 'ACTIVE'")"
operational_column_count="$(docker exec "$postgres_container" psql -U qintopia -d qintopia -Atc "SELECT count(*) FROM information_schema.columns WHERE (table_name = 'orders' AND column_name IN ('booking_channel_code','channel_order_reference')) OR (table_name = 'collection_facts' AND column_name = 'transaction_reference')")"
test "$required_migration_count" = "27"
test "$demo_subject_count" = "1"
test "$operational_column_count" = "3"

printf 'Compose cold start verified on %s with isolated project %s and PostgreSQL container %s.\n' "$base_url" "$project" "$postgres_container"
