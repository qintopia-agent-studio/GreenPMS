LOCK TABLE command_catalog, staff_command_profile_catalog, subject_command_grants,
  orders, stays, amendments, stay_segments, pricing_revisions, inventory_claims,
  coverage_items, entitlement_ledger IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO command_catalog(command_type, command_class) VALUES ('REVOKE_CHECK_OUT', 'HUMAN_COMMAND');
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
  WHERE conrelid = 'subject_command_grants'::regclass AND conname = 'subject_command_grants_human_exact_check';
  IF position('''CHECK_OUT''::text, ''COMPLETE_STAY''::text' IN definition) = 0 THEN
    RAISE EXCEPTION 'checkout reversal migration cannot locate the command grant constraint';
  END IF;
  definition := replace(definition, '''CHECK_OUT''::text, ''COMPLETE_STAY''::text',
    '''CHECK_OUT''::text, ''REVOKE_CHECK_OUT''::text, ''COMPLETE_STAY''::text');
  ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
  EXECUTE 'ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check ' || definition;
END $$;

INSERT INTO staff_command_profile_catalog(profile, command_type, token_default)
VALUES ('ADMIN', 'REVOKE_CHECK_OUT', true);
INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT subject_id, property_id, 'REVOKE_CHECK_OUT' FROM staff_profile_assignments WHERE profile = 'ADMIN';
UPDATE staff_profile_reconciliation_state SET projection_hash = (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value, E'\n' ORDER BY row_value), ''), 'UTF8')), 'hex')
  FROM (
    SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value FROM staff_profile_assignments
    UNION ALL SELECT format('G|%s|%s|%s', subject_id, property_id, command_type) FROM subject_command_grants
  ) AS projection
), reconciled_by = current_user, reconciled_at = now() WHERE singleton;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure) INTO definition;
  IF position('(NEW.status = ''IN_HOUSE'' AND amendment.amendment_type = ''CHECK_IN'')' IN definition) = 0
    OR position('source_stay_status = ''PLANNED''' IN definition) = 0 THEN
    RAISE EXCEPTION 'checkout reversal migration cannot locate stay transition guards';
  END IF;
  definition := replace(definition,
    '(NEW.status = ''IN_HOUSE'' AND amendment.amendment_type = ''CHECK_IN'')',
    '(NEW.status = ''IN_HOUSE'' AND amendment.amendment_type IN (''CHECK_IN'', ''REVOKE_CHECK_OUT''))');
  definition := replace(definition, '(source_stay_status = ''PLANNED''',
    '(source_stay_status = ''COMPLETED'' AND target_stay_status = ''IN_HOUSE'' AND target_command_type = ''REVOKE_CHECK_OUT'') OR (source_stay_status = ''PLANNED''');
  definition := replace(definition, '''CHECK_IN'', ''CHECK_OUT'', ''COMPLETE_STAY''',
    '''CHECK_IN'', ''CHECK_OUT'', ''REVOKE_CHECK_OUT'', ''COMPLETE_STAY''');
  EXECUTE definition;
END $$;

CREATE UNIQUE INDEX amendments_one_reversal_per_checkout
ON amendments ((payload ->> 'checkoutAmendmentId')) WHERE amendment_type = 'REVOKE_CHECK_OUT';

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_validate_inventory_claim_source()'::regprocedure) INTO definition;
  IF position('source_segment_type = ''RESCHEDULE_STAY''' IN definition) = 0 THEN
    RAISE EXCEPTION 'checkout reversal migration cannot locate full timeline claim guard';
  END IF;
  definition := replace(definition, 'source_segment_type = ''RESCHEDULE_STAY''',
    'source_segment_type IN (''RESCHEDULE_STAY'', ''REVOKE_CHECK_OUT'')');
  definition := replace(definition, 'source_amendment_type = ''RESCHEDULE_STAY''', 'source_amendment_type = source_segment_type');
  definition := replace(definition, 'source_amendment_type <> ''RESCHEDULE_STAY''', 'source_amendment_type <> source_segment_type');
  EXECUTE definition;
