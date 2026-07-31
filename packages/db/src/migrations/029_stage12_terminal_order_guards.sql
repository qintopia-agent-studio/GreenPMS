LOCK TABLE orders, stays, amendments, pricing_revisions, coverage_items, entitlement_ledger,
  inventory_claims, collection_facts, command_executions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
  status IN ('RESERVED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW','CHECK_IN_REVOKED')
);
ALTER TABLE stays DROP CONSTRAINT stays_status_check;
ALTER TABLE stays ADD CONSTRAINT stays_status_check CHECK (
  status IN ('PLANNED','IN_HOUSE','COMPLETED','CANCELLED','NO_SHOW','CHECK_IN_REVOKED')
);
ALTER TABLE entitlement_ledger DROP CONSTRAINT entitlement_ledger_entry_type_check;
ALTER TABLE entitlement_ledger ADD CONSTRAINT entitlement_ledger_entry_type_check CHECK (
  entry_type IN ('ADJUST','HOLD','RELEASE','CONSUME','RESTORE','EXPIRE')
);

CREATE UNIQUE INDEX entitlement_ledger_one_restore_per_coverage_idx
  ON entitlement_ledger (coverage_id)
  WHERE entry_type = 'RESTORE';

WITH legacy_terminal AS (
  SELECT DISTINCT ON (orders.id)
    orders.id AS order_id,
    orders.stay_type,
    orders.member_id,
    orders.member_contract_id,
    orders.booking_channel_code,
    orders.pricing_policy_version_id,
    orders.arrival_date,
    orders.departure_date,
    amendments.id AS amendment_id,
    prior.currency,
    COALESCE((
      SELECT max(revision_no) FROM pricing_revisions existing WHERE existing.order_id = orders.id
    ), 0) + 1 AS revision_no
  FROM orders
  JOIN amendments ON amendments.order_id = orders.id
    AND amendments.amendment_type IN ('CANCEL_ORDER', 'MARK_NO_SHOW')
  JOIN pricing_revisions AS prior ON prior.id = orders.current_revision_id
  WHERE orders.status IN ('CANCELLED', 'NO_SHOW')
    AND NOT EXISTS (
      SELECT 1 FROM pricing_revisions terminal WHERE terminal.amendment_id = amendments.id
    )
  ORDER BY orders.id, amendments.sequence DESC
), inserted AS (
  INSERT INTO pricing_revisions(
    id, order_id, revision_no, amendment_id, policy_version_id, arrival_date, departure_date,
    coverage_set, cash_lines, policy_base_amount_minor, pricing_basis,
    manual_adjustment_minor, current_contract_amount_minor, currency
  )
  SELECT
    'revision_stage12_legacy_' || md5(amendment_id), order_id, revision_no, amendment_id,
    pricing_policy_version_id, arrival_date, departure_date, '[]'::jsonb, '[]'::jsonb, 0,
    CASE
      WHEN stay_type = 'FREE' THEN 'FREE'
      WHEN member_id IS NOT NULL OR member_contract_id IS NOT NULL THEN 'MEMBER_ENTITLEMENT'
      WHEN booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN') THEN 'CHANNEL_CONTRACT'
      ELSE 'POLICY'
    END,
    0, 0, currency
  FROM legacy_terminal
  RETURNING id, order_id
)
UPDATE orders SET current_revision_id = inserted.id, updated_at = now()
FROM inserted WHERE orders.id = inserted.order_id;

CREATE OR REPLACE FUNCTION qintopia_validate_entitlement_lifecycle_fact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  coverage_lot_id text;
  coverage_order_id text;
  coverage_service_date date;
  coverage_status text;
  execution_type text;
  execution_property_id text;
  order_property_id text;
