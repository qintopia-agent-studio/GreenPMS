LOCK TABLE command_previews, command_executions, command_receipts, audit_entries, amendments
  IN SHARE ROW EXCLUSIVE MODE;

DO $stage11_upgrade$
DECLARE
  function_definition text;
  forbidden_future_move_guard text := E'  IF future_transition_count <> 0 THEN\n    RAISE EXCEPTION ''SHORTEN_STAY cannot crop an inventory transition effective on or after the business date''\n      USING ERRCODE = ''23514'', CONSTRAINT = ''stage10_shorten_future_move_boundary'';\n  END IF;\n\n';
BEGIN
  SELECT pg_get_functiondef('qintopia_assert_stage10_shorten_combination(text)'::regprocedure)
    INTO STRICT function_definition;
  IF position(forbidden_future_move_guard IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 028 could not locate the Stage 10 future MOVE rejection block';
  END IF;
  EXECUTE replace(function_definition, forbidden_future_move_guard, '');
  IF pg_get_functiondef('qintopia_assert_stage10_shorten_combination(text)'::regprocedure)
      LIKE '%stage10_shorten_future_move_boundary%' THEN
    RAISE EXCEPTION 'migration 028 did not remove the Stage 10 future MOVE rejection block';
  END IF;
END;
$stage11_upgrade$;

CREATE OR REPLACE FUNCTION qintopia_assert_stage11_shorten_before_timeline(target_command_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  short_amendment amendments%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  before_arrival date;
  before_departure date;
  payload_timeline_count integer;
  original_timeline_count integer;
  payload_timeline jsonb;
  original_timeline jsonb;
BEGIN
  IF target_command_id IS NULL THEN
    RETURN;
  END IF;

  SELECT command_type, state INTO execution_type, execution_state
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'SHORTEN_STAY'
    OR execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;

  SELECT * INTO short_amendment
    FROM amendments
    WHERE command_id = target_command_id
      AND amendment_type = 'SHORTEN_STAY';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO STRICT target_stay
    FROM stays
    WHERE order_id = short_amendment.order_id;
  SELECT * INTO STRICT target_segment
    FROM stay_segments
    WHERE amendment_id = short_amendment.id
      AND stay_id = target_stay.id;

  BEGIN
    before_arrival := (short_amendment.payload #>> '{before,arrivalDate}')::date;
    before_departure := (short_amendment.payload #>> '{before,departureDate}')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SHORTEN_STAY requires typed before dates and stay timeline'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_shorten_before_timeline_binding';
  END;

  IF jsonb_typeof(short_amendment.payload #> '{before,stayTimeline}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SHORTEN_STAY requires a typed before stay timeline'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_shorten_before_timeline_binding';
  END IF;

  BEGIN
    SELECT count(*)::integer,
           COALESCE(jsonb_agg(jsonb_build_object(
             'serviceDate', timeline_item.item ->> 'serviceDate',
             'inventoryUnitId', timeline_item.item ->> 'inventoryUnitId'
           ) ORDER BY timeline_item.ordinality), '[]'::jsonb)
      INTO payload_timeline_count, payload_timeline
      FROM jsonb_array_elements(short_amendment.payload #> '{before,stayTimeline}')
        WITH ORDINALITY AS timeline_item(item, ordinality);

    IF payload_timeline_count <> before_departure - before_arrival
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(short_amendment.payload #> '{before,stayTimeline}')
          WITH ORDINALITY AS timeline_item(item, ordinality)
        WHERE jsonb_typeof(timeline_item.item) IS DISTINCT FROM 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(timeline_item.item)) IS DISTINCT FROM 2
          OR NOT timeline_item.item ? 'serviceDate'
          OR NOT timeline_item.item ? 'inventoryUnitId'
          OR btrim(COALESCE(timeline_item.item ->> 'inventoryUnitId', '')) = ''
          OR (timeline_item.item ->> 'serviceDate')::date
            IS DISTINCT FROM before_arrival + (timeline_item.ordinality::integer - 1)
      ) THEN
      RAISE EXCEPTION 'SHORTEN_STAY before stay timeline is not a continuous strict interval'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_shorten_before_timeline_binding';
    END IF;
  EXCEPTION
    WHEN SQLSTATE '23514' THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'SHORTEN_STAY before stay timeline is not a continuous strict interval'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_shorten_before_timeline_binding';
  END;

  WITH ranked_original_claims AS (
    SELECT claim.service_date,
           claim.inventory_unit_id,
           row_number() OVER (
             PARTITION BY claim.service_date
             ORDER BY segment.sequence DESC, claim.created_at DESC, claim.id DESC
           ) AS claim_rank
    FROM inventory_claims AS claim
    JOIN stay_segments AS segment ON segment.id = claim.source_id
    WHERE claim.source_type = 'ORDER_SEGMENT'
      AND segment.stay_id = target_stay.id
      AND segment.sequence < target_segment.sequence
      AND claim.service_date >= before_arrival
      AND claim.service_date < before_departure
  ), canonical_original_timeline AS (
    SELECT service_date, inventory_unit_id
    FROM ranked_original_claims
    WHERE claim_rank = 1
  )
  SELECT count(*)::integer,
         COALESCE(jsonb_agg(jsonb_build_object(
           'serviceDate', service_date::text,
           'inventoryUnitId', inventory_unit_id
         ) ORDER BY service_date), '[]'::jsonb)
    INTO original_timeline_count, original_timeline
    FROM canonical_original_timeline;

  IF original_timeline_count <> before_departure - before_arrival
    OR payload_timeline IS DISTINCT FROM original_timeline THEN
    RAISE EXCEPTION 'SHORTEN_STAY before stay timeline must match the complete prior arrangement'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_shorten_before_timeline_binding';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage11_shorten_before_timeline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'command_executions' THEN
    PERFORM qintopia_assert_stage11_shorten_before_timeline(NEW.id);
  ELSE
    PERFORM qintopia_assert_stage11_shorten_before_timeline(NEW.command_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER amendments_stage11_validate_shorten_before_timeline
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_shorten_before_timeline();

CREATE CONSTRAINT TRIGGER command_executions_stage11_validate_shorten_before_timeline
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_shorten_before_timeline();

CREATE OR REPLACE FUNCTION qintopia_validate_inventory_claim_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_property_id text;
  expected_room_id text;
  source_property_id text;
  source_inventory_unit_id text;
  source_room_id text;
  source_arrival_date date;
  source_departure_date date;
  source_segment_type text;
  source_amendment_type text;
  source_amendment_payload jsonb;
  reschedule_pair_valid boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.property_id IS DISTINCT FROM OLD.property_id
      OR NEW.room_id IS DISTINCT FROM OLD.room_id
      OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
      OR NEW.service_date IS DISTINCT FROM OLD.service_date
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'inventory claim identity and typed source are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.active IS NOT TRUE OR NEW.active IS NOT FALSE OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'inventory claim only supports one active-to-released transition' USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT property_id, CASE WHEN kind = 'ROOM' THEN id ELSE parent_room_id END
  INTO unit_property_id, expected_room_id
  FROM inventory_units WHERE id = NEW.inventory_unit_id;
  IF unit_property_id IS NULL
    OR unit_property_id <> NEW.property_id
    OR expected_room_id IS NULL
    OR expected_room_id <> NEW.room_id THEN
    RAISE EXCEPTION 'inventory claim unit identity is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_claims_unit_identity_valid';
  END IF;

  IF NEW.source_type = 'ORDER_SEGMENT' THEN
    SELECT orders.property_id, segment.inventory_unit_id,
      CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
      segment.arrival_date, segment.departure_date, segment.segment_type, amendment.amendment_type, amendment.payload
    INTO source_property_id, source_inventory_unit_id, source_room_id, source_arrival_date, source_departure_date,
      source_segment_type, source_amendment_type, source_amendment_payload
    FROM stay_segments AS segment
    JOIN stays ON stays.id = segment.stay_id
    JOIN orders ON orders.id = stays.order_id
    JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
    JOIN amendments AS amendment ON amendment.id = segment.amendment_id
    WHERE segment.id = NEW.source_id;
    IF source_segment_type = 'RESCHEDULE_STAY' AND source_amendment_type = 'RESCHEDULE_STAY'
      AND jsonb_typeof(source_amendment_payload #> '{after,stayTimeline}') = 'array' THEN
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(source_amendment_payload #> '{after,stayTimeline}') AS item(value)
        WHERE jsonb_typeof(item.value) = 'object'
          AND item.value ->> 'serviceDate' = NEW.service_date::text
          AND item.value ->> 'inventoryUnitId' = NEW.inventory_unit_id
      ) INTO reschedule_pair_valid;
    END IF;
  ELSIF NEW.source_type = 'MAINTENANCE' THEN
    SELECT lock.property_id, lock.inventory_unit_id,
      CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
      lock.arrival_date, lock.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id, source_arrival_date, source_departure_date
    FROM maintenance_locks AS lock
    JOIN inventory_units AS unit ON unit.id = lock.inventory_unit_id
    WHERE lock.id = NEW.source_id;
  ELSE
    SELECT block.property_id, block.inventory_unit_id, block.room_id,
      block.arrival_date, block.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id, source_arrival_date, source_departure_date
    FROM internal_use_blocks AS block
    WHERE block.id = NEW.source_id;
  END IF;

  IF source_property_id IS NULL
    OR source_property_id <> NEW.property_id
    OR (NEW.source_type = 'ORDER_SEGMENT' AND source_segment_type = 'RESCHEDULE_STAY'
      AND (source_amendment_type <> 'RESCHEDULE_STAY' OR NOT reschedule_pair_valid))
    OR (NOT (NEW.source_type = 'ORDER_SEGMENT' AND source_segment_type = 'RESCHEDULE_STAY'
      AND source_amendment_type = 'RESCHEDULE_STAY') AND (
      source_inventory_unit_id <> NEW.inventory_unit_id
      OR source_room_id <> NEW.room_id
      OR NEW.service_date < source_arrival_date
      OR NEW.service_date >= source_departure_date
    )) THEN
    RAISE EXCEPTION 'inventory claim typed source does not match its property, unit, room, or date'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_claims_typed_source_integrity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage11_move_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  move_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  business_date date;
  effective_date date;
BEGIN
  SELECT * INTO move_amendment FROM amendments WHERE id = NEW.amendment_id;
  IF NOT FOUND OR move_amendment.amendment_type <> 'MOVE_UNIT' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
  BEGIN
    effective_date := (move_amendment.payload ->> 'effectiveDate')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'MOVE_UNIT requires a typed effective date'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_typed_effective_date';
  END;
  business_date := qintopia_stage10_property_today(target_order.property_id);
  IF move_amendment.order_id IS DISTINCT FROM NEW.order_id
    OR target_order.status NOT IN ('RESERVED', 'CHECKED_IN')
    OR move_amendment.payload ->> 'operation' IS DISTINCT FROM 'MOVE_UNIT'
    OR NEW.arrival_date IS DISTINCT FROM target_order.arrival_date
    OR NEW.departure_date IS DISTINCT FROM target_order.departure_date
    OR effective_date < target_order.arrival_date
    OR effective_date >= target_order.departure_date
    OR (target_order.status = 'RESERVED' AND business_date > target_order.arrival_date)
    OR (target_order.status = 'CHECKED_IN' AND effective_date < business_date)
    OR (target_order.status = 'CHECKED_IN' AND business_date >= target_order.departure_date) THEN
    RAISE EXCEPTION 'MOVE_UNIT does not satisfy the order-state and business-date matrix'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_state_date_matrix';
  END IF;
  IF NEW.current_contract_amount_minor < 0
    OR NEW.current_contract_amount_minor > 2147483600
    OR mod(NEW.current_contract_amount_minor, 100) <> 0 THEN
    RAISE EXCEPTION 'MOVE_UNIT contract amount must be a non-negative whole-yuan PostgreSQL integer'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_contract_amount';
  END IF;
  IF target_order.stay_type = 'FREE' THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'FREE'
      OR NEW.policy_base_amount_minor IS DISTINCT FROM 0
      OR NEW.current_contract_amount_minor IS DISTINCT FROM 0
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'free MOVE_UNIT revisions must remain zero and FREE'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_free_zero';
    END IF;
  ELSIF target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'member MOVE_UNIT revisions require MEMBER_ENTITLEMENT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_member_basis';
    END IF;
  ELSIF target_order.booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN') THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'CHANNEL_CONTRACT'
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0
      OR (abs(NEW.current_contract_amount_minor::bigint - NEW.policy_base_amount_minor::bigint) * 100
          > NEW.policy_base_amount_minor::bigint * 15
        AND btrim(COALESCE(move_amendment.payload #>> '{pricingDecision,reason,note}', '')) = '') THEN
      RAISE EXCEPTION 'external-channel MOVE_UNIT revisions require a complete channel amount decision'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_channel_basis';
    END IF;
  ELSIF target_order.booking_channel_code = 'WECOM' THEN
    IF NEW.pricing_basis NOT IN ('POLICY', 'MANUAL_ADJUSTMENT')
      OR (NEW.pricing_basis = 'POLICY' AND NEW.manual_adjustment_minor IS DISTINCT FROM 0)
      OR (NEW.pricing_basis = 'MANUAL_ADJUSTMENT' AND NEW.manual_adjustment_minor = 0)
      OR (NEW.pricing_basis = 'MANUAL_ADJUSTMENT'
        AND btrim(COALESCE(move_amendment.payload #>> '{pricingDecision,reason,note}', '')) = '') THEN
      RAISE EXCEPTION 'WECOM MOVE_UNIT revisions require POLICY or explained MANUAL_ADJUSTMENT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_wecom_basis';
    END IF;
  ELSE
    RAISE EXCEPTION 'paid MOVE_UNIT revisions require a known booking channel'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_channel_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_revisions_stage11_validate_move
BEFORE INSERT ON pricing_revisions
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_move_revision();

CREATE OR REPLACE FUNCTION qintopia_validate_stage11_move_amendment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
BEGIN
  IF NEW.amendment_type <> 'MOVE_UNIT' THEN RETURN NEW; END IF;
  IF NEW.command_id IS NULL THEN
    RAISE EXCEPTION 'new MOVE_UNIT amendments require a command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_command_required';
  END IF;
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;
  IF execution_type IS DISTINCT FROM 'MOVE_UNIT' THEN
    RAISE EXCEPTION 'MOVE_UNIT amendment requires a MOVE_UNIT command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_command_type';
  END IF;
  IF btrim(NEW.reason_note) = '' THEN
    RAISE EXCEPTION 'MOVE_UNIT requires an operator reason note'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_reason_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amendments_stage11_validate_move
BEFORE INSERT ON amendments
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_move_amendment();

CREATE OR REPLACE FUNCTION qintopia_preserve_stage11_consumed_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CONSUMED' AND (
    TG_OP = 'DELETE'
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.lot_id IS DISTINCT FROM OLD.lot_id
    OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
    OR NEW.service_date IS DISTINCT FROM OLD.service_date
    OR NEW.unit_kind IS DISTINCT FROM OLD.unit_kind
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.held_by_revision_id IS DISTINCT FROM OLD.held_by_revision_id
  ) THEN
    RAISE EXCEPTION 'consumed member coverage is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_consumed_coverage_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_items_stage11_preserve_consumed_update
BEFORE UPDATE ON coverage_items
FOR EACH ROW EXECUTE FUNCTION qintopia_preserve_stage11_consumed_coverage();
CREATE TRIGGER coverage_items_stage11_preserve_consumed_delete
BEFORE DELETE ON coverage_items
FOR EACH ROW EXECUTE FUNCTION qintopia_preserve_stage11_consumed_coverage();

CREATE OR REPLACE FUNCTION qintopia_validate_stage11_move_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  coverage_order_id text;
BEGIN
  IF NEW.command_id IS NULL THEN RETURN NEW; END IF;
  SELECT command_type, state INTO execution_type, execution_state FROM command_executions WHERE id = NEW.command_id;
  IF execution_type IN ('RESCHEDULE_STAY', 'EXTEND_STAY') THEN
    IF execution_state IS DISTINCT FROM 'EXECUTING' THEN
      RAISE EXCEPTION 'completed stay date change ledger counts are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_ledger_closed';
    END IF;
    RETURN NEW;
  END IF;
  IF execution_type IS DISTINCT FROM 'MOVE_UNIT' THEN RETURN NEW; END IF;
  IF execution_state IS DISTINCT FROM 'EXECUTING' THEN
    RAISE EXCEPTION 'completed MOVE_UNIT ledger facts are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_ledger_closed';
  END IF;
  IF NEW.entry_type NOT IN ('HOLD', 'RELEASE')
    OR NEW.quantity_delta <> (CASE NEW.entry_type WHEN 'HOLD' THEN -1 ELSE 1 END) THEN
    RAISE EXCEPTION 'MOVE_UNIT may only migrate HELD coverage with balanced HOLD and RELEASE facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_ledger_entry';
  END IF;
  SELECT order_id INTO coverage_order_id FROM coverage_items WHERE id = NEW.coverage_id;
  IF coverage_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'MOVE_UNIT entitlement fact must reference coverage from the same order'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_ledger_order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlement_ledger_stage11_validate_move
BEFORE INSERT ON entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_move_ledger();

CREATE OR REPLACE FUNCTION qintopia_reject_stage11_move_collection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE execution_type text;
BEGIN
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;
  IF execution_type = 'MOVE_UNIT' THEN
    RAISE EXCEPTION 'MOVE_UNIT must not append collection or refund facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_no_collection_write';
  ELSIF execution_type IN ('RESCHEDULE_STAY', 'EXTEND_STAY') THEN
    RAISE EXCEPTION 'stay date changes must not append collection or refund facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_no_collection_write';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_facts_stage11_reject_move
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_stage11_move_collection();

CREATE OR REPLACE FUNCTION qintopia_preserve_stage11_preview_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.command_type IS DISTINCT FROM OLD.command_type
    OR NEW.normalized_input IS DISTINCT FROM OLD.normalized_input
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.effect IS DISTINCT FROM OLD.effect
    OR NEW.effect_hash IS DISTINCT FROM OLD.effect_hash
    OR NEW.basis_versions IS DISTINCT FROM OLD.basis_versions
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'command Preview protocol evidence is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'stage11_preview_evidence_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER command_previews_stage11_preserve_evidence
BEFORE UPDATE ON command_previews
FOR EACH ROW EXECUTE FUNCTION qintopia_preserve_stage11_preview_evidence();

CREATE OR REPLACE FUNCTION qintopia_assert_stage11_protocol_evidence(
  target_command_id text,
  target_amendment_id text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  target_execution command_executions%ROWTYPE;
  target_amendment amendments%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  target_receipt command_receipts%ROWTYPE;
  target_audit audit_entries%ROWTYPE;
  allowed_audit_count integer;
BEGIN
  SELECT * INTO STRICT target_execution FROM command_executions WHERE id = target_command_id;
  SELECT * INTO STRICT target_amendment FROM amendments WHERE id = target_amendment_id;
  SELECT count(*)::integer INTO allowed_audit_count
    FROM audit_entries
    WHERE command_id = target_command_id AND decision = 'ALLOWED';
  IF allowed_audit_count <> 1 THEN
    RAISE EXCEPTION 'Stage 11 command requires one authoritative audit record'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_protocol_evidence_complete';
  END IF;
  SELECT * INTO STRICT target_audit
    FROM audit_entries WHERE command_id = target_command_id AND decision = 'ALLOWED';
  SELECT * INTO STRICT target_preview
    FROM command_previews WHERE id = target_audit.metadata ->> 'previewId';
  SELECT * INTO STRICT target_receipt
    FROM command_receipts WHERE command_id = target_command_id;

  IF target_execution.state IS DISTINCT FROM 'APPLIED'
    OR target_amendment.command_id IS DISTINCT FROM target_execution.id
    OR target_amendment.amendment_type IS DISTINCT FROM target_execution.command_type
    OR target_preview.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_preview.property_id IS DISTINCT FROM target_execution.property_id
    OR target_preview.command_type IS DISTINCT FROM target_execution.command_type
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.effect IS DISTINCT FROM target_amendment.payload
    OR target_audit.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_audit.credential_id IS DISTINCT FROM target_execution.credential_id
    OR target_audit.action IS DISTINCT FROM target_execution.command_type
    OR target_audit.correlation_id IS DISTINCT FROM target_execution.correlation_id
    OR target_audit.reason ->> 'code' IS DISTINCT FROM target_amendment.reason_code
    OR target_audit.reason ->> 'note' IS DISTINCT FROM target_amendment.reason_note
    OR target_audit.metadata ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_receipt.execution_status IS DISTINCT FROM 'EXECUTED'
    OR target_receipt.business_committed IS DISTINCT FROM true
    OR target_receipt.error IS NOT NULL
    OR target_receipt.result ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_receipt.result ->> 'orderId' IS DISTINCT FROM target_amendment.order_id
    OR target_receipt.result ->> 'amendmentId' IS DISTINCT FROM target_amendment.id THEN
    RAISE EXCEPTION 'Stage 11 Preview, amendment, audit, and Receipt evidence do not bind one effect'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_protocol_evidence_binding';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_assert_stage11_move_combination(target_command_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  move_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  move_count integer;
  command_amendment_count integer;
  segment_count integer;
  revision_count integer;
  before_count integer;
  after_count integer;
  historical_before_count integer;
  active_claim_count integer;
  actual_occupant_count integer;
  effect_occupant_count integer;
  effect_occupancy_capacity integer;
  command_ledger_count integer;
  release_ledger_count integer;
  hold_ledger_count integer;
  effect_ledger_count integer;
  actual_fact_count bigint;
  actual_net_collection bigint;
  effect_fact_count bigint;
  effect_net_collection bigint;
  effect_collection_difference bigint;
  before_arrival date;
  before_departure date;
  after_arrival date;
  after_departure date;
  effective_date date;
  target_unit_id text;
  target_unit_active boolean;
  target_unit_property_id text;
  target_unit_kind text;
  target_unit_room_type_code text;
  target_unit_capacity integer;
  before_timeline jsonb;
  after_timeline jsonb;
  historical_before_timeline jsonb;
  active_claim_timeline jsonb;
  active_coverage jsonb;
  consumed_dates jsonb;
  preserved_coverage_dates jsonb;
  migrated_coverage_dates jsonb;
  expected_target_snapshot jsonb;
  expected_preserved_claims jsonb;
  expected_released_claims jsonb;
  expected_added_claims jsonb;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id INTO execution_type, execution_state, execution_property_id
    FROM command_executions WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'MOVE_UNIT' THEN RETURN; END IF;
  SELECT count(*)::integer INTO command_amendment_count FROM amendments
    WHERE command_id = target_command_id;
  SELECT count(*)::integer INTO move_count FROM amendments
    WHERE command_id = target_command_id AND amendment_type = 'MOVE_UNIT';
  IF command_amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN RETURN; END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED'
    OR command_amendment_count <> 1
    OR move_count <> 1 THEN
    RAISE EXCEPTION 'complete MOVE_UNIT facts require one amendment and an applied execution'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_execution_complete';
  END IF;
  SELECT * INTO STRICT move_amendment FROM amendments
    WHERE command_id = target_command_id AND amendment_type = 'MOVE_UNIT';
  BEGIN
    before_arrival := (move_amendment.payload #>> '{before,arrivalDate}')::date;
    before_departure := (move_amendment.payload #>> '{before,departureDate}')::date;
    after_arrival := (move_amendment.payload #>> '{after,arrivalDate}')::date;
    after_departure := (move_amendment.payload #>> '{after,departureDate}')::date;
    effective_date := (move_amendment.payload ->> 'effectiveDate')::date;
    effect_ledger_count := (move_amendment.payload #>> '{entitlementSummary,ledgerWriteCount}')::integer;
    effect_fact_count := (move_amendment.payload #>> '{fundsSummary,factCount}')::bigint;
    effect_net_collection := (move_amendment.payload #>> '{fundsSummary,netRecordedCollection,minorUnits}')::bigint;
    effect_collection_difference := (move_amendment.payload #>> '{fundsSummary,collectionDifference,minorUnits}')::bigint;
    effect_occupant_count := (move_amendment.payload ->> 'occupantCount')::integer;
    effect_occupancy_capacity := (move_amendment.payload ->> 'occupancyCapacity')::integer;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'MOVE_UNIT amendment has incomplete typed fields'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_typed_payload';
  END;
  target_unit_id := move_amendment.payload #>> '{toInventoryUnit,id}';
  IF move_amendment.sequence IS DISTINCT FROM move_amendment.new_version
    OR move_amendment.new_version IS DISTINCT FROM move_amendment.prior_version + 1
    OR move_amendment.order_id IS DISTINCT FROM move_amendment.payload ->> 'orderId'
    OR move_amendment.payload ->> 'operation' IS DISTINCT FROM 'MOVE_UNIT'
    OR after_arrival IS DISTINCT FROM before_arrival
    OR after_departure IS DISTINCT FROM before_departure
    OR effective_date < after_arrival OR effective_date >= after_departure
    OR btrim(COALESCE(target_unit_id, '')) = ''
    OR jsonb_typeof(move_amendment.payload #> '{before,stayTimeline}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{after,stayTimeline}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{inventoryChange,preservedClaims}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{inventoryChange,releasedClaims}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{inventoryChange,addedClaims}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload -> 'entitlementSummary') IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(move_amendment.payload -> 'entitlementSummary')) IS DISTINCT FROM 4
    OR jsonb_typeof(move_amendment.payload #> '{entitlementSummary,preservedCoverageDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{entitlementSummary,migratedHeldCoverageDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{entitlementSummary,consumedCoverageDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(move_amendment.payload #> '{entitlementSummary,ledgerWriteCount}') IS DISTINCT FROM 'number'
    OR effect_ledger_count < 0 OR effect_fact_count < 0
    OR effect_occupant_count < 1 OR effect_occupancy_capacity < 1 THEN
    RAISE EXCEPTION 'MOVE_UNIT amendment shape is incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_amendment_shape';
  END IF;
  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', item.value ->> 'serviceDate', 'inventoryUnitId', item.value ->> 'inventoryUnitId')
      ORDER BY item.ordinality), '[]'::jsonb)
    INTO before_count, before_timeline
    FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS item(value, ordinality);
  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', item.value ->> 'serviceDate', 'inventoryUnitId', item.value ->> 'inventoryUnitId')
      ORDER BY item.ordinality), '[]'::jsonb)
    INTO after_count, after_timeline
    FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS item(value, ordinality);
  IF before_count <> before_departure - before_arrival OR after_count <> after_departure - after_arrival
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS item(value, ordinality)
      WHERE jsonb_typeof(item.value) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(item.value)) IS DISTINCT FROM 2
        OR (item.value ->> 'serviceDate')::date IS DISTINCT FROM before_arrival + (item.ordinality::integer - 1)
        OR btrim(COALESCE(item.value ->> 'inventoryUnitId', '')) = '')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS item(value, ordinality)
      WHERE jsonb_typeof(item.value) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(item.value)) IS DISTINCT FROM 2
        OR (item.value ->> 'serviceDate')::date IS DISTINCT FROM after_arrival + (item.ordinality::integer - 1)
        OR btrim(COALESCE(item.value ->> 'inventoryUnitId', '')) = '')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS item(value)
      WHERE (item.value ->> 'serviceDate')::date < effective_date
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') AS prior(value)
          WHERE prior.value ->> 'serviceDate' = item.value ->> 'serviceDate'
            AND prior.value ->> 'inventoryUnitId' = item.value ->> 'inventoryUnitId'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS item(value)
      WHERE (item.value ->> 'serviceDate')::date >= effective_date
        AND item.value ->> 'inventoryUnitId' IS DISTINCT FROM target_unit_id)
    OR before_timeline IS NOT DISTINCT FROM after_timeline THEN
    RAISE EXCEPTION 'MOVE_UNIT before and after timelines are not a legal suffix replacement'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_timeline_shape';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', prior.value ->> 'serviceDate', 'inventoryUnitId', prior.value ->> 'inventoryUnitId')
      ORDER BY prior.ordinality), '[]'::jsonb)
    INTO expected_preserved_claims
    FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS prior(value, ordinality)
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS next(value)
      WHERE next.value ->> 'serviceDate' = prior.value ->> 'serviceDate'
        AND next.value ->> 'inventoryUnitId' = prior.value ->> 'inventoryUnitId');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', prior.value ->> 'serviceDate', 'inventoryUnitId', prior.value ->> 'inventoryUnitId')
      ORDER BY prior.ordinality), '[]'::jsonb)
    INTO expected_released_claims
    FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS prior(value, ordinality)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS next(value)
      WHERE next.value ->> 'serviceDate' = prior.value ->> 'serviceDate'
        AND next.value ->> 'inventoryUnitId' = prior.value ->> 'inventoryUnitId');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', next.value ->> 'serviceDate', 'inventoryUnitId', next.value ->> 'inventoryUnitId')
      ORDER BY next.ordinality), '[]'::jsonb)
    INTO expected_added_claims
    FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS next(value, ordinality)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') AS prior(value)
      WHERE prior.value ->> 'serviceDate' = next.value ->> 'serviceDate'
        AND prior.value ->> 'inventoryUnitId' = next.value ->> 'inventoryUnitId');

  IF move_amendment.payload #> '{inventoryChange,preservedClaims}' IS DISTINCT FROM expected_preserved_claims
    OR move_amendment.payload #> '{inventoryChange,releasedClaims}' IS DISTINCT FROM expected_released_claims
    OR move_amendment.payload #> '{inventoryChange,addedClaims}' IS DISTINCT FROM expected_added_claims
    OR jsonb_array_length(move_amendment.payload #> '{inventoryChange,preservedClaims}')
      + jsonb_array_length(move_amendment.payload #> '{inventoryChange,releasedClaims}') <> before_count
    OR jsonb_array_length(move_amendment.payload #> '{inventoryChange,preservedClaims}')
      + jsonb_array_length(move_amendment.payload #> '{inventoryChange,addedClaims}') <> after_count
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') AS prior(value)
      JOIN jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS next(value)
        ON next.value ->> 'serviceDate' = prior.value ->> 'serviceDate'
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(move_amendment.payload #> CASE
          WHEN next.value ->> 'inventoryUnitId' = prior.value ->> 'inventoryUnitId'
            THEN '{inventoryChange,preservedClaims}'::text[]
          ELSE '{inventoryChange,releasedClaims}'::text[]
        END) AS diff(value)
        WHERE diff.value ->> 'serviceDate' = prior.value ->> 'serviceDate'
          AND diff.value ->> 'inventoryUnitId' = prior.value ->> 'inventoryUnitId'
      )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS next(value)
      JOIN jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') AS prior(value)
        ON prior.value ->> 'serviceDate' = next.value ->> 'serviceDate'
      WHERE next.value ->> 'inventoryUnitId' <> prior.value ->> 'inventoryUnitId'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{inventoryChange,addedClaims}') AS added(value)
          WHERE added.value ->> 'serviceDate' = next.value ->> 'serviceDate'
            AND added.value ->> 'inventoryUnitId' = next.value ->> 'inventoryUnitId'
        )
    ) THEN
    RAISE EXCEPTION 'MOVE_UNIT inventory diff does not exactly partition the before and after timelines'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_inventory_diff';
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = move_amendment.order_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  IF execution_property_id IS DISTINCT FROM target_order.property_id
    OR move_amendment.payload ->> 'stayId' IS DISTINCT FROM target_stay.id
    OR move_amendment.sequence IS DISTINCT FROM (SELECT max(sequence) FROM amendments WHERE order_id = target_order.id)
    OR (move_amendment.prior_version > 0 AND NOT EXISTS (
      SELECT 1 FROM amendments AS prior
      WHERE prior.order_id = target_order.id AND prior.sequence = move_amendment.prior_version
        AND prior.new_version = move_amendment.prior_version
        AND prior.sequence = (SELECT max(previous.sequence) FROM amendments AS previous
          WHERE previous.order_id = target_order.id AND previous.sequence < move_amendment.sequence)
    )) THEN
    RAISE EXCEPTION 'MOVE_UNIT command and amendment must bind the current order aggregate'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_order_command_chain';
  END IF;

  IF (target_order.status = 'RESERVED' AND EXISTS (
      SELECT 1 FROM coverage_items
      WHERE order_id = target_order.id AND status = 'CONSUMED'
    )) OR (target_order.status = 'CHECKED_IN' AND EXISTS (
      SELECT 1 FROM coverage_items
      WHERE order_id = target_order.id AND status = 'HELD'
    )) THEN
    RAISE EXCEPTION 'MOVE_UNIT order and active member coverage lifecycle states are incompatible'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_coverage_lifecycle_state';
  END IF;

  SELECT unit.property_id, unit.active, unit.kind, unit.room_type_code, unit.occupancy_capacity,
      jsonb_build_object(
        'id', unit.id,
        'propertyId', unit.property_id,
        'kind', unit.kind,
        'roomId', CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
        'code', unit.code,
        'name', unit.name,
        'catalogVersion', unit.catalog_version,
        'buildingCode', unit.building_code,
        'roomTypeCode', unit.room_type_code,
        'pricingProductCode', unit.pricing_product_code,
        'inventoryBasis', unit.inventory_basis,
        'codeProvenance', unit.code_provenance,
        'physicalBedCount', unit.physical_bed_count,
        'occupancyCapacity', unit.occupancy_capacity
      )
    INTO target_unit_property_id, target_unit_active, target_unit_kind, target_unit_room_type_code,
      target_unit_capacity, expected_target_snapshot
    FROM inventory_units AS unit WHERE unit.id = target_unit_id;
  SELECT count(*)::integer INTO actual_occupant_count FROM order_occupants WHERE order_id = target_order.id;
  IF target_unit_property_id IS DISTINCT FROM target_order.property_id
    OR target_unit_active IS DISTINCT FROM true
    OR actual_occupant_count < 1
    OR actual_occupant_count > target_unit_capacity
    OR effect_occupant_count IS DISTINCT FROM actual_occupant_count
    OR effect_occupancy_capacity IS DISTINCT FROM target_unit_capacity
    OR move_amendment.payload -> 'toInventoryUnit' IS DISTINCT FROM expected_target_snapshot THEN
    RAISE EXCEPTION 'MOVE_UNIT target activity, snapshot, occupants, or capacity is stale'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_target_capacity_snapshot';
  END IF;
  SELECT count(*)::integer INTO segment_count FROM stay_segments WHERE amendment_id = move_amendment.id;
  SELECT count(*)::integer INTO revision_count FROM pricing_revisions WHERE amendment_id = move_amendment.id;
  IF segment_count <> 1 OR revision_count <> 1 THEN
    RAISE EXCEPTION 'MOVE_UNIT requires exactly one segment and one pricing revision'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_segment_revision_complete';
  END IF;
  SELECT * INTO STRICT target_segment FROM stay_segments WHERE amendment_id = move_amendment.id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE amendment_id = move_amendment.id;
  IF target_segment.stay_id IS DISTINCT FROM target_stay.id
    OR target_segment.segment_type IS DISTINCT FROM 'MOVE'
    OR target_segment.inventory_unit_id IS DISTINCT FROM target_unit_id
    OR target_segment.arrival_date IS DISTINCT FROM effective_date
    OR target_segment.departure_date IS DISTINCT FROM after_departure
    OR target_segment.supersedes_segment_id IS NULL
    OR target_segment.sequence IS DISTINCT FROM (SELECT max(sequence) FROM stay_segments WHERE stay_id = target_stay.id)
    OR NOT EXISTS (SELECT 1 FROM stay_segments AS prior WHERE prior.id = target_segment.supersedes_segment_id
      AND prior.stay_id = target_stay.id AND prior.sequence = target_segment.sequence - 1
      AND prior.sequence = (SELECT max(previous.sequence) FROM stay_segments AS previous
        WHERE previous.stay_id = target_stay.id AND previous.id <> target_segment.id))
    OR target_revision.order_id IS DISTINCT FROM target_order.id
    OR target_revision.revision_no IS DISTINCT FROM (SELECT max(revision_no) FROM pricing_revisions WHERE order_id = target_order.id)
    OR target_revision.arrival_date IS DISTINCT FROM after_arrival
    OR target_revision.departure_date IS DISTINCT FROM after_departure
    OR target_revision.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id
    OR target_revision.policy_base_amount_minor::text IS DISTINCT FROM move_amendment.payload #>> '{pricingDecision,policyBaseAmount,minorUnits}'
    OR target_revision.current_contract_amount_minor::text IS DISTINCT FROM move_amendment.payload #>> '{pricingDecision,targetCurrentContractAmount,minorUnits}'
    OR target_revision.current_contract_amount_minor::text IS DISTINCT FROM move_amendment.payload #>> '{after,pricing,currentContractAmount,minorUnits}'
    OR target_revision.manual_adjustment_minor::text IS DISTINCT FROM move_amendment.payload #>> '{pricingDecision,manualAdjustmentMinor}'
    OR target_revision.pricing_basis IS DISTINCT FROM move_amendment.payload #>> '{pricingDecision,pricingBasis}'
    OR target_revision.currency IS DISTINCT FROM move_amendment.payload #>> '{pricingDecision,policyBaseAmount,currency}'
    OR target_revision.currency IS DISTINCT FROM move_amendment.payload #>> '{pricingDecision,targetCurrentContractAmount,currency}'
    OR target_revision.currency IS DISTINCT FROM move_amendment.payload #>> '{after,pricing,currentContractAmount,currency}'
    OR target_revision.currency IS DISTINCT FROM move_amendment.payload #>> '{fundsSummary,netRecordedCollection,currency}'
    OR target_revision.currency IS DISTINCT FROM move_amendment.payload #>> '{fundsSummary,collectionDifference,currency}'
    OR target_revision.coverage_set IS DISTINCT FROM move_amendment.payload #> '{after,pricing,coverageSet}'
    OR target_revision.cash_lines IS DISTINCT FROM move_amendment.payload #> '{after,pricing,cashLines}'
    OR target_order.arrival_date IS DISTINCT FROM after_arrival
    OR target_order.departure_date IS DISTINCT FROM after_departure
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id
    OR target_order.version IS DISTINCT FROM move_amendment.new_version
    OR NOT EXISTS (SELECT 1 FROM pricing_revisions AS prior
      WHERE prior.order_id = target_order.id
        AND prior.revision_no = target_revision.revision_no - 1
        AND prior.arrival_date = before_arrival
        AND prior.departure_date = before_departure
        AND prior.current_contract_amount_minor::text = move_amendment.payload #>> '{before,currentContractAmount,minorUnits}'
        AND prior.currency = move_amendment.payload #>> '{before,currentContractAmount,currency}')
    OR (target_order.status = 'RESERVED' AND target_stay.status <> 'PLANNED')
    OR (target_order.status = 'CHECKED_IN' AND target_stay.status <> 'IN_HOUSE') THEN
    RAISE EXCEPTION 'MOVE_UNIT current arrangement and pricing pointers are incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_current_projection';
  END IF;

  WITH ranked_prior_claims AS (
    SELECT claim.service_date, claim.inventory_unit_id,
      row_number() OVER (
        PARTITION BY claim.service_date
        ORDER BY segment.sequence DESC, claim.created_at DESC, claim.id DESC
      ) AS claim_rank
    FROM inventory_claims AS claim
    JOIN stay_segments AS segment ON segment.id = claim.source_id
    WHERE claim.source_type = 'ORDER_SEGMENT'
      AND segment.stay_id = target_stay.id
      AND segment.sequence < target_segment.sequence
      AND claim.service_date >= before_arrival
      AND claim.service_date < before_departure
  )
  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', service_date::text, 'inventoryUnitId', inventory_unit_id)
      ORDER BY service_date), '[]'::jsonb)
    INTO historical_before_count, historical_before_timeline
    FROM ranked_prior_claims WHERE claim_rank = 1;
  IF historical_before_count <> before_count
    OR historical_before_timeline IS DISTINCT FROM before_timeline THEN
    RAISE EXCEPTION 'MOVE_UNIT before timeline must match the immediate pre-command arrangement'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_before_claim_chain';
  END IF;

  IF target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') AS item(value)
      LEFT JOIN inventory_units AS prior_unit ON prior_unit.id = item.value ->> 'inventoryUnitId'
      WHERE prior_unit.id IS NULL
        OR prior_unit.kind IS DISTINCT FROM target_unit_kind
        OR prior_unit.room_type_code IS DISTINCT FROM target_unit_room_type_code
    ) OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      LEFT JOIN member_contracts AS contract ON contract.id = coverage.contract_id
      LEFT JOIN membership_orders AS membership
        ON membership.id = contract.membership_order_id
        AND membership.entitlement_lot_id = coverage.lot_id
        AND membership.contract_id = coverage.contract_id
      LEFT JOIN inventory_units AS coverage_unit ON coverage_unit.id = coverage.inventory_unit_id
      WHERE coverage.order_id = target_order.id
        AND coverage.status IN ('HELD', 'CONSUMED')
        AND (
          contract.id IS NULL
          OR coverage_unit.id IS NULL
          OR coverage_unit.kind IS DISTINCT FROM target_unit_kind
          OR coverage_unit.room_type_code IS DISTINCT FROM target_unit_room_type_code
          OR coverage.unit_kind IS DISTINCT FROM
            CASE target_unit_kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END
          OR (contract.membership_order_id IS NOT NULL AND (
            membership.id IS NULL
            OR membership.status IS DISTINCT FROM 'ACTIVE'
            OR membership.allowed_inventory_kind IS DISTINCT FROM target_unit_kind
            OR membership.allowed_room_type_code IS DISTINCT FROM target_unit_room_type_code
            OR membership.entitlement_unit_kind IS DISTINCT FROM
              CASE target_unit_kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END
            OR membership.allowed_inventory_kind IS DISTINCT FROM coverage_unit.kind
            OR membership.allowed_room_type_code IS DISTINCT FROM coverage_unit.room_type_code
            OR membership.entitlement_unit_kind IS DISTINCT FROM coverage.unit_kind
          ))
        )
    ) OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      WHERE coverage.order_id = target_order.id
        AND coverage.status = 'CONSUMED'
        AND NOT EXISTS (
          SELECT 1
          FROM inventory_claims AS claim
          JOIN stay_segments AS segment ON segment.id = claim.source_id
          WHERE claim.source_type = 'ORDER_SEGMENT'
            AND segment.stay_id = target_stay.id
            AND claim.service_date = coverage.service_date
            AND claim.inventory_unit_id = coverage.inventory_unit_id
        )
    ) THEN
      RAISE EXCEPTION 'member MOVE_UNIT target and historical coverage must match the active membership product'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_member_product';
    END IF;
  END IF;

  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', claim.service_date::text, 'inventoryUnitId', claim.inventory_unit_id)
      ORDER BY claim.service_date), '[]'::jsonb)
    INTO active_claim_count, active_claim_timeline
    FROM inventory_claims AS claim
    WHERE claim.source_type = 'ORDER_SEGMENT' AND claim.active
      AND claim.source_id IN (SELECT id FROM stay_segments WHERE stay_id = target_stay.id);
  IF active_claim_count <> after_count OR active_claim_timeline IS DISTINCT FROM after_timeline
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{inventoryChange,preservedClaims}') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_claims AS claim JOIN stay_segments AS segment ON segment.id = claim.source_id
        WHERE claim.source_type = 'ORDER_SEGMENT' AND claim.active AND segment.stay_id = target_stay.id
          AND segment.sequence < target_segment.sequence
          AND claim.service_date::text = item.value ->> 'serviceDate'
          AND claim.inventory_unit_id = item.value ->> 'inventoryUnitId'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{inventoryChange,addedClaims}') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_claims AS claim
        WHERE claim.source_type = 'ORDER_SEGMENT' AND claim.active AND claim.source_id = target_segment.id
          AND claim.service_date::text = item.value ->> 'serviceDate'
          AND claim.inventory_unit_id = item.value ->> 'inventoryUnitId'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{inventoryChange,releasedClaims}') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_claims AS claim JOIN stay_segments AS segment ON segment.id = claim.source_id
        WHERE claim.source_type = 'ORDER_SEGMENT' AND NOT claim.active AND segment.stay_id = target_stay.id
          AND segment.sequence < target_segment.sequence
          AND claim.service_date::text = item.value ->> 'serviceDate'
          AND claim.inventory_unit_id = item.value ->> 'inventoryUnitId')) THEN
    RAISE EXCEPTION 'MOVE_UNIT active and historical Claim sets do not match the frozen diff'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_claim_binding';
  END IF;
  SELECT count(*)::bigint, COALESCE(sum(net_effect_minor), 0)::bigint
    INTO actual_fact_count, actual_net_collection FROM collection_facts WHERE order_id = target_order.id;
  IF actual_fact_count IS DISTINCT FROM effect_fact_count
    OR actual_net_collection IS DISTINCT FROM effect_net_collection
    OR effect_collection_difference IS DISTINCT FROM target_revision.current_contract_amount_minor::bigint - effect_net_collection
    OR EXISTS (SELECT 1 FROM collection_facts
      WHERE order_id = target_order.id AND currency IS DISTINCT FROM target_revision.currency)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id) THEN
    RAISE EXCEPTION 'MOVE_UNIT funds summary must be frozen and money-write free'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_frozen_funds';
  END IF;
  SELECT count(*)::integer,
      count(*) FILTER (WHERE entry_type = 'RELEASE')::integer,
      count(*) FILTER (WHERE entry_type = 'HOLD')::integer
    INTO command_ledger_count, release_ledger_count, hold_ledger_count
    FROM entitlement_ledger WHERE command_id = target_command_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', coverage.service_date::text,
      'inventoryUnitId', coverage.inventory_unit_id,
      'unitKind', coverage.unit_kind,
      'entitlementLotId', coverage.lot_id) ORDER BY coverage.service_date), '[]'::jsonb)
    INTO active_coverage FROM coverage_items AS coverage
    WHERE coverage.order_id = target_order.id
      AND coverage.status IN ('HELD', 'CONSUMED')
      AND coverage.service_date >= after_arrival
      AND coverage.service_date < after_departure;
  SELECT COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text) ORDER BY coverage.service_date), '[]'::jsonb)
    INTO consumed_dates FROM coverage_items AS coverage
    WHERE coverage.order_id = target_order.id AND coverage.status = 'CONSUMED';
  SELECT COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text) ORDER BY coverage.service_date), '[]'::jsonb)
    INTO preserved_coverage_dates FROM coverage_items AS coverage
    WHERE coverage.order_id = target_order.id
      AND coverage.status = 'HELD'
      AND coverage.service_date >= after_arrival
      AND coverage.service_date < after_departure
      AND coverage.held_by_revision_id <> target_revision.id;
  SELECT COALESCE(jsonb_agg(to_jsonb(ledger.service_date::text) ORDER BY ledger.service_date), '[]'::jsonb)
    INTO migrated_coverage_dates FROM entitlement_ledger AS ledger
    WHERE ledger.command_id = target_command_id AND ledger.entry_type = 'RELEASE';
  IF target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN
    IF target_revision.coverage_set IS DISTINCT FROM active_coverage
      OR move_amendment.payload #> '{entitlementSummary,preservedCoverageDates}' IS DISTINCT FROM preserved_coverage_dates
      OR move_amendment.payload #> '{entitlementSummary,migratedHeldCoverageDates}' IS DISTINCT FROM migrated_coverage_dates
      OR move_amendment.payload #> '{entitlementSummary,consumedCoverageDates}' IS DISTINCT FROM consumed_dates
      OR command_ledger_count IS DISTINCT FROM effect_ledger_count
      OR release_ledger_count <> hold_ledger_count
      OR command_ledger_count <> release_ledger_count + hold_ledger_count
      OR effect_ledger_count <> release_ledger_count * 2
      OR EXISTS (SELECT 1 FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id AND coverage.status = 'HELD'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{after,stayTimeline}') AS item(value)
            WHERE item.value ->> 'serviceDate' = coverage.service_date::text
              AND item.value ->> 'inventoryUnitId' = coverage.inventory_unit_id))
      OR EXISTS (SELECT 1 FROM entitlement_ledger AS ledger
        WHERE ledger.command_id = target_command_id
          AND ledger.entry_type IN ('RELEASE', 'HOLD')
          AND ledger.service_date < effective_date)
      OR EXISTS (SELECT 1 FROM coverage_items
        WHERE order_id = target_order.id AND status = 'HELD'
          AND (service_date < after_arrival OR service_date >= after_departure))
      OR EXISTS (SELECT 1 FROM coverage_items AS coverage JOIN inventory_units AS unit ON unit.id = coverage.inventory_unit_id
        WHERE coverage.order_id = target_order.id AND coverage.status IN ('HELD', 'CONSUMED')
          AND coverage.unit_kind <> CASE unit.kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END)
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS ledger
        LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
        WHERE ledger.command_id = target_command_id AND (
          ledger.entry_type NOT IN ('RELEASE', 'HOLD')
          OR ledger.order_id IS DISTINCT FROM target_order.id
          OR coverage.order_id IS DISTINCT FROM target_order.id
          OR coverage.service_date IS DISTINCT FROM ledger.service_date
          OR coverage.lot_id IS DISTINCT FROM ledger.lot_id
          OR (ledger.entry_type = 'RELEASE' AND (
            ledger.quantity_delta <> 1
            OR ledger.reason <> 'ORDER_COVERAGE_RELEASE'
            OR coverage.status <> 'RELEASED'
            OR coverage.held_by_revision_id = target_revision.id
            OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(move_amendment.payload #> '{before,stayTimeline}') AS item(value)
              WHERE item.value ->> 'serviceDate' = ledger.service_date::text
                AND item.value ->> 'inventoryUnitId' = coverage.inventory_unit_id
            )
          ))
          OR (ledger.entry_type = 'HOLD' AND (
            ledger.quantity_delta <> -1
            OR ledger.reason <> 'ORDER_COVERAGE_HOLD'
            OR coverage.status <> 'HELD'
            OR coverage.held_by_revision_id <> target_revision.id
            OR coverage.inventory_unit_id <> target_unit_id
          ))
        )
      )
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS release
        LEFT JOIN coverage_items AS released_coverage ON released_coverage.id = release.coverage_id
        WHERE release.command_id = target_command_id AND release.entry_type = 'RELEASE'
          AND NOT EXISTS (
            SELECT 1
            FROM entitlement_ledger AS hold
            JOIN coverage_items AS held_coverage ON held_coverage.id = hold.coverage_id
            WHERE hold.command_id = target_command_id
              AND hold.entry_type = 'HOLD'
              AND hold.service_date = release.service_date
              AND held_coverage.contract_id = released_coverage.contract_id
              AND held_coverage.lot_id = released_coverage.lot_id
              AND held_coverage.unit_kind = released_coverage.unit_kind
          )
      )
      OR EXISTS (
        SELECT 1 FROM entitlement_ledger
        WHERE command_id = target_command_id
        GROUP BY entry_type, service_date HAVING count(*) <> 1
      ) THEN
      RAISE EXCEPTION 'member MOVE_UNIT coverage must match immutable and active entitlement facts'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_member_coverage';
    END IF;
  ELSIF target_revision.coverage_set IS DISTINCT FROM '[]'::jsonb
    OR move_amendment.payload #> '{entitlementSummary,preservedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR move_amendment.payload #> '{entitlementSummary,migratedHeldCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR move_amendment.payload #> '{entitlementSummary,consumedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR effect_ledger_count IS DISTINCT FROM 0
    OR command_ledger_count <> 0 THEN
    RAISE EXCEPTION 'non-member MOVE_UNIT must not contain entitlement coverage or ledger facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_move_nonmember_coverage';
  END IF;
  PERFORM qintopia_assert_stage11_protocol_evidence(target_command_id, move_amendment.id);
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_assert_stage11_date_change_combination(target_command_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  change_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  command_amendment_count integer;
  change_count integer;
  segment_count integer;
  revision_count integer;
  before_count integer;
  after_count integer;
  historical_count integer;
  active_claim_count integer;
  ledger_count integer;
  release_ledger_count integer;
  hold_ledger_count integer;
  consume_ledger_count integer;
  expire_ledger_count integer;
  actual_net_collection bigint;
  effect_net_collection bigint;
  effect_collection_difference bigint;
  effect_policy_base bigint;
  effect_contract_amount bigint;
  effect_after_contract_amount bigint;
  effect_manual_adjustment bigint;
  before_arrival date;
  before_departure date;
  after_arrival date;
  after_departure date;
  business_date date;
  first_unit_id text;
  last_unit_id text;
  tail_unit_id text;
  tail_arrival date;
  before_timeline jsonb;
  after_timeline jsonb;
  expected_timeline jsonb;
  historical_timeline jsonb;
  expected_preserved_claim_dates jsonb;
  expected_released_claim_dates jsonb;
  expected_added_claim_dates jsonb;
  active_claim_timeline jsonb;
  active_coverage jsonb;
  expected_preserved_coverage_dates jsonb;
  expected_added_coverage_dates jsonb;
  expected_released_coverage_dates jsonb;
  expected_consumed_coverage_dates jsonb;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id INTO execution_type, execution_state, execution_property_id
    FROM command_executions WHERE id = target_command_id;
  IF execution_type NOT IN ('RESCHEDULE_STAY', 'EXTEND_STAY') THEN RETURN; END IF;

  SELECT count(*)::integer INTO command_amendment_count
    FROM amendments WHERE command_id = target_command_id;
  SELECT count(*)::integer INTO change_count
    FROM amendments WHERE command_id = target_command_id AND amendment_type = execution_type;
  IF command_amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN RETURN; END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED'
    OR command_amendment_count <> 1
    OR change_count <> 1 THEN
    RAISE EXCEPTION 'complete stay date change facts require one matching amendment and an applied execution'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_execution_complete';
  END IF;

  SELECT * INTO STRICT change_amendment
    FROM amendments WHERE command_id = target_command_id AND amendment_type = execution_type;
  IF jsonb_typeof(change_amendment.payload #> '{before,stayTimeline}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{after,stayTimeline}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{inventoryChange,preservedDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{inventoryChange,releasedDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{inventoryChange,addedDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{entitlementChange,preservedCoverageDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{entitlementChange,releasedCoverageDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{entitlementChange,addedCoverageDates}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(change_amendment.payload #> '{entitlementChange,consumedCoverageDates}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'stay date change requires complete typed timeline and diff arrays'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_typed_payload';
  END IF;

  BEGIN
    before_arrival := (change_amendment.payload #>> '{before,arrivalDate}')::date;
    before_departure := (change_amendment.payload #>> '{before,departureDate}')::date;
    after_arrival := (change_amendment.payload #>> '{after,arrivalDate}')::date;
    after_departure := (change_amendment.payload #>> '{after,departureDate}')::date;
    effect_policy_base := (change_amendment.payload #>> '{pricingDecision,policyBaseAmount,minorUnits}')::bigint;
    effect_contract_amount := (change_amendment.payload #>> '{pricingDecision,targetCurrentContractAmount,minorUnits}')::bigint;
    effect_after_contract_amount := (change_amendment.payload #>> '{after,pricing,currentContractAmount,minorUnits}')::bigint;
    effect_manual_adjustment := (change_amendment.payload #>> '{pricingDecision,manualAdjustmentMinor}')::bigint;
    effect_net_collection := (change_amendment.payload #>> '{fundsSummary,netRecordedCollection,minorUnits}')::bigint;
    effect_collection_difference := (change_amendment.payload #>> '{fundsSummary,collectionDifference,minorUnits}')::bigint;
    PERFORM (item.value ->> 'serviceDate')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{before,stayTimeline}') AS item(value);
    PERFORM (item.value ->> 'serviceDate')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{inventoryChange,preservedDates}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{inventoryChange,releasedDates}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{inventoryChange,addedDates}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{entitlementChange,preservedCoverageDates}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{entitlementChange,releasedCoverageDates}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{entitlementChange,addedCoverageDates}') AS item(value);
    PERFORM (item.value #>> '{}')::date
      FROM jsonb_array_elements(change_amendment.payload #> '{entitlementChange,consumedCoverageDates}') AS item(value);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'stay date change payload contains an untyped date or money value'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_typed_payload';
  END;

  IF change_amendment.order_id IS DISTINCT FROM change_amendment.payload ->> 'orderId'
    OR change_amendment.sequence IS DISTINCT FROM change_amendment.new_version
    OR change_amendment.new_version IS DISTINCT FROM change_amendment.prior_version + 1
    OR btrim(change_amendment.reason_note) = ''
    OR change_amendment.payload ->> 'operation' IS DISTINCT FROM execution_type
    OR before_arrival >= before_departure
    OR after_arrival >= after_departure
    OR (execution_type = 'RESCHEDULE_STAY' AND after_arrival = before_arrival AND after_departure = before_departure)
    OR (execution_type = 'EXTEND_STAY' AND (after_arrival IS DISTINCT FROM before_arrival OR after_departure <= before_departure))
    OR effect_contract_amount IS DISTINCT FROM effect_after_contract_amount
    OR effect_collection_difference IS DISTINCT FROM effect_contract_amount - effect_net_collection
    OR effect_contract_amount < 0 OR effect_contract_amount > 2147483600
    OR effect_policy_base < 0 OR effect_policy_base > 2147483600 THEN
    RAISE EXCEPTION 'stay date change amendment shape is incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_amendment_shape';
  END IF;

  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', item.value ->> 'serviceDate', 'inventoryUnitId', item.value ->> 'inventoryUnitId')
      ORDER BY item.ordinality), '[]'::jsonb)
    INTO before_count, before_timeline
    FROM jsonb_array_elements(change_amendment.payload #> '{before,stayTimeline}')
      WITH ORDINALITY AS item(value, ordinality);
  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', item.value ->> 'serviceDate', 'inventoryUnitId', item.value ->> 'inventoryUnitId')
      ORDER BY item.ordinality), '[]'::jsonb)
    INTO after_count, after_timeline
    FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}')
      WITH ORDINALITY AS item(value, ordinality);
  IF before_count <> before_departure - before_arrival
    OR after_count <> after_departure - after_arrival
    OR EXISTS (SELECT 1
      FROM jsonb_array_elements(change_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS item(value, ordinality)
      WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
        OR item.value IS DISTINCT FROM jsonb_build_object(
          'serviceDate', item.value ->> 'serviceDate', 'inventoryUnitId', item.value ->> 'inventoryUnitId')
        OR (item.value ->> 'serviceDate')::date IS DISTINCT FROM before_arrival + (item.ordinality::integer - 1)
        OR btrim(COALESCE(item.value ->> 'inventoryUnitId', '')) = '')
    OR EXISTS (SELECT 1
      FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS item(value, ordinality)
      WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
        OR item.value IS DISTINCT FROM jsonb_build_object(
          'serviceDate', item.value ->> 'serviceDate', 'inventoryUnitId', item.value ->> 'inventoryUnitId')
        OR (item.value ->> 'serviceDate')::date IS DISTINCT FROM after_arrival + (item.ordinality::integer - 1)
        OR btrim(COALESCE(item.value ->> 'inventoryUnitId', '')) = '') THEN
    RAISE EXCEPTION 'stay date change timelines must be complete typed intervals'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_timeline_shape';
  END IF;

  first_unit_id := before_timeline -> 0 ->> 'inventoryUnitId';
  last_unit_id := before_timeline -> (before_count - 1) ->> 'inventoryUnitId';
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', (after_arrival + series.day_offset)::text,
      'inventoryUnitId', CASE
        WHEN after_arrival - before_arrival = after_departure - before_departure
          THEN before_timeline -> series.day_offset ->> 'inventoryUnitId'
        WHEN after_arrival + series.day_offset < before_arrival THEN first_unit_id
        WHEN after_arrival + series.day_offset >= before_departure THEN last_unit_id
        ELSE before_timeline -> ((after_arrival + series.day_offset) - before_arrival) ->> 'inventoryUnitId'
      END
    ) ORDER BY series.day_offset), '[]'::jsonb)
    INTO expected_timeline
    FROM generate_series(0, after_count - 1) AS series(day_offset);
  IF after_timeline IS DISTINCT FROM expected_timeline THEN
    RAISE EXCEPTION 'stay date change after timeline does not satisfy Plan B'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_plan_b';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(prior.value ->> 'serviceDate') ORDER BY prior.ordinality), '[]'::jsonb)
    INTO expected_preserved_claim_dates
    FROM jsonb_array_elements(change_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS prior(value, ordinality)
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') AS next(value)
      WHERE next.value ->> 'serviceDate' = prior.value ->> 'serviceDate'
        AND next.value ->> 'inventoryUnitId' = prior.value ->> 'inventoryUnitId');
  SELECT COALESCE(jsonb_agg(to_jsonb(prior.value ->> 'serviceDate') ORDER BY prior.ordinality), '[]'::jsonb)
    INTO expected_released_claim_dates
    FROM jsonb_array_elements(change_amendment.payload #> '{before,stayTimeline}') WITH ORDINALITY AS prior(value, ordinality)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') AS next(value)
      WHERE next.value ->> 'serviceDate' = prior.value ->> 'serviceDate'
        AND next.value ->> 'inventoryUnitId' = prior.value ->> 'inventoryUnitId');
  SELECT COALESCE(jsonb_agg(to_jsonb(next.value ->> 'serviceDate') ORDER BY next.ordinality), '[]'::jsonb)
    INTO expected_added_claim_dates
    FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS next(value, ordinality)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{before,stayTimeline}') AS prior(value)
      WHERE prior.value ->> 'serviceDate' = next.value ->> 'serviceDate'
        AND prior.value ->> 'inventoryUnitId' = next.value ->> 'inventoryUnitId');
  IF change_amendment.payload #> '{inventoryChange,preservedDates}' IS DISTINCT FROM expected_preserved_claim_dates
    OR change_amendment.payload #> '{inventoryChange,releasedDates}' IS DISTINCT FROM expected_released_claim_dates
    OR change_amendment.payload #> '{inventoryChange,addedDates}' IS DISTINCT FROM expected_added_claim_dates THEN
    RAISE EXCEPTION 'stay date change Claim diff does not exactly partition timeline pairs'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_claim_partition';
  END IF;

  SELECT * INTO STRICT target_order FROM orders WHERE id = change_amendment.order_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  IF change_amendment.sequence IS DISTINCT FROM (SELECT max(sequence) FROM amendments WHERE order_id = target_order.id)
    OR NOT EXISTS (
      SELECT 1 FROM amendments AS prior
      WHERE prior.order_id = target_order.id
        AND prior.sequence = change_amendment.prior_version
        AND prior.new_version = change_amendment.prior_version
        AND prior.sequence = (SELECT max(previous.sequence) FROM amendments AS previous
          WHERE previous.order_id = target_order.id AND previous.sequence < change_amendment.sequence)
    ) THEN
    RAISE EXCEPTION 'stay date change amendment must extend the unique latest aggregate chain'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_order_command_chain';
  END IF;
  business_date := qintopia_stage10_property_today(target_order.property_id);
  IF execution_property_id IS DISTINCT FROM target_order.property_id
    OR (execution_type = 'RESCHEDULE_STAY' AND (target_order.status <> 'RESERVED' OR target_stay.status <> 'PLANNED' OR after_arrival < business_date))
    OR (execution_type = 'EXTEND_STAY' AND (target_order.status <> 'CHECKED_IN' OR target_stay.status <> 'IN_HOUSE')) THEN
    RAISE EXCEPTION 'stay date change does not satisfy the final state and business-date matrix'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_state_matrix';
  END IF;

  SELECT count(*)::integer INTO segment_count FROM stay_segments WHERE amendment_id = change_amendment.id;
  SELECT count(*)::integer INTO revision_count FROM pricing_revisions WHERE amendment_id = change_amendment.id;
  IF segment_count <> 1 OR revision_count <> 1 THEN
    RAISE EXCEPTION 'stay date change requires exactly one segment and one pricing revision'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_segment_revision_complete';
  END IF;
  SELECT * INTO STRICT target_segment FROM stay_segments WHERE amendment_id = change_amendment.id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE amendment_id = change_amendment.id;

  WITH ranked_historical_claims AS (
    SELECT claim.service_date, claim.inventory_unit_id,
      row_number() OVER (PARTITION BY claim.service_date
        ORDER BY segment.sequence DESC, claim.created_at DESC, claim.id DESC) AS claim_rank
    FROM inventory_claims AS claim
    JOIN stay_segments AS segment ON segment.id = claim.source_id
    WHERE claim.source_type = 'ORDER_SEGMENT'
      AND segment.stay_id = target_stay.id
      AND segment.sequence < target_segment.sequence
      AND claim.service_date >= before_arrival AND claim.service_date < before_departure
  )
  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', service_date::text, 'inventoryUnitId', inventory_unit_id)
      ORDER BY service_date), '[]'::jsonb)
    INTO historical_count, historical_timeline
    FROM ranked_historical_claims WHERE claim_rank = 1;
  IF historical_count <> before_count OR historical_timeline IS DISTINCT FROM before_timeline THEN
    RAISE EXCEPTION 'stay date change before timeline does not match historical Claims'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_before_claims';
  END IF;

  tail_unit_id := after_timeline -> (after_count - 1) ->> 'inventoryUnitId';
  SELECT min((item.value ->> 'serviceDate')::date) INTO tail_arrival
    FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS item(value, ordinality)
    WHERE item.ordinality > COALESCE((SELECT max(prior.ordinality)
      FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') WITH ORDINALITY AS prior(value, ordinality)
      WHERE prior.value ->> 'inventoryUnitId' IS DISTINCT FROM tail_unit_id), 0);
  IF target_segment.stay_id IS DISTINCT FROM target_stay.id
    OR target_segment.segment_type IS DISTINCT FROM execution_type
    OR target_segment.inventory_unit_id IS DISTINCT FROM tail_unit_id
    OR target_segment.arrival_date IS DISTINCT FROM tail_arrival
    OR target_segment.departure_date IS DISTINCT FROM after_departure
    OR target_segment.supersedes_segment_id IS NULL
    OR target_segment.sequence IS DISTINCT FROM (SELECT max(sequence) FROM stay_segments WHERE stay_id = target_stay.id)
    OR NOT EXISTS (SELECT 1 FROM stay_segments AS prior
      WHERE prior.id = target_segment.supersedes_segment_id
        AND prior.stay_id = target_stay.id AND prior.sequence = target_segment.sequence - 1)
    OR target_revision.order_id IS DISTINCT FROM target_order.id
    OR target_revision.revision_no IS DISTINCT FROM (SELECT max(revision_no) FROM pricing_revisions WHERE order_id = target_order.id)
    OR target_revision.arrival_date IS DISTINCT FROM after_arrival
    OR target_revision.departure_date IS DISTINCT FROM after_departure
    OR target_revision.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id
    OR target_revision.policy_base_amount_minor::bigint IS DISTINCT FROM effect_policy_base
    OR target_revision.current_contract_amount_minor::bigint IS DISTINCT FROM effect_contract_amount
    OR target_revision.manual_adjustment_minor::bigint IS DISTINCT FROM effect_manual_adjustment
    OR target_revision.pricing_basis IS DISTINCT FROM change_amendment.payload #>> '{pricingDecision,pricingBasis}'
    OR target_revision.currency IS DISTINCT FROM change_amendment.payload #>> '{pricingDecision,targetCurrentContractAmount,currency}'
    OR target_revision.currency IS DISTINCT FROM change_amendment.payload #>> '{fundsSummary,netRecordedCollection,currency}'
    OR target_revision.currency IS DISTINCT FROM change_amendment.payload #>> '{fundsSummary,collectionDifference,currency}'
    OR target_revision.coverage_set IS DISTINCT FROM change_amendment.payload #> '{after,pricing,coverageSet}'
    OR target_revision.cash_lines IS DISTINCT FROM change_amendment.payload #> '{after,pricing,cashLines}'
    OR target_order.arrival_date IS DISTINCT FROM after_arrival
    OR target_order.departure_date IS DISTINCT FROM after_departure
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id
    OR target_order.version IS DISTINCT FROM change_amendment.new_version
    OR NOT EXISTS (SELECT 1 FROM pricing_revisions AS prior
      WHERE prior.order_id = target_order.id AND prior.revision_no = target_revision.revision_no - 1
        AND prior.arrival_date = before_arrival AND prior.departure_date = before_departure) THEN
    RAISE EXCEPTION 'stay date change current segment, revision, or order pointers are incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_current_projection';
  END IF;

  SELECT count(*)::integer, COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', claim.service_date::text, 'inventoryUnitId', claim.inventory_unit_id)
      ORDER BY claim.service_date, claim.id), '[]'::jsonb)
    INTO active_claim_count, active_claim_timeline
    FROM inventory_claims AS claim
    WHERE claim.source_type = 'ORDER_SEGMENT' AND claim.active
      AND claim.source_id IN (SELECT id FROM stay_segments WHERE stay_id = target_stay.id);
  IF active_claim_count <> after_count OR active_claim_timeline IS DISTINCT FROM after_timeline
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{inventoryChange,preservedDates}') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_claims AS claim JOIN stay_segments AS segment ON segment.id = claim.source_id
        WHERE claim.source_type = 'ORDER_SEGMENT' AND claim.active AND segment.stay_id = target_stay.id
          AND segment.sequence < target_segment.sequence AND claim.service_date::text = item.value #>> '{}'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{inventoryChange,releasedDates}') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_claims AS claim JOIN stay_segments AS segment ON segment.id = claim.source_id
        WHERE claim.source_type = 'ORDER_SEGMENT' AND NOT claim.active AND segment.stay_id = target_stay.id
          AND segment.sequence < target_segment.sequence AND claim.service_date::text = item.value #>> '{}'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{inventoryChange,addedDates}') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM inventory_claims AS claim
        WHERE claim.source_type = 'ORDER_SEGMENT' AND claim.active AND claim.source_id = target_segment.id
          AND claim.service_date::text = item.value #>> '{}')) THEN
    RAISE EXCEPTION 'stay date change active and historical Claims do not match the frozen diff'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_claim_binding';
  END IF;

  SELECT COALESCE(sum(net_effect_minor), 0)::bigint INTO actual_net_collection
    FROM collection_facts WHERE order_id = target_order.id;
  IF actual_net_collection IS DISTINCT FROM effect_net_collection
    OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id) THEN
    RAISE EXCEPTION 'stay date change funds summary must be frozen and collection-write free'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_frozen_funds';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'serviceDate', coverage.service_date::text,
      'inventoryUnitId', coverage.inventory_unit_id,
      'unitKind', coverage.unit_kind,
      'entitlementLotId', coverage.lot_id) ORDER BY coverage.service_date), '[]'::jsonb)
    INTO active_coverage FROM coverage_items AS coverage
    WHERE coverage.order_id = target_order.id AND coverage.status IN ('HELD', 'CONSUMED');
  SELECT COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text) ORDER BY coverage.service_date), '[]'::jsonb)
    INTO expected_preserved_coverage_dates FROM coverage_items AS coverage
    WHERE coverage.order_id = target_order.id AND coverage.status IN ('HELD', 'CONSUMED')
      AND coverage.held_by_revision_id <> target_revision.id;
  SELECT COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text) ORDER BY coverage.service_date), '[]'::jsonb)
    INTO expected_added_coverage_dates FROM coverage_items AS coverage
    WHERE coverage.order_id = target_order.id AND coverage.status IN ('HELD', 'CONSUMED')
      AND coverage.held_by_revision_id = target_revision.id;
  SELECT COALESCE(jsonb_agg(to_jsonb(ledger.service_date::text) ORDER BY ledger.service_date), '[]'::jsonb)
    INTO expected_released_coverage_dates FROM entitlement_ledger AS ledger
    WHERE ledger.command_id = target_command_id AND ledger.entry_type = 'RELEASE';
  SELECT COALESCE(jsonb_agg(to_jsonb(ledger.service_date::text) ORDER BY ledger.service_date), '[]'::jsonb)
    INTO expected_consumed_coverage_dates FROM entitlement_ledger AS ledger
    WHERE ledger.command_id = target_command_id AND ledger.entry_type = 'CONSUME';
  SELECT count(*)::integer,
      count(*) FILTER (WHERE entry_type = 'RELEASE')::integer,
      count(*) FILTER (WHERE entry_type = 'HOLD')::integer,
      count(*) FILTER (WHERE entry_type = 'CONSUME')::integer,
      count(*) FILTER (WHERE entry_type = 'EXPIRE')::integer
    INTO ledger_count, release_ledger_count, hold_ledger_count, consume_ledger_count, expire_ledger_count
    FROM entitlement_ledger WHERE command_id = target_command_id;

  IF target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN
    IF target_revision.coverage_set IS DISTINCT FROM active_coverage
      OR change_amendment.payload #> '{entitlementChange,preservedCoverageDates}' IS DISTINCT FROM expected_preserved_coverage_dates
      OR change_amendment.payload #> '{entitlementChange,releasedCoverageDates}' IS DISTINCT FROM expected_released_coverage_dates
      OR change_amendment.payload #> '{entitlementChange,addedCoverageDates}' IS DISTINCT FROM expected_added_coverage_dates
      OR change_amendment.payload #> '{entitlementChange,consumedCoverageDates}' IS DISTINCT FROM expected_consumed_coverage_dates
      OR release_ledger_count <> jsonb_array_length(expected_released_coverage_dates)
      OR hold_ledger_count <> jsonb_array_length(expected_added_coverage_dates)
      OR consume_ledger_count <> jsonb_array_length(expected_consumed_coverage_dates)
      OR ledger_count <> release_ledger_count + hold_ledger_count + consume_ledger_count + expire_ledger_count
      OR (execution_type = 'EXTEND_STAY'
        AND expected_consumed_coverage_dates IS DISTINCT FROM expected_added_coverage_dates)
      OR EXISTS (SELECT 1 FROM entitlement_ledger AS ledger
        WHERE ledger.command_id = target_command_id
        GROUP BY ledger.entry_type, ledger.coverage_id HAVING count(*) <> 1)
      OR (execution_type = 'RESCHEDULE_STAY' AND EXISTS (SELECT 1 FROM coverage_items
        WHERE order_id = target_order.id AND status = 'CONSUMED'))
      OR (execution_type = 'EXTEND_STAY' AND EXISTS (SELECT 1 FROM coverage_items
        WHERE order_id = target_order.id AND status = 'HELD'))
      OR EXISTS (SELECT 1 FROM coverage_items AS coverage JOIN inventory_units AS unit ON unit.id = coverage.inventory_unit_id
        WHERE coverage.order_id = target_order.id AND coverage.status IN ('HELD', 'CONSUMED')
          AND (coverage.unit_kind <> CASE unit.kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END
            OR (coverage.status = 'HELD' AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') AS item(value)
              WHERE item.value ->> 'serviceDate' = coverage.service_date::text
                AND item.value ->> 'inventoryUnitId' = coverage.inventory_unit_id))
            OR (coverage.status = 'CONSUMED' AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(change_amendment.payload #> '{after,stayTimeline}') AS item(value)
              JOIN inventory_units AS timeline_unit ON timeline_unit.id = item.value ->> 'inventoryUnitId'
              WHERE item.value ->> 'serviceDate' = coverage.service_date::text
                AND timeline_unit.kind = unit.kind
                AND timeline_unit.room_type_code IS NOT DISTINCT FROM unit.room_type_code))))
      OR EXISTS (SELECT 1 FROM entitlement_ledger AS ledger
        LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
        WHERE ledger.command_id = target_command_id AND (
          ledger.entry_type NOT IN ('RELEASE', 'HOLD', 'CONSUME', 'EXPIRE')
          OR ledger.order_id IS DISTINCT FROM target_order.id
          OR coverage.order_id IS DISTINCT FROM target_order.id
          OR coverage.service_date IS DISTINCT FROM ledger.service_date
          OR coverage.lot_id IS DISTINCT FROM ledger.lot_id
          OR (ledger.entry_type = 'RELEASE' AND (ledger.quantity_delta <> 1 OR coverage.status <> 'RELEASED'
            OR ledger.reason <> 'ORDER_COVERAGE_RELEASE'))
          OR (ledger.entry_type = 'HOLD' AND (ledger.quantity_delta <> -1 OR coverage.held_by_revision_id <> target_revision.id
            OR ledger.reason <> 'ORDER_COVERAGE_HOLD'))
          OR (ledger.entry_type = 'CONSUME' AND (ledger.quantity_delta <> 0 OR coverage.status <> 'CONSUMED'
            OR execution_type <> 'EXTEND_STAY' OR coverage.held_by_revision_id <> target_revision.id
            OR ledger.reason <> 'EXTEND_STAY_ENTITLEMENT_CONSUMED'))
          OR (ledger.entry_type = 'EXPIRE' AND (ledger.quantity_delta <> -1 OR coverage.status <> 'RELEASED'
            OR ledger.reason <> 'RELEASE_AFTER_EXPIRY'
            OR NOT EXISTS (SELECT 1 FROM entitlement_ledger AS release
              WHERE release.command_id = target_command_id AND release.entry_type = 'RELEASE'
                AND release.coverage_id = ledger.coverage_id))))) THEN
      RAISE EXCEPTION 'member stay date change coverage and ledger facts do not match the frozen effect'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_member_coverage';
    END IF;
  ELSIF target_revision.coverage_set IS DISTINCT FROM '[]'::jsonb
    OR change_amendment.payload #> '{entitlementChange,preservedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR change_amendment.payload #> '{entitlementChange,releasedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR change_amendment.payload #> '{entitlementChange,addedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR change_amendment.payload #> '{entitlementChange,consumedCoverageDates}' IS DISTINCT FROM '[]'::jsonb
    OR ledger_count <> 0 THEN
    RAISE EXCEPTION 'non-member stay date change must not contain entitlement coverage or ledger facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_nonmember_coverage';
  END IF;
  PERFORM qintopia_assert_stage11_protocol_evidence(target_command_id, change_amendment.id);
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage11_move_combination() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE execution_type text;
BEGIN
  IF NEW.amendment_type IN ('RESCHEDULE_STAY', 'EXTEND_STAY') THEN
    SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;
    IF NEW.command_id IS NULL OR execution_type IS DISTINCT FROM NEW.amendment_type THEN
      RAISE EXCEPTION 'stay date change amendment requires a matching command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'stage11_date_change_command_binding';
    END IF;
  END IF;
  PERFORM qintopia_assert_stage11_move_combination(NEW.command_id);
  PERFORM qintopia_assert_stage11_date_change_combination(NEW.command_id);
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER amendments_stage11_validate_move_combination
AFTER INSERT ON amendments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_move_combination();

CREATE OR REPLACE FUNCTION qintopia_validate_stage11_move_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM qintopia_assert_stage11_move_combination(NEW.id);
  PERFORM qintopia_assert_stage11_date_change_combination(NEW.id);
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER command_executions_stage11_validate_move_combination
AFTER INSERT OR UPDATE OF state ON command_executions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage11_move_execution();
