LOCK TABLE orders, stays, amendments, stay_segments, pricing_revisions, inventory_claims,
  member_contracts, entitlement_lots, coverage_items, entitlement_ledger
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE migration_import_runs (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  source_system text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  manifest_hash char(64) NOT NULL,
  correlation_id text NOT NULL,
  cutover_observed_at timestamptz NOT NULL,
  cutover_business_date date NOT NULL,
  state text NOT NULL,
  input_summary jsonb NOT NULL,
  reconciliation_summary jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_import_runs_id_property_unique UNIQUE (id, property_id),
  CONSTRAINT migration_import_runs_identity_key
    UNIQUE (property_id, source_system, idempotency_key),
  CONSTRAINT migration_import_runs_source_system_nonblank
    CHECK (btrim(source_system) <> ''),
  CONSTRAINT migration_import_runs_idempotency_key_nonblank
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT migration_import_runs_correlation_nonblank
    CHECK (btrim(correlation_id) <> ''),
  CONSTRAINT migration_import_runs_request_hash_shape
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_import_runs_manifest_hash_shape
    CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_import_runs_state_check
    CHECK (state IN ('EXECUTING', 'APPLIED')),
  CONSTRAINT migration_import_runs_completion_shape CHECK (
    (state = 'EXECUTING' AND reconciliation_summary IS NULL AND completed_at IS NULL)
    OR (state = 'APPLIED' AND reconciliation_summary IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT migration_import_runs_input_summary_object
    CHECK (jsonb_typeof(input_summary) = 'object'),
  CONSTRAINT migration_import_runs_reconciliation_summary_object
    CHECK (reconciliation_summary IS NULL OR jsonb_typeof(reconciliation_summary) = 'object')
);

CREATE TABLE migration_import_files (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES migration_import_runs(id),
  source_role text NOT NULL,
  file_name text NOT NULL,
  sha256 char(64) NOT NULL,
  exported_at timestamptz,
  row_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_import_files_run_role_key UNIQUE (run_id, source_role),
  CONSTRAINT migration_import_files_source_role_nonblank CHECK (btrim(source_role) <> ''),
  CONSTRAINT migration_import_files_file_name_nonblank CHECK (btrim(file_name) <> ''),
  CONSTRAINT migration_import_files_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_import_files_row_count_nonnegative CHECK (row_count IS NULL OR row_count >= 0)
);

CREATE TABLE migration_order_sources (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES migration_import_runs(id),
  property_id text NOT NULL REFERENCES properties(id),
  source_system text NOT NULL,
  source_order_id text NOT NULL,
  source_row integer NOT NULL,
  disposition text NOT NULL,
  raw_channel text,
  mapped_channel_code text,
  channel_order_reference text,
  channel_reference_missing_reason text,
  arrival_date date,
  departure_date date,
  observed_order_status text,
  observed_stay_status text,
  stay_type text,
  pricing_basis text,
  guest_snapshot jsonb NOT NULL,
  historical_actual_amount_minor integer NOT NULL,
  currency char(3) NOT NULL,
  operational_snapshot_payload jsonb,
  canonical_payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  manual_confirmation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_order_sources_source_key
    UNIQUE (property_id, source_system, source_order_id),
  CONSTRAINT migration_order_sources_id_property_unique UNIQUE (id, property_id),
  CONSTRAINT migration_order_sources_run_property_fk
    FOREIGN KEY (run_id, property_id)
    REFERENCES migration_import_runs(id, property_id),
  CONSTRAINT migration_order_sources_source_system_nonblank CHECK (btrim(source_system) <> ''),
  CONSTRAINT migration_order_sources_order_id_nonblank CHECK (btrim(source_order_id) <> ''),
  CONSTRAINT migration_order_sources_source_row_positive CHECK (source_row > 0),
  CONSTRAINT migration_order_sources_disposition_check CHECK (
    disposition IN ('HISTORICAL_ACCOMMODATION', 'OPERATIONAL', 'NON_ACCOMMODATION')
  ),
  CONSTRAINT migration_order_sources_mapped_channel_check CHECK (
    mapped_channel_code IS NULL OR mapped_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN', 'WECOM')
  ),
  CONSTRAINT migration_order_sources_channel_reference_nonblank CHECK (
    channel_order_reference IS NULL OR btrim(channel_order_reference) <> ''
  ),
  CONSTRAINT migration_order_sources_missing_reason_check CHECK (
    channel_reference_missing_reason IS NULL
    OR channel_reference_missing_reason = 'HISTORICAL_NOT_RECORDED'
  ),
  CONSTRAINT migration_order_sources_channel_reference_reason_shape CHECK (
    channel_order_reference IS NULL OR channel_reference_missing_reason IS NULL
  ),
  CONSTRAINT migration_order_sources_pricing_basis_check CHECK (
    pricing_basis IS NULL OR pricing_basis IN (
      'POLICY', 'CHANNEL_CONTRACT', 'MANUAL_ADJUSTMENT', 'MEMBER_ENTITLEMENT', 'FREE'
    )
  ),
  CONSTRAINT migration_order_sources_observed_order_status_check CHECK (
    observed_order_status IS NULL OR observed_order_status IN ('RESERVED', 'CHECKED_IN')
  ),
  CONSTRAINT migration_order_sources_observed_stay_status_check CHECK (
    observed_stay_status IS NULL OR observed_stay_status IN ('PLANNED', 'IN_HOUSE')
  ),
  CONSTRAINT migration_order_sources_dates_shape CHECK (
    (arrival_date IS NULL AND departure_date IS NULL)
    OR (arrival_date IS NOT NULL AND departure_date > arrival_date)
  ),
  CONSTRAINT migration_order_sources_operational_shape CHECK (
    (
      disposition = 'OPERATIONAL'
      AND arrival_date IS NOT NULL
      AND departure_date IS NOT NULL
      AND observed_order_status IS NOT NULL
      AND observed_stay_status IS NOT NULL
      AND stay_type IS NOT NULL
      AND pricing_basis IS NOT NULL
      AND operational_snapshot_payload IS NOT NULL
    ) OR (
      disposition <> 'OPERATIONAL'
      AND observed_order_status IS NULL
      AND observed_stay_status IS NULL
      AND operational_snapshot_payload IS NULL
    )
  ),
  CONSTRAINT migration_order_sources_guest_snapshot_object
    CHECK (jsonb_typeof(guest_snapshot) = 'object'),
  CONSTRAINT migration_order_sources_amount_nonnegative
    CHECK (historical_actual_amount_minor >= 0),
  CONSTRAINT migration_order_sources_payload_hash_shape
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_order_sources_canonical_payload_object
    CHECK (jsonb_typeof(canonical_payload) = 'object'),
  CONSTRAINT migration_order_sources_manual_confirmation_object
    CHECK (jsonb_typeof(manual_confirmation) = 'object')
);

CREATE TABLE historical_order_archives (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  property_id text NOT NULL,
  record_kind text NOT NULL,
  source_order_id text NOT NULL,
  guest_full_name text,
  guest_nickname text,
  guest_phone text,
  mapped_channel_code text,
  channel_order_reference text,
  channel_reference_missing_reason text,
  arrival_date date,
  departure_date date,
  stay_type text,
  source_status text,
  historical_actual_amount_minor integer NOT NULL,
  lodging_subtotal_minor integer,
  checkout_amount_minor integer,
  amount_difference_reason text,
  currency char(3) NOT NULL,
  canonical_payload jsonb NOT NULL,
  allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT historical_order_archives_source_unique UNIQUE (source_id),
  CONSTRAINT historical_order_archives_source_property_fk
    FOREIGN KEY (source_id, property_id)
    REFERENCES migration_order_sources(id, property_id),
  CONSTRAINT historical_order_archives_record_kind_check CHECK (
    record_kind IN ('MIGRATED_ARCHIVE', 'NON_ACCOMMODATION_ARCHIVE')
  ),
  CONSTRAINT historical_order_archives_source_order_nonblank CHECK (btrim(source_order_id) <> ''),
  CONSTRAINT historical_order_archives_dates_shape CHECK (
    (arrival_date IS NULL AND departure_date IS NULL)
    OR (arrival_date IS NOT NULL AND departure_date > arrival_date)
  ),
  CONSTRAINT historical_order_archives_amount_nonnegative
    CHECK (historical_actual_amount_minor >= 0),
  CONSTRAINT historical_order_archives_lodging_subtotal_nonnegative
    CHECK (lodging_subtotal_minor IS NULL OR lodging_subtotal_minor >= 0),
  CONSTRAINT historical_order_archives_checkout_amount_nonnegative
    CHECK (checkout_amount_minor IS NULL OR checkout_amount_minor >= 0),
  CONSTRAINT historical_order_archives_allowed_actions_empty
    CHECK (allowed_actions = '[]'::jsonb),
  CONSTRAINT historical_order_archives_payload_object
    CHECK (jsonb_typeof(canonical_payload) = 'object')
);

ALTER TABLE orders
  ADD COLUMN migration_source_id text,
  ADD CONSTRAINT orders_migration_source_unique UNIQUE (migration_source_id),
  ADD CONSTRAINT orders_migration_source_fk
    FOREIGN KEY (migration_source_id) REFERENCES migration_order_sources(id);

ALTER TABLE member_contracts
  ADD COLUMN migration_source_id text,
  ADD CONSTRAINT member_contracts_migration_source_unique UNIQUE (migration_source_id),
  ADD CONSTRAINT member_contracts_migration_source_fk
    FOREIGN KEY (migration_source_id) REFERENCES migration_order_sources(id);

ALTER TABLE entitlement_lots
  ADD COLUMN migration_source_id text,
  ADD CONSTRAINT entitlement_lots_migration_source_unique UNIQUE (migration_source_id),
  ADD CONSTRAINT entitlement_lots_migration_source_fk
    FOREIGN KEY (migration_source_id) REFERENCES migration_order_sources(id);

ALTER TABLE pricing_revisions
  ALTER COLUMN policy_base_amount_minor DROP NOT NULL,
  ADD COLUMN pricing_origin text NOT NULL DEFAULT 'STANDARD',
  ADD CONSTRAINT pricing_revisions_pricing_origin_shape CHECK (
    (
      pricing_origin = 'STANDARD'
      AND policy_base_amount_minor IS NOT NULL
      AND policy_base_amount_minor >= 0
    ) OR (
      pricing_origin IN ('MIGRATED_ACTUAL', 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER')
      AND policy_base_amount_minor IS NULL
      AND manual_adjustment_minor = 0
    )
  );

CREATE TABLE migration_order_targets (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  archive_id text,
  order_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_order_targets_source_unique UNIQUE (source_id),
  CONSTRAINT migration_order_targets_source_fk
    FOREIGN KEY (source_id) REFERENCES migration_order_sources(id),
  CONSTRAINT migration_order_targets_archive_unique UNIQUE (archive_id),
  CONSTRAINT migration_order_targets_order_unique UNIQUE (order_id),
  CONSTRAINT migration_order_targets_archive_fk
    FOREIGN KEY (archive_id) REFERENCES historical_order_archives(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT migration_order_targets_order_fk
    FOREIGN KEY (order_id) REFERENCES orders(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT migration_order_targets_exactly_one_target CHECK (
    (archive_id IS NOT NULL AND order_id IS NULL)
    OR (archive_id IS NULL AND order_id IS NOT NULL)
  )
);

CREATE TABLE migration_overdue_inventory_holds (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  order_id text NOT NULL,
  property_id text NOT NULL,
  room_id text NOT NULL REFERENCES inventory_units(id),
  inventory_unit_id text NOT NULL REFERENCES inventory_units(id),
  starts_on date NOT NULL,
  cutover_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_overdue_holds_source_unique UNIQUE (source_id),
  CONSTRAINT migration_overdue_holds_order_unique UNIQUE (order_id),
  CONSTRAINT migration_overdue_holds_source_property_fk
    FOREIGN KEY (source_id, property_id)
    REFERENCES migration_order_sources(id, property_id),
  CONSTRAINT migration_overdue_holds_order_fk
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE migration_overdue_inventory_hold_releases (
  id text PRIMARY KEY,
  hold_id text NOT NULL,
  source_id text NOT NULL,
  order_id text NOT NULL,
  command_id text NOT NULL,
  extension_segment_id text NOT NULL,
  pricing_revision_id text NOT NULL,
  new_departure_date date NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_overdue_releases_hold_unique UNIQUE (hold_id),
  CONSTRAINT migration_overdue_releases_source_unique UNIQUE (source_id),
  CONSTRAINT migration_overdue_releases_order_unique UNIQUE (order_id),
  CONSTRAINT migration_overdue_releases_command_unique UNIQUE (command_id),
  CONSTRAINT migration_overdue_releases_segment_unique UNIQUE (extension_segment_id),
  CONSTRAINT migration_overdue_releases_revision_unique UNIQUE (pricing_revision_id),
  CONSTRAINT migration_overdue_releases_hold_fk
    FOREIGN KEY (hold_id) REFERENCES migration_overdue_inventory_holds(id),
  CONSTRAINT migration_overdue_releases_source_fk
    FOREIGN KEY (source_id) REFERENCES migration_order_sources(id),
  CONSTRAINT migration_overdue_releases_order_fk
    FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT migration_overdue_releases_command_fk
    FOREIGN KEY (command_id) REFERENCES command_executions(id),
  CONSTRAINT migration_overdue_releases_segment_fk
    FOREIGN KEY (extension_segment_id) REFERENCES stay_segments(id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT migration_overdue_releases_revision_fk
    FOREIGN KEY (pricing_revision_id) REFERENCES pricing_revisions(id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX migration_order_sources_run_idx ON migration_order_sources (run_id, source_row);
CREATE INDEX historical_order_archives_search_idx
  ON historical_order_archives (property_id, arrival_date, departure_date, source_order_id);
CREATE INDEX historical_order_archives_guest_name_idx
  ON historical_order_archives (property_id, guest_full_name) WHERE guest_full_name IS NOT NULL;
CREATE INDEX historical_order_archives_guest_phone_idx
  ON historical_order_archives (property_id, guest_phone) WHERE guest_phone IS NOT NULL;
CREATE INDEX migration_overdue_holds_active_lookup_idx
  ON migration_overdue_inventory_holds (property_id, room_id, starts_on, inventory_unit_id);

CREATE OR REPLACE FUNCTION qintopia_protect_migration_import_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'migration import runs cannot be deleted'
      USING ERRCODE = '55000', CONSTRAINT = 'migration_import_runs_delete_forbidden';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.source_system IS DISTINCT FROM OLD.source_system
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.cutover_observed_at IS DISTINCT FROM OLD.cutover_observed_at
    OR NEW.cutover_business_date IS DISTINCT FROM OLD.cutover_business_date
    OR NEW.input_summary IS DISTINCT FROM OLD.input_summary
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'migration import run identity and input are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'migration_import_runs_identity_immutable';
  END IF;
  IF OLD.state IS DISTINCT FROM 'EXECUTING'
    OR NEW.state IS DISTINCT FROM 'APPLIED'
    OR OLD.reconciliation_summary IS NOT NULL
    OR OLD.completed_at IS NOT NULL
    OR NEW.reconciliation_summary IS NULL
    OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'migration import run only supports one EXECUTING to APPLIED transition'
      USING ERRCODE = '55000', CONSTRAINT = 'migration_import_runs_state_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER migration_import_runs_protect_state
BEFORE UPDATE OR DELETE ON migration_import_runs
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_migration_import_run();

CREATE TRIGGER migration_import_files_append_only
BEFORE UPDATE OR DELETE ON migration_import_files
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER migration_order_sources_append_only
BEFORE UPDATE OR DELETE ON migration_order_sources
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER historical_order_archives_append_only
BEFORE UPDATE OR DELETE ON historical_order_archives
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER migration_order_targets_append_only
BEFORE UPDATE OR DELETE ON migration_order_targets
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER migration_overdue_holds_append_only
BEFORE UPDATE OR DELETE ON migration_overdue_inventory_holds
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE TRIGGER migration_overdue_releases_append_only
BEFORE UPDATE OR DELETE ON migration_overdue_inventory_hold_releases
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE OR REPLACE FUNCTION qintopia_validate_migration_order_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_run migration_import_runs%ROWTYPE;
  snapshot jsonb;
  snapshot_key_count integer;
  timeline_count integer;
  snapshot_cutover timestamptz;
  snapshot_arrival date;
  snapshot_departure date;
  snapshot_amount integer;
  canonical_source_arrival date;
  canonical_source_departure date;
  expected_component_arrival date;
  canonical_point_count integer;
  canonical_unique_point_count integer;
BEGIN
  SELECT * INTO STRICT target_run FROM migration_import_runs WHERE id = NEW.run_id;
  IF target_run.property_id IS DISTINCT FROM NEW.property_id
    OR target_run.source_system IS DISTINCT FROM NEW.source_system THEN
    RAISE EXCEPTION 'migration source must match its import run property and source system'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_run_identity_match';
  END IF;
  IF NEW.channel_order_reference IS NOT NULL
    AND NEW.channel_order_reference IS DISTINCT FROM btrim(NEW.channel_order_reference) THEN
    RAISE EXCEPTION 'normalized migration channel reference cannot contain outer whitespace'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_channel_reference_normalized';
  END IF;
  IF jsonb_typeof(NEW.canonical_payload -> 'guest') IS DISTINCT FROM 'object'
    OR NEW.guest_snapshot IS DISTINCT FROM jsonb_build_object(
      'fullName', NEW.canonical_payload #> '{guest,name}',
      'nameProvenance', NEW.canonical_payload #> '{guest,nameProvenance}',
      'nickname', NEW.canonical_payload #> '{guest,nickname}',
      'nicknameProvenance', NEW.canonical_payload #> '{guest,nicknameProvenance}',
      'phone', NEW.canonical_payload #> '{guest,phone}',
      'phoneProvenance', NEW.canonical_payload #> '{guest,phoneProvenance}',
      'documentNumber', NULL
    )
    OR btrim(COALESCE(NEW.guest_snapshot ->> 'nameProvenance', '')) = ''
    OR btrim(COALESCE(NEW.guest_snapshot ->> 'nicknameProvenance', '')) = ''
    OR btrim(COALESCE(NEW.guest_snapshot ->> 'phoneProvenance', '')) = '' THEN
    RAISE EXCEPTION 'migration guest snapshot must exactly retain canonical identity provenance'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_guest_provenance_match';
  END IF;

  IF NEW.disposition <> 'OPERATIONAL' THEN
    IF NEW.canonical_payload ? 'operationalSnapshot' THEN
      RAISE EXCEPTION 'archive migration sources cannot claim an operational snapshot'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_archive_has_no_snapshot';
    END IF;
    RETURN NEW;
  END IF;

  snapshot := NEW.operational_snapshot_payload;
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
    OR NEW.canonical_payload -> 'operationalSnapshot' IS DISTINCT FROM snapshot THEN
    RAISE EXCEPTION 'operational snapshot must be an immutable member of the canonical payload'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_canonical_match';
  END IF;
  SELECT count(*)::integer INTO snapshot_key_count FROM jsonb_object_keys(snapshot);
  IF snapshot_key_count NOT IN (13, 14)
    OR NOT snapshot ?& ARRAY[
      'sourceId', 'sourceOrderId', 'cutoverObservedAt', 'observedStatus',
      'observedStayStatus', 'arrivalDate', 'departureDate', 'stayType',
      'pricingOrigin', 'historicalActualAmountMinor', 'currency',
      'stayTimeline', 'inventoryUnitId'
    ]
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(snapshot) AS snapshot_key(key)
      WHERE snapshot_key.key <> ALL(ARRAY[
        'sourceId', 'sourceOrderId', 'cutoverObservedAt', 'observedStatus',
        'observedStayStatus', 'arrivalDate', 'departureDate', 'stayType',
        'pricingOrigin', 'historicalActualAmountMinor', 'currency',
        'stayTimeline', 'inventoryUnitId', 'overdueHoldStartsOn'
      ])
    ) THEN
    RAISE EXCEPTION 'operational snapshot has an incomplete or unknown top-level field set'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_exact_keys';
  END IF;

  BEGIN
    snapshot_cutover := (snapshot ->> 'cutoverObservedAt')::timestamptz;
    snapshot_arrival := (snapshot ->> 'arrivalDate')::date;
    snapshot_departure := (snapshot ->> 'departureDate')::date;
    snapshot_amount := (snapshot ->> 'historicalActualAmountMinor')::integer;
    IF snapshot ? 'overdueHoldStartsOn' THEN
      PERFORM (snapshot ->> 'overdueHoldStartsOn')::date;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'operational snapshot contains an untyped timestamp, date, or amount'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_typed_values';
  END;

  IF snapshot ->> 'sourceId' IS DISTINCT FROM NEW.id
    OR snapshot ->> 'sourceOrderId' IS DISTINCT FROM NEW.source_order_id
    OR snapshot_cutover IS DISTINCT FROM target_run.cutover_observed_at
    OR snapshot ->> 'observedStatus' IS DISTINCT FROM NEW.observed_order_status
    OR snapshot ->> 'observedStayStatus' IS DISTINCT FROM NEW.observed_stay_status
    OR snapshot_arrival IS DISTINCT FROM NEW.arrival_date
    OR snapshot_departure IS DISTINCT FROM NEW.departure_date
    OR snapshot ->> 'stayType' IS DISTINCT FROM NEW.stay_type
    OR snapshot ->> 'pricingOrigin' IS DISTINCT FROM 'MIGRATED_ACTUAL'
    OR snapshot_amount IS DISTINCT FROM NEW.historical_actual_amount_minor
    OR snapshot ->> 'currency' IS DISTINCT FROM NEW.currency
    OR btrim(COALESCE(snapshot ->> 'inventoryUnitId', '')) = ''
    OR (NEW.observed_order_status = 'RESERVED' AND NEW.observed_stay_status <> 'PLANNED')
    OR (NEW.observed_order_status = 'CHECKED_IN' AND NEW.observed_stay_status <> 'IN_HOUSE') THEN
    RAISE EXCEPTION 'operational snapshot does not match its normalized migration source'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_normalized_match';
  END IF;

  IF jsonb_typeof(snapshot -> 'stayTimeline') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'operational snapshot requires a complete stay timeline'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_timeline_shape';
  END IF;
  SELECT count(*)::integer INTO timeline_count
  FROM jsonb_array_elements(snapshot -> 'stayTimeline');
  IF timeline_count < 1
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(snapshot -> 'stayTimeline')
        WITH ORDINALITY AS timeline(item, ordinality)
      LEFT JOIN inventory_units AS unit
        ON unit.id = timeline.item ->> 'inventoryUnitId'
      WHERE jsonb_typeof(timeline.item) IS DISTINCT FROM 'object'
        OR timeline.item IS DISTINCT FROM jsonb_build_object(
          'serviceDate', timeline.item ->> 'serviceDate',
          'inventoryUnitId', timeline.item ->> 'inventoryUnitId'
        )
        OR timeline.item ->> 'serviceDate' !~ '^\d{4}-\d{2}-\d{2}$'
        OR (timeline.item ->> 'serviceDate')::date < NEW.arrival_date
        OR (timeline.item ->> 'serviceDate')::date >= NEW.departure_date
        OR NULLIF(btrim(timeline.item ->> 'inventoryUnitId'), '') IS NULL
        OR timeline.item ->> 'inventoryUnitId' IS DISTINCT FROM
          btrim(timeline.item ->> 'inventoryUnitId')
        OR unit.id IS NULL
        OR unit.property_id IS DISTINCT FROM NEW.property_id
        OR unit.active IS NOT TRUE
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT
          timeline.ordinality,
          timeline.item ->> 'serviceDate' AS service_date,
          timeline.item ->> 'inventoryUnitId' AS inventory_unit_id,
          lag(timeline.item ->> 'serviceDate') OVER (
            ORDER BY timeline.ordinality
          ) AS previous_service_date,
          lag(timeline.item ->> 'inventoryUnitId') OVER (
            ORDER BY timeline.ordinality
          ) AS previous_inventory_unit_id
        FROM jsonb_array_elements(snapshot -> 'stayTimeline')
          WITH ORDINALITY AS timeline(item, ordinality)
      ) AS ordered_timeline
      WHERE ordered_timeline.ordinality > 1
        AND (
          ordered_timeline.service_date,
          ordered_timeline.inventory_unit_id
        ) <= (
          ordered_timeline.previous_service_date,
          ordered_timeline.previous_inventory_unit_id
        )
    )
    OR snapshot -> 'stayTimeline' -> 0 ->> 'serviceDate'
      IS DISTINCT FROM NEW.arrival_date::text
    OR snapshot -> 'stayTimeline' -> (timeline_count - 1) ->> 'serviceDate'
      IS DISTINCT FROM (NEW.departure_date - 1)::text
    OR snapshot ->> 'inventoryUnitId' IS DISTINCT FROM
      snapshot -> 'stayTimeline' -> (timeline_count - 1) ->> 'inventoryUnitId' THEN
    RAISE EXCEPTION 'operational snapshot stay timeline must be a sorted, unique, sellable, edge-anchored set'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_timeline_shape';
  END IF;

  IF jsonb_typeof(NEW.canonical_payload -> 'sourceStay') IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW.canonical_payload -> 'segments') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.canonical_payload -> 'segments') < 1 THEN
    RAISE EXCEPTION 'operational canonical payload requires source stay and segment evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_current_component_match';
  END IF;
  canonical_source_arrival := (NEW.canonical_payload #>> '{sourceStay,arrivalDate}')::date;
  canonical_source_departure := (NEW.canonical_payload #>> '{sourceStay,departureDate}')::date;
  IF canonical_source_arrival::text IS DISTINCT FROM
      NEW.canonical_payload #>> '{sourceStay,arrivalDate}'
    OR canonical_source_departure::text IS DISTINCT FROM
      NEW.canonical_payload #>> '{sourceStay,departureDate}'
    OR canonical_source_departure <= canonical_source_arrival
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.canonical_payload -> 'segments') AS segment(value)
      LEFT JOIN inventory_units AS unit
        ON unit.property_id = NEW.property_id
        AND unit.code = segment.value ->> 'inventoryUnitCode'
      WHERE jsonb_typeof(segment.value) IS DISTINCT FROM 'object'
        OR NULLIF(segment.value ->> 'arrivalDate', '') IS NULL
        OR NULLIF(segment.value ->> 'departureDate', '') IS NULL
        OR segment.value ->> 'arrivalDate' !~ '^\d{4}-\d{2}-\d{2}$'
        OR segment.value ->> 'departureDate' !~ '^\d{4}-\d{2}-\d{2}$'
        OR (segment.value ->> 'arrivalDate')::date::text
          IS DISTINCT FROM segment.value ->> 'arrivalDate'
        OR (segment.value ->> 'departureDate')::date::text
          IS DISTINCT FROM segment.value ->> 'departureDate'
        OR (segment.value ->> 'departureDate')::date
          <= (segment.value ->> 'arrivalDate')::date
        OR (segment.value ->> 'arrivalDate')::date < canonical_source_arrival
        OR (segment.value ->> 'departureDate')::date > canonical_source_departure
        OR NULLIF(btrim(segment.value ->> 'inventoryUnitCode'), '') IS NULL
        OR segment.value ->> 'inventoryUnitCode' IS DISTINCT FROM
          btrim(segment.value ->> 'inventoryUnitCode')
        OR unit.id IS NULL
        OR unit.active IS NOT TRUE
    ) THEN
    RAISE EXCEPTION 'operational canonical source stay or segment evidence is malformed'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_current_component_match';
  END IF;

  SELECT COALESCE(
    max(expected.service_date)::date + 1,
    canonical_source_arrival
  ) INTO expected_component_arrival
  FROM generate_series(
    canonical_source_arrival,
    canonical_source_departure - 1,
    interval '1 day'
  ) AS expected(service_date)
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.canonical_payload -> 'segments') AS segment(value)
    WHERE (segment.value ->> 'arrivalDate')::date <= expected.service_date::date
      AND (segment.value ->> 'departureDate')::date > expected.service_date::date
  );

  SELECT
    count(*)::integer,
    count(DISTINCT (point.service_date, point.inventory_unit_id))::integer
  INTO canonical_point_count, canonical_unique_point_count
  FROM (
    SELECT
      day.service_date::date AS service_date,
      unit.id AS inventory_unit_id
    FROM jsonb_array_elements(NEW.canonical_payload -> 'segments') AS segment(value)
    JOIN inventory_units AS unit
      ON unit.property_id = NEW.property_id
      AND unit.code = segment.value ->> 'inventoryUnitCode'
    CROSS JOIN LATERAL generate_series(
      (segment.value ->> 'arrivalDate')::date,
      (segment.value ->> 'departureDate')::date - 1,
      interval '1 day'
    ) AS day(service_date)
    WHERE day.service_date::date >= expected_component_arrival
      AND day.service_date::date < canonical_source_departure
  ) AS point;

  IF expected_component_arrival >= canonical_source_departure
    OR snapshot_arrival IS DISTINCT FROM expected_component_arrival
    OR snapshot_departure IS DISTINCT FROM canonical_source_departure
    OR canonical_point_count IS DISTINCT FROM canonical_unique_point_count
    OR canonical_point_count IS DISTINCT FROM timeline_count
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT
          day.service_date::date AS service_date,
          unit.id AS inventory_unit_id
        FROM jsonb_array_elements(NEW.canonical_payload -> 'segments') AS segment(value)
        JOIN inventory_units AS unit
          ON unit.property_id = NEW.property_id
          AND unit.code = segment.value ->> 'inventoryUnitCode'
        CROSS JOIN LATERAL generate_series(
          (segment.value ->> 'arrivalDate')::date,
          (segment.value ->> 'departureDate')::date - 1,
          interval '1 day'
        ) AS day(service_date)
        WHERE day.service_date::date >= expected_component_arrival
          AND day.service_date::date < canonical_source_departure
      ) AS expected_point
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(snapshot -> 'stayTimeline') AS item(value)
        WHERE item.value ->> 'serviceDate' = expected_point.service_date::text
          AND item.value ->> 'inventoryUnitId' = expected_point.inventory_unit_id
      )
    )
    OR (
      NEW.observed_order_status = 'CHECKED_IN'
      AND NOT (
        (
          NOT (snapshot ? 'overdueHoldStartsOn')
          AND snapshot_arrival <= target_run.cutover_business_date
          AND target_run.cutover_business_date < snapshot_departure
        )
        OR (
          snapshot ? 'overdueHoldStartsOn'
          AND snapshot_departure <= target_run.cutover_business_date
        )
      )
    )
    OR (
      NEW.observed_order_status = 'RESERVED'
      AND (
        snapshot ? 'overdueHoldStartsOn'
        OR snapshot_arrival < target_run.cutover_business_date
      )
    )
    OR (
      snapshot ? 'overdueHoldStartsOn'
      AND (snapshot ->> 'overdueHoldStartsOn')::date IS DISTINCT FROM snapshot_departure
    ) THEN
    RAISE EXCEPTION 'operational snapshot must exactly project the canonical current component'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_current_component_match';
  END IF;

  IF NEW.pricing_basis IN ('MEMBER_ENTITLEMENT', 'FREE') THEN
    IF NEW.mapped_channel_code IS NOT NULL
      OR NEW.channel_order_reference IS NOT NULL
      OR NEW.channel_reference_missing_reason IS NOT NULL
      OR NEW.historical_actual_amount_minor <> 0 THEN
      RAISE EXCEPTION 'member and free migration snapshots cannot claim a channel or cash price'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_non_cash_identity';
    END IF;
  ELSIF NEW.mapped_channel_code IS NULL THEN
    RAISE EXCEPTION 'paid migration snapshots require a mapped channel'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_paid_channel_required';
  ELSIF NEW.mapped_channel_code = 'WECOM' THEN
    IF NEW.channel_order_reference IS NOT NULL OR NEW.channel_reference_missing_reason IS NOT NULL THEN
      RAISE EXCEPTION 'WECOM migration snapshots cannot claim a channel order reference'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_wecom_reference_null';
    END IF;
  ELSIF NEW.channel_order_reference IS NULL
    AND NEW.channel_reference_missing_reason IS DISTINCT FROM 'HISTORICAL_NOT_RECORDED' THEN
    RAISE EXCEPTION 'missing external channel references require historical-not-recorded provenance'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_external_missing_reason';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN SQLSTATE '23514' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'operational migration source is malformed'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_snapshot_typed_values';
