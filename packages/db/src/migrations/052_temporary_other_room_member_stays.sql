LOCK TABLE quotes, orders, stays, stay_segments, amendments, pricing_revisions,
  coverage_items, entitlement_ledger, inventory_claims, collection_facts,
  membership_orders, member_contracts, entitlement_lots, inventory_units,
  command_executions, command_receipts, audit_entries
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE quotes
  ADD COLUMN temporary_other_room_arrangement jsonb,
  ADD CONSTRAINT quotes_temporary_other_room_arrangement_shape CHECK (
    temporary_other_room_arrangement IS NULL
    OR (
      jsonb_typeof(temporary_other_room_arrangement) = 'object'
      AND temporary_other_room_arrangement ->> 'kind' = 'TEMPORARY_OTHER_ROOM'
      AND temporary_other_room_arrangement ->> 'originalInventoryKind' = 'ROOM'
      AND temporary_other_room_arrangement ->> 'entitlementUnitKind' = 'ROOM_NIGHT'
      AND temporary_other_room_arrangement ->> 'actualInventoryKind' = 'ROOM'
      AND temporary_other_room_arrangement ->> 'originalRoomTypeCode'
        IS DISTINCT FROM temporary_other_room_arrangement ->> 'actualRoomTypeCode'
      AND temporary_other_room_arrangement ? 'membershipOrderId'
      AND temporary_other_room_arrangement ? 'memberContractId'
      AND temporary_other_room_arrangement ? 'entitlementLotId'
      AND temporary_other_room_arrangement ? 'actualInventoryUnitId'
      AND temporary_other_room_arrangement ? 'originalRoomTypeCode'
      AND temporary_other_room_arrangement ? 'actualRoomTypeCode'
      AND temporary_other_room_arrangement ? 'arrivalDate'
      AND temporary_other_room_arrangement ? 'departureDate'
      AND temporary_other_room_arrangement ->> 'arrivalDate' ~ '^\d{4}-\d{2}-\d{2}$'
      AND temporary_other_room_arrangement ->> 'departureDate' ~ '^\d{4}-\d{2}-\d{2}$'
      AND (temporary_other_room_arrangement ->> 'arrivalDate')::date
        < (temporary_other_room_arrangement ->> 'departureDate')::date
    )
  );

CREATE OR REPLACE FUNCTION qintopia_validate_coverage_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_contract_id text;
  lot_unit_kind text;
  lot_status text;
  lot_expires_on date;
  contract_property_id text;
  contract_member_id text;
  contract_status text;
  contract_valid_from date;
  contract_valid_until date;
  order_property_id text;
  order_member_id text;
  order_contract_id text;
  inventory_property_id text;
  inventory_kind text;
  inventory_room_type_code text;
  held_revision_order_id text;
  held_revision_arrival_date date;
  held_revision_departure_date date;
  membership_order_id text;
  membership_status text;
  membership_room_type_code text;
  membership_inventory_kind text;
  membership_unit_kind text;
  temporary_other_room_evidence boolean;
BEGIN
  SELECT lot.contract_id, lot.unit_kind, lot.status, lot.expires_on,
         contract.property_id, contract.member_id, contract.status, contract.valid_from, contract.valid_until
    INTO lot_contract_id, lot_unit_kind, lot_status, lot_expires_on,
         contract_property_id, contract_member_id, contract_status, contract_valid_from, contract_valid_until
    FROM entitlement_lots AS lot
    JOIN member_contracts AS contract ON contract.id = lot.contract_id
    WHERE lot.id = NEW.lot_id;
  SELECT property_id, member_id, member_contract_id
    INTO order_property_id, order_member_id, order_contract_id
    FROM orders WHERE id = NEW.order_id;
  SELECT property_id, kind, room_type_code
    INTO inventory_property_id, inventory_kind, inventory_room_type_code
    FROM inventory_units WHERE id = NEW.inventory_unit_id;
  SELECT order_id, arrival_date, departure_date
    INTO held_revision_order_id, held_revision_arrival_date, held_revision_departure_date
    FROM pricing_revisions WHERE id = NEW.held_by_revision_id;
  SELECT id, status, allowed_room_type_code, allowed_inventory_kind, entitlement_unit_kind
    INTO membership_order_id, membership_status, membership_room_type_code,
         membership_inventory_kind, membership_unit_kind
    FROM membership_orders
    WHERE entitlement_lot_id = NEW.lot_id
      AND contract_id = NEW.contract_id;

  IF lot_contract_id IS NULL OR order_property_id IS NULL OR inventory_property_id IS NULL OR held_revision_order_id IS NULL THEN
    RAISE EXCEPTION 'coverage requires existing lot, order, inventory, and pricing revision'
      USING ERRCODE = '23503', CONSTRAINT = 'coverage_items_owners_required';
  END IF;
  IF NEW.contract_id IS DISTINCT FROM lot_contract_id
    OR order_property_id IS DISTINCT FROM contract_property_id
    OR inventory_property_id IS DISTINCT FROM contract_property_id THEN
    RAISE EXCEPTION 'coverage lot, contract, order, and inventory must share ownership'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_owner_match';
  END IF;
  IF NEW.unit_kind IS DISTINCT FROM lot_unit_kind
    OR NEW.unit_kind IS DISTINCT FROM (CASE inventory_kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END) THEN
    RAISE EXCEPTION 'coverage entitlement kind must match its lot and inventory unit'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_unit_kind_match';
  END IF;
  IF held_revision_order_id IS DISTINCT FROM NEW.order_id
    OR NEW.service_date < held_revision_arrival_date
    OR NEW.service_date >= held_revision_departure_date THEN
    RAISE EXCEPTION 'coverage must belong to the holding pricing revision and its stay dates'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_revision_match';
  END IF;
  IF contract_status IS DISTINCT FROM 'ACTIVE'
    OR lot_status IS DISTINCT FROM 'ACTIVE'
    OR (NEW.service_date < contract_valid_from AND NOT (
      NEW.status = 'CONSUMED'
      AND EXISTS (
        SELECT 1
        FROM pricing_revisions AS revision
        JOIN amendments AS conversion
          ON conversion.id = revision.amendment_id
          AND conversion.order_id = revision.order_id
        JOIN command_executions AS execution ON execution.id = conversion.command_id
        JOIN orders AS booking ON booking.id = revision.order_id
        JOIN stays AS stay ON stay.order_id = booking.id
        JOIN membership_orders AS membership_order
          ON membership_order.entitlement_lot_id = NEW.lot_id
          AND membership_order.contract_id = NEW.contract_id
        WHERE revision.id = NEW.held_by_revision_id
          AND revision.order_id = NEW.order_id
          AND booking.current_revision_id = revision.id
          AND booking.member_id = membership_order.member_id
          AND booking.member_contract_id = NEW.contract_id
          AND booking.status = 'CHECKED_IN'
          AND stay.status = 'IN_HOUSE'
          AND conversion.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND execution.state = 'EXECUTING'
          AND execution.property_id = booking.property_id
          AND membership_order.created_by_command_id = execution.id
          AND membership_order.activated_by_command_id = execution.id
          AND membership_order.status = 'ACTIVE'
          AND membership_order.property_id = booking.property_id
      )
    ))
    OR NEW.service_date > contract_valid_until
    OR NEW.service_date > lot_expires_on THEN
    RAISE EXCEPTION 'coverage requires active entitlement valid for the service date'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_entitlement_valid';
  END IF;
  IF order_member_id IS NOT NULL AND contract_member_id IS DISTINCT FROM order_member_id THEN
    RAISE EXCEPTION 'coverage contract must belong to the order member'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_order_member_match';
  END IF;
  IF order_member_id IS NULL AND order_contract_id IS DISTINCT FROM NEW.contract_id THEN
    RAISE EXCEPTION 'legacy coverage contract must match the order contract'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_legacy_order_contract_match';
  END IF;
  IF order_member_id IS NOT NULL AND membership_order_id IS NOT NULL AND (
    membership_status IS DISTINCT FROM 'ACTIVE'
    OR membership_room_type_code IS DISTINCT FROM inventory_room_type_code
    OR membership_inventory_kind IS DISTINCT FROM inventory_kind
    OR membership_unit_kind IS DISTINCT FROM NEW.unit_kind
  ) THEN
    SELECT EXISTS (
      SELECT 1
      FROM amendments AS created
      JOIN command_executions AS execution ON execution.id = created.command_id
      JOIN orders AS booking ON booking.id = created.order_id
      JOIN pricing_revisions AS revision
        ON revision.id = NEW.held_by_revision_id
        AND revision.order_id = created.order_id
        AND revision.amendment_id = created.id
      WHERE created.order_id = NEW.order_id
        AND created.sequence = 1
        AND created.amendment_type = 'CREATE_ORDER'
        AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
        AND NULLIF(btrim(created.reason_note), '') IS NOT NULL
        AND char_length(created.reason_note) <= 200
        AND created.command_id IS NOT NULL
        AND execution.command_type = 'CREATE_ORDER'
        AND execution.property_id = booking.property_id
        AND execution.state IN ('EXECUTING', 'APPLIED')
        AND booking.current_revision_id = revision.id
        AND booking.property_id = order_property_id
        AND booking.member_id = order_member_id
        AND booking.member_contract_id = NEW.contract_id
        AND membership_status = 'ACTIVE'
        AND membership_room_type_code IS DISTINCT FROM inventory_room_type_code
        AND membership_inventory_kind = 'ROOM'
        AND membership_unit_kind = 'ROOM_NIGHT'
        AND inventory_kind = 'ROOM'
        AND NEW.unit_kind = 'ROOM_NIGHT'
        AND created.payload -> 'temporaryOtherRoomArrangement' = jsonb_build_object(
          'kind', 'TEMPORARY_OTHER_ROOM',
          'membershipOrderId', membership_order_id,
          'memberContractId', NEW.contract_id,
          'entitlementLotId', NEW.lot_id,
          'originalRoomTypeCode', membership_room_type_code,
          'originalInventoryKind', 'ROOM',
          'entitlementUnitKind', 'ROOM_NIGHT',
          'actualInventoryUnitId', NEW.inventory_unit_id,
          'actualRoomTypeCode', inventory_room_type_code,
          'actualInventoryKind', 'ROOM',
          'arrivalDate', held_revision_arrival_date::text,
          'departureDate', held_revision_departure_date::text
        )
    ) INTO temporary_other_room_evidence;

    IF NOT temporary_other_room_evidence THEN
      RAISE EXCEPTION 'coverage inventory must match the active membership product'
        USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_membership_product_match';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_temporary_other_room_create_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking orders%ROWTYPE;
  stay stays%ROWTYPE;
  segment stay_segments%ROWTYPE;
  revision pricing_revisions%ROWTYPE;
  target_quote quotes%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  target_execution command_executions%ROWTYPE;
  target_receipt command_receipts%ROWTYPE;
  target_audit audit_entries%ROWTYPE;
  arrangement jsonb;
  expected_coverage_set jsonb;
  expected_resource_refs jsonb;
  expected_fact_refs jsonb;
  occupant_refs jsonb;
  coverage_refs jsonb;
  expected_nights integer;
  amendment_count integer;
  stay_count integer;
  segment_count integer;
  revision_count integer;
  coverage_count integer;
  claim_count integer;
  ledger_count integer;
  complete_mismatched_source_count integer;
  selected_source_count integer;
  exact_source_count integer;
  allowed_audit_count integer;
  preview_count integer;
  preview_evidence_count integer;
  quote_evidence_count integer;
  post_hold_balance bigint;
  current_xid xid := (pg_current_xact_id()::text)::xid;
  database_owner_name text;
