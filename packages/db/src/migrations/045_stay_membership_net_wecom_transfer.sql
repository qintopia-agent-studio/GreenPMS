-- A conversion may transfer only the unrefunded balance of a WECOM lodging
-- collection. Ordinary REVERSAL facts keep their exact-full-amount rule from
-- migration 011; this relaxation is limited to the typed conversion bridge.
LOCK TABLE collection_facts, membership_payment_facts,
  stay_collection_membership_transfers, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

-- A normal REVERSAL still cancels its source fact in full and may not be
-- recorded while an active refund exists. The sole exception is the typed
-- conversion bridge: it cancels exactly the remaining WECOM balance after
-- original-route refunds. The deferred Stage 13 graph then requires its
-- matching transfer before the transaction can commit.
CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  order_currency char(3);
  referenced_fact_type text;
  referenced_order_id text;
  reversed_fact_type text;
  reversed_order_id text;
  reversed_currency char(3);
  reversed_amount_minor integer;
  reversed_net_effect_minor integer;
  reversal_command_type text;
  active_refunded_minor bigint;
  expected_reversal_minor bigint;
BEGIN
  SELECT property.currency
    INTO order_currency
    FROM orders AS booking
    JOIN properties AS property ON property.id = booking.property_id
    WHERE booking.id = NEW.order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'collection facts require an existing order'
      USING ERRCODE = '23503', CONSTRAINT = 'collection_facts_order_required';
  END IF;
  IF NEW.currency IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'collection fact currency must match the order property currency'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_order_currency_match';
  END IF;

  IF NEW.fact_type = 'COLLECTION' THEN
    IF NEW.net_effect_minor::bigint IS DISTINCT FROM NEW.amount_minor::bigint THEN
      RAISE EXCEPTION 'collection net effect must equal its amount'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_collection_net_effect';
    END IF;
    IF NEW.references_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'collection facts cannot reference another fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_collection_reference_null';
    END IF;
    IF NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'collection facts cannot reverse another fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_collection_reversal_null';
    END IF;
  ELSIF NEW.fact_type = 'REFUND' THEN
    IF NEW.net_effect_minor::bigint IS DISTINCT FROM -(NEW.amount_minor::bigint) THEN
      RAISE EXCEPTION 'refund net effect must be the negative of its amount'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_net_effect';
    END IF;
    IF NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'refund facts cannot reverse another fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reversal_null';
    END IF;
    SELECT fact_type, order_id
      INTO referenced_fact_type, referenced_order_id
      FROM collection_facts
      WHERE fact_id = NEW.references_fact_id;
    IF NOT FOUND OR referenced_fact_type IS DISTINCT FROM 'COLLECTION' THEN
      RAISE EXCEPTION 'refund facts must reference a collection fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_collection';
    END IF;
    IF referenced_order_id IS DISTINCT FROM NEW.order_id THEN
      RAISE EXCEPTION 'refund facts must reference a collection in the same order'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_refund_reference_same_order';
    END IF;
  ELSIF NEW.fact_type = 'REVERSAL' THEN
    IF NEW.references_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'reversal facts cannot use the refund reference field'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_reference_null';
    END IF;
    IF NEW.reverses_fact_id IS NULL THEN
      RAISE EXCEPTION 'reversal facts require the fact they reverse'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_target_required';
    END IF;
    SELECT fact_type, order_id, currency, amount_minor, net_effect_minor
      INTO reversed_fact_type, reversed_order_id, reversed_currency, reversed_amount_minor, reversed_net_effect_minor
      FROM collection_facts
      WHERE fact_id = NEW.reverses_fact_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reversal facts require an existing fact'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_target_required';
    END IF;
    IF reversed_fact_type = 'REVERSAL' THEN
      RAISE EXCEPTION 'reversal facts cannot reverse another reversal'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_target_not_reversal';
    END IF;
    IF reversed_order_id IS DISTINCT FROM NEW.order_id THEN
      RAISE EXCEPTION 'reversal facts must reverse a fact in the same order'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_same_order';
    END IF;
    IF reversed_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'reversal facts must use the reversed fact currency'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_same_currency';
    END IF;
    SELECT command_type
      INTO reversal_command_type
      FROM command_executions
      WHERE id = NEW.command_id;
    SELECT COALESCE(SUM(refund.amount_minor), 0)
      INTO active_refunded_minor
      FROM collection_facts AS refund
      WHERE reversed_fact_type = 'COLLECTION'
        AND refund.fact_type = 'REFUND'
        AND refund.references_fact_id = NEW.reverses_fact_id
        AND NOT EXISTS (
          SELECT 1 FROM collection_facts AS refund_reversal
          WHERE refund_reversal.reverses_fact_id = refund.fact_id
        );
    expected_reversal_minor := reversed_amount_minor::bigint - active_refunded_minor;
    IF reversal_command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
      AND reversed_fact_type = 'COLLECTION'
      AND active_refunded_minor > 0 THEN
      IF expected_reversal_minor <= 0
        OR NEW.amount_minor::bigint IS DISTINCT FROM expected_reversal_minor
        OR NEW.net_effect_minor::bigint IS DISTINCT FROM -expected_reversal_minor THEN
        RAISE EXCEPTION 'conversion reversal must negate the remaining lodging balance'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_conversion_reversal_remaining_amount';
      END IF;
    ELSE
      IF NEW.amount_minor IS DISTINCT FROM reversed_amount_minor THEN
        RAISE EXCEPTION 'reversal amount must equal the reversed fact amount'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_amount';
      END IF;
      IF NEW.net_effect_minor::bigint IS DISTINCT FROM -(reversed_net_effect_minor::bigint) THEN
        RAISE EXCEPTION 'reversal net effect must negate the reversed fact net effect'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_net_effect';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  reversed_amount_minor integer;
  reversal_command_type text;
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
    SELECT fact_type, amount_minor
      INTO reversed_fact_type, reversed_amount_minor
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
        SELECT command_type
          INTO reversal_command_type
          FROM command_executions
          WHERE id = NEW.command_id;
        IF reversal_command_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          OR NEW.amount_minor::bigint IS DISTINCT FROM reversed_amount_minor::bigint - active_refunded_minor
          OR NEW.net_effect_minor::bigint IS DISTINCT FROM -(reversed_amount_minor::bigint - active_refunded_minor) THEN
          RAISE EXCEPTION 'collection facts with active refunds cannot be reversed'
            USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_reversal_collection_has_active_refunds';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_membership_payment_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_order membership_orders%ROWTYPE;
  source_fact collection_facts%ROWTYPE;
  source_property_id text;
  corrected membership_payment_facts%ROWTYPE;
  reversed membership_payment_facts%ROWTYPE;
  active_refunded_minor bigint;
