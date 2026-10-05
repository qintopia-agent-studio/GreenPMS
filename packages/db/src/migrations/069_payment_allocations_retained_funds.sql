-- Incremental, append-only allocation ledger. Historical cash facts remain untouched.
LOCK TABLE collection_facts, external_payment_matches, external_payment_bills IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE collection_facts ADD COLUMN external_payment_bill_id text REFERENCES external_payment_bills(id);
ALTER TABLE collection_facts DROP CONSTRAINT collection_facts_fact_type_check;
ALTER TABLE collection_facts ADD CONSTRAINT collection_facts_fact_type_check CHECK (fact_type IN ('COLLECTION','REFUND','REVERSAL','REALLOCATION_IN','REALLOCATION_OUT'));
CREATE TABLE external_payment_allocations (
 id text PRIMARY KEY, bill_id text NOT NULL REFERENCES external_payment_bills(id),
 collection_fact_id text NOT NULL UNIQUE REFERENCES collection_facts(fact_id),
 amount_minor integer NOT NULL CHECK(amount_minor>0), command_id text REFERENCES command_executions(id),
 origin text NOT NULL CHECK(origin IN ('CONFIRMED','HISTORICAL_LINK')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_payment_allocation_releases (
 id text PRIMARY KEY, allocation_id text NOT NULL UNIQUE REFERENCES external_payment_allocations(id),
 reversal_fact_id text NOT NULL UNIQUE REFERENCES collection_facts(fact_id), command_id text NOT NULL REFERENCES command_executions(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE retained_funds (
 id text PRIMARY KEY, property_id text NOT NULL REFERENCES properties(id), source_order_id text NOT NULL REFERENCES orders(id),
 source_fact_id text NOT NULL REFERENCES collection_facts(fact_id), bill_id text NOT NULL REFERENCES external_payment_bills(id),
 owner_name text NOT NULL CHECK(length(btrim(owner_name))>0), owner_contact text NOT NULL CHECK(length(btrim(owner_contact))>0),
 confirmation_note text NOT NULL CHECK(length(btrim(confirmation_note))>0), amount_minor integer NOT NULL CHECK(amount_minor>0),
 command_id text NOT NULL REFERENCES command_executions(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE retained_fund_entries (
 id text PRIMARY KEY, retained_fund_id text NOT NULL REFERENCES retained_funds(id), kind text NOT NULL CHECK(kind IN ('USE','REFUND','RELEASE')),
 amount_minor integer NOT NULL CHECK(amount_minor>0), target_order_id text REFERENCES orders(id),
 source_out_fact_id text UNIQUE REFERENCES collection_facts(fact_id), target_in_fact_id text UNIQUE REFERENCES collection_facts(fact_id),
 refund_fact_id text UNIQUE REFERENCES collection_facts(fact_id), authorization_note text NOT NULL CHECK(length(btrim(authorization_note))>0),
 command_id text NOT NULL REFERENCES command_executions(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='USE' AND target_order_id IS NOT NULL AND source_out_fact_id IS NOT NULL AND target_in_fact_id IS NOT NULL AND refund_fact_id IS NULL)
 OR (kind='REFUND' AND target_order_id IS NULL AND source_out_fact_id IS NULL AND target_in_fact_id IS NULL AND refund_fact_id IS NOT NULL)
 OR (kind='RELEASE' AND num_nonnulls(target_order_id,source_out_fact_id,target_in_fact_id,refund_fact_id)=0))
);
CREATE INDEX external_payment_allocations_bill ON external_payment_allocations(bill_id);
CREATE INDEX retained_funds_source ON retained_funds(source_fact_id);
CREATE INDEX retained_funds_property ON retained_funds(property_id,created_at,id);
CREATE INDEX retained_fund_entries_parent ON retained_fund_entries(retained_fund_id);
-- No facts or events are emitted by the backfill, including reversed historical matches.
INSERT INTO external_payment_allocations(id,bill_id,collection_fact_id,amount_minor,command_id,origin,created_at)
 SELECT 'legacy:'||m.bill_id,m.bill_id,m.collection_fact_id,f.amount_minor,NULL,'HISTORICAL_LINK',m.created_at
 FROM external_payment_matches m JOIN collection_facts f ON f.fact_id=m.collection_fact_id;

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
    IF NOT FOUND OR referenced_fact_type NOT IN ('COLLECTION','REALLOCATION_IN') THEN
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
    IF NOT FOUND OR referenced_fact_type NOT IN ('COLLECTION','REALLOCATION_IN') THEN
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

CREATE OR REPLACE FUNCTION qintopia_validate_wecom_refund_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE property_key text;
BEGIN
  NEW.refund_reference := NULLIF(btrim(NEW.refund_reference), '');
  IF NEW.fact_type = 'REFUND' AND NEW.method = 'WECOM' THEN
    IF NEW.refund_reference IS NULL OR length(NEW.refund_reference) > 200 THEN
      RAISE EXCEPTION 'new wecom refunds require their own refund reference'
        USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_wecom_refund_reference_required';
    END IF;
    SELECT property_id INTO property_key FROM orders WHERE id=NEW.order_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('wecom-refund:'||property_key||':'||NEW.refund_reference,0));
    IF EXISTS(SELECT 1 FROM collection_facts f JOIN orders o ON o.id=f.order_id
      WHERE o.property_id=property_key AND f.method='WECOM' AND f.fact_type='REFUND'
        AND f.refund_reference=NEW.refund_reference
        AND (NEW.external_payment_bill_id IS NULL OR f.external_payment_bill_id IS DISTINCT FROM NEW.external_payment_bill_id)) THEN
      RAISE EXCEPTION 'wecom refund reference is already recorded for this property'
        USING ERRCODE='23505', CONSTRAINT='collection_facts_wecom_refund_reference_unique';
    END IF;
  ELSIF NEW.refund_reference IS NOT NULL THEN
    RAISE EXCEPTION 'refund reference is only supported for wecom refund facts'
      USING ERRCODE = '23514', CONSTRAINT = 'collection_facts_wecom_refund_reference_shape';
  END IF;
  RETURN NEW;
END;
$$;


CREATE FUNCTION qintopia_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'allocation history is append-only' USING ERRCODE='23514'; END $$;

-- Every writer of a shared source takes the same lock before its INSERT.
CREATE FUNCTION qintopia_allocation_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text; source_bill_id text;
BEGIN
 IF TG_TABLE_NAME='external_payment_allocations' THEN k:=NEW.bill_id;
 ELSIF TG_TABLE_NAME='external_payment_allocation_releases' THEN SELECT bill_id INTO k FROM external_payment_allocations WHERE id=NEW.allocation_id;
 ELSIF TG_TABLE_NAME='retained_funds' THEN k:=NEW.bill_id;
 ELSIF TG_TABLE_NAME='retained_fund_entries' THEN SELECT bill_id INTO k FROM retained_funds WHERE id=NEW.retained_fund_id;
 ELSIF TG_TABLE_NAME='external_payment_matches' THEN k:=NEW.bill_id;
 ELSE
  k:=NEW.external_payment_bill_id;
  IF k IS NULL THEN SELECT COALESCE(f.external_payment_bill_id,a.bill_id) INTO k FROM collection_facts f LEFT JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id WHERE f.fact_id=COALESCE(NEW.references_fact_id,NEW.reverses_fact_id); END IF;
 END IF;
 IF k IS NOT NULL THEN
  SELECT COALESCE(c.id,b.id) INTO source_bill_id FROM external_payment_bills b LEFT JOIN external_payment_bills c ON c.source_id=b.source_id AND c.merchant_id=b.merchant_id AND c.kind='COLLECTION' AND c.reference=b.transaction_id WHERE b.id=k;
  PERFORM 1 FROM external_payment_bills WHERE id IN (k,source_bill_id) ORDER BY id FOR UPDATE;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION qintopia_allocation_fact_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b external_payment_bills%ROWTYPE; source_fact collection_facts%ROWTYPE; p text; source_bill text;
BEGIN
 IF NEW.external_payment_bill_id IS NOT NULL THEN
  SELECT * INTO STRICT b FROM external_payment_bills WHERE id=NEW.external_payment_bill_id;
  SELECT property_id INTO p FROM orders WHERE id=NEW.order_id;
  IF b.state<>'SUCCESS' OR b.needs_review OR b.amount_minor IS NULL OR p IS DISTINCT FROM b.property_id OR NEW.currency<>'CNY' OR NEW.method<>'WECOM' THEN
   RAISE EXCEPTION 'unverified or cross-property allocation source' USING ERRCODE='23514';
  END IF;
  IF NEW.fact_type IN ('COLLECTION','REFUND') AND (b.kind<>NEW.fact_type OR CASE WHEN NEW.fact_type='COLLECTION' THEN NEW.transaction_reference ELSE NEW.refund_reference END IS DISTINCT FROM b.reference) THEN
   RAISE EXCEPTION 'allocation transaction reference mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.fact_type='REFUND' THEN
   SELECT COALESCE(cf.external_payment_bill_id,a.bill_id) INTO source_bill FROM collection_facts cf LEFT JOIN external_payment_allocations a ON a.collection_fact_id=cf.fact_id WHERE cf.fact_id=NEW.references_fact_id;
   IF NOT EXISTS(SELECT 1 FROM external_payment_bills c WHERE c.id=source_bill AND c.kind='COLLECTION' AND c.source_id=b.source_id AND c.merchant_id=b.merchant_id AND c.reference=b.transaction_id) THEN
    RAISE EXCEPTION 'refund original source mismatch' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 IF NEW.fact_type IN ('REALLOCATION_IN','REALLOCATION_OUT') THEN
  SELECT * INTO STRICT source_fact FROM collection_facts WHERE fact_id=NEW.references_fact_id;
  SELECT COALESCE(source_fact.external_payment_bill_id,a.bill_id) INTO source_bill FROM external_payment_allocations a WHERE a.collection_fact_id=source_fact.fact_id;
  source_bill:=COALESCE(source_fact.external_payment_bill_id,source_bill);
  IF source_fact.fact_type NOT IN ('COLLECTION','REALLOCATION_IN') OR NEW.external_payment_bill_id IS NULL OR source_bill IS DISTINCT FROM NEW.external_payment_bill_id OR b.kind<>'COLLECTION'
   OR NEW.reverses_fact_id IS NOT NULL OR NEW.transaction_reference IS NOT NULL OR NEW.refund_reference IS NOT NULL
   OR NEW.net_effect_minor::bigint <> (CASE WHEN NEW.fact_type='REALLOCATION_IN' THEN NEW.amount_minor::bigint ELSE -NEW.amount_minor::bigint END)
   OR (NEW.fact_type='REALLOCATION_OUT' AND NEW.order_id<>source_fact.order_id)
   OR (NEW.fact_type='REALLOCATION_IN' AND NEW.order_id=source_fact.order_id)
   OR EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND booking_channel_code IN ('YOUMUDAO','CTRIP','MEITUAN')) THEN
    RAISE EXCEPTION 'invalid internal reallocation shape' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.fact_type='REVERSAL' AND EXISTS(SELECT 1 FROM collection_facts WHERE fact_id=NEW.reverses_fact_id AND fact_type IN ('REALLOCATION_IN','REALLOCATION_OUT')) THEN
  RAISE EXCEPTION 'internal transfers cannot be reversed independently' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- Deferred checks see the complete cash/allocation/transfer graph, never half a command.
CREATE FUNCTION qintopia_assert_allocation_graph() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Only newly inserted reversals require release regardless of allocation origin.
 -- Do not retroactively release or reject pre-migration historical reversals.
 -- Nest the table check: other trigger tables do not have these NEW fields.
 IF TG_TABLE_NAME='collection_facts' THEN
  IF NEW.fact_type='REVERSAL' AND EXISTS(
   SELECT 1 FROM collection_facts f JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id
   WHERE f.fact_id=NEW.reverses_fact_id AND f.fact_type='REFUND'
    AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id AND r.reversal_fact_id=NEW.fact_id)) THEN
   RAISE EXCEPTION 'external refund reversal requires attribution release' USING ERRCODE='23514';
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM external_payment_allocations a JOIN external_payment_bills b ON b.id=a.bill_id JOIN collection_facts f ON f.fact_id=a.collection_fact_id JOIN orders o ON o.id=f.order_id
   WHERE a.amount_minor<>f.amount_minor OR b.kind<>f.fact_type OR o.property_id<>b.property_id OR f.currency<>'CNY' OR f.method<>'WECOM'
    OR (a.origin='CONFIRMED' AND (a.command_id IS DISTINCT FROM f.command_id OR f.external_payment_bill_id IS DISTINCT FROM b.id ))
    OR (a.origin='HISTORICAL_LINK' AND NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=a.bill_id AND m.collection_fact_id=a.collection_fact_id))) THEN
  RAISE EXCEPTION 'invalid allocation fact graph' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM external_payment_bills b WHERE
   COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a WHERE a.bill_id=b.id AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id)),0)>b.amount_minor
   OR (EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.bill_id=b.id) AND EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=b.id AND m.membership_payment_fact_id IS NOT NULL))) THEN
  RAISE EXCEPTION 'allocation exceeds bill or conflicts with membership' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM collection_facts f WHERE f.external_payment_bill_id IS NOT NULL AND f.fact_type IN ('COLLECTION','REFUND') AND NOT EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=f.fact_id AND a.bill_id=f.external_payment_bill_id)) THEN
  RAISE EXCEPTION 'explicit cash fact requires matching allocation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM external_payment_allocation_releases r JOIN external_payment_allocations a ON a.id=r.allocation_id JOIN collection_facts f ON f.fact_id=r.reversal_fact_id
  WHERE f.fact_type<>'REVERSAL' OR f.reverses_fact_id IS DISTINCT FROM a.collection_fact_id OR f.command_id<>r.command_id
   OR EXISTS(SELECT 1 FROM retained_funds h WHERE h.source_fact_id=a.collection_fact_id AND (h.amount_minor>(SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=h.id AND e.kind='RELEASE')))
   OR EXISTS(SELECT 1 FROM collection_facts x WHERE x.references_fact_id=a.collection_fact_id AND x.fact_type IN ('REFUND','REALLOCATION_OUT') AND NOT EXISTS(SELECT 1 FROM collection_facts v WHERE v.reverses_fact_id=x.fact_id))
   OR EXISTS(SELECT 1 FROM membership_payment_facts m WHERE m.source_collection_fact_id=a.collection_fact_id)) THEN
  RAISE EXCEPTION 'occupied allocation cannot be released' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM collection_facts v JOIN collection_facts f ON f.fact_id=v.reverses_fact_id
  JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id
  WHERE v.fact_type='REVERSAL' AND f.fact_type='REFUND' AND a.origin='CONFIRMED'
   AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases r WHERE r.allocation_id=a.id AND r.reversal_fact_id=v.fact_id)) THEN
  RAISE EXCEPTION 'external refund reversal requires attribution release' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM retained_funds h JOIN collection_facts f ON f.fact_id=h.source_fact_id JOIN orders o ON o.id=f.order_id
  LEFT JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id
  WHERE f.fact_type NOT IN ('COLLECTION','REALLOCATION_IN') OR f.method<>'WECOM' OR o.property_id<>h.property_id OR f.order_id<>h.source_order_id
   OR COALESCE(f.external_payment_bill_id,a.bill_id) IS DISTINCT FROM h.bill_id
   OR (EXISTS(SELECT 1 FROM collection_facts r WHERE r.reverses_fact_id=f.fact_id) AND h.amount_minor>(SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=h.id AND e.kind='RELEASE'))) THEN
  RAISE EXCEPTION 'invalid retained source' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM retained_funds h WHERE (SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=h.id)>h.amount_minor) THEN
  RAISE EXCEPTION 'retained funds overspent' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM retained_fund_entries e JOIN retained_funds h ON h.id=e.retained_fund_id
  LEFT JOIN collection_facts x ON x.fact_id=e.source_out_fact_id LEFT JOIN collection_facts y ON y.fact_id=e.target_in_fact_id LEFT JOIN collection_facts r ON r.fact_id=e.refund_fact_id
  WHERE (e.kind='USE' AND (x.fact_type IS DISTINCT FROM 'REALLOCATION_OUT' OR y.fact_type IS DISTINCT FROM 'REALLOCATION_IN'
    OR x.order_id<>h.source_order_id OR y.order_id<>e.target_order_id OR x.references_fact_id IS DISTINCT FROM h.source_fact_id OR y.references_fact_id IS DISTINCT FROM h.source_fact_id
    OR x.amount_minor<>e.amount_minor OR y.amount_minor<>e.amount_minor OR x.command_id<>e.command_id OR y.command_id<>e.command_id
    OR x.external_payment_bill_id IS DISTINCT FROM h.bill_id OR y.external_payment_bill_id IS DISTINCT FROM h.bill_id))
   OR (e.kind='REFUND' AND (r.fact_type IS DISTINCT FROM 'REFUND' OR r.references_fact_id IS DISTINCT FROM h.source_fact_id OR r.order_id<>h.source_order_id OR r.amount_minor<>e.amount_minor OR r.command_id<>e.command_id))) THEN
  RAISE EXCEPTION 'retained entry graph mismatch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM collection_facts f WHERE f.fact_type IN ('REALLOCATION_IN','REALLOCATION_OUT') AND NOT EXISTS(SELECT 1 FROM retained_fund_entries e WHERE e.kind='USE' AND CASE WHEN f.fact_type='REALLOCATION_IN' THEN e.target_in_fact_id ELSE e.source_out_fact_id END=f.fact_id)) THEN
  RAISE EXCEPTION 'internal reallocation must be paired atomically' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM collection_facts f WHERE f.fact_type IN ('COLLECTION','REALLOCATION_IN') AND
  (SELECT COALESCE(sum(x.amount_minor),0) FROM collection_facts x WHERE x.references_fact_id=f.fact_id AND x.fact_type IN ('REFUND','REALLOCATION_OUT') AND NOT EXISTS(SELECT 1 FROM collection_facts r WHERE r.reverses_fact_id=x.fact_id))
  + (SELECT COALESCE(sum(h.amount_minor-(SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=h.id)),0) FROM retained_funds h WHERE h.source_fact_id=f.fact_id)
   > f.amount_minor) THEN RAISE EXCEPTION 'source funds overspent or reserved' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM collection_facts f WHERE f.fact_type='REVERSAL' AND (
  EXISTS(SELECT 1 FROM retained_funds h WHERE h.source_fact_id=f.reverses_fact_id AND h.amount_minor>(SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=h.id))
  OR EXISTS(SELECT 1 FROM collection_facts x WHERE x.references_fact_id=f.reverses_fact_id AND x.fact_type='REALLOCATION_OUT')
  OR EXISTS(SELECT 1 FROM retained_fund_entries e WHERE e.refund_fact_id=f.reverses_fact_id))) THEN
  RAISE EXCEPTION 'occupied source cannot be reversed' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