END;
$$;

CREATE TRIGGER migration_order_sources_validate_insert
BEFORE INSERT ON migration_order_sources
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_order_source();

CREATE OR REPLACE FUNCTION qintopia_validate_historical_order_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_source migration_order_sources%ROWTYPE;
  expected_kind text;
BEGIN
  SELECT * INTO STRICT target_source FROM migration_order_sources WHERE id = NEW.source_id;
  expected_kind := CASE target_source.disposition
    WHEN 'HISTORICAL_ACCOMMODATION' THEN 'MIGRATED_ARCHIVE'
    WHEN 'NON_ACCOMMODATION' THEN 'NON_ACCOMMODATION_ARCHIVE'
    ELSE NULL
  END;
  IF expected_kind IS NULL
    OR NEW.property_id IS DISTINCT FROM target_source.property_id
    OR NEW.record_kind IS DISTINCT FROM expected_kind
    OR NEW.source_order_id IS DISTINCT FROM target_source.source_order_id
    OR NEW.guest_full_name IS DISTINCT FROM target_source.guest_snapshot ->> 'fullName'
    OR NEW.guest_nickname IS DISTINCT FROM target_source.guest_snapshot ->> 'nickname'
    OR NEW.guest_phone IS DISTINCT FROM target_source.guest_snapshot ->> 'phone'
    OR NEW.mapped_channel_code IS DISTINCT FROM target_source.mapped_channel_code
    OR NEW.channel_order_reference IS DISTINCT FROM target_source.channel_order_reference
    OR NEW.channel_reference_missing_reason IS DISTINCT FROM target_source.channel_reference_missing_reason
    OR NEW.arrival_date IS DISTINCT FROM target_source.arrival_date
    OR NEW.departure_date IS DISTINCT FROM target_source.departure_date
    OR NEW.stay_type IS DISTINCT FROM target_source.stay_type
    OR NEW.historical_actual_amount_minor IS DISTINCT FROM target_source.historical_actual_amount_minor
    OR NEW.currency IS DISTINCT FROM target_source.currency
    OR NEW.canonical_payload IS DISTINCT FROM target_source.canonical_payload
    OR NEW.allowed_actions IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'historical archive must be an exact read-only projection of its source'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_order_archives_source_projection_match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER historical_order_archives_validate_insert
