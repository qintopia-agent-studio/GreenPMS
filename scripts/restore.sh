#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_RESTORE:-false}" != "true" ]]; then
  printf 'Refusing restore. Set ALLOW_RESTORE=true and restore only into a new database.\n' >&2
  exit 2
fi

backup="${1:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
target="${2:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
container="${POSTGRES_CONTAINER:-qintopia-postgres}"
migration_user="${MIGRATION_DATABASE_USER:-${POSTGRES_USER:-qintopia_migrator}}"
migration_password="${MIGRATION_DATABASE_PASSWORD:-${POSTGRES_PASSWORD:-qintopia_migrator}}"
runtime_user="${RUNTIME_DATABASE_USER:-qintopia_runtime}"
runtime_password="${RUNTIME_DATABASE_PASSWORD:-qintopia_runtime}"
staff_profile_manifest_name="${STAFF_PROFILE_MANIFEST_NAME:-unconfigured}"
host_port="${POSTGRES_HOST_PORT:-55432}"
live_database="${POSTGRES_DB:-qintopia}"
target_created=false
migrations_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/db/src/migrations" && pwd)"
supported_baseline_migrations_sql=""
current_migrations_sql=""
current_migration_names=()
supported_baseline_migration_count=0
current_migration_count=0
for migration_path in "$migrations_directory"/[0-9][0-9][0-9]_*.sql; do
  migration_name="${migration_path##*/}"
  if [[ ! "$migration_name" =~ ^[0-9]{3}_[A-Za-z0-9_]+[.]sql$ ]]; then
    printf 'Refusing unexpected migration filename: %s\n' "$migration_name" >&2
    exit 1
  fi
  migration_number=$((10#${migration_name%%_*}))
  current_migration_names+=("$migration_name")
  current_migrations_sql+="'$migration_name',"
  current_migration_count=$((current_migration_count + 1))
  if (( migration_number <= 26 )); then
    supported_baseline_migrations_sql+="'$migration_name',"
    supported_baseline_migration_count=$((supported_baseline_migration_count + 1))
  fi
done
current_migrations_sql="${current_migrations_sql%,}"
supported_baseline_migrations_sql="${supported_baseline_migrations_sql%,}"
if [[ "$supported_baseline_migration_count" != "26" || "$current_migration_count" -lt "$supported_baseline_migration_count" ]]; then
  printf 'Restore migration manifest is incomplete (baseline %s/26, current %s).\n' "$supported_baseline_migration_count" "$current_migration_count" >&2
  exit 1
fi

cleanup_partial_target() {
  if [[ "$target_created" != "true" ]]; then
    return
  fi
  printf 'Restore failed; partial target database %s was retained for manual inspection and will never be removed automatically.\n' "$target" >&2
}

restore_failed() {
  local status=$?
  trap - ERR
  cleanup_partial_target
  exit "$status"
}

run_current_migrations() {
  if [[ -n "${VERIFY_APP_IMAGE:-}" ]]; then
    docker run --rm --init \
      --add-host host.docker.internal:host-gateway \
      -e "DATABASE_URL=" \
      -e "PGHOST=host.docker.internal" \
      -e "PGPORT=$host_port" \
      -e "PGDATABASE=$target" \
      -e "PGUSER=$runtime_user" \
      -e "PGPASSWORD=$runtime_password" \
      -e "MIGRATION_PGHOST=host.docker.internal" \
      -e "MIGRATION_PGPORT=$host_port" \
      -e "MIGRATION_PGDATABASE=$target" \
      -e "MIGRATION_PGUSER=$migration_user" \
      -e "MIGRATION_PGPASSWORD=$migration_password" \
      -e "RUNTIME_DATABASE_PASSWORD=$runtime_password" \
      -e "STAFF_PROFILE_MANIFEST_NAME=$staff_profile_manifest_name" \
      "$VERIFY_APP_IMAGE" npm run db:migrate
    return
  fi
  DATABASE_URL="" \
    PGHOST="127.0.0.1" PGPORT="$host_port" PGDATABASE="$target" PGUSER="$runtime_user" PGPASSWORD="$runtime_password" \
    MIGRATION_PGHOST="127.0.0.1" MIGRATION_PGPORT="$host_port" MIGRATION_PGDATABASE="$target" MIGRATION_PGUSER="$migration_user" MIGRATION_PGPASSWORD="$migration_password" \
    RUNTIME_DATABASE_PASSWORD="$runtime_password" \
    STAFF_PROFILE_MANIFEST_NAME="$staff_profile_manifest_name" \
    npm run db:migrate
}

run_current_readiness() {
  if [[ -n "${VERIFY_APP_IMAGE:-}" ]]; then
    docker run --rm --init \
      --add-host host.docker.internal:host-gateway \
      -e "DATABASE_URL=" \
      -e "PGHOST=host.docker.internal" \
      -e "PGPORT=$host_port" \
      -e "PGDATABASE=$target" \
      -e "PGUSER=$runtime_user" \
      -e "PGPASSWORD=$runtime_password" \
      -e "STAFF_PROFILE_MANIFEST_NAME=$staff_profile_manifest_name" \
      "$VERIFY_APP_IMAGE" npm run db:ready
    return
  fi
  DATABASE_URL="" PGHOST="127.0.0.1" PGPORT="$host_port" PGDATABASE="$target" PGUSER="$runtime_user" PGPASSWORD="$runtime_password" STAFF_PROFILE_MANIFEST_NAME="$staff_profile_manifest_name" npm run db:ready
}

if [[ "$target" == "$live_database" ]]; then
  printf 'Refusing to restore over the configured live database %s.\n' "$live_database" >&2
  exit 2
fi
if [[ ! "$target" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
  printf 'Refusing unsafe target database name: %s\n' "$target" >&2
  exit 2
fi
test -s "$backup"
target_exists="$(docker exec "$container" psql -U "$migration_user" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$target'")"
if [[ "$target_exists" == "1" ]]; then
  printf 'Refusing restore because target database %s already exists. Choose a new database name.\n' "$target" >&2
  exit 2
fi
trap restore_failed ERR
docker exec "$container" createdb -U "$migration_user" "$target"
target_created=true
docker exec -i "$container" pg_restore -U "$migration_user" -d "$target" --no-owner --no-privileges < "$backup"
baseline_migrations="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name IN ($supported_baseline_migrations_sql)")"
unknown_migrations="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name NOT IN ($current_migrations_sql)")"
restored_migration_manifest="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*)::text || ':' || COALESCE(string_agg(name, ',' ORDER BY name), '') FROM schema_migrations")"
restored_migration_count="${restored_migration_manifest%%:*}"
restored_migration_names="${restored_migration_manifest#*:}"
if [[ "$baseline_migrations" != "$supported_baseline_migration_count" ]]; then
  printf 'Restore target %s is missing a supported migration baseline (found %s of %s through stage 9).\n' "$target" "$baseline_migrations" "$supported_baseline_migration_count" >&2
  cleanup_partial_target
  exit 1
