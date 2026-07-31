#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_RESTORE:-false}" != "true" ]]; then
  printf 'Refusing restore. Set ALLOW_RESTORE=true and restore only into a new database.\n' >&2
  exit 2
fi

backup="${1:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
target="${2:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
container="${POSTGRES_CONTAINER:-qintopia-postgres}"
user="${POSTGRES_USER:-qintopia}"
password="${POSTGRES_PASSWORD:-qintopia}"
host_port="${POSTGRES_HOST_PORT:-55432}"
live_database="${POSTGRES_DB:-qintopia}"
target_created=false
target_oid=""
supported_baseline_migrations_sql="'001_initial.sql','002_immutability.sql','003_active_coverage_uniqueness.sql','004_security_identity_guards.sql','005_core_identity_and_entitlement_guards.sql','006_property_scoped_idempotency.sql','007_reference_catalog.sql','008_reference_catalog_sealing.sql','009_booking_channels_and_transaction_references.sql','010_qintopia_2026_catalog_pricing_and_free_stays.sql','011_core_fact_shape_guards.sql','012_legacy_demo_inventory_catalog_backfill.sql','013_room_status_operations.sql','014_new_order_primary_guest_nickname.sql','015_generated_room_operational_codes.sql','016_member_property_links.sql','017_membership_orders.sql','018_member_stay_identity_and_coverage_guards.sql','019_member_stay_booking_channel_rules.sql','020_whole_room_occupants.sql','021_defer_internal_use.sql','022_order_occupant_corrections.sql','023_collection_fact_pricing_revision.sql','024_free_stay_category_code.sql','025_channel_order_atomic_pricing.sql','026_stage9_stay_change_guards.sql'"
current_migrations_sql="$supported_baseline_migrations_sql,'027_stage10_stay_shortening_guards.sql','028_stage11_move_unit_guards.sql'"

cleanup_partial_target() {
  if [[ "$target_created" != "true" ]]; then
    return
  fi
  local current_oid
  if ! current_oid="$(docker exec "$container" psql -U "$user" -d postgres -Atc "SELECT oid FROM pg_database WHERE datname = '$target'")"; then
    printf 'Restore failed and target database %s identity could not be verified; it was not removed automatically.\n' "$target" >&2
    return
  fi
  if [[ -z "$current_oid" ]]; then
    return
  fi
  if [[ -z "$target_oid" || "$current_oid" != "$target_oid" ]]; then
    printf 'Restore failed but target database %s no longer has the OID created by this restore; it was not removed.\n' "$target" >&2
    return
  fi
  if ! docker exec "$container" dropdb -U "$user" --if-exists "$target" >/dev/null 2>&1; then
    printf 'Restore failed and partial target database %s could not be removed automatically.\n' "$target" >&2
  fi
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
      -e "PGUSER=$user" \
      -e "PGPASSWORD=$password" \
      "$VERIFY_APP_IMAGE" npm run db:migrate
    return
  fi
  DATABASE_URL="" PGHOST="127.0.0.1" PGPORT="$host_port" PGDATABASE="$target" PGUSER="$user" PGPASSWORD="$password" npm run db:migrate
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
target_exists="$(docker exec "$container" psql -U "$user" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$target'")"
if [[ "$target_exists" == "1" ]]; then
  printf 'Refusing restore because target database %s already exists. Choose a new database name.\n' "$target" >&2
  exit 2
fi
trap restore_failed ERR
docker exec "$container" createdb -U "$user" "$target"
target_created=true
target_oid="$(docker exec "$container" psql -U "$user" -d postgres -Atc "SELECT oid FROM pg_database WHERE datname = '$target'")"
if [[ ! "$target_oid" =~ ^[0-9]+$ ]]; then
  printf 'Could not capture the identity of newly created target database %s.\n' "$target" >&2
  false
fi
docker exec -i "$container" pg_restore -U "$user" -d "$target" --no-owner --no-privileges < "$backup"
baseline_migrations="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name IN ($supported_baseline_migrations_sql)")"
unknown_migrations="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name NOT IN ($current_migrations_sql)")"
if [[ "$baseline_migrations" != "26" ]]; then
  printf 'Restore target %s is missing a supported migration baseline (found %s of 26 through stage 9).\n' "$target" "$baseline_migrations" >&2
  cleanup_partial_target
  exit 1
fi
if [[ "$unknown_migrations" != "0" ]]; then
  printf 'Restore target %s contains %s migration(s) unknown to this application version.\n' "$target" "$unknown_migrations" >&2
  cleanup_partial_target
  exit 1
fi

if ! run_current_migrations; then
  printf 'Restore target %s could not be upgraded with the current migrations.\n' "$target" >&2
  cleanup_partial_target
  exit 1
fi