-- Legacy whole-bill callers still create a match; mirror it once without new cash facts.
CREATE FUNCTION qintopia_mirror_external_payment_allocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.collection_fact_id IS NOT NULL THEN
  INSERT INTO external_payment_allocations(id,bill_id,collection_fact_id,amount_minor,origin,created_at)
   SELECT 'legacy:'||NEW.bill_id,NEW.bill_id,fact_id,amount_minor,'HISTORICAL_LINK',NEW.created_at FROM collection_facts WHERE fact_id=NEW.collection_fact_id
   ON CONFLICT(collection_fact_id) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER external_payment_allocation_mirror AFTER INSERT ON external_payment_matches FOR EACH ROW EXECUTE FUNCTION qintopia_mirror_external_payment_allocation();
CREATE TRIGGER allocation_00_lock BEFORE INSERT ON collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_lock();
CREATE TRIGGER allocation_fact_guard BEFORE INSERT ON collection_facts FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_fact_guard();
CREATE TRIGGER allocation_00_lock BEFORE INSERT ON external_payment_matches FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_lock();
CREATE CONSTRAINT TRIGGER allocation_graph AFTER INSERT ON collection_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_assert_allocation_graph();
CREATE CONSTRAINT TRIGGER allocation_graph AFTER INSERT ON external_payment_matches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_assert_allocation_graph();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['external_payment_allocations','external_payment_allocation_releases','retained_funds','retained_fund_entries'] LOOP
  EXECUTE format('CREATE TRIGGER allocation_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_immutable()',t);
  EXECUTE format('CREATE TRIGGER allocation_00_lock BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_lock()',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER allocation_graph AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_assert_allocation_graph()',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, qintopia_runtime, qintopia_payment_worker',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO qintopia_runtime',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION qintopia_allocation_immutable(),qintopia_allocation_lock(),qintopia_allocation_fact_guard(),qintopia_assert_allocation_graph(),qintopia_mirror_external_payment_allocation() FROM PUBLIC;

CREATE FUNCTION qintopia_retained_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE net bigint; reserved bigint; due bigint;
BEGIN
 PERFORM 1 FROM orders WHERE id=NEW.source_order_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.source_order_id AND property_id=NEW.property_id AND status IN ('CANCELLED','NO_SHOW','CHECKED_OUT') AND member_contract_id IS NULL AND stay_type<>'FREE' AND (booking_channel_code IS NULL OR booking_channel_code='WECOM')) THEN
  RAISE EXCEPTION 'retention requires completed ordinary direct order' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM amendments WHERE order_id=NEW.source_order_id AND amendment_type='CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP') THEN
  RAISE EXCEPTION 'converted member funds cannot be retained' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM collection_facts WHERE fact_id=NEW.source_fact_id AND fact_type='REALLOCATION_IN') AND NOT EXISTS(
  SELECT 1 FROM retained_fund_entries e JOIN retained_funds h ON h.id=e.retained_fund_id
   WHERE e.target_in_fact_id=NEW.source_fact_id AND h.owner_name=NEW.owner_name AND h.owner_contact=NEW.owner_contact) THEN
  RAISE EXCEPTION 'retained owner must survive reallocation' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(net_effect_minor),0) INTO net FROM collection_facts WHERE order_id=NEW.source_order_id;
 SELECT COALESCE(p.current_contract_amount_minor,0) INTO due FROM orders o LEFT JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.id=NEW.source_order_id;
 SELECT COALESCE(sum(h.amount_minor-(SELECT COALESCE(sum(e.amount_minor),0) FROM retained_fund_entries e WHERE e.retained_fund_id=h.id)),0) INTO reserved FROM retained_funds h WHERE h.source_order_id=NEW.source_order_id;
 IF NEW.amount_minor+reserved>net-due THEN RAISE EXCEPTION 'retention exceeds order surplus' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retained_source_guard BEFORE INSERT ON retained_funds FOR EACH ROW EXECUTE FUNCTION qintopia_retained_source_guard();