END $$;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_assert_stage13_stay_conversion_command_v033(text)'::regprocedure) INTO definition;
  IF position('''CHECK_OUT'',' IN definition) = 0 THEN
    RAISE EXCEPTION 'checkout reversal migration cannot locate converted stay lifecycle allowlist';
  END IF;
  EXECUTE replace(definition, '''CHECK_OUT'',', '''CHECK_OUT'', ''REVOKE_CHECK_OUT'',');
END $$;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_membership_projection_update_050()'::regprocedure) INTO definition;
  IF position('''CHECK_IN'', ''COMPLETE_STAY'', ''CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP''' IN definition) = 0 THEN
    RAISE EXCEPTION 'checkout reversal migration cannot locate entitlement version allowlist';
  END IF;
  EXECUTE replace(definition, '''CHECK_IN'', ''COMPLETE_STAY'', ''CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP''',
    '''CHECK_IN'', ''REVOKE_CHECK_OUT'', ''COMPLETE_STAY'', ''CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP''');
END $$;

CREATE FUNCTION qintopia_assert_checkout_reversal(target_command_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  execution command_executions%ROWTYPE;
  reversal amendments%ROWTYPE;
  checkout amendments%ROWTYPE;
  shortening amendments%ROWTYPE;
  source_revision pricing_revisions%ROWTYPE;
  restored_revision pricing_revisions%ROWTYPE;
  source_segment stay_segments%ROWTYPE;
  source_action amendments%ROWTYPE;
  restored_segment stay_segments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_timeline jsonb;
  source_sequence integer;
  last_unit text;
  prior_revision pricing_revisions%ROWTYPE;
  prior_segment stay_segments%ROWTYPE;
  original_coverage jsonb;
  net_collection bigint;
BEGIN
  SELECT * INTO execution FROM command_executions WHERE id = target_command_id;
  IF execution.command_type IS DISTINCT FROM 'REVOKE_CHECK_OUT' THEN
    IF EXISTS (SELECT 1 FROM amendments WHERE command_id = target_command_id AND amendment_type = 'REVOKE_CHECK_OUT') THEN
      RAISE EXCEPTION 'checkout reversal amendment requires its typed command' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO reversal FROM amendments WHERE command_id = target_command_id AND amendment_type = 'REVOKE_CHECK_OUT';
  IF reversal.id IS NULL AND execution.state IS DISTINCT FROM 'APPLIED' THEN RETURN; END IF;
  IF reversal.id IS NULL OR execution.state IS DISTINCT FROM 'APPLIED'
    OR (SELECT count(*) FROM amendments WHERE command_id = target_command_id) <> 1
    OR NOT EXISTS (SELECT 1 FROM staff_profile_assignments AS profile
      JOIN subjects AS subject ON subject.id = profile.subject_id AND subject.status = 'ACTIVE'
      JOIN subject_command_grants AS permission ON permission.subject_id = profile.subject_id
        AND permission.property_id = profile.property_id AND permission.command_type = 'REVOKE_CHECK_OUT'
      WHERE profile.subject_id = execution.subject_id AND profile.property_id = execution.property_id AND profile.profile = 'ADMIN')
    OR btrim(reversal.reason_note) = ''
    OR reversal.payload ->> 'operation' IS DISTINCT FROM 'REVOKE_CHECK_OUT'
    OR reversal.payload ->> 'orderId' IS DISTINCT FROM reversal.order_id
    OR reversal.payload ->> 'fromStatus' IS DISTINCT FROM 'CHECKED_OUT'
    OR reversal.payload ->> 'toStatus' IS DISTINCT FROM 'CHECKED_IN' THEN
    RAISE EXCEPTION 'checkout reversal requires one applied administrator command and a reason'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_authority';
  END IF;
  SELECT * INTO target_order FROM orders WHERE id = reversal.order_id;
  SELECT * INTO target_stay FROM stays WHERE order_id = target_order.id;
  SELECT * INTO checkout FROM amendments WHERE id = reversal.payload ->> 'checkoutAmendmentId';
  IF checkout.id IS NULL OR checkout.order_id IS DISTINCT FROM target_order.id
    OR checkout.amendment_type IS DISTINCT FROM 'CHECK_OUT'
    OR checkout.sequence::text IS DISTINCT FROM reversal.payload ->> 'checkoutSequence'
    OR checkout.sequence >= reversal.sequence
    OR EXISTS (SELECT 1 FROM amendments WHERE order_id = target_order.id
      AND sequence > checkout.sequence AND sequence < reversal.sequence AND amendment_type <> 'CORRECT_ORDER_OCCUPANT') THEN
    RAISE EXCEPTION 'checkout reversal must reference the current effective checkout'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_source';
  END IF;
  SELECT * INTO shortening FROM amendments WHERE order_id = target_order.id
    AND sequence = checkout.sequence - 1 AND command_id = checkout.command_id AND amendment_type = 'SHORTEN_STAY';
  source_sequence := CASE WHEN shortening.id IS NULL THEN checkout.sequence ELSE shortening.sequence END;
  SELECT revision.* INTO source_revision FROM pricing_revisions AS revision
  JOIN amendments AS action ON action.id = revision.amendment_id
  WHERE revision.order_id = target_order.id AND action.sequence < source_sequence ORDER BY revision.revision_no DESC LIMIT 1;
  SELECT * INTO restored_revision FROM pricing_revisions WHERE amendment_id = reversal.id;
  SELECT * INTO restored_segment FROM stay_segments WHERE amendment_id = reversal.id;
  SELECT revision.* INTO prior_revision FROM pricing_revisions AS revision
    JOIN amendments AS action ON action.id = revision.amendment_id
    WHERE revision.order_id = target_order.id AND action.sequence < reversal.sequence ORDER BY revision.revision_no DESC LIMIT 1;
  SELECT * INTO prior_segment FROM stay_segments WHERE stay_id = target_stay.id
    AND sequence < restored_segment.sequence ORDER BY sequence DESC LIMIT 1;
  SELECT segment.* INTO source_segment FROM stay_segments AS segment
  JOIN amendments AS action ON action.id = segment.amendment_id
  WHERE segment.stay_id = target_stay.id AND action.sequence < source_sequence ORDER BY segment.sequence DESC LIMIT 1;
  SELECT * INTO source_action FROM amendments WHERE id = source_segment.amendment_id;
  IF source_segment.segment_type = 'INITIAL' THEN
    SELECT jsonb_agg(jsonb_build_object('serviceDate', day::date::text, 'inventoryUnitId', source_segment.inventory_unit_id) ORDER BY day)
    INTO target_timeline FROM generate_series(source_segment.arrival_date::timestamp,
      (source_segment.departure_date - 1)::timestamp, interval '1 day') AS day;
  ELSE
    target_timeline := COALESCE(source_action.payload #> '{after,stayTimeline}', source_action.payload -> 'stayTimeline');
  END IF;
  last_unit := target_timeline -> -1 ->> 'inventoryUnitId';
  IF source_revision.id IS NULL OR source_revision.id IS DISTINCT FROM reversal.payload ->> 'sourceRevisionId'
    OR restored_revision.id IS NULL OR restored_segment.id IS NULL OR target_timeline IS NULL
    OR jsonb_array_length(target_timeline) <> source_revision.departure_date - source_revision.arrival_date
    OR reversal.payload #> '{after,stayTimeline}' IS DISTINCT FROM target_timeline
    OR reversal.payload ->> 'mode' IS DISTINCT FROM (CASE WHEN shortening.id IS NULL THEN 'UNDO_CHECK_OUT' ELSE 'UNDO_EARLY_CHECK_OUT' END)
    OR (to_jsonb(restored_revision) - ARRAY['id','revision_no','amendment_id','created_at'])
      IS DISTINCT FROM (to_jsonb(source_revision) - ARRAY['id','revision_no','amendment_id','created_at'])
    OR restored_segment.segment_type IS DISTINCT FROM 'REVOKE_CHECK_OUT'
    OR restored_segment.stay_id IS DISTINCT FROM target_stay.id
    OR restored_segment.sequence IS DISTINCT FROM prior_segment.sequence + 1
    OR restored_segment.supersedes_segment_id IS DISTINCT FROM prior_segment.id
    OR restored_revision.revision_no IS DISTINCT FROM prior_revision.revision_no + 1
    OR reversal.new_version IS DISTINCT FROM reversal.prior_version + 1
    OR reversal.sequence IS DISTINCT FROM reversal.new_version
    OR restored_segment.inventory_unit_id IS DISTINCT FROM last_unit
    OR restored_segment.arrival_date IS DISTINCT FROM (
      SELECT min((item ->> 'serviceDate')::date) FROM jsonb_array_elements(target_timeline) AS item
      WHERE item ->> 'inventoryUnitId' = last_unit AND (item ->> 'serviceDate')::date > COALESCE((
        SELECT max((other ->> 'serviceDate')::date) FROM jsonb_array_elements(target_timeline) AS other
        WHERE other ->> 'inventoryUnitId' <> last_unit), source_revision.arrival_date - 1))
    OR restored_segment.departure_date IS DISTINCT FROM source_revision.departure_date
    OR target_order.property_id IS DISTINCT FROM execution.property_id
    OR target_order.status IS DISTINCT FROM 'CHECKED_IN' OR target_stay.status IS DISTINCT FROM 'IN_HOUSE'
    OR target_order.version IS DISTINCT FROM reversal.new_version
    OR target_order.current_revision_id IS DISTINCT FROM restored_revision.id
    OR target_order.arrival_date IS DISTINCT FROM source_revision.arrival_date
    OR target_order.departure_date IS DISTINCT FROM source_revision.departure_date
    OR reversal.payload -> 'before' IS DISTINCT FROM jsonb_build_object(
      'arrivalDate', prior_revision.arrival_date::text, 'departureDate', prior_revision.departure_date::text,
      'currentContractAmount', jsonb_build_object('currency', prior_revision.currency, 'minorUnits', prior_revision.current_contract_amount_minor))
    OR reversal.payload #>> '{after,arrivalDate}' IS DISTINCT FROM source_revision.arrival_date::text
    OR reversal.payload #>> '{after,departureDate}' IS DISTINCT FROM source_revision.departure_date::text
    OR reversal.payload #> '{after,currentContractAmount}' IS DISTINCT FROM jsonb_build_object(
      'currency', source_revision.currency, 'minorUnits', source_revision.current_contract_amount_minor)
    OR (SELECT count(*) FROM stay_segments WHERE amendment_id = reversal.id) <> 1
    OR (SELECT count(*) FROM pricing_revisions WHERE amendment_id = reversal.id) <> 1 THEN
    RAISE EXCEPTION 'checkout reversal must restore the complete original arrangement and pricing'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_snapshot';
  END IF;
  IF EXISTS (
    WITH checked_dates AS (
      SELECT (item ->> 'serviceDate')::date AS service_date, item ->> 'inventoryUnitId' AS unit_id
      FROM jsonb_array_elements(target_timeline) AS item
      UNION ALL SELECT day::date, last_unit FROM generate_series(source_revision.departure_date::timestamp,
        (reversal.payload ->> 'businessDate')::date::timestamp, interval '1 day') AS day
    )
    SELECT 1 FROM checked_dates AS checked JOIN inventory_units AS unit ON unit.id = checked.unit_id
    WHERE NOT unit.active OR EXISTS (
      SELECT 1 FROM inventory_claims AS claim WHERE claim.property_id = target_order.property_id AND claim.active
        AND claim.service_date = checked.service_date AND claim.room_id = COALESCE(unit.parent_room_id, unit.id)
        AND (unit.kind = 'ROOM' OR claim.inventory_unit_id IN (unit.id, unit.parent_room_id))
        AND NOT (claim.source_type = 'ORDER_SEGMENT' AND claim.source_id IN (SELECT id FROM stay_segments WHERE stay_id = target_stay.id))
    ) OR EXISTS (
      SELECT 1 FROM internal_use_blocks AS block WHERE block.property_id = target_order.property_id AND block.status = 'ACTIVE'
        AND block.room_id = COALESCE(unit.parent_room_id, unit.id)
        AND block.arrival_date <= checked.service_date AND block.departure_date > checked.service_date
        AND (unit.kind = 'ROOM' OR block.inventory_unit_id IN (unit.id, unit.parent_room_id))
    )
  ) THEN
    RAISE EXCEPTION 'checkout reversal conflicts with existing inventory' USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_inventory';
  END IF;
  SELECT COALESCE(sum(net_effect_minor), 0) INTO net_collection FROM collection_facts WHERE order_id = target_order.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('serviceDate', coverage.service_date::text,
    'inventoryUnitId', coverage.inventory_unit_id, 'entitlementLotId', coverage.lot_id,
    'unitKind', coverage.unit_kind) ORDER BY coverage.service_date), '[]'::jsonb)
  INTO original_coverage FROM coverage_items AS coverage WHERE coverage.id IN (
    SELECT ledger.coverage_id FROM entitlement_ledger AS ledger
    WHERE ledger.order_id = target_order.id AND ledger.coverage_id IS NOT NULL
      AND ledger.command_id IN (SELECT command_id FROM amendments WHERE order_id = target_order.id AND sequence < source_sequence)
    GROUP BY ledger.coverage_id HAVING sum(ledger.quantity_delta) = -1 AND bool_or(ledger.entry_type IN ('CONSUME','CONVERSION_CONSUME'))
  );
  IF (SELECT COALESCE(jsonb_agg(jsonb_build_object('serviceDate', service_date::text,
      'inventoryUnitId', inventory_unit_id, 'entitlementLotId', lot_id, 'unitKind', unit_kind)
      ORDER BY service_date), '[]'::jsonb) FROM coverage_items WHERE order_id = target_order.id AND status = 'CONSUMED')
      IS DISTINCT FROM original_coverage
    OR EXISTS (SELECT 1 FROM coverage_items WHERE order_id = target_order.id AND status = 'HELD')
    OR EXISTS (SELECT 1 FROM entitlement_ledger AS ledger
      JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
      JOIN entitlement_lots AS lot ON lot.id = ledger.lot_id
      JOIN member_contracts AS contract ON contract.id = lot.contract_id
      WHERE ledger.command_id = target_command_id AND (
        coverage.held_by_revision_id <> restored_revision.id OR coverage.status <> 'CONSUMED'
        OR lot.status <> 'ACTIVE' OR contract.status <> 'ACTIVE'
        OR contract.member_id IS DISTINCT FROM COALESCE(target_order.member_id,
          (SELECT member_id FROM member_contracts WHERE id = target_order.member_contract_id))
        OR lot.expires_on < (reversal.payload ->> 'businessDate')::date
        OR ledger.service_date < contract.valid_from OR ledger.service_date > contract.valid_until
        OR ledger.service_date > lot.expires_on
        OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE lot_id = lot.id AND entry_type IN ('EXPIRE','VOID'))
        OR (SELECT count(*) FROM entitlement_ledger WHERE command_id = target_command_id AND coverage_id = coverage.id) <> 2
        OR (SELECT sum(quantity_delta) FROM entitlement_ledger WHERE command_id = target_command_id AND coverage_id = coverage.id) <> -1
      ))
    OR reversal.payload -> 'fundsSummary' IS DISTINCT FROM jsonb_build_object(
      'netRecordedCollection', jsonb_build_object('currency', source_revision.currency, 'minorUnits', net_collection),
      'collectionDifference', jsonb_build_object('currency', source_revision.currency, 'minorUnits', source_revision.current_contract_amount_minor - net_collection),
      'refundReferenceAmount', jsonb_build_object('currency', source_revision.currency, 'minorUnits', greatest(0, net_collection - source_revision.current_contract_amount_minor))) THEN
    RAISE EXCEPTION 'checkout reversal must preserve original consumption and recorded money'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_coverage';
  END IF;
  IF (SELECT jsonb_agg(jsonb_build_object('serviceDate', claim.service_date::text, 'inventoryUnitId', claim.inventory_unit_id)
        ORDER BY claim.service_date) FROM inventory_claims AS claim
      JOIN stay_segments AS segment ON segment.id = claim.source_id
      WHERE segment.stay_id = target_stay.id AND claim.source_type = 'ORDER_SEGMENT' AND claim.active)
      IS DISTINCT FROM target_timeline
    OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id)
    OR EXISTS (SELECT 1 FROM membership_payment_facts WHERE command_id = target_command_id)
    OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE command_id = target_command_id
      AND (order_id IS DISTINCT FROM target_order.id OR entry_type NOT IN ('HOLD','CONSUME')
        OR (entry_type = 'CONSUME' AND reason <> 'REVOKE_CHECK_OUT_ENTITLEMENT_CONSUMED')))
    OR EXISTS (SELECT 1 FROM entitlement_lots AS lot WHERE lot.id IN (
      SELECT lot_id FROM entitlement_ledger WHERE command_id = target_command_id)
      AND lot.total_units + (SELECT COALESCE(sum(quantity_delta), 0) FROM entitlement_ledger WHERE lot_id = lot.id) < 0)
    OR (SELECT COALESCE(jsonb_agg(service_date::text ORDER BY service_date), '[]'::jsonb)
      FROM entitlement_ledger WHERE command_id = target_command_id AND entry_type = 'CONSUME')
      IS DISTINCT FROM reversal.payload -> 'entitlementReconsumeDates' THEN
    RAISE EXCEPTION 'checkout reversal inventory, entitlement or funds are inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_facts';
  END IF;
