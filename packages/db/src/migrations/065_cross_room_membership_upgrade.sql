-- Extend only typed, reviewed stay conversions. Existing identity, money, inventory,
-- execution graph and entitlement guards remain in force.
LOCK TABLE amendments, coverage_items, entitlement_ledger, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION qintopia_cross_room_upgrade_matches(
  target_order_id text, target_membership_id text, target_unit_id text, target_date date DEFAULT NULL
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM amendments a
    JOIN orders o ON o.id = a.order_id
    JOIN command_executions e ON e.id = a.command_id
    JOIN membership_orders m ON m.id = target_membership_id
      AND m.created_by_command_id = e.id AND m.activated_by_command_id = e.id
    JOIN inventory_units u ON u.id = target_unit_id AND u.property_id = o.property_id
    WHERE a.order_id = target_order_id
      AND a.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
      AND e.command_type = a.amendment_type AND e.property_id = o.property_id
      AND e.state IN ('EXECUTING', 'APPLIED')
      AND m.property_id = o.property_id AND m.member_id = o.member_id
      AND m.contract_id = o.member_contract_id AND m.status = 'ACTIVE'
      AND m.allowed_inventory_kind = 'ROOM' AND m.entitlement_unit_kind = 'ROOM_NIGHT'
      AND u.kind = 'ROOM' AND u.room_type_code <> m.allowed_room_type_code
      AND NULLIF(btrim(a.payload #>> '{crossRoomUpgrade,reason}'), '') IS NOT NULL
      AND char_length(a.payload #>> '{crossRoomUpgrade,reason}') <= 200
      AND a.payload -> 'crossRoomUpgrade' = jsonb_build_object(
        'kind', 'TEMPORARY_OTHER_ROOM_UPGRADE',
        'reason', a.payload #>> '{crossRoomUpgrade,reason}',
        'originalRoomTypeCode', m.allowed_room_type_code,
        'actualInventoryUnitId', u.id,
        'actualRoomTypeCode', u.room_type_code,
        'arrivalDate', a.payload #>> '{entitlement,serviceDates,0}',
        'departureDate', ((a.payload #>> '{entitlement,serviceDates,-1}')::date + 1)::text
      )
      AND (target_date IS NULL OR a.payload #> '{entitlement,serviceDates}' @> jsonb_build_array(target_date::text))
      AND EXISTS (
        SELECT 1 FROM command_previews p
        WHERE p.command_type = e.command_type AND p.subject_id = e.subject_id
          AND p.property_id = e.property_id AND p.effect = a.payload
          AND p.basis_versions ->> 'orderStatus' = 'CHECKED_IN'
          AND p.normalized_input ->> 'orderId' = o.id
          AND p.normalized_input ->> 'membershipProductId' = m.product_id
          AND btrim(p.normalized_input ->> 'temporaryOtherRoomReason') = a.payload #>> '{crossRoomUpgrade,reason}'
      )
  );
$$;

-- Keep the existing guard bodies; require the exact known clause before changing
-- the three room-type checks. No global constraint or trigger is disabled.
DO $migration$
DECLARE definition text; old_clause text; new_clause text;
BEGIN
  SELECT pg_get_functiondef('qintopia_validate_coverage_ownership()'::regprocedure) INTO definition;
  old_clause := 'IF NOT temporary_other_room_evidence THEN';
  new_clause := 'IF NOT temporary_other_room_evidence AND NOT qintopia_cross_room_upgrade_matches(NEW.order_id, membership_order_id, NEW.inventory_unit_id, NEW.service_date) THEN';
  IF position(old_clause IN definition) = 0 THEN RAISE EXCEPTION 'coverage ownership guard not recognized'; END IF;
  EXECUTE replace(definition, old_clause, new_clause);

  SELECT pg_get_functiondef('qintopia_validate_conversion_consume_entitlement_fact()'::regprocedure) INTO definition;
  old_clause := 'AND coverage_room_type_code = target_membership_order.allowed_room_type_code)';
  new_clause := 'AND (coverage_room_type_code = target_membership_order.allowed_room_type_code OR qintopia_cross_room_upgrade_matches(NEW.order_id, target_membership_order.id, target_coverage.inventory_unit_id, NEW.service_date)))';
  IF position(old_clause IN definition) = 0 THEN RAISE EXCEPTION 'conversion consume guard not recognized'; END IF;
  EXECUTE replace(definition, old_clause, new_clause);

  SELECT pg_get_functiondef('qintopia_assert_stage13_stay_conversion_command_v033(text)'::regprocedure) INTO definition;
  old_clause := 'OR unit.room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code';
  new_clause := 'OR (unit.room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code AND NOT qintopia_cross_room_upgrade_matches(target_order.id, target_membership_order.id, coverage.inventory_unit_id, coverage.service_date))';
  IF position(old_clause IN definition) = 0 THEN RAISE EXCEPTION 'conversion graph guard not recognized'; END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END;
$migration$;

CREATE FUNCTION qintopia_guard_cross_room_upgrade() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE membership_id text; actual_unit_id text;
BEGIN
  IF NEW.amendment_type IN ('EXTEND_STAY', 'MOVE_UNIT', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS')
    AND EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' AND payload ? 'crossRoomUpgrade') THEN
    RAISE EXCEPTION 'cross-room upgrade cannot extend or move its reviewed accommodation'
      USING ERRCODE = '23514', CONSTRAINT = 'cross_room_upgrade_lifecycle';
  END IF;
  IF NEW.amendment_type <> 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' OR NOT (NEW.payload ? 'crossRoomUpgrade') THEN RETURN NEW; END IF;
  SELECT id INTO membership_id FROM membership_orders WHERE activated_by_command_id = NEW.command_id;
  actual_unit_id := NEW.payload #>> '{crossRoomUpgrade,actualInventoryUnitId}';
  IF NOT qintopia_cross_room_upgrade_matches(NEW.order_id, membership_id, actual_unit_id)
    OR NOT EXISTS (SELECT 1 FROM entitlement_ledger WHERE command_id = NEW.command_id AND entry_type = 'CONVERSION_CONSUME')
    OR EXISTS (
      SELECT 1 FROM entitlement_ledger l LEFT JOIN coverage_items c ON c.id = l.coverage_id
      WHERE l.command_id = NEW.command_id AND l.entry_type = 'CONVERSION_CONSUME'
        AND (c.id IS NULL OR c.inventory_unit_id IS DISTINCT FROM actual_unit_id)
    ) THEN
    RAISE EXCEPTION 'cross-room upgrade requires reviewed, in-house, single-room conversion evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'cross_room_upgrade_evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER cross_room_upgrade_evidence_guard
AFTER INSERT ON amendments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_cross_room_upgrade();

REVOKE ALL ON FUNCTION qintopia_cross_room_upgrade_matches(text,text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_cross_room_upgrade_matches(text,text,text,date) TO qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_guard_cross_room_upgrade() FROM PUBLIC;
