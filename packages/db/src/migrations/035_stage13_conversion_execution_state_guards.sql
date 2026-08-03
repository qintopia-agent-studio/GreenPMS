LOCK TABLE command_executions, amendments, collection_facts, membership_orders,
  membership_payment_facts, stay_collection_membership_transfers, entitlement_ledger
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM command_executions AS execution
    WHERE execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
      AND execution.state IS DISTINCT FROM 'APPLIED'
      AND (
        EXISTS (SELECT 1 FROM amendments WHERE command_id = execution.id)
        OR EXISTS (
          SELECT 1 FROM membership_orders
          WHERE created_by_command_id = execution.id
            OR activated_by_command_id = execution.id
        )
        OR EXISTS (SELECT 1 FROM membership_payment_facts WHERE command_id = execution.id)
        OR EXISTS (SELECT 1 FROM stay_collection_membership_transfers WHERE command_id = execution.id)
        OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = execution.id)
        OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE command_id = execution.id)
      )
  ) THEN
    RAISE EXCEPTION 'non-applied stay-to-membership conversion commands cannot carry business facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_execution_state';
  END IF;
END;
$$;

ALTER FUNCTION qintopia_assert_stage13_stay_conversion_command(text)
  RENAME TO qintopia_assert_stage13_stay_conversion_command_v033;