END $$;

CREATE FUNCTION qintopia_validate_checkout_reversal_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM qintopia_assert_checkout_reversal(CASE WHEN TG_TABLE_NAME = 'command_executions' THEN NEW.id ELSE to_jsonb(NEW) ->> 'command_id' END);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER command_executions_checkout_reversal
AFTER INSERT OR UPDATE ON command_executions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_checkout_reversal_execution();
CREATE CONSTRAINT TRIGGER amendments_checkout_reversal
AFTER INSERT ON amendments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.amendment_type = 'REVOKE_CHECK_OUT') EXECUTE FUNCTION qintopia_validate_checkout_reversal_execution();

CREATE FUNCTION qintopia_validate_checkout_reversal_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE command_id text;
BEGIN
  IF (TG_TABLE_NAME = 'orders' AND OLD.status = 'CHECKED_OUT' AND NEW.status <> OLD.status)
    OR (TG_TABLE_NAME = 'stays' AND OLD.status = 'COMPLETED' AND NEW.status <> OLD.status) THEN
    SELECT action.command_id INTO command_id FROM amendments AS action
    WHERE action.order_id = CASE WHEN TG_TABLE_NAME = 'orders' THEN NEW.id ELSE to_jsonb(NEW) ->> 'order_id' END
      AND action.amendment_type = 'REVOKE_CHECK_OUT'
      AND action.xmin = (pg_current_xact_id()::text)::xid
    ORDER BY action.sequence DESC LIMIT 1;
    IF command_id IS NULL THEN
      RAISE EXCEPTION 'reopening a completed stay requires a checkout reversal'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_reversal_transition';
    END IF;
    PERFORM qintopia_assert_checkout_reversal(command_id);
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER orders_checkout_reversal_transition AFTER UPDATE ON orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_checkout_reversal_transition();
CREATE CONSTRAINT TRIGGER stays_checkout_reversal_transition AFTER UPDATE ON stays
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_checkout_reversal_transition();

REVOKE ALL ON FUNCTION qintopia_assert_checkout_reversal(text),
  qintopia_validate_checkout_reversal_execution(), qintopia_validate_checkout_reversal_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_assert_checkout_reversal(text) TO qintopia_runtime;
