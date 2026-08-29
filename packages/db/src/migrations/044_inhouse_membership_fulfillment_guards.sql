LOCK TABLE orders, stays, amendments, pricing_revisions, coverage_items,
  entitlement_ledger, inventory_claims, collection_facts, membership_orders,
  membership_payment_facts, member_contracts, entitlement_lots,
  stay_collection_membership_transfers, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX amendments_one_membership_conversion_per_order_idx
  ON amendments (order_id)
  WHERE amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';

-- Stage 10 originally prohibited every entitlement write. Converted in-house
-- stays may now restore only the future coverage removed by a shortening.
DO $stage10_conversion_shorten$
DECLARE
  function_definition text;
  old_guard text := E'    OR short_amendment.payload #>> ''{entitlementSummary,ledgerWriteCount}'' IS DISTINCT FROM ''0''\n    OR effect_contract_amount IS NULL';
  new_guard text := E'    OR jsonb_typeof(short_amendment.payload #> ''{entitlementSummary,restoredFutureCoverageDates}'') IS DISTINCT FROM ''array''\n    OR jsonb_typeof(short_amendment.payload #> ''{entitlementSummary,ledgerWriteCount}'') IS DISTINCT FROM ''number''\n    OR (short_amendment.payload #>> ''{entitlementSummary,ledgerWriteCount}'')::integer\n      IS DISTINCT FROM jsonb_array_length(short_amendment.payload #> ''{entitlementSummary,restoredFutureCoverageDates}'')\n    OR effect_contract_amount IS NULL';