BEFORE INSERT ON historical_order_archives
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_order_archive();

CREATE OR REPLACE FUNCTION qintopia_validate_migrated_order_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_source migration_order_sources%ROWTYPE;
  policy_property_id text;
BEGIN
  IF NEW.migration_source_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT target_source
    FROM migration_order_sources WHERE id = NEW.migration_source_id;
  SELECT property_id INTO policy_property_id
    FROM pricing_policy_versions WHERE id = NEW.pricing_policy_version_id;
  IF target_source.disposition IS DISTINCT FROM 'OPERATIONAL'
    OR NEW.property_id IS DISTINCT FROM target_source.property_id
    OR NEW.status IS DISTINCT FROM target_source.observed_order_status
    OR NEW.arrival_date IS DISTINCT FROM target_source.arrival_date
    OR NEW.departure_date IS DISTINCT FROM target_source.departure_date
    OR NEW.stay_type IS DISTINCT FROM target_source.stay_type
    OR NEW.primary_guest_snapshot IS DISTINCT FROM target_source.guest_snapshot
    OR NEW.booking_channel_code IS DISTINCT FROM target_source.mapped_channel_code
    OR NEW.channel_order_reference IS DISTINCT FROM target_source.channel_order_reference
    OR policy_property_id IS DISTINCT FROM NEW.property_id THEN
    RAISE EXCEPTION 'migrated operational order must match its immutable source snapshot'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_migration_source_snapshot_match';
  END IF;
  IF target_source.pricing_basis = 'MEMBER_ENTITLEMENT' THEN
    IF NEW.member_id IS NOT NULL OR NEW.member_contract_id IS NULL
      OR NEW.booking_channel_code IS NOT NULL OR NEW.channel_order_reference IS NOT NULL THEN
      RAISE EXCEPTION 'migrated member-entitlement order requires its source-owned legacy contract'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_migrated_member_contract_required';
    END IF;
  ELSIF target_source.pricing_basis = 'FREE' THEN
    IF NEW.member_id IS NOT NULL OR NEW.member_contract_id IS NOT NULL
      OR NEW.booking_channel_code IS NOT NULL OR NEW.channel_order_reference IS NOT NULL THEN
      RAISE EXCEPTION 'migrated free order cannot claim membership or channel identity'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_migrated_free_identity';
    END IF;
  ELSIF NEW.member_id IS NOT NULL OR NEW.member_contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'paid migrated order cannot claim membership identity'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_migrated_paid_member_null';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_validate_migration_source
