-- Independent payment transport state; never changes financial facts or pms.events.v1.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qintopia_payment_delivery_worker') THEN
    CREATE ROLE qintopia_payment_delivery_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO qintopia_payment_delivery_worker;
CREATE TABLE payment_delivery_source (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  source_instance text NOT NULL CHECK(source_instance ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  paused boolean NOT NULL DEFAULT true,
  reason_code text NOT NULL DEFAULT 'NOT_ACTIVATED'
);
CREATE TABLE payment_delivery_events (
  event_id text PRIMARY KEY REFERENCES external_payment_events(event_id),
  property_id text NOT NULL REFERENCES properties(id),
  sequence bigint NOT NULL CHECK(sequence>0),
  body text NOT NULL CHECK(octet_length(body)<=65536),
  UNIQUE(property_id,sequence)
);
CREATE TABLE payment_deliveries (
  event_id text PRIMARY KEY REFERENCES payment_delivery_events(event_id),
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
CREATE INDEX payment_deliveries_due ON payment_deliveries(next_attempt_at) WHERE state IN ('pending','sending');
CREATE TABLE payment_delivery_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text REFERENCES payment_delivery_events(event_id),
  action text NOT NULL CHECK(action IN ('ATTEMPT','PAUSE','RESUME','REPLAY')),
  result_code text NOT NULL,
  delivery_id text,
  generation bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION qintopia_payment_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment delivery identity and evidence are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER payment_delivery_events_immutable BEFORE UPDATE OR DELETE ON payment_delivery_events
  FOR EACH ROW EXECUTE FUNCTION qintopia_payment_delivery_immutable();
CREATE TRIGGER payment_delivery_source_immutable BEFORE UPDATE OF source_instance OR DELETE ON payment_delivery_source
  FOR EACH ROW EXECUTE FUNCTION qintopia_payment_delivery_immutable();
CREATE TRIGGER payment_delivery_audit_immutable BEFORE UPDATE OR DELETE ON payment_delivery_audit
  FOR EACH ROW EXECUTE FUNCTION qintopia_payment_delivery_immutable();

-- Materializes only committed facts visible in this publication transaction.
-- No moving checkpoint: crash/restart always finds all unpublished event identities.
CREATE FUNCTION qintopia_payment_delivery_publish(property_key text, expected_source text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_key text; published integer;
BEGIN
  SELECT source_instance INTO source_key FROM payment_delivery_source WHERE singleton FOR SHARE;
  IF source_key IS NULL OR source_key<>expected_source THEN RAISE EXCEPTION 'payment delivery source mismatch'; END IF;
  WITH inserted AS (
    INSERT INTO payment_delivery_events(event_id,property_id,sequence,body)
      SELECT e.event_id,e.property_id,e.sequence,json_build_object(
        'schemaVersion','pms.payments.v1','sourceInstance',source_key,'propertyId',e.property_id,
        'eventId',e.event_id,'sequence',e.sequence::text,'billId',e.bill_id,'kind',b.kind,
        'eventType',e.event_type,'occurredAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
      FROM external_payment_events e JOIN external_payment_bills b ON b.id=e.bill_id
      WHERE e.property_id=property_key AND NOT EXISTS(SELECT 1 FROM payment_delivery_events p WHERE p.event_id=e.event_id)
      ORDER BY e.sequence LIMIT 100 ON CONFLICT DO NOTHING RETURNING event_id
  ) INSERT INTO payment_deliveries(event_id) SELECT event_id FROM inserted;
  GET DIAGNOSTICS published=ROW_COUNT;
  RETURN published;
END $$;
-- Maintenance owner only. Replay retains the original immutable event bytes.
CREATE FUNCTION qintopia_payment_delivery_control(operation text, reason text, event_key text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE event_generation bigint;
BEGIN
  IF reason IS NULL OR reason !~ '^[A-Za-z0-9_.:-]{1,128}$' THEN RAISE EXCEPTION 'reason required'; END IF;
  PERFORM 1 FROM payment_delivery_source WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment source not configured'; END IF;
  IF operation IN ('PAUSE','RESUME') AND event_key IS NULL THEN
    UPDATE payment_delivery_source SET paused=(operation='PAUSE'),reason_code=reason WHERE singleton;
  ELSIF operation='REPLAY' AND event_key IS NOT NULL THEN
    UPDATE payment_deliveries SET state='pending',first_attempt_at=NULL,attempts=0,next_attempt_at=clock_timestamp(),
      completed_at=NULL,last_error_code=NULL,generation=generation+1
      WHERE event_id=event_key AND state='dead_letter' RETURNING generation INTO event_generation;
    IF NOT FOUND THEN RAISE EXCEPTION 'retained dead letter required'; END IF;
  ELSE RAISE EXCEPTION 'invalid payment delivery operation'; END IF;
  INSERT INTO payment_delivery_audit(event_id,action,result_code,generation) VALUES(event_key,operation,reason,event_generation);
END $$;
REVOKE ALL ON payment_delivery_source,payment_delivery_events,payment_deliveries,payment_delivery_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_payment_delivery_immutable(),qintopia_payment_delivery_publish(text,text),
  qintopia_payment_delivery_control(text,text,text) FROM PUBLIC;
GRANT SELECT ON payment_delivery_source,payment_delivery_events,payment_deliveries TO qintopia_payment_delivery_worker;
GRANT UPDATE(paused,reason_code) ON payment_delivery_source TO qintopia_payment_delivery_worker;
GRANT UPDATE(state,attempts,generation,next_attempt_at,first_attempt_at,lease_until,last_delivery_id,receipt_id,last_error_code,completed_at)
  ON payment_deliveries TO qintopia_payment_delivery_worker;
GRANT INSERT(event_id,action,result_code,delivery_id,generation) ON payment_delivery_audit TO qintopia_payment_delivery_worker;
GRANT USAGE ON SEQUENCE payment_delivery_audit_id_seq TO qintopia_payment_delivery_worker;
GRANT EXECUTE ON FUNCTION qintopia_payment_delivery_publish(text,text) TO qintopia_payment_delivery_worker;
