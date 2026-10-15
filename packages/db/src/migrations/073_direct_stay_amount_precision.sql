-- 普通企微直订手工本单金额支持角分；政策价舍入、免费和会员约束保持不变。

CREATE OR REPLACE FUNCTION qintopia_validate_stage9_pricing_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  change_type text;
  amendment_order_id text;
  channel_code text;
  order_stay_type text;
  order_status text;
  order_member_id text;
  order_contract_id text;
BEGIN
  SELECT amendment_type, order_id INTO change_type, amendment_order_id
    FROM amendments
    WHERE id = NEW.amendment_id;

  IF change_type NOT IN ('RESCHEDULE_STAY', 'EXTEND_STAY') THEN
    RETURN NEW;
  END IF;

  IF amendment_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'stay change pricing revision and amendment must belong to the same order'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_amendment_order';
  END IF;

  SELECT booking_channel_code, stay_type, status, member_id, member_contract_id
    INTO channel_code, order_stay_type, order_status, order_member_id, order_contract_id
    FROM orders
    WHERE id = NEW.order_id;

  IF (change_type = 'RESCHEDULE_STAY' AND order_status IS DISTINCT FROM 'RESERVED')
    OR (change_type = 'EXTEND_STAY' AND order_status IS DISTINCT FROM 'CHECKED_IN') THEN
    RAISE EXCEPTION 'stay change pricing revision does not match the current order status'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_order_status';
  END IF;

  IF NEW.current_contract_amount_minor < 0
    OR NEW.current_contract_amount_minor > 2147483600
    OR (COALESCE(channel_code, '') NOT IN ('YOUMUDAO', 'CTRIP', 'MEITUAN')
      AND NOT (channel_code IS NOT DISTINCT FROM 'WECOM' AND order_stay_type IS DISTINCT FROM 'FREE' AND order_member_id IS NULL AND order_contract_id IS NULL)
      AND mod(NEW.current_contract_amount_minor, 100) <> 0) THEN
    RAISE EXCEPTION 'stay change contract amount must be a supported non-negative amount (member amounts retain whole yuan)'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_contract_amount';
  END IF;

  IF order_stay_type = 'FREE' THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'FREE'
      OR NEW.policy_base_amount_minor IS DISTINCT FROM 0
      OR NEW.current_contract_amount_minor IS DISTINCT FROM 0
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'free stay changes must keep a zero FREE pricing revision'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_free_zero';
    END IF;
  ELSIF order_member_id IS NOT NULL OR order_contract_id IS NOT NULL THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'member stay changes require MEMBER_ENTITLEMENT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_member_basis';
    END IF;
  ELSIF channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN') THEN
    IF NEW.pricing_basis IS DISTINCT FROM 'CHANNEL_CONTRACT'
      OR NEW.manual_adjustment_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'external channel stay changes require CHANNEL_CONTRACT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_channel_basis';
    END IF;
  ELSIF channel_code = 'WECOM' THEN
    IF NEW.pricing_basis IS NULL
      OR NEW.pricing_basis NOT IN ('POLICY', 'MANUAL_ADJUSTMENT')
      OR (NEW.pricing_basis = 'POLICY' AND NEW.manual_adjustment_minor IS DISTINCT FROM 0)
      OR (NEW.pricing_basis = 'MANUAL_ADJUSTMENT' AND NEW.manual_adjustment_minor = 0) THEN
      RAISE EXCEPTION 'WECOM stay changes require POLICY or MANUAL_ADJUSTMENT pricing'
        USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_wecom_basis';
    END IF;
  ELSE
    RAISE EXCEPTION 'paid stay changes require a known booking channel'
      USING ERRCODE = '23514', CONSTRAINT = 'pricing_revisions_stage9_channel_required';
  END IF;

  RETURN NEW;
END;
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
    OR (COALESCE(target_order.booking_channel_code, '') NOT IN ('YOUMUDAO', 'CTRIP', 'MEITUAN')
      AND NOT (target_order.booking_channel_code IS NOT DISTINCT FROM 'WECOM' AND target_order.stay_type IS DISTINCT FROM 'FREE' AND target_order.member_id IS NULL AND target_order.member_contract_id IS NULL)
      AND mod(NEW.current_contract_amount_minor, 100) <> 0) THEN
    RAISE EXCEPTION 'SHORTEN_STAY contract amount must be a supported non-negative amount (member amounts retain whole yuan)'
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
    OR (COALESCE(target_order.booking_channel_code, '') NOT IN ('YOUMUDAO', 'CTRIP', 'MEITUAN')
      AND NOT (target_order.booking_channel_code IS NOT DISTINCT FROM 'WECOM' AND target_order.stay_type IS DISTINCT FROM 'FREE' AND target_order.member_id IS NULL AND target_order.member_contract_id IS NULL)
      AND mod(NEW.current_contract_amount_minor, 100) <> 0) THEN
    RAISE EXCEPTION 'MOVE_UNIT contract amount must be a supported non-negative amount (member amounts retain whole yuan)'
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
