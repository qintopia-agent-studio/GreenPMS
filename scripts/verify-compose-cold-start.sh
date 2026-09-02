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
migration_user="${MIGRATION_DATABASE_USER:-qintopia_migrator}"
migration_password="${MIGRATION_DATABASE_PASSWORD:-qintopia_migrator}"
runtime_user="${RUNTIME_DATABASE_USER:-qintopia_runtime}"
runtime_password="${RUNTIME_DATABASE_PASSWORD:-qintopia_runtime}"
workdir="$(mktemp -d)"
cookie_jar="$workdir/cookies.txt"
started=false
migrations_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/db/src/migrations" && pwd)"
current_migrations_sql=""
current_migration_count=0
for migration_path in "$migrations_directory"/[0-9][0-9][0-9]_*.sql; do
  migration_name="${migration_path##*/}"
  if [[ ! "$migration_name" =~ ^[0-9]{3}_[A-Za-z0-9_]+[.]sql$ ]]; then
    printf 'Refusing unexpected migration filename: %s\n' "$migration_name" >&2
    exit 1
  fi
  current_migrations_sql+="'$migration_name',"
  current_migration_count=$((current_migration_count + 1))
done
current_migrations_sql="${current_migrations_sql%,}"

compose() {
  "${compose_command[@]}" --project-name "$project" --file compose.yaml "$@"
}

run_migration_psql() {
  docker exec "$postgres_container" psql -U "$migration_user" -d qintopia "$@"
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
export MIGRATION_DATABASE_USER="$migration_user"
export MIGRATION_DATABASE_PASSWORD="$migration_password"
export RUNTIME_DATABASE_USER="$runtime_user"
export RUNTIME_DATABASE_PASSWORD="$runtime_password"
export SESSION_COOKIE_SECURE=false
export SEED_DEMO_DATA=true
export STAFF_PROFILE_MANIFEST_NAME=demo
export MIGRATION_STAFF_PROFILE_MANIFEST_NAME=unconfigured
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

required_migration_count="$(run_migration_psql -Atc "SELECT count(*) FROM schema_migrations WHERE name IN ($current_migrations_sql)")"
stage11_function_count="$(run_migration_psql -Atc "SELECT (to_regprocedure('qintopia_assert_stage11_shorten_before_timeline(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_shorten_before_timeline()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_inventory_claim_source()') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_date_change_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_combination()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_execution()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_revision()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_amendment()') IS NOT NULL)::integer + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_ledger()') IS NOT NULL)::integer + (to_regprocedure('qintopia_reject_stage11_move_collection()') IS NOT NULL)::integer + (to_regprocedure('qintopia_preserve_stage11_preview_evidence()') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)') IS NOT NULL)::integer")"
stage11_replacement_count="$(run_migration_psql -Atc "SELECT COALESCE(position('stage10_shorten_future_move_boundary' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))) = 0, false)::integer + COALESCE(position('reschedule_pair_valid' IN pg_get_functiondef(to_regprocedure('qintopia_validate_inventory_claim_source()'))) > 0, false)::integer")"
stage11_body_marker_count="$(run_migration_psql -Atc "SELECT COALESCE(position('stage11_move_order_command_chain' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_move_inventory_diff' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('ledger.service_date < effective_date' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_date_change_order_command_chain' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_date_change_plan_b' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer + COALESCE(position('target_preview.effect IS DISTINCT FROM target_amendment.payload' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer + COALESCE(position('target_receipt.result ->> ''effectHash'' IS DISTINCT FROM target_preview.effect_hash' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer + COALESCE(position('stage11_preview_evidence_immutable' IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_preview_evidence()'))) > 0, false)::integer")"
stage11_trigger_count="$(run_migration_psql -Atc "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A') AND trigger.tgdeferrable AND trigger.tginitdeferred AND ((relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_shorten_before_timeline' AND trigger.tgtype = 5 AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage11_validate_shorten_before_timeline' AND trigger.tgtype = 21 AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline') OR (relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_move_combination' AND trigger.tgtype = 5 AND handler.proname = 'qintopia_validate_stage11_move_combination') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage11_validate_move_combination' AND trigger.tgtype = 21 AND handler.proname = 'qintopia_validate_stage11_move_execution'))")"
stage11_immediate_trigger_count="$(run_migration_psql -Atc "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A') AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND ((relation.relname = 'pricing_revisions' AND trigger.tgname = 'pricing_revisions_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_revision') OR (relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_amendment') OR (relation.relname = 'coverage_items' AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_update' AND trigger.tgtype = 19 AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage') OR (relation.relname = 'coverage_items' AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_delete' AND trigger.tgtype = 11 AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage') OR (relation.relname = 'entitlement_ledger' AND trigger.tgname = 'entitlement_ledger_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_ledger') OR (relation.relname = 'collection_facts' AND trigger.tgname = 'collection_facts_stage11_reject_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_reject_stage11_move_collection') OR (relation.relname = 'inventory_claims' AND trigger.tgname = 'inventory_claims_validate_source' AND trigger.tgtype = 23 AND handler.proname = 'qintopia_validate_inventory_claim_source') OR (relation.relname = 'command_previews' AND trigger.tgname = 'command_previews_stage11_preserve_evidence' AND trigger.tgtype = 19 AND handler.proname = 'qintopia_preserve_stage11_preview_evidence'))")"
demo_subject_count="$(run_migration_psql -Atc "SELECT count(*) FROM subjects WHERE username = 'operator' AND status = 'ACTIVE'")"
reconciled_staff_profile_manifest="$(run_migration_psql -Atc "SELECT manifest_name FROM staff_profile_reconciliation_state WHERE singleton")"
operational_column_count="$(run_migration_psql -Atc "SELECT count(*) FROM information_schema.columns WHERE (table_name = 'orders' AND column_name IN ('booking_channel_code','channel_order_reference')) OR (table_name = 'collection_facts' AND column_name = 'transaction_reference')")"
runtime_identity="$(docker exec -e "PGPASSWORD=$runtime_password" "$postgres_container" psql -U "$runtime_user" -d qintopia -Atc "SELECT current_user || ':' || session_user")"
runtime_restricted_role_count="$(run_migration_psql -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '$runtime_user' AND rolcanlogin AND NOT rolsuper AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls")"
if docker exec -e "PGPASSWORD=$runtime_password" "$postgres_container" psql -U "$runtime_user" -d qintopia -v ON_ERROR_STOP=1 -c "CREATE TEMP TABLE runtime_forbidden(id text)" >/dev/null 2>&1; then
  printf 'Runtime database role unexpectedly created a TEMP table.\n' >&2
  exit 1
fi
test "$required_migration_count" = "$current_migration_count"
test "$stage11_function_count" = "14"
test "$stage11_replacement_count" = "2"
test "$stage11_body_marker_count" = "8"
test "$stage11_trigger_count" = "4"
test "$stage11_immediate_trigger_count" = "8"
test "$demo_subject_count" = "1"
test "$reconciled_staff_profile_manifest" = "demo"
test "$operational_column_count" = "3"
test "$runtime_identity" = "$runtime_user:$runtime_user"
test "$runtime_restricted_role_count" = "1"

printf 'Compose cold start verified on %s with isolated project %s and PostgreSQL container %s.\n' "$base_url" "$project" "$postgres_container"