fi
if [[ "$unknown_migrations" != "0" ]]; then
  printf 'Restore target %s contains %s migration(s) unknown to this application version.\n' "$target" "$unknown_migrations" >&2
  cleanup_partial_target
  exit 1
fi
if [[ ! "$restored_migration_count" =~ ^[0-9]+$ ]] || (( restored_migration_count < supported_baseline_migration_count || restored_migration_count > current_migration_count )); then
  printf 'Restore target %s has an invalid migration history length (%s; supported range %s-%s).\n' "$target" "$restored_migration_count" "$supported_baseline_migration_count" "$current_migration_count" >&2
  cleanup_partial_target
  exit 1
fi
expected_restored_migration_names=""
for (( migration_index=0; migration_index<restored_migration_count; migration_index++ )); do
  if [[ -n "$expected_restored_migration_names" ]]; then
    expected_restored_migration_names+=","
  fi
  expected_restored_migration_names+="${current_migration_names[$migration_index]}"
done
if [[ "$restored_migration_names" != "$expected_restored_migration_names" ]]; then
  printf 'Restore target %s has a non-contiguous migration history; applied migrations must be an exact prefix of this application version.\n' "$target" >&2
  cleanup_partial_target
  exit 1
fi

if ! run_current_migrations; then
  printf 'Restore target %s could not be upgraded with the current migrations.\n' "$target" >&2
  cleanup_partial_target
  exit 1
fi

