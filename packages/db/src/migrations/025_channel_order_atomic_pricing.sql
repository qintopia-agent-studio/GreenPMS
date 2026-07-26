ALTER TABLE pricing_revisions
  ADD COLUMN policy_base_amount_minor integer,
  ADD COLUMN pricing_basis text;

ALTER TABLE pricing_revisions DISABLE TRIGGER pricing_revisions_append_only;

UPDATE pricing_revisions AS revision
SET
  policy_base_amount_minor = revision.current_contract_amount_minor - revision.manual_adjustment_minor,
  pricing_basis = CASE
    WHEN orders.stay_type = 'FREE' THEN 'FREE'
    WHEN orders.member_id IS NOT NULL OR orders.member_contract_id IS NOT NULL THEN 'MEMBER_ENTITLEMENT'
    WHEN revision.manual_adjustment_minor <> 0 THEN 'MANUAL_ADJUSTMENT'
    ELSE 'POLICY'
  END
FROM orders
WHERE orders.id = revision.order_id;

ALTER TABLE pricing_revisions ENABLE TRIGGER pricing_revisions_append_only;

ALTER TABLE pricing_revisions
  ALTER COLUMN policy_base_amount_minor SET NOT NULL,
  ALTER COLUMN pricing_basis SET NOT NULL,
  ADD CONSTRAINT pricing_revisions_policy_base_nonnegative CHECK (policy_base_amount_minor >= 0),
  ADD CONSTRAINT pricing_revisions_contract_amount_nonnegative CHECK (current_contract_amount_minor >= 0),
  ADD CONSTRAINT pricing_revisions_pricing_basis_check CHECK (
    pricing_basis IN ('POLICY', 'CHANNEL_CONTRACT', 'MANUAL_ADJUSTMENT', 'MEMBER_ENTITLEMENT', 'FREE')
  );

CREATE OR REPLACE FUNCTION qintopia_validate_new_order_channel() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    RAISE EXCEPTION 'external channel orders require a channel order reference'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_channel_order_reference_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_pricing_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order orders%ROWTYPE;
BEGIN
  IF NEW.policy_base_amount_minor IS NULL THEN
    NEW.policy_base_amount_minor := NEW.current_contract_amount_minor - NEW.manual_adjustment_minor;
  END IF;
  IF NEW.pricing_basis IS NULL THEN
    NEW.pricing_basis := CASE WHEN NEW.manual_adjustment_minor = 0 THEN 'POLICY' ELSE 'MANUAL_ADJUSTMENT' END;
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

  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
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
END;
$$;

CREATE TRIGGER pricing_revisions_validate
BEFORE INSERT ON pricing_revisions
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_pricing_revision();
