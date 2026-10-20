-- Allow upgrade-time confirmation for a continuous sequence of temporary whole-room arrangements.
-- Keep the original single-room evidence contract valid and preserve all existing guards.
LOCK TABLE amendments, coverage_items, entitlement_ledger, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION qintopia_cross_room_upgrade_matches(
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
      AND NULLIF(btrim(a.payload #>> '{crossRoomUpgrade,reason}'), '') IS NOT NULL
      AND char_length(a.payload #>> '{crossRoomUpgrade,reason}') <= 200
      AND (
        (
          a.payload #>> '{crossRoomUpgrade,kind}' = 'TEMPORARY_OTHER_ROOM_UPGRADE'
          AND u.kind = 'ROOM' AND u.room_type_code <> m.allowed_room_type_code
          AND a.payload -> 'crossRoomUpgrade' = jsonb_build_object(
            'kind', 'TEMPORARY_OTHER_ROOM_UPGRADE',
            'reason', a.payload #>> '{crossRoomUpgrade,reason}',
            'originalRoomTypeCode', m.allowed_room_type_code,
            'actualInventoryUnitId', u.id,
            'actualRoomTypeCode', u.room_type_code,
            'arrivalDate', a.payload #>> '{entitlement,serviceDates,0}',
            'departureDate', ((a.payload #>> '{entitlement,serviceDates,-1}')::date + 1)::text
          )
        )
        OR (
          a.payload #>> '{crossRoomUpgrade,kind}' = 'TEMPORARY_ROOM_SEQUENCE_UPGRADE'
          AND a.payload #>> '{crossRoomUpgrade,originalRoomTypeCode}' = m.allowed_room_type_code
          AND a.payload #>> '{crossRoomUpgrade,arrivalDate}' = o.arrival_date::text
          AND a.payload #>> '{crossRoomUpgrade,departureDate}' = o.departure_date::text
          AND (SELECT count(*) FROM jsonb_object_keys(a.payload -> 'crossRoomUpgrade')) = 8
          AND (a.payload -> 'crossRoomUpgrade') ?& ARRAY[
            'kind', 'reason', 'originalRoomTypeCode', 'actualInventoryUnitId',
            'actualRoomTypeCode', 'arrivalDate', 'departureDate', 'segments'
          ]
          AND jsonb_typeof(a.payload #> '{crossRoomUpgrade,segments}') = 'array'
          AND jsonb_array_length(a.payload #> '{crossRoomUpgrade,segments}') >= 2
          AND (a.payload #> '{crossRoomUpgrade,segments,0}') ->> 'arrivalDate' = o.arrival_date::text
          AND (a.payload #> '{crossRoomUpgrade,segments}') -> (jsonb_array_length(a.payload #> '{crossRoomUpgrade,segments}') - 1) ->> 'departureDate' = o.departure_date::text
          AND (a.payload #> '{crossRoomUpgrade,segments,0}') ->> 'inventoryUnitId' = a.payload #>> '{crossRoomUpgrade,actualInventoryUnitId}'
          AND (a.payload #> '{crossRoomUpgrade,segments,0}') ->> 'roomTypeCode' = a.payload #>> '{crossRoomUpgrade,actualRoomTypeCode}'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(a.payload #> '{crossRoomUpgrade,segments}') WITH ORDINALITY AS segment(value, ordinal)
            LEFT JOIN inventory_units segment_unit
              ON segment_unit.id = segment.value ->> 'inventoryUnitId'
             AND segment_unit.property_id = o.property_id
            WHERE segment_unit.id IS NULL
              OR segment_unit.kind <> 'ROOM'
              OR (SELECT count(*) FROM jsonb_object_keys(segment.value)) <> 4
              OR NOT (segment.value ?& ARRAY['inventoryUnitId', 'roomTypeCode', 'arrivalDate', 'departureDate'])
              OR segment.value ->> 'roomTypeCode' IS DISTINCT FROM segment_unit.room_type_code
              OR NULLIF(segment.value ->> 'arrivalDate', '') IS NULL
              OR NULLIF(segment.value ->> 'departureDate', '') IS NULL
              OR (segment.value ->> 'departureDate')::date <= (segment.value ->> 'arrivalDate')::date
          )
          AND NOT EXISTS (
            SELECT 1
            FROM (
              SELECT
                (segment.value ->> 'arrivalDate')::date AS arrival_date,
                (segment.value ->> 'departureDate')::date AS departure_date,
                lag((segment.value ->> 'departureDate')::date) OVER (ORDER BY segment.ordinal) AS previous_departure_date
              FROM jsonb_array_elements(a.payload #> '{crossRoomUpgrade,segments}') WITH ORDINALITY AS segment(value, ordinal)
            ) ordered_segments
            WHERE ordered_segments.previous_departure_date IS NOT NULL
              AND ordered_segments.arrival_date <> ordered_segments.previous_departure_date
          )
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(a.payload #> '{crossRoomUpgrade,segments}') AS segment(value)
            WHERE segment.value ->> 'inventoryUnitId' = target_unit_id
              AND (target_date IS NULL OR ((segment.value ->> 'arrivalDate')::date <= target_date AND target_date < (segment.value ->> 'departureDate')::date))
          )
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(a.payload #> '{crossRoomUpgrade,segments}') AS segment(value)
            JOIN inventory_units target_segment_unit
              ON target_segment_unit.id = segment.value ->> 'inventoryUnitId'
             AND target_segment_unit.property_id = o.property_id
            WHERE target_segment_unit.room_type_code = m.allowed_room_type_code
          )
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(a.payload #> '{crossRoomUpgrade,segments}') AS segment(value)
            JOIN inventory_units different_segment_unit
              ON different_segment_unit.id = segment.value ->> 'inventoryUnitId'
             AND different_segment_unit.property_id = o.property_id
            WHERE different_segment_unit.room_type_code IS DISTINCT FROM m.allowed_room_type_code
          )
        )
      )
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

CREATE OR REPLACE FUNCTION qintopia_guard_cross_room_upgrade() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE membership_id text; actual_unit_id text; evidence_kind text;
BEGIN
  IF NEW.amendment_type IN ('EXTEND_STAY', 'MOVE_UNIT', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS')
    AND EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' AND payload ? 'crossRoomUpgrade') THEN
    RAISE EXCEPTION 'cross-room upgrade cannot extend or move its reviewed accommodation'
      USING ERRCODE = '23514', CONSTRAINT = 'cross_room_upgrade_lifecycle';
  END IF;
  IF NEW.amendment_type <> 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' OR NOT (NEW.payload ? 'crossRoomUpgrade') THEN RETURN NEW; END IF;
  SELECT id INTO membership_id FROM membership_orders WHERE activated_by_command_id = NEW.command_id;
  evidence_kind := NEW.payload #>> '{crossRoomUpgrade,kind}';
  actual_unit_id := NEW.payload #>> '{crossRoomUpgrade,actualInventoryUnitId}';
  IF evidence_kind = 'TEMPORARY_OTHER_ROOM_UPGRADE' THEN
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
  ELSIF evidence_kind = 'TEMPORARY_ROOM_SEQUENCE_UPGRADE' THEN
    IF NOT EXISTS (SELECT 1 FROM entitlement_ledger WHERE command_id = NEW.command_id AND entry_type = 'CONVERSION_CONSUME')
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger l
        LEFT JOIN coverage_items c ON c.id = l.coverage_id
        WHERE l.command_id = NEW.command_id AND l.entry_type = 'CONVERSION_CONSUME'
          AND (c.id IS NULL OR NOT qintopia_cross_room_upgrade_matches(NEW.order_id, membership_id, c.inventory_unit_id, c.service_date))
      )
      OR (SELECT count(*) FROM entitlement_ledger WHERE command_id = NEW.command_id AND entry_type = 'CONVERSION_CONSUME')
        <> jsonb_array_length(NEW.payload #> '{entitlement,serviceDates}') THEN
      RAISE EXCEPTION 'cross-room sequence upgrade requires reviewed, continuous whole-room conversion evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'cross_room_upgrade_evidence';
    END IF;
  ELSE
    RAISE EXCEPTION 'cross-room upgrade evidence kind is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'cross_room_upgrade_evidence';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_cross_room_upgrade_matches(text,text,text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_cross_room_upgrade_matches(text,text,text,date) TO qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_guard_cross_room_upgrade() FROM PUBLIC;