BEGIN
  IF NEW.entry_type NOT IN ('HOLD', 'RELEASE', 'CONSUME', 'RESTORE') THEN
    RETURN NEW;
  END IF;
  SELECT lot_id, order_id, service_date, status
    INTO coverage_lot_id, coverage_order_id, coverage_service_date, coverage_status
    FROM coverage_items WHERE id = NEW.coverage_id;
  IF coverage_lot_id IS NULL
    OR NEW.lot_id IS DISTINCT FROM coverage_lot_id
    OR NEW.order_id IS DISTINCT FROM coverage_order_id
    OR NEW.service_date IS DISTINCT FROM coverage_service_date THEN
    RAISE EXCEPTION 'entitlement lifecycle fact must match its coverage identity'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_coverage_match';
  END IF;
  IF (NEW.entry_type = 'HOLD' AND NEW.quantity_delta <> -1)
    OR (NEW.entry_type = 'RELEASE' AND NEW.quantity_delta <> 1)
    OR (NEW.entry_type = 'CONSUME' AND NEW.quantity_delta <> 0)
    OR (NEW.entry_type = 'RESTORE' AND NEW.quantity_delta <> 1) THEN
    RAISE EXCEPTION 'entitlement lifecycle fact has an invalid quantity delta'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_lifecycle_delta';
  END IF;
  IF (NEW.entry_type = 'HOLD' AND coverage_status IS DISTINCT FROM 'HELD')
    OR (NEW.entry_type = 'RELEASE' AND coverage_status IS DISTINCT FROM 'RELEASED')
    OR (NEW.entry_type IN ('CONSUME', 'RESTORE') AND coverage_status IS DISTINCT FROM 'CONSUMED') THEN
    RAISE EXCEPTION 'entitlement lifecycle fact must match the current coverage status'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_lifecycle_status';
  END IF;
  IF NEW.entry_type IN ('RELEASE', 'CONSUME', 'RESTORE') AND NOT EXISTS (
    SELECT 1 FROM entitlement_ledger
    WHERE coverage_id = NEW.coverage_id AND entry_type = 'HOLD'
  ) THEN
    RAISE EXCEPTION 'terminal entitlement lifecycle fact requires its original hold'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_terminal_requires_hold';
  END IF;
  IF NEW.entry_type = 'RESTORE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM entitlement_ledger
      WHERE coverage_id = NEW.coverage_id AND entry_type = 'CONSUME'
    ) THEN
      RAISE EXCEPTION 'restored entitlement requires its original consumption'
        USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_restore_requires_consume';
    END IF;
    SELECT command_type, property_id INTO execution_type, execution_property_id
      FROM command_executions WHERE id = NEW.command_id;
    SELECT property_id INTO order_property_id FROM orders WHERE id = NEW.order_id;
    IF execution_type IS DISTINCT FROM 'REVOKE_CHECK_IN'
      OR execution_property_id IS DISTINCT FROM order_property_id THEN
      RAISE EXCEPTION 'entitlement restoration requires its typed revoke-check-in command'
        USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_restore_command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage12_terminal_amendment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  execution_type text;
BEGIN
  IF NEW.amendment_type NOT IN ('CANCEL_ORDER', 'MARK_NO_SHOW', 'REVOKE_CHECK_IN') THEN
    RETURN NEW;
  END IF;
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;
  IF execution_type IS DISTINCT FROM NEW.amendment_type
    OR btrim(NEW.reason_note) = ''
    OR NEW.payload ->> 'orderId' IS DISTINCT FROM NEW.order_id
    OR NEW.payload ->> 'fromStatus' IS DISTINCT FROM (CASE
      WHEN NEW.amendment_type = 'REVOKE_CHECK_IN' THEN 'CHECKED_IN' ELSE 'RESERVED' END)
    OR NEW.payload ->> 'toStatus' IS DISTINCT FROM (CASE NEW.amendment_type
      WHEN 'CANCEL_ORDER' THEN 'CANCELLED'
      WHEN 'MARK_NO_SHOW' THEN 'NO_SHOW'
      ELSE 'CHECK_IN_REVOKED' END) THEN
    RAISE EXCEPTION 'stage12 terminal amendment is not bound to its typed command and status transition'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_amendment_shape';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amendments_stage12_validate_terminal