BEFORE INSERT OR UPDATE OF migration_source_id ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migrated_order_source();

CREATE OR REPLACE FUNCTION qintopia_protect_order_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.primary_guest_snapshot IS DISTINCT FROM OLD.primary_guest_snapshot
    OR NEW.booking_channel_code IS DISTINCT FROM OLD.booking_channel_code
    OR NEW.channel_order_reference IS DISTINCT FROM OLD.channel_order_reference
    OR NEW.free_stay_reason IS DISTINCT FROM OLD.free_stay_reason
    OR NEW.free_stay_category_code IS DISTINCT FROM OLD.free_stay_category_code
    OR NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id
    OR NEW.stay_type IS DISTINCT FROM OLD.stay_type
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id
    OR NEW.migration_source_id IS DISTINCT FROM OLD.migration_source_id THEN
    RAISE EXCEPTION 'order identity, guest snapshot, channel, membership, pricing anchor, and migration source are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'orders_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_new_order_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  migration_source migration_order_sources%ROWTYPE;
BEGIN
  NEW.channel_order_reference := NULLIF(
    regexp_replace(btrim(NEW.channel_order_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  IF NEW.stay_type = 'FREE' THEN
    IF NEW.free_stay_category_code IS NULL THEN
      RAISE EXCEPTION 'new free stays require a free-stay category'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_new_free_stay_category_required';
    END IF;
    IF NEW.booking_channel_code IS NOT NULL OR NEW.channel_order_reference IS NOT NULL THEN
      RAISE EXCEPTION 'free stays cannot have a booking channel or channel order reference'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_free_stay_booking_channel_null';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.member_id IS NOT NULL OR NEW.member_contract_id IS NOT NULL THEN
    IF NEW.booking_channel_code IS NOT NULL OR NEW.channel_order_reference IS NOT NULL THEN
      RAISE EXCEPTION 'member stays cannot have a booking channel or channel order reference'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_member_booking_channel_null';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.booking_channel_code IS NULL
    OR NEW.booking_channel_code NOT IN ('YOUMUDAO', 'CTRIP', 'MEITUAN', 'WECOM') THEN
    RAISE EXCEPTION 'new non-member orders require a known booking channel code'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_booking_channel_required';
  END IF;
  IF NEW.booking_channel_code = 'WECOM' AND NEW.channel_order_reference IS NOT NULL THEN
    RAISE EXCEPTION 'WECOM orders cannot have a channel order reference'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_wecom_has_no_channel_order_reference';
  END IF;
  IF NEW.booking_channel_code <> 'WECOM' AND NEW.channel_order_reference IS NULL THEN
    IF NEW.migration_source_id IS NULL THEN
      RAISE EXCEPTION 'external channel orders require a channel order reference'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_new_channel_order_reference_required';
    END IF;
    SELECT * INTO migration_source
      FROM migration_order_sources WHERE id = NEW.migration_source_id;
    IF migration_source.disposition IS DISTINCT FROM 'OPERATIONAL'
      OR migration_source.property_id IS DISTINCT FROM NEW.property_id
      OR migration_source.mapped_channel_code IS DISTINCT FROM NEW.booking_channel_code
      OR migration_source.channel_order_reference IS NOT NULL
      OR migration_source.channel_reference_missing_reason IS DISTINCT FROM 'HISTORICAL_NOT_RECORDED' THEN
      RAISE EXCEPTION 'external channel reference may be absent only when history explicitly did not record it'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_migrated_channel_reference_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_new_member_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  migration_source migration_order_sources%ROWTYPE;
BEGIN
  IF NEW.member_id IS NOT NULL THEN
    IF NEW.migration_source_id IS NOT NULL THEN
      RAISE EXCEPTION 'migration-provenance legacy contracts cannot claim a member profile'
        USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_migrated_member_null';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.migration_source_id IS NULL THEN
    RAISE EXCEPTION 'new member contracts require a member profile'
      USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_new_member_required';
  END IF;
  SELECT * INTO migration_source
    FROM migration_order_sources WHERE id = NEW.migration_source_id;
  IF migration_source.disposition IS DISTINCT FROM 'OPERATIONAL'
    OR migration_source.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR migration_source.property_id IS DISTINCT FROM NEW.property_id
    OR NEW.status IS DISTINCT FROM 'ACTIVE'
    OR NEW.valid_from IS DISTINCT FROM migration_source.arrival_date
    OR NEW.valid_until IS DISTINCT FROM migration_source.departure_date - 1
    OR NEW.member_name IS DISTINCT FROM migration_source.guest_snapshot ->> 'fullName' THEN
    RAISE EXCEPTION 'legacy member contract must exactly match its migration source'
      USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_migration_source_match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_new_order_occupant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order orders%ROWTYPE;
  target_source migration_order_sources%ROWTYPE;
BEGIN
  NEW.full_name := NULLIF(btrim(NEW.full_name), '');
  NEW.nickname := NULLIF(btrim(NEW.nickname), '');
  NEW.phone := NULLIF(btrim(NEW.phone), '');
  NEW.document_number := NULLIF(btrim(NEW.document_number), '');

  IF EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'order occupant list is frozen after initial order creation'
      USING ERRCODE = '55000', CONSTRAINT = 'order_occupants_initial_list_frozen';
  END IF;
  IF NEW.created_by_command_id IS NULL THEN
    SELECT * INTO target_order FROM orders WHERE id = NEW.order_id;
    IF target_order.migration_source_id IS NULL THEN
      RAISE EXCEPTION 'new order occupants require a creating command'
        USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_created_by_command_required';
    END IF;
    SELECT * INTO STRICT target_source
      FROM migration_order_sources WHERE id = target_order.migration_source_id;
    IF target_source.disposition IS DISTINCT FROM 'OPERATIONAL'
      OR NEW.ordinal <> 1
      OR NEW.role IS DISTINCT FROM 'PRIMARY'
      OR NEW.full_name IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'fullName'), '')
      OR NEW.nickname IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'nickname'), '')
      OR NEW.phone IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'phone'), '')
      OR NEW.document_number IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'documentNumber'), '') THEN
      RAISE EXCEPTION 'commandless migration occupant must exactly match the source-owned primary guest'
        USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_migration_primary_match';
    END IF;
  END IF;

  IF NEW.full_name IS NULL OR char_length(NEW.full_name) > 200 THEN
    RAISE EXCEPTION 'new order occupants require a full name of at most 200 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_full_name_required';
  END IF;
  IF NEW.created_by_command_id IS NOT NULL
    AND (NEW.nickname IS NULL OR char_length(NEW.nickname) > 200) THEN
    RAISE EXCEPTION 'new order occupants require a nickname of at most 200 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_nickname_required';
  END IF;
  IF NEW.nickname IS NOT NULL AND char_length(NEW.nickname) > 200 THEN
    RAISE EXCEPTION 'order occupant nickname exceeds 200 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_nickname_length';
  END IF;
  IF NEW.phone IS NOT NULL AND char_length(NEW.phone) > 80 THEN
    RAISE EXCEPTION 'order occupant phone exceeds 80 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_phone_length';
  END IF;
  IF NEW.document_number IS NOT NULL AND char_length(NEW.document_number) > 120 THEN
    RAISE EXCEPTION 'order occupant document number exceeds 120 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_document_number_length';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_protect_member_contract_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.migration_source_id IS DISTINCT FROM OLD.migration_source_id THEN
    RAISE EXCEPTION 'member contract member, property, and migration source are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'member_contracts_owner_immutable';
  END IF;
  IF OLD.migration_source_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'migration-provenance legacy contracts are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'member_contracts_migrated_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_entitlement_lot_migration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_contract member_contracts%ROWTYPE;
  target_source migration_order_sources%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.migration_source_id IS NOT NULL THEN
      RAISE EXCEPTION 'migration-provenance entitlement lots are immutable'
        USING ERRCODE = '55000', CONSTRAINT = 'entitlement_lots_migrated_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.migration_source_id IS DISTINCT FROM OLD.migration_source_id
      OR (OLD.migration_source_id IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'migration-provenance entitlement lots are immutable'
        USING ERRCODE = '55000', CONSTRAINT = 'entitlement_lots_migrated_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.migration_source_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT target_contract FROM member_contracts WHERE id = NEW.contract_id;
  SELECT * INTO STRICT target_source FROM migration_order_sources WHERE id = NEW.migration_source_id;
  IF target_contract.migration_source_id IS DISTINCT FROM NEW.migration_source_id
    OR target_source.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR target_source.disposition IS DISTINCT FROM 'OPERATIONAL'
    OR NEW.unit_kind IS DISTINCT FROM 'ROOM_NIGHT'
    OR NEW.total_units IS DISTINCT FROM
      jsonb_array_length(target_source.operational_snapshot_payload -> 'stayTimeline')
    OR NEW.expires_on IS DISTINCT FROM target_source.departure_date - 1 THEN
    RAISE EXCEPTION 'migration entitlement lot must exactly match its source-owned legacy contract'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_lots_migration_source_match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlement_lots_validate_migration
BEFORE INSERT OR UPDATE OR DELETE ON entitlement_lots
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_entitlement_lot_migration();

CREATE OR REPLACE FUNCTION qintopia_validate_migration_amendment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order orders%ROWTYPE;
  target_source migration_order_sources%ROWTYPE;
  execution_type text;
  target_hold migration_overdue_inventory_holds%ROWTYPE;
  new_departure date;
  historical_amount integer;
  increment_amount integer;
  new_amount integer;
BEGIN
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
  IF NEW.command_id IS NOT NULL THEN
    SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;
  END IF;

  IF NEW.amendment_type = 'MIGRATED_OPERATIONAL_SNAPSHOT' THEN
    IF target_order.migration_source_id IS NULL THEN
      RAISE EXCEPTION 'migration snapshot amendment requires a migrated operational order'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_migration_source_required';
    END IF;
    SELECT * INTO STRICT target_source
      FROM migration_order_sources WHERE id = target_order.migration_source_id;
    IF target_source.disposition IS DISTINCT FROM 'OPERATIONAL'
      OR NEW.sequence <> 1
      OR NEW.prior_version <> 0
      OR NEW.new_version <> 1
      OR NEW.command_id IS NOT NULL
      OR NEW.payload IS DISTINCT FROM target_source.operational_snapshot_payload
      OR btrim(NEW.reason_code) = ''
      OR btrim(NEW.reason_note) = '' THEN
      RAISE EXCEPTION 'migration snapshot amendment must exactly bind source, cutover, state, dates, inventory, and amount'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_migration_snapshot_shape';
    END IF;
    RETURN NEW;
  END IF;

  IF target_order.migration_source_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.sequence = 1 THEN
    RAISE EXCEPTION 'migrated operational orders must begin with a migration snapshot'
      USING ERRCODE = '23514', CONSTRAINT = 'amendments_migrated_initial_snapshot_required';
  END IF;
  IF NEW.amendment_type IN (
    'CREATE_ORDER', 'RESCHEDULE_STAY', 'EXTEND_STAY', 'SHORTEN_STAY',
    'MOVE_UNIT', 'REPRICE_ORDER', 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
  ) THEN
    IF NEW.amendment_type <> 'EXTEND_STAY'
      OR execution_type IS DISTINCT FROM 'RESOLVE_MIGRATED_OVERDUE_STAY' THEN
      RAISE EXCEPTION 'historical-actual orders require an explicit migration correction flow'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_migrated_repricing_forbidden';
    END IF;
    BEGIN
      SELECT * INTO STRICT target_hold
        FROM migration_overdue_inventory_holds
        WHERE id = NEW.payload ->> 'holdId';
      new_departure := (NEW.payload ->> 'newDepartureDate')::date;
      historical_amount := (NEW.payload ->> 'historicalActualAmountMinor')::integer;
      increment_amount := (NEW.payload ->> 'postCutoverIncrementAmountMinor')::integer;
      new_amount := (NEW.payload ->> 'newContractAmountMinor')::integer;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'overdue migration resolution requires typed hold, date, and amount evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_migrated_overdue_typed_payload';
    END;
    SELECT * INTO STRICT target_source
      FROM migration_order_sources WHERE id = target_order.migration_source_id;
    IF NEW.payload ->> 'operation' IS DISTINCT FROM 'RESOLVE_MIGRATED_OVERDUE_STAY'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 8
      OR NOT NEW.payload ?& ARRAY[
        'operation', 'orderId', 'sourceId', 'holdId',
        'historicalActualAmountMinor', 'postCutoverIncrementAmountMinor',
        'newContractAmountMinor', 'newDepartureDate'
      ]
      OR NEW.payload ->> 'orderId' IS DISTINCT FROM NEW.order_id
      OR NEW.payload ->> 'sourceId' IS DISTINCT FROM target_source.id
      OR target_hold.order_id IS DISTINCT FROM NEW.order_id
      OR target_hold.source_id IS DISTINCT FROM target_source.id
      OR new_departure <= target_hold.starts_on
      OR historical_amount IS DISTINCT FROM target_source.historical_actual_amount_minor
      OR increment_amount < 0
      OR new_amount IS DISTINCT FROM historical_amount + increment_amount
      OR btrim(NEW.reason_code) = ''
      OR btrim(NEW.reason_note) = '' THEN
      RAISE EXCEPTION 'overdue migration resolution payload does not match its source and active hold'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_migrated_overdue_payload_match';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amendments_validate_migration_shape
BEFORE INSERT ON amendments
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_amendment();

CREATE OR REPLACE FUNCTION qintopia_validate_migration_segment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order orders%ROWTYPE;
  target_source migration_order_sources%ROWTYPE;
  target_amendment amendments%ROWTYPE;
  target_stay stays%ROWTYPE;
BEGIN
  SELECT * INTO STRICT target_stay FROM stays WHERE id = NEW.stay_id;
  SELECT * INTO STRICT target_order FROM orders WHERE id = target_stay.order_id;
  SELECT * INTO STRICT target_amendment FROM amendments WHERE id = NEW.amendment_id;
  IF NEW.segment_type = 'MIGRATED_INITIAL' THEN
    IF target_order.migration_source_id IS NULL THEN
      RAISE EXCEPTION 'migration initial segment requires a migrated operational order'
        USING ERRCODE = '23514', CONSTRAINT = 'stay_segments_migration_source_required';
    END IF;
    SELECT * INTO STRICT target_source
      FROM migration_order_sources WHERE id = target_order.migration_source_id;
    IF NEW.sequence <> 1
      OR NEW.supersedes_segment_id IS NOT NULL
      OR target_amendment.order_id IS DISTINCT FROM target_order.id
      OR target_amendment.amendment_type IS DISTINCT FROM 'MIGRATED_OPERATIONAL_SNAPSHOT'
      OR target_amendment.payload IS DISTINCT FROM target_source.operational_snapshot_payload
      OR NEW.arrival_date IS DISTINCT FROM target_source.arrival_date
      OR NEW.departure_date IS DISTINCT FROM target_source.departure_date
      OR NEW.inventory_unit_id IS DISTINCT FROM
        target_source.operational_snapshot_payload ->> 'inventoryUnitId' THEN
      RAISE EXCEPTION 'migration initial segment must represent the complete source timeline and trailing unit'
        USING ERRCODE = '23514', CONSTRAINT = 'stay_segments_migrated_initial_shape';
    END IF;
  ELSIF target_order.migration_source_id IS NOT NULL AND NEW.sequence = 1 THEN
    RAISE EXCEPTION 'migrated operational stay must begin with a MIGRATED_INITIAL segment'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_segments_migrated_initial_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stay_segments_validate_migration_shape
BEFORE INSERT ON stay_segments
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_segment();

CREATE OR REPLACE FUNCTION qintopia_validate_pricing_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order orders%ROWTYPE;
  target_source migration_order_sources%ROWTYPE;
  target_amendment amendments%ROWTYPE;
  prior_revision pricing_revisions%ROWTYPE;
  target_hold migration_overdue_inventory_holds%ROWTYPE;
  execution_type text;
  historical_amount integer;
  increment_amount integer;
  new_amount integer;
  new_departure date;
BEGIN
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;

  IF NEW.pricing_origin = 'STANDARD' THEN
    IF NEW.pricing_basis IS NULL THEN
      NEW.pricing_basis := CASE
        WHEN NEW.manual_adjustment_minor = 0 THEN 'POLICY' ELSE 'MANUAL_ADJUSTMENT' END;
    END IF;
    IF NEW.policy_base_amount_minor IS NULL THEN
      NEW.policy_base_amount_minor := NEW.current_contract_amount_minor - NEW.manual_adjustment_minor;
    END IF;
    IF NEW.pricing_basis = 'CHANNEL_CONTRACT' THEN
      IF NEW.manual_adjustment_minor <> 0 THEN
        RAISE EXCEPTION 'channel contract price difference is not a manual adjustment'
          USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_channel_manual_adjustment_zero';
      END IF;
    ELSIF NEW.current_contract_amount_minor <> NEW.policy_base_amount_minor + NEW.manual_adjustment_minor THEN
      RAISE EXCEPTION 'contract amount must equal policy base plus manual adjustment'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_amount_equation';
    END IF;
    IF NEW.pricing_basis = 'FREE'
      AND (NEW.policy_base_amount_minor <> 0 OR NEW.current_contract_amount_minor <> 0 OR NEW.manual_adjustment_minor <> 0) THEN
      RAISE EXCEPTION 'free pricing revision must remain zero'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_free_zero';
    END IF;
    IF target_order.stay_type = 'FREE' AND NEW.pricing_basis <> 'FREE' THEN
      RAISE EXCEPTION 'free order requires FREE pricing basis for every revision'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_all_free_basis';
    ELSIF (target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL)
      AND NEW.pricing_basis <> 'MEMBER_ENTITLEMENT' THEN
      RAISE EXCEPTION 'member order requires MEMBER_ENTITLEMENT pricing basis for every revision'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_all_member_basis';
    ELSIF NEW.revision_no = 1 THEN
      IF target_order.booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN')
        AND NEW.pricing_basis <> 'CHANNEL_CONTRACT' THEN
        RAISE EXCEPTION 'external channel order requires CHANNEL_CONTRACT initial pricing basis'
          USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_initial_channel_basis';
      ELSIF target_order.booking_channel_code = 'WECOM'
        AND NEW.pricing_basis NOT IN ('POLICY', 'MANUAL_ADJUSTMENT') THEN
        RAISE EXCEPTION 'WECOM order requires POLICY or MANUAL_ADJUSTMENT initial pricing basis'
          USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_initial_wecom_basis';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF target_order.migration_source_id IS NULL THEN
    RAISE EXCEPTION 'migration pricing origins require an immutable migration source'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_migration_source_required';
  END IF;
  SELECT * INTO STRICT target_source
    FROM migration_order_sources WHERE id = target_order.migration_source_id;
  SELECT * INTO STRICT target_amendment FROM amendments WHERE id = NEW.amendment_id;

  IF NEW.pricing_origin = 'MIGRATED_ACTUAL' THEN
    IF target_source.disposition IS DISTINCT FROM 'OPERATIONAL'
      OR NEW.revision_no <> 1
      OR target_amendment.order_id IS DISTINCT FROM NEW.order_id
      OR target_amendment.amendment_type IS DISTINCT FROM 'MIGRATED_OPERATIONAL_SNAPSHOT'
      OR target_amendment.payload IS DISTINCT FROM target_source.operational_snapshot_payload
      OR NEW.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id
      OR NEW.arrival_date IS DISTINCT FROM target_source.arrival_date
      OR NEW.departure_date IS DISTINCT FROM target_source.departure_date
      OR NEW.pricing_basis IS DISTINCT FROM target_source.pricing_basis
      OR NEW.current_contract_amount_minor IS DISTINCT FROM target_source.historical_actual_amount_minor
      OR NEW.currency IS DISTINCT FROM target_source.currency
      OR jsonb_typeof(NEW.coverage_set) IS DISTINCT FROM 'array'
      OR NEW.cash_lines IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
        'lineKind', 'MIGRATED_ACTUAL',
        'historicalActualAmountMinor', target_source.historical_actual_amount_minor,
        'currency', target_source.currency
      )) THEN
      RAISE EXCEPTION 'migrated actual pricing must exactly match the immutable source snapshot'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_migrated_actual_match';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.pricing_origin <> 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER' THEN
    RAISE EXCEPTION 'unknown pricing origin'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_pricing_origin_known';
  END IF;
  SELECT command_type INTO execution_type
    FROM command_executions WHERE id = target_amendment.command_id;
  SELECT * INTO STRICT prior_revision
    FROM pricing_revisions
    WHERE order_id = NEW.order_id AND revision_no = NEW.revision_no - 1;
  BEGIN
    SELECT * INTO STRICT target_hold
      FROM migration_overdue_inventory_holds
      WHERE id = target_amendment.payload ->> 'holdId';
    historical_amount := (target_amendment.payload ->> 'historicalActualAmountMinor')::integer;
    increment_amount := (target_amendment.payload ->> 'postCutoverIncrementAmountMinor')::integer;
    new_amount := (target_amendment.payload ->> 'newContractAmountMinor')::integer;
    new_departure := (target_amendment.payload ->> 'newDepartureDate')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'post-cutover migration pricing requires typed hold, date, and amount evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_migrated_plus_typed_payload';
  END;
  IF execution_type IS DISTINCT FROM 'RESOLVE_MIGRATED_OVERDUE_STAY'
    OR target_amendment.amendment_type IS DISTINCT FROM 'EXTEND_STAY'
    OR target_hold.order_id IS DISTINCT FROM NEW.order_id
    OR target_hold.source_id IS DISTINCT FROM target_source.id
    OR prior_revision.pricing_origin IS DISTINCT FROM 'MIGRATED_ACTUAL'
    OR NEW.revision_no IS DISTINCT FROM prior_revision.revision_no + 1
    OR historical_amount IS DISTINCT FROM prior_revision.current_contract_amount_minor
    OR increment_amount < 0
    OR new_amount IS DISTINCT FROM historical_amount + increment_amount
    OR NEW.current_contract_amount_minor IS DISTINCT FROM new_amount
    OR NEW.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id
    OR NEW.arrival_date IS DISTINCT FROM target_source.arrival_date
    OR NEW.departure_date IS DISTINCT FROM new_departure
    OR NEW.pricing_basis IS DISTINCT FROM prior_revision.pricing_basis
    OR NEW.currency IS DISTINCT FROM prior_revision.currency
    OR NEW.coverage_set IS DISTINCT FROM prior_revision.coverage_set
    OR NEW.cash_lines IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
      'lineKind', 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER',
      'historicalActualAmountMinor', historical_amount,
      'postCutoverIncrementAmountMinor', increment_amount,
      'newContractAmountMinor', new_amount,
      'currency', NEW.currency
    )) THEN
    RAISE EXCEPTION 'post-cutover migration pricing must preserve history and add only the confirmed increment'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_migrated_plus_match';
  END IF;
  RETURN NEW;
