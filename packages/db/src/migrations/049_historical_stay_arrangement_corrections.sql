LOCK TABLE command_catalog, staff_command_profile_catalog, staff_profile_assignments,
  subject_command_grants, token_command_ceilings, orders, stays, amendments,
  stay_segments, pricing_revisions, inventory_claims, inventory_room_days,
  inventory_bed_days, coverage_items, entitlement_ledger, collection_facts,
  command_executions, command_receipts, audit_entries, command_previews
  IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO command_catalog(command_type, command_class, feature_key) VALUES
  ('CORRECT_HISTORICAL_STAY_ARRANGEMENTS', 'HUMAN_COMMAND', NULL)
ON CONFLICT (command_type) DO UPDATE SET
  command_class = EXCLUDED.command_class,
  feature_key = EXCLUDED.feature_key;

INSERT INTO staff_command_profile_catalog(profile, command_type, token_default) VALUES
  ('ADMIN', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS', true)
ON CONFLICT (profile, command_type) DO UPDATE SET
  token_default = EXCLUDED.token_default;

INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT assignment.subject_id,
  assignment.property_id,
  'CORRECT_HISTORICAL_STAY_ARRANGEMENTS'
FROM staff_profile_assignments AS assignment
WHERE assignment.profile = 'ADMIN'
ON CONFLICT DO NOTHING;

CREATE TABLE historical_stay_arrangement_corrections (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  order_id text NOT NULL REFERENCES orders(id),
  stay_id text NOT NULL REFERENCES stays(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  prior_inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  prior_arrival_date date NOT NULL,
  prior_departure_date date NOT NULL,
  corrected_inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  corrected_arrival_date date NOT NULL,
  corrected_departure_date date NOT NULL,
  reason_code text NOT NULL,
  reason_note text NOT NULL CHECK (NULLIF(btrim(reason_note), '') IS NOT NULL),
  actor_subject_id text NOT NULL REFERENCES subjects(id),
  amendment_id text NOT NULL UNIQUE REFERENCES amendments(id),
  stay_segment_id text NOT NULL UNIQUE REFERENCES stay_segments(id),
  pricing_revision_id text NOT NULL UNIQUE,
  created_by_command_id text NOT NULL REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, sequence),
  FOREIGN KEY (pricing_revision_id, order_id) REFERENCES pricing_revisions(id, order_id),
  CHECK (prior_departure_date > prior_arrival_date),
  CHECK (corrected_departure_date > corrected_arrival_date),
  CHECK (
    prior_inventory_unit_id IS DISTINCT FROM corrected_inventory_unit_id
    OR prior_arrival_date IS DISTINCT FROM corrected_arrival_date
    OR prior_departure_date IS DISTINCT FROM corrected_departure_date
  )
);

CREATE INDEX historical_stay_arrangement_corrections_property_idx
  ON historical_stay_arrangement_corrections(property_id, created_at DESC, id);
CREATE INDEX historical_stay_arrangement_corrections_order_idx
  ON historical_stay_arrangement_corrections(order_id, sequence DESC);

CREATE TRIGGER historical_stay_arrangement_corrections_append_only
BEFORE UPDATE OR DELETE ON historical_stay_arrangement_corrections
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

GRANT SELECT, INSERT ON historical_stay_arrangement_corrections TO qintopia_runtime;

CREATE UNIQUE INDEX audit_entries_allowed_preview_id_unique_idx
  ON audit_entries ((metadata ->> 'previewId'))
  WHERE decision = 'ALLOWED'
    AND NULLIF(btrim(metadata ->> 'previewId'), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION qintopia_validate_historical_stay_arrangement_correction_amendment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  execution_type text;
BEGIN
  IF NEW.amendment_type IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENT' THEN
    RETURN NEW;
  END IF;

  IF NEW.command_id IS NULL THEN
    RAISE EXCEPTION 'historical stay arrangement correction amendments require a command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_command_required';
  END IF;

  SELECT command_type INTO execution_type
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS' THEN
    RAISE EXCEPTION 'historical stay arrangement correction amendment requires its typed command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_command_type';
  END IF;

  IF btrim(NEW.reason_note) = ''
    OR NEW.payload ->> 'operation' IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENT'
    OR NEW.payload ->> 'commandType' IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS'
    OR NEW.payload ->> 'orderId' IS DISTINCT FROM NEW.order_id
    OR btrim(COALESCE(NEW.payload ->> 'stayId', '')) = ''
    OR btrim(COALESCE(NEW.payload ->> 'correctionSetHash', '')) = ''
    OR jsonb_typeof(NEW.payload #> '{before,nights}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.payload #> '{before,stayTimeline}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.payload #> '{after,nights}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.payload #> '{after,stayTimeline}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.payload #> '{unchanged,occupantCount}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.payload #> '{unchanged,occupants}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.payload #> '{unchanged,collectionFactCount}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.payload #> '{unchanged,netRecordedCollectionMinor}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.payload #> '{unchanged,collectionDifferenceMinor}') IS DISTINCT FROM 'number'
    OR NEW.payload #>> '{before,inventoryUnitId}' IS NULL
    OR NEW.payload #>> '{before,arrivalDate}' IS NULL
    OR NEW.payload #>> '{before,departureDate}' IS NULL
    OR NEW.payload #>> '{after,inventoryUnitId}' IS NULL
    OR NEW.payload #>> '{after,arrivalDate}' IS NULL
    OR NEW.payload #>> '{after,departureDate}' IS NULL
    OR NEW.payload #>> '{unchanged,orderStatus}' IS DISTINCT FROM 'CHECKED_OUT'
    OR NEW.payload #>> '{unchanged,stayStatus}' IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'historical stay arrangement correction amendment payload is incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_amendment_shape';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS amendments_validate_historical_stay_arrangement_correction ON amendments;
CREATE TRIGGER amendments_validate_historical_stay_arrangement_correction
BEFORE INSERT ON amendments
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_amendment();

CREATE OR REPLACE FUNCTION qintopia_assert_historical_stay_arrangement_correction_command(
  target_command_id text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  execution_subject_id text;
  execution_credential_id text;
  execution_correlation_id text;
  amendment_count integer;
  correction_count integer;
  allowed_audit_count integer;
  preview_count integer;
  target_audit audit_entries%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  target_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF target_command_id IS NULL THEN
    RETURN;
  END IF;

  SELECT command_type, state, property_id, subject_id, credential_id, correlation_id
    INTO execution_type, execution_state, execution_property_id, execution_subject_id,
      execution_credential_id, execution_correlation_id
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS' THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO amendment_count
    FROM amendments
    WHERE command_id = target_command_id;
  IF amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    RAISE EXCEPTION 'historical stay arrangement correction requires an applied command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_execution_state';
  END IF;
  IF amendment_count = 0 OR EXISTS (
    SELECT 1
    FROM amendments AS amendment
    WHERE amendment.command_id = target_command_id
      AND amendment.amendment_type IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENT'
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction command requires only typed correction amendments'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_amendment_set';
  END IF;

  SELECT count(*)::integer
    INTO correction_count
    FROM historical_stay_arrangement_corrections
    WHERE created_by_command_id = target_command_id;
  IF correction_count IS DISTINCT FROM amendment_count THEN
    RAISE EXCEPTION 'historical stay arrangement correction command requires one audit fact per typed amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_exact_fact_set';
  END IF;

  SELECT count(*)::integer INTO allowed_audit_count
  FROM audit_entries
  WHERE command_id = target_command_id
    AND decision = 'ALLOWED';
  IF allowed_audit_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'historical stay arrangement correction requires one authoritative Preview audit'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_preview_binding';
  END IF;
  SELECT * INTO target_audit
  FROM audit_entries
  WHERE command_id = target_command_id
    AND decision = 'ALLOWED';
  SELECT count(*)::integer INTO preview_count
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  IF preview_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'historical stay arrangement correction requires one immutable Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_preview_binding';
  END IF;
  SELECT * INTO target_preview
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';

  IF target_audit.subject_id IS DISTINCT FROM execution_subject_id
    OR target_audit.credential_id IS DISTINCT FROM execution_credential_id
    OR target_audit.action IS DISTINCT FROM execution_type
    OR target_audit.correlation_id IS DISTINCT FROM execution_correlation_id
    OR target_audit.metadata ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR jsonb_typeof(target_audit.reason) IS DISTINCT FROM 'object'
    OR target_preview.subject_id IS DISTINCT FROM execution_subject_id
    OR target_preview.property_id IS DISTINCT FROM execution_property_id
    OR target_preview.command_type IS DISTINCT FROM execution_type
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.effect ->> 'operation' IS DISTINCT FROM execution_type
    OR target_preview.basis_versions ->> 'propertyId' IS DISTINCT FROM execution_property_id
    OR jsonb_typeof(target_preview.effect -> 'corrections') IS DISTINCT FROM 'array'
    OR EXISTS (
      SELECT 1
      FROM historical_stay_arrangement_corrections AS correction
      WHERE correction.created_by_command_id = target_command_id
        AND (correction.reason_code IS DISTINCT FROM target_audit.reason ->> 'code'
          OR correction.reason_note IS DISTINCT FROM target_audit.reason ->> 'note')
    ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction must bind its actor, reason, and effect hash to one used Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_preview_binding';
  END IF;

  IF jsonb_array_length(target_preview.effect -> 'corrections') IS DISTINCT FROM correction_count
    OR EXISTS (
      SELECT 1
      FROM historical_stay_arrangement_corrections AS correction
      JOIN amendments AS amendment ON amendment.id = correction.amendment_id
      WHERE correction.created_by_command_id = target_command_id
        AND (
          amendment.payload ->> 'correctionSetHash'
            IS DISTINCT FROM target_preview.basis_versions ->> 'correctionSetHash'
          OR (
            SELECT count(*)
            FROM jsonb_array_elements(target_preview.effect -> 'corrections') AS preview_item(value)
            WHERE preview_item.value ->> 'orderId' = correction.order_id
              AND preview_item.value ->> 'stayId' = correction.stay_id
              AND preview_item.value ->> 'expectedVersion' = correction.expected_version::text
              AND preview_item.value -> 'before' IS NOT DISTINCT FROM amendment.payload -> 'before'
              AND preview_item.value -> 'after'
                IS NOT DISTINCT FROM (amendment.payload -> 'after') - 'pricing'
              AND preview_item.value -> 'unchanged' IS NOT DISTINCT FROM amendment.payload -> 'unchanged'
          ) IS DISTINCT FROM 1::bigint
        )
    ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction root facts must match every value frozen in the used Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_preview_binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN amendments AS amendment
      ON amendment.id = correction.amendment_id
    JOIN pricing_revisions AS revision
      ON revision.id = correction.pricing_revision_id
      AND revision.order_id = correction.order_id
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS occupant_count,
        COALESCE(jsonb_agg(jsonb_build_object(
          'ordinal', occupant.ordinal,
          'role', occupant.role,
          'fullName', CASE
            WHEN latest_correction.id IS NULL THEN occupant.full_name
            ELSE latest_correction.corrected_full_name
          END,
          'nickname', CASE
            WHEN latest_correction.id IS NULL THEN occupant.nickname
            ELSE latest_correction.corrected_nickname
          END
        ) ORDER BY occupant.ordinal), '[]'::jsonb) AS occupant_snapshot
      FROM order_occupants AS occupant
      LEFT JOIN LATERAL (
        SELECT correction_row.id,
          correction_row.corrected_full_name,
          correction_row.corrected_nickname
        FROM order_occupant_corrections AS correction_row
        WHERE correction_row.occupant_id = occupant.id
        ORDER BY correction_row.sequence DESC
        LIMIT 1
      ) AS latest_correction ON true
      WHERE occupant.order_id = correction.order_id
    ) AS occupants
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS fact_count,
        COALESCE(sum(fact.net_effect_minor), 0)::bigint AS net_recorded_collection_minor
      FROM collection_facts AS fact
      WHERE fact.order_id = correction.order_id
    ) AS collections
    WHERE correction.created_by_command_id = target_command_id
      AND (
        amendment.payload #>> '{before,nights}'
          IS DISTINCT FROM (correction.prior_departure_date - correction.prior_arrival_date)::text
        OR amendment.payload #> '{before,stayTimeline}' IS DISTINCT FROM (
          SELECT jsonb_agg(
            jsonb_build_object(
              'serviceDate', expected.service_date::date,
              'inventoryUnitId', correction.prior_inventory_unit_id
            ) ORDER BY expected.service_date
          )
          FROM generate_series(
            correction.prior_arrival_date,
            correction.prior_departure_date - 1,
            interval '1 day'
          ) AS expected(service_date)
        )
        OR amendment.payload #>> '{after,nights}'
          IS DISTINCT FROM (correction.corrected_departure_date - correction.corrected_arrival_date)::text
        OR amendment.payload #> '{after,stayTimeline}' IS DISTINCT FROM (
          SELECT jsonb_agg(
            jsonb_build_object(
              'serviceDate', expected.service_date::date,
              'inventoryUnitId', correction.corrected_inventory_unit_id
            ) ORDER BY expected.service_date
          )
          FROM generate_series(
            correction.corrected_arrival_date,
            correction.corrected_departure_date - 1,
            interval '1 day'
          ) AS expected(service_date)
        )
        OR amendment.payload #>> '{unchanged,occupantCount}'
          IS DISTINCT FROM occupants.occupant_count::text
        OR amendment.payload #> '{unchanged,occupants}'
          IS DISTINCT FROM occupants.occupant_snapshot
        OR amendment.payload #>> '{unchanged,collectionFactCount}'
          IS DISTINCT FROM collections.fact_count::text
        OR amendment.payload #>> '{unchanged,netRecordedCollectionMinor}'
          IS DISTINCT FROM collections.net_recorded_collection_minor::text
        OR amendment.payload #>> '{unchanged,collectionDifferenceMinor}'
          IS DISTINCT FROM (
            revision.current_contract_amount_minor::bigint - collections.net_recorded_collection_minor
          )::text
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction Preview must match authoritative stay, occupant, and collection facts'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_preview_database_facts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    WHERE correction.created_by_command_id = target_command_id
      AND correction.sequence IS DISTINCT FROM COALESCE((
        SELECT max(prior.sequence)
        FROM historical_stay_arrangement_corrections AS prior
        WHERE prior.order_id = correction.order_id
          AND prior.id <> correction.id
      ), 0) + 1
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction sequence must start at one and advance exactly once'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_sequence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN properties AS property_row ON property_row.id = correction.property_id
    WHERE correction.created_by_command_id = target_command_id
      AND correction.corrected_departure_date >
        (transaction_timestamp() AT TIME ZONE property_row.timezone)::date
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction departure cannot be after the property business date'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_future_date';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    WHERE correction.created_by_command_id = target_command_id
      AND correction.actor_subject_id IS DISTINCT FROM execution_subject_id
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction actor must match the command subject'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_actor_binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN amendments AS amendment
      ON amendment.id = correction.amendment_id
    JOIN stay_segments AS segment
      ON segment.id = correction.stay_segment_id
      AND segment.amendment_id = amendment.id
    JOIN pricing_revisions AS revision
      ON revision.id = correction.pricing_revision_id
      AND revision.amendment_id = amendment.id
    WHERE correction.created_by_command_id = target_command_id
      AND (
        correction.xmin IS DISTINCT FROM target_xid
        OR amendment.xmin IS DISTINCT FROM target_xid
        OR segment.xmin IS DISTINCT FROM target_xid
        OR revision.xmin IS DISTINCT FROM target_xid
        OR correction.created_at IS DISTINCT FROM transaction_timestamp()
        OR amendment.created_at IS DISTINCT FROM transaction_timestamp()
        OR segment.created_at IS DISTINCT FROM transaction_timestamp()
        OR revision.created_at IS DISTINCT FROM transaction_timestamp()
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction facts must be recorded by the current transaction clock'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_transaction_time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM amendments AS amendment
    WHERE amendment.command_id = target_command_id
      AND NOT EXISTS (
        SELECT 1
        FROM historical_stay_arrangement_corrections AS correction
        JOIN orders AS order_row
          ON order_row.id = correction.order_id
        JOIN stays AS stay_row
          ON stay_row.id = correction.stay_id
          AND stay_row.order_id = order_row.id
        JOIN stay_segments AS segment
          ON segment.id = correction.stay_segment_id
          AND segment.stay_id = stay_row.id
          AND segment.amendment_id = amendment.id
        JOIN stay_segments AS prior_segment
          ON prior_segment.id = segment.supersedes_segment_id
          AND prior_segment.stay_id = segment.stay_id
          AND prior_segment.sequence = segment.sequence - 1
        JOIN pricing_revisions AS revision
          ON revision.id = correction.pricing_revision_id
          AND revision.order_id = order_row.id
          AND revision.amendment_id = amendment.id
        JOIN pricing_revisions AS prior_revision
          ON prior_revision.id = amendment.payload #>> '{unchanged,currentRevisionId}'
          AND prior_revision.order_id = order_row.id
        JOIN inventory_units AS prior_unit
          ON prior_unit.id = correction.prior_inventory_unit_id
          AND prior_unit.property_id = correction.property_id
        JOIN inventory_units AS corrected_unit
          ON corrected_unit.id = correction.corrected_inventory_unit_id
          AND corrected_unit.property_id = correction.property_id
        WHERE correction.amendment_id = amendment.id
          AND correction.created_by_command_id = target_command_id
          AND correction.property_id = execution_property_id
          AND correction.order_id = amendment.order_id
          AND correction.expected_version = amendment.prior_version
          AND amendment.sequence = amendment.new_version
          AND amendment.new_version = amendment.prior_version + 1
          AND amendment.payload ->> 'orderId' = order_row.id
          AND amendment.payload ->> 'stayId' = stay_row.id
          AND (amendment.payload ->> 'expectedVersion')::integer = amendment.prior_version
          AND amendment.payload #>> '{before,inventoryUnitId}' = correction.prior_inventory_unit_id
          AND (amendment.payload #>> '{before,arrivalDate}')::date = correction.prior_arrival_date
          AND (amendment.payload #>> '{before,departureDate}')::date = correction.prior_departure_date
          AND amendment.payload #>> '{after,inventoryUnitId}' = correction.corrected_inventory_unit_id
          AND (amendment.payload #>> '{after,arrivalDate}')::date = correction.corrected_arrival_date
          AND (amendment.payload #>> '{after,departureDate}')::date = correction.corrected_departure_date
          AND segment.segment_type = 'CORRECT_HISTORICAL_STAY_ARRANGEMENT'
          AND segment.sequence = prior_segment.sequence + 1
          AND segment.inventory_unit_id = correction.corrected_inventory_unit_id
          AND segment.arrival_date = correction.corrected_arrival_date
          AND segment.departure_date = correction.corrected_departure_date
          AND prior_segment.inventory_unit_id = correction.prior_inventory_unit_id
          AND prior_segment.arrival_date = correction.prior_arrival_date
          AND prior_segment.departure_date = correction.prior_departure_date
          AND order_row.property_id = correction.property_id
          AND order_row.status = 'CHECKED_OUT'
          AND stay_row.status = 'COMPLETED'
          AND order_row.version = amendment.new_version
          AND order_row.current_revision_id = revision.id
          AND order_row.arrival_date = correction.corrected_arrival_date
          AND order_row.departure_date = correction.corrected_departure_date
          AND revision.revision_no = prior_revision.revision_no + 1
          AND revision.policy_version_id = prior_revision.policy_version_id
          AND revision.arrival_date = correction.corrected_arrival_date
          AND revision.departure_date = correction.corrected_departure_date
          AND revision.coverage_set IS NOT DISTINCT FROM prior_revision.coverage_set
          AND revision.cash_lines IS NOT DISTINCT FROM prior_revision.cash_lines
          AND revision.policy_base_amount_minor IS NOT DISTINCT FROM prior_revision.policy_base_amount_minor
          AND revision.pricing_basis IS NOT DISTINCT FROM prior_revision.pricing_basis
          AND revision.manual_adjustment_minor IS NOT DISTINCT FROM prior_revision.manual_adjustment_minor
          AND revision.current_contract_amount_minor IS NOT DISTINCT FROM prior_revision.current_contract_amount_minor
          AND revision.currency IS NOT DISTINCT FROM prior_revision.currency
          AND correction.reason_code = amendment.reason_code
          AND correction.reason_note = amendment.reason_note
          AND prior_unit.kind = corrected_unit.kind
          AND prior_unit.pricing_product_code IS NOT DISTINCT FROM corrected_unit.pricing_product_code
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction did not commit the exact amendment, segment, pricing, and audit chain'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_exact_chain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN inventory_units AS corrected_unit
      ON corrected_unit.id = correction.corrected_inventory_unit_id
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS occupant_count
      FROM order_occupants AS occupant
      WHERE occupant.order_id = correction.order_id
    ) AS occupants
    WHERE correction.created_by_command_id = target_command_id
      AND (
        corrected_unit.property_id IS DISTINCT FROM correction.property_id
        OR corrected_unit.active IS DISTINCT FROM true
        OR occupants.occupant_count < 1
        OR occupants.occupant_count > corrected_unit.occupancy_capacity
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction target cannot hold the frozen occupant set'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_occupancy_capacity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN stay_segments AS segment
      ON segment.stay_id = correction.stay_id
    JOIN inventory_claims AS claim
      ON claim.source_type = 'ORDER_SEGMENT'
      AND claim.source_id = segment.id
    WHERE correction.created_by_command_id = target_command_id
      AND claim.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction must not leave active inventory claims on completed stays'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_claim_release';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN stay_segments AS segment
      ON segment.id = correction.stay_segment_id
    JOIN inventory_claims AS claim
      ON claim.source_type = 'ORDER_SEGMENT'
      AND claim.source_id = segment.id
      AND claim.xmin = target_xid
    WHERE correction.created_by_command_id = target_command_id
      AND (
        EXISTS (
          SELECT 1
          FROM inventory_room_days AS room_day
          WHERE room_day.whole_claim_id = claim.id
        )
        OR EXISTS (
          SELECT 1
          FROM inventory_bed_days AS bed_day
          WHERE bed_day.bed_claim_id = claim.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction must clear every released inventory claim pointer'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_claim_pointer_release';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN stay_segments AS segment
      ON segment.id = correction.stay_segment_id
    JOIN inventory_units AS unit_row
      ON unit_row.id = correction.corrected_inventory_unit_id
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS claim_count
      FROM inventory_claims AS claim
      WHERE claim.source_type = 'ORDER_SEGMENT'
        AND claim.source_id = segment.id
        AND claim.property_id = correction.property_id
        AND claim.room_id = CASE WHEN unit_row.kind = 'ROOM' THEN unit_row.id ELSE unit_row.parent_room_id END
        AND claim.inventory_unit_id = correction.corrected_inventory_unit_id
        AND claim.service_date >= correction.corrected_arrival_date
        AND claim.service_date < correction.corrected_departure_date
        AND claim.active IS FALSE
        AND claim.released_at IS NOT NULL
        AND claim.xmin = target_xid
    ) AS released_claims ON true
    WHERE correction.created_by_command_id = target_command_id
      AND (
        released_claims.claim_count IS DISTINCT FROM correction.corrected_departure_date - correction.corrected_arrival_date
        OR EXISTS (
          SELECT 1
          FROM generate_series(
            correction.corrected_arrival_date,
            correction.corrected_departure_date - 1,
            interval '1 day'
          ) AS expected(service_date)
          WHERE (
            SELECT count(*)
            FROM inventory_claims AS exact_claim
            WHERE exact_claim.source_type = 'ORDER_SEGMENT'
              AND exact_claim.source_id = segment.id
              AND exact_claim.property_id = correction.property_id
              AND exact_claim.room_id = CASE WHEN unit_row.kind = 'ROOM' THEN unit_row.id ELSE unit_row.parent_room_id END
              AND exact_claim.inventory_unit_id = correction.corrected_inventory_unit_id
              AND exact_claim.service_date = expected.service_date::date
              AND exact_claim.active IS FALSE
              AND exact_claim.released_at IS NOT NULL
              AND exact_claim.xmin = target_xid
          ) IS DISTINCT FROM 1::bigint
        )
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction requires released historical inventory evidence for every corrected service date'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_claim_evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN inventory_units AS corrected_unit
      ON corrected_unit.id = correction.corrected_inventory_unit_id
    JOIN inventory_claims AS blocker
      ON blocker.property_id = correction.property_id
      AND blocker.active IS TRUE
      AND blocker.room_id = CASE
        WHEN corrected_unit.kind = 'ROOM' THEN corrected_unit.id
        ELSE corrected_unit.parent_room_id
      END
      AND blocker.service_date >= correction.corrected_arrival_date
      AND blocker.service_date < correction.corrected_departure_date
    JOIN inventory_units AS blocker_unit
      ON blocker_unit.id = blocker.inventory_unit_id
    WHERE correction.created_by_command_id = target_command_id
      AND (
        corrected_unit.kind = 'ROOM'
        OR blocker_unit.kind = 'ROOM'
        OR blocker_unit.id = corrected_unit.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM historical_stay_arrangement_corrections AS set_correction
        JOIN stay_segments AS set_segment
          ON set_segment.stay_id = set_correction.stay_id
        WHERE set_correction.created_by_command_id = target_command_id
          AND blocker.source_type = 'ORDER_SEGMENT'
          AND blocker.source_id = set_segment.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN inventory_units AS corrected_unit
      ON corrected_unit.id = correction.corrected_inventory_unit_id
    JOIN maintenance_locks AS blocker
      ON blocker.property_id = correction.property_id
      AND blocker.status = 'ACTIVE'
      AND blocker.arrival_date < correction.corrected_departure_date
      AND blocker.departure_date > correction.corrected_arrival_date
    JOIN inventory_units AS blocker_unit
      ON blocker_unit.id = blocker.inventory_unit_id
      AND (CASE WHEN blocker_unit.kind = 'ROOM' THEN blocker_unit.id ELSE blocker_unit.parent_room_id END)
        = (CASE WHEN corrected_unit.kind = 'ROOM' THEN corrected_unit.id ELSE corrected_unit.parent_room_id END)
    WHERE correction.created_by_command_id = target_command_id
      AND (
        corrected_unit.kind = 'ROOM'
        OR blocker_unit.kind = 'ROOM'
        OR blocker_unit.id = corrected_unit.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN inventory_units AS corrected_unit
      ON corrected_unit.id = correction.corrected_inventory_unit_id
    JOIN internal_use_blocks AS blocker
      ON blocker.property_id = correction.property_id
      AND blocker.status = 'ACTIVE'
      AND blocker.arrival_date < correction.corrected_departure_date
      AND blocker.departure_date > correction.corrected_arrival_date
      AND blocker.room_id = CASE
        WHEN corrected_unit.kind = 'ROOM' THEN corrected_unit.id
        ELSE corrected_unit.parent_room_id
      END
    JOIN inventory_units AS blocker_unit
      ON blocker_unit.id = blocker.inventory_unit_id
    WHERE correction.created_by_command_id = target_command_id
      AND (
        corrected_unit.kind = 'ROOM'
        OR blocker_unit.kind = 'ROOM'
        OR blocker_unit.id = corrected_unit.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN inventory_units AS corrected_unit
      ON corrected_unit.id = correction.corrected_inventory_unit_id
    JOIN properties AS correction_property
      ON correction_property.id = correction.property_id
    JOIN orders AS blocker_order
      ON blocker_order.property_id = correction.property_id
      AND blocker_order.status IN ('RESERVED', 'CHECKED_IN')
    JOIN stays AS blocker_stay
      ON blocker_stay.order_id = blocker_order.id
      AND (
        (blocker_order.status = 'RESERVED' AND blocker_stay.status = 'PLANNED')
        OR (blocker_order.status = 'CHECKED_IN' AND blocker_stay.status = 'IN_HOUSE')
      )
    JOIN stay_segments AS blocker_segment
      ON blocker_segment.stay_id = blocker_stay.id
      AND NOT EXISTS (
        SELECT 1
        FROM stay_segments AS later_segment
        WHERE later_segment.stay_id = blocker_segment.stay_id
          AND later_segment.sequence > blocker_segment.sequence
      )
    JOIN inventory_units AS blocker_unit
      ON blocker_unit.id = blocker_segment.inventory_unit_id
      AND (CASE WHEN blocker_unit.kind = 'ROOM' THEN blocker_unit.id ELSE blocker_unit.parent_room_id END)
        = (CASE WHEN corrected_unit.kind = 'ROOM' THEN corrected_unit.id ELSE corrected_unit.parent_room_id END)
    WHERE correction.created_by_command_id = target_command_id
      AND blocker_order.id <> correction.order_id
      AND blocker_segment.arrival_date < correction.corrected_departure_date
      AND (
        CASE WHEN blocker_order.status = 'CHECKED_IN'
          AND blocker_segment.departure_date =
            (transaction_timestamp() AT TIME ZONE correction_property.timezone)::date
          THEN blocker_segment.departure_date + 1
          ELSE blocker_segment.departure_date
        END
      ) > correction.corrected_arrival_date
      AND (
        corrected_unit.kind = 'ROOM'
        OR blocker_unit.kind = 'ROOM'
        OR blocker_unit.id = corrected_unit.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM historical_stay_arrangement_corrections AS set_correction
        WHERE set_correction.created_by_command_id = target_command_id
          AND set_correction.order_id = blocker_order.id
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction overlaps an outside active occupancy or unavailable blocker'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_outside_active_blocker';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS correction
    JOIN inventory_units AS corrected_unit
      ON corrected_unit.id = correction.corrected_inventory_unit_id
    JOIN orders AS blocker_order
      ON blocker_order.property_id = correction.property_id
      AND blocker_order.status = 'CHECKED_OUT'
    JOIN stays AS blocker_stay
      ON blocker_stay.order_id = blocker_order.id
      AND blocker_stay.status = 'COMPLETED'
    JOIN LATERAL (
      SELECT timeline_item.value ->> 'serviceDate' AS service_date,
        timeline_item.value ->> 'inventoryUnitId' AS inventory_unit_id
      FROM (
        SELECT COALESCE(
            arrangement_amendment.payload #> '{after,stayTimeline}',
            arrangement_amendment.payload -> 'stayTimeline'
          ) AS stay_timeline
        FROM amendments AS arrangement_amendment
        WHERE arrangement_amendment.order_id = blocker_order.id
          AND arrangement_amendment.amendment_type IN (
            'RESCHEDULE_STAY',
            'EXTEND_STAY',
            'SHORTEN_STAY',
            'MOVE_UNIT',
            'CORRECT_HISTORICAL_STAY_ARRANGEMENT'
          )
          AND jsonb_typeof(COALESCE(
            arrangement_amendment.payload #> '{after,stayTimeline}',
            arrangement_amendment.payload -> 'stayTimeline'
          )) = 'array'
        ORDER BY arrangement_amendment.sequence DESC
        LIMIT 1
      ) AS final_arrangement
      CROSS JOIN LATERAL jsonb_array_elements(final_arrangement.stay_timeline) AS timeline_item(value)

      UNION ALL

      SELECT fallback_date.service_date::date::text,
        fallback_segment.inventory_unit_id
      FROM stay_segments AS fallback_segment
      CROSS JOIN LATERAL generate_series(
        fallback_segment.arrival_date,
        fallback_segment.departure_date - 1,
        interval '1 day'
      ) AS fallback_date(service_date)
      WHERE fallback_segment.stay_id = blocker_stay.id
        AND NOT EXISTS (
          SELECT 1
          FROM stay_segments AS later_segment
          WHERE later_segment.stay_id = fallback_segment.stay_id
            AND later_segment.sequence > fallback_segment.sequence
        )
        AND NOT EXISTS (
          SELECT 1
          FROM amendments AS arrangement_amendment
          WHERE arrangement_amendment.order_id = blocker_order.id
            AND arrangement_amendment.amendment_type IN (
              'RESCHEDULE_STAY',
              'EXTEND_STAY',
              'SHORTEN_STAY',
              'MOVE_UNIT',
              'CORRECT_HISTORICAL_STAY_ARRANGEMENT'
            )
            AND jsonb_typeof(COALESCE(
              arrangement_amendment.payload #> '{after,stayTimeline}',
              arrangement_amendment.payload -> 'stayTimeline'
            )) = 'array'
        )
    ) AS blocker_day ON true
    JOIN inventory_units AS blocker_unit
      ON blocker_unit.id = blocker_day.inventory_unit_id
      AND (CASE WHEN blocker_unit.kind = 'ROOM' THEN blocker_unit.id ELSE blocker_unit.parent_room_id END)
        = (CASE WHEN corrected_unit.kind = 'ROOM' THEN corrected_unit.id ELSE corrected_unit.parent_room_id END)
    WHERE correction.created_by_command_id = target_command_id
      AND blocker_day.service_date::date >= correction.corrected_arrival_date
      AND blocker_day.service_date::date < correction.corrected_departure_date
      AND (
        corrected_unit.kind = 'ROOM'
        OR blocker_unit.kind = 'ROOM'
        OR blocker_unit.id = corrected_unit.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM historical_stay_arrangement_corrections AS set_correction
        WHERE set_correction.created_by_command_id = target_command_id
          AND set_correction.order_id = blocker_order.id
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction overlaps an outside completed stay projection'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_outside_completed_overlap';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM historical_stay_arrangement_corrections AS left_correction
    JOIN inventory_units AS left_unit
      ON left_unit.id = left_correction.corrected_inventory_unit_id
    JOIN historical_stay_arrangement_corrections AS right_correction
      ON right_correction.created_by_command_id = left_correction.created_by_command_id
      AND right_correction.id < left_correction.id
    JOIN inventory_units AS right_unit
      ON right_unit.id = right_correction.corrected_inventory_unit_id
    WHERE left_correction.created_by_command_id = target_command_id
      AND left_correction.corrected_arrival_date < right_correction.corrected_departure_date
      AND right_correction.corrected_arrival_date < left_correction.corrected_departure_date
      AND (CASE WHEN left_unit.kind = 'ROOM' THEN left_unit.id ELSE left_unit.parent_room_id END)
        = (CASE WHEN right_unit.kind = 'ROOM' THEN right_unit.id ELSE right_unit.parent_room_id END)
      AND (
        left_unit.kind = 'ROOM'
        OR right_unit.kind = 'ROOM'
        OR left_unit.id = right_unit.id
      )
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction final set contains an internal inventory overlap'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_final_set_overlap';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM collection_facts AS fact
    WHERE fact.command_id = target_command_id
  ) OR EXISTS (
    SELECT 1
    FROM entitlement_ledger AS ledger
    WHERE ledger.command_id = target_command_id
  ) OR EXISTS (
    SELECT 1
    FROM coverage_items AS coverage
    JOIN historical_stay_arrangement_corrections AS correction
      ON correction.order_id = coverage.order_id
    WHERE correction.created_by_command_id = target_command_id
      AND coverage.xmin = target_xid
  ) THEN
    RAISE EXCEPTION 'historical stay arrangement correction must not mutate funds or entitlement facts'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_stay_correction_no_funds_or_entitlements';
  END IF;
END;
$$;

-- Row locking immutable baselines requires one column-level UPDATE privilege.
-- Their append-only triggers still reject every attempted mutation by runtime.
GRANT UPDATE (created_at) ON
  stay_segments,
  pricing_revisions,
  collection_facts,
  entitlement_ledger
TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_validate_historical_stay_arrangement_correction_execution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM qintopia_assert_historical_stay_arrangement_correction_command(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'amendments' THEN
      target_command_id := NEW.command_id;
    WHEN 'stay_segments' THEN
      SELECT amendment.command_id
        INTO target_command_id
        FROM amendments AS amendment
        WHERE amendment.id = NEW.amendment_id;
    WHEN 'pricing_revisions' THEN
      SELECT amendment.command_id
        INTO target_command_id
        FROM amendments AS amendment
        WHERE amendment.id = NEW.amendment_id;
    ELSE
      target_command_id := NEW.created_by_command_id;
  END CASE;
  PERFORM qintopia_assert_historical_stay_arrangement_correction_command(target_command_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS command_executions_validate_historical_stay_arrangement_correction ON command_executions;
CREATE CONSTRAINT TRIGGER command_executions_validate_historical_stay_arrangement_correction
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_execution();

DROP TRIGGER IF EXISTS amendments_validate_historical_stay_arrangement_correction_chain ON amendments;
CREATE CONSTRAINT TRIGGER amendments_validate_historical_stay_arrangement_correction_chain
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.command_id IS NOT NULL)
EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child();

DROP TRIGGER IF EXISTS stay_segments_validate_historical_stay_arrangement_correction_chain ON stay_segments;
CREATE CONSTRAINT TRIGGER stay_segments_validate_historical_stay_arrangement_correction_chain
AFTER INSERT ON stay_segments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child();

DROP TRIGGER IF EXISTS pricing_revisions_validate_historical_stay_arrangement_correction_chain ON pricing_revisions;
CREATE CONSTRAINT TRIGGER pricing_revisions_validate_historical_stay_arrangement_correction_chain
AFTER INSERT ON pricing_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child();

DROP TRIGGER IF EXISTS historical_stay_arrangement_corrections_validate_chain ON historical_stay_arrangement_corrections;
CREATE CONSTRAINT TRIGGER historical_stay_arrangement_corrections_validate_chain
AFTER INSERT ON historical_stay_arrangement_corrections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_stay_arrangement_correction_child();

DO $$
DECLARE
  function_definition text;
  old_fragment text := $fragment$
      OR (execution.command_type = 'COMPLETE_STAY' AND amendment.amendment_type = 'CHECK_OUT')
$fragment$;
  new_fragment text := $fragment$
      OR (execution.command_type = 'COMPLETE_STAY' AND amendment.amendment_type = 'CHECK_OUT')
      OR (execution.command_type = 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS'
        AND amendment.amendment_type = 'CORRECT_HISTORICAL_STAY_ARRANGEMENT')
$fragment$;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_order_projection_update()'::regprocedure)
    INTO STRICT function_definition;
  IF position(old_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 049 could not locate the runtime order projection command mapping';
  END IF;
  EXECUTE replace(function_definition, old_fragment, new_fragment);
  IF pg_get_functiondef('qintopia_guard_runtime_order_projection_update()'::regprocedure)
      NOT LIKE '%CORRECT_HISTORICAL_STAY_ARRANGEMENT%' THEN
    RAISE EXCEPTION 'migration 049 did not add the runtime order projection mapping';
  END IF;
END;
$$;

DO $$
DECLARE
  function_definition text;
  old_claim_create_fragment text := $fragment$
          WHERE claim.id = source_claim_id
            AND claim.active
            AND claim.xmin = current_xid
            AND amendment.xmin = current_xid
$fragment$;
  new_claim_create_fragment text := $fragment$
          WHERE claim.id = source_claim_id
            AND claim.xmin = current_xid
            AND amendment.xmin = current_xid
$fragment$;
  old_claim_release_fragment text := $fragment$
          JOIN amendments AS amendment
            ON amendment.order_id = stay_row.order_id
            AND amendment.xmin = current_xid
          WHERE claim.id = source_claim_id
            AND NOT claim.active
            AND claim.xmin = current_xid
          ORDER BY amendment.sequence DESC
$fragment$;
  new_claim_release_fragment text := $fragment$
          JOIN amendments AS amendment
            ON amendment.order_id = stay_row.order_id
            AND amendment.xmin = current_xid
          LEFT JOIN historical_stay_arrangement_corrections AS correction
            ON correction.stay_segment_id = segment.id
            AND correction.amendment_id = amendment.id
            AND correction.created_by_command_id = amendment.command_id
            AND correction.xmin = current_xid
          WHERE claim.id = source_claim_id
            AND NOT claim.active
            AND claim.xmin = current_xid
            AND (
              amendment.amendment_type IS DISTINCT FROM 'CORRECT_HISTORICAL_STAY_ARRANGEMENT'
              OR (
                amendment.id = segment.amendment_id
                AND correction.id IS NOT NULL
                AND segment.xmin = current_xid
              )
            )
          ORDER BY amendment.sequence DESC
$fragment$;
  old_fragment text := $fragment$
      'CHECK_IN', 'CHECK_OUT', 'COMPLETE_STAY', 'LOCK_MAINTENANCE',
      'RELEASE_MAINTENANCE'
$fragment$;
  new_fragment text := $fragment$
      'CHECK_IN', 'CHECK_OUT', 'COMPLETE_STAY', 'LOCK_MAINTENANCE',
      'RELEASE_MAINTENANCE', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS'
$fragment$;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
    INTO STRICT function_definition;
  IF position(old_claim_create_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 049 could not locate the runtime Claim creation evidence query';
  END IF;
  function_definition := replace(
    function_definition,
    old_claim_create_fragment,
    new_claim_create_fragment
  );
  IF position(old_claim_release_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 049 could not locate the runtime Claim release evidence query';
  END IF;
  function_definition := replace(
    function_definition,
    old_claim_release_fragment,
    new_claim_release_fragment
  );
  IF position(old_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 049 could not locate the runtime room-status command allowlist';
  END IF;
  EXECUTE replace(function_definition, old_fragment, new_fragment);
  IF pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
      NOT LIKE '%CORRECT_HISTORICAL_STAY_ARRANGEMENTS%'
    OR pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
      NOT LIKE '%correction.stay_segment_id = segment.id%'
    OR position(
      new_claim_create_fragment
      IN pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
    ) = 0 THEN
    RAISE EXCEPTION 'migration 049 did not add the runtime room-status command allowlist entry';
  END IF;
END;
$$;
