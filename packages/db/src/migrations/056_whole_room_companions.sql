LOCK TABLE command_catalog, staff_command_profile_catalog, subject_command_grants,
  orders, order_occupants, amendments IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO command_catalog(command_type, command_class) VALUES ('MANAGE_ORDER_OCCUPANTS', 'HUMAN_COMMAND');
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
  WHERE conrelid = 'subject_command_grants'::regclass AND conname = 'subject_command_grants_human_exact_check';
  IF position('''CORRECT_ORDER_OCCUPANT''::text' IN definition) = 0 THEN
    RAISE EXCEPTION 'companion migration cannot locate command grant constraint';
  END IF;
  definition := replace(definition, '''CORRECT_ORDER_OCCUPANT''::text', '''CORRECT_ORDER_OCCUPANT''::text, ''MANAGE_ORDER_OCCUPANTS''::text');
  ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
  EXECUTE 'ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check ' || definition;
END $$;
INSERT INTO staff_command_profile_catalog(profile, command_type, token_default)
VALUES ('ADMIN', 'MANAGE_ORDER_OCCUPANTS', true), ('STAFF', 'MANAGE_ORDER_OCCUPANTS', true);
INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT subject_id, property_id, 'MANAGE_ORDER_OCCUPANTS' FROM staff_profile_assignments WHERE profile IN ('ADMIN','STAFF');
UPDATE staff_profile_reconciliation_state SET projection_hash = (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value, E'\n' ORDER BY row_value), ''), 'UTF8')), 'hex')
  FROM (
    SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value FROM staff_profile_assignments
    UNION ALL SELECT format('G|%s|%s|%s', subject_id, property_id, command_type) FROM subject_command_grants
  ) AS projection
), reconciled_by = current_user, reconciled_at = now() WHERE singleton;