BEFORE INSERT ON amendments
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage12_terminal_amendment();

CREATE OR REPLACE FUNCTION qintopia_validate_stage12_terminal_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  amendment_type text;
  target_order orders%ROWTYPE;
  expected_basis text;
BEGIN
  SELECT amendments.amendment_type INTO amendment_type
    FROM amendments WHERE amendments.id = NEW.amendment_id;
  IF amendment_type NOT IN ('CANCEL_ORDER', 'MARK_NO_SHOW', 'REVOKE_CHECK_IN') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
  expected_basis := CASE
    WHEN target_order.stay_type = 'FREE' THEN 'FREE'
    WHEN target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL THEN 'MEMBER_ENTITLEMENT'
    WHEN target_order.booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN') THEN 'CHANNEL_CONTRACT'
    ELSE 'POLICY'
  END;
  IF NEW.current_contract_amount_minor <> 0
    OR NEW.policy_base_amount_minor <> 0
    OR NEW.manual_adjustment_minor <> 0
    OR NEW.coverage_set IS DISTINCT FROM '[]'::jsonb
    OR NEW.cash_lines IS DISTINCT FROM '[]'::jsonb
    OR NEW.pricing_basis IS DISTINCT FROM expected_basis
    OR NEW.arrival_date IS DISTINCT FROM target_order.arrival_date
    OR NEW.departure_date IS DISTINCT FROM target_order.departure_date
    OR NEW.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id THEN
    RAISE EXCEPTION 'stage12 terminal command requires a complete typed zero pricing revision'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_zero_revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_revisions_stage12_validate_terminal