BEGIN
  IF NEW.amendment_type IS DISTINCT FROM 'CREATE_ORDER'
    OR (
      NEW.reason_code IS DISTINCT FROM 'TEMPORARY_OTHER_ROOM'
      AND NOT (NEW.payload ? 'temporaryOtherRoomArrangement')
    ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO booking
    FROM orders
    WHERE id = NEW.order_id;
  SELECT count(*)::integer INTO amendment_count
    FROM amendments
    WHERE order_id = NEW.order_id;
  SELECT count(*)::integer INTO stay_count
    FROM stays
    WHERE order_id = NEW.order_id;
  SELECT * INTO stay FROM stays WHERE order_id = NEW.order_id LIMIT 1;
  SELECT count(*)::integer INTO revision_count
    FROM pricing_revisions
    WHERE order_id = NEW.order_id
      AND amendment_id = NEW.id
      AND revision_no = 1;
  SELECT * INTO revision
    FROM pricing_revisions
    WHERE order_id = NEW.order_id
      AND amendment_id = NEW.id
      AND revision_no = 1
    LIMIT 1;
  SELECT count(*)::integer INTO segment_count
    FROM stay_segments
    WHERE stay_id = stay.id;
  SELECT * INTO segment
    FROM stay_segments
    WHERE stay_id = stay.id
    ORDER BY sequence
    LIMIT 1;
  arrangement := NEW.payload -> 'temporaryOtherRoomArrangement';

  IF booking.id IS NULL
    OR amendment_count IS DISTINCT FROM 1
    OR stay_count IS DISTINCT FROM 1
    OR revision_count IS DISTINCT FROM 1
    OR (SELECT count(*) FROM pricing_revisions WHERE order_id = NEW.order_id) IS DISTINCT FROM 1::bigint
    OR booking.current_revision_id IS DISTINCT FROM revision.id
    OR booking.version IS DISTINCT FROM 1
    OR NEW.sequence IS DISTINCT FROM 1
    OR NEW.prior_version IS DISTINCT FROM 0
    OR NEW.new_version IS DISTINCT FROM 1
    OR NEW.reason_code IS DISTINCT FROM 'TEMPORARY_OTHER_ROOM'
    OR NULLIF(btrim(NEW.reason_note), '') IS NULL
    OR NEW.reason_note IS DISTINCT FROM btrim(NEW.reason_note)
    OR char_length(NEW.reason_note) > 200
    OR jsonb_typeof(arrangement) IS DISTINCT FROM 'object'
    OR arrangement ->> 'kind' IS DISTINCT FROM 'TEMPORARY_OTHER_ROOM'
    OR (SELECT count(*) FROM jsonb_object_keys(arrangement)) IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'temporary other-room CREATE_ORDER requires complete typed amendment evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_create_order_amendment';
  END IF;

  IF booking.status IS DISTINCT FROM 'RESERVED'
    OR stay.status IS DISTINCT FROM 'PLANNED'
    OR segment.sequence IS DISTINCT FROM 1
    OR segment.segment_type IS DISTINCT FROM 'INITIAL'
    OR segment.supersedes_segment_id IS NOT NULL
    OR segment.amendment_id IS DISTINCT FROM NEW.id
    OR segment.inventory_unit_id IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
    OR segment.arrival_date IS DISTINCT FROM booking.arrival_date
    OR segment.departure_date IS DISTINCT FROM booking.departure_date
    OR booking.member_id IS NULL
    OR booking.member_contract_id IS NULL
    OR booking.booking_channel_code IS NOT NULL
    OR booking.channel_order_reference IS NOT NULL
    OR booking.free_stay_reason IS NOT NULL
    OR booking.free_stay_category_code IS NOT NULL
    OR booking.arrival_date::text IS DISTINCT FROM arrangement ->> 'arrivalDate'
    OR booking.departure_date::text IS DISTINCT FROM arrangement ->> 'departureDate'
    OR booking.member_contract_id IS DISTINCT FROM arrangement ->> 'memberContractId' THEN
    RAISE EXCEPTION 'temporary other-room order identity is inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_order_identity';
  END IF;

  -- temporary_other_room_exact_initial_segment
  IF segment_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'temporary other-room create order requires exactly one INITIAL segment'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_exact_initial_segment';
  END IF;

  SELECT count(*)::integer INTO expected_nights
  FROM generate_series(booking.arrival_date, booking.departure_date - 1, '1 day'::interval) AS service_date;

  SELECT jsonb_agg(jsonb_build_object(
      'serviceDate', service_date::date,
      'inventoryUnitId', arrangement ->> 'actualInventoryUnitId',
      'entitlementLotId', arrangement ->> 'entitlementLotId',
      'unitKind', 'ROOM_NIGHT'
    ) ORDER BY service_date)
    INTO expected_coverage_set
  FROM generate_series(
    booking.arrival_date,
    booking.departure_date - 1,
    '1 day'::interval
  ) AS expected(service_date);

  IF expected_nights <= 0
    OR revision.cash_lines IS DISTINCT FROM '[]'::jsonb
    OR revision.policy_base_amount_minor IS DISTINCT FROM 0
    OR revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR revision.manual_adjustment_minor IS DISTINCT FROM 0
    OR revision.current_contract_amount_minor IS DISTINCT FROM 0
    OR jsonb_typeof(revision.coverage_set) IS DISTINCT FROM 'array'
    OR revision.coverage_set IS DISTINCT FROM expected_coverage_set THEN
    RAISE EXCEPTION 'temporary other-room pricing revision must be fully covered and zero cash'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_zero_pricing';
  END IF;

  IF NEW.payload ->> 'inventoryUnitId' IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
    OR NEW.payload ->> 'arrivalDate' IS DISTINCT FROM arrangement ->> 'arrivalDate'
    OR NEW.payload ->> 'departureDate' IS DISTINCT FROM arrangement ->> 'departureDate'
    OR NEW.payload -> 'pricingDecision' IS NULL THEN
    RAISE EXCEPTION 'temporary other-room pricing coverage set is incomplete or tampered'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_pricing_coverage';
  END IF;

  WITH source_state AS (
    SELECT membership_order.id AS membership_order_id,
      membership_order.contract_id,
      membership_order.entitlement_lot_id,
      membership_order.status AS membership_status,
      membership_order.allowed_room_type_code,
      membership_order.allowed_inventory_kind,
      membership_order.entitlement_unit_kind,
      membership_order.valid_from AS membership_valid_from,
      membership_order.valid_until AS membership_valid_until,
      contract.status AS contract_status,
      contract.valid_from,
      contract.valid_until,
      contract.membership_order_id AS contract_membership_order_id,
      lot.unit_kind AS lot_unit_kind,
      lot.status AS lot_status,
      lot.expires_on,
      property.timezone,
      lot.total_units::bigint
        + COALESCE(sum(ledger.quantity_delta::bigint), 0)
        - COALESCE(sum(ledger.quantity_delta::bigint)
          FILTER (WHERE ledger.command_id = NEW.command_id), 0) AS pre_command_balance,
      count(*) FILTER (WHERE ledger.entry_type = 'EXPIRE') AS expire_count
    FROM membership_orders AS membership_order
    JOIN member_contracts AS contract ON contract.id = membership_order.contract_id
    JOIN entitlement_lots AS lot ON lot.id = membership_order.entitlement_lot_id
    JOIN properties AS property ON property.id = membership_order.property_id
    LEFT JOIN entitlement_ledger AS ledger ON ledger.lot_id = lot.id
    WHERE membership_order.property_id = booking.property_id
      AND membership_order.member_id = booking.member_id
      AND contract.property_id = booking.property_id
      AND contract.member_id = booking.member_id
    GROUP BY membership_order.id, membership_order.contract_id,
      membership_order.entitlement_lot_id, membership_order.status,
      membership_order.allowed_room_type_code, membership_order.allowed_inventory_kind,
      membership_order.entitlement_unit_kind, membership_order.valid_from,
      membership_order.valid_until, contract.status, contract.valid_from,
      contract.valid_until, contract.membership_order_id, lot.unit_kind,
      lot.status, lot.expires_on, lot.total_units, property.timezone
  ), eligible_source AS (
    SELECT source_state.*,
      source_state.membership_status = 'ACTIVE'
        AND source_state.contract_status = 'ACTIVE'
        AND source_state.lot_status = 'ACTIVE'
        AND source_state.allowed_inventory_kind = 'ROOM'
        AND source_state.entitlement_unit_kind = 'ROOM_NIGHT'
        AND source_state.lot_unit_kind = 'ROOM_NIGHT'
        AND source_state.contract_membership_order_id = source_state.membership_order_id
        AND source_state.membership_valid_from IS NOT DISTINCT FROM source_state.valid_from
        AND source_state.membership_valid_until IS NOT DISTINCT FROM source_state.valid_until
        AND source_state.expires_on >=
          (transaction_timestamp() AT TIME ZONE source_state.timezone)::date
        AND source_state.expire_count = 0 AS active_whole_room_source
    FROM source_state
  )
  SELECT
    count(*) FILTER (WHERE active_whole_room_source
      AND valid_from <= booking.arrival_date
      AND valid_until >= booking.departure_date - 1
      AND expires_on >= booking.departure_date - 1
      AND pre_command_balance BETWEEN expected_nights AND 2147483647
      AND allowed_room_type_code IS DISTINCT FROM arrangement ->> 'actualRoomTypeCode')::integer,
    count(*) FILTER (WHERE active_whole_room_source
      AND valid_from <= booking.arrival_date
      AND valid_until >= booking.departure_date - 1
      AND expires_on >= booking.departure_date - 1
      AND pre_command_balance BETWEEN expected_nights AND 2147483647
      AND allowed_room_type_code IS DISTINCT FROM arrangement ->> 'actualRoomTypeCode'
      AND membership_order_id = arrangement ->> 'membershipOrderId'
      AND contract_id = arrangement ->> 'memberContractId'
      AND entitlement_lot_id = arrangement ->> 'entitlementLotId'
      AND allowed_room_type_code = arrangement ->> 'originalRoomTypeCode')::integer,
    count(*) FILTER (WHERE active_whole_room_source
      AND allowed_room_type_code = arrangement ->> 'actualRoomTypeCode'
      AND EXISTS (
        SELECT 1
        FROM generate_series(
          booking.arrival_date,
          booking.departure_date - 1,
          '1 day'::interval
        ) AS candidate(service_date)
        WHERE candidate.service_date::date BETWEEN valid_from AND valid_until
          AND candidate.service_date::date <= expires_on
      ))::integer
    INTO complete_mismatched_source_count, selected_source_count, exact_source_count
  FROM eligible_source;

  -- temporary_other_room_exact_source_priority
  IF exact_source_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'temporary other-room arrangement cannot bypass an exact whole-room entitlement source'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_exact_source_priority';
  END IF;

  IF complete_mismatched_source_count IS DISTINCT FROM 1
    OR selected_source_count IS DISTINCT FROM 1
    OR NOT EXISTS (
      SELECT 1
      FROM inventory_units AS actual_unit
      WHERE actual_unit.property_id = booking.property_id
        AND actual_unit.id = arrangement ->> 'actualInventoryUnitId'
        AND actual_unit.kind = 'ROOM'
        AND actual_unit.parent_room_id IS NULL
        AND actual_unit.room_type_code = arrangement ->> 'actualRoomTypeCode'
        AND arrangement ->> 'originalRoomTypeCode' IS DISTINCT FROM actual_unit.room_type_code
        AND arrangement ->> 'originalInventoryKind' = 'ROOM'
        AND arrangement ->> 'entitlementUnitKind' = 'ROOM_NIGHT'
        AND arrangement ->> 'actualInventoryKind' = 'ROOM'
    ) THEN
    RAISE EXCEPTION 'temporary other-room membership and inventory evidence is inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_membership_inventory';
  END IF;

  SELECT lot.total_units::bigint + COALESCE(sum(ledger.quantity_delta::bigint), 0)
    INTO post_hold_balance
  FROM entitlement_lots AS lot
  LEFT JOIN entitlement_ledger AS ledger ON ledger.lot_id = lot.id
  WHERE lot.id = arrangement ->> 'entitlementLotId'
  GROUP BY lot.id, lot.total_units;

  -- temporary_other_room_post_hold_balance
  IF post_hold_balance IS NULL
    OR post_hold_balance < 0
    OR post_hold_balance > 2147483647
    OR EXISTS (
      SELECT 1 FROM entitlement_ledger
      WHERE lot_id = arrangement ->> 'entitlementLotId'
        AND entry_type = 'EXPIRE'
    ) THEN
    RAISE EXCEPTION 'temporary other-room selected Lot balance is outside its authoritative bounds'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_post_hold_balance';
  END IF;

  SELECT count(*)::integer INTO coverage_count
  FROM coverage_items AS coverage
  WHERE coverage.order_id = NEW.order_id;
  IF coverage_count IS DISTINCT FROM expected_nights
    OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      WHERE coverage.order_id = NEW.order_id
        AND (
          coverage.contract_id IS DISTINCT FROM arrangement ->> 'memberContractId'
          OR coverage.lot_id IS DISTINCT FROM arrangement ->> 'entitlementLotId'
          OR coverage.inventory_unit_id IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
          OR coverage.unit_kind IS DISTINCT FROM 'ROOM_NIGHT'
          OR coverage.status IS DISTINCT FROM 'HELD'
          OR coverage.held_by_revision_id IS DISTINCT FROM revision.id
          OR coverage.service_date < booking.arrival_date
          OR coverage.service_date >= booking.departure_date
          OR coverage.xmin IS DISTINCT FROM current_xid
        )
    )
    OR EXISTS (
      SELECT 1
      FROM generate_series(
        booking.arrival_date,
        booking.departure_date - 1,
        '1 day'::interval
      ) AS expected_coverage_date(service_date)
      WHERE NOT EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = NEW.order_id
          AND coverage.service_date = expected_coverage_date.service_date::date
      )
    ) THEN
    RAISE EXCEPTION 'temporary other-room coverage facts must exactly match the original Lot and actual room'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_coverage_facts';
  END IF;

  SELECT count(*)::integer INTO claim_count
  FROM inventory_claims AS claim
  WHERE claim.source_id = segment.id;
  IF claim_count IS DISTINCT FROM expected_nights
    OR EXISTS (
      SELECT 1
      FROM inventory_claims AS claim
      WHERE claim.source_id = segment.id
        AND (
          claim.source_type IS DISTINCT FROM 'ORDER_SEGMENT'
          OR NOT claim.active
          OR claim.released_at IS NOT NULL
          OR claim.property_id IS DISTINCT FROM booking.property_id
          OR claim.room_id IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
          OR claim.inventory_unit_id IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
          OR claim.service_date < booking.arrival_date
          OR claim.service_date >= booking.departure_date
          OR claim.xmin IS DISTINCT FROM current_xid
        )
    )
    OR EXISTS (
      SELECT 1
      FROM generate_series(
        booking.arrival_date,
        booking.departure_date - 1,
        '1 day'::interval
      ) AS expected_claim_date(service_date)
      WHERE (
        SELECT count(*)
        FROM inventory_claims AS claim
        WHERE claim.source_id = segment.id
          AND claim.service_date = expected_claim_date.service_date::date
      ) IS DISTINCT FROM 1::bigint
    )
    OR EXISTS (
      SELECT 1
      FROM generate_series(
        booking.arrival_date,
        booking.departure_date - 1,
        '1 day'::interval
      ) AS expected_room_day(service_date)
      LEFT JOIN inventory_room_days AS room_day
        ON room_day.room_id = arrangement ->> 'actualInventoryUnitId'
        AND room_day.service_date = expected_room_day.service_date::date
      LEFT JOIN inventory_claims AS claim
        ON claim.id = room_day.whole_claim_id
        AND claim.source_type = 'ORDER_SEGMENT'
        AND claim.source_id = segment.id
      WHERE claim.id IS NULL
        OR room_day.xmin IS DISTINCT FROM current_xid
    ) THEN
    RAISE EXCEPTION 'temporary other-room claims must occupy only the actual target room'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_actual_claims';
  END IF;

  -- temporary_other_room_exact_claim_set
  IF EXISTS (
      SELECT 1 FROM orders
      WHERE xmin = current_xid AND id IS DISTINCT FROM booking.id
    )
    OR EXISTS (
      SELECT 1 FROM stays
      WHERE xmin = current_xid AND id IS DISTINCT FROM stay.id
    )
    OR EXISTS (
      SELECT 1 FROM amendments
      WHERE xmin = current_xid AND id IS DISTINCT FROM NEW.id
    )
    OR EXISTS (
      SELECT 1 FROM stay_segments
      WHERE xmin = current_xid AND id IS DISTINCT FROM segment.id
    )
    OR EXISTS (
      SELECT 1 FROM pricing_revisions
      WHERE xmin = current_xid AND id IS DISTINCT FROM revision.id
    )
    OR EXISTS (
      SELECT 1 FROM order_occupants
      WHERE xmin = current_xid AND order_id IS DISTINCT FROM booking.id
    )
    OR EXISTS (
      SELECT 1 FROM coverage_items
      WHERE xmin = current_xid AND order_id IS DISTINCT FROM booking.id
    )
    OR EXISTS (
      SELECT 1 FROM inventory_claims
      WHERE xmin = current_xid
        AND (source_type IS DISTINCT FROM 'ORDER_SEGMENT' OR source_id IS DISTINCT FROM segment.id)
    )
    OR EXISTS (
      SELECT 1 FROM collection_facts
      WHERE xmin = current_xid
    ) THEN
    RAISE EXCEPTION 'temporary other-room create transaction contains unrelated business facts'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_exact_claim_set';
  END IF;

  SELECT count(*)::integer INTO ledger_count
  FROM entitlement_ledger AS ledger
  JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
  WHERE ledger.order_id = NEW.order_id
    AND ledger.entry_type = 'HOLD'
    AND ledger.quantity_delta = -1
    AND ledger.lot_id = arrangement ->> 'entitlementLotId'
    AND ledger.service_date = coverage.service_date
    AND ledger.command_id = NEW.command_id
    AND ledger.reason = 'ORDER_COVERAGE_HOLD';
  IF ledger_count IS DISTINCT FROM expected_nights
    OR (SELECT count(*) FROM entitlement_ledger WHERE order_id = NEW.order_id) IS DISTINCT FROM expected_nights
    OR (SELECT count(*) FROM entitlement_ledger WHERE command_id = NEW.command_id) IS DISTINCT FROM expected_nights
    OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      LEFT JOIN entitlement_ledger AS ledger
        ON ledger.coverage_id = coverage.id
        AND ledger.entry_type = 'HOLD'
      WHERE coverage.order_id = NEW.order_id
      GROUP BY coverage.id, coverage.service_date
      HAVING count(ledger.fact_id) IS DISTINCT FROM 1::bigint
        OR bool_or(ledger.lot_id IS DISTINCT FROM coverage.lot_id)
        OR bool_or(ledger.order_id IS DISTINCT FROM coverage.order_id)
        OR bool_or(ledger.service_date IS DISTINCT FROM coverage.service_date)
        OR bool_or(ledger.quantity_delta IS DISTINCT FROM -1)
        OR bool_or(ledger.command_id IS DISTINCT FROM NEW.command_id)
        OR bool_or(ledger.reason IS DISTINCT FROM 'ORDER_COVERAGE_HOLD')
        OR bool_or(ledger.xmin IS DISTINCT FROM current_xid)
    )
    OR EXISTS (
      SELECT 1 FROM entitlement_ledger AS ledger
      WHERE ledger.xmin = current_xid
        AND (
          ledger.order_id IS DISTINCT FROM NEW.order_id
          OR ledger.command_id IS DISTINCT FROM NEW.command_id
          OR ledger.entry_type IS DISTINCT FROM 'HOLD'
        )
    ) THEN
    RAISE EXCEPTION 'temporary other-room entitlement ledger must hold one original room night per service date'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_entitlement_ledger';
  END IF;

  IF EXISTS (SELECT 1 FROM collection_facts WHERE order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'temporary other-room create order must not create collection or refund facts'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_no_funds';
  END IF;

  SELECT * INTO target_execution
  FROM command_executions
  WHERE id = NEW.command_id;
  SELECT * INTO target_receipt
  FROM command_receipts
  WHERE command_id = NEW.command_id;
  SELECT count(*)::integer INTO allowed_audit_count
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT * INTO target_audit
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED'
  LIMIT 1;
  SELECT count(*)::integer INTO preview_count
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT * INTO target_preview
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId'
  LIMIT 1;
  SELECT * INTO target_quote
  FROM quotes
  WHERE id = NEW.payload ->> 'quoteId'
  LIMIT 1;
  SELECT pg_get_userbyid(database_row.datdba) INTO database_owner_name
  FROM pg_database AS database_row
  WHERE database_row.datname = current_database();

  SELECT COALESCE(jsonb_agg(occupant.id ORDER BY occupant.ordinal), '[]'::jsonb)
    INTO occupant_refs
  FROM order_occupants AS occupant
  WHERE occupant.order_id = NEW.order_id;
  SELECT COALESCE(jsonb_agg(coverage.id ORDER BY coverage.service_date), '[]'::jsonb)
    INTO coverage_refs
  FROM coverage_items AS coverage
  WHERE coverage.order_id = NEW.order_id;
  SELECT COALESCE(jsonb_agg(ledger.fact_id ORDER BY coverage.service_date), '[]'::jsonb)
    INTO expected_fact_refs
  FROM coverage_items AS coverage
  JOIN entitlement_ledger AS ledger
    ON ledger.coverage_id = coverage.id
    AND ledger.entry_type = 'HOLD'
  WHERE coverage.order_id = NEW.order_id;
  expected_resource_refs := jsonb_build_array(
      booking.id, stay.id, segment.id, revision.id
    ) || occupant_refs || coverage_refs;

  -- temporary_other_room_quote_evidence
  IF target_quote.id IS NULL
    OR target_quote.property_id IS DISTINCT FROM booking.property_id
    OR target_quote.member_id IS DISTINCT FROM booking.member_id
    OR target_quote.member_contract_id IS DISTINCT FROM booking.member_contract_id
    OR target_quote.inventory_unit_id IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
    OR target_quote.arrival_date IS DISTINCT FROM booking.arrival_date
    OR target_quote.departure_date IS DISTINCT FROM booking.departure_date
    OR target_quote.policy_version_id IS DISTINCT FROM revision.policy_version_id
    OR target_quote.currency IS DISTINCT FROM revision.currency
    OR target_quote.temporary_other_room_arrangement IS DISTINCT FROM arrangement
    OR target_quote.coverage_set IS DISTINCT FROM expected_coverage_set
    OR target_quote.cash_lines IS DISTINCT FROM '[]'::jsonb
    OR target_quote.cash_remainder_minor IS DISTINCT FROM 0
    OR target_quote.current_contract_amount_minor IS DISTINCT FROM 0
    OR (target_quote.requester_subject_id IS NULL AND current_user IS DISTINCT FROM database_owner_name)
    OR (target_quote.requester_subject_id IS NOT NULL
      AND target_quote.requester_subject_id IS DISTINCT FROM target_execution.subject_id) THEN
    RAISE EXCEPTION 'temporary other-room create order requires an authoritative typed Quote'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_quote_evidence';
  END IF;

  quote_evidence_count := 0;
  IF target_quote.requester_subject_id IS NOT NULL THEN
    SELECT count(*)::integer INTO quote_evidence_count
    FROM command_executions AS quote_execution
    JOIN command_receipts AS quote_receipt
      ON quote_receipt.command_id = quote_execution.id
    JOIN audit_entries AS quote_audit
      ON quote_audit.command_id = quote_execution.id
    JOIN subjects AS quote_subject
      ON quote_subject.id = quote_execution.subject_id
      AND quote_subject.status = 'ACTIVE'
    JOIN subject_property_grants AS quote_property_grant
      ON quote_property_grant.subject_id = quote_execution.subject_id
      AND quote_property_grant.property_id = quote_execution.property_id
      AND quote_property_grant.access_level = 'WRITE'
    JOIN quotes AS quote_row ON quote_row.id = target_quote.id
    WHERE quote_execution.command_type = 'CREATE_QUOTE'
      AND quote_execution.property_id = target_quote.property_id
      AND quote_execution.subject_id = target_quote.requester_subject_id
      AND quote_execution.state = 'APPLIED'
      AND quote_receipt.execution_status = 'EXECUTED'
      AND quote_receipt.business_committed
      AND quote_receipt.result #>> '{quote,quoteId}' = target_quote.id
      AND quote_receipt.result #> '{quote,temporaryOtherRoomArrangement}' = arrangement
      AND quote_receipt.resource_refs = jsonb_build_array(target_quote.id)
      AND quote_receipt.fact_refs = '[]'::jsonb
      AND quote_audit.subject_id = quote_execution.subject_id
      AND quote_audit.credential_id = quote_execution.credential_id
      AND quote_audit.action = 'CREATE_QUOTE'
      AND quote_audit.decision = 'ALLOWED'
      AND quote_audit.correlation_id = quote_execution.correlation_id
      AND quote_audit.reason IS NULL
      AND quote_audit.target_refs = jsonb_build_array(target_quote.id)
      AND quote_audit.metadata = jsonb_build_object('quoteInputHash', target_quote.input_hash)
      AND quote_row.xmin = quote_execution.xmin
      AND quote_execution.xmin = quote_receipt.xmin
      AND quote_execution.xmin = quote_audit.xmin
      AND quote_row.created_at = quote_execution.created_at
      AND (
        EXISTS (
          SELECT 1 FROM web_sessions AS session_row
          WHERE session_row.id = quote_execution.credential_id
            AND session_row.subject_id = quote_execution.subject_id
            AND session_row.expires_at > quote_execution.created_at
            AND (session_row.revoked_at IS NULL OR session_row.revoked_at >= quote_execution.created_at)
        )
        OR EXISTS (
          SELECT 1 FROM api_tokens AS token
          WHERE token.id = quote_execution.credential_id
            AND token.subject_id = quote_execution.subject_id
            AND token.property_scope = quote_execution.property_id
            AND token.access_ceiling = 'WRITE'
            AND token.expires_at > quote_execution.created_at
            AND (token.revoked_at IS NULL OR token.revoked_at >= quote_execution.created_at)
        )
      );
    IF quote_evidence_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'temporary other-room Quote requires one typed CREATE_QUOTE evidence graph'
        USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_quote_evidence';
    END IF;
  END IF;

  -- temporary_other_room_preview_evidence
  SELECT count(*)::integer INTO preview_evidence_count
  FROM command_executions AS preview_execution
  JOIN command_receipts AS preview_receipt
    ON preview_receipt.command_id = preview_execution.id
  JOIN audit_entries AS preview_audit
    ON preview_audit.command_id = preview_execution.id
  JOIN subjects AS preview_subject
    ON preview_subject.id = preview_execution.subject_id
    AND preview_subject.status = 'ACTIVE'
  JOIN subject_property_grants AS preview_property_grant
    ON preview_property_grant.subject_id = preview_execution.subject_id
    AND preview_property_grant.property_id = preview_execution.property_id
    AND preview_property_grant.access_level = 'WRITE'
  JOIN subject_command_grants AS preview_command_grant
    ON preview_command_grant.subject_id = preview_execution.subject_id
    AND preview_command_grant.property_id = preview_execution.property_id
    AND preview_command_grant.command_type = 'CREATE_ORDER'
  WHERE preview_execution.command_type = 'PREVIEW:CREATE_ORDER'
    AND preview_execution.property_id = target_preview.property_id
    AND preview_execution.subject_id = target_preview.subject_id
    AND preview_execution.state = 'APPLIED'
    AND preview_receipt.execution_status = 'EXECUTED'
    AND preview_receipt.business_committed
    AND preview_receipt.result #>> '{preview,previewId}' = target_preview.id
    AND preview_receipt.result #>> '{preview,commandType}' = 'CREATE_ORDER'
    AND preview_receipt.result #>> '{preview,effectHash}' = target_preview.effect_hash
    AND preview_receipt.result #> '{preview,effect}' = target_preview.effect
    AND preview_receipt.resource_refs = jsonb_build_array(target_preview.id)
    AND preview_receipt.fact_refs = '[]'::jsonb
    AND preview_audit.subject_id = preview_execution.subject_id
    AND preview_audit.credential_id = preview_execution.credential_id
    AND preview_audit.action = 'PREVIEW:CREATE_ORDER'
    AND preview_audit.decision = 'ALLOWED'
    AND preview_audit.correlation_id = preview_execution.correlation_id
    AND preview_audit.reason IS NULL
    AND preview_audit.target_refs = jsonb_build_array(target_preview.id)
    AND preview_audit.metadata = jsonb_build_object('effectHash', target_preview.effect_hash)
    AND preview_execution.xmin = preview_receipt.xmin
    AND preview_execution.xmin = preview_audit.xmin
    AND preview_execution.created_at = target_preview.created_at
    AND (
      EXISTS (
        SELECT 1 FROM web_sessions AS session_row
        WHERE session_row.id = preview_execution.credential_id
          AND session_row.subject_id = preview_execution.subject_id
          AND session_row.expires_at > preview_execution.created_at
          AND (session_row.revoked_at IS NULL OR session_row.revoked_at >= preview_execution.created_at)
      )
      OR EXISTS (
        SELECT 1 FROM api_tokens AS token
        WHERE token.id = preview_execution.credential_id
          AND token.subject_id = preview_execution.subject_id
          AND token.property_scope = preview_execution.property_id
          AND token.access_ceiling = 'WRITE'
          AND token.expires_at > preview_execution.created_at
          AND (token.revoked_at IS NULL OR token.revoked_at >= preview_execution.created_at)
      )
    );

  IF preview_count IS DISTINCT FROM 1
    OR preview_evidence_count IS DISTINCT FROM 1
    OR target_preview.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_preview.property_id IS DISTINCT FROM booking.property_id
    OR target_preview.command_type IS DISTINCT FROM 'CREATE_ORDER'
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.normalized_input ->> 'propertyId' IS DISTINCT FROM booking.property_id
    OR target_preview.normalized_input ->> 'quoteId' IS DISTINCT FROM target_quote.id
    OR target_preview.normalized_input ->> 'temporaryOtherRoomReason' IS DISTINCT FROM NEW.reason_note
    OR target_preview.effect ->> 'quoteId' IS DISTINCT FROM target_quote.id
    OR target_preview.effect ->> 'memberId' IS DISTINCT FROM booking.member_id
    OR target_preview.effect ->> 'memberContractId' IS DISTINCT FROM booking.member_contract_id
    OR target_preview.effect ->> 'arrivalDate' IS DISTINCT FROM booking.arrival_date::text
    OR target_preview.effect ->> 'departureDate' IS DISTINCT FROM booking.departure_date::text
    OR target_preview.effect -> 'temporaryOtherRoomArrangement' IS DISTINCT FROM arrangement
    OR target_preview.effect ->> 'temporaryOtherRoomReason' IS DISTINCT FROM NEW.reason_note
    OR target_preview.effect #>> '{inventoryUnit,id}' IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
    OR target_preview.effect #>> '{inventoryUnit,kind}' IS DISTINCT FROM 'ROOM'
    OR target_preview.effect #>> '{inventoryUnit,roomTypeCode}' IS DISTINCT FROM arrangement ->> 'actualRoomTypeCode'
    OR target_preview.effect #> '{pricing,coverageSet}' IS DISTINCT FROM expected_coverage_set
    OR target_preview.effect #> '{pricing,cashLines}' IS DISTINCT FROM '[]'::jsonb
    OR target_preview.effect #>> '{pricing,cashRemainder,minorUnits}' IS DISTINCT FROM '0'
    OR target_preview.effect #>> '{pricing,currentContractAmount,minorUnits}' IS DISTINCT FROM '0'
    OR target_preview.effect #>> '{pricingDecision,pricingBasis}' IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR target_preview.effect #>> '{pricingDecision,policyBaseAmount,minorUnits}' IS DISTINCT FROM '0'
    OR target_preview.effect #>> '{pricingDecision,targetCurrentContractAmount,minorUnits}' IS DISTINCT FROM '0'
    OR target_preview.effect #>> '{pricingDecision,manualAdjustmentMinor}' IS DISTINCT FROM '0'
    OR target_preview.basis_versions ->> 'quoteInputHash' IS DISTINCT FROM target_quote.input_hash
    OR NEW.payload ->> 'quoteId' IS DISTINCT FROM target_quote.id
    OR NEW.payload -> 'temporaryOtherRoomArrangement' IS DISTINCT FROM target_preview.effect -> 'temporaryOtherRoomArrangement'
    OR NEW.payload -> 'pricingDecision' IS DISTINCT FROM target_preview.effect -> 'pricingDecision' THEN
    RAISE EXCEPTION 'temporary other-room create order requires one immutable used Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_preview_evidence';
  END IF;

  IF NOT qintopia_has_typed_runtime_command_evidence(
      NEW.command_id,
      'CREATE_ORDER',
      booking.property_id
    )
    OR allowed_audit_count IS DISTINCT FROM 1
    OR target_execution.subject_id IS DISTINCT FROM target_audit.subject_id
    OR target_execution.credential_id IS DISTINCT FROM target_audit.credential_id
    OR target_execution.correlation_id IS DISTINCT FROM target_audit.correlation_id
    OR target_audit.action IS DISTINCT FROM 'CREATE_ORDER'
    OR target_audit.reason IS DISTINCT FROM jsonb_build_object(
      'code', 'TEMPORARY_OTHER_ROOM',
      'note', NEW.reason_note
    )
    OR target_audit.target_refs IS DISTINCT FROM expected_resource_refs
    OR target_audit.metadata IS DISTINCT FROM jsonb_build_object(
      'previewId', target_preview.id,
      'effectHash', target_preview.effect_hash
    )
    OR target_receipt.execution_status IS DISTINCT FROM 'EXECUTED'
    OR NOT target_receipt.business_committed
    OR target_receipt.result ->> 'orderId' IS DISTINCT FROM booking.id
    OR target_receipt.result ->> 'stayId' IS DISTINCT FROM stay.id
    OR target_receipt.result ->> 'segmentId' IS DISTINCT FROM segment.id
    OR target_receipt.result ->> 'pricingRevisionId' IS DISTINCT FROM revision.id
    OR target_receipt.result ->> 'temporaryOtherRoomCreateAmendmentId' IS DISTINCT FROM NEW.id
    OR target_receipt.result -> 'temporaryOtherRoomArrangement' IS DISTINCT FROM arrangement
    OR target_receipt.result ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_receipt.resource_refs IS DISTINCT FROM expected_resource_refs
    OR target_receipt.fact_refs IS DISTINCT FROM expected_fact_refs THEN
    RAISE EXCEPTION 'temporary other-room create order requires command, receipt, and audit evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_command_evidence';
  END IF;

  -- temporary_other_room_current_transaction
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = booking.id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM stays WHERE id = stay.id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM stay_segments WHERE id = segment.id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM amendments WHERE id = NEW.id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM pricing_revisions WHERE id = revision.id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM command_previews WHERE id = target_preview.id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM command_executions WHERE id = NEW.command_id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM command_receipts WHERE command_id = NEW.command_id AND xmin = current_xid)
    OR NOT EXISTS (SELECT 1 FROM audit_entries WHERE id = target_audit.id AND xmin = current_xid)
    OR EXISTS (
      SELECT 1 FROM order_occupants
      WHERE order_id = NEW.order_id
        AND (created_by_command_id IS DISTINCT FROM NEW.command_id OR xmin IS DISTINCT FROM current_xid)
    )
    OR (SELECT count(*) FROM order_occupants WHERE order_id = NEW.order_id)
      IS DISTINCT FROM jsonb_array_length(target_preview.effect -> 'occupants')::bigint
    OR NOT EXISTS (
      SELECT 1 FROM member_contracts
      WHERE id = arrangement ->> 'memberContractId'
        AND xmin = current_xid
    )
    OR NOT EXISTS (
      SELECT 1 FROM entitlement_lots
      WHERE id = arrangement ->> 'entitlementLotId'
        AND xmin = current_xid
    ) THEN
    RAISE EXCEPTION 'temporary other-room create graph must be written by the current transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_current_transaction';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_temporary_other_room_lifecycle_amendment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  booking orders%ROWTYPE;
  stay_status text;
  create_amendment_id text;
  arrangement jsonb;
  new_arrival_date date;
  new_departure_date date;
  expected_preserved_dates jsonb;
  expected_released_dates jsonb;
  expected_stay_timeline jsonb;
  expected_coverage_set jsonb;