CREATE FUNCTION qintopia_assert_stage13_stay_conversion_command(target_command_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  conversion_order_id text;
  conversion_membership_order_id text;
  conversion_entitlement_lot_id text;
  conversion_amendment_count integer;
  conversion_membership_order_count integer;
  conversion_amendment_payload jsonb;
  remaining_payment_payload jsonb;
  remaining_payment_matches boolean := false;
  direct_payment_count integer;
  direct_payment_command_id text;
  direct_payment_fact_type text;
  direct_payment_amount_minor bigint;
  direct_payment_currency text;
  direct_payment_transaction_reference text;
BEGIN
  IF target_command_id IS NULL THEN
    RETURN;
  END IF;

  SELECT command_type, state
    INTO execution_type, execution_state
    FROM command_executions
    WHERE id = target_command_id;
  IF NOT FOUND
    OR execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RETURN;
  END IF;

  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    IF EXISTS (SELECT 1 FROM amendments WHERE command_id = target_command_id)
      OR EXISTS (
        SELECT 1 FROM membership_orders
        WHERE created_by_command_id = target_command_id
          OR activated_by_command_id = target_command_id
      )
      OR EXISTS (SELECT 1 FROM membership_payment_facts WHERE command_id = target_command_id)
      OR EXISTS (SELECT 1 FROM stay_collection_membership_transfers WHERE command_id = target_command_id)
      OR EXISTS (SELECT 1 FROM collection_facts WHERE command_id = target_command_id)
      OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE command_id = target_command_id) THEN
      RAISE EXCEPTION 'stay-to-membership conversion business facts require an applied command execution'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_execution_state';
    END IF;
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO conversion_amendment_count
    FROM amendments AS amendment
    WHERE amendment.command_id = target_command_id
      AND amendment.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  SELECT count(*)::integer
    INTO conversion_membership_order_count
    FROM membership_orders AS membership_order
    WHERE membership_order.created_by_command_id = target_command_id
      AND membership_order.activated_by_command_id = target_command_id;

  -- The v033 assertion remains authoritative for incomplete conversion graphs. Once
  -- both graph roots are unique, bind the direct payment to the reviewed effect
  -- before a looser aggregate-sum check can accept a split or substituted payment.
  IF conversion_amendment_count = 1 AND conversion_membership_order_count = 1 THEN
    SELECT amendment.order_id, amendment.payload
      INTO conversion_order_id, conversion_amendment_payload
      FROM amendments AS amendment
      WHERE amendment.command_id = target_command_id
        AND amendment.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
    SELECT membership_order.id, membership_order.entitlement_lot_id
      INTO conversion_membership_order_id, conversion_entitlement_lot_id
      FROM membership_orders AS membership_order
      WHERE membership_order.created_by_command_id = target_command_id
        AND membership_order.activated_by_command_id = target_command_id;

    remaining_payment_payload := conversion_amendment_payload -> 'remainingPayment';
    SELECT count(*)::integer,
           min(fact.command_id),
           min(fact.fact_type),
           min(fact.amount_minor)::bigint,
           min(fact.currency::text),
           min(fact.transaction_reference)
      INTO direct_payment_count,
           direct_payment_command_id,
           direct_payment_fact_type,
           direct_payment_amount_minor,
           direct_payment_currency,
           direct_payment_transaction_reference
      FROM membership_payment_facts AS fact
      WHERE fact.membership_order_id = conversion_membership_order_id
        AND fact.source_type = 'DIRECT_WECOM';

    IF COALESCE(conversion_amendment_payload ? 'remainingPayment', false) THEN
      IF jsonb_typeof(remaining_payment_payload) = 'null' THEN
        remaining_payment_matches := direct_payment_count = 0;
      ELSIF jsonb_typeof(remaining_payment_payload) = 'object' THEN
        remaining_payment_matches := direct_payment_count = 1
          AND direct_payment_command_id IS NOT DISTINCT FROM target_command_id
          AND direct_payment_fact_type IS NOT DISTINCT FROM 'COLLECTION'
          AND to_jsonb(direct_payment_amount_minor)
            IS NOT DISTINCT FROM remaining_payment_payload #> '{amount,minorUnits}'
          AND to_jsonb(direct_payment_currency)
            IS NOT DISTINCT FROM remaining_payment_payload #> '{amount,currency}'
          AND to_jsonb(direct_payment_transaction_reference)
            IS NOT DISTINCT FROM remaining_payment_payload -> 'transactionReference';
      END IF;
    END IF;

    IF NOT remaining_payment_matches THEN
      RAISE EXCEPTION 'stay-to-membership conversion direct payment must exactly match the reviewed remaining payment'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_remaining_payment_binding';
    END IF;
  END IF;

  PERFORM qintopia_assert_stage13_stay_conversion_command_v033(target_command_id);

  SELECT amendment.order_id
    INTO STRICT conversion_order_id
    FROM amendments AS amendment
    WHERE amendment.command_id = target_command_id
      AND amendment.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  SELECT membership_order.id, membership_order.entitlement_lot_id
    INTO STRICT conversion_membership_order_id, conversion_entitlement_lot_id
    FROM membership_orders AS membership_order
    WHERE membership_order.created_by_command_id = target_command_id
      AND membership_order.activated_by_command_id = target_command_id;

  IF EXISTS (
      SELECT 1
      FROM collection_facts AS fact
      WHERE fact.command_id = target_command_id
        AND NOT EXISTS (
          SELECT 1
          FROM stay_collection_membership_transfers AS transfer
          WHERE transfer.command_id = target_command_id
            AND transfer.order_id = conversion_order_id
            AND transfer.source_reversal_fact_id = fact.fact_id
            AND transfer.source_collection_fact_id = fact.reverses_fact_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM membership_payment_facts AS fact
      WHERE fact.command_id = target_command_id
        AND NOT (
          (
            fact.source_type = 'STAY_COLLECTION_TRANSFER'
            AND EXISTS (
              SELECT 1
              FROM stay_collection_membership_transfers AS transfer
              WHERE transfer.command_id = target_command_id
                AND transfer.order_id = conversion_order_id
                AND transfer.membership_order_id = conversion_membership_order_id
                AND transfer.membership_payment_fact_id = fact.fact_id
            )
          )
          OR (
            fact.source_type = 'DIRECT_WECOM'
            AND fact.membership_order_id = conversion_membership_order_id
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS fact
      WHERE fact.command_id = target_command_id
        AND (
          fact.entry_type IS DISTINCT FROM 'CONVERSION_CONSUME'
          OR fact.order_id IS DISTINCT FROM conversion_order_id
          OR fact.lot_id IS DISTINCT FROM conversion_entitlement_lot_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM stay_collection_membership_transfers AS transfer
      WHERE transfer.command_id = target_command_id
        AND (
          transfer.order_id IS DISTINCT FROM conversion_order_id
          OR transfer.membership_order_id IS DISTINCT FROM conversion_membership_order_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM membership_orders AS membership_order
      WHERE (
          membership_order.created_by_command_id = target_command_id
          OR membership_order.activated_by_command_id = target_command_id
        )
        AND (
          membership_order.id IS DISTINCT FROM conversion_membership_order_id
          OR membership_order.created_by_command_id IS DISTINCT FROM target_command_id
          OR membership_order.activated_by_command_id IS DISTINCT FROM target_command_id
        )
    ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion command cannot own facts outside its conversion graph'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_command_fact_exclusivity';
  END IF;
END;
$$;

DO $$
DECLARE
  conversion_execution record;
BEGIN
  FOR conversion_execution IN
    SELECT id
    FROM command_executions
    WHERE command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
  LOOP
    PERFORM qintopia_assert_stage13_stay_conversion_command(conversion_execution.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.command_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER entitlement_ledger_stage13_validate_stay_conversion ON entitlement_ledger;

CREATE CONSTRAINT TRIGGER entitlement_ledger_stage13_validate_stay_conversion
AFTER INSERT ON entitlement_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child();

CREATE CONSTRAINT TRIGGER amendments_stage13_validate_stay_conversion
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.command_id IS NOT NULL)
EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child();

CREATE FUNCTION qintopia_validate_stage13_stay_conversion_membership_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.created_by_command_id);
  IF NEW.activated_by_command_id IS DISTINCT FROM NEW.created_by_command_id THEN
    PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.activated_by_command_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER membership_orders_stage13_validate_stay_conversion
AFTER INSERT OR UPDATE OF activated_by_command_id ON membership_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_membership_order();

CREATE OR REPLACE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
BEGIN
  PERFORM 1 FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1
    FROM stay_collection_membership_transfers
    WHERE membership_order_id = NEW.membership_order_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT command_type, state
    INTO execution_type, execution_state
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    AND execution_state IS DISTINCT FROM 'APPLIED'
    AND EXISTS (
      SELECT 1
      FROM stay_collection_membership_transfers AS transfer
      JOIN membership_orders AS membership_order
        ON membership_order.id = transfer.membership_order_id
      WHERE transfer.membership_order_id = NEW.membership_order_id
        AND transfer.command_id = NEW.command_id
        AND membership_order.created_by_command_id = NEW.command_id
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'membership funds are closed for membership orders created from lodging collection transfer'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_funds_closed';
END;
$$;

-- Keep the operator-facing 4.6 collection-method contract below the API layer.
-- Historical rows remain readable; every write after migration 035 is strict.
CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_transaction_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  referenced_fact_type text;
  referenced_order_id text;
  referenced_amount_minor integer;
  referenced_method text;
  active_refunded_minor bigint;
  reversed_collection_fact_id text;
  reversed_fact_type text;
  order_booking_channel_code text;
BEGIN
  NEW.transaction_reference := NULLIF(
    regexp_replace(btrim(NEW.transaction_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  IF NEW.pricing_revision_id IS NULL THEN
    RAISE EXCEPTION 'new collection facts require a pricing revision'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_new_pricing_revision_required';
  END IF;
  IF NEW.fact_type IN ('COLLECTION', 'REFUND')
    AND (
      NEW.method = 'BANK_TRANSFER'
      OR (NEW.fact_type = 'COLLECTION' AND NEW.method = 'WECOM')
    )
    AND NEW.transaction_reference IS NULL THEN
    RAISE EXCEPTION 'wecom collections and bank transfer facts require a transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_method_transaction_reference_required';
  END IF;
  IF NEW.fact_type = 'REVERSAL' AND NEW.transaction_reference IS NOT NULL THEN
    RAISE EXCEPTION 'reversal facts cannot have a transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_transaction_reference_null';
  END IF;
  SELECT booking_channel_code
    INTO order_booking_channel_code
    FROM orders
    WHERE id = NEW.order_id;
  IF FOUND AND NEW.fact_type IN ('COLLECTION', 'REFUND') THEN
    IF order_booking_channel_code IN ('YOUMUDAO', 'CTRIP', 'MEITUAN') THEN
      RAISE EXCEPTION 'external channel orders cannot record per-order collection or refund facts in PMS'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_external_channel_money_forbidden';
    END IF;
    IF NEW.method NOT IN ('WECOM', 'BANK_TRANSFER', 'CASH', 'OTHER') THEN
      RAISE EXCEPTION 'collection and refund facts require an operator-facing collection method'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_operator_method_required';
    END IF;
    IF NEW.method IN ('CASH', 'OTHER') AND NEW.transaction_reference IS NOT NULL THEN
      RAISE EXCEPTION 'cash and other collection methods cannot carry a transaction reference'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_cash_other_transaction_reference_null';
    END IF;
    IF NEW.fact_type = 'REFUND'
      AND NEW.method = 'WECOM'
      AND NEW.transaction_reference IS NOT NULL THEN
      RAISE EXCEPTION 'wecom refunds derive the original transaction reference from the referenced collection'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_wecom_refund_transaction_reference_null';
    END IF;
  END IF;
  IF NEW.fact_type = 'REFUND' THEN
    IF NEW.references_fact_id IS NULL THEN
      RAISE EXCEPTION 'refund facts require a referenced collection fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_required';
    END IF;
    SELECT fact_type, order_id, amount_minor, method
      INTO referenced_fact_type, referenced_order_id, referenced_amount_minor, referenced_method
      FROM collection_facts
      WHERE fact_id = NEW.references_fact_id
      FOR UPDATE;
    IF NOT FOUND OR referenced_fact_type IS DISTINCT FROM 'COLLECTION' THEN
      RAISE EXCEPTION 'refund facts must reference a collection fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_collection';
    END IF;
    IF referenced_order_id IS DISTINCT FROM NEW.order_id THEN
      RAISE EXCEPTION 'refund facts must reference a collection in the same order'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_same_order';
    END IF;
    IF (referenced_method = 'WECOM') IS DISTINCT FROM (NEW.method = 'WECOM') THEN
      RAISE EXCEPTION 'wecom collections must be refunded through the original wecom route'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_wecom_refund_original_route';
    END IF;
    SELECT fact_id
      INTO reversed_collection_fact_id
      FROM collection_facts
      WHERE reverses_fact_id = NEW.references_fact_id;
    IF FOUND THEN
      RAISE EXCEPTION 'refund facts cannot reference a reversed collection'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_reversed';
    END IF;
    SELECT COALESCE(SUM(refund.amount_minor), 0)
      INTO active_refunded_minor
      FROM collection_facts AS refund
      WHERE refund.fact_type = 'REFUND'
        AND refund.references_fact_id = NEW.references_fact_id
        AND NOT EXISTS (
          SELECT 1 FROM collection_facts AS reversal
          WHERE reversal.reverses_fact_id = refund.fact_id
        );
    IF active_refunded_minor + NEW.amount_minor::bigint > referenced_amount_minor::bigint THEN
      RAISE EXCEPTION 'refund exceeds remaining referenced collection amount'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_remaining_amount';
    END IF;
  END IF;
  IF NEW.fact_type = 'REVERSAL' THEN
    SELECT fact_type
      INTO reversed_fact_type
      FROM collection_facts
      WHERE fact_id = NEW.reverses_fact_id
      FOR UPDATE;
    IF FOUND AND reversed_fact_type = 'COLLECTION' THEN
      SELECT COALESCE(SUM(refund.amount_minor), 0)
        INTO active_refunded_minor
        FROM collection_facts AS refund
        WHERE refund.fact_type = 'REFUND'
          AND refund.references_fact_id = NEW.reverses_fact_id
          AND NOT EXISTS (
            SELECT 1 FROM collection_facts AS reversal
            WHERE reversal.reverses_fact_id = refund.fact_id
          );
      IF active_refunded_minor > 0 THEN
        RAISE EXCEPTION 'collection facts with active refunds cannot be reversed'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_collection_has_active_refunds';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