required_migrations="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name IN ($current_migrations_sql)")"
unknown_migrations="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name NOT IN ($current_migrations_sql)")"
stage10_functions="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage10_shorten_combination()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage10_pricing_revision()') IS NOT NULL)::integer")"
stage10_triggers="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgdeferrable AND trigger.tginitdeferred AND trigger.tgenabled IN ('O','A') AND ((relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage10_validate_combination' AND handler.proname = 'qintopia_validate_stage10_shorten_combination') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage10_validate_combination' AND handler.proname = 'qintopia_validate_stage10_shorten_execution'))")"
stage10_immediate_triggers="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND trigger.tgenabled IN ('O','A') AND trigger.tgtype = 7 AND ((trigger.tgrelid = to_regclass('pricing_revisions') AND trigger.tgname = 'pricing_revisions_stage10_validate' AND handler.proname = 'qintopia_validate_stage10_pricing_revision') OR (trigger.tgrelid = to_regclass('amendments') AND trigger.tgname = 'amendments_stage10_reject_checkout_bypass' AND handler.proname = 'qintopia_reject_stage10_checkout_bypass') OR (trigger.tgrelid = to_regclass('entitlement_ledger') AND trigger.tgname = 'entitlement_ledger_stage10_reject_write' AND handler.proname = 'qintopia_reject_stage10_entitlement_write'))")"
stage11_functions="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT (to_regprocedure('qintopia_assert_stage11_shorten_before_timeline(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_shorten_before_timeline()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_inventory_claim_source()') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_date_change_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_combination()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_execution()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_revision()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_amendment()') IS NOT NULL)::integer + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_ledger()') IS NOT NULL)::integer + (to_regprocedure('qintopia_reject_stage11_move_collection()') IS NOT NULL)::integer + (to_regprocedure('qintopia_preserve_stage11_preview_evidence()') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)') IS NOT NULL)::integer")"
stage11_replacements="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE(position('stage10_shorten_future_move_boundary' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))) = 0, false)::integer + COALESCE(position('reschedule_pair_valid' IN pg_get_functiondef(to_regprocedure('qintopia_validate_inventory_claim_source()'))) > 0, false)::integer")"
stage11_body_markers="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE(position('stage11_move_order_command_chain' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_move_inventory_diff' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('ledger.service_date < effective_date' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_date_change_order_command_chain' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_date_change_plan_b' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer + COALESCE(position('target_preview.effect IS DISTINCT FROM target_amendment.payload' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer + COALESCE(position('target_receipt.result ->> ''effectHash'' IS DISTINCT FROM target_preview.effect_hash' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer + COALESCE(position('stage11_preview_evidence_immutable' IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_preview_evidence()'))) > 0, false)::integer")"
stage11_triggers="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A') AND trigger.tgdeferrable AND trigger.tginitdeferred AND ((relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_shorten_before_timeline' AND trigger.tgtype = 5 AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage11_validate_shorten_before_timeline' AND trigger.tgtype = 21 AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline') OR (relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_move_combination' AND trigger.tgtype = 5 AND handler.proname = 'qintopia_validate_stage11_move_combination') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage11_validate_move_combination' AND trigger.tgtype = 21 AND handler.proname = 'qintopia_validate_stage11_move_execution'))")"
stage11_immediate_triggers="$(docker exec "$container" psql -U "$migration_user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A') AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND ((relation.relname = 'pricing_revisions' AND trigger.tgname = 'pricing_revisions_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_revision') OR (relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_amendment') OR (relation.relname = 'coverage_items' AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_update' AND trigger.tgtype = 19 AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage') OR (relation.relname = 'coverage_items' AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_delete' AND trigger.tgtype = 11 AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage') OR (relation.relname = 'entitlement_ledger' AND trigger.tgname = 'entitlement_ledger_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_ledger') OR (relation.relname = 'collection_facts' AND trigger.tgname = 'collection_facts_stage11_reject_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_reject_stage11_move_collection') OR (relation.relname = 'inventory_claims' AND trigger.tgname = 'inventory_claims_validate_source' AND trigger.tgtype = 23 AND handler.proname = 'qintopia_validate_inventory_claim_source') OR (relation.relname = 'command_previews' AND trigger.tgname = 'command_previews_stage11_preserve_evidence' AND trigger.tgtype = 19 AND handler.proname = 'qintopia_preserve_stage11_preview_evidence'))")"
if [[ "$required_migrations" != "$current_migration_count" || "$unknown_migrations" != "0" || "$stage10_functions" != "3" || "$stage10_triggers" != "2" || "$stage10_immediate_triggers" != "3" || "$stage11_functions" != "14" || "$stage11_replacements" != "2" || "$stage11_body_markers" != "8" || "$stage11_triggers" != "4" || "$stage11_immediate_triggers" != "8" ]]; then
  printf 'Restore target %s did not reach the current schema (migrations %s/%s, stage11 functions %s/14, replacements %s/2, body markers %s/8, deferred triggers %s/4, immediate trigger bindings %s/8).\n' "$target" "$required_migrations" "$current_migration_count" "$stage11_functions" "$stage11_replacements" "$stage11_body_markers" "$stage11_triggers" "$stage11_immediate_triggers" >&2
  cleanup_partial_target
  exit 1
fi
if ! run_current_readiness; then
  printf 'Restore target %s failed the current database readiness validation.\n' "$target" >&2
  cleanup_partial_target
  exit 1
fi
trap - ERR
target_created=false
printf 'Restored %s into new database %s\n' "$backup" "$target"