BEGIN
  NEW.transaction_reference := NULLIF(
    regexp_replace(btrim(NEW.transaction_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  NEW.source_order_id := NULLIF(btrim(NEW.source_order_id), '');
  NEW.source_collection_fact_id := NULLIF(btrim(NEW.source_collection_fact_id), '');

  SELECT * INTO target_order FROM membership_orders WHERE id = NEW.membership_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership payment requires an existing membership order'
      USING ERRCODE = '23503', CONSTRAINT = 'membership_payment_order_required';
  END IF;
  IF NEW.currency IS DISTINCT FROM target_order.currency THEN
    RAISE EXCEPTION 'membership payment currency must match its membership order'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_currency_match';
  END IF;

  IF NEW.source_type = 'DIRECT_WECOM' THEN
    IF NEW.source_order_id IS NOT NULL OR NEW.source_collection_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'direct membership payments cannot carry lodging source fields'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_direct_source_null';
    END IF;
  ELSIF NEW.source_type = 'STAY_COLLECTION_TRANSFER' THEN
    IF NEW.fact_type IS DISTINCT FROM 'COLLECTION'
      OR NEW.net_effect_minor IS DISTINCT FROM NEW.amount_minor
      OR NEW.transaction_reference IS NOT NULL
      OR NEW.corrects_fact_id IS NOT NULL
      OR NEW.reverses_fact_id IS NOT NULL
      OR NEW.source_order_id IS NULL
      OR NEW.source_collection_fact_id IS NULL THEN
      RAISE EXCEPTION 'transferred lodging collection has an invalid membership payment shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_transfer_shape';
    END IF;
    SELECT * INTO source_fact
      FROM collection_facts
      WHERE fact_id = NEW.source_collection_fact_id;
    SELECT property_id INTO source_property_id
      FROM orders
      WHERE id = source_fact.order_id;
    SELECT COALESCE(sum(refund.amount_minor), 0)
      INTO active_refunded_minor
      FROM collection_facts AS refund
      WHERE refund.fact_type = 'REFUND'
        AND refund.references_fact_id = source_fact.fact_id
        AND NOT EXISTS (
          SELECT 1 FROM collection_facts AS reversal
          WHERE reversal.reverses_fact_id = refund.fact_id
        );
    IF NOT FOUND
      OR source_fact.order_id IS DISTINCT FROM NEW.source_order_id
      OR source_property_id IS DISTINCT FROM target_order.property_id
      OR source_fact.fact_type IS DISTINCT FROM 'COLLECTION'
      OR source_fact.method IS DISTINCT FROM 'WECOM'
      OR NULLIF(btrim(source_fact.transaction_reference), '') IS NULL
      OR source_fact.amount_minor - active_refunded_minor IS DISTINCT FROM NEW.amount_minor
      OR NEW.amount_minor <= 0
      OR source_fact.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'transferred membership payment must match the remaining WECOM lodging collection balance'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_transfer_source';
    END IF;
  ELSE
    RAISE EXCEPTION 'membership payment source type is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_source_type_check';
  END IF;

  IF NEW.fact_type = 'COLLECTION' THEN
    IF NEW.net_effect_minor IS DISTINCT FROM NEW.amount_minor
      OR NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'membership collection has an invalid shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_collection_shape';
    END IF;
    IF NEW.source_type = 'DIRECT_WECOM' AND NEW.transaction_reference IS NULL THEN
      RAISE EXCEPTION 'direct membership collection requires a transaction reference'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_collection_shape';
    END IF;
    IF NEW.source_type = 'DIRECT_WECOM'
      AND NEW.transaction_reference IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM stay_collection_membership_transfers AS transfer
        JOIN collection_facts AS source
          ON source.order_id = transfer.order_id
        WHERE transfer.membership_order_id = NEW.membership_order_id
          AND source.fact_type = 'COLLECTION'
          AND source.transaction_reference = NEW.transaction_reference
      ) THEN
      RAISE EXCEPTION 'direct membership collection must not reuse a lodging transaction reference from the converted order'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_conversion_direct_reference_new';
    END IF;
    IF NEW.corrects_fact_id IS NOT NULL THEN
      SELECT * INTO corrected FROM membership_payment_facts WHERE fact_id = NEW.corrects_fact_id;
      IF NOT FOUND
        OR corrected.fact_type <> 'COLLECTION'
        OR corrected.source_type <> 'DIRECT_WECOM'
        OR corrected.membership_order_id <> NEW.membership_order_id THEN
        RAISE EXCEPTION 'replacement collection must correct a direct collection in the same membership order'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_correction_target';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM membership_payment_facts WHERE reverses_fact_id = NEW.corrects_fact_id) THEN
        RAISE EXCEPTION 'replacement collection requires a reversal of the corrected fact'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_correction_reversal_required';
      END IF;
    END IF;
  ELSE
    IF NEW.source_type <> 'DIRECT_WECOM'
      OR NEW.corrects_fact_id IS NOT NULL
      OR NEW.reverses_fact_id IS NULL
      OR NEW.transaction_reference IS NOT NULL THEN
      RAISE EXCEPTION 'membership reversal has an invalid shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_shape';
    END IF;
    SELECT * INTO reversed FROM membership_payment_facts WHERE fact_id = NEW.reverses_fact_id;
    IF NOT FOUND
      OR reversed.fact_type <> 'COLLECTION'
      OR reversed.source_type <> 'DIRECT_WECOM'
      OR reversed.membership_order_id <> NEW.membership_order_id THEN
      RAISE EXCEPTION 'membership reversal must reverse a direct collection in the same membership order'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_target';
    END IF;
    IF NEW.amount_minor IS DISTINCT FROM reversed.amount_minor
      OR NEW.net_effect_minor IS DISTINCT FROM -reversed.net_effect_minor
      OR NEW.currency IS DISTINCT FROM reversed.currency THEN
      RAISE EXCEPTION 'membership reversal must negate the original collection'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_amount';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stay_collection_membership_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_fact collection_facts%ROWTYPE;
  source_reversal collection_facts%ROWTYPE;
  membership_payment membership_payment_facts%ROWTYPE;
  membership_order membership_orders%ROWTYPE;
  source_property_id text;
  execution_type text;
  active_refunded_minor bigint;
  residual_minor bigint;
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  SELECT * INTO source_fact FROM collection_facts WHERE fact_id = NEW.source_collection_fact_id FOR UPDATE;
  SELECT * INTO source_reversal FROM collection_facts WHERE fact_id = NEW.source_reversal_fact_id FOR UPDATE;
  SELECT * INTO membership_payment FROM membership_payment_facts WHERE fact_id = NEW.membership_payment_fact_id FOR UPDATE;
  SELECT * INTO membership_order FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  SELECT property_id INTO source_property_id FROM orders WHERE id = NEW.order_id;
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;

  IF source_fact.fact_id IS NULL
    OR source_reversal.fact_id IS NULL
    OR membership_payment.fact_id IS NULL
    OR membership_order.id IS NULL
    OR source_property_id IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires complete source and destination facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_complete';
  END IF;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires its typed command'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_command';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stay_collection_membership_transfers AS existing
    WHERE existing.order_id = NEW.order_id
      AND (existing.command_id IS DISTINCT FROM NEW.command_id
        OR existing.membership_order_id IS DISTINCT FROM NEW.membership_order_id)
  ) THEN
    RAISE EXCEPTION 'one lodging order can be converted to membership only once'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_one_conversion_per_order';
  END IF;
  IF NEW.property_id IS DISTINCT FROM source_property_id
    OR membership_order.property_id IS DISTINCT FROM NEW.property_id THEN
    RAISE EXCEPTION 'stay-to-membership transfer must stay inside one property'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_property';
  END IF;
  IF source_fact.order_id IS DISTINCT FROM NEW.order_id
    OR source_fact.fact_type IS DISTINCT FROM 'COLLECTION'
    OR source_fact.method IS DISTINCT FROM 'WECOM'
    OR NULLIF(btrim(source_fact.transaction_reference), '') IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership transfer source must be a WECOM lodging collection'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM collection_facts AS reversal
    WHERE reversal.reverses_fact_id = source_fact.fact_id
      AND reversal.fact_id IS DISTINCT FROM source_reversal.fact_id
  ) THEN
    RAISE EXCEPTION 'ordinary-reversed lodging collections cannot be transferred to membership'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_reversed';
  END IF;
  SELECT COALESCE(SUM(refund.amount_minor), 0)
    INTO active_refunded_minor
    FROM collection_facts AS refund
    WHERE refund.fact_type = 'REFUND'
      AND refund.references_fact_id = source_fact.fact_id
      AND NOT EXISTS (
        SELECT 1 FROM collection_facts AS reversal
        WHERE reversal.reverses_fact_id = refund.fact_id
      );
  residual_minor := source_fact.amount_minor - active_refunded_minor;
  IF residual_minor <= 0 THEN
    RAISE EXCEPTION 'fully refunded lodging collections cannot create a transfer fact'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_refunded';
  END IF;
  IF source_reversal.order_id IS DISTINCT FROM NEW.order_id
    OR source_reversal.fact_type IS DISTINCT FROM 'REVERSAL'
    OR source_reversal.reverses_fact_id IS DISTINCT FROM source_fact.fact_id
    OR source_reversal.command_id IS DISTINCT FROM NEW.command_id
    OR source_reversal.amount_minor IS DISTINCT FROM residual_minor
    OR source_reversal.net_effect_minor IS DISTINCT FROM -residual_minor
    OR source_reversal.currency IS DISTINCT FROM source_fact.currency THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires a reversal of the remaining lodging balance'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_reversal';
  END IF;
  IF membership_payment.membership_order_id IS DISTINCT FROM NEW.membership_order_id
    OR membership_payment.fact_type IS DISTINCT FROM 'COLLECTION'
    OR membership_payment.source_type IS DISTINCT FROM 'STAY_COLLECTION_TRANSFER'
    OR membership_payment.source_order_id IS DISTINCT FROM NEW.order_id
    OR membership_payment.source_collection_fact_id IS DISTINCT FROM source_fact.fact_id
    OR membership_payment.command_id IS DISTINCT FROM NEW.command_id
    OR membership_payment.transaction_reference IS NOT NULL
    OR membership_payment.amount_minor IS DISTINCT FROM residual_minor
    OR membership_payment.net_effect_minor IS DISTINCT FROM residual_minor
    OR membership_payment.currency IS DISTINCT FROM source_fact.currency THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires a matching remaining-balance membership payment fact'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_payment';
  END IF;
  RETURN NEW;