CREATE FUNCTION qintopia_allocation_unassigned_refund_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text; must_check boolean:=true;
BEGIN
 IF TG_TABLE_NAME='external_payment_allocations' THEN k:=NEW.bill_id; must_check:=NEW.origin='CONFIRMED';
 ELSIF TG_TABLE_NAME='external_payment_allocation_releases' THEN SELECT bill_id INTO k FROM external_payment_allocations WHERE id=NEW.allocation_id;
 ELSIF TG_TABLE_NAME='retained_funds' THEN k:=NEW.bill_id;
 ELSE SELECT bill_id INTO k FROM retained_funds WHERE id=NEW.retained_fund_id; must_check:=NEW.kind<>'REFUND'; END IF;
 IF must_check AND EXISTS(SELECT 1 FROM external_payment_bills c JOIN external_payment_bills r ON r.source_id=c.source_id AND r.merchant_id=c.merchant_id AND r.transaction_id=c.reference AND r.kind='REFUND' AND r.state='SUCCESS'
  WHERE c.id=k AND c.kind='COLLECTION' AND (r.amount_minor IS NULL OR r.needs_review OR r.amount_minor>(SELECT COALESCE(sum(a.amount_minor),0) FROM external_payment_allocations a WHERE a.bill_id=r.id AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)))) THEN
  RAISE EXCEPTION 'unassigned successful refund freezes source funds' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['external_payment_allocations','external_payment_allocation_releases','retained_funds','retained_fund_entries'] LOOP
  EXECUTE format('CREATE TRIGGER allocation_unassigned_refund_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_unassigned_refund_guard()',t);
 END LOOP;
