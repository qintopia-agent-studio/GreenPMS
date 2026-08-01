-- Historical facts may legitimately lack an immutable pricing-revision link.
-- Keep that state readable without permitting any newly inserted fact to omit it.
ALTER TABLE collection_facts
  ALTER COLUMN pricing_revision_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_transaction_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  referenced_fact_type text;
  referenced_order_id text;
  referenced_amount_minor integer;
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
  IF NEW.fact_type IN ('COLLECTION', 'REFUND') AND NEW.transaction_reference IS NULL THEN
    RAISE EXCEPTION 'new collection and refund facts require a transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_new_transaction_reference_required';
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
  END IF;
  IF NEW.fact_type = 'REFUND' THEN
    IF NEW.references_fact_id IS NULL THEN
      RAISE EXCEPTION 'refund facts require a referenced collection fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_required';
    END IF;
    SELECT fact_type, order_id, amount_minor
      INTO referenced_fact_type, referenced_order_id, referenced_amount_minor
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