END;
$$;

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
  migrated_pair_valid boolean := false;
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
      segment.arrival_date, segment.departure_date, segment.segment_type,
      amendment.amendment_type, amendment.payload
    INTO source_property_id, source_inventory_unit_id, source_room_id,
      source_arrival_date, source_departure_date, source_segment_type,
      source_amendment_type, source_amendment_payload
    FROM stay_segments AS segment
    JOIN stays ON stays.id = segment.stay_id
    JOIN orders ON orders.id = stays.order_id
    JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
    JOIN amendments AS amendment ON amendment.id = segment.amendment_id
    WHERE segment.id = NEW.source_id;
    IF source_segment_type = 'RESCHEDULE_STAY'
      AND source_amendment_type = 'RESCHEDULE_STAY'
      AND jsonb_typeof(source_amendment_payload #> '{after,stayTimeline}') = 'array' THEN
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(source_amendment_payload #> '{after,stayTimeline}') AS item(value)
        WHERE jsonb_typeof(item.value) = 'object'
          AND item.value ->> 'serviceDate' = NEW.service_date::text
          AND item.value ->> 'inventoryUnitId' = NEW.inventory_unit_id
      ) INTO reschedule_pair_valid;
    ELSIF source_segment_type = 'MIGRATED_INITIAL'
      AND source_amendment_type = 'MIGRATED_OPERATIONAL_SNAPSHOT'
      AND jsonb_typeof(source_amendment_payload -> 'stayTimeline') = 'array' THEN
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(source_amendment_payload -> 'stayTimeline') AS item(value)
        WHERE jsonb_typeof(item.value) = 'object'
          AND item.value ->> 'serviceDate' = NEW.service_date::text
          AND item.value ->> 'inventoryUnitId' = NEW.inventory_unit_id
      ) INTO migrated_pair_valid;
    END IF;
  ELSIF NEW.source_type = 'MAINTENANCE' THEN
    SELECT lock.property_id, lock.inventory_unit_id,
      CASE WHEN unit.kind = 'ROOM' THEN unit.id ELSE unit.parent_room_id END,
      lock.arrival_date, lock.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id,
      source_arrival_date, source_departure_date
    FROM maintenance_locks AS lock
    JOIN inventory_units AS unit ON unit.id = lock.inventory_unit_id
    WHERE lock.id = NEW.source_id;
  ELSE
    SELECT block.property_id, block.inventory_unit_id, block.room_id,
      block.arrival_date, block.departure_date
    INTO source_property_id, source_inventory_unit_id, source_room_id,
      source_arrival_date, source_departure_date
    FROM internal_use_blocks AS block
    WHERE block.id = NEW.source_id;
  END IF;

  IF source_property_id IS NULL
    OR source_property_id <> NEW.property_id
    OR (NEW.source_type = 'ORDER_SEGMENT' AND source_segment_type = 'RESCHEDULE_STAY'
      AND (source_amendment_type <> 'RESCHEDULE_STAY' OR NOT reschedule_pair_valid))
    OR (NEW.source_type = 'ORDER_SEGMENT' AND source_segment_type = 'MIGRATED_INITIAL'
      AND (source_amendment_type <> 'MIGRATED_OPERATIONAL_SNAPSHOT' OR NOT migrated_pair_valid))
    OR (NOT (
      NEW.source_type = 'ORDER_SEGMENT'
      AND (
        (source_segment_type = 'RESCHEDULE_STAY' AND source_amendment_type = 'RESCHEDULE_STAY')
        OR (source_segment_type = 'MIGRATED_INITIAL'
          AND source_amendment_type = 'MIGRATED_OPERATIONAL_SNAPSHOT')
      )
    ) AND (
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

CREATE OR REPLACE FUNCTION qintopia_validate_migration_overdue_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_source migration_order_sources%ROWTYPE;
  target_order orders%ROWTYPE;
  target_run migration_import_runs%ROWTYPE;
  unit_property_id text;
  expected_room_id text;
  target_stay_status text;
  snapshot_hold_start date;
BEGIN
  SELECT * INTO STRICT target_source
    FROM migration_order_sources WHERE id = NEW.source_id;
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
  SELECT * INTO STRICT target_run FROM migration_import_runs WHERE id = target_source.run_id;
  SELECT property_id, CASE WHEN kind = 'ROOM' THEN id ELSE parent_room_id END
    INTO unit_property_id, expected_room_id
    FROM inventory_units WHERE id = NEW.inventory_unit_id;
  SELECT status INTO target_stay_status FROM stays WHERE order_id = NEW.order_id;
  BEGIN
    snapshot_hold_start := (target_source.operational_snapshot_payload ->> 'overdueHoldStartsOn')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'migration overdue hold requires a typed source hold start'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_overdue_holds_typed_start';
  END;
  IF target_source.disposition IS DISTINCT FROM 'OPERATIONAL'
    OR target_source.observed_order_status IS DISTINCT FROM 'CHECKED_IN'
    OR target_source.observed_stay_status IS DISTINCT FROM 'IN_HOUSE'
    OR target_order.migration_source_id IS DISTINCT FROM NEW.source_id
    OR target_order.property_id IS DISTINCT FROM NEW.property_id
    OR target_order.status IS DISTINCT FROM 'CHECKED_IN'
    OR target_stay_status IS DISTINCT FROM 'IN_HOUSE'
    OR unit_property_id IS DISTINCT FROM NEW.property_id
    OR expected_room_id IS DISTINCT FROM NEW.room_id
    OR NEW.inventory_unit_id IS DISTINCT FROM target_source.operational_snapshot_payload ->> 'inventoryUnitId'
    OR snapshot_hold_start IS DISTINCT FROM NEW.starts_on
    OR target_source.departure_date > NEW.starts_on
    OR NEW.cutover_observed_at IS DISTINCT FROM target_run.cutover_observed_at THEN
    RAISE EXCEPTION 'migration overdue hold must bind the checked-in source, room, interval, and cutover'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_overdue_holds_source_match';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'qintopia:migration-overdue-room:' || NEW.property_id || ':' || NEW.room_id,
    0::bigint
  ));
  IF EXISTS (
    SELECT 1
    FROM inventory_claims AS claim
    WHERE claim.active IS TRUE
      AND claim.property_id = NEW.property_id
      AND claim.room_id = NEW.room_id
      AND claim.service_date >= NEW.starts_on
      AND (
        NEW.inventory_unit_id = NEW.room_id
        OR claim.inventory_unit_id = claim.room_id
        OR claim.inventory_unit_id = NEW.inventory_unit_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM migration_overdue_inventory_holds AS hold
    WHERE hold.property_id = NEW.property_id
      AND hold.room_id = NEW.room_id
      AND NOT EXISTS (
        SELECT 1 FROM migration_overdue_inventory_hold_releases AS release
        WHERE release.hold_id = hold.id
      )
      AND (
        NEW.inventory_unit_id = NEW.room_id
        OR hold.inventory_unit_id = hold.room_id
        OR hold.inventory_unit_id = NEW.inventory_unit_id
      )
  ) THEN
    RAISE EXCEPTION 'migration overdue hold conflicts with existing inventory occupancy'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_overdue_holds_inventory_conflict';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER migration_overdue_holds_validate_insert
BEFORE INSERT ON migration_overdue_inventory_holds
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_overdue_hold();

CREATE OR REPLACE FUNCTION qintopia_reject_active_migration_overdue_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND EXISTS (
    SELECT 1
    FROM migration_overdue_inventory_holds AS hold
    WHERE hold.order_id = OLD.id
      AND NOT EXISTS (
        SELECT 1 FROM migration_overdue_inventory_hold_releases AS release
        WHERE release.hold_id = hold.id
      )
  ) THEN
    RAISE EXCEPTION 'active migrated overdue occupancy must be resolved before changing order status'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_overdue_order_status_requires_resolution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_migration_overdue_status_guard
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_active_migration_overdue_status_change();

CREATE OR REPLACE FUNCTION qintopia_reject_active_migration_overdue_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active IS NOT TRUE THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'qintopia:migration-overdue-room:' || NEW.property_id || ':' || NEW.room_id,
    0::bigint
  ));
  IF EXISTS (
    SELECT 1
    FROM migration_overdue_inventory_holds AS hold
    WHERE hold.property_id = NEW.property_id
      AND hold.room_id = NEW.room_id
      AND NEW.service_date >= hold.starts_on
      AND NOT EXISTS (
        SELECT 1 FROM migration_overdue_inventory_hold_releases AS release
        WHERE release.hold_id = hold.id
      )
      AND (
        hold.inventory_unit_id = hold.room_id
        OR NEW.inventory_unit_id = NEW.room_id
        OR hold.inventory_unit_id = NEW.inventory_unit_id
      )
  ) THEN
    RAISE EXCEPTION 'inventory claim conflicts with an active migrated overdue occupancy hold'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_claims_migration_overdue_hold_conflict';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_claims_reject_active_migration_overdue_hold
