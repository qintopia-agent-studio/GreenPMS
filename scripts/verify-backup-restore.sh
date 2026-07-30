#!/usr/bin/env bash
set -euo pipefail

container="${POSTGRES_CONTAINER:-qintopia-postgres}"
user="${POSTGRES_USER:-qintopia}"
password="${POSTGRES_PASSWORD:-qintopia}"
host_port="${POSTGRES_HOST_PORT:-55432}"
live_database="${POSTGRES_DB:-qintopia}"
run_id="$$_$(date +%s)_${RANDOM}"
source_database="qintopia_restore_source_${run_id}"
target_database="qintopia_restore_verify_${run_id}"
workdir="$(mktemp -d)"
bootstrap="$workdir/bootstrap.dump"
restore_point="$workdir/restore-point.dump"
boundary_marker="__qintopia_restore_boundary_$$_$(date +%s)_${RANDOM}__"
sentinel_property_id="prop_restore_sentinel_${run_id}"
fixture_reference="RESTORE-${run_id}"
catalog_batch_id="qintopia-2026-feishu-revision-561-user-confirmed-v4"
trap 'docker exec "$container" dropdb -U "$user" --if-exists "$source_database" >/dev/null 2>&1 || true; docker exec "$container" dropdb -U "$user" --if-exists "$target_database" >/dev/null 2>&1 || true; rm -rf "$workdir"' EXIT

run_app_command() {
  local database="$1"
  shift
  if [[ -n "${VERIFY_APP_IMAGE:-}" ]]; then
    local docker_arguments=(
      run --rm --init
      --add-host host.docker.internal:host-gateway
      -e "DATABASE_URL=postgres://$user:$password@host.docker.internal:$host_port/$database"
    )
    if [[ -n "${RESTORE_FIXTURE_REFERENCE:-}" ]]; then
      docker_arguments+=(-e "RESTORE_FIXTURE_REFERENCE=$RESTORE_FIXTURE_REFERENCE")
    fi
    docker "${docker_arguments[@]}" "$VERIFY_APP_IMAGE" "$@"
    return
  fi
  DATABASE_URL="postgres://$user:$password@127.0.0.1:$host_port/$database" "$@"
}

docker exec "$container" pg_dump -U "$user" -Fc "$live_database" > "$bootstrap"
docker exec "$container" createdb -U "$user" "$source_database"
docker exec -i "$container" pg_restore -U "$user" -d "$source_database" --no-owner --no-privileges < "$bootstrap"
docker exec "$container" psql -U "$user" -d "$source_database" -v ON_ERROR_STOP=1 -c "
  BEGIN;
  DROP TRIGGER IF EXISTS pricing_revisions_stage10_validate ON pricing_revisions;
  DROP TRIGGER IF EXISTS amendments_stage10_reject_checkout_bypass ON amendments;
  DROP TRIGGER IF EXISTS entitlement_ledger_stage10_reject_write ON entitlement_ledger;
  DROP TRIGGER IF EXISTS amendments_stage10_validate_combination ON amendments;
  DROP TRIGGER IF EXISTS command_executions_stage10_validate_combination ON command_executions;
  DROP FUNCTION IF EXISTS qintopia_validate_stage10_pricing_revision();
  DROP FUNCTION IF EXISTS qintopia_reject_stage10_checkout_bypass();
  DROP FUNCTION IF EXISTS qintopia_reject_stage10_entitlement_write();
  DROP FUNCTION IF EXISTS qintopia_validate_stage10_shorten_combination();
  DROP FUNCTION IF EXISTS qintopia_validate_stage10_shorten_execution();
  DROP FUNCTION IF EXISTS qintopia_assert_stage10_shorten_combination(text);
  DROP FUNCTION IF EXISTS qintopia_stage10_property_today(text);
  DELETE FROM schema_migrations WHERE name = '027_stage10_stay_shortening_guards.sql';
  COMMIT;
" >/dev/null
source_stage9_migration_count="$(docker exec "$container" psql -U "$user" -d "$source_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name ~ '^[0-9]{3}_.*[.]sql$'")"
test "$source_stage9_migration_count" = "26"
docker exec "$container" psql -U "$user" -d "$source_database" -v ON_ERROR_STOP=1 -c "INSERT INTO properties(id, code, name, timezone, currency) VALUES ('$sentinel_property_id', '$sentinel_property_id', 'Restore sentinel', 'Asia/Shanghai', 'CNY')" >/dev/null
run_app_command "$source_database" npm run db:seed >/dev/null
RESTORE_FIXTURE_REFERENCE="$fixture_reference" run_app_command "$source_database" node --import tsx tests/helpers/create-restore-fixture.ts >/dev/null
run_app_command "$source_database" npm run db:import:2026 >/dev/null
source_catalog_content_hash="$(docker exec "$container" psql -U "$user" -d "$source_database" -Atc "SELECT content_hash FROM catalog_import_batches WHERE id = '$catalog_batch_id'")"
source_catalog_snapshot_hash="$(docker exec "$container" psql -U "$user" -d "$source_database" -Atc "SELECT md5(source_snapshot::text) FROM catalog_import_batches WHERE id = '$catalog_batch_id'")"