CREATE TABLE order_occupant_removals (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  occupant_id text NOT NULL UNIQUE REFERENCES order_occupants(id),
  amendment_id text NOT NULL UNIQUE REFERENCES amendments(id),
  created_by_command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW active_order_occupants WITH (security_invoker = true) AS
SELECT occupant.* FROM order_occupants AS occupant
WHERE NOT EXISTS (SELECT 1 FROM order_occupant_removals AS removal WHERE removal.occupant_id = occupant.id);
GRANT SELECT, INSERT ON order_occupant_removals TO qintopia_runtime;
GRANT SELECT ON active_order_occupants TO qintopia_runtime;
CREATE TRIGGER order_occupant_removals_append_only BEFORE UPDATE OR DELETE ON order_occupant_removals
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

DO $$
DECLARE definition text; function_name text;
BEGIN
  SELECT pg_get_functiondef('qintopia_validate_new_order_occupant()'::regprocedure) INTO definition;
  IF position('IF EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id) THEN' IN definition) = 0 THEN
    RAISE EXCEPTION 'companion migration cannot locate frozen roster guard';
  END IF;
  definition := replace(definition,
    'IF EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id) THEN',
    'IF EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id) AND NOT EXISTS (SELECT 1 FROM command_executions WHERE id = NEW.created_by_command_id AND command_type = ''MANAGE_ORDER_OCCUPANTS'' AND state = ''EXECUTING'') THEN');
  EXECUTE definition;
  FOREACH function_name IN ARRAY ARRAY['qintopia_validate_order_occupant_set()',
    'qintopia_assert_stage11_move_combination(text)', 'qintopia_assert_historical_stay_arrangement_correction_command(text)'] LOOP
    SELECT pg_get_functiondef(function_name::regprocedure) INTO definition;
    IF position('FROM order_occupants' IN definition) = 0 THEN
      RAISE EXCEPTION 'companion migration cannot locate roster projection in %', function_name;
    END IF;
    EXECUTE replace(definition, 'FROM order_occupants', 'FROM active_order_occupants');
  END LOOP;
  SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure) INTO definition;
  IF position('''CREATE_ORDER'', ''CORRECT_ORDER_OCCUPANT'',' IN definition) = 0 THEN
    RAISE EXCEPTION 'companion migration cannot locate room-status revision allowlist';
  END IF;
  EXECUTE replace(definition, '''CREATE_ORDER'', ''CORRECT_ORDER_OCCUPANT'',', '''CREATE_ORDER'', ''CORRECT_ORDER_OCCUPANT'', ''MANAGE_ORDER_OCCUPANTS'',');
END $$;

CREATE FUNCTION qintopia_assert_companion_command(target_command_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  execution command_executions%ROWTYPE;
  change amendments%ROWTYPE;
  booking orders%ROWTYPE;
  person order_occupants%ROWTYPE;
  removal order_occupant_removals%ROWTYPE;
  people integer;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  SELECT * INTO execution FROM command_executions WHERE id = target_command_id;
  IF execution.command_type IS DISTINCT FROM 'MANAGE_ORDER_OCCUPANTS' THEN
    IF EXISTS (SELECT 1 FROM order_occupant_removals WHERE created_by_command_id = target_command_id)
      OR EXISTS (SELECT 1 FROM amendments WHERE command_id = target_command_id AND amendment_type = 'MANAGE_ORDER_OCCUPANTS') THEN
      RAISE EXCEPTION 'companion changes require their typed command' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  SELECT * INTO change FROM amendments WHERE command_id = target_command_id AND amendment_type = 'MANAGE_ORDER_OCCUPANTS';
  IF change.id IS NULL AND execution.state <> 'APPLIED'
    AND NOT EXISTS (SELECT 1 FROM order_occupants WHERE created_by_command_id = target_command_id)
    AND NOT EXISTS (SELECT 1 FROM order_occupant_removals WHERE created_by_command_id = target_command_id) THEN RETURN; END IF;
  SELECT * INTO booking FROM orders WHERE id = change.order_id;
  SELECT * INTO person FROM order_occupants WHERE id = change.payload ->> 'occupantId';
  SELECT * INTO removal FROM order_occupant_removals WHERE created_by_command_id = target_command_id;
  SELECT count(*) INTO people FROM active_order_occupants WHERE order_id = booking.id;
  IF change.id IS NULL OR execution.state IS DISTINCT FROM 'APPLIED'
    OR (SELECT count(*) FROM amendments WHERE command_id = target_command_id) <> 1
    OR booking.property_id IS DISTINCT FROM execution.property_id
    OR booking.status NOT IN ('RESERVED','CHECKED_IN')
    OR NOT EXISTS (SELECT 1 FROM stays WHERE order_id = booking.id
      AND status = CASE booking.status WHEN 'RESERVED' THEN 'PLANNED' ELSE 'IN_HOUSE' END)
    OR person.order_id IS DISTINCT FROM booking.id OR person.role IS DISTINCT FROM 'ADDITIONAL'
    OR person.ordinal::text IS DISTINCT FROM change.payload ->> 'ordinal'
    OR btrim(change.reason_note) = ''
    OR booking.version IS DISTINCT FROM change.new_version
    OR change.payload ->> 'operation' IS DISTINCT FROM execution.command_type
    OR change.payload ->> 'orderId' IS DISTINCT FROM booking.id
    OR change.payload ->> 'arrivalDate' IS DISTINCT FROM booking.arrival_date::text
    OR change.payload ->> 'departureDate' IS DISTINCT FROM booking.departure_date::text
    OR people::text IS DISTINCT FROM change.payload ->> 'afterCount'
    OR NOT EXISTS (SELECT 1 FROM command_receipts WHERE command_id = target_command_id
      AND execution_status = 'EXECUTED' AND business_committed AND xmin = current_xid
      AND result ->> 'amendmentId' = change.id AND result ->> 'occupantId' = person.id
      AND (result ->> 'removalId') IS NOT DISTINCT FROM removal.id
      AND result - ARRAY['amendmentId','removalId','effectHash'] = change.payload
      AND result ->> 'effectHash' ~ '^[a-f0-9]{64}$')
    OR NOT EXISTS (SELECT 1 FROM audit_entries WHERE command_id = target_command_id
      AND decision = 'ALLOWED' AND action = execution.command_type AND xmin = current_xid) THEN
    RAISE EXCEPTION 'companion change requires exact order, person, receipt and audit evidence' USING ERRCODE = '23514';
  END IF;
  IF change.payload ->> 'action' = 'ADD' THEN
    IF person.created_by_command_id IS DISTINCT FROM target_command_id OR removal.id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM order_occupants WHERE id = person.id AND xmin = current_xid)
      OR (SELECT count(*) FROM order_occupants WHERE created_by_command_id = target_command_id) <> 1
      OR (change.payload ->> 'beforeCount')::integer IS DISTINCT FROM people - 1
      OR jsonb_build_object('fullName', person.full_name, 'nickname', person.nickname,
          'phone', person.phone, 'documentNumber', person.document_number) IS DISTINCT FROM change.payload -> 'guest' THEN
      RAISE EXCEPTION 'added companion does not match approved snapshot' USING ERRCODE = '23514';
    END IF;
  ELSIF change.payload ->> 'action' = 'REMOVE' THEN
    IF removal.id IS NULL OR removal.order_id IS DISTINCT FROM booking.id OR removal.occupant_id IS DISTINCT FROM person.id
      OR NOT EXISTS (SELECT 1 FROM order_occupant_removals WHERE id = removal.id AND xmin = current_xid)
      OR removal.amendment_id IS DISTINCT FROM change.id OR (change.payload ->> 'beforeCount')::integer IS DISTINCT FROM people + 1
      OR change.payload -> 'guest' IS DISTINCT FROM COALESCE(
        (SELECT jsonb_build_object('fullName', corrected_full_name, 'nickname', corrected_nickname,
          'phone', corrected_phone, 'documentNumber', corrected_document_number)
          FROM order_occupant_corrections WHERE occupant_id = person.id ORDER BY sequence DESC LIMIT 1),
        jsonb_build_object('fullName', person.full_name, 'nickname', person.nickname,
          'phone', person.phone, 'documentNumber', person.document_number))
      OR EXISTS (SELECT 1 FROM order_occupants WHERE created_by_command_id = target_command_id) THEN
      RAISE EXCEPTION 'removed companion does not match approved snapshot' USING ERRCODE = '23514';
    END IF;
  ELSE RAISE EXCEPTION 'unknown companion action' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_claims AS claim JOIN stay_segments AS segment ON segment.id = claim.source_id
      JOIN stays AS stay ON stay.id = segment.stay_id WHERE stay.order_id = booking.id AND claim.active AND claim.source_type = 'ORDER_SEGMENT')
    OR EXISTS (SELECT 1 FROM inventory_claims AS claim JOIN stay_segments AS segment ON segment.id = claim.source_id
      JOIN stays AS stay ON stay.id = segment.stay_id JOIN inventory_units AS unit ON unit.id = claim.inventory_unit_id
      WHERE stay.order_id = booking.id AND claim.active AND claim.source_type = 'ORDER_SEGMENT'
        AND (unit.kind <> 'ROOM' OR people > unit.occupancy_capacity))
    OR (change.payload ->> 'occupancyCapacity')::integer IS DISTINCT FROM (
      SELECT min(unit.occupancy_capacity) FROM inventory_claims AS claim
      JOIN stay_segments AS segment ON segment.id = claim.source_id JOIN stays AS stay ON stay.id = segment.stay_id
      JOIN inventory_units AS unit ON unit.id = claim.inventory_unit_id
      WHERE stay.order_id = booking.id AND claim.active AND claim.source_type = 'ORDER_SEGMENT')
    OR EXISTS (SELECT 1 FROM pricing_revisions WHERE amendment_id = change.id)
    OR EXISTS (SELECT 1 FROM stay_segments WHERE amendment_id = change.id)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id)
    OR EXISTS (SELECT 1 FROM membership_payment_facts WHERE command_id = target_command_id)
    OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE command_id = target_command_id) THEN
    RAISE EXCEPTION 'companion change exceeds whole-room capacity or mutates unrelated facts' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION qintopia_validate_companion_command() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM qintopia_assert_companion_command(CASE TG_TABLE_NAME
    WHEN 'command_executions' THEN NEW.id
    WHEN 'amendments' THEN to_jsonb(NEW) ->> 'command_id'
    ELSE to_jsonb(NEW) ->> 'created_by_command_id' END);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER command_executions_companion_guard AFTER INSERT OR UPDATE ON command_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_companion_command();
CREATE CONSTRAINT TRIGGER amendments_companion_guard AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.amendment_type = 'MANAGE_ORDER_OCCUPANTS') EXECUTE FUNCTION qintopia_validate_companion_command();
CREATE CONSTRAINT TRIGGER order_occupants_companion_guard AFTER INSERT ON order_occupants
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_companion_command();
CREATE CONSTRAINT TRIGGER order_occupant_removals_companion_guard AFTER INSERT ON order_occupant_removals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_companion_command();
REVOKE ALL ON FUNCTION qintopia_assert_companion_command(text), qintopia_validate_companion_command() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_assert_companion_command(text) TO qintopia_runtime;