END;
$$;

-- Keep 045 fail-closed against the frozen 044 Stage 13 body before replacing it
-- with snapshot-aware conversion semantics.
DO $assert_frozen_044_stage13$
DECLARE
  frozen_body_hash text;
BEGIN
  SELECT encode(sha256(convert_to(procedure_row.prosrc, 'UTF8')), 'hex')
    INTO frozen_body_hash
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      to_regprocedure('qintopia_assert_stage13_stay_conversion_command_v033(text)');

  IF frozen_body_hash IS DISTINCT FROM '6327c242458f6b4e040eeb8bd263a0325cf62801a38384f86c4ada3ddef4b7a3' THEN
    RAISE EXCEPTION 'migration 045 expected the frozen 044 conversion assertion body'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_frozen_044_body';
  END IF;
END;
$assert_frozen_044_stage13$;

CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command_v033(target_command_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  amendment_count integer;
  target_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  conversion_revision pricing_revisions%ROWTYPE;
  current_revision pricing_revisions%ROWTYPE;
  target_membership_order membership_orders%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  target_member members%ROWTYPE;
  membership_order_count integer;
  conversion_revision_count integer;
  latest_revision_no integer;
  post_amendment_count integer;
  post_amendment_last_version integer;
  payload_service_dates jsonb;
  payload_service_date_count integer;
  payload_distinct_service_date_count integer;
  payload_first_service_date date;
  payload_last_service_date date;
  payload_service_date_set jsonb;
  payload_entitlement_units integer;
  payload_consumed_units integer;
  payload_remaining_units integer;
  payload_valid_from date;
  payload_valid_until date;
  transfer_count integer;
  transfer_residual_total bigint;
  transfer_reversal_total bigint;
  transfer_membership_total bigint;
  direct_membership_count integer;
  direct_membership_total bigint;
  actual_lodging_net bigint;
  conversion_ledger_count integer;
  conversion_ledger_delta bigint;
  conversion_ledger_with_coverage_count integer;
  conversion_ledger_without_coverage_count integer;
  conversion_ledger_service_date_set jsonb;
  conversion_coverage_count integer;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO amendment_count
    FROM amendments
    WHERE command_id = target_command_id;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;
  SELECT * INTO target_amendment
    FROM amendments
    WHERE command_id = target_command_id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  IF amendment_count <> 1 OR NOT FOUND THEN
    RAISE EXCEPTION 'stay-to-membership conversion requires exactly one typed amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_amendment';
  END IF;

  SELECT * INTO STRICT target_order FROM orders WHERE id = target_amendment.order_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT count(*)::integer INTO conversion_revision_count
    FROM pricing_revisions
    WHERE order_id = target_order.id
      AND amendment_id = target_amendment.id;
  SELECT * INTO conversion_revision
    FROM pricing_revisions
    WHERE order_id = target_order.id
      AND amendment_id = target_amendment.id;
  SELECT * INTO STRICT current_revision
    FROM pricing_revisions
    WHERE id = target_order.current_revision_id;
  SELECT COALESCE(max(revision_no), 0)::integer
    INTO latest_revision_no
    FROM pricing_revisions
    WHERE order_id = target_order.id;

  SELECT count(*)::integer INTO membership_order_count
    FROM membership_orders
    WHERE created_by_command_id = target_command_id
      AND activated_by_command_id = target_command_id;
  SELECT * INTO target_membership_order
    FROM membership_orders
    WHERE created_by_command_id = target_command_id
      AND activated_by_command_id = target_command_id;
  IF membership_order_count <> 1 OR target_membership_order.id IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership conversion requires one active membership order created by the same command'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_order';
  END IF;
  SELECT * INTO target_contract
    FROM member_contracts
    WHERE id = target_membership_order.contract_id;
  SELECT * INTO target_lot
    FROM entitlement_lots
    WHERE id = target_membership_order.entitlement_lot_id;
  SELECT * INTO target_member
    FROM members
    WHERE id = target_membership_order.member_id;

  payload_service_dates := target_amendment.payload #> '{entitlement,serviceDates}';
  BEGIN
    payload_entitlement_units :=
      (target_amendment.payload #>> '{entitlement,entitlementUnits}')::integer;
    payload_consumed_units :=
      (target_amendment.payload #>> '{entitlement,consumedUnits}')::integer;
    payload_remaining_units :=
      (target_amendment.payload #>> '{entitlement,remainingUnits}')::integer;
    payload_valid_from :=
      (target_amendment.payload #>> '{entitlement,validFrom}')::date;
    payload_valid_until :=
      (target_amendment.payload #>> '{entitlement,validUntil}')::date;
    PERFORM service_date.value::date
      FROM jsonb_array_elements_text(payload_service_dates) AS service_date(value);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'stay-to-membership conversion must carry typed entitlement payload dates and units'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_entitlement';
  END;
  SELECT count(*)::integer,
         count(DISTINCT service_date)::integer,
         min(service_date),
         max(service_date),
         COALESCE(jsonb_agg(to_jsonb(service_date::text) ORDER BY service_date), '[]'::jsonb)
    INTO payload_service_date_count,
      payload_distinct_service_date_count,
      payload_first_service_date,
      payload_last_service_date,
      payload_service_date_set
    FROM (
      SELECT service_date.value::date
      FROM jsonb_array_elements_text(payload_service_dates) AS service_date(value)
    ) AS payload_dates(service_date);

  IF execution_property_id IS DISTINCT FROM target_order.property_id
    OR NOT (
      (target_order.status = 'CHECKED_OUT' AND target_stay.status = 'COMPLETED')
      OR (target_order.status = 'CHECKED_IN' AND target_stay.status = 'IN_HOUSE')
    )
    OR target_order.stay_type = 'FREE'
    OR target_order.booking_channel_code IS DISTINCT FROM 'WECOM'
    OR target_order.member_id IS DISTINCT FROM target_membership_order.member_id
    OR target_order.member_contract_id IS DISTINCT FROM target_contract.id
    OR conversion_revision_count <> 1
    OR conversion_revision.id IS NULL
    OR conversion_revision.amendment_id IS DISTINCT FROM target_amendment.id
    OR conversion_revision.order_id IS DISTINCT FROM target_order.id
    OR conversion_revision.arrival_date IS DISTINCT FROM payload_first_service_date
    OR conversion_revision.departure_date IS DISTINCT FROM payload_last_service_date + 1
    OR conversion_revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR conversion_revision.current_contract_amount_minor IS DISTINCT FROM 0
    OR conversion_revision.manual_adjustment_minor IS DISTINCT FROM 0
    OR conversion_revision.coverage_set IS DISTINCT FROM '[]'::jsonb
    OR conversion_revision.cash_lines IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'stay-to-membership conversion must leave one linked in-house or completed lodging order at zero amount'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_order_state';
  END IF;

  SELECT count(*)::integer,
         COALESCE(max(new_version), target_amendment.new_version)::integer
    INTO post_amendment_count, post_amendment_last_version
    FROM amendments
    WHERE order_id = target_order.id
      AND sequence > target_amendment.sequence;
  IF target_order.version < target_amendment.new_version
    OR post_amendment_last_version IS DISTINCT FROM target_order.version
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT amendment.*,
               execution.command_type,
               execution.state AS command_state,
               execution.property_id AS command_property_id,
               row_number() OVER (ORDER BY amendment.sequence) AS chain_position,
               lag(amendment.new_version) OVER (ORDER BY amendment.sequence) AS prior_chain_version
        FROM amendments AS amendment
        LEFT JOIN command_executions AS execution
          ON execution.id = amendment.command_id
        WHERE amendment.order_id = target_order.id
          AND amendment.sequence > target_amendment.sequence
      ) AS post
      WHERE post.amendment_type NOT IN (
          'EXTEND_STAY',
          'SHORTEN_STAY',
          'MOVE_UNIT',
          'CHECK_OUT',
          'CORRECT_ORDER_OCCUPANT'
        )
        OR post.command_state IS DISTINCT FROM 'APPLIED'
        OR post.command_property_id IS DISTINCT FROM target_order.property_id
        OR NOT (
          post.command_type IS NOT DISTINCT FROM post.amendment_type
          OR (post.amendment_type = 'CHECK_OUT'
            AND post.command_type IS NOT DISTINCT FROM 'SHORTEN_STAY')
        )
        OR post.sequence IS DISTINCT FROM target_amendment.sequence + post.chain_position
        OR post.prior_version IS DISTINCT FROM
          COALESCE(post.prior_chain_version, target_amendment.new_version)
        OR post.new_version IS DISTINCT FROM post.prior_version + 1
    ) THEN
    RAISE EXCEPTION 'converted stay version chain may only contain approved fulfillment amendments after conversion'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_current_chain';
  END IF;

  IF current_revision.order_id IS DISTINCT FROM target_order.id
    OR current_revision.revision_no IS DISTINCT FROM latest_revision_no
    OR current_revision.revision_no < conversion_revision.revision_no
    OR current_revision.arrival_date IS DISTINCT FROM target_order.arrival_date
    OR current_revision.departure_date IS DISTINCT FROM target_order.departure_date
    OR current_revision.policy_version_id IS DISTINCT FROM target_order.pricing_policy_version_id
    OR current_revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR current_revision.current_contract_amount_minor IS DISTINCT FROM 0
    OR current_revision.manual_adjustment_minor IS DISTINCT FROM 0
    OR current_revision.cash_lines IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'converted stay must keep its current projection on the latest zero membership-entitlement revision'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_current_projection';
  END IF;

  IF target_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_membership_order.agreed_price_minor <= 0
    OR target_membership_order.contract_id IS NULL
    OR target_membership_order.entitlement_lot_id IS NULL
    OR target_contract.id IS NULL
    OR target_lot.id IS NULL
    OR target_member.id IS NULL
    OR target_membership_order.member_id IS DISTINCT FROM target_member.id
    OR target_membership_order.created_by_command_id IS DISTINCT FROM target_command_id
    OR target_membership_order.activated_by_command_id IS DISTINCT FROM target_command_id
    OR target_membership_order.product_id IS DISTINCT FROM target_amendment.payload #>> '{product,productId}'
    OR target_membership_order.product_code IS DISTINCT FROM target_amendment.payload #>> '{product,code}'
    OR target_membership_order.product_version::text IS DISTINCT FROM target_amendment.payload #>> '{product,version}'
    OR target_membership_order.product_name IS DISTINCT FROM target_amendment.payload #>> '{product,name}'
    OR target_membership_order.listed_price_minor::text
      IS DISTINCT FROM target_amendment.payload #>> '{membershipPricing,listedPrice,minorUnits}'
    OR target_membership_order.agreed_price_minor::text
      IS DISTINCT FROM target_amendment.payload #>> '{membershipPricing,agreedPrice,minorUnits}'
    OR target_membership_order.price_adjustment_minor::text
      IS DISTINCT FROM target_amendment.payload #>> '{membershipPricing,adjustment,minorUnits}'
    OR target_membership_order.price_adjustment_reason
      IS DISTINCT FROM target_amendment.payload #>> '{membershipPricing,adjustmentReason}'
    OR target_membership_order.currency::text
      IS DISTINCT FROM target_amendment.payload #>> '{membershipPricing,agreedPrice,currency}'
    OR target_membership_order.entitlement_unit_kind
      IS DISTINCT FROM target_amendment.payload #>> '{entitlement,entitlementUnitKind}'
    OR target_membership_order.entitlement_units IS DISTINCT FROM payload_entitlement_units
    OR target_membership_order.allowed_room_type_code
      IS DISTINCT FROM target_amendment.payload #>> '{product,allowedRoomTypeCode}'
    OR target_membership_order.allowed_inventory_kind
      IS DISTINCT FROM target_amendment.payload #>> '{product,allowedInventoryKind}'
    OR target_membership_order.valid_from IS DISTINCT FROM payload_valid_from
    OR target_membership_order.valid_until IS DISTINCT FROM payload_valid_until
    OR target_contract.membership_order_id IS DISTINCT FROM target_membership_order.id
    OR target_contract.member_id IS DISTINCT FROM target_membership_order.member_id
    OR target_contract.property_id IS DISTINCT FROM target_membership_order.property_id
    OR target_contract.valid_from IS DISTINCT FROM payload_valid_from
    OR target_contract.valid_until IS DISTINCT FROM payload_valid_until
    OR target_lot.contract_id IS DISTINCT FROM target_contract.id
    OR target_lot.unit_kind IS DISTINCT FROM target_membership_order.entitlement_unit_kind
    OR target_lot.total_units IS DISTINCT FROM target_membership_order.entitlement_units
    OR target_lot.expires_on IS DISTINCT FROM payload_valid_until THEN
    RAISE EXCEPTION 'stay-to-membership conversion contract, price, and entitlement lot must match the membership order'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_contract_lot';
  END IF;

  IF target_amendment.payload #>> '{member,memberId}'
      IS DISTINCT FROM target_membership_order.member_id
    OR NULLIF(
      regexp_replace(target_amendment.payload #>> '{primaryOccupant,phone}', '[[:space:]]+', '', 'g'),
      ''
    ) IS DISTINCT FROM regexp_replace(target_member.phone, '[[:space:]]+', '', 'g')
    OR NULLIF(
      regexp_replace(target_amendment.payload #>> '{member,phone}', '[[:space:]]+', '', 'g'),
      ''
    ) IS DISTINCT FROM regexp_replace(target_member.phone, '[[:space:]]+', '', 'g') THEN
    RAISE EXCEPTION 'stay-to-membership conversion member identity must match the conversion payload phone'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_member_identity';
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(source.amount_minor - refunded.active_refunded_minor), 0)::bigint,
         COALESCE(sum(reversal.amount_minor), 0)::bigint,
         COALESCE(sum(payment.amount_minor), 0)::bigint
    INTO transfer_count, transfer_residual_total, transfer_reversal_total, transfer_membership_total
    FROM stay_collection_membership_transfers AS transfer
    JOIN collection_facts AS source
      ON source.fact_id = transfer.source_collection_fact_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(refund.amount_minor), 0)::bigint AS active_refunded_minor
      FROM collection_facts AS refund
      WHERE refund.fact_type = 'REFUND'
        AND refund.references_fact_id = source.fact_id
        AND NOT EXISTS (
          SELECT 1 FROM collection_facts AS refund_reversal
          WHERE refund_reversal.reverses_fact_id = refund.fact_id
        )
    ) AS refunded ON TRUE
    JOIN collection_facts AS reversal
      ON reversal.fact_id = transfer.source_reversal_fact_id
    JOIN membership_payment_facts AS payment
      ON payment.fact_id = transfer.membership_payment_fact_id
    WHERE transfer.command_id = target_command_id
      AND transfer.order_id = target_order.id
      AND transfer.membership_order_id = target_membership_order.id;
  SELECT count(*)::integer, COALESCE(sum(amount_minor), 0)::bigint
    INTO direct_membership_count, direct_membership_total
    FROM membership_payment_facts
    WHERE membership_order_id = target_membership_order.id
      AND source_type = 'DIRECT_WECOM'
      AND fact_type = 'COLLECTION';
  SELECT COALESCE(sum(net_effect_minor), 0)::bigint
    INTO actual_lodging_net
    FROM collection_facts
    WHERE order_id = target_order.id;

  IF EXISTS (
    SELECT 1
    FROM stay_collection_membership_transfers AS transfer
    WHERE transfer.membership_order_id = target_membership_order.id
      AND (transfer.command_id IS DISTINCT FROM target_command_id
        OR transfer.order_id IS DISTINCT FROM target_order.id)
  ) OR EXISTS (
    SELECT 1
    FROM membership_payment_facts AS payment
    WHERE payment.membership_order_id = target_membership_order.id
      AND (payment.command_id IS DISTINCT FROM target_command_id
        OR payment.fact_type IS DISTINCT FROM 'COLLECTION'
        OR payment.amount_minor <= 0
        OR payment.net_effect_minor IS DISTINCT FROM payment.amount_minor
        OR payment.corrects_fact_id IS NOT NULL
        OR payment.reverses_fact_id IS NOT NULL
        OR payment.source_type NOT IN ('DIRECT_WECOM', 'STAY_COLLECTION_TRANSFER')
        OR (payment.source_type = 'DIRECT_WECOM'
          AND NULLIF(btrim(payment.transaction_reference), '') IS NULL)
        OR (payment.source_type = 'STAY_COLLECTION_TRANSFER'
          AND NOT EXISTS (
            SELECT 1
            FROM stay_collection_membership_transfers AS transfer
            WHERE transfer.command_id = target_command_id
              AND transfer.order_id = target_order.id
              AND transfer.membership_order_id = target_membership_order.id
              AND transfer.membership_payment_fact_id = payment.fact_id
          )))
  ) OR transfer_residual_total IS DISTINCT FROM transfer_reversal_total
    OR transfer_residual_total IS DISTINCT FROM transfer_membership_total
    OR transfer_residual_total + direct_membership_total
      IS DISTINCT FROM target_membership_order.agreed_price_minor
    OR actual_lodging_net IS DISTINCT FROM 0
    OR direct_membership_count > 1
    OR NOT EXISTS (
      SELECT 1
      FROM membership_payment_facts AS payment
      LEFT JOIN stay_collection_membership_transfers AS transfer
        ON transfer.membership_payment_fact_id = payment.fact_id
      LEFT JOIN collection_facts AS source
        ON source.fact_id = transfer.source_collection_fact_id
      WHERE payment.membership_order_id = target_membership_order.id
        AND payment.fact_type = 'COLLECTION'
        AND payment.amount_minor > 0
        AND (
          (payment.source_type = 'DIRECT_WECOM'
            AND NULLIF(btrim(payment.transaction_reference), '') IS NOT NULL)
          OR (payment.source_type = 'STAY_COLLECTION_TRANSFER'
            AND source.method = 'WECOM'
            AND NULLIF(btrim(source.transaction_reference), '') IS NOT NULL)
        )
    ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion must conserve positive, traceable lodging and membership funds'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_funds_conserved';
  END IF;

  IF transfer_count = 0 THEN
    IF transfer_residual_total <> 0
      OR transfer_reversal_total <> 0
      OR transfer_membership_total <> 0
      OR direct_membership_count <> 1
      OR direct_membership_total IS DISTINCT FROM target_membership_order.agreed_price_minor THEN
      RAISE EXCEPTION 'zero-transfer conversion requires zero remaining lodging balance and one full direct payment'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_zero_transfer_funds';
    END IF;
  ELSIF transfer_residual_total <= 0 THEN
    RAISE EXCEPTION 'positive transfer conversion requires positive remaining lodging balance'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_complete_lodging_funds';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM collection_facts AS fact
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(refund.amount_minor), 0)::bigint AS active_refunded_minor
      FROM collection_facts AS refund
      WHERE refund.fact_type = 'REFUND'
        AND refund.references_fact_id = fact.fact_id
        AND NOT EXISTS (
          SELECT 1 FROM collection_facts AS refund_reversal
          WHERE refund_reversal.reverses_fact_id = refund.fact_id
        )
    ) AS refunded ON fact.fact_type = 'COLLECTION'
    WHERE fact.order_id = target_order.id
      AND NOT (
        (fact.fact_type = 'COLLECTION'
          AND fact.amount_minor > 0
          AND fact.net_effect_minor = fact.amount_minor
          AND fact.method = 'WECOM'
          AND NULLIF(btrim(fact.transaction_reference), '') IS NOT NULL
          AND fact.references_fact_id IS NULL
          AND fact.reverses_fact_id IS NULL
          AND refunded.active_refunded_minor BETWEEN 0 AND fact.amount_minor
          AND (
            (fact.amount_minor - refunded.active_refunded_minor > 0
              AND EXISTS (
                SELECT 1
                FROM stay_collection_membership_transfers AS transfer
                WHERE transfer.command_id = target_command_id
                  AND transfer.order_id = target_order.id
                  AND transfer.source_collection_fact_id = fact.fact_id
              ))
            OR (fact.amount_minor = refunded.active_refunded_minor
              AND NOT EXISTS (
                SELECT 1
                FROM stay_collection_membership_transfers AS transfer
                WHERE transfer.source_collection_fact_id = fact.fact_id
              ))
          ))
        OR (fact.fact_type = 'REFUND'
          AND fact.amount_minor > 0
          AND fact.net_effect_minor = -fact.amount_minor
          AND fact.method = 'WECOM'
          AND NULLIF(btrim(fact.transaction_reference), '') IS NULL
          AND fact.references_fact_id IS NOT NULL
          AND fact.reverses_fact_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM collection_facts AS source
            WHERE source.fact_id = fact.references_fact_id
              AND source.order_id = target_order.id
              AND source.fact_type = 'COLLECTION'
              AND source.method = 'WECOM'
          ))
        OR (fact.fact_type = 'REVERSAL'
          AND fact.command_id = target_command_id
          AND EXISTS (
            SELECT 1
            FROM stay_collection_membership_transfers AS transfer
            WHERE transfer.command_id = target_command_id
              AND transfer.order_id = target_order.id
              AND transfer.source_reversal_fact_id = fact.fact_id
              AND transfer.source_collection_fact_id = fact.reverses_fact_id
          ))
      )
  ) THEN
    RAISE EXCEPTION 'conversion requires the complete valid WECOM lodging fund graph and transfers every remaining balance'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_complete_lodging_funds';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM membership_payment_facts AS direct
    JOIN collection_facts AS source
      ON source.order_id = target_order.id
      AND source.fact_type = 'COLLECTION'
    WHERE direct.membership_order_id = target_membership_order.id
      AND direct.source_type = 'DIRECT_WECOM'
      AND direct.fact_type = 'COLLECTION'
      AND direct.transaction_reference = source.transaction_reference
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion direct payment must use a new transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_direct_reference_new';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM amendments AS conversion
    WHERE conversion.order_id = target_order.id
      AND conversion.amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
      AND conversion.command_id IS DISTINCT FROM target_command_id
  ) THEN
    RAISE EXCEPTION 'one lodging order can be converted to membership only once'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_one_per_order';
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(quantity_delta), 0)::bigint,
         count(*) FILTER (WHERE coverage_id IS NOT NULL)::integer,
         count(*) FILTER (WHERE coverage_id IS NULL)::integer,
         COALESCE(jsonb_agg(to_jsonb(service_date::text) ORDER BY service_date), '[]'::jsonb)
    INTO conversion_ledger_count,
      conversion_ledger_delta,
      conversion_ledger_with_coverage_count,
      conversion_ledger_without_coverage_count,
      conversion_ledger_service_date_set
    FROM entitlement_ledger
    WHERE command_id = target_command_id
      AND order_id = target_order.id
      AND lot_id = target_membership_order.entitlement_lot_id
      AND entry_type = 'CONVERSION_CONSUME';
  IF jsonb_typeof(payload_service_dates) IS DISTINCT FROM 'array'
    OR payload_service_date_count <= 0
    OR payload_service_date_count IS DISTINCT FROM payload_distinct_service_date_count
    OR payload_service_date_count IS DISTINCT FROM payload_consumed_units
    OR payload_entitlement_units IS DISTINCT FROM target_membership_order.entitlement_units
    OR payload_entitlement_units - payload_consumed_units IS DISTINCT FROM payload_remaining_units
    OR target_membership_order.entitlement_units < payload_consumed_units
    OR payload_service_date_count
      IS DISTINCT FROM payload_last_service_date - payload_first_service_date + 1
    OR conversion_ledger_count IS DISTINCT FROM payload_service_date_count
    OR conversion_ledger_delta IS DISTINCT FROM -payload_service_date_count
    OR conversion_ledger_service_date_set IS DISTINCT FROM payload_service_date_set
    OR (
      conversion_ledger_with_coverage_count <> conversion_ledger_count
      AND conversion_ledger_without_coverage_count <> conversion_ledger_count
    )
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS ledger
      WHERE ledger.command_id = target_command_id
        AND (ledger.entry_type IS DISTINCT FROM 'CONVERSION_CONSUME'
          OR ledger.order_id IS DISTINCT FROM target_order.id
          OR ledger.lot_id IS DISTINCT FROM target_membership_order.entitlement_lot_id
          OR ledger.quantity_delta IS DISTINCT FROM -1
          OR ledger.service_date < payload_first_service_date
          OR ledger.service_date > payload_last_service_date
          OR NOT (payload_service_date_set @> jsonb_build_array(ledger.service_date::text)))
    ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion must consume exactly the planned stay once'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_entitlement';
  END IF;

  IF conversion_ledger_without_coverage_count = conversion_ledger_count THEN
    IF EXISTS (
      SELECT 1
      FROM coverage_items
      WHERE order_id = target_order.id
        AND contract_id = target_contract.id
        AND lot_id = target_lot.id
        AND held_by_revision_id = conversion_revision.id
    ) THEN
      RAISE EXCEPTION 'completed-stay conversion consumption must remain coverage-free'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_completed_coverage';
    END IF;
  ELSE
    SELECT count(*)::integer INTO conversion_coverage_count
      FROM entitlement_ledger AS ledger
      JOIN coverage_items AS coverage
        ON coverage.id = ledger.coverage_id
      WHERE ledger.command_id = target_command_id
        AND ledger.entry_type = 'CONVERSION_CONSUME'
        AND ledger.order_id = target_order.id
        AND ledger.lot_id = target_lot.id;
    IF conversion_coverage_count <> payload_service_date_count
      OR EXISTS (
        SELECT 1
        FROM entitlement_ledger AS ledger
        LEFT JOIN coverage_items AS coverage
          ON coverage.id = ledger.coverage_id
        LEFT JOIN inventory_units AS unit
          ON unit.id = coverage.inventory_unit_id
        WHERE ledger.command_id = target_command_id
          AND ledger.entry_type = 'CONVERSION_CONSUME'
          AND (ledger.coverage_id IS NULL
            OR coverage.id IS NULL
            OR coverage.order_id IS DISTINCT FROM target_order.id
            OR coverage.contract_id IS DISTINCT FROM target_contract.id
            OR coverage.lot_id IS DISTINCT FROM target_lot.id
            OR coverage.service_date IS DISTINCT FROM ledger.service_date
            OR coverage.held_by_revision_id IS DISTINCT FROM conversion_revision.id
            OR coverage.status NOT IN ('CONSUMED', 'RELEASED')
            OR coverage.unit_kind IS DISTINCT FROM target_membership_order.entitlement_unit_kind
            OR unit.kind IS DISTINCT FROM target_membership_order.allowed_inventory_kind
            OR unit.room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code
            OR NOT (payload_service_date_set @> jsonb_build_array(coverage.service_date::text)))
      )
      OR EXISTS (
        SELECT 1
        FROM coverage_items AS coverage
        WHERE coverage.held_by_revision_id = conversion_revision.id
          AND (
            coverage.order_id IS DISTINCT FROM target_order.id
            OR coverage.contract_id IS DISTINCT FROM target_contract.id
            OR coverage.lot_id IS DISTINCT FROM target_lot.id
            OR NOT EXISTS (
              SELECT 1
              FROM entitlement_ledger AS ledger
              WHERE ledger.command_id = target_command_id
                AND ledger.entry_type = 'CONVERSION_CONSUME'
                AND ledger.coverage_id = coverage.id
            )
          )
      ) THEN
      RAISE EXCEPTION 'in-house conversion requires one consumed coverage and one bound conversion consumption per conversion service date'
        USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_inhouse_coverage';
    END IF;
  END IF;
END;
$$;

DO $verify_existing_conversions$
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
$verify_existing_conversions$;