docker exec "$container" pg_dump -U "$user" -Fc "$source_database" > "$restore_point"
docker exec "$container" psql -U "$user" -d "$source_database" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(name) VALUES ('$boundary_marker')" >/dev/null

ALLOW_RESTORE=true POSTGRES_CONTAINER="$container" POSTGRES_USER="$user" POSTGRES_PASSWORD="$password" POSTGRES_HOST_PORT="$host_port" POSTGRES_DB="$live_database" bash ./scripts/restore.sh "$restore_point" "$target_database" >/dev/null

source_marker="$(docker exec "$container" psql -U "$user" -d "$source_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name = '$boundary_marker'")"
target_marker="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name = '$boundary_marker'")"
target_sentinel="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM properties WHERE id = '$sentinel_property_id'")"
required_migrations="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM schema_migrations WHERE name IN ('001_initial.sql','002_immutability.sql','003_active_coverage_uniqueness.sql','004_security_identity_guards.sql','005_core_identity_and_entitlement_guards.sql','006_property_scoped_idempotency.sql','007_reference_catalog.sql','008_reference_catalog_sealing.sql','009_booking_channels_and_transaction_references.sql','010_qintopia_2026_catalog_pricing_and_free_stays.sql','011_core_fact_shape_guards.sql','012_legacy_demo_inventory_catalog_backfill.sql','013_room_status_operations.sql','014_new_order_primary_guest_nickname.sql','015_generated_room_operational_codes.sql','016_member_property_links.sql','017_membership_orders.sql','018_member_stay_identity_and_coverage_guards.sql','019_member_stay_booking_channel_rules.sql','020_whole_room_occupants.sql','021_defer_internal_use.sql','022_order_occupant_corrections.sql','023_collection_fact_pricing_revision.sql','024_free_stay_category_code.sql','025_channel_order_atomic_pricing.sql','026_stage9_stay_change_guards.sql','027_stage10_stay_shortening_guards.sql')")"
stage10_function_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT (to_regprocedure('qintopia_assert_stage10_shorten_combination(text)') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage10_shorten_combination()') IS NOT NULL)::integer + (to_regprocedure('qintopia_validate_stage10_pricing_revision()') IS NOT NULL)::integer")"
stage10_trigger_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND trigger.tgdeferrable AND trigger.tginitdeferred AND trigger.tgenabled <> 'D' AND ((relation.relname = 'amendments' AND trigger.tgname = 'amendments_stage10_validate_combination' AND handler.proname = 'qintopia_validate_stage10_shorten_combination') OR (relation.relname = 'command_executions' AND trigger.tgname = 'command_executions_stage10_validate_combination' AND handler.proname = 'qintopia_validate_stage10_shorten_execution'))")"
stage10_immediate_trigger_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM pg_trigger AS trigger JOIN pg_proc AS handler ON handler.oid = trigger.tgfoid WHERE NOT trigger.tgisinternal AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND trigger.tgenabled <> 'D' AND trigger.tgtype = 7 AND ((trigger.tgrelid = to_regclass('pricing_revisions') AND trigger.tgname = 'pricing_revisions_stage10_validate' AND handler.proname = 'qintopia_validate_stage10_pricing_revision') OR (trigger.tgrelid = to_regclass('amendments') AND trigger.tgname = 'amendments_stage10_reject_checkout_bypass' AND handler.proname = 'qintopia_reject_stage10_checkout_bypass') OR (trigger.tgrelid = to_regclass('entitlement_ledger') AND trigger.tgname = 'entitlement_ledger_stage10_reject_write' AND handler.proname = 'qintopia_reject_stage10_entitlement_write'))")"
member_property_link_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM member_property_links')"
operational_reference_columns="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM information_schema.columns WHERE (table_name = 'orders' AND column_name IN ('booking_channel_code','channel_order_reference')) OR (table_name = 'collection_facts' AND column_name = 'transaction_reference')")"
operational_reference_triggers="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('orders_validate_new_channel','collection_facts_validate_new_transaction_reference')")"
one_stay_violations="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM orders o LEFT JOIN stays s ON s.order_id=o.id GROUP BY o.id HAVING count(s.id) <> 1' | wc -l | tr -d ' ')"
missing_revisions="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM orders WHERE current_revision_id IS NULL')"
room_bed_conflicts="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM inventory_room_days r JOIN inventory_bed_days b ON b.room_id=r.room_id AND b.service_date=r.service_date WHERE r.whole_claim_id IS NOT NULL AND b.bed_claim_id IS NOT NULL')"
catalog_batch_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM catalog_import_batches WHERE id = '$catalog_batch_id' AND sealed_at IS NOT NULL AND jsonb_typeof(source_snapshot) = 'object' AND length(content_hash) = 64")"
catalog_inventory_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM inventory_catalog_entries WHERE import_batch_id = '$catalog_batch_id'")"
catalog_rate_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM reference_rate_entries WHERE import_batch_id = '$catalog_batch_id'")"
catalog_membership_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM reference_membership_products WHERE import_batch_id = '$catalog_batch_id'")"
target_catalog_content_hash="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT content_hash FROM catalog_import_batches WHERE id = '$catalog_batch_id'")"
target_catalog_snapshot_hash="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT md5(source_snapshot::text) FROM catalog_import_batches WHERE id = '$catalog_batch_id'")"
fixture_order_id="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT id FROM orders WHERE booking_channel_code = 'CTRIP' AND channel_order_reference = '$fixture_reference'")"
fixture_stay_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM stays WHERE order_id = '$fixture_order_id'")"
fixture_amendment_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM amendments WHERE order_id = '$fixture_order_id'")"
fixture_revision_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM pricing_revisions WHERE order_id = '$fixture_order_id'")"
fixture_claim_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM inventory_claims WHERE source_type = 'ORDER_SEGMENT' AND source_id IN (SELECT id FROM stay_segments WHERE stay_id IN (SELECT id FROM stays WHERE order_id = '$fixture_order_id')) AND active")"
fixture_fact_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM collection_facts WHERE order_id = '$fixture_order_id' AND transaction_reference IN ('$fixture_reference-COLLECTION-1', '$fixture_reference-COLLECTION-2', '$fixture_reference-REFUND-1')")"
fixture_refund_reference_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM collection_facts refund JOIN collection_facts collection ON collection.fact_id = refund.references_fact_id WHERE refund.order_id = '$fixture_order_id' AND refund.fact_type = 'REFUND' AND refund.transaction_reference = '$fixture_reference-REFUND-1' AND collection.order_id = refund.order_id AND collection.fact_type = 'COLLECTION' AND collection.transaction_reference = '$fixture_reference-COLLECTION-1'")"
fixture_receipt_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM command_receipts receipt JOIN command_executions execution ON execution.id = receipt.command_id WHERE execution.command_type IN ('CREATE_ORDER','RECORD_COLLECTION','RECORD_REFUND') AND receipt.business_committed AND receipt.result ->> 'orderId' = '$fixture_order_id'")"
fixture_audit_count="$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT count(*) FROM audit_entries WHERE command_id IN (SELECT command_id FROM collection_facts WHERE order_id = '$fixture_order_id') AND decision = 'ALLOWED'")"