required_migrations="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name IN ($current_migrations_sql)")"
unknown_migrations="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name NOT IN ($current_migrations_sql)")"
stage10_functions="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage10_shorten_combination()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage10_pricing_revision()') IS NOT NULL)::integer")"
stage10_triggers="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgdeferrable AND trigger.tginitdeferred AND trigger.tgenabled IN ('O','A') AND ((relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage10_validate_combination' AND handler.proname = 'qintopia_validate_stage10_shorten_combination') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage10_validate_combination' AND handler.proname = 'qintopia_validate_stage10_shorten_execution'))")"
stage10_immediate_triggers="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND trigger.tgenabled IN ('O','A') AND trigger.tgtype = 7 AND ((trigger.tgrelid = to_regclass('pricing_revisions') AND trigger.tgname = 'pricing_revisions_stage10_validate' AND handler.proname = 'qintopia_validate_stage10_pricing_revision') OR (trigger.tgrelid = to_regclass('amendments') AND trigger.tgname = 'amendments_stage10_reject_checkout_bypass' AND handler.proname = 'qintopia_reject_stage10_checkout_bypass') OR (trigger.tgrelid = to_regclass('entitlement_ledger') AND trigger.tgname = 'entitlement_ledger_stage10_reject_write' AND handler.proname = 'qintopia_reject_stage10_entitlement_write'))")"
stage11_functions="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT (to_regprocedure('qintopia_assert_stage11_shorten_before_timeline(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_shorten_before_timeline()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_inventory_claim_source()') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_move_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_date_change_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_combination()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_execution()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_revision()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_amendment()') IS NOT NULL)::integer + (to_regprocedure('qintopia_preserve_stage11_consumed_coverage()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage11_move_ledger()') IS NOT NULL)::integer + (to_regprocedure('qintopia_reject_stage11_move_collection()') IS NOT NULL)::integer + (to_regprocedure('qintopia_preserve_stage11_preview_evidence()') IS NOT NULL)::integer + (to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)') IS NOT NULL)::integer")"
stage11_replacements="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE(position('stage10_shorten_future_move_boundary' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage10_shorten_combination(text)'))) = 0, false)::integer + COALESCE(position('reschedule_pair_valid' IN pg_get_functiondef(to_regprocedure('qintopia_validate_inventory_claim_source()'))) > 0, false)::integer")"
stage11_body_markers="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE(position('stage11_move_order_command_chain' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_move_inventory_diff' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('ledger.service_date < effective_date' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_move_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_date_change_order_command_chain' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer + COALESCE(position('stage11_date_change_plan_b' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_date_change_combination(text)'))) > 0, false)::integer + COALESCE(position('target_preview.effect IS DISTINCT FROM target_amendment.payload' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer + COALESCE(position('target_receipt.result ->> ''effectHash'' IS DISTINCT FROM target_preview.effect_hash' IN pg_get_functiondef(to_regprocedure('qintopia_assert_stage11_protocol_evidence(text,text)'))) > 0, false)::integer + COALESCE(position('stage11_preview_evidence_immutable' IN pg_get_functiondef(to_regprocedure('qintopia_preserve_stage11_preview_evidence()'))) > 0, false)::integer")"
stage11_triggers="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A') AND trigger.tgdeferrable AND trigger.tginitdeferred AND ((relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_shorten_before_timeline' AND trigger.tgtype = 5 AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage11_validate_shorten_before_timeline' AND trigger.tgtype = 21 AND handler.proname = 'qintopia_validate_stage11_shorten_before_timeline') OR (relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_move_combination' AND trigger.tgtype = 5 AND handler.proname = 'qintopia_validate_stage11_move_combination') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage11_validate_move_combination' AND trigger.tgtype = 21 AND handler.proname = 'qintopia_validate_stage11_move_execution'))")"
stage11_immediate_triggers="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgenabled IN ('O','A') AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND ((relation.relname = 'pricing_revisions' AND trigger.tgname = 'pricing_revisions_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_revision') OR (relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_amendment') OR (relation.relname = 'coverage_items' AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_update' AND trigger.tgtype = 19 AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage') OR (relation.relname = 'coverage_items' AND trigger.tgname = 'coverage_items_stage11_preserve_consumed_delete' AND trigger.tgtype = 11 AND handler.proname = 'qintopia_preserve_stage11_consumed_coverage') OR (relation.relname = 'entitlement_ledger' AND trigger.tgname = 'entitlement_ledger_stage11_validate_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_validate_stage11_move_ledger') OR (relation.relname = 'collection_facts' AND trigger.tgname = 'collection_facts_stage11_reject_move' AND trigger.tgtype = 7 AND handler.proname = 'qintopia_reject_stage11_move_collection') OR (relation.relname = 'inventory_claims' AND trigger.tgname = 'inventory_claims_validate_source' AND trigger.tgtype = 23 AND handler.proname = 'qintopia_validate_inventory_claim_source') OR (relation.relname = 'command_previews' AND trigger.tgname = 'command_previews_stage11_preserve_evidence' AND trigger.tgtype = 19 AND handler.proname = 'qintopia_preserve_stage11_preview_evidence'))")"
if [[ "$required_migrations" != "28" || "$unknown_migrations" != "0" || "$stage10_functions" != "3" || "$stage10_triggers" != "2" || "$stage10_immediate_triggers" != "3" || "$stage11_functions" != "14" || "$stage11_replacements" != "2" || "$stage11_body_markers" != "8" || "$stage11_triggers" != "4" || "$stage11_immediate_triggers" != "8" ]]; then
  printf 'Restore target %s did not reach a complete stage 11 schema (migrations %s/28, stage11 functions %s/14, replacements %s/2, body markers %s/8, deferred triggers %s/4, immediate trigger bindings %s/8).\n' "$target" "$required_migrations" "$stage11_functions" "$stage11_replacements" "$stage11_body_markers" "$stage11_triggers" "$stage11_immediate_triggers" >&2
  cleanup_partial_target
  exit 1
fi
trap - ERR
target_created=false
printf 'Restored %s into new database %s\n' "$backup" "$target"