END $$;
CREATE FUNCTION qintopia_allocation_membership_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text;
BEGIN
 IF NEW.source_collection_fact_id IS NOT NULL THEN
  SELECT bill_id INTO k FROM external_payment_allocations WHERE collection_fact_id=NEW.source_collection_fact_id;
  IF k IS NOT NULL THEN
   PERFORM 1 FROM external_payment_bills WHERE id=k FOR UPDATE;
   IF (SELECT count(*) FROM external_payment_allocations WHERE bill_id=k)<>1
    OR EXISTS(SELECT 1 FROM external_payment_allocations a JOIN external_payment_bills b ON b.id=a.bill_id WHERE a.bill_id=k AND a.amount_minor<>b.amount_minor)
    OR EXISTS(SELECT 1 FROM retained_funds WHERE bill_id=k)
    OR EXISTS(SELECT 1 FROM collection_facts WHERE external_payment_bill_id=k AND fact_type IN ('REALLOCATION_IN','REALLOCATION_OUT')) THEN
    RAISE EXCEPTION 'split or retained payment cannot transfer to membership' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_membership_guard BEFORE INSERT ON membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_membership_guard();
REVOKE ALL ON FUNCTION qintopia_retained_source_guard(),qintopia_allocation_unassigned_refund_guard(),qintopia_allocation_membership_guard() FROM PUBLIC;