BEGIN
  SELECT * INTO booking
    FROM orders
    WHERE id = NEW.order_id;
  SELECT status INTO stay_status
    FROM stays
    WHERE order_id = NEW.order_id;
  SELECT created.id, created.payload -> 'temporaryOtherRoomArrangement'
    INTO create_amendment_id, arrangement
    FROM amendments AS created
    WHERE created.order_id = NEW.order_id
      AND created.sequence = 1
      AND created.amendment_type = 'CREATE_ORDER'
      AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
      AND created.payload ? 'temporaryOtherRoomArrangement';

  IF create_amendment_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.amendment_type = 'RESCHEDULE_STAY' THEN
    IF NEW.payload #>> '{after,arrivalDate}' !~ '^\d{4}-\d{2}-\d{2}$'
      OR NEW.payload #>> '{after,departureDate}' !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'temporary other-room reschedule requires local dates'
        USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_reschedule_subset';
    END IF;
    new_arrival_date := (NEW.payload #>> '{after,arrivalDate}')::date;
    new_departure_date := (NEW.payload #>> '{after,departureDate}')::date;

    SELECT COALESCE(jsonb_agg(to_jsonb(service_date::date::text) ORDER BY service_date), '[]'::jsonb)
      INTO expected_preserved_dates
      FROM generate_series(new_arrival_date, new_departure_date - 1, '1 day'::interval) AS service_date;
    SELECT COALESCE(jsonb_agg(to_jsonb(service_date::date::text) ORDER BY service_date), '[]'::jsonb)
      INTO expected_released_dates
      FROM generate_series(booking.arrival_date, booking.departure_date - 1, '1 day'::interval) AS service_date
      WHERE service_date::date < new_arrival_date OR service_date::date >= new_departure_date;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'serviceDate', service_date::date::text,
        'inventoryUnitId', arrangement ->> 'actualInventoryUnitId'
      ) ORDER BY service_date), '[]'::jsonb)
      INTO expected_stay_timeline
      FROM generate_series(new_arrival_date, new_departure_date - 1, '1 day'::interval) AS service_date;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'serviceDate', service_date::date::text,
        'inventoryUnitId', arrangement ->> 'actualInventoryUnitId',
        'unitKind', 'ROOM_NIGHT',
        'entitlementLotId', arrangement ->> 'entitlementLotId'
      ) ORDER BY service_date), '[]'::jsonb)
      INTO expected_coverage_set
      FROM generate_series(new_arrival_date, new_departure_date - 1, '1 day'::interval) AS service_date;

    IF booking.id IS NULL
      OR booking.status IS DISTINCT FROM 'RESERVED'
      OR stay_status IS DISTINCT FROM 'PLANNED'
      OR new_arrival_date >= new_departure_date
      OR new_arrival_date < booking.arrival_date
      OR new_departure_date > booking.departure_date
      OR (new_arrival_date = booking.arrival_date AND new_departure_date = booking.departure_date)
      OR NEW.payload ->> 'operation' IS DISTINCT FROM 'RESCHEDULE_STAY'
      OR NEW.payload ->> 'inventoryUnitId' IS DISTINCT FROM arrangement ->> 'actualInventoryUnitId'
      OR NEW.payload -> 'temporaryOtherRoomArrangement' IS DISTINCT FROM arrangement
      OR NEW.payload ->> 'temporaryOtherRoomCreateAmendmentId' IS DISTINCT FROM create_amendment_id
      OR NEW.payload #> '{after,stayTimeline}' IS DISTINCT FROM expected_stay_timeline
      OR NEW.payload #> '{after,pricing,coverageSet}' IS DISTINCT FROM expected_coverage_set
      OR NEW.payload #> '{after,pricing,cashLines}' IS DISTINCT FROM '[]'::jsonb
      OR NEW.payload #>> '{after,pricing,cashRemainder,minorUnits}' IS DISTINCT FROM '0'
      OR NEW.payload #>> '{after,pricing,currentContractAmount,minorUnits}' IS DISTINCT FROM '0'
      OR NEW.payload #>> '{pricingDecision,manualAdjustmentMinor}' IS DISTINCT FROM '0'
      OR NEW.payload #> '{inventoryChange,preservedDates}' IS DISTINCT FROM expected_preserved_dates
      OR NEW.payload #> '{inventoryChange,releasedDates}' IS DISTINCT FROM expected_released_dates
      OR NEW.payload #> '{inventoryChange,addedDates}' IS DISTINCT FROM '[]'::jsonb
      OR NEW.payload #> '{entitlementChange,preservedCoverageDates}' IS DISTINCT FROM expected_preserved_dates
      OR NEW.payload #> '{entitlementChange,releasedCoverageDates}' IS DISTINCT FROM expected_released_dates
      OR NEW.payload #> '{entitlementChange,addedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
      OR NEW.payload #> '{entitlementChange,consumedCoverageDates}' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'temporary other-room reschedule must be a strict non-empty subset with unchanged room and entitlement source'
        USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_reschedule_subset';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.amendment_type IN (
      'CORRECT_HISTORICAL_STAY_ARRANGEMENT',
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'EXTEND_STAY',
      'MOVE_UNIT',
      'REPRICE_ORDER',
      'REFRESH_MEMBER_COVERAGE'
    ) THEN
    RAISE EXCEPTION 'temporary other-room order lifecycle change is not supported'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_lifecycle_closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_protect_temporary_other_room_member_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_referenced boolean;
  lifecycle_evidence boolean;
  current_xid xid := (pg_current_xact_id()::text)::xid;
  source_member_id text;
  locked_source_member_id text;
  version_lock_key bigint;
  version_lock_held boolean;
  extension_consume_evidence boolean;
