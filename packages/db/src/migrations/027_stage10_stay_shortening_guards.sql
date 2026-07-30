CREATE OR REPLACE FUNCTION qintopia_stage10_property_today(target_property_id text) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (transaction_timestamp() AT TIME ZONE property.timezone)::date
  FROM properties AS property
  WHERE property.id = target_property_id
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage10_pricing_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  change_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  before_arrival date;
  before_departure date;
  after_arrival date;
  after_departure date;
  business_date date;
BEGIN
  SELECT * INTO change_amendment
    FROM amendments
    WHERE id = NEW.amendment_id;

  IF NOT FOUND OR change_amendment.amendment_type <> 'SHORTEN_STAY' THEN
    RETURN NEW;
  END IF;

  IF change_amendment.order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'SHORTEN_STAY pricing revision and amendment must belong to the same order'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_amendment_order';
  END IF;

  SELECT * INTO STRICT target_order
    FROM orders
    WHERE id = NEW.order_id;

  IF target_order.status IS DISTINCT FROM 'CHECKED_IN' THEN
    RAISE EXCEPTION 'SHORTEN_STAY pricing revision requires a checked-in order'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_order_status';
  END IF;

  BEGIN
    before_arrival := (change_amendment.payload #>> '{before,arrivalDate}')::date;
    before_departure := (change_amendment.payload #>> '{before,departureDate}')::date;
    after_arrival := (change_amendment.payload #>> '{after,arrivalDate}')::date;
    after_departure := (change_amendment.payload #>> '{after,departureDate}')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SHORTEN_STAY requires typed before and after dates'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_typed_dates';
  END;

  business_date := qintopia_stage10_property_today(target_order.property_id);
  IF change_amendment.payload ->> 'operation' IS DISTINCT FROM 'SHORTEN_STAY'
    OR change_amendment.payload ->> 'completionMode' IS NULL
    OR change_amendment.payload ->> 'completionMode' NOT IN ('SHORTEN_IN_HOUSE', 'EARLY_CHECK_OUT')
    OR before_arrival IS NULL OR before_departure IS NULL
    OR after_arrival IS DISTINCT FROM before_arrival
    OR after_departure IS NULL
    OR after_departure <= after_arrival
    OR after_departure >= before_departure
    OR target_order.arrival_date IS DISTINCT FROM before_arrival
    OR target_order.departure_date IS DISTINCT FROM before_departure
    OR before_arrival >= business_date
    OR business_date >= before_departure
    OR after_departure < business_date
    OR (change_amendment.payload ->> 'completionMode' = 'EARLY_CHECK_OUT' AND after_departure IS DISTINCT FROM business_date)
    OR (change_amendment.payload ->> 'completionMode' = 'SHORTEN_IN_HOUSE' AND after_departure <= business_date)
    OR NEW.arrival_date IS DISTINCT FROM after_arrival
    OR NEW.departure_date IS DISTINCT FROM after_departure THEN
    RAISE EXCEPTION 'SHORTEN_STAY dates do not form a legal current-business-day shortening'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_date_matrix';
  END IF;

  IF NEW.current_contract_amount_minor < 0
    OR NEW.current_contract_amount_minor > 2147483600
    OR mod(NEW.current_contract_amount_minor, 100) <> 0 THEN
    RAISE EXCEPTION 'SHORTEN_STAY contract amount must be a non-negative whole-yuan PostgreSQL integer'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_contract_amount';
  END IF;

  IF target_order.stay_type = 'FREE' THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'FREE'
      OR NEW.policy_base_amount_minor IS DISTINCT FROM 0
      OR NEW.current_contract_amount_minor IS DISTINCT FROM 0
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'free SHORTEN_STAY revisions must remain zero and FREE'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_free_zero';
    END IF;
  ELSIF target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'member SHORTEN_STAY revisions require MEMBER_ENTITLEMENT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_member_basis';
    END IF;
  ELSIF target_order.booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN') THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'CHANNEL_CONTRACT'
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0
      OR (
        abs(NEW.current_contract_amount_minor::bigint - NEW.policy_base_amount_minor::bigint) * 100
          > NEW.policy_base_amount_minor::bigint * 15
        AND btrim(COALESCE(change_amendment.payload #>> '{pricingDecision,reason,note}', '')) = ''
      ) THEN
      RAISE EXCEPTION 'external-channel SHORTEN_STAY revisions require CHANNEL_CONTRACT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_channel_basis';
    END IF;
  ELSIF target_order.booking_channel_code = 'WECOM' THEN
    IF NEW.pricing_basis NOT IN ('POLICY', 'MANUAL_ADJUSTMENT')
      OR (NEW.pricing_basis = 'POLICY' AND NEW.manual_adjustment_minor IS DISTINCT FROM 0)
      OR (NEW.pricing_basis = 'MANUAL_ADJUSTMENT' AND NEW.manual_adjustment_minor = 0)
      OR (
        NEW.pricing_basis = 'MANUAL_ADJUSTMENT'
        AND btrim(COALESCE(change_amendment.payload #>> '{pricingDecision,reason,note}', '')) = ''
      ) THEN
      RAISE EXCEPTION 'WECOM SHORTEN_STAY revisions require POLICY or MANUAL_ADJUSTMENT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_wecom_basis';
    END IF;
  ELSE
    RAISE EXCEPTION 'paid SHORTEN_STAY revisions require a known booking channel'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage10_channel_required';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_revisions_stage10_validate
BEFORE INSERT ON pricing_revisions
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage10_pricing_revision();

CREATE OR REPLACE FUNCTION qintopia_reject_stage10_checkout_bypass() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  planned_departure date;
  recorded_business_date date;
BEGIN
  IF NEW.amendment_type NOT IN ('SHORTEN_STAY', 'CHECK_OUT') THEN
    RETURN NEW;
  END IF;

  IF NEW.amendment_type = 'SHORTEN_STAY' THEN
    IF NEW.command_id IS NULL THEN
      RAISE EXCEPTION 'new SHORTEN_STAY amendments require a command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_command_required';
    END IF;
    SELECT command_type INTO execution_type
      FROM command_executions
      WHERE id = NEW.command_id;
    IF execution_type IS DISTINCT FROM 'SHORTEN_STAY' THEN
      RAISE EXCEPTION 'SHORTEN_STAY amendment requires a SHORTEN_STAY command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_shorten_command_type';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.command_id IS NOT NULL THEN
    SELECT command_type INTO execution_type
      FROM command_executions
      WHERE id = NEW.command_id;
    IF execution_type NOT IN ('CHECK_OUT', 'SHORTEN_STAY') THEN
      RAISE EXCEPTION 'CHECK_OUT amendment requires a CHECK_OUT or SHORTEN_STAY command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_checkout_command_type';
    END IF;
    IF execution_type = 'SHORTEN_STAY' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT departure_date INTO planned_departure
    FROM orders
    WHERE id = NEW.order_id;
  BEGIN
    recorded_business_date := (NEW.payload ->> 'businessDate')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'CHECK_OUT requires a typed business date'
      USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_checkout_business_date';
  END;

  IF recorded_business_date IS NULL OR recorded_business_date < planned_departure THEN
    RAISE EXCEPTION 'ordinary CHECK_OUT cannot end a stay before its planned departure date'
      USING ERRCODE = '23514', CONSTRAINT = 'amendments_stage10_checkout_not_early';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amendments_stage10_reject_checkout_bypass
BEFORE INSERT ON amendments
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_stage10_checkout_bypass();

CREATE OR REPLACE FUNCTION qintopia_reject_stage10_entitlement_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
BEGIN
  IF NEW.command_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT command_type INTO execution_type
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type = 'SHORTEN_STAY' THEN
    RAISE EXCEPTION 'SHORTEN_STAY must not append entitlement ledger facts'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_stage10_no_write';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlement_ledger_stage10_reject_write
BEFORE INSERT ON entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_stage10_entitlement_write();

CREATE OR REPLACE FUNCTION qintopia_assert_stage10_shorten_combination(target_command_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
  execution_state text;
  short_amendment amendments%ROWTYPE;
  checkout_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  short_count integer;
  checkout_count integer;
  command_amendment_count integer;
  segment_count integer;
  revision_count integer;
  active_claim_count integer;
  active_claim_date_count integer;
  original_timeline_count integer;
  future_transition_count integer;
  payload_timeline_count integer;
  before_arrival date;
  before_departure date;
  after_arrival date;
  after_departure date;
  business_date date;
  expected_active_claim_count integer;
  completion_mode text;
  effect_policy_base bigint;
  effect_contract_amount bigint;
  effect_after_contract_amount bigint;
  effect_manual_adjustment bigint;
  effect_net_collection bigint;
  effect_collection_difference bigint;
  effect_refund_reference bigint;
  effect_fact_count bigint;
  actual_net_collection bigint;
  actual_fact_count bigint;
  payload_timeline jsonb;
  original_cropped_timeline jsonb;
  active_claim_timeline jsonb;
  expected_member_coverage jsonb;
  expected_current_consumed_dates jsonb;
  expected_retained_consumed_dates jsonb;
  payload_tail_inventory_unit_id text;
  payload_tail_arrival date;
BEGIN
  IF target_command_id IS NULL THEN
    RETURN;
  END IF;
  SELECT command_type, state INTO execution_type, execution_state
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'SHORTEN_STAY' THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO short_count
    FROM amendments
    WHERE command_id = target_command_id AND amendment_type = 'SHORTEN_STAY';
  SELECT count(*)::integer INTO checkout_count
    FROM amendments
    WHERE command_id = target_command_id AND amendment_type = 'CHECK_OUT';
  SELECT count(*)::integer INTO command_amendment_count
    FROM amendments
    WHERE command_id = target_command_id;
  IF command_amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    RAISE EXCEPTION 'complete SHORTEN_STAY business facts require an applied command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_execution_state';
  END IF;
  IF short_count <> 1 THEN
    RAISE EXCEPTION 'SHORTEN_STAY command requires exactly one shortening amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_amendment_complete';
  END IF;

  SELECT * INTO STRICT short_amendment
    FROM amendments
    WHERE command_id = target_command_id AND amendment_type = 'SHORTEN_STAY';
  completion_mode := short_amendment.payload ->> 'completionMode';
  BEGIN
    before_arrival := (short_amendment.payload #>> '{before,arrivalDate}')::date;
    before_departure := (short_amendment.payload #>> '{before,departureDate}')::date;
    after_arrival := (short_amendment.payload #>> '{after,arrivalDate}')::date;
    after_departure := (short_amendment.payload #>> '{after,departureDate}')::date;
    effect_policy_base := (short_amendment.payload #>> '{pricingDecision,policyBaseAmount,minorUnits}')::bigint;
    effect_contract_amount := (short_amendment.payload #>> '{pricingDecision,targetCurrentContractAmount,minorUnits}')::bigint;
    effect_after_contract_amount := (short_amendment.payload #>> '{after,pricing,currentContractAmount,minorUnits}')::bigint;
    effect_manual_adjustment := (short_amendment.payload #>> '{pricingDecision,manualAdjustmentMinor}')::bigint;
    effect_net_collection := (short_amendment.payload #>> '{fundsSummary,netRecordedCollection,minorUnits}')::bigint;
    effect_collection_difference := (short_amendment.payload #>> '{fundsSummary,collectionDifference,minorUnits}')::bigint;
    effect_fact_count := (short_amendment.payload #>> '{fundsSummary,factCount}')::bigint;
    effect_refund_reference := (short_amendment.payload #>> '{refundReferenceAmount,minorUnits}')::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SHORTEN_STAY command requires typed before and after dates'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_typed_dates';
  END;

  IF short_amendment.sequence IS DISTINCT FROM short_amendment.new_version
    OR short_amendment.new_version IS DISTINCT FROM short_amendment.prior_version + 1
    OR btrim(short_amendment.reason_note) = ''
    OR short_amendment.payload ->> 'operation' IS DISTINCT FROM 'SHORTEN_STAY'
    OR completion_mode IS NULL
    OR completion_mode NOT IN ('SHORTEN_IN_HOUSE', 'EARLY_CHECK_OUT')
    OR before_arrival IS NULL OR before_departure IS NULL
    OR after_arrival IS DISTINCT FROM before_arrival
    OR after_departure IS NULL OR after_departure <= after_arrival
    OR after_departure >= before_departure
    OR short_amendment.payload #>> '{entitlementSummary,ledgerWriteCount}' IS DISTINCT FROM '0'
    OR effect_contract_amount IS NULL
    OR effect_contract_amount IS DISTINCT FROM effect_after_contract_amount
    OR effect_collection_difference IS DISTINCT FROM effect_contract_amount - effect_net_collection
    OR effect_fact_count IS NULL
    OR effect_fact_count < 0
    OR effect_fact_count > 2147483647
    OR effect_refund_reference IS DISTINCT FROM greatest(0::bigint, effect_net_collection - effect_contract_amount)
    OR effect_refund_reference < 0
    OR effect_refund_reference > 2147483647 THEN
    RAISE EXCEPTION 'SHORTEN_STAY amendment shape is incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_amendment_shape';
  END IF;

  SELECT * INTO STRICT target_order FROM orders WHERE id = short_amendment.order_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = short_amendment.order_id;
  business_date := qintopia_stage10_property_today(target_order.property_id);

  SELECT count(*)::integer INTO segment_count
    FROM stay_segments AS segment
    WHERE segment.amendment_id = short_amendment.id
      AND segment.stay_id = target_stay.id;
  SELECT count(*)::integer INTO revision_count
    FROM pricing_revisions AS revision
    WHERE revision.amendment_id = short_amendment.id
      AND revision.order_id = short_amendment.order_id;
  IF segment_count <> 1 OR revision_count <> 1 THEN
    RAISE EXCEPTION 'SHORTEN_STAY requires exactly one segment and one pricing revision'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_segment_revision_complete';
  END IF;

  SELECT * INTO STRICT target_segment
    FROM stay_segments
    WHERE amendment_id = short_amendment.id AND stay_id = target_stay.id;
  SELECT * INTO STRICT target_revision
    FROM pricing_revisions
    WHERE amendment_id = short_amendment.id AND order_id = short_amendment.order_id;

  SELECT count(*)::bigint, COALESCE(sum(fact.net_effect_minor), 0)::bigint
    INTO actual_fact_count, actual_net_collection
    FROM collection_facts AS fact
    WHERE fact.order_id = short_amendment.order_id;
  IF effect_fact_count IS DISTINCT FROM actual_fact_count
    OR effect_net_collection IS DISTINCT FROM actual_net_collection THEN
    RAISE EXCEPTION 'SHORTEN_STAY frozen funds summary must match recorded collection facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_frozen_funds';
  END IF;

  IF jsonb_typeof(short_amendment.payload #> '{after,stayTimeline}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SHORTEN_STAY requires a typed after stay timeline'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_timeline_binding';
  END IF;

  SELECT count(*)::integer,
         COALESCE(jsonb_agg(jsonb_build_object(
           'serviceDate', timeline_item.item ->> 'serviceDate',
           'inventoryUnitId', timeline_item.item ->> 'inventoryUnitId'
         ) ORDER BY timeline_item.ordinality), '[]'::jsonb)
    INTO payload_timeline_count, payload_timeline
    FROM jsonb_array_elements(short_amendment.payload #> '{after,stayTimeline}')
      WITH ORDINALITY AS timeline_item(item, ordinality);

  IF payload_timeline_count <> after_departure - after_arrival
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(short_amendment.payload #> '{after,stayTimeline}')
        WITH ORDINALITY AS timeline_item(item, ordinality)
      WHERE jsonb_typeof(timeline_item.item) IS DISTINCT FROM 'object'
        OR btrim(COALESCE(timeline_item.item ->> 'inventoryUnitId', '')) = ''
        OR (timeline_item.item ->> 'serviceDate')::date
          IS DISTINCT FROM after_arrival + (timeline_item.ordinality::integer - 1)
    ) THEN
    RAISE EXCEPTION 'SHORTEN_STAY after stay timeline is not a continuous typed interval'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_timeline_binding';
  END IF;

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
  ), original_timeline AS (
    SELECT service_date, inventory_unit_id
    FROM ranked_original_claims
    WHERE claim_rank = 1
  ), original_timeline_with_prior_unit AS (
    SELECT service_date,
           inventory_unit_id,
           lag(inventory_unit_id) OVER (ORDER BY service_date) AS prior_inventory_unit_id
    FROM original_timeline
  )
  SELECT count(*)::integer,
         COALESCE(jsonb_agg(jsonb_build_object(
           'serviceDate', service_date::text,
           'inventoryUnitId', inventory_unit_id
         ) ORDER BY service_date) FILTER (WHERE service_date < after_departure), '[]'::jsonb),
         count(*) FILTER (
           WHERE prior_inventory_unit_id IS NOT NULL
             AND inventory_unit_id IS DISTINCT FROM prior_inventory_unit_id
             AND service_date >= business_date
         )::integer
    INTO original_timeline_count, original_cropped_timeline, future_transition_count
    FROM original_timeline_with_prior_unit;

  IF future_transition_count <> 0 THEN
    RAISE EXCEPTION 'SHORTEN_STAY cannot crop an inventory transition effective on or after the business date'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_future_move_boundary';
  END IF;

  IF original_timeline_count <> before_departure - before_arrival
    OR payload_timeline IS DISTINCT FROM original_cropped_timeline THEN
    RAISE EXCEPTION 'SHORTEN_STAY timeline must be the original arrangement cropped at the new departure date'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_timeline_binding';
  END IF;

  SELECT timeline_item.item ->> 'inventoryUnitId'
    INTO payload_tail_inventory_unit_id
    FROM jsonb_array_elements(short_amendment.payload #> '{after,stayTimeline}')
      WITH ORDINALITY AS timeline_item(item, ordinality)
    ORDER BY timeline_item.ordinality DESC
    LIMIT 1;
  SELECT min((timeline_item.item ->> 'serviceDate')::date)
    INTO payload_tail_arrival
    FROM jsonb_array_elements(short_amendment.payload #> '{after,stayTimeline}')
      WITH ORDINALITY AS timeline_item(item, ordinality)
    WHERE timeline_item.ordinality > COALESCE((
      SELECT max(prior_item.ordinality)
      FROM jsonb_array_elements(short_amendment.payload #> '{after,stayTimeline}')
        WITH ORDINALITY AS prior_item(item, ordinality)
      WHERE prior_item.item ->> 'inventoryUnitId' IS DISTINCT FROM payload_tail_inventory_unit_id
    ), 0);

  IF target_segment.segment_type IS DISTINCT FROM 'SHORTEN_STAY'
    OR target_segment.supersedes_segment_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM stay_segments AS prior_segment
      WHERE prior_segment.id = target_segment.supersedes_segment_id
        AND prior_segment.stay_id = target_segment.stay_id
        AND prior_segment.sequence = target_segment.sequence - 1
    )
    OR target_segment.sequence IS DISTINCT FROM (
      SELECT max(segment.sequence) FROM stay_segments AS segment WHERE segment.stay_id = target_stay.id
    )
    OR target_segment.inventory_unit_id IS DISTINCT FROM payload_tail_inventory_unit_id
    OR target_segment.arrival_date IS DISTINCT FROM payload_tail_arrival
    OR target_segment.departure_date IS DISTINCT FROM after_departure
    OR target_revision.revision_no IS DISTINCT FROM (
      SELECT max(revision.revision_no) FROM pricing_revisions AS revision WHERE revision.order_id = short_amendment.order_id
    )
    OR target_revision.arrival_date IS DISTINCT FROM after_arrival
    OR target_revision.departure_date IS DISTINCT FROM after_departure
    OR target_revision.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id
    OR target_revision.policy_base_amount_minor::bigint IS DISTINCT FROM effect_policy_base
    OR target_revision.current_contract_amount_minor::bigint IS DISTINCT FROM effect_contract_amount
    OR target_revision.manual_adjustment_minor::bigint IS DISTINCT FROM effect_manual_adjustment
    OR target_revision.currency IS DISTINCT FROM short_amendment.payload #>> '{pricingDecision,targetCurrentContractAmount,currency}'
    OR target_revision.currency IS DISTINCT FROM short_amendment.payload #>> '{refundReferenceAmount,currency}'
    OR target_revision.coverage_set IS DISTINCT FROM short_amendment.payload #> '{after,pricing,coverageSet}'
    OR target_revision.cash_lines IS DISTINCT FROM short_amendment.payload #> '{after,pricing,cashLines}'
    OR target_order.arrival_date IS DISTINCT FROM after_arrival
    OR target_order.departure_date IS DISTINCT FROM after_departure
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id THEN
    RAISE EXCEPTION 'SHORTEN_STAY current arrangement and pricing pointers are incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_current_projection';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'serviceDate', claim.service_date::text,
           'inventoryUnitId', claim.inventory_unit_id
         ) ORDER BY claim.service_date, claim.id), '[]'::jsonb)
    INTO active_claim_timeline
    FROM inventory_claims AS claim
    WHERE claim.source_type = 'ORDER_SEGMENT'
      AND claim.source_id IN (
        SELECT segment.id FROM stay_segments AS segment WHERE segment.stay_id = target_stay.id
      )
      AND claim.active IS TRUE;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'serviceDate', coverage.service_date::text,
           'inventoryUnitId', coverage.inventory_unit_id,
           'unitKind', coverage.unit_kind,
           'entitlementLotId', coverage.lot_id
         ) ORDER BY coverage.service_date, coverage.inventory_unit_id), '[]'::jsonb),
         COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text) ORDER BY coverage.service_date)
           FILTER (WHERE coverage.service_date >= after_arrival AND coverage.service_date < after_departure), '[]'::jsonb)
    INTO expected_member_coverage, expected_current_consumed_dates
    FROM coverage_items AS coverage
    WHERE coverage.order_id = short_amendment.order_id
      AND coverage.status = 'CONSUMED'
      AND coverage.service_date >= after_arrival
      AND coverage.service_date < after_departure;

  IF target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(coverage.service_date::text) ORDER BY coverage.service_date), '[]'::jsonb)
      INTO expected_retained_consumed_dates
      FROM coverage_items AS coverage
      WHERE coverage.order_id = short_amendment.order_id
        AND coverage.status = 'CONSUMED'
        AND (coverage.service_date < after_arrival OR coverage.service_date >= after_departure);

    IF target_revision.coverage_set IS DISTINCT FROM expected_member_coverage
      OR short_amendment.payload #> '{entitlementSummary,currentConsumedCoverageDates}'
        IS DISTINCT FROM expected_current_consumed_dates
      OR short_amendment.payload #> '{entitlementSummary,retainedHistoricalConsumedCoverageDates}'
        IS DISTINCT FROM expected_retained_consumed_dates THEN
      RAISE EXCEPTION 'member SHORTEN_STAY pricing must match immutable consumed coverage facts'
        USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_member_consumed_coverage';
    END IF;
  ELSIF target_revision.coverage_set IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'non-member SHORTEN_STAY pricing must not contain entitlement coverage'
      USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_member_consumed_coverage';
  END IF;

  SELECT count(*)::integer, count(DISTINCT claim.service_date)::integer
    INTO active_claim_count, active_claim_date_count
    FROM inventory_claims AS claim
    WHERE claim.source_type = 'ORDER_SEGMENT'
      AND claim.source_id IN (
        SELECT segment.id
        FROM stay_segments AS segment
        WHERE segment.stay_id = target_stay.id
      )
      AND claim.active IS TRUE;

  IF completion_mode = 'SHORTEN_IN_HOUSE' THEN
    expected_active_claim_count := after_departure - after_arrival;
    IF checkout_count <> 0 OR command_amendment_count <> 1
      OR target_order.status IS DISTINCT FROM 'CHECKED_IN'
      OR target_stay.status IS DISTINCT FROM 'IN_HOUSE'
      OR target_order.version IS DISTINCT FROM short_amendment.new_version
      OR active_claim_count IS DISTINCT FROM expected_active_claim_count
      OR active_claim_date_count IS DISTINCT FROM expected_active_claim_count
      OR active_claim_timeline IS DISTINCT FROM payload_timeline
      OR EXISTS (
        SELECT 1
        FROM inventory_claims AS claim
        WHERE claim.source_type = 'ORDER_SEGMENT'
          AND claim.source_id IN (SELECT segment.id FROM stay_segments AS segment WHERE segment.stay_id = target_stay.id)
          AND claim.active IS TRUE
          AND (claim.service_date < after_arrival OR claim.service_date >= after_departure)
      ) THEN
      RAISE EXCEPTION 'in-house SHORTEN_STAY did not commit a complete arrangement'
        USING ERRCODE = '23514', CONSTRAINT = 'stage10_shorten_in_house_complete';
    END IF;
  ELSE
    IF checkout_count <> 1 OR command_amendment_count <> 2 THEN
      RAISE EXCEPTION 'early checkout requires one shortening and one checkout amendment'
        USING ERRCODE = '23514', CONSTRAINT = 'stage10_early_checkout_amendments_complete';
    END IF;
    SELECT * INTO STRICT checkout_amendment
      FROM amendments
      WHERE command_id = target_command_id AND amendment_type = 'CHECK_OUT';
    IF checkout_amendment.order_id IS DISTINCT FROM short_amendment.order_id
      OR checkout_amendment.sequence IS DISTINCT FROM short_amendment.sequence + 1
      OR checkout_amendment.prior_version IS DISTINCT FROM short_amendment.new_version
      OR checkout_amendment.new_version IS DISTINCT FROM short_amendment.new_version + 1
      OR checkout_amendment.reason_code IS DISTINCT FROM short_amendment.reason_code
      OR checkout_amendment.reason_note IS DISTINCT FROM short_amendment.reason_note
      OR checkout_amendment.payload ->> 'orderId' IS DISTINCT FROM short_amendment.order_id
      OR checkout_amendment.payload ->> 'fromStatus' IS DISTINCT FROM 'CHECKED_IN'
      OR checkout_amendment.payload ->> 'toStatus' IS DISTINCT FROM 'CHECKED_OUT'
      OR checkout_amendment.payload ->> 'effectiveDate' IS DISTINCT FROM after_departure::text
      OR checkout_amendment.payload ->> 'businessDate' IS DISTINCT FROM after_departure::text
      OR checkout_amendment.payload ->> 'recordingMode' IS DISTINCT FROM 'ON_SCHEDULE'
      OR checkout_amendment.payload ? 'operation'
      OR checkout_amendment.payload ? 'completionMode'
      OR checkout_amendment.payload ? 'before'
      OR checkout_amendment.payload ? 'after'
      OR checkout_amendment.payload ? 'cleaningTask'
      OR EXISTS (SELECT 1 FROM stay_segments AS segment WHERE segment.amendment_id = checkout_amendment.id)
      OR EXISTS (SELECT 1 FROM pricing_revisions AS revision WHERE revision.amendment_id = checkout_amendment.id)
      OR target_order.status IS DISTINCT FROM 'CHECKED_OUT'
      OR target_stay.status IS DISTINCT FROM 'COMPLETED'
      OR target_order.version IS DISTINCT FROM checkout_amendment.new_version
      OR active_claim_count <> 0 THEN
      RAISE EXCEPTION 'early checkout did not commit the complete typed terminal combination'
        USING ERRCODE = '23514', CONSTRAINT = 'stage10_early_checkout_complete';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage10_shorten_combination() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM qintopia_assert_stage10_shorten_combination(NEW.command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER amendments_stage10_validate_combination
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage10_shorten_combination();

CREATE OR REPLACE FUNCTION qintopia_validate_stage10_shorten_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM qintopia_assert_stage10_shorten_combination(NEW.id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER command_executions_stage10_validate_combination
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage10_shorten_execution();