BEFORE INSERT ON pricing_revisions
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage12_terminal_revision();

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
  expected_stay_status text;
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
  SELECT command_type, state, property_id INTO execution_type, execution_state, execution_property_id
    FROM command_executions WHERE id = target_command_id;
  IF execution_type NOT IN ('CANCEL_ORDER', 'MARK_NO_SHOW', 'REVOKE_CHECK_IN') THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO amendment_count
    FROM amendments WHERE command_id = target_command_id;
  IF amendment_count = 0 AND execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    RAISE EXCEPTION 'complete stage12 terminal facts require an applied command execution'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_execution_state';
  END IF;
  SELECT * INTO target_amendment
    FROM amendments WHERE command_id = target_command_id AND amendment_type = execution_type;
  IF amendment_count <> 1 OR NOT FOUND THEN
    RAISE EXCEPTION 'stage12 terminal command requires exactly one typed amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_complete';
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = target_amendment.order_id;
  IF execution_property_id IS DISTINCT FROM target_order.property_id THEN
    RAISE EXCEPTION 'stage12 terminal command property must match its order property'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_property_binding';
  END IF;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT timezone INTO STRICT target_timezone FROM properties WHERE id = target_order.property_id;
  SELECT count(*)::integer INTO revision_count FROM pricing_revisions
    WHERE amendment_id = target_amendment.id AND order_id = target_order.id;
  SELECT * INTO target_revision FROM pricing_revisions
    WHERE amendment_id = target_amendment.id AND order_id = target_order.id;

  expected_order_status := CASE execution_type
    WHEN 'CANCEL_ORDER' THEN 'CANCELLED'
    WHEN 'MARK_NO_SHOW' THEN 'NO_SHOW'
    ELSE 'CHECK_IN_REVOKED' END;
  expected_stay_status := expected_order_status;
  IF revision_count <> 1 OR NOT FOUND
    OR target_order.status IS DISTINCT FROM expected_order_status
    OR target_stay.status IS DISTINCT FROM expected_stay_status
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id
    OR target_order.version IS DISTINCT FROM target_amendment.new_version
    OR target_revision.current_contract_amount_minor <> 0 THEN
    RAISE EXCEPTION 'stage12 terminal command did not commit its state and zero pricing atomically'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_complete';
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
    OR (execution_type IN ('CANCEL_ORDER', 'MARK_NO_SHOW') AND (consumed_coverage_count <> 0 OR restore_count <> 0))
    OR (execution_type = 'REVOKE_CHECK_IN' AND restore_count <> consumed_coverage_count) THEN
    RAISE EXCEPTION 'stage12 terminal command did not conserve inventory and entitlement facts'
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
    RAISE EXCEPTION 'stage12 terminal command has damaged funds evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_funds';
  END;
  IF effect_net_collection IS DISTINCT FROM actual_net_collection
    OR effect_refund_reference IS DISTINCT FROM greatest(0::bigint, actual_net_collection)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id) THEN
    RAISE EXCEPTION 'stage12 terminal command refund reference must not create money facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_funds';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage12_terminal_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM qintopia_assert_stage12_terminal_command(NEW.id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER command_executions_stage12_validate_terminal
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage12_terminal_execution();

CREATE OR REPLACE FUNCTION qintopia_validate_stage12_terminal_child() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM qintopia_assert_stage12_terminal_command(NEW.command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER entitlement_ledger_stage12_validate_terminal
AFTER INSERT ON entitlement_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage12_terminal_child();

CREATE OR REPLACE FUNCTION qintopia_protect_stage12_terminal_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CANCELLED', 'NO_SHOW', 'CHECK_IN_REVOKED')
    AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'stage12 terminal order and stay status cannot be reopened'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_stage12_protect_terminal_status
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_stage12_terminal_status();

CREATE TRIGGER stays_stage12_protect_terminal_status
BEFORE UPDATE OF status ON stays
FOR EACH ROW EXECUTE FUNCTION qintopia_protect_stage12_terminal_status();

CREATE OR REPLACE FUNCTION qintopia_validate_stage12_order_terminal_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_command_id text;
  expected_type text;
BEGIN
  IF NEW.status NOT IN ('CANCELLED', 'NO_SHOW', 'CHECK_IN_REVOKED')
    OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  expected_type := CASE NEW.status
    WHEN 'CANCELLED' THEN 'CANCEL_ORDER'
    WHEN 'NO_SHOW' THEN 'MARK_NO_SHOW'
    ELSE 'REVOKE_CHECK_IN' END;
  SELECT command_id INTO target_command_id
    FROM amendments
    WHERE order_id = NEW.id AND sequence = NEW.version AND amendment_type = expected_type;
  IF target_command_id IS NULL THEN
    RAISE EXCEPTION 'stage12 terminal order status requires its typed immutable amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_status_typed';
  END IF;
  PERFORM qintopia_assert_stage12_terminal_command(target_command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER orders_stage12_validate_terminal_transition
AFTER UPDATE OF status ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage12_order_terminal_transition();

CREATE OR REPLACE FUNCTION qintopia_validate_stage12_stay_terminal_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order orders%ROWTYPE;
  target_command_id text;
  expected_type text;
BEGIN
  IF NEW.status NOT IN ('CANCELLED', 'NO_SHOW', 'CHECK_IN_REVOKED')
    OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = NEW.order_id;
  expected_type := CASE NEW.status
    WHEN 'CANCELLED' THEN 'CANCEL_ORDER'
    WHEN 'NO_SHOW' THEN 'MARK_NO_SHOW'
    ELSE 'REVOKE_CHECK_IN' END;
  SELECT command_id INTO target_command_id
    FROM amendments
    WHERE order_id = target_order.id
      AND sequence = target_order.version
      AND amendment_type = expected_type;
  IF target_command_id IS NULL THEN
    RAISE EXCEPTION 'stage12 terminal stay status requires its typed immutable amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage12_terminal_status_typed';
  END IF;
  PERFORM qintopia_assert_stage12_terminal_command(target_command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER stays_stage12_validate_terminal_transition
AFTER UPDATE OF status ON stays
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage12_stay_terminal_transition();
