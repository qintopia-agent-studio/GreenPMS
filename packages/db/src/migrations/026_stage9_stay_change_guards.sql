DROP INDEX IF EXISTS coverage_items_active_order_date_idx;

CREATE UNIQUE INDEX coverage_items_active_order_date_idx
  ON coverage_items (order_id, service_date)
  WHERE status IN ('HELD', 'CONSUMED');

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
    OR mod(NEW.current_contract_amount_minor, 100) <> 0 THEN
    RAISE EXCEPTION 'stay change contract amount must be a non-negative whole-yuan PostgreSQL integer'
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

CREATE TRIGGER pricing_revisions_stage9_validate
BEFORE INSERT ON pricing_revisions
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage9_pricing_revision();
