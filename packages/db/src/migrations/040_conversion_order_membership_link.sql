-- A lodging order becomes a member stay only as part of the atomic
-- CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP command. Keep all other identity
-- fields immutable and require the typed amendment to already exist.
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
    OR NEW.stay_type IS DISTINCT FROM OLD.stay_type THEN
    RAISE EXCEPTION 'order identity, guest snapshot, booking channel, free-stay identity, stay type, and locked pricing policy are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    IF OLD.member_id IS NOT NULL OR OLD.member_contract_id IS NOT NULL
      OR NEW.member_id IS NULL OR NEW.member_contract_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM amendments AS amendment
        JOIN command_executions AS execution
          ON execution.id = amendment.command_id
        JOIN membership_orders AS membership_order
          ON membership_order.created_by_command_id = execution.id
          AND membership_order.activated_by_command_id = execution.id
        JOIN member_contracts AS contract
          ON contract.id = membership_order.contract_id
        WHERE amendment.order_id = NEW.id
          AND amendment.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND amendment.prior_version = OLD.version
          AND amendment.new_version = NEW.version
          AND execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND execution.state = 'EXECUTING'
          AND execution.property_id = NEW.property_id
          AND membership_order.property_id = NEW.property_id
          AND membership_order.status = 'ACTIVE'
          AND membership_order.member_id = NEW.member_id
          AND membership_order.contract_id = NEW.member_contract_id
          AND contract.member_id = NEW.member_id
          AND contract.property_id = NEW.property_id
          AND contract.membership_order_id = membership_order.id
      ) THEN
      RAISE EXCEPTION 'order membership identity can only be linked once by a conversion amendment' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
