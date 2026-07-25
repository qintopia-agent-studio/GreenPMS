CREATE TABLE order_occupant_corrections (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  occupant_id text NOT NULL REFERENCES order_occupants(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  prior_full_name text,
  prior_nickname text,
  prior_phone text,
  prior_document_number text,
  corrected_full_name text NOT NULL,
  corrected_nickname text NOT NULL,
  corrected_phone text,
  corrected_document_number text,
  reason_code text NOT NULL,
  reason_note text NOT NULL,
  actor_subject_id text NOT NULL REFERENCES subjects(id),
  amendment_id text NOT NULL UNIQUE REFERENCES amendments(id),
  created_by_command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_occupant_corrections_occupant_sequence_unique UNIQUE (occupant_id, sequence)
);

CREATE OR REPLACE FUNCTION qintopia_validate_order_occupant_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  base_occupant order_occupants%ROWTYPE;
  latest_correction order_occupant_corrections%ROWTYPE;
  target_order orders%ROWTYPE;
  target_amendment amendments%ROWTYPE;
  creating_command command_executions%ROWTYPE;
  expected_sequence integer;
  current_full_name text;
  current_nickname text;
  current_phone text;
  current_document_number text;
BEGIN
  SELECT * INTO target_order FROM orders WHERE id = NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'occupant correction requires an existing target order'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_order_required';
  END IF;
  SELECT * INTO base_occupant
    FROM order_occupants
    WHERE id = NEW.occupant_id
    FOR UPDATE;
  IF NOT FOUND OR base_occupant.order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'occupant correction requires an occupant from the target order'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_occupant_order';
  END IF;

  SELECT * INTO target_amendment FROM amendments WHERE id = NEW.amendment_id;
  SELECT * INTO creating_command FROM command_executions WHERE id = NEW.created_by_command_id;
  IF target_amendment.id IS NULL
    OR target_amendment.order_id <> NEW.order_id
    OR target_amendment.amendment_type <> 'CORRECT_ORDER_OCCUPANT'
    OR target_amendment.command_id IS DISTINCT FROM NEW.created_by_command_id
    OR target_amendment.prior_version <> target_order.version
    OR target_amendment.new_version <> target_order.version + 1
    OR target_amendment.sequence <> target_order.version + 1
    OR target_amendment.reason_code <> NEW.reason_code
    OR target_amendment.reason_note <> NEW.reason_note THEN
    RAISE EXCEPTION 'occupant correction amendment does not match the order aggregate'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_amendment_shape';
  END IF;
  IF creating_command.id IS NULL
    OR creating_command.command_type <> 'CORRECT_ORDER_OCCUPANT'
    OR creating_command.property_id <> target_order.property_id
    OR creating_command.subject_id <> NEW.actor_subject_id
    OR creating_command.state <> 'EXECUTING' THEN
    RAISE EXCEPTION 'occupant correction requires its executing correction command'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_command_shape';
  END IF;
  IF char_length(btrim(NEW.reason_code)) NOT BETWEEN 1 AND 80
    OR char_length(btrim(NEW.reason_note)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'occupant correction requires a structured reason'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_reason_shape';
  END IF;

  SELECT * INTO latest_correction
    FROM order_occupant_corrections
    WHERE occupant_id = NEW.occupant_id
    ORDER BY sequence DESC
    LIMIT 1;
  expected_sequence := COALESCE(latest_correction.sequence, 0) + 1;
  current_full_name := COALESCE(latest_correction.corrected_full_name, base_occupant.full_name);
  current_nickname := COALESCE(latest_correction.corrected_nickname, base_occupant.nickname);
  current_phone := CASE WHEN latest_correction.id IS NULL THEN base_occupant.phone ELSE latest_correction.corrected_phone END;
  current_document_number := CASE WHEN latest_correction.id IS NULL THEN base_occupant.document_number ELSE latest_correction.corrected_document_number END;

  IF NEW.sequence <> expected_sequence THEN
    RAISE EXCEPTION 'occupant correction sequence must be contiguous'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_sequence_contiguous';
  END IF;
  IF NEW.prior_full_name IS DISTINCT FROM current_full_name
    OR NEW.prior_nickname IS DISTINCT FROM current_nickname
    OR NEW.prior_phone IS DISTINCT FROM current_phone
    OR NEW.prior_document_number IS DISTINCT FROM current_document_number THEN
    RAISE EXCEPTION 'occupant correction prior snapshot is stale'
      USING ERRCODE = '40001', CONSTRAINT = 'order_occupant_corrections_prior_snapshot';
  END IF;

  NEW.corrected_full_name := NULLIF(btrim(NEW.corrected_full_name), '');
  NEW.corrected_nickname := NULLIF(btrim(NEW.corrected_nickname), '');
  NEW.corrected_phone := NULLIF(btrim(NEW.corrected_phone), '');
  NEW.corrected_document_number := NULLIF(btrim(NEW.corrected_document_number), '');
  IF NEW.corrected_full_name IS NULL OR char_length(NEW.corrected_full_name) > 200
    OR NEW.corrected_nickname IS NULL OR char_length(NEW.corrected_nickname) > 200
    OR NEW.corrected_phone IS NOT NULL AND char_length(NEW.corrected_phone) > 80
    OR NEW.corrected_document_number IS NOT NULL AND char_length(NEW.corrected_document_number) > 120 THEN
    RAISE EXCEPTION 'occupant correction snapshot is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_snapshot_shape';
  END IF;
  IF NEW.corrected_full_name IS NOT DISTINCT FROM current_full_name
    AND NEW.corrected_nickname IS NOT DISTINCT FROM current_nickname
    AND NEW.corrected_phone IS NOT DISTINCT FROM current_phone
    AND NEW.corrected_document_number IS NOT DISTINCT FROM current_document_number THEN
    RAISE EXCEPTION 'occupant correction must change at least one field'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_change_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_occupant_corrections_validate_new
BEFORE INSERT ON order_occupant_corrections
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_order_occupant_correction();

CREATE TRIGGER order_occupant_corrections_append_only
BEFORE UPDATE OR DELETE ON order_occupant_corrections
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE OR REPLACE FUNCTION qintopia_validate_committed_order_occupant_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM amendments AS amendment
    JOIN orders AS booking ON booking.id = amendment.order_id
    JOIN command_executions AS command ON command.id = NEW.created_by_command_id
    WHERE amendment.id = NEW.amendment_id
      AND booking.id = NEW.order_id
      AND booking.version = amendment.new_version
      AND command.state = 'APPLIED'
  ) THEN
    RAISE EXCEPTION 'occupant correction aggregate is incomplete at commit'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupant_corrections_committed_aggregate';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER order_occupant_corrections_validate_committed
AFTER INSERT ON order_occupant_corrections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_committed_order_occupant_correction();

CREATE INDEX order_occupant_corrections_order_created_idx
  ON order_occupant_corrections (order_id, created_at, id);