BEGIN
  SELECT pg_get_functiondef('qintopia_assert_stage10_shorten_combination(text)'::regprocedure)
    INTO STRICT function_definition;
  IF position(old_guard IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 044 could not locate the Stage 10 zero-entitlement-write assertion';
  END IF;
  EXECUTE replace(function_definition, old_guard, new_guard);
END;
$stage10_conversion_shorten$;

-- Every MOVE_UNIT effect now carries an explicit converted-coverage marker.
-- The Stage 14 assertion below binds the marker to the immutable graph.
DO $stage11_conversion_move$
DECLARE
  function_definition text;
  old_shape text := E'    OR (SELECT count(*) FROM jsonb_object_keys(move_amendment.payload -> ''entitlementSummary'')) IS DISTINCT FROM 4\n    OR jsonb_typeof(move_amendment.payload #> ''{entitlementSummary,preservedCoverageDates}'') IS DISTINCT FROM ''array''';
  new_shape text := E'    OR (SELECT count(*) FROM jsonb_object_keys(move_amendment.payload -> ''entitlementSummary'')) IS DISTINCT FROM 5\n    OR jsonb_typeof(move_amendment.payload #> ''{entitlementSummary,convertedMembershipCoveragePreserved}'') IS DISTINCT FROM ''boolean''\n    OR jsonb_typeof(move_amendment.payload #> ''{entitlementSummary,preservedCoverageDates}'') IS DISTINCT FROM ''array''';
BEGIN
  SELECT pg_get_functiondef('qintopia_assert_stage11_move_combination(text)'::regprocedure)
    INTO STRICT function_definition;
  IF position(old_shape IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 044 could not locate the Stage 11 MOVE entitlement-summary shape';
  END IF;
  EXECUTE replace(function_definition, old_shape, new_shape);
END;
$stage11_conversion_move$;

-- A conversion contract starts on the upgrade business date. Coverage for
-- already-served dates is a typed consumption trace, not retroactive validity.
DO $conversion_historical_coverage$
DECLARE
  function_definition text;
  old_validity_guard text := E'  IF contract_status IS DISTINCT FROM ''ACTIVE''\n    OR NEW.service_date < contract_valid_from\n    OR NEW.service_date > contract_valid_until\n    OR NEW.service_date > lot_expires_on THEN';
  new_validity_guard text := $coverage_validity_guard$  IF contract_status IS DISTINCT FROM 'ACTIVE'
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
    OR NEW.service_date > lot_expires_on THEN$coverage_validity_guard$;
BEGIN
  SELECT pg_get_functiondef('qintopia_validate_coverage_ownership()'::regprocedure)
    INTO STRICT function_definition;
  IF position(old_validity_guard IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 044 could not locate the coverage validity assertion';
  END IF;
  EXECUTE replace(function_definition, old_validity_guard, new_validity_guard);
END;
$conversion_historical_coverage$;

CREATE OR REPLACE FUNCTION qintopia_protect_coverage_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'HELD' THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'CONSUMED'
      AND EXISTS (
        SELECT 1
        FROM pricing_revisions AS revision
        JOIN amendments AS conversion
          ON conversion.id = revision.amendment_id
          AND conversion.order_id = revision.order_id
        JOIN command_executions AS execution ON execution.id = conversion.command_id
        JOIN orders AS booking ON booking.id = revision.order_id
        JOIN stays AS stay ON stay.order_id = booking.id
        JOIN entitlement_lots AS lot ON lot.id = NEW.lot_id
        JOIN member_contracts AS contract ON contract.id = NEW.contract_id
        JOIN membership_orders AS membership_order
          ON membership_order.id = contract.membership_order_id
        WHERE revision.id = NEW.held_by_revision_id
          AND revision.order_id = NEW.order_id
          AND booking.current_revision_id = revision.id
          AND booking.member_id = membership_order.member_id
          AND booking.member_contract_id = contract.id
          AND booking.status = 'CHECKED_IN'
          AND stay.status = 'IN_HOUSE'
          AND conversion.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND execution.state = 'EXECUTING'
          AND execution.property_id = booking.property_id
          AND membership_order.created_by_command_id = execution.id
          AND membership_order.activated_by_command_id = execution.id
          AND membership_order.status = 'ACTIVE'
          AND membership_order.contract_id = contract.id
          AND membership_order.entitlement_lot_id = lot.id
          AND membership_order.property_id = booking.property_id
          AND lot.contract_id = contract.id
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'coverage must be created in HELD status or by a typed in-house membership conversion'
      USING ERRCODE = '55000', CONSTRAINT = 'coverage_conversion_consumed_insert';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coverage identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.lot_id IS DISTINCT FROM OLD.lot_id
    OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.unit_kind IS DISTINCT FROM OLD.unit_kind
    OR NEW.held_by_revision_id IS DISTINCT FROM OLD.held_by_revision_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'coverage identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'HELD' AND NEW.status IN ('RELEASED', 'CONSUMED') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'CONSUMED'
    AND NEW.status = 'RELEASED'
    AND EXISTS (
      SELECT 1
      FROM entitlement_ledger AS restore
      JOIN command_executions AS execution ON execution.id = restore.command_id
      JOIN amendments AS shortening
        ON shortening.command_id = execution.id
        AND shortening.order_id = restore.order_id
        AND shortening.amendment_type = 'SHORTEN_STAY'
      WHERE restore.coverage_id = OLD.id
        AND restore.lot_id = OLD.lot_id
        AND restore.order_id = OLD.order_id
        AND restore.service_date = OLD.service_date
        AND restore.entry_type = 'RESTORE'
        AND restore.quantity_delta = 1
        AND restore.reason = 'SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
        AND execution.command_type = 'SHORTEN_STAY'
        AND execution.state = 'EXECUTING'
        AND execution.property_id = (
          SELECT property_id FROM orders WHERE id = OLD.order_id
        )
        AND EXISTS (
          SELECT 1
          FROM amendments AS conversion
          WHERE conversion.order_id = OLD.order_id
            AND conversion.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
        )
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'coverage status transition is not authorized by its typed entitlement lifecycle'
    USING ERRCODE = '55000', CONSTRAINT = 'coverage_status_typed_transition';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_stage10_entitlement_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  order_property_id text;
  shortening_payload jsonb;
  business_date date;
  new_departure_date date;
BEGIN
  IF NEW.command_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type IS DISTINCT FROM 'SHORTEN_STAY' THEN
    RETURN NEW;
  END IF;

  SELECT booking.property_id, amendment.payload
    INTO order_property_id, shortening_payload
    FROM orders AS booking
    JOIN amendments AS amendment
      ON amendment.order_id = booking.id
      AND amendment.command_id = NEW.command_id
      AND amendment.amendment_type = 'SHORTEN_STAY'
    WHERE booking.id = NEW.order_id;
  BEGIN
    business_date := (shortening_payload ->> 'businessDate')::date;
    new_departure_date := (shortening_payload #>> '{after,departureDate}')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'converted SHORTEN_STAY restoration requires typed dates'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_stage10_restore_dates';
  END;

  IF execution_state IS NOT DISTINCT FROM 'EXECUTING'
    AND execution_property_id IS NOT DISTINCT FROM order_property_id
    AND NEW.entry_type IS NOT DISTINCT FROM 'RESTORE'
    AND NEW.quantity_delta IS NOT DISTINCT FROM 1
    AND NEW.coverage_id IS NOT NULL
    AND NEW.reason IS NOT DISTINCT FROM 'SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
    AND NEW.service_date >= business_date
    AND NEW.service_date >= new_departure_date
    AND EXISTS (
      SELECT 1
      FROM amendments AS conversion
      WHERE conversion.order_id = NEW.order_id
        AND conversion.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    )
    AND EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      WHERE coverage.id = NEW.coverage_id
        AND coverage.order_id = NEW.order_id
        AND coverage.service_date = NEW.service_date
        AND coverage.lot_id = NEW.lot_id
        AND coverage.status = 'CONSUMED'
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SHORTEN_STAY may only restore removed future coverage from a converted stay'
    USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_stage10_no_write';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_entitlement_lifecycle_fact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  coverage_lot_id text;
  coverage_order_id text;
  coverage_service_date date;
  coverage_status text;
  execution_type text;
  execution_property_id text;
  order_property_id text;
  hold_count integer;
  consume_count integer;
  conversion_consume_count integer;
BEGIN
  IF NEW.entry_type NOT IN ('HOLD', 'RELEASE', 'CONSUME', 'RESTORE', 'CONVERSION_CONSUME') THEN
    RETURN NEW;
  END IF;
  IF NEW.entry_type = 'CONVERSION_CONSUME' AND NEW.coverage_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT lot_id, order_id, service_date, status
    INTO coverage_lot_id, coverage_order_id, coverage_service_date, coverage_status
    FROM coverage_items
    WHERE id = NEW.coverage_id;
  IF coverage_lot_id IS NULL
    OR NEW.lot_id IS DISTINCT FROM coverage_lot_id
    OR NEW.order_id IS DISTINCT FROM coverage_order_id
    OR NEW.service_date IS DISTINCT FROM coverage_service_date THEN
    RAISE EXCEPTION 'entitlement lifecycle fact must match its coverage identity'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_coverage_match';
  END IF;
  IF (NEW.entry_type = 'HOLD' AND NEW.quantity_delta <> -1)
    OR (NEW.entry_type = 'RELEASE' AND NEW.quantity_delta <> 1)
    OR (NEW.entry_type = 'CONSUME' AND NEW.quantity_delta <> 0)
    OR (NEW.entry_type = 'RESTORE' AND NEW.quantity_delta <> 1)
    OR (NEW.entry_type = 'CONVERSION_CONSUME' AND NEW.quantity_delta <> -1) THEN
    RAISE EXCEPTION 'entitlement lifecycle fact has an invalid quantity delta'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_lifecycle_delta';
  END IF;
  IF (NEW.entry_type = 'HOLD' AND coverage_status IS DISTINCT FROM 'HELD')
    OR (NEW.entry_type = 'RELEASE' AND coverage_status IS DISTINCT FROM 'RELEASED')
    OR (NEW.entry_type IN ('CONSUME', 'RESTORE', 'CONVERSION_CONSUME')
      AND coverage_status IS DISTINCT FROM 'CONSUMED') THEN
    RAISE EXCEPTION 'entitlement lifecycle fact must match the current coverage status'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_lifecycle_status';
  END IF;

  SELECT count(*) FILTER (WHERE entry_type = 'HOLD')::integer,
         count(*) FILTER (WHERE entry_type = 'CONSUME')::integer,
         count(*) FILTER (WHERE entry_type = 'CONVERSION_CONSUME')::integer
    INTO hold_count, consume_count, conversion_consume_count
    FROM entitlement_ledger
    WHERE coverage_id = NEW.coverage_id;
  IF NEW.entry_type IN ('RELEASE', 'CONSUME') AND hold_count <> 1 THEN
    RAISE EXCEPTION 'terminal entitlement lifecycle fact requires its original hold'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_terminal_requires_hold';
  END IF;
  IF NEW.entry_type = 'CONVERSION_CONSUME'
    AND (hold_count <> 0 OR consume_count <> 0 OR conversion_consume_count <> 0) THEN
    RAISE EXCEPTION 'conversion consumption must be the sole original consumption for its coverage'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_conversion_consume_lifecycle';
  END IF;
  IF NEW.entry_type = 'RESTORE' THEN
    IF NOT ((hold_count = 1 AND consume_count = 1 AND conversion_consume_count = 0)
      OR (hold_count = 0 AND consume_count = 0 AND conversion_consume_count = 1)) THEN
      RAISE EXCEPTION 'restored entitlement requires exactly one original consumption lifecycle'
        USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_restore_requires_consume';
    END IF;
    SELECT command_type, property_id
      INTO execution_type, execution_property_id
      FROM command_executions
      WHERE id = NEW.command_id;
    SELECT property_id INTO order_property_id
      FROM orders
      WHERE id = NEW.order_id;
    IF execution_property_id IS DISTINCT FROM order_property_id
      OR execution_type NOT IN ('REVOKE_CHECK_IN', 'SHORTEN_STAY')
      OR (execution_type = 'REVOKE_CHECK_IN'
        AND NEW.reason IS DISTINCT FROM 'REVOKE_CHECK_IN_ENTITLEMENT_RESTORED')
      OR (execution_type = 'SHORTEN_STAY' AND (
        NEW.reason IS DISTINCT FROM 'SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
        OR NOT EXISTS (
          SELECT 1
          FROM amendments
          WHERE order_id = NEW.order_id
            AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
        )
      )) THEN
      RAISE EXCEPTION 'entitlement restoration requires its typed revoke or converted shortening command'
        USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_restore_command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_coverage_lifecycle_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hold_count integer;
  release_count integer;
  consume_count integer;
  restore_count integer;
  conversion_consume_count integer;
  current_status text;
BEGIN
  SELECT status INTO current_status
    FROM coverage_items
    WHERE id = NEW.id;
  SELECT count(*) FILTER (WHERE entry_type = 'HOLD')::integer,
         count(*) FILTER (WHERE entry_type = 'RELEASE')::integer,
         count(*) FILTER (WHERE entry_type = 'CONSUME')::integer,
         count(*) FILTER (WHERE entry_type = 'RESTORE')::integer,
         count(*) FILTER (WHERE entry_type = 'CONVERSION_CONSUME')::integer
    INTO hold_count, release_count, consume_count, restore_count, conversion_consume_count
    FROM entitlement_ledger
    WHERE coverage_id = NEW.id;

  IF NOT (
    (current_status = 'HELD'
      AND hold_count = 1 AND release_count = 0 AND consume_count = 0
      AND restore_count = 0 AND conversion_consume_count = 0)
    OR (current_status = 'CONSUMED' AND (
      (hold_count = 1 AND release_count = 0 AND consume_count = 1
        AND restore_count = 0 AND conversion_consume_count = 0)
      OR (hold_count = 0 AND release_count = 0 AND consume_count = 0
        AND restore_count = 0 AND conversion_consume_count = 1)
    ))
    OR (current_status = 'RELEASED' AND (
      (hold_count = 1 AND release_count = 1 AND consume_count = 0
        AND restore_count = 0 AND conversion_consume_count = 0)
      OR (hold_count = 1 AND release_count = 0 AND consume_count = 1
        AND restore_count = 1 AND conversion_consume_count = 0)
      OR (hold_count = 0 AND release_count = 0 AND consume_count = 0
        AND restore_count = 1 AND conversion_consume_count = 1)
    ))
  ) THEN
    RAISE EXCEPTION 'coverage status and entitlement lifecycle facts must remain conserved'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_lifecycle_conserved';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_preserve_stage11_consumed_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  restore_command_id text;
  restore_execution_type text;
  restore_execution_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'CONSUMED' THEN
      RAISE EXCEPTION 'consumed member coverage is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_consumed_coverage_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'CONSUMED'
    AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
    AND NEW.contract_id IS NOT DISTINCT FROM OLD.contract_id
    AND NEW.lot_id IS NOT DISTINCT FROM OLD.lot_id
    AND NEW.inventory_unit_id IS NOT DISTINCT FROM OLD.inventory_unit_id
    AND NEW.service_date IS NOT DISTINCT FROM OLD.service_date
    AND NEW.unit_kind IS NOT DISTINCT FROM OLD.unit_kind
    AND NEW.held_by_revision_id IS NOT DISTINCT FROM OLD.held_by_revision_id
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.status = 'RELEASED'
    AND EXISTS (
      SELECT 1
      FROM amendments
      WHERE order_id = OLD.order_id
        AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    ) THEN
    SELECT ledger.command_id
      INTO restore_command_id
      FROM entitlement_ledger AS ledger
      WHERE ledger.coverage_id = OLD.id
        AND ledger.entry_type = 'RESTORE'
        AND ledger.reason = 'SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
      ORDER BY ledger.created_at DESC, ledger.fact_id DESC
      LIMIT 1;
    SELECT command_type, state
      INTO restore_execution_type, restore_execution_state
      FROM command_executions
      WHERE id = restore_command_id;
    IF restore_execution_type = 'SHORTEN_STAY'
      AND restore_execution_state = 'EXECUTING'
      AND EXISTS (
        SELECT 1
        FROM amendments
        WHERE command_id = restore_command_id
          AND order_id = OLD.order_id
          AND amendment_type = 'SHORTEN_STAY'
      ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.status = 'CONSUMED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'consumed member coverage is immutable except for a typed future-stay restoration'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_consumed_coverage_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_conversion_consume_entitlement_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_membership_order membership_orders%ROWTYPE;
  target_coverage coverage_items%ROWTYPE;
  coverage_inventory_kind text;
  coverage_room_type_code text;
BEGIN
  IF NEW.entry_type <> 'CONVERSION_CONSUME' THEN
    RETURN NEW;
  END IF;
  SELECT command_type, state
    INTO execution_type, execution_state
    FROM command_executions
    WHERE id = NEW.command_id;
  SELECT * INTO target_order FROM orders WHERE id = NEW.order_id;
  SELECT * INTO target_stay FROM stays WHERE order_id = NEW.order_id;
  SELECT * INTO target_lot FROM entitlement_lots WHERE id = NEW.lot_id;
  SELECT * INTO target_contract FROM member_contracts WHERE id = target_lot.contract_id;
  SELECT * INTO target_membership_order
    FROM membership_orders
    WHERE entitlement_lot_id = NEW.lot_id;
  IF NEW.coverage_id IS NOT NULL THEN
    SELECT * INTO target_coverage FROM coverage_items WHERE id = NEW.coverage_id;
    SELECT kind, room_type_code
      INTO coverage_inventory_kind, coverage_room_type_code
      FROM inventory_units
      WHERE id = target_coverage.inventory_unit_id;
  END IF;

  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    OR execution_state IS DISTINCT FROM 'EXECUTING'
    OR target_order.id IS NULL
    OR target_stay.id IS NULL
    OR target_lot.id IS NULL
    OR target_contract.id IS NULL
    OR target_membership_order.id IS NULL
    OR target_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_membership_order.contract_id IS DISTINCT FROM target_contract.id
    OR target_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_membership_order.member_id IS DISTINCT FROM target_order.member_id
    OR target_order.member_contract_id IS DISTINCT FROM target_contract.id
    OR target_membership_order.activated_by_command_id IS DISTINCT FROM NEW.command_id
    OR NEW.quantity_delta IS DISTINCT FROM -1
    OR NEW.service_date IS NULL
    OR NEW.service_date < target_order.arrival_date
    OR NEW.service_date >= target_order.departure_date
    OR NEW.reason IS DISTINCT FROM 'STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED'
    OR NOT (
      (target_order.status = 'CHECKED_OUT'
        AND target_stay.status = 'COMPLETED'
        AND NEW.coverage_id IS NULL)
      OR (target_order.status = 'CHECKED_IN'
        AND target_stay.status = 'IN_HOUSE'
        AND NEW.coverage_id IS NOT NULL
        AND target_coverage.id IS NOT NULL
        AND target_coverage.order_id = target_order.id
        AND target_coverage.contract_id = target_contract.id
        AND target_coverage.lot_id = target_lot.id
        AND target_coverage.service_date = NEW.service_date
        AND target_coverage.status = 'CONSUMED'
        AND target_coverage.held_by_revision_id = target_order.current_revision_id
        AND target_coverage.unit_kind = target_membership_order.entitlement_unit_kind
        AND coverage_inventory_kind = target_membership_order.allowed_inventory_kind
        AND coverage_room_type_code = target_membership_order.allowed_room_type_code)
    ) THEN
    RAISE EXCEPTION 'conversion consumption entitlement fact has an invalid in-house or completed-stay shape'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_conversion_consume_shape';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_lodging_funds_after_membership_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  order_property_id text;
  prior_conversion_command_id text;
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  SELECT property_id INTO order_property_id FROM orders WHERE id = NEW.order_id;
  SELECT command_id INTO prior_conversion_command_id
    FROM amendments
    WHERE order_id = NEW.order_id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = NEW.command_id;

  IF prior_conversion_command_id IS NULL THEN
    IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
      RETURN NEW;
    END IF;
    IF execution_state = 'EXECUTING'
      AND execution_property_id = order_property_id
      AND NEW.fact_type = 'REVERSAL'
      AND EXISTS (
        SELECT 1
        FROM membership_orders
        WHERE created_by_command_id = NEW.command_id
          AND property_id = order_property_id
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stay conversion may initially append only its typed lodging reversals'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_initial_lodging_fund_shape';
  END IF;

  IF prior_conversion_command_id = NEW.command_id
    AND execution_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    AND execution_state = 'EXECUTING'
    AND execution_property_id = order_property_id
    AND NEW.fact_type = 'REVERSAL' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lodging funds are closed after a stay converts to membership'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_lodging_funds_closed';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  target_membership_order membership_orders%ROWTYPE;
BEGIN
  PERFORM 1 FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  SELECT * INTO target_membership_order
    FROM membership_orders
    WHERE id = NEW.membership_order_id;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = NEW.command_id;

  IF NOT EXISTS (
    SELECT 1
    FROM command_executions AS creation
    WHERE creation.id = target_membership_order.created_by_command_id
      AND creation.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
  ) THEN
    RETURN NEW;
  END IF;
  IF target_membership_order.created_by_command_id = NEW.command_id
    AND execution_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    AND execution_state = 'EXECUTING'
    AND execution_property_id = target_membership_order.property_id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'membership funds are closed for membership orders created from lodging conversion'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_funds_closed';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command_v033(target_command_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  amendment_count integer;
  target_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  target_membership_order membership_orders%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  membership_order_count integer;
  identity_match_count integer;
  transfer_count integer;
  transfer_source_total bigint;
  transfer_reversal_total bigint;
  transfer_membership_total bigint;
  direct_membership_count integer;
  direct_membership_total bigint;
  lodging_fact_count integer;
  lodging_source_count integer;
  lodging_conversion_reversal_count integer;
  actual_lodging_net bigint;
  conversion_ledger_count integer;
  conversion_ledger_delta bigint;
  conversion_coverage_count integer;
  active_claim_count integer;
  expected_nights integer;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO amendment_count
    FROM amendments
    WHERE command_id = target_command_id;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;
  SELECT * INTO target_amendment
    FROM amendments
    WHERE command_id = target_command_id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  IF amendment_count <> 1 OR NOT FOUND THEN
    RAISE EXCEPTION 'stay-to-membership conversion requires exactly one typed amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_amendment';
  END IF;

  SELECT * INTO STRICT target_order FROM orders WHERE id = target_amendment.order_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE id = target_order.current_revision_id;
  SELECT count(*)::integer INTO membership_order_count
    FROM membership_orders
    WHERE created_by_command_id = target_command_id
      AND activated_by_command_id = target_command_id;
  SELECT * INTO target_membership_order
    FROM membership_orders
    WHERE created_by_command_id = target_command_id
      AND activated_by_command_id = target_command_id;
  IF membership_order_count <> 1 OR target_membership_order.id IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership conversion requires one active membership order created by the same command'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_order';
  END IF;
  SELECT * INTO target_contract
    FROM member_contracts
    WHERE id = target_membership_order.contract_id;
  SELECT * INTO target_lot
    FROM entitlement_lots
    WHERE id = target_membership_order.entitlement_lot_id;

  IF execution_property_id IS DISTINCT FROM target_order.property_id
    OR NOT (
      (target_order.status = 'CHECKED_OUT' AND target_stay.status = 'COMPLETED')
      OR (target_order.status = 'CHECKED_IN' AND target_stay.status = 'IN_HOUSE')
    )
    OR target_order.stay_type = 'FREE'
    OR target_order.booking_channel_code IS DISTINCT FROM 'WECOM'
    OR target_order.member_id IS DISTINCT FROM target_membership_order.member_id
    OR target_order.member_contract_id IS DISTINCT FROM target_contract.id
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id
    OR target_order.version IS DISTINCT FROM target_amendment.new_version
    OR target_revision.amendment_id IS DISTINCT FROM target_amendment.id
    OR target_revision.order_id IS DISTINCT FROM target_order.id
    OR target_revision.arrival_date IS DISTINCT FROM target_order.arrival_date
    OR target_revision.departure_date IS DISTINCT FROM target_order.departure_date
    OR target_revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR target_revision.current_contract_amount_minor IS DISTINCT FROM 0
    OR target_revision.manual_adjustment_minor IS DISTINCT FROM 0
    OR target_revision.coverage_set IS DISTINCT FROM '[]'::jsonb
    OR target_revision.cash_lines IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'stay-to-membership conversion must leave one linked in-house or completed lodging order at zero amount'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_order_state';
  END IF;

  IF target_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_membership_order.agreed_price_minor <= 0
    OR target_membership_order.contract_id IS NULL
    OR target_membership_order.entitlement_lot_id IS NULL
    OR target_contract.id IS NULL
    OR target_lot.id IS NULL
    OR target_contract.membership_order_id IS DISTINCT FROM target_membership_order.id
    OR target_contract.member_id IS DISTINCT FROM target_membership_order.member_id
    OR target_contract.property_id IS DISTINCT FROM target_membership_order.property_id
    OR target_lot.contract_id IS DISTINCT FROM target_contract.id
    OR target_lot.unit_kind IS DISTINCT FROM target_membership_order.entitlement_unit_kind
    OR target_lot.total_units IS DISTINCT FROM target_membership_order.entitlement_units THEN
    RAISE EXCEPTION 'stay-to-membership conversion contract, price, and entitlement lot must match the membership order'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_contract_lot';
  END IF;

  SELECT count(*)::integer INTO identity_match_count
    FROM order_occupants AS occupant
    LEFT JOIN LATERAL (
      SELECT corrected_phone
      FROM order_occupant_corrections
      WHERE occupant_id = occupant.id
      ORDER BY sequence DESC
      LIMIT 1
    ) AS latest ON TRUE
    JOIN members AS member_row
      ON member_row.id = target_membership_order.member_id
    WHERE occupant.order_id = target_order.id
      AND occupant.role = 'PRIMARY'
      AND NULLIF(
        regexp_replace(
          CASE WHEN latest.corrected_phone IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM order_occupant_corrections AS marker
              WHERE marker.occupant_id = occupant.id
            )
            THEN occupant.phone
            ELSE latest.corrected_phone
          END,
          '[[:space:]]+', '', 'g'
        ),
        ''
      ) = regexp_replace(member_row.phone, '[[:space:]]+', '', 'g');
  IF identity_match_count <> 1 THEN
    RAISE EXCEPTION 'stay-to-membership conversion member identity must match the latest primary guest phone'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_member_identity';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stay_segments AS segment
    JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
    WHERE segment.stay_id = target_stay.id
      AND (unit.kind IS DISTINCT FROM target_membership_order.allowed_inventory_kind
        OR unit.room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code)
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion membership product must match every lodging segment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_product_match';
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(source.amount_minor), 0)::bigint,
         COALESCE(sum(reversal.amount_minor), 0)::bigint,
         COALESCE(sum(payment.amount_minor), 0)::bigint
    INTO transfer_count, transfer_source_total, transfer_reversal_total, transfer_membership_total
    FROM stay_collection_membership_transfers AS transfer
    JOIN collection_facts AS source
      ON source.fact_id = transfer.source_collection_fact_id
    JOIN collection_facts AS reversal
      ON reversal.fact_id = transfer.source_reversal_fact_id
    JOIN membership_payment_facts AS payment
      ON payment.fact_id = transfer.membership_payment_fact_id
    WHERE transfer.command_id = target_command_id
      AND transfer.order_id = target_order.id
      AND transfer.membership_order_id = target_membership_order.id;
  SELECT count(*)::integer, COALESCE(sum(amount_minor), 0)::bigint
    INTO direct_membership_count, direct_membership_total
    FROM membership_payment_facts
    WHERE membership_order_id = target_membership_order.id
      AND source_type = 'DIRECT_WECOM'
      AND fact_type = 'COLLECTION';
  SELECT count(*)::integer,
         count(*) FILTER (WHERE fact_type = 'COLLECTION')::integer,
         count(*) FILTER (
           WHERE fact_type = 'REVERSAL' AND command_id = target_command_id
         )::integer,
         COALESCE(sum(net_effect_minor), 0)::bigint
    INTO lodging_fact_count, lodging_source_count,
      lodging_conversion_reversal_count, actual_lodging_net
    FROM collection_facts
    WHERE order_id = target_order.id;

  IF EXISTS (
    SELECT 1
    FROM stay_collection_membership_transfers AS transfer
    WHERE transfer.membership_order_id = target_membership_order.id
      AND (transfer.command_id IS DISTINCT FROM target_command_id
        OR transfer.order_id IS DISTINCT FROM target_order.id)
  ) OR EXISTS (
    SELECT 1
    FROM membership_payment_facts AS payment
    WHERE payment.membership_order_id = target_membership_order.id
      AND (payment.command_id IS DISTINCT FROM target_command_id
        OR payment.fact_type IS DISTINCT FROM 'COLLECTION'
        OR payment.amount_minor <= 0
        OR payment.net_effect_minor IS DISTINCT FROM payment.amount_minor
        OR payment.corrects_fact_id IS NOT NULL
        OR payment.reverses_fact_id IS NOT NULL)
  ) OR transfer_source_total IS DISTINCT FROM transfer_reversal_total
    OR transfer_source_total IS DISTINCT FROM transfer_membership_total
    OR transfer_source_total + direct_membership_total
      IS DISTINCT FROM target_membership_order.agreed_price_minor
    OR actual_lodging_net IS DISTINCT FROM 0
    OR direct_membership_count > 1
    OR NOT EXISTS (
      SELECT 1
      FROM membership_payment_facts AS payment
      LEFT JOIN stay_collection_membership_transfers AS transfer
        ON transfer.membership_payment_fact_id = payment.fact_id
      LEFT JOIN collection_facts AS source
        ON source.fact_id = transfer.source_collection_fact_id
      WHERE payment.membership_order_id = target_membership_order.id
        AND payment.fact_type = 'COLLECTION'
        AND payment.amount_minor > 0
        AND (
          (payment.source_type = 'DIRECT_WECOM'
            AND NULLIF(btrim(payment.transaction_reference), '') IS NOT NULL)
          OR (payment.source_type = 'STAY_COLLECTION_TRANSFER'
            AND source.method = 'WECOM'
            AND NULLIF(btrim(source.transaction_reference), '') IS NOT NULL)
        )
    ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion must conserve positive, traceable lodging and membership funds'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_funds_conserved';
  END IF;

  IF transfer_count = 0 THEN
    IF lodging_fact_count <> 0
      OR transfer_source_total <> 0
      OR transfer_reversal_total <> 0
      OR transfer_membership_total <> 0
      OR direct_membership_count <> 1
      OR direct_membership_total IS DISTINCT FROM target_membership_order.agreed_price_minor THEN
      RAISE EXCEPTION 'zero-transfer conversion requires a genuinely empty lodging fund graph and one full direct payment'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_zero_transfer_funds';
    END IF;
  ELSE
    IF transfer_source_total <= 0
      OR lodging_source_count <> transfer_count
      OR lodging_conversion_reversal_count <> transfer_count
      OR lodging_fact_count <> transfer_count * 2
      OR EXISTS (
        SELECT 1
        FROM collection_facts AS fact
        WHERE fact.order_id = target_order.id
          AND NOT (
            (fact.fact_type = 'COLLECTION'
              AND fact.amount_minor > 0
              AND fact.net_effect_minor = fact.amount_minor
              AND fact.method = 'WECOM'
              AND NULLIF(btrim(fact.transaction_reference), '') IS NOT NULL
              AND fact.references_fact_id IS NULL
              AND fact.reverses_fact_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM stay_collection_membership_transfers AS transfer
                WHERE transfer.command_id = target_command_id
                  AND transfer.order_id = target_order.id
                  AND transfer.source_collection_fact_id = fact.fact_id
              ))
            OR (fact.fact_type = 'REVERSAL'
              AND fact.command_id = target_command_id
              AND EXISTS (
                SELECT 1
                FROM stay_collection_membership_transfers AS transfer
                WHERE transfer.command_id = target_command_id
                  AND transfer.order_id = target_order.id
                  AND transfer.source_reversal_fact_id = fact.fact_id
                  AND transfer.source_collection_fact_id = fact.reverses_fact_id
              ))
          )
      ) THEN
      RAISE EXCEPTION 'positive-transfer conversion requires the complete pure WECOM lodging fund graph'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_complete_lodging_funds';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM membership_payment_facts AS direct
    JOIN collection_facts AS source
      ON source.order_id = target_order.id
      AND source.fact_type = 'COLLECTION'
    WHERE direct.membership_order_id = target_membership_order.id
      AND direct.source_type = 'DIRECT_WECOM'
      AND direct.fact_type = 'COLLECTION'
      AND direct.transaction_reference = source.transaction_reference
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion direct payment must use a new transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_direct_reference_new';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM amendments AS conversion
    WHERE conversion.order_id = target_order.id
      AND conversion.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
      AND conversion.command_id IS DISTINCT FROM target_command_id
  ) THEN
    RAISE EXCEPTION 'one lodging order can be converted to membership only once'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_one_per_order';
  END IF;

  expected_nights := target_order.departure_date - target_order.arrival_date;
  SELECT count(*)::integer, COALESCE(sum(quantity_delta), 0)::bigint
    INTO conversion_ledger_count, conversion_ledger_delta
    FROM entitlement_ledger
    WHERE command_id = target_command_id
      AND order_id = target_order.id
      AND lot_id = target_membership_order.entitlement_lot_id
      AND entry_type = 'CONVERSION_CONSUME';
  IF conversion_ledger_count IS DISTINCT FROM expected_nights
    OR conversion_ledger_delta IS DISTINCT FROM -expected_nights
    OR target_membership_order.entitlement_units < expected_nights
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS ledger
      WHERE ledger.command_id = target_command_id
        AND (ledger.entry_type IS DISTINCT FROM 'CONVERSION_CONSUME'
          OR ledger.order_id IS DISTINCT FROM target_order.id
          OR ledger.lot_id IS DISTINCT FROM target_membership_order.entitlement_lot_id
          OR ledger.quantity_delta IS DISTINCT FROM -1
          OR ledger.service_date < target_order.arrival_date
          OR ledger.service_date >= target_order.departure_date)
    ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion must consume exactly the planned stay once'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_entitlement';
  END IF;

  IF target_order.status = 'CHECKED_OUT' THEN
    IF EXISTS (
      SELECT 1
      FROM entitlement_ledger
      WHERE command_id = target_command_id
        AND coverage_id IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM coverage_items
      WHERE order_id = target_order.id
        AND contract_id = target_contract.id
        AND lot_id = target_lot.id
    ) THEN
      RAISE EXCEPTION 'completed-stay conversion consumption must remain coverage-free'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_completed_coverage';
    END IF;
  ELSE
    SELECT count(*)::integer INTO conversion_coverage_count
      FROM coverage_items
      WHERE order_id = target_order.id
        AND contract_id = target_contract.id
        AND lot_id = target_lot.id
        AND held_by_revision_id = target_revision.id
        AND status = 'CONSUMED';
    SELECT count(*)::integer INTO active_claim_count
      FROM inventory_claims AS claim
      WHERE claim.source_type = 'ORDER_SEGMENT'
        AND claim.source_id IN (
          SELECT id FROM stay_segments WHERE stay_id = target_stay.id
        )
        AND claim.active IS TRUE;
    IF conversion_coverage_count <> expected_nights
      OR active_claim_count <> expected_nights
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND (coverage.contract_id IS DISTINCT FROM target_contract.id
            OR coverage.lot_id IS DISTINCT FROM target_lot.id
            OR coverage.held_by_revision_id IS DISTINCT FROM target_revision.id
            OR coverage.status IS DISTINCT FROM 'CONSUMED'
            OR coverage.service_date < target_order.arrival_date
            OR coverage.service_date >= target_order.departure_date)
      )
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS ledger
        LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
        WHERE ledger.command_id = target_command_id
          AND (ledger.coverage_id IS NULL
            OR coverage.id IS NULL
            OR coverage.order_id IS DISTINCT FROM target_order.id
            OR coverage.contract_id IS DISTINCT FROM target_contract.id
            OR coverage.lot_id IS DISTINCT FROM target_lot.id
            OR coverage.service_date IS DISTINCT FROM ledger.service_date
            OR coverage.status IS DISTINCT FROM 'CONSUMED'
            OR NOT EXISTS (
              SELECT 1
              FROM inventory_claims AS claim
              WHERE claim.source_type = 'ORDER_SEGMENT'
                AND claim.source_id IN (
                  SELECT id FROM stay_segments WHERE stay_id = target_stay.id
                )
                AND claim.active IS TRUE
                AND claim.service_date = coverage.service_date
                AND claim.inventory_unit_id = coverage.inventory_unit_id
            ))
      )
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND NOT EXISTS (
            SELECT 1
            FROM entitlement_ledger AS ledger
            WHERE ledger.command_id = target_command_id
              AND ledger.entry_type = 'CONVERSION_CONSUME'
              AND ledger.coverage_id = coverage.id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS lifecycle
        JOIN coverage_items AS coverage ON coverage.id = lifecycle.coverage_id
        WHERE coverage.order_id = target_order.id
          AND lifecycle.entry_type IN ('HOLD', 'RELEASE', 'CONSUME', 'RESTORE')
      ) THEN
      RAISE EXCEPTION 'in-house conversion requires one consumed coverage and one bound conversion consumption per active service date'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_inhouse_coverage';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_assert_converted_stay_fulfillment_command(target_command_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  matching_amendment_count integer;
  target_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  conversion_amendment amendments%ROWTYPE;
  conversion_membership_order membership_orders%ROWTYPE;
  conversion_contract member_contracts%ROWTYPE;
  conversion_lot entitlement_lots%ROWTYPE;
  conversion_count integer;
  after_arrival date;
  after_departure date;
  business_date date;
  payload_ledger_count integer;
  command_ledger_count integer;
  hold_ledger_count integer;
  consume_ledger_count integer;
  restore_ledger_count integer;
  active_coverage_count integer;
  entitlement_balance bigint;
  restored_dates jsonb;
  expected_restored_dates jsonb;
  added_dates jsonb;
  consumed_dates jsonb;
  expected_consumed_dates jsonb;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type NOT IN (
    'SHORTEN_STAY',
    'EXTEND_STAY',
    'MOVE_UNIT',
    'REPRICE_ORDER',
    'REFRESH_MEMBER_COVERAGE',
    'REVOKE_CHECK_IN'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO matching_amendment_count
    FROM amendments
    WHERE command_id = target_command_id
      AND amendment_type = execution_type;
  IF matching_amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED' OR matching_amendment_count <> 1 THEN
    RAISE EXCEPTION 'converted-stay fulfillment facts require one typed amendment and an applied execution'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_fulfillment_execution';
  END IF;
  SELECT * INTO STRICT target_amendment
    FROM amendments
    WHERE command_id = target_command_id
      AND amendment_type = execution_type;
  SELECT * INTO STRICT target_order FROM orders WHERE id = target_amendment.order_id;

  SELECT count(*)::integer INTO conversion_count
    FROM amendments
    WHERE order_id = target_order.id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  IF conversion_count = 0 THEN
    IF execution_type = 'MOVE_UNIT'
      AND target_amendment.payload #>> '{entitlementSummary,convertedMembershipCoveragePreserved}'
        IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'ordinary MOVE_UNIT cannot claim converted coverage preservation'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_move_marker';
    END IF;
    IF execution_type = 'SHORTEN_STAY'
      AND (target_amendment.payload #> '{entitlementSummary,restoredFutureCoverageDates}'
          IS DISTINCT FROM '[]'::jsonb
        OR target_amendment.payload #>> '{entitlementSummary,ledgerWriteCount}'
          IS DISTINCT FROM '0') THEN
      RAISE EXCEPTION 'ordinary SHORTEN_STAY cannot restore converted entitlement coverage'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_shorten_marker';
    END IF;
    RETURN;
  END IF;
  IF conversion_count <> 1 THEN
    RAISE EXCEPTION 'one lodging order can have only one membership conversion'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_one_conversion';
  END IF;
  IF execution_type IN ('REPRICE_ORDER', 'REFRESH_MEMBER_COVERAGE', 'REVOKE_CHECK_IN') THEN
    RAISE EXCEPTION 'converted stays cannot use ordinary repricing, coverage refresh, or check-in revocation'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_ordinary_action_closed';
  END IF;

  SELECT * INTO STRICT conversion_amendment
    FROM amendments
    WHERE order_id = target_order.id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  SELECT * INTO conversion_contract
    FROM member_contracts
    WHERE id = target_order.member_contract_id;
  SELECT * INTO conversion_membership_order
    FROM membership_orders
    WHERE id = conversion_contract.membership_order_id;
  SELECT * INTO conversion_lot
    FROM entitlement_lots
    WHERE id = conversion_membership_order.entitlement_lot_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE id = target_order.current_revision_id;

  IF conversion_contract.id IS NULL
    OR conversion_membership_order.id IS NULL
    OR conversion_lot.id IS NULL
    OR conversion_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR conversion_membership_order.agreed_price_minor <= 0
    OR conversion_membership_order.created_by_command_id IS DISTINCT FROM conversion_amendment.command_id
    OR conversion_membership_order.activated_by_command_id IS DISTINCT FROM conversion_amendment.command_id
    OR conversion_membership_order.contract_id IS DISTINCT FROM conversion_contract.id
    OR conversion_contract.membership_order_id IS DISTINCT FROM conversion_membership_order.id
    OR conversion_contract.member_id IS DISTINCT FROM target_order.member_id
    OR conversion_contract.member_id IS DISTINCT FROM conversion_membership_order.member_id
    OR conversion_contract.property_id IS DISTINCT FROM target_order.property_id
    OR conversion_contract.property_id IS DISTINCT FROM conversion_membership_order.property_id
    OR conversion_lot.contract_id IS DISTINCT FROM conversion_contract.id
    OR conversion_lot.unit_kind IS DISTINCT FROM conversion_membership_order.entitlement_unit_kind
    OR conversion_lot.total_units IS DISTINCT FROM conversion_membership_order.entitlement_units
    OR target_order.member_id IS DISTINCT FROM conversion_membership_order.member_id
    OR execution_property_id IS DISTINCT FROM target_order.property_id
    OR conversion_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_revision.amendment_id IS DISTINCT FROM target_amendment.id
    OR target_revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR target_revision.current_contract_amount_minor IS DISTINCT FROM 0
    OR target_revision.manual_adjustment_minor IS DISTINCT FROM 0
    OR target_revision.cash_lines IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'converted-stay fulfillment must remain bound to its conversion contract, lot, and zero pricing'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_membership_binding';
  END IF;

  BEGIN
    after_arrival := (target_amendment.payload #>> '{after,arrivalDate}')::date;
    after_departure := (target_amendment.payload #>> '{after,departureDate}')::date;
    payload_ledger_count := CASE execution_type
      WHEN 'SHORTEN_STAY' THEN
        (target_amendment.payload #>> '{entitlementSummary,ledgerWriteCount}')::integer
      WHEN 'MOVE_UNIT' THEN
        (target_amendment.payload #>> '{entitlementSummary,ledgerWriteCount}')::integer
      ELSE NULL
    END;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'converted-stay fulfillment requires typed dates and ledger counts'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_typed_payload';
  END;
  IF after_arrival IS NULL OR after_departure <= after_arrival
    OR target_order.arrival_date IS DISTINCT FROM after_arrival
    OR target_order.departure_date IS DISTINCT FROM after_departure THEN
    RAISE EXCEPTION 'converted-stay fulfillment dates must match the current order'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_date_binding';
  END IF;

  SELECT COALESCE(conversion_lot.total_units, 0)::bigint
      + COALESCE(sum(ledger.quantity_delta), 0)::bigint
    INTO entitlement_balance
    FROM entitlement_ledger AS ledger
    WHERE ledger.lot_id = conversion_lot.id;
  IF entitlement_balance < 0 THEN
    RAISE EXCEPTION 'converted-stay fulfillment cannot overdraw membership entitlement'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_entitlement_balance';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE entry_type = 'HOLD')::integer,
         count(*) FILTER (WHERE entry_type = 'CONSUME')::integer,
         count(*) FILTER (WHERE entry_type = 'RESTORE')::integer
    INTO command_ledger_count, hold_ledger_count, consume_ledger_count, restore_ledger_count
    FROM entitlement_ledger
    WHERE command_id = target_command_id;

  IF execution_type = 'EXTEND_STAY' THEN
    added_dates := target_amendment.payload #> '{entitlementChange,addedCoverageDates}';
    consumed_dates := target_amendment.payload #> '{entitlementChange,consumedCoverageDates}';
    IF jsonb_typeof(added_dates) IS DISTINCT FROM 'array'
      OR jsonb_typeof(consumed_dates) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'converted-stay extension requires typed entitlement date arrays'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_extend_entitlement_graph';
    END IF;
    BEGIN
      PERFORM (item.value #>> '{}')::date
        FROM jsonb_array_elements(added_dates) AS item(value);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'converted-stay extension entitlement dates are invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_extend_entitlement_graph';
    END;
    IF consumed_dates IS DISTINCT FROM added_dates
      OR jsonb_array_length(added_dates) = 0
      OR command_ledger_count <> jsonb_array_length(added_dates) * 2
      OR hold_ledger_count <> jsonb_array_length(added_dates)
      OR consume_ledger_count <> jsonb_array_length(added_dates)
      OR restore_ledger_count <> 0
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS ledger
        LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
        WHERE ledger.command_id = target_command_id
          AND (ledger.entry_type NOT IN ('HOLD', 'CONSUME')
            OR ledger.order_id IS DISTINCT FROM target_order.id
            OR ledger.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.id IS NULL
            OR coverage.order_id IS DISTINCT FROM target_order.id
            OR coverage.contract_id IS DISTINCT FROM conversion_contract.id
            OR coverage.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.service_date IS DISTINCT FROM ledger.service_date
            OR coverage.status IS DISTINCT FROM 'CONSUMED'
            OR coverage.held_by_revision_id IS DISTINCT FROM target_revision.id
            OR coverage.unit_kind IS DISTINCT FROM conversion_membership_order.entitlement_unit_kind
            OR NOT (added_dates @> jsonb_build_array(coverage.service_date::text))
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(target_amendment.payload #> '{after,stayTimeline}') AS item(value)
              WHERE item.value ->> 'serviceDate' = coverage.service_date::text
                AND item.value ->> 'inventoryUnitId' = coverage.inventory_unit_id
            )
            OR (ledger.entry_type = 'HOLD' AND (
              ledger.quantity_delta <> -1
              OR ledger.reason <> 'ORDER_COVERAGE_HOLD'))
            OR (ledger.entry_type = 'CONSUME' AND (
              ledger.quantity_delta <> 0
              OR ledger.reason <> 'EXTEND_STAY_ENTITLEMENT_CONSUMED')))
      )
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND coverage.status IN ('HELD', 'CONSUMED')
          AND (coverage.status <> 'CONSUMED'
            OR coverage.contract_id IS DISTINCT FROM conversion_contract.id
            OR coverage.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.service_date < after_arrival
            OR coverage.service_date >= after_departure)
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(added_dates) AS added(value)
        WHERE (SELECT count(*)
          FROM coverage_items AS coverage
          WHERE coverage.order_id = target_order.id
            AND coverage.service_date = (added.value #>> '{}')::date
            AND coverage.status = 'CONSUMED'
            AND coverage.held_by_revision_id = target_revision.id) <> 1
          OR (SELECT count(*)
            FROM entitlement_ledger AS ledger
            JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
            WHERE ledger.command_id = target_command_id
              AND coverage.service_date = (added.value #>> '{}')::date
              AND ledger.entry_type = 'HOLD') <> 1
          OR (SELECT count(*)
            FROM entitlement_ledger AS ledger
            JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
            WHERE ledger.command_id = target_command_id
              AND coverage.service_date = (added.value #>> '{}')::date
              AND ledger.entry_type = 'CONSUME') <> 1
      ) THEN
      RAISE EXCEPTION 'converted-stay extension requires one HOLD and one CONSUME for every added service date'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_extend_entitlement_graph';
    END IF;
  ELSIF execution_type = 'SHORTEN_STAY' THEN
    restored_dates := target_amendment.payload #> '{entitlementSummary,restoredFutureCoverageDates}';
    expected_restored_dates := target_amendment.payload #> '{inventoryChange,releasedDates}';
    IF jsonb_typeof(restored_dates) IS DISTINCT FROM 'array'
      OR jsonb_typeof(expected_restored_dates) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'converted SHORTEN_STAY restoration dates are invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_shorten_typed_dates';
    END IF;
    BEGIN
      business_date := (target_amendment.payload ->> 'businessDate')::date;
      PERFORM (item.value #>> '{}')::date
        FROM jsonb_array_elements(restored_dates) AS item(value);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'converted SHORTEN_STAY restoration dates are invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_shorten_typed_dates';
    END;
    IF restored_dates IS DISTINCT FROM expected_restored_dates
      OR payload_ledger_count <> jsonb_array_length(restored_dates)
      OR command_ledger_count <> jsonb_array_length(restored_dates)
      OR restore_ledger_count <> jsonb_array_length(restored_dates)
      OR hold_ledger_count <> 0
      OR consume_ledger_count <> 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(restored_dates) AS item(value)
        WHERE (item.value #>> '{}')::date < business_date
          OR (item.value #>> '{}')::date < after_departure
      )
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS restore
        LEFT JOIN coverage_items AS coverage ON coverage.id = restore.coverage_id
        WHERE restore.command_id = target_command_id
          AND (restore.entry_type <> 'RESTORE'
            OR restore.quantity_delta <> 1
            OR restore.reason <> 'SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
            OR restore.order_id IS DISTINCT FROM target_order.id
            OR restore.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.id IS NULL
            OR coverage.order_id IS DISTINCT FROM target_order.id
            OR coverage.contract_id IS DISTINCT FROM conversion_contract.id
            OR coverage.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.service_date IS DISTINCT FROM restore.service_date
            OR coverage.status IS DISTINCT FROM 'RELEASED'
            OR NOT (restored_dates @> jsonb_build_array(coverage.service_date::text))
            OR (SELECT count(*)
              FROM entitlement_ledger AS consumed
              WHERE consumed.coverage_id = coverage.id
                AND consumed.entry_type IN ('CONSUME', 'CONVERSION_CONSUME')) <> 1)
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(restored_dates) AS item(value)
        WHERE (SELECT count(*)
          FROM coverage_items AS coverage
          JOIN entitlement_ledger AS restore
            ON restore.coverage_id = coverage.id
            AND restore.command_id = target_command_id
            AND restore.entry_type = 'RESTORE'
          WHERE coverage.order_id = target_order.id
            AND coverage.service_date = (item.value #>> '{}')::date
            AND coverage.status = 'RELEASED') <> 1
      )
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND coverage.status = 'CONSUMED'
          AND (coverage.contract_id IS DISTINCT FROM conversion_contract.id
            OR coverage.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.service_date < after_arrival
            OR coverage.service_date >= after_departure)
      ) THEN
      RAISE EXCEPTION 'converted SHORTEN_STAY must restore and release exactly the removed future entitlement coverage'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_shorten_entitlement_graph';
    END IF;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text)
        ORDER BY coverage.service_date), '[]'::jsonb)
      INTO expected_consumed_dates
      FROM coverage_items AS coverage
      WHERE coverage.order_id = target_order.id
        AND coverage.status = 'CONSUMED';
    IF target_amendment.payload #>> '{entitlementSummary,convertedMembershipCoveragePreserved}'
        IS DISTINCT FROM 'true'
      OR target_amendment.payload #> '{entitlementSummary,preservedCoverageDates}'
        IS DISTINCT FROM '[]'::jsonb
      OR target_amendment.payload #> '{entitlementSummary,migratedHeldCoverageDates}'
        IS DISTINCT FROM '[]'::jsonb
      OR target_amendment.payload #> '{entitlementSummary,consumedCoverageDates}'
        IS DISTINCT FROM expected_consumed_dates
      OR payload_ledger_count <> 0
      OR command_ledger_count <> 0
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND coverage.status IN ('HELD', 'CONSUMED')
          AND (coverage.status <> 'CONSUMED'
            OR coverage.contract_id IS DISTINCT FROM conversion_contract.id
            OR coverage.lot_id IS DISTINCT FROM conversion_lot.id
            OR coverage.service_date < after_arrival
            OR coverage.service_date >= after_departure)
      )
      OR target_amendment.payload #>> '{toInventoryUnit,kind}'
        IS DISTINCT FROM conversion_membership_order.allowed_inventory_kind
      OR target_amendment.payload #>> '{toInventoryUnit,roomTypeCode}'
        IS DISTINCT FROM conversion_membership_order.allowed_room_type_code THEN
      RAISE EXCEPTION 'converted MOVE_UNIT must preserve consumed coverage identity with zero entitlement writes'
        USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_move_entitlement_graph';
    END IF;
  END IF;

  SELECT count(*)::integer INTO active_coverage_count
    FROM coverage_items
    WHERE order_id = target_order.id
      AND status = 'CONSUMED'
      AND service_date >= after_arrival
      AND service_date < after_departure;
  IF active_coverage_count <> after_departure - after_arrival
    OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      WHERE coverage.order_id = target_order.id
        AND coverage.status = 'HELD'
    )
    OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      WHERE coverage.order_id = target_order.id
        AND coverage.status = 'CONSUMED'
        AND (coverage.contract_id IS DISTINCT FROM conversion_contract.id
          OR coverage.lot_id IS DISTINCT FROM conversion_lot.id
          OR coverage.service_date < after_arrival
          OR coverage.service_date >= after_departure)
    ) THEN
    RAISE EXCEPTION 'converted-stay fulfillment must retain one consumed coverage for every current service date'
      USING ERRCODE = '23514', CONSTRAINT = 'converted_stay_current_coverage';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_converted_stay_fulfillment_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_converted_stay_fulfillment_command(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_converted_stay_fulfillment_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_converted_stay_fulfillment_command(NEW.command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER command_executions_validate_converted_stay_fulfillment
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_execution();

CREATE CONSTRAINT TRIGGER amendments_validate_converted_stay_fulfillment
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.command_id IS NOT NULL)
EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_child();

CREATE CONSTRAINT TRIGGER entitlement_ledger_validate_converted_stay_fulfillment
AFTER INSERT ON entitlement_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.command_id IS NOT NULL)
EXECUTE FUNCTION qintopia_validate_converted_stay_fulfillment_child();
