-- Explicit v2 read model. No v1 event or delivery bytes are changed.
CREATE TABLE payment_allocation_heads (
 property_id text PRIMARY KEY REFERENCES properties(id), last_sequence bigint NOT NULL CHECK(last_sequence>0)
);
CREATE TABLE payment_allocation_events (
 event_id text PRIMARY KEY, property_id text NOT NULL REFERENCES properties(id),
 sequence bigint NOT NULL CHECK(sequence>0), bill_id text NOT NULL REFERENCES external_payment_bills(id),
 event_type text NOT NULL CHECK(event_type IN ('DISCOVERED','SOURCE_CHANGED','ALLOCATED','ALLOCATION_RELEASED','RETAINED','RETENTION_CHANGED')),
 source_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(property_id,sequence)
);
CREATE FUNCTION qintopia_allocation_emit(bill_key text,event_kind text,identity_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE property_key text; next_sequence bigint;
BEGIN
 SELECT property_id INTO STRICT property_key FROM external_payment_bills WHERE id=bill_key;
 -- Lock is held through commit: a reader can never advance past an uncommitted event.
 INSERT INTO payment_allocation_heads VALUES(property_key,1)
 ON CONFLICT(property_id) DO UPDATE SET last_sequence=payment_allocation_heads.last_sequence+1
 RETURNING last_sequence INTO next_sequence;
 IF EXISTS(SELECT 1 FROM payment_allocation_events WHERE source_key=identity_key) THEN
  UPDATE payment_allocation_heads SET last_sequence=last_sequence-1 WHERE property_id=property_key;
  RETURN;
 END IF;
 INSERT INTO payment_allocation_events(event_id,property_id,sequence,bill_id,event_type,source_key)
 VALUES('allocation_event_'||property_key||'_'||next_sequence,property_key,next_sequence,bill_key,event_kind,identity_key);
END $$;
CREATE FUNCTION qintopia_allocation_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE bill_key text; event_kind text;
BEGIN
 IF TG_TABLE_NAME='external_payment_bills' THEN
  IF TG_OP='UPDATE' AND (NEW.state,NEW.amount_minor,NEW.needs_review,NEW.transaction_id,NEW.original_trade_no) IS NOT DISTINCT FROM (OLD.state,OLD.amount_minor,OLD.needs_review,OLD.transaction_id,OLD.original_trade_no) THEN RETURN NEW; END IF;
  bill_key:=NEW.id; event_kind:=CASE WHEN TG_OP='INSERT' THEN 'DISCOVERED' ELSE 'SOURCE_CHANGED' END;
 ELSIF TG_TABLE_NAME='external_payment_allocations' THEN bill_key:=NEW.bill_id; event_kind:='ALLOCATED';
 ELSIF TG_TABLE_NAME='external_payment_allocation_releases' THEN
  SELECT bill_id INTO STRICT bill_key FROM external_payment_allocations WHERE id=NEW.allocation_id; event_kind:='ALLOCATION_RELEASED';
 ELSIF TG_TABLE_NAME='retained_funds' THEN bill_key:=NEW.bill_id; event_kind:='RETAINED';
 ELSE SELECT bill_id INTO STRICT bill_key FROM retained_funds WHERE id=NEW.retained_fund_id; event_kind:='RETENTION_CHANGED';
 END IF;
 PERFORM qintopia_allocation_emit(bill_key,event_kind,TG_TABLE_NAME||':'||NEW.id||':'||event_kind||CASE WHEN TG_OP='UPDATE' THEN ':'||txid_current()::text ELSE '' END);
 RETURN NEW;
END $$;
CREATE TRIGGER payment_allocation_discovery AFTER INSERT OR UPDATE ON external_payment_bills FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_capture();
CREATE TRIGGER payment_allocation_capture AFTER INSERT ON external_payment_allocations FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_capture();
CREATE TRIGGER payment_allocation_release_capture AFTER INSERT ON external_payment_allocation_releases FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_capture();
CREATE TRIGGER payment_allocation_retention_capture AFTER INSERT ON retained_funds FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_capture();
CREATE TRIGGER payment_allocation_retention_entry_capture AFTER INSERT ON retained_fund_entries FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_capture();
CREATE TRIGGER payment_allocation_events_immutable BEFORE UPDATE OR DELETE ON payment_allocation_events FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON FUNCTION qintopia_allocation_emit(text,text,text),qintopia_allocation_capture() FROM PUBLIC;
REVOKE ALL ON payment_allocation_heads,payment_allocation_events FROM PUBLIC;
GRANT SELECT ON payment_allocation_heads,payment_allocation_events TO qintopia_runtime;

-- Independent identity preserves the v1 worker's exact privilege allowlist.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qintopia_allocation_delivery_worker') THEN
 CREATE ROLE qintopia_allocation_delivery_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO qintopia_allocation_delivery_worker;