BEGIN
  IF TG_TABLE_NAME = 'member_contracts' THEN
    SELECT EXISTS (
      SELECT 1
      FROM amendments AS created
      WHERE created.sequence = 1
        AND created.amendment_type = 'CREATE_ORDER'
        AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
        AND created.payload #>> '{temporaryOtherRoomArrangement,memberContractId}' = OLD.id
    ) INTO source_referenced;
    IF source_referenced AND (
      TG_OP = 'DELETE'
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.member_id IS DISTINCT FROM OLD.member_id
      OR NEW.member_name IS DISTINCT FROM OLD.member_name
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
      OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
      OR NEW.membership_order_id IS DISTINCT FROM OLD.membership_order_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.version IS DISTINCT FROM OLD.version + 1
    ) THEN
      RAISE EXCEPTION 'temporary other-room membership source is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
    END IF;
    IF source_referenced AND TG_OP = 'UPDATE' THEN
      WITH eligible_evidence AS (
        SELECT ledger.entry_type, execution.command_type
        FROM entitlement_ledger AS ledger
        JOIN coverage_items AS coverage
          ON coverage.id = ledger.coverage_id
          AND coverage.order_id = ledger.order_id
          AND coverage.lot_id = ledger.lot_id
          AND coverage.service_date = ledger.service_date
        JOIN command_executions AS execution
          ON execution.id = ledger.command_id
        JOIN amendments AS action
          ON action.order_id = ledger.order_id
          AND action.command_id = ledger.command_id
          AND (
            action.amendment_type = execution.command_type
            OR (execution.command_type = 'COMPLETE_STAY' AND action.amendment_type IN ('CHECK_IN', 'CHECK_OUT'))
          )
        WHERE coverage.contract_id = OLD.id
          AND ledger.xmin = current_xid
          AND execution.state = 'EXECUTING'
          AND (
            (ledger.entry_type = 'HOLD' AND execution.command_type IN ('CREATE_ORDER', 'EXTEND_STAY'))
            OR (ledger.entry_type = 'RELEASE' AND execution.command_type IN (
              'CANCEL_ORDER', 'MARK_NO_SHOW', 'RESCHEDULE_STAY', 'SHORTEN_STAY'
            ))
            OR (ledger.entry_type = 'CONSUME' AND execution.command_type IN (
              'CHECK_IN', 'COMPLETE_STAY', 'EXTEND_STAY'
            ))
            OR (ledger.entry_type = 'RESTORE' AND execution.command_type IN ('REVOKE_CHECK_IN', 'SHORTEN_STAY'))
          )
      )
      SELECT EXISTS (SELECT 1 FROM eligible_evidence),
             EXISTS (
               SELECT 1
               FROM eligible_evidence
               WHERE entry_type = 'CONSUME' AND command_type = 'EXTEND_STAY'
             )
      INTO lifecycle_evidence, extension_consume_evidence;
      IF NOT lifecycle_evidence THEN
        RAISE EXCEPTION 'temporary other-room membership source version requires lodging lifecycle evidence'
          USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
      END IF;
      version_lock_key := hashtextextended(
        'qintopia:temporary-other-room-source-version:member_contracts:' || OLD.id
          || CASE WHEN extension_consume_evidence THEN ':EXTEND_STAY:CONSUME' ELSE '' END,
        0::bigint
      );
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint = ((version_lock_key >> 32) & 4294967295::bigint)
          AND objid::bigint = (version_lock_key & 4294967295::bigint)
          AND objsubid = 1
          AND granted
      ) INTO version_lock_held;
      IF version_lock_held THEN
        RAISE EXCEPTION 'temporary other-room membership source version may advance once per lifecycle phase'
          USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
      END IF;
      PERFORM pg_advisory_xact_lock(version_lock_key);
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'entitlement_lots' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT member_id INTO source_member_id
      FROM member_contracts
      WHERE id = NEW.contract_id;
      IF source_member_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'qintopia:member-entitlements:' || source_member_id,
          0::bigint
        ));
        PERFORM 1
        FROM members
        WHERE id = source_member_id
        FOR UPDATE;
        SELECT member_id INTO locked_source_member_id
        FROM member_contracts
        WHERE id = NEW.contract_id
        FOR UPDATE;
        IF locked_source_member_id IS DISTINCT FROM source_member_id THEN
          RAISE EXCEPTION 'temporary other-room entitlement source owner changed while locking'
            USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
        END IF;
      END IF;
      SELECT EXISTS (
        SELECT 1
        FROM amendments AS created
        WHERE created.sequence = 1
          AND created.amendment_type = 'CREATE_ORDER'
          AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
          AND created.payload #>> '{temporaryOtherRoomArrangement,memberContractId}' = NEW.contract_id
      ) INTO source_referenced;
      IF source_referenced THEN
        RAISE EXCEPTION 'temporary other-room membership source cannot receive another entitlement Lot'
          USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
      END IF;
      RETURN NEW;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM amendments AS created
      WHERE created.sequence = 1
        AND created.amendment_type = 'CREATE_ORDER'
        AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
        AND created.payload #>> '{temporaryOtherRoomArrangement,entitlementLotId}' = OLD.id
    ) INTO source_referenced;
    IF source_referenced AND (
      TG_OP = 'DELETE'
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
      OR NEW.unit_kind IS DISTINCT FROM OLD.unit_kind
      OR NEW.total_units IS DISTINCT FROM OLD.total_units
      OR NEW.expires_on IS DISTINCT FROM OLD.expires_on
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.version IS DISTINCT FROM OLD.version + 1
    ) THEN
      RAISE EXCEPTION 'temporary other-room entitlement source is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
    END IF;
    IF source_referenced AND TG_OP = 'UPDATE' THEN
      WITH eligible_evidence AS (
        SELECT ledger.entry_type, execution.command_type
        FROM entitlement_ledger AS ledger
        JOIN coverage_items AS coverage
          ON coverage.id = ledger.coverage_id
          AND coverage.order_id = ledger.order_id
          AND coverage.lot_id = ledger.lot_id
          AND coverage.service_date = ledger.service_date
        JOIN command_executions AS execution
          ON execution.id = ledger.command_id
        JOIN amendments AS action
          ON action.order_id = ledger.order_id
          AND action.command_id = ledger.command_id
          AND (
            action.amendment_type = execution.command_type
            OR (execution.command_type = 'COMPLETE_STAY' AND action.amendment_type IN ('CHECK_IN', 'CHECK_OUT'))
          )
        WHERE ledger.lot_id = OLD.id
          AND ledger.xmin = current_xid
          AND execution.state = 'EXECUTING'
          AND (
            (ledger.entry_type = 'HOLD' AND execution.command_type IN ('CREATE_ORDER', 'EXTEND_STAY'))
            OR (ledger.entry_type = 'RELEASE' AND execution.command_type IN (
              'CANCEL_ORDER', 'MARK_NO_SHOW', 'RESCHEDULE_STAY', 'SHORTEN_STAY'
            ))
            OR (ledger.entry_type = 'CONSUME' AND execution.command_type IN (
              'CHECK_IN', 'COMPLETE_STAY', 'EXTEND_STAY'
            ))
            OR (ledger.entry_type = 'RESTORE' AND execution.command_type IN ('REVOKE_CHECK_IN', 'SHORTEN_STAY'))
          )
      )
      SELECT EXISTS (SELECT 1 FROM eligible_evidence),
             EXISTS (
               SELECT 1
               FROM eligible_evidence
               WHERE entry_type = 'CONSUME' AND command_type = 'EXTEND_STAY'
             )
      INTO lifecycle_evidence, extension_consume_evidence;
      IF NOT lifecycle_evidence THEN
        RAISE EXCEPTION 'temporary other-room entitlement source version requires lodging lifecycle evidence'
          USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
      END IF;
      version_lock_key := hashtextextended(
        'qintopia:temporary-other-room-source-version:entitlement_lots:' || OLD.id
          || CASE WHEN extension_consume_evidence THEN ':EXTEND_STAY:CONSUME' ELSE '' END,
        0::bigint
      );
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint = ((version_lock_key >> 32) & 4294967295::bigint)
          AND objid::bigint = (version_lock_key & 4294967295::bigint)
          AND objsubid = 1
          AND granted
      ) INTO version_lock_held;
      IF version_lock_held THEN
        RAISE EXCEPTION 'temporary other-room entitlement source version may advance once per lifecycle phase'
          USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
      END IF;
      PERFORM pg_advisory_xact_lock(version_lock_key);
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM amendments AS created
    WHERE created.sequence = 1
      AND created.amendment_type = 'CREATE_ORDER'
      AND created.reason_code = 'TEMPORARY_OTHER_ROOM'
      AND created.payload #>> '{temporaryOtherRoomArrangement,entitlementLotId}' = NEW.lot_id
  ) INTO source_referenced;
  IF source_referenced
    AND NEW.entry_type NOT IN ('HOLD', 'RELEASE', 'CONSUME', 'RESTORE') THEN
    RAISE EXCEPTION 'temporary other-room entitlement source only accepts lodging lifecycle facts'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_member_chain_closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_temporary_other_room_funds() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM amendments AS created
    WHERE created.order_id = NEW.order_id
      AND created.sequence = 1
      AND created.amendment_type = 'CREATE_ORDER'
      AND (
        created.reason_code = 'TEMPORARY_OTHER_ROOM'
        OR created.payload ? 'temporaryOtherRoomArrangement'
      )
  ) THEN
    RAISE EXCEPTION 'temporary other-room orders cannot have collection facts'
      USING ERRCODE = '23514', CONSTRAINT = 'temporary_other_room_no_funds';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_validate_coverage_ownership() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_validate_coverage_ownership() FROM qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_validate_temporary_other_room_create_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_validate_temporary_other_room_create_order() FROM qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_reject_temporary_other_room_lifecycle_amendment() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_reject_temporary_other_room_lifecycle_amendment() FROM qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_protect_temporary_other_room_member_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_protect_temporary_other_room_member_chain() FROM qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_reject_temporary_other_room_funds() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_reject_temporary_other_room_funds() FROM qintopia_runtime;