INSERT INTO command_catalog(command_type,command_class) VALUES
 ('RETAIN_ORDER_FUNDS','HUMAN_COMMAND'),('APPLY_RETAINED_FUNDS','HUMAN_COMMAND'),('RELEASE_RETAINED_FUNDS','HUMAN_COMMAND'),('REFUND_RETAINED_FUNDS','HUMAN_COMMAND');
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint WHERE conrelid='subject_command_grants'::regclass AND conname='subject_command_grants_human_exact_check';
 IF position('''RECORD_COLLECTION''::text' IN definition)=0 THEN RAISE EXCEPTION 'missing grant baseline'; END IF;
 definition:=replace(definition,'''RECORD_COLLECTION''::text','''RECORD_COLLECTION''::text, ''RETAIN_ORDER_FUNDS''::text, ''APPLY_RETAINED_FUNDS''::text, ''RELEASE_RETAINED_FUNDS''::text, ''REFUND_RETAINED_FUNDS''::text');
 ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
 EXECUTE 'ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check '||definition;
END $$;
INSERT INTO staff_command_profile_catalog(profile,command_type,token_default)
 SELECT c.profile,m.new_command,c.token_default FROM staff_command_profile_catalog c JOIN (VALUES
 ('RECORD_COLLECTION','RETAIN_ORDER_FUNDS'),('RECORD_COLLECTION','APPLY_RETAINED_FUNDS'),('REVERSE_FACT','RELEASE_RETAINED_FUNDS'),('RECORD_REFUND','REFUND_RETAINED_FUNDS')) m(old_command,new_command) ON c.command_type=m.old_command;
INSERT INTO subject_command_grants(subject_id,property_id,command_type)
 SELECT g.subject_id,g.property_id,m.new_command FROM subject_command_grants g JOIN (VALUES
 ('RECORD_COLLECTION','RETAIN_ORDER_FUNDS'),('RECORD_COLLECTION','APPLY_RETAINED_FUNDS'),('REVERSE_FACT','RELEASE_RETAINED_FUNDS'),('RECORD_REFUND','REFUND_RETAINED_FUNDS')) m(old_command,new_command) ON g.command_type=m.old_command;
-- Existing token ceilings deliberately remain unchanged.
UPDATE staff_profile_reconciliation_state SET projection_hash=(SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value,E'\n' ORDER BY row_value),''),'UTF8')),'hex') FROM (
 SELECT format('A|%s|%s|%s',subject_id,property_id,profile) AS row_value FROM staff_profile_assignments UNION ALL SELECT format('G|%s|%s|%s',subject_id,property_id,command_type) FROM subject_command_grants) projection),reconciled_by=current_user,reconciled_at=now() WHERE singleton;

-- Retained operations change displayed order funding without inventing new cash.
DO $$ DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure) INTO definition;
 IF position('''RECORD_REFUND'', ''REVERSE_FACT'', ''REFRESH_MEMBER_COVERAGE''' IN definition)=0 THEN
  RAISE EXCEPTION 'allocation room-status allowlist not recognized'; END IF;
 EXECUTE replace(definition, '''RECORD_REFUND'', ''REVERSE_FACT'', ''REFRESH_MEMBER_COVERAGE''',
  '''RECORD_REFUND'', ''REVERSE_FACT'', ''RETAIN_ORDER_FUNDS'', ''APPLY_RETAINED_FUNDS'', ''RELEASE_RETAINED_FUNDS'', ''REFUND_RETAINED_FUNDS'', ''REFRESH_MEMBER_COVERAGE''');
END $$;