-- Isolated opt-in v2 delivery queue; owner must configure and resume explicitly.
CREATE TABLE allocation_delivery_source (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  source_instance text NOT NULL CHECK(source_instance ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  paused boolean NOT NULL DEFAULT true,
  reason_code text NOT NULL DEFAULT 'NOT_ACTIVATED'
);
CREATE TABLE allocation_delivery_events (
  event_id text PRIMARY KEY REFERENCES payment_allocation_events(event_id),
  property_id text NOT NULL REFERENCES properties(id),
  sequence bigint NOT NULL CHECK(sequence>0),
  body text NOT NULL CHECK(octet_length(body)<=65536),
  UNIQUE(property_id,sequence)
);
CREATE TABLE allocation_deliveries (
  event_id text PRIMARY KEY REFERENCES allocation_delivery_events(event_id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  lease_until timestamptz,
  last_delivery_id text,
  receipt_id text,
  last_error_code text,
  completed_at timestamptz,
  CHECK((state='sending')=(lease_until IS NOT NULL)),
  CHECK((state='accepted')=(receipt_id IS NOT NULL))
);
CREATE INDEX allocation_deliveries_due ON allocation_deliveries(next_attempt_at) WHERE state IN ('pending','sending');
CREATE TABLE allocation_delivery_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text REFERENCES allocation_delivery_events(event_id),
  action text NOT NULL CHECK(action IN ('ATTEMPT','PAUSE','RESUME','REPLAY')),
  result_code text NOT NULL,
  delivery_id text,
  generation bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION qintopia_allocation_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment delivery identity and evidence are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER allocation_delivery_events_immutable BEFORE UPDATE OR DELETE ON allocation_delivery_events
  FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_delivery_immutable();
CREATE TRIGGER allocation_delivery_source_immutable BEFORE UPDATE OF source_instance OR DELETE ON allocation_delivery_source
  FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_delivery_immutable();
CREATE TRIGGER allocation_delivery_audit_immutable BEFORE UPDATE OR DELETE ON allocation_delivery_audit
  FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_delivery_immutable();

-- Materializes only committed facts visible in this publication transaction.
-- No moving checkpoint: crash/restart always finds all unpublished event identities.
CREATE FUNCTION qintopia_allocation_delivery_publish(property_key text, expected_source text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE configured_source text; published integer;
BEGIN
  SELECT source_instance INTO configured_source FROM allocation_delivery_source WHERE singleton FOR SHARE;
  IF configured_source IS NULL OR configured_source<>expected_source THEN RAISE EXCEPTION 'payment delivery source mismatch'; END IF;
  WITH inserted AS (
    INSERT INTO allocation_delivery_events(event_id,property_id,sequence,body)
      SELECT e.event_id,e.property_id,e.sequence,json_build_object(
        'schemaVersion','pms.payments.v2','sourceInstance',configured_source,'propertyId',e.property_id,
        'eventId',e.event_id,'sequence',e.sequence::text,'billId',e.bill_id,'kind',b.kind,
        'eventType',e.event_type,'billVersion',e.sequence::text,'stateReference',json_build_object('path','/api/v2/external-payments','propertyId',e.property_id,'billId',e.bill_id,'kind',b.kind,'status','ALL'),'occurredAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
      FROM payment_allocation_events e JOIN external_payment_bills b ON b.id=e.bill_id
      WHERE e.property_id=property_key AND NOT EXISTS(SELECT 1 FROM allocation_delivery_events p WHERE p.event_id=e.event_id)
      ORDER BY e.sequence LIMIT 100 ON CONFLICT DO NOTHING RETURNING event_id
  ) INSERT INTO allocation_deliveries(event_id) SELECT event_id FROM inserted;
  GET DIAGNOSTICS published=ROW_COUNT;
  RETURN published;
END $$;
-- Maintenance owner only. Replay retains the original immutable event bytes.
CREATE FUNCTION qintopia_allocation_delivery_control(operation text, reason text, event_key text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE event_generation bigint;
BEGIN
  IF reason IS NULL OR reason !~ '^[A-Za-z0-9_.:-]{1,128}$' THEN RAISE EXCEPTION 'reason required'; END IF;
  PERFORM 1 FROM allocation_delivery_source WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment source not configured'; END IF;
  IF operation IN ('PAUSE','RESUME') AND event_key IS NULL THEN
    UPDATE allocation_delivery_source SET paused=(operation='PAUSE'),reason_code=reason WHERE singleton;
  ELSIF operation='REPLAY' AND event_key IS NOT NULL THEN
    UPDATE allocation_deliveries SET state='pending',first_attempt_at=NULL,attempts=0,next_attempt_at=clock_timestamp(),
      completed_at=NULL,last_error_code=NULL,generation=generation+1
      WHERE event_id=event_key AND state='dead_letter' RETURNING generation INTO event_generation;
    IF NOT FOUND THEN RAISE EXCEPTION 'retained dead letter required'; END IF;
  ELSE RAISE EXCEPTION 'invalid payment delivery operation'; END IF;
  INSERT INTO allocation_delivery_audit(event_id,action,result_code,generation) VALUES(event_key,operation,reason,event_generation);
END $$;
REVOKE ALL ON allocation_delivery_source,allocation_delivery_events,allocation_deliveries,allocation_delivery_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_allocation_delivery_immutable(),qintopia_allocation_delivery_publish(text,text),
  qintopia_allocation_delivery_control(text,text,text) FROM PUBLIC;
GRANT SELECT ON allocation_delivery_source,allocation_delivery_events,allocation_deliveries TO qintopia_allocation_delivery_worker;
GRANT UPDATE(paused,reason_code) ON allocation_delivery_source TO qintopia_allocation_delivery_worker;
GRANT UPDATE(state,attempts,generation,next_attempt_at,first_attempt_at,lease_until,last_delivery_id,receipt_id,last_error_code,completed_at)
  ON allocation_deliveries TO qintopia_allocation_delivery_worker;
GRANT INSERT(event_id,action,result_code,delivery_id,generation) ON allocation_delivery_audit TO qintopia_allocation_delivery_worker;
GRANT USAGE ON SEQUENCE allocation_delivery_audit_id_seq TO qintopia_allocation_delivery_worker;
GRANT EXECUTE ON FUNCTION qintopia_allocation_delivery_publish(text,text) TO qintopia_allocation_delivery_worker;
