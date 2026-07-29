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
live_database="${POSTGRES_DB:-qintopia}"
target_created=false
target_oid=""

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
required_migrations="$(docker exec "$container" psql -U "$user" -d "$target" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM schema_migrations WHERE name IN ('001_initial.sql','002_immutability.sql','003_active_coverage_uniqueness.sql','004_security_identity_guards.sql','005_core_identity_and_entitlement_guards.sql','006_property_scoped_idempotency.sql','007_reference_catalog.sql','008_reference_catalog_sealing.sql','009_booking_channels_and_transaction_references.sql','010_qintopia_2026_catalog_pricing_and_free_stays.sql','011_core_fact_shape_guards.sql','012_legacy_demo_inventory_catalog_backfill.sql','013_room_status_operations.sql','014_new_order_primary_guest_nickname.sql','015_generated_room_operational_codes.sql','016_member_property_links.sql','017_membership_orders.sql','018_member_stay_identity_and_coverage_guards.sql','019_member_stay_booking_channel_rules.sql','020_whole_room_occupants.sql','021_defer_internal_use.sql','022_order_occupant_corrections.sql','023_collection_fact_pricing_revision.sql','024_free_stay_category_code.sql','025_channel_order_atomic_pricing.sql','026_stage9_stay_change_guards.sql')")"
if [[ "$required_migrations" != "26" ]]; then
  printf 'Restore target %s is missing required migrations (found %s of 26).\n' "$target" "$required_migrations" >&2
  cleanup_partial_target
  exit 1
fi
trap - ERR
target_created=false
printf 'Restored %s into new database %s\n' "$backup" "$target"