test "$source_marker" = "1"
test "$target_marker" = "0"
test "$target_sentinel" = "1"
test "$required_migrations" = "27"
test "$stage10_function_count" = "3"
test "$stage10_trigger_count" = "2"
test "$stage10_immediate_trigger_count" = "3"
test "$member_property_link_count" -ge 1
test "$operational_reference_columns" = "3"
test "$operational_reference_triggers" = "2"
test "$one_stay_violations" = "0"
test "$missing_revisions" = "0"
test "$room_bed_conflicts" = "0"
test "$catalog_batch_count" = "1"
test "$catalog_inventory_count" = "8"
test "$catalog_rate_count" = "32"
test "$catalog_membership_count" = "3"
test "$source_catalog_content_hash" = "$target_catalog_content_hash"
test "$source_catalog_snapshot_hash" = "$target_catalog_snapshot_hash"
test -n "$fixture_order_id"
test "$fixture_stay_count" = "1"
test "$fixture_amendment_count" = "1"
test "$fixture_revision_count" = "1"
test "$fixture_claim_count" = "2"
test "$fixture_fact_count" = "3"
test "$fixture_refund_reference_count" = "1"
test "$fixture_receipt_count" = "4"
test "$fixture_audit_count" = "3"
catalog_append_error="$workdir/catalog-append-error.txt"
if docker exec "$container" psql -U "$user" -d "$target_database" -v ON_ERROR_STOP=1 -c "INSERT INTO inventory_catalog_entries(id, import_batch_id, type_code, type_name, bathroom_type, sell_unit_kind, physical_room_count, units_per_room, sellable_unit_count, electricity_included, execution_state, source_sheet, source_range) VALUES ('restore_illegal_catalog_append', '$catalog_batch_id', 'restore_illegal_catalog_append', 'Restore illegal append', 'SHARED', 'ROOM', 1, NULL, 1, false, 'REFERENCE_ONLY', 'restore', 'A1')" >/dev/null 2>"$catalog_append_error"; then
  printf 'Restored catalog batch unexpectedly accepted a child append after sealing.\n' >&2
  exit 1
fi
if ! grep -q 'sealed or missing' "$catalog_append_error"; then
  sed -n '1,80p' "$catalog_append_error" >&2
  printf 'Restored catalog append failed for an unexpected reason.\n' >&2
  exit 1
fi
printf 'Backup/restore verified: a populated stage 9 backup upgraded to the complete stage 10 schema with non-empty Order/Stay/revision/inventory/collection/refund/Receipt/audit facts, core invariants, and the sealed 8/32/3 reference catalog intact.\n'
