CREATE OR REPLACE FUNCTION qintopia_reject_new_internal_use() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'internal use is deferred until its operating boundary is approved'
    USING ERRCODE = '23514', CONSTRAINT = 'internal_use_deferred';
END;
$$;

CREATE TRIGGER internal_use_blocks_reject_new
BEFORE INSERT OR UPDATE ON internal_use_blocks
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_new_internal_use();

CREATE TRIGGER inventory_claims_reject_new_internal_use
BEFORE INSERT OR UPDATE ON inventory_claims
FOR EACH ROW
WHEN (NEW.source_type = 'INTERNAL_USE')
EXECUTE FUNCTION qintopia_reject_new_internal_use();

CREATE OR REPLACE FUNCTION qintopia_reject_deferred_unavailable_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active IS TRUE AND EXISTS (
    SELECT 1
    FROM internal_use_blocks AS block
    WHERE block.property_id = NEW.property_id
      AND block.room_id = NEW.room_id
      AND block.status = 'ACTIVE'
      AND block.arrival_date <= NEW.service_date
      AND NEW.service_date < block.departure_date
      AND (
        NEW.inventory_unit_id = NEW.room_id
        OR block.inventory_unit_id = block.room_id
        OR block.inventory_unit_id = NEW.inventory_unit_id
      )
  ) THEN
    RAISE EXCEPTION 'inventory overlaps preserved unavailable history'
      USING ERRCODE = '23514', CONSTRAINT = 'deferred_unavailable_inventory_conflict';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_claims_reject_deferred_unavailable_overlap
BEFORE INSERT ON inventory_claims
FOR EACH ROW
WHEN (NEW.source_type <> 'INTERNAL_USE')
EXECUTE FUNCTION qintopia_reject_deferred_unavailable_overlap();

CREATE OR REPLACE FUNCTION qintopia_assert_complete_maintenance_release(target_lock_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  lock_row maintenance_locks%ROWTYPE;
  expected_claim_count integer;
  actual_claim_count integer;
BEGIN
  SELECT * INTO lock_row FROM maintenance_locks WHERE id = target_lock_id;
  IF lock_row.id IS NULL OR lock_row.status <> 'RELEASED' THEN
    RAISE EXCEPTION 'maintenance Claim release requires the complete Block release in the same transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'maintenance_claims_complete_release';
  END IF;

  expected_claim_count := lock_row.departure_date - lock_row.arrival_date;
  SELECT count(*) INTO actual_claim_count
  FROM inventory_claims
  WHERE source_type = 'MAINTENANCE' AND source_id = target_lock_id;

  IF actual_claim_count <> expected_claim_count OR EXISTS (
    SELECT 1
    FROM generate_series(lock_row.arrival_date, lock_row.departure_date - 1, interval '1 day') AS expected(service_date)
    LEFT JOIN inventory_claims AS claim
      ON claim.source_type = 'MAINTENANCE'
      AND claim.source_id = target_lock_id
      AND claim.service_date = expected.service_date::date
      AND claim.inventory_unit_id = lock_row.inventory_unit_id
      AND claim.property_id = lock_row.property_id
    GROUP BY expected.service_date
    HAVING count(claim.id) <> 1
      OR bool_or(claim.active IS TRUE)
      OR bool_or(claim.released_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'maintenance release requires exactly one released Claim for every service date'
      USING ERRCODE = '23514', CONSTRAINT = 'maintenance_claims_complete_release';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_released_maintenance_claim_set() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_lock_id text;
BEGIN
  IF TG_TABLE_NAME = 'inventory_claims' THEN
    target_lock_id := NEW.source_id;
  ELSE
    target_lock_id := NEW.id;
  END IF;
  PERFORM qintopia_assert_complete_maintenance_release(target_lock_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER maintenance_claim_release_complete
AFTER UPDATE ON inventory_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.source_type = 'MAINTENANCE' AND OLD.active IS TRUE AND NEW.active IS FALSE)
EXECUTE FUNCTION qintopia_validate_released_maintenance_claim_set();

CREATE CONSTRAINT TRIGGER maintenance_block_release_complete
AFTER UPDATE ON maintenance_locks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED')
EXECUTE FUNCTION qintopia_validate_released_maintenance_claim_set();
