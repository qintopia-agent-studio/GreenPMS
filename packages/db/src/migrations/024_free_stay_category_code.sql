ALTER TABLE orders
  ADD COLUMN free_stay_category_code text,
  ADD CONSTRAINT orders_free_stay_category_code_check CHECK (
    free_stay_category_code IS NULL OR free_stay_category_code IN ('VOLUNTEER', 'RECEPTION')
  ),
  ADD CONSTRAINT orders_free_stay_category_scope CHECK (
    (stay_type = 'FREE') OR free_stay_category_code IS NULL
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
    RAISE EXCEPTION 'non-WECOM orders require a channel order reference'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_new_channel_order_reference_required';
  END IF;
  RETURN NEW;
END;
$$;

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
    OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    RAISE EXCEPTION 'order identity, guest snapshot, booking channel, free-stay identity, membership, stay type, and locked pricing policy are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
