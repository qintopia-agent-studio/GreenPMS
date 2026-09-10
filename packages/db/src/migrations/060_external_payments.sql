DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qintopia_payment_worker') THEN
    CREATE ROLE qintopia_payment_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO qintopia_payment_worker;
CREATE TABLE external_payment_sources (
  id text PRIMARY KEY,
  corp_id text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  matching_since timestamptz NOT NULL DEFAULT '2026-09-01 00:00:00+08',
  import_since timestamptz NOT NULL,
  synced_until timestamptz,
  baseline_complete boolean NOT NULL DEFAULT false,
  reconciliation_until timestamptz,
  last_success_at timestamptz,
  last_reconciliation_at timestamptz,
  last_error_code text,
  CHECK (import_since <= matching_since)
);
CREATE TABLE external_payment_accounts (
  source_id text NOT NULL REFERENCES external_payment_sources(id),
  merchant_id text NOT NULL,
  property_id text NOT NULL REFERENCES properties(id),
  PRIMARY KEY (source_id, merchant_id),
  UNIQUE (source_id, merchant_id, property_id)
);
CREATE TABLE external_payment_bills (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  merchant_id text NOT NULL,
  property_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('COLLECTION','REFUND')),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  original_trade_no text NOT NULL,
  transaction_id text,
  external_user_id text,
  collector_id text,
  amount_minor integer CHECK (amount_minor > 0),
  occurred_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('SUCCESS','PENDING','CLOSED','UNKNOWN')),
  needs_review boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id,merchant_id,property_id) REFERENCES external_payment_accounts(source_id,merchant_id,property_id),
  UNIQUE (source_id,merchant_id,kind,reference)
);
CREATE INDEX external_payment_bills_candidates ON external_payment_bills(property_id,kind,occurred_at DESC,id);
CREATE INDEX external_payment_bills_original ON external_payment_bills(source_id,merchant_id,original_trade_no,kind);
CREATE TABLE external_payment_contacts (
  source_id text NOT NULL REFERENCES external_payment_sources(id),
  external_user_id text NOT NULL,
  nickname text,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (source_id,external_user_id)
);
CREATE TABLE external_payment_matches (
  bill_id text PRIMARY KEY REFERENCES external_payment_bills(id),
  collection_fact_id text UNIQUE REFERENCES collection_facts(fact_id),
  membership_payment_fact_id text UNIQUE REFERENCES membership_payment_facts(fact_id),
  origin text NOT NULL CHECK (origin IN ('CONFIRMED','HISTORICAL_LINK')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(collection_fact_id,membership_payment_fact_id) = 1)
);
-- Durable discovery feed; financial agent consumption is a separate contract
-- from the existing personnel/stay integration event types.
CREATE TABLE external_payment_event_heads (
  property_id text PRIMARY KEY REFERENCES properties(id),
  last_sequence bigint NOT NULL DEFAULT 0
);
CREATE TABLE external_payment_events (
  property_id text NOT NULL REFERENCES properties(id),
  sequence bigint NOT NULL,
  event_id text NOT NULL UNIQUE,
  bill_id text NOT NULL REFERENCES external_payment_bills(id),
  event_type text NOT NULL CHECK (event_type IN ('DISCOVERED','MATCHED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_id,event_type),
  PRIMARY KEY (property_id,sequence)
);

CREATE FUNCTION qintopia_validate_external_payment_match() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  bill external_payment_bills%ROWTYPE;
  fact collection_facts%ROWTYPE;
  member_fact membership_payment_facts%ROWTYPE;
  target_property text;
  parent_reference text;
BEGIN
  SELECT * INTO STRICT bill FROM external_payment_bills WHERE id=NEW.bill_id FOR UPDATE;
  IF bill.state <> 'SUCCESS' OR bill.amount_minor IS NULL OR bill.needs_review THEN
    RAISE EXCEPTION 'external payment is not a verified successful transaction'
      USING ERRCODE='23514', CONSTRAINT='external_payment_match_success_required';
  END IF;
  IF NEW.collection_fact_id IS NOT NULL THEN
    SELECT * INTO STRICT fact FROM collection_facts WHERE fact_id=NEW.collection_fact_id;
    SELECT property_id INTO target_property FROM orders WHERE id=fact.order_id;
    IF target_property IS DISTINCT FROM bill.property_id OR fact.method <> 'WECOM'
      OR fact.fact_type <> bill.kind OR fact.amount_minor <> bill.amount_minor
      OR fact.currency <> 'CNY' THEN
      RAISE EXCEPTION 'external payment does not match the lodging fact'
        USING ERRCODE='23514', CONSTRAINT='external_payment_match_fact_shape';
    END IF;
    IF bill.kind='COLLECTION' AND fact.transaction_reference IS DISTINCT FROM bill.reference THEN
      RAISE EXCEPTION 'collection reference differs'
        USING ERRCODE='23514', CONSTRAINT='external_payment_match_reference';
    END IF;
    IF bill.kind='REFUND' THEN
      SELECT transaction_reference INTO parent_reference FROM collection_facts WHERE fact_id=fact.references_fact_id;
      IF bill.transaction_id IS NULL OR parent_reference IS DISTINCT FROM bill.transaction_id
        OR (fact.refund_reference IS NOT NULL AND fact.refund_reference <> bill.reference)
        OR (NEW.origin='CONFIRMED' AND fact.refund_reference IS NULL) THEN
        RAISE EXCEPTION 'refund or original collection reference differs'
          USING ERRCODE='23514', CONSTRAINT='external_payment_match_refund_reference';
      END IF;
    END IF;
  ELSE
    SELECT * INTO STRICT member_fact FROM membership_payment_facts WHERE fact_id=NEW.membership_payment_fact_id;
    SELECT property_id INTO target_property FROM membership_orders WHERE id=member_fact.membership_order_id;
    IF target_property IS DISTINCT FROM bill.property_id OR bill.kind <> 'COLLECTION'
      OR member_fact.fact_type <> 'COLLECTION' OR member_fact.amount_minor <> bill.amount_minor
      OR member_fact.currency <> 'CNY' OR member_fact.transaction_reference IS DISTINCT FROM bill.reference
      OR member_fact.source_type <> 'DIRECT_WECOM' THEN
      RAISE EXCEPTION 'external payment does not match the membership fact'
        USING ERRCODE='23514', CONSTRAINT='external_payment_match_membership_shape';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_payment_match_guard BEFORE INSERT ON external_payment_matches
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_external_payment_match();

CREATE FUNCTION qintopia_keep_external_payment_match() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'external payment matches are append-only'
    USING ERRCODE='23514', CONSTRAINT='external_payment_match_immutable';
END;
$$;
CREATE TRIGGER external_payment_match_immutable BEFORE UPDATE OR DELETE ON external_payment_matches
FOR EACH ROW EXECUTE FUNCTION qintopia_keep_external_payment_match();

CREATE FUNCTION qintopia_external_payment_event(bill_key text, event_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE property_key text; next_sequence bigint;
BEGIN
  IF event_kind NOT IN ('DISCOVERED','MATCHED') THEN RAISE EXCEPTION 'invalid payment event'; END IF;
  SELECT property_id INTO STRICT property_key FROM external_payment_bills WHERE id=bill_key;
  INSERT INTO external_payment_event_heads(property_id) VALUES(property_key) ON CONFLICT DO NOTHING;
  -- Allocate a property cursor only while holding the transactional head lock.
  PERFORM 1 FROM external_payment_event_heads WHERE property_id=property_key FOR UPDATE;
  IF EXISTS(SELECT 1 FROM external_payment_events WHERE bill_id=bill_key AND event_type=event_kind) THEN RETURN; END IF;
  UPDATE external_payment_event_heads SET last_sequence=last_sequence+1 WHERE property_id=property_key
    RETURNING last_sequence INTO next_sequence;
  INSERT INTO external_payment_events(property_id,sequence,event_id,bill_id,event_type)
    VALUES(property_key,next_sequence,'payment:'||bill_key||':'||event_kind,bill_key,event_kind);
END;
$$;
CREATE FUNCTION qintopia_external_payment_matched_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.origin='CONFIRMED' THEN PERFORM qintopia_external_payment_event(NEW.bill_id,'MATCHED'); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_payment_matched_event AFTER INSERT ON external_payment_matches
FOR EACH ROW EXECUTE FUNCTION qintopia_external_payment_matched_event();

CREATE FUNCTION qintopia_link_historical_external_payment(bill_key text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bill external_payment_bills%ROWTYPE; candidates jsonb; candidate jsonb; candidate_count integer;
BEGIN
  SELECT * INTO STRICT bill FROM external_payment_bills WHERE id=bill_key FOR UPDATE;
  IF EXISTS(SELECT 1 FROM external_payment_matches WHERE bill_id=bill_key) THEN RETURN 1; END IF;
  IF bill.state <> 'SUCCESS' OR bill.amount_minor IS NULL THEN RETURN 0; END IF;
  IF bill.kind='REFUND' AND EXISTS (
    SELECT 1 FROM collection_facts f JOIN orders o ON o.id=f.order_id
    JOIN collection_facts original ON original.fact_id=f.references_fact_id
    WHERE o.property_id=bill.property_id AND f.fact_type='REFUND' AND f.method='WECOM'
      AND f.amount_minor=bill.amount_minor AND f.refund_reference IS NULL
      AND original.transaction_reference=bill.transaction_id
  ) THEN
    UPDATE external_payment_bills SET needs_review=true WHERE id=bill_key;
    RETURN 2;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(candidate_rows)), '[]'::jsonb) INTO candidates FROM (
    SELECT f.fact_id, 'LODGING' AS target FROM collection_facts f JOIN orders o ON o.id=f.order_id
    LEFT JOIN collection_facts original ON original.fact_id=f.references_fact_id
    WHERE o.property_id=bill.property_id AND f.method='WECOM' AND f.fact_type=bill.kind
      AND f.amount_minor=bill.amount_minor AND f.currency='CNY'
      AND ((bill.kind='COLLECTION' AND f.transaction_reference=bill.reference)
        OR (bill.kind='REFUND' AND original.transaction_reference=bill.transaction_id
          AND (f.refund_reference=bill.reference OR f.refund_reference IS NULL)))
    UNION ALL
    SELECT f.fact_id, 'MEMBERSHIP' FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id
    WHERE bill.kind='COLLECTION' AND o.property_id=bill.property_id AND f.fact_type='COLLECTION'
      AND f.source_type='DIRECT_WECOM' AND f.transaction_reference=bill.reference
      AND f.amount_minor=bill.amount_minor AND f.currency='CNY'
  ) candidate_rows;
  candidate_count := jsonb_array_length(candidates);
  IF candidate_count=1 THEN
    candidate := candidates->0;
    IF EXISTS(SELECT 1 FROM external_payment_matches WHERE collection_fact_id=candidate->>'fact_id'
      OR membership_payment_fact_id=candidate->>'fact_id') THEN
      UPDATE external_payment_bills SET needs_review=true WHERE id=bill_key;
      RETURN 2;
    END IF;
    INSERT INTO external_payment_matches(bill_id,collection_fact_id,membership_payment_fact_id,origin)
      VALUES(bill_key,CASE WHEN candidate->>'target'='LODGING' THEN candidate->>'fact_id' END,
        CASE WHEN candidate->>'target'='MEMBERSHIP' THEN candidate->>'fact_id' END,'HISTORICAL_LINK');
  ELSIF candidate_count>1 THEN
    UPDATE external_payment_bills SET needs_review=true WHERE id=bill_key;
  END IF;
  RETURN candidate_count;
END;
$$;

REVOKE ALL ON external_payment_sources,external_payment_accounts,external_payment_bills,
  external_payment_contacts,external_payment_matches,external_payment_events,external_payment_event_heads FROM PUBLIC;
GRANT SELECT ON external_payment_sources,external_payment_accounts,external_payment_bills,
  external_payment_contacts,external_payment_matches,external_payment_events,external_payment_event_heads TO qintopia_runtime;
GRANT INSERT ON external_payment_matches TO qintopia_runtime;
-- Lock affordance: a trigger prevents mutating bill IDs.
CREATE FUNCTION qintopia_keep_external_payment_bill_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'external payment identity is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_payment_bill_identity BEFORE UPDATE OF id ON external_payment_bills
FOR EACH ROW EXECUTE FUNCTION qintopia_keep_external_payment_bill_id();
GRANT UPDATE (id) ON external_payment_bills TO qintopia_runtime;
GRANT SELECT ON external_payment_sources,external_payment_accounts,external_payment_bills,
  external_payment_contacts,external_payment_matches,external_payment_events TO qintopia_payment_worker;
GRANT INSERT,UPDATE ON external_payment_bills,external_payment_contacts TO qintopia_payment_worker;
GRANT UPDATE (synced_until,baseline_complete,reconciliation_until,last_success_at,last_error_code,last_reconciliation_at)
  ON external_payment_sources TO qintopia_payment_worker;
REVOKE ALL ON FUNCTION qintopia_validate_external_payment_match(),qintopia_keep_external_payment_match(),
  qintopia_keep_external_payment_bill_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_validate_external_payment_match(),qintopia_keep_external_payment_bill_id()
  TO qintopia_runtime,qintopia_payment_worker;
REVOKE ALL ON FUNCTION qintopia_external_payment_event(text,text),qintopia_external_payment_matched_event(),
  qintopia_link_historical_external_payment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_external_payment_event(text,text),qintopia_link_historical_external_payment(text)
  TO qintopia_payment_worker;