DROP TRIGGER IF EXISTS amendments_validate_temporary_other_room_create ON amendments;
CREATE CONSTRAINT TRIGGER amendments_validate_temporary_other_room_create
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN ((NEW.amendment_type = 'CREATE_ORDER')
  AND (NEW.reason_code = 'TEMPORARY_OTHER_ROOM'
    OR NEW.payload ? 'temporaryOtherRoomArrangement'))
EXECUTE FUNCTION qintopia_validate_temporary_other_room_create_order();

DROP TRIGGER IF EXISTS amendments_reject_temporary_other_room_lifecycle ON amendments;
CREATE TRIGGER amendments_reject_temporary_other_room_lifecycle
BEFORE INSERT ON amendments
FOR EACH ROW
EXECUTE FUNCTION qintopia_reject_temporary_other_room_lifecycle_amendment();

DROP TRIGGER IF EXISTS member_contracts_protect_temporary_other_room_source ON member_contracts;
CREATE TRIGGER member_contracts_protect_temporary_other_room_source
BEFORE UPDATE OR DELETE ON member_contracts
FOR EACH ROW
EXECUTE FUNCTION qintopia_protect_temporary_other_room_member_chain();

DROP TRIGGER IF EXISTS entitlement_lots_protect_temporary_other_room_source ON entitlement_lots;
CREATE TRIGGER entitlement_lots_protect_temporary_other_room_source
BEFORE INSERT OR UPDATE OR DELETE ON entitlement_lots
FOR EACH ROW
EXECUTE FUNCTION qintopia_protect_temporary_other_room_member_chain();

DROP TRIGGER IF EXISTS entitlement_ledger_protect_temporary_other_room_source ON entitlement_ledger;
CREATE TRIGGER entitlement_ledger_protect_temporary_other_room_source
BEFORE INSERT ON entitlement_ledger
FOR EACH ROW
EXECUTE FUNCTION qintopia_protect_temporary_other_room_member_chain();

DROP TRIGGER IF EXISTS collection_facts_reject_temporary_other_room_funds ON collection_facts;
CREATE CONSTRAINT TRIGGER collection_facts_reject_temporary_other_room_funds
AFTER INSERT ON collection_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION qintopia_reject_temporary_other_room_funds();