BEFORE INSERT OR UPDATE ON inventory_claims
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_active_migration_overdue_hold();

CREATE OR REPLACE FUNCTION qintopia_validate_migration_overdue_release() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_hold migration_overdue_inventory_holds%ROWTYPE;
  target_source migration_order_sources%ROWTYPE;
  target_order orders%ROWTYPE;
  target_command command_executions%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  prior_segment stay_segments%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_amendment amendments%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  expected_claim_count integer;
  actual_claim_count integer;
BEGIN
  SELECT * INTO STRICT target_hold
    FROM migration_overdue_inventory_holds WHERE id = NEW.hold_id;
  SELECT * INTO STRICT target_source
    FROM migration_order_sources WHERE id = NEW.source_id;
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
  SELECT * INTO STRICT target_command FROM command_executions WHERE id = NEW.command_id;
  SELECT * INTO STRICT target_segment FROM stay_segments WHERE id = NEW.extension_segment_id;
  SELECT * INTO STRICT prior_segment FROM stay_segments WHERE id = target_segment.supersedes_segment_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE id = target_segment.stay_id;
  SELECT * INTO STRICT target_amendment FROM amendments WHERE id = target_segment.amendment_id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE id = NEW.pricing_revision_id;
  expected_claim_count := NEW.new_departure_date - target_hold.starts_on;
  SELECT count(*)::integer INTO actual_claim_count
    FROM inventory_claims
    WHERE source_type = 'ORDER_SEGMENT'
      AND source_id = NEW.extension_segment_id;

  IF NEW.source_id IS DISTINCT FROM target_hold.source_id
    OR NEW.order_id IS DISTINCT FROM target_hold.order_id
    OR target_order.migration_source_id IS DISTINCT FROM NEW.source_id
    OR target_command.command_type IS DISTINCT FROM 'RESOLVE_MIGRATED_OVERDUE_STAY'
    OR target_command.state IS DISTINCT FROM 'APPLIED'
    OR target_command.property_id IS DISTINCT FROM target_hold.property_id
    OR target_amendment.command_id IS DISTINCT FROM NEW.command_id
    OR target_amendment.order_id IS DISTINCT FROM NEW.order_id
    OR target_amendment.amendment_type IS DISTINCT FROM 'EXTEND_STAY'
    OR target_amendment.payload ->> 'operation' IS DISTINCT FROM 'RESOLVE_MIGRATED_OVERDUE_STAY'
    OR target_amendment.payload ->> 'holdId' IS DISTINCT FROM NEW.hold_id
    OR target_amendment.payload ->> 'sourceId' IS DISTINCT FROM NEW.source_id
    OR (target_amendment.payload ->> 'newDepartureDate')::date IS DISTINCT FROM NEW.new_departure_date
    OR target_stay.order_id IS DISTINCT FROM NEW.order_id
    OR target_segment.segment_type IS DISTINCT FROM 'EXTEND_STAY'
    OR target_segment.sequence IS DISTINCT FROM prior_segment.sequence + 1
    OR target_segment.inventory_unit_id IS DISTINCT FROM target_hold.inventory_unit_id
    OR target_segment.arrival_date IS DISTINCT FROM prior_segment.arrival_date
    OR target_segment.departure_date IS DISTINCT FROM NEW.new_departure_date
    OR prior_segment.stay_id IS DISTINCT FROM target_segment.stay_id
    OR prior_segment.departure_date > target_hold.starts_on
    OR target_revision.order_id IS DISTINCT FROM NEW.order_id
    OR target_revision.amendment_id IS DISTINCT FROM target_amendment.id
    OR target_revision.pricing_origin IS DISTINCT FROM 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER'
    OR target_revision.departure_date IS DISTINCT FROM NEW.new_departure_date
    OR target_order.current_revision_id IS DISTINCT FROM NEW.pricing_revision_id
    OR target_order.departure_date IS DISTINCT FROM NEW.new_departure_date
    OR target_order.version IS DISTINCT FROM target_amendment.new_version
    OR expected_claim_count <= 0
    OR actual_claim_count IS DISTINCT FROM expected_claim_count
    OR EXISTS (
      SELECT 1
      FROM inventory_claims AS claim
      WHERE claim.source_type = 'ORDER_SEGMENT'
        AND claim.source_id = NEW.extension_segment_id
        AND (
          claim.property_id IS DISTINCT FROM target_hold.property_id
          OR claim.room_id IS DISTINCT FROM target_hold.room_id
          OR claim.inventory_unit_id IS DISTINCT FROM target_hold.inventory_unit_id
          OR claim.service_date < target_hold.starts_on
          OR claim.service_date >= NEW.new_departure_date
          OR claim.active IS NOT TRUE
          OR claim.released_at IS NOT NULL
        )
    ) OR EXISTS (
      SELECT 1
      FROM generate_series(target_hold.starts_on, NEW.new_departure_date - 1, interval '1 day') AS day(service_date)
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_claims AS claim
        WHERE claim.source_type = 'ORDER_SEGMENT'
          AND claim.source_id = NEW.extension_segment_id
          AND claim.service_date = day.service_date::date
          AND claim.inventory_unit_id = target_hold.inventory_unit_id
          AND claim.active IS TRUE
      )
    ) THEN
    RAISE EXCEPTION 'migration overdue release requires one applied command and complete segment, pricing, and claim facts'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_overdue_releases_complete';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN SQLSTATE '23514' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'migration overdue release contains malformed or incomplete facts'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_overdue_releases_complete';
END;
$$;

CREATE CONSTRAINT TRIGGER migration_overdue_releases_validate_complete
AFTER INSERT ON migration_overdue_inventory_hold_releases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_overdue_release();

CREATE OR REPLACE FUNCTION qintopia_assert_migration_source_target(target_source_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  target_source migration_order_sources%ROWTYPE;
  target_link migration_order_targets%ROWTYPE;
  target_archive historical_order_archives%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_amendment amendments%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  target_occupant order_occupants%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  expected_stay_status text;
  target_count integer;
  amendment_count integer;
  stay_count integer;
  segment_count integer;
  revision_count integer;
  claim_count integer;
  coverage_count integer;
  ledger_count integer;
  hold_count integer;
  membership_order_count integer;
  occupant_count integer;
BEGIN
  SELECT * INTO STRICT target_source
    FROM migration_order_sources WHERE id = target_source_id;
  IF NOT EXISTS (
    SELECT 1 FROM migration_import_runs
    WHERE id = target_source.run_id AND state = 'APPLIED'
  ) THEN
    RAISE EXCEPTION 'migration sources can commit only as part of an applied import run'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_applied_run_required';
  END IF;
  SELECT count(*)::integer INTO target_count
    FROM migration_order_targets WHERE source_id = target_source_id;
  IF target_count <> 1 THEN
    RAISE EXCEPTION 'every migration source requires exactly one immutable target'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_sources_target_required';
  END IF;
  SELECT * INTO STRICT target_link
    FROM migration_order_targets WHERE source_id = target_source_id;

  IF target_source.disposition <> 'OPERATIONAL' THEN
    IF target_link.archive_id IS NULL OR target_link.order_id IS NOT NULL THEN
      RAISE EXCEPTION 'archive migration source must target only a historical archive'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_order_targets_disposition_match';
    END IF;
    SELECT * INTO STRICT target_archive
      FROM historical_order_archives WHERE id = target_link.archive_id;
    IF target_archive.source_id IS DISTINCT FROM target_source.id
      OR target_archive.record_kind IS DISTINCT FROM (CASE target_source.disposition
        WHEN 'HISTORICAL_ACCOMMODATION' THEN 'MIGRATED_ARCHIVE'
        ELSE 'NON_ACCOMMODATION_ARCHIVE' END) THEN
      RAISE EXCEPTION 'historical archive target does not match its migration disposition'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_order_targets_disposition_match';
    END IF;
    RETURN;
  END IF;

  IF target_link.order_id IS NULL OR target_link.archive_id IS NOT NULL THEN
    RAISE EXCEPTION 'operational migration source must target only a core order'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_targets_disposition_match';
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = target_link.order_id;
  expected_stay_status := CASE target_source.observed_order_status
    WHEN 'RESERVED' THEN 'PLANNED' ELSE 'IN_HOUSE' END;
  SELECT count(*)::integer INTO amendment_count
    FROM amendments WHERE order_id = target_order.id;
  SELECT count(*)::integer INTO stay_count
    FROM stays WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT count(*)::integer INTO segment_count
    FROM stay_segments WHERE stay_id = target_stay.id;
  SELECT count(*)::integer INTO revision_count
    FROM pricing_revisions WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_amendment
    FROM amendments WHERE order_id = target_order.id AND sequence = 1;
  SELECT * INTO STRICT target_segment
    FROM stay_segments WHERE stay_id = target_stay.id AND sequence = 1;
  SELECT * INTO STRICT target_revision
    FROM pricing_revisions WHERE order_id = target_order.id AND revision_no = 1;
  SELECT count(*)::integer INTO occupant_count
    FROM order_occupants WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_occupant
    FROM order_occupants WHERE order_id = target_order.id AND ordinal = 1;
  SELECT count(*)::integer INTO claim_count
    FROM inventory_claims
    WHERE source_type = 'ORDER_SEGMENT'
      AND source_id = target_segment.id;

  IF target_order.migration_source_id IS DISTINCT FROM target_source.id
    OR target_stay.status IS DISTINCT FROM expected_stay_status
    OR amendment_count <> 1
    OR stay_count <> 1
    OR segment_count <> 1
    OR revision_count <> 1
    OR target_amendment.amendment_type IS DISTINCT FROM 'MIGRATED_OPERATIONAL_SNAPSHOT'
    OR target_amendment.payload IS DISTINCT FROM target_source.operational_snapshot_payload
    OR target_segment.segment_type IS DISTINCT FROM 'MIGRATED_INITIAL'
    OR target_segment.amendment_id IS DISTINCT FROM target_amendment.id
    OR target_revision.amendment_id IS DISTINCT FROM target_amendment.id
    OR target_revision.pricing_origin IS DISTINCT FROM 'MIGRATED_ACTUAL'
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id
    OR occupant_count <> 1
    OR target_occupant.role IS DISTINCT FROM 'PRIMARY'
    OR target_occupant.created_by_command_id IS NOT NULL
    OR target_occupant.full_name IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'fullName'), '')
    OR target_occupant.nickname IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'nickname'), '')
    OR target_occupant.phone IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'phone'), '')
    OR target_occupant.document_number IS DISTINCT FROM NULLIF(btrim(target_source.guest_snapshot ->> 'documentNumber'), '')
    OR claim_count IS DISTINCT FROM
      jsonb_array_length(target_source.operational_snapshot_payload -> 'stayTimeline')
    OR EXISTS (
      SELECT 1
      FROM inventory_claims AS claim
      WHERE claim.source_type = 'ORDER_SEGMENT'
        AND claim.source_id = target_segment.id
        AND (
          claim.property_id IS DISTINCT FROM target_source.property_id
          OR claim.active IS NOT TRUE
          OR claim.released_at IS NOT NULL
          OR NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(target_source.operational_snapshot_payload -> 'stayTimeline') AS item(value)
            WHERE item.value ->> 'serviceDate' = claim.service_date::text
              AND item.value ->> 'inventoryUnitId' = claim.inventory_unit_id
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(target_source.operational_snapshot_payload -> 'stayTimeline') AS item(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM inventory_claims AS claim
        WHERE claim.source_type = 'ORDER_SEGMENT'
          AND claim.source_id = target_segment.id
          AND claim.service_date = (item.value ->> 'serviceDate')::date
          AND claim.inventory_unit_id = item.value ->> 'inventoryUnitId'
          AND claim.active IS TRUE
      )
    ) OR EXISTS (
      SELECT 1 FROM collection_facts WHERE order_id = target_order.id
    ) THEN
    RAISE EXCEPTION 'operational migration target is not a complete source-bound snapshot'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_targets_operational_complete';
  END IF;

  SELECT count(*)::integer INTO hold_count
    FROM migration_overdue_inventory_holds AS hold
    WHERE hold.source_id = target_source.id
      AND NOT EXISTS (
        SELECT 1 FROM migration_overdue_inventory_hold_releases AS release
        WHERE release.hold_id = hold.id
      );
  IF (target_source.operational_snapshot_payload ? 'overdueHoldStartsOn' AND hold_count <> 1)
    OR (NOT (target_source.operational_snapshot_payload ? 'overdueHoldStartsOn') AND hold_count <> 0) THEN
    RAISE EXCEPTION 'operational migration overdue hold does not match its snapshot flag'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_order_targets_overdue_hold_complete';
  END IF;

  IF target_source.pricing_basis = 'MEMBER_ENTITLEMENT' THEN
    SELECT count(*)::integer INTO target_count
      FROM member_contracts WHERE migration_source_id = target_source.id;
    IF target_count <> 1 THEN
      RAISE EXCEPTION 'member-entitlement migration requires one legacy contract'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_member_entitlement_complete';
    END IF;
    SELECT * INTO STRICT target_contract
      FROM member_contracts WHERE migration_source_id = target_source.id;
    SELECT count(*)::integer INTO target_count
      FROM entitlement_lots WHERE migration_source_id = target_source.id;
    IF target_count <> 1 THEN
      RAISE EXCEPTION 'member-entitlement migration requires one source-owned lot'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_member_entitlement_complete';
    END IF;
    SELECT * INTO STRICT target_lot
      FROM entitlement_lots WHERE migration_source_id = target_source.id;
    SELECT count(*)::integer INTO coverage_count
      FROM coverage_items WHERE order_id = target_order.id;
    SELECT count(*)::integer INTO ledger_count
      FROM entitlement_ledger WHERE order_id = target_order.id;
    SELECT count(*)::integer INTO membership_order_count
      FROM membership_orders
      WHERE contract_id = target_contract.id OR entitlement_lot_id = target_lot.id;
    IF target_order.member_id IS NOT NULL
      OR target_order.member_contract_id IS DISTINCT FROM target_contract.id
      OR target_contract.member_id IS NOT NULL
      OR target_lot.contract_id IS DISTINCT FROM target_contract.id
      OR coverage_count IS DISTINCT FROM
        jsonb_array_length(target_source.operational_snapshot_payload -> 'stayTimeline')
      OR ledger_count IS DISTINCT FROM
        2 * jsonb_array_length(target_source.operational_snapshot_payload -> 'stayTimeline')
      OR membership_order_count <> 0
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND (
            coverage.contract_id IS DISTINCT FROM target_contract.id
            OR coverage.lot_id IS DISTINCT FROM target_lot.id
            OR coverage.status IS DISTINCT FROM 'CONSUMED'
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(target_source.operational_snapshot_payload -> 'stayTimeline') AS item(value)
              WHERE item.value ->> 'serviceDate' = coverage.service_date::text
                AND item.value ->> 'inventoryUnitId' = coverage.inventory_unit_id
            )
          )
      ) OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.order_id = target_order.id
          AND (
            (SELECT count(*) FROM entitlement_ledger AS ledger
              WHERE ledger.coverage_id = coverage.id
                AND ledger.lot_id = target_lot.id
                AND ledger.order_id = target_order.id
                AND ledger.service_date = coverage.service_date
                AND ledger.entry_type = 'HOLD'
                AND ledger.quantity_delta = -1
                AND ledger.command_id IS NULL) <> 1
            OR (SELECT count(*) FROM entitlement_ledger AS ledger
              WHERE ledger.coverage_id = coverage.id
                AND ledger.lot_id = target_lot.id
                AND ledger.order_id = target_order.id
                AND ledger.service_date = coverage.service_date
                AND ledger.entry_type = 'CONSUME'
                AND ledger.quantity_delta = 0
                AND ledger.command_id IS NULL) <> 1
          )
      ) THEN
      RAISE EXCEPTION 'member-entitlement migration contract, lot, coverage, and ledger are incomplete'
        USING ERRCODE = '23514', CONSTRAINT = 'migration_member_entitlement_complete';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM member_contracts WHERE migration_source_id = target_source.id
  ) OR EXISTS (
    SELECT 1 FROM entitlement_lots WHERE migration_source_id = target_source.id
  ) THEN
    RAISE EXCEPTION 'non-member migration source cannot create legacy entitlement objects'
      USING ERRCODE = '23514', CONSTRAINT = 'migration_non_member_entitlement_absent';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_migration_source_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'migration_order_sources' THEN
    PERFORM qintopia_assert_migration_source_target(NEW.id);
  ELSE
    PERFORM qintopia_assert_migration_source_target(NEW.source_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER migration_order_sources_validate_target
AFTER INSERT ON migration_order_sources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_source_target();

CREATE CONSTRAINT TRIGGER migration_order_targets_validate_source
AFTER INSERT ON migration_order_targets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_migration_source_target();

-- Stage 9's ordinary whole-interval repricing guard cannot interpret the dedicated
-- post-cutover composition. The migration pricing trigger and release fact own this one branch.
DROP TRIGGER pricing_revisions_stage9_validate ON pricing_revisions;
CREATE TRIGGER pricing_revisions_stage9_validate
BEFORE INSERT ON pricing_revisions
FOR EACH ROW
WHEN (NEW.pricing_origin IS DISTINCT FROM 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER')
EXECUTE FUNCTION qintopia_validate_stage9_pricing_revision();

-- The Stage 11 combination validator remains authoritative for ordinary date changes.
-- RESOLVE is instead closed by migration_overdue_releases_validate_complete at commit.
DROP TRIGGER amendments_stage11_validate_move_combination ON amendments;
CREATE CONSTRAINT TRIGGER amendments_stage11_validate_move_combination
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NOT (
  NEW.amendment_type = 'EXTEND_STAY'
  AND COALESCE(NEW.payload ->> 'operation', '') = 'RESOLVE_MIGRATED_OVERDUE_STAY'
))
EXECUTE FUNCTION qintopia_validate_stage11_move_combination();

ALTER FUNCTION qintopia_assert_stage12_terminal_command(text)
  RENAME TO qintopia_assert_stage12_terminal_command_v029;

CREATE OR REPLACE FUNCTION qintopia_assert_stage12_terminal_command(target_command_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  target_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  target_timezone text;
  expected_order_status text;
  amendment_count integer;
  revision_count integer;
  active_claim_count integer;
  held_coverage_count integer;
  consumed_coverage_count integer;
  restore_count integer;
  actual_net_collection bigint;
  effect_net_collection bigint;
  effect_refund_reference bigint;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions WHERE id = target_command_id;
  IF execution_type NOT IN ('CANCEL_ORDER', 'MARK_NO_SHOW', 'REVOKE_CHECK_IN') THEN
    RETURN;
  END IF;
  SELECT count(*)::integer INTO amendment_count
    FROM amendments WHERE command_id = target_command_id;
  IF amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN RETURN; END IF;
  SELECT * INTO target_amendment
    FROM amendments WHERE command_id = target_command_id AND amendment_type = execution_type;
  IF NOT FOUND THEN
    PERFORM qintopia_assert_stage12_terminal_command_v029(target_command_id);
    RETURN;
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = target_amendment.order_id;
  IF target_order.migration_source_id IS NULL THEN
    PERFORM qintopia_assert_stage12_terminal_command_v029(target_command_id);
    RETURN;
  END IF;

  IF execution_state IS DISTINCT FROM 'APPLIED'
    OR amendment_count <> 1
    OR execution_property_id IS DISTINCT FROM target_order.property_id THEN
    RAISE EXCEPTION 'migrated terminal command requires one applied, property-bound amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_migrated_terminal_complete';
  END IF;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE id = target_order.current_revision_id;
  SELECT timezone INTO STRICT target_timezone FROM properties WHERE id = target_order.property_id;
  SELECT count(*)::integer INTO revision_count
    FROM pricing_revisions
    WHERE amendment_id = target_amendment.id AND order_id = target_order.id;
  expected_order_status := CASE execution_type
    WHEN 'CANCEL_ORDER' THEN 'CANCELLED'
    WHEN 'MARK_NO_SHOW' THEN 'NO_SHOW'
    ELSE 'CHECK_IN_REVOKED' END;
  IF revision_count <> 0
    OR target_revision.pricing_origin NOT IN ('MIGRATED_ACTUAL', 'MIGRATED_ACTUAL_PLUS_POST_CUTOVER')
    OR target_order.status IS DISTINCT FROM expected_order_status
    OR target_stay.status IS DISTINCT FROM expected_order_status
    OR target_order.version IS DISTINCT FROM target_amendment.new_version THEN
    RAISE EXCEPTION 'migrated terminal command must preserve its historical-actual pricing revision'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_migrated_terminal_pricing_preserved';
  END IF;

  SELECT count(*)::integer INTO active_claim_count
    FROM inventory_claims AS claim
    WHERE claim.source_type = 'ORDER_SEGMENT'
      AND claim.source_id IN (SELECT id FROM stay_segments WHERE stay_id = target_stay.id)
      AND claim.active IS TRUE;
  SELECT count(*) FILTER (WHERE status = 'HELD')::integer,
         count(*) FILTER (WHERE status = 'CONSUMED')::integer
    INTO held_coverage_count, consumed_coverage_count
    FROM coverage_items WHERE order_id = target_order.id;
  SELECT count(*)::integer INTO restore_count
    FROM entitlement_ledger
    WHERE order_id = target_order.id AND entry_type = 'RESTORE' AND command_id = target_command_id;
  IF active_claim_count <> 0 OR held_coverage_count <> 0
    OR (execution_type IN ('CANCEL_ORDER', 'MARK_NO_SHOW')
      AND (consumed_coverage_count <> 0 OR restore_count <> 0))
    OR (execution_type = 'REVOKE_CHECK_IN' AND restore_count <> consumed_coverage_count) THEN
    RAISE EXCEPTION 'migrated terminal command did not conserve inventory and entitlement facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_inventory_entitlement';
  END IF;

  IF execution_type = 'MARK_NO_SHOW' AND (
    target_amendment.payload ->> 'businessDate'
      IS DISTINCT FROM (transaction_timestamp() AT TIME ZONE target_timezone)::date::text
    OR transaction_timestamp() AT TIME ZONE target_timezone
      < target_order.arrival_date::timestamp + time '20:00'
  ) THEN
    RAISE EXCEPTION 'no-show cannot be recorded before the local arrival-date threshold'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_no_show_local_threshold';
  END IF;
  IF execution_type = 'REVOKE_CHECK_IN' AND (
    target_amendment.payload ->> 'unusedRoomConfirmed' IS DISTINCT FROM 'true'
    OR target_amendment.payload ->> 'businessDate' IS DISTINCT FROM target_order.arrival_date::text
    OR (transaction_timestamp() AT TIME ZONE target_timezone)::date IS DISTINCT FROM target_order.arrival_date
  ) THEN
    RAISE EXCEPTION 'revoke-check-in requires same-day unused-room confirmation'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_revoke_same_day_unused';
  END IF;

  SELECT COALESCE(sum(net_effect_minor), 0)::bigint INTO actual_net_collection
    FROM collection_facts WHERE order_id = target_order.id;
  BEGIN
    effect_net_collection := (target_amendment.payload #>> '{amounts,netRecordedCollection,minorUnits}')::bigint;
    effect_refund_reference := (target_amendment.payload #>> '{amounts,refundReferenceAmount,minorUnits}')::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'migrated terminal command has damaged funds evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_funds';
  END;
  IF effect_net_collection IS DISTINCT FROM actual_net_collection
    OR effect_refund_reference IS DISTINCT FROM greatest(0::bigint, actual_net_collection)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id) THEN
    RAISE EXCEPTION 'migrated terminal command must not manufacture historical money facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_funds';
  END IF;
END;
$$;
