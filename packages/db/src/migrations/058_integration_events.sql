-- Additive event capture. No source is configured and no outbound I/O is enabled by migration.
CREATE TABLE integration_source (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_instance text NOT NULL CHECK (source_instance ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  capture_mode text NOT NULL CHECK (capture_mode IN ('baseline','live')),
  epoch text NOT NULL DEFAULT gen_random_uuid()::text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE integration_maintenance_refs (
  fact_ref text PRIMARY KEY,
  transaction_id xid8 NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE integration_entity_revisions (
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('member','inventory_unit')),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 256),
  revision bigint NOT NULL CHECK (revision > 0),
  last_fact_ref text NOT NULL,
  invalidated boolean NOT NULL,
  invalidated_recorded_at timestamptz,
  PRIMARY KEY (aggregate_type, aggregate_id)
);
CREATE TABLE integration_outbox (
  event_id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_instance text NOT NULL,
  property_id text NOT NULL REFERENCES properties(id),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('order','member','inventory_unit')),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 256),
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'pms.order.created','pms.order.context_changed','pms.stay.checked_in',
    'pms.stay.arrangement_changed','pms.stay.checked_out','pms.stay.cancelled',
    'pms.stay.no_show','pms.stay.check_in_revoked','pms.stay.check_out_revoked',
    'pms.order.occupants_changed','pms.member.context_changed',
    'pms.inventory_unit.context_changed','pms.entity.invalidated')),
  source_fact_ref text NOT NULL CHECK (length(source_fact_ref) BETWEEN 1 AND 256 AND source_fact_ref ~ '^(command|amendment|correction|account_management_operation|migration|baseline):.+$'),
  recorded_at timestamptz NOT NULL,
  origin text NOT NULL CHECK (origin IN ('baseline','live','historical_correction')),
  refs jsonb NOT NULL,
  capture_epoch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publish_seq bigint CHECK (publish_seq > 0),
  UNIQUE(property_id,publish_seq),
  UNIQUE(event_id,property_id,publish_seq),
  UNIQUE (source_instance,property_id,aggregate_type,aggregate_id,aggregate_revision,event_type,source_fact_ref),
  UNIQUE (source_instance,property_id,aggregate_type,aggregate_id,event_type,source_fact_ref),
  CHECK (jsonb_typeof(refs) = 'object' AND refs - ARRAY['order_id','stay_id','member_id','inventory_unit_id','occupant_id']::text[] = '{}'::jsonb)
);
CREATE TABLE integration_publish_state (
  property_id text PRIMARY KEY REFERENCES properties(id),
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  floor bigint NOT NULL DEFAULT 0 CHECK (floor >= 0 AND floor <= head),
  cursor_epoch text NOT NULL DEFAULT gen_random_uuid()::text
);
CREATE TABLE integration_published_events (
  event_id text PRIMARY KEY REFERENCES integration_outbox(event_id),
  property_id text NOT NULL REFERENCES properties(id),
  publish_seq bigint NOT NULL CHECK (publish_seq > 0),
  body text NOT NULL CHECK (octet_length(body) <= 65536),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (property_id,publish_seq),
  FOREIGN KEY(event_id,property_id,publish_seq) REFERENCES integration_outbox(event_id,property_id,publish_seq),
  CHECK (encode(sha256(convert_to(body,'UTF8')),'hex') = body_hash)
);
CREATE TABLE integration_deliveries (
  event_id text PRIMARY KEY REFERENCES integration_published_events(event_id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  generation bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_attempt_at timestamptz,
  last_delivery_id text,
  last_error_code text,
  receipt_id text,
  completed_at timestamptz
);
CREATE TABLE integration_subscription_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused boolean NOT NULL DEFAULT true,
  reason_code text NOT NULL DEFAULT 'NOT_ACTIVATED'
);
INSERT INTO integration_subscription_state(singleton) VALUES(true);
CREATE TABLE integration_delivery_audit (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_id text REFERENCES integration_outbox(event_id),
  action text NOT NULL,
  result_code text NOT NULL,
  delivery_id text,
  generation bigint,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX integration_outbox_pending ON integration_outbox(property_id,created_at,event_id) WHERE publish_seq IS NULL;
CREATE INDEX integration_deliveries_pending ON integration_deliveries(next_attempt_at,event_id) WHERE state IN ('pending','sending');
CREATE INDEX integration_orders_scan ON orders(property_id,id);
CREATE INDEX integration_orders_member ON orders(property_id,member_id,id) WHERE member_id IS NOT NULL;

-- This shared latch is acquired even before initial configuration. Switching mode
-- succeeds only after relevant writers drain; busy control calls do not queue.
CREATE FUNCTION qintopia_integration_write_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('qintopia:integration-capture',0));
  RETURN NULL;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['orders','stays','stay_segments','order_occupants','order_occupant_corrections','order_occupant_removals','amendments','members','member_property_links','member_external_references','inventory_units','account_management_operations'] LOOP
    EXECUTE format('CREATE TRIGGER integration_write_fence BEFORE INSERT OR UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION qintopia_integration_write_fence()',relation);
  END LOOP;
END $$;

CREATE FUNCTION qintopia_integration_emit(target_property text, entity_kind text, entity_id text, revision_no bigint,
  event_name text, fact_ref text, fact_time timestamptz, fact_origin text, references_json jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE config integration_source%ROWTYPE; prior integration_outbox%ROWTYPE; effective_origin text;
BEGIN
  SELECT * INTO config FROM integration_source WHERE singleton;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(references_json) item WHERE jsonb_typeof(item.value)<>'string' OR length(item.value#>>'{}') NOT BETWEEN 1 AND 256) THEN
    RAISE EXCEPTION 'INTEGRATION_REFERENCE_INVALID';
  END IF;
  effective_origin := CASE WHEN config.capture_mode='baseline' THEN 'baseline' ELSE fact_origin END;
  SELECT * INTO prior FROM integration_outbox WHERE source_instance=config.source_instance AND property_id=target_property
    AND aggregate_type=entity_kind AND aggregate_id=entity_id AND event_type=event_name AND source_fact_ref=fact_ref;
  IF FOUND THEN
    IF prior.aggregate_revision<>revision_no OR prior.refs IS DISTINCT FROM references_json OR prior.origin<>effective_origin OR prior.recorded_at IS DISTINCT FROM fact_time THEN
      RAISE EXCEPTION 'INTEGRATION_FACT_CONFLICT';
    END IF;
    RETURN;
  END IF;
  INSERT INTO integration_outbox(source_instance,property_id,aggregate_type,aggregate_id,aggregate_revision,event_type,
    source_fact_ref,recorded_at,origin,refs,capture_epoch)
  VALUES(config.source_instance,target_property,entity_kind,entity_id,revision_no,event_name,fact_ref,fact_time,effective_origin,references_json,config.epoch);
END $$;

CREATE FUNCTION qintopia_integration_context(entity_kind text, entity_id text, fact_ref text, fact_time timestamptz, fact_origin text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE version_row integration_entity_revisions%ROWTYPE; gone boolean; invalid_time timestamptz; target_property text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM integration_source) THEN RETURN; END IF;
  IF entity_kind='member' THEN
    SELECT deleted_at IS NOT NULL,deleted_at INTO gone,invalid_time FROM members WHERE id=entity_id;
  ELSIF entity_kind='inventory_unit' THEN
    SELECT NOT active,NULL::timestamptz INTO gone,invalid_time FROM inventory_units WHERE id=entity_id;
  ELSE RAISE EXCEPTION 'INTEGRATION_ENTITY_TYPE'; END IF;
  IF gone IS NULL THEN RAISE EXCEPTION 'INTEGRATION_ENTITY_MISSING'; END IF;
  INSERT INTO integration_entity_revisions(aggregate_type,aggregate_id,revision,last_fact_ref,invalidated,invalidated_recorded_at)
    VALUES(entity_kind,entity_id,1,fact_ref,gone,invalid_time)
    ON CONFLICT(aggregate_type,aggregate_id) DO UPDATE SET
      revision=CASE WHEN integration_entity_revisions.last_fact_ref=excluded.last_fact_ref THEN integration_entity_revisions.revision ELSE integration_entity_revisions.revision+1 END,
      last_fact_ref=excluded.last_fact_ref,invalidated=excluded.invalidated,invalidated_recorded_at=excluded.invalidated_recorded_at
    RETURNING * INTO version_row;
  FOR target_property IN
    SELECT property_id FROM member_property_links WHERE entity_kind='member' AND member_id=entity_id
    UNION SELECT property_id FROM inventory_units WHERE entity_kind='inventory_unit' AND id=entity_id ORDER BY 1
  LOOP
    PERFORM qintopia_integration_emit(target_property,entity_kind,entity_id,version_row.revision,
      CASE WHEN gone THEN 'pms.entity.invalidated' WHEN entity_kind='member' THEN 'pms.member.context_changed' ELSE 'pms.inventory_unit.context_changed' END,
      fact_ref,fact_time,fact_origin,jsonb_build_object(CASE WHEN entity_kind='member' THEN 'member_id' ELSE 'inventory_unit_id' END,entity_id));
  END LOOP;
END $$;

-- Called at commit, after the final business graph and Receipt have been written.
CREATE FUNCTION qintopia_integration_capture_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE booking orders%ROWTYPE; stay_id text; command_type text; event_name text; fact_origin text; refs jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM integration_source) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT booking FROM orders WHERE id=NEW.order_id;
  SELECT id INTO STRICT stay_id FROM stays WHERE order_id=booking.id;
  IF NEW.command_id IS NOT NULL THEN
    SELECT c.command_type INTO command_type FROM command_executions c
      LEFT JOIN command_receipts r ON r.command_id=c.id
      WHERE c.id=NEW.command_id AND c.state='APPLIED' AND (r.business_committed OR (
        (SELECT capture_mode FROM integration_source)='baseline'
        AND session_user=(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())
      ));
    IF command_type IS NULL THEN RAISE EXCEPTION 'INTEGRATION_COMMAND_NOT_COMMITTED'; END IF;
  END IF;
  event_name := CASE NEW.amendment_type
    WHEN 'CREATE_ORDER' THEN 'pms.order.created' WHEN 'CHECK_IN' THEN 'pms.stay.checked_in'
    WHEN 'CHECK_OUT' THEN 'pms.stay.checked_out' WHEN 'CANCEL_ORDER' THEN 'pms.stay.cancelled'
    WHEN 'MARK_NO_SHOW' THEN 'pms.stay.no_show' WHEN 'REVOKE_CHECK_IN' THEN 'pms.stay.check_in_revoked'
    WHEN 'REVOKE_CHECK_OUT' THEN 'pms.stay.check_out_revoked'
    WHEN 'CORRECT_ORDER_OCCUPANT' THEN 'pms.order.occupants_changed' WHEN 'MANAGE_ORDER_OCCUPANTS' THEN 'pms.order.occupants_changed'
    WHEN 'RESCHEDULE_STAY' THEN 'pms.stay.arrangement_changed' WHEN 'EXTEND_STAY' THEN 'pms.stay.arrangement_changed'
    WHEN 'SHORTEN_STAY' THEN 'pms.stay.arrangement_changed' WHEN 'MOVE_UNIT' THEN 'pms.stay.arrangement_changed'
    WHEN 'CORRECT_HISTORICAL_STAY_ARRANGEMENT' THEN 'pms.stay.arrangement_changed'
    WHEN 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN 'pms.order.context_changed'
    WHEN 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY' THEN 'pms.order.context_changed'
    WHEN 'REPRICE_ORDER' THEN 'pms.order.context_changed' WHEN 'REFRESH_MEMBER_COVERAGE' THEN 'pms.order.context_changed'
    ELSE NULL END;
  IF event_name IS NULL THEN RAISE EXCEPTION 'INTEGRATION_UNMAPPED_AMENDMENT'; END IF;
  fact_origin := CASE
    WHEN NEW.command_id IS NULL THEN 'baseline'
    WHEN NEW.reason_code='BACKFILL_STAY' OR command_type IN ('COMPLETE_STAY','BACKFILL_COMPLETED_STAY','CORRECT_HISTORICAL_STAY_ARRANGEMENTS','VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY')
      OR NEW.amendment_type IN ('CORRECT_ORDER_OCCUPANT','REVOKE_CHECK_IN','REVOKE_CHECK_OUT')
      OR NEW.payload->>'recordingMode'='LATE_RECORDED'
      OR (NEW.amendment_type='MANAGE_ORDER_OCCUPANTS' AND NEW.payload->>'action'='REMOVE')
      OR (NEW.amendment_type='CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' AND booking.status='CHECKED_OUT')
    THEN 'historical_correction' ELSE 'live' END;
  refs := jsonb_build_object('order_id',booking.id,'stay_id',stay_id);
  IF booking.member_id IS NOT NULL THEN refs := refs || jsonb_build_object('member_id',booking.member_id); END IF;
  PERFORM qintopia_integration_emit(booking.property_id,'order',booking.id,booking.version,event_name,
    'amendment:'||NEW.id,NEW.created_at,fact_origin,refs);
  IF NEW.amendment_type='REVOKE_CHECK_OUT' THEN
    PERFORM qintopia_integration_emit(booking.property_id,'order',booking.id,booking.version,'pms.stay.arrangement_changed',
      'amendment:'||NEW.id,NEW.created_at,fact_origin,refs);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER integration_order_capture AFTER INSERT ON amendments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_integration_capture_order();

CREATE FUNCTION qintopia_integration_capture_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE entity_id text; entity_kind text; ref text; fact_time timestamptz; fact_origin text := 'historical_correction'; command_id text; command_kind text; deletion_id text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM integration_source) THEN RETURN NULL; END IF;
  entity_kind := CASE WHEN TG_TABLE_NAME='inventory_units' THEN 'inventory_unit' ELSE 'member' END;
  IF TG_TABLE_NAME IN ('members','inventory_units') THEN entity_id := NEW.id; ELSE entity_id := NEW.member_id; END IF;
  IF TG_OP='UPDATE' THEN
    IF entity_kind='inventory_unit' AND (to_jsonb(NEW)-'name'-'code') IS NOT DISTINCT FROM (to_jsonb(OLD)-'name'-'code') THEN RETURN NULL; END IF;
    IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL; END IF;
  END IF;
  SELECT operation_id,created_at INTO deletion_id,fact_time FROM member_deletions
    WHERE entity_kind='member' AND member_id=entity_id AND xmin=(pg_current_xact_id()::text)::xid;
  IF deletion_id IS NOT NULL THEN ref := 'account_management_operation:'||deletion_id;
  ELSE
    SELECT c.id,c.completed_at,c.command_type INTO command_id,fact_time,command_kind FROM command_executions c
      JOIN command_receipts r ON r.command_id=c.id
      WHERE c.xmin=(pg_current_xact_id()::text)::xid AND c.state='APPLIED' AND r.business_committed
        AND c.command_type NOT IN ('CREATE_QUOTE');
    IF (SELECT count(*) FROM command_executions c JOIN command_receipts r ON r.command_id=c.id
      WHERE c.xmin=(pg_current_xact_id()::text)::xid AND c.state='APPLIED' AND r.business_committed)>1 THEN
      RAISE EXCEPTION 'INTEGRATION_AMBIGUOUS_AUTHORITY';
    END IF;
    IF command_id IS NOT NULL THEN
      ref := 'command:'||command_id;
      IF command_kind IN ('CREATE_MEMBER','ACTIVATE_MEMBERSHIP_ORDER','CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP') THEN fact_origin := 'live'; END IF;
    ELSE
      IF session_user='qintopia_runtime' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolname='qintopia_integration_worker') THEN
        RAISE EXCEPTION 'INTEGRATION_AUTHORITY_REQUIRED';
      END IF;
      ref := current_setting('qintopia.integration_maintenance_ref',true);
      IF ref IS NULL OR ref='' THEN
        IF (SELECT capture_mode FROM integration_source)='live' THEN RAISE EXCEPTION 'INTEGRATION_MAINTENANCE_REFERENCE_REQUIRED'; END IF;
        ref := 'baseline:'||(SELECT epoch FROM integration_source)||':'||pg_current_xact_id()::text;
      END IF;
      IF ref !~ '^(baseline|migration):[A-Za-z0-9_.:-]{1,180}$' THEN RAISE EXCEPTION 'INTEGRATION_MAINTENANCE_REFERENCE_INVALID'; END IF;
      INSERT INTO integration_maintenance_refs(fact_ref,transaction_id) VALUES(ref,pg_current_xact_id()) ON CONFLICT DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM integration_maintenance_refs WHERE fact_ref=ref AND transaction_id=pg_current_xact_id()) THEN
        RAISE EXCEPTION 'INTEGRATION_MAINTENANCE_REFERENCE_REUSED';
      END IF;
      SELECT recorded_at INTO fact_time FROM integration_maintenance_refs WHERE fact_ref=ref;
      IF ref LIKE 'baseline:%' THEN fact_origin := 'baseline'; END IF;
    END IF;
  END IF;
  PERFORM qintopia_integration_context(entity_kind,entity_id,ref,coalesce(fact_time,clock_timestamp()),fact_origin);
  RETURN NULL;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['members','member_property_links','member_external_references','inventory_units'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER integration_context_capture AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_integration_capture_context()',relation);
  END LOOP;
END $$;

-- Owner-only control. A source alias cannot be silently changed after publication.
CREATE FUNCTION qintopia_integration_configure(source_name text, mode text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE row record; baseline_ref text;
BEGIN
  IF source_name IS NULL OR source_name !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' THEN RAISE EXCEPTION 'INTEGRATION_SOURCE_INVALID'; END IF;
  IF mode IS NULL OR mode NOT IN ('baseline','live') THEN RAISE EXCEPTION 'INTEGRATION_MODE_INVALID'; END IF;
  -- Never queue an exclusive lock behind a writer that may hold business row
  -- locks: later shared-lock requests must remain free to drain. Busy leaves the
  -- mode unchanged; the owner retries after the old writers finish.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('qintopia:integration-capture',0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='INTEGRATION_CAPTURE_BUSY';
  END IF;
  IF EXISTS(SELECT 1 FROM integration_source WHERE source_instance<>source_name) THEN RAISE EXCEPTION 'INTEGRATION_SOURCE_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_source) THEN
    INSERT INTO integration_source(singleton,source_instance,capture_mode) VALUES(true,source_name,'baseline');
    baseline_ref := 'baseline:'||(SELECT epoch FROM integration_source);
    FOR row IN SELECT id FROM members ORDER BY id LOOP
      PERFORM qintopia_integration_context('member',row.id,baseline_ref,clock_timestamp(),'baseline');
    END LOOP;
    FOR row IN SELECT id FROM inventory_units ORDER BY id LOOP
      PERFORM qintopia_integration_context('inventory_unit',row.id,baseline_ref,clock_timestamp(),'baseline');
    END LOOP;
  END IF;
  INSERT INTO integration_publish_state(property_id) SELECT id FROM properties ON CONFLICT DO NOTHING;
  UPDATE integration_source SET capture_mode=mode,epoch=gen_random_uuid()::text WHERE singleton;
  INSERT INTO integration_control_audit(actor_role,action,config_version,reason_code)
    SELECT session_user,'CAPTURE_'||upper(mode),epoch,'OWNER_CONFIGURE' FROM integration_source;
END $$;

CREATE FUNCTION qintopia_integration_publish(target_property text, batch_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE published_count integer := 0; head_seq bigint; fact integration_outbox%ROWTYPE; raw_body text;
BEGIN
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INTEGRATION_BATCH_LIMIT'; END IF;
  IF NOT EXISTS(SELECT 1 FROM integration_source) THEN RETURN 0; END IF;
  INSERT INTO integration_publish_state(property_id) VALUES(target_property) ON CONFLICT DO NOTHING;
  SELECT head INTO head_seq FROM integration_publish_state WHERE property_id=target_property FOR UPDATE;
  FOR fact IN SELECT o.* FROM integration_outbox o WHERE o.property_id=target_property
    AND o.publish_seq IS NULL
    ORDER BY o.created_at,o.event_id LIMIT batch_limit
  LOOP
    head_seq := head_seq+1;
    raw_body := jsonb_build_object('schema_version','pms.events.v1','event_id',fact.event_id,
      'source_instance',fact.source_instance,'property_id',fact.property_id,'event_type',fact.event_type,
      'aggregate_type',fact.aggregate_type,'aggregate_id',fact.aggregate_id,'aggregate_revision',fact.aggregate_revision::text,
      'recorded_at',to_char(fact.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'effective_at',NULL,'source_fact_ref',fact.source_fact_ref,'publish_seq',head_seq::text,'refs',fact.refs,'origin',fact.origin)::text;
    UPDATE integration_outbox SET publish_seq=head_seq WHERE event_id=fact.event_id;
    INSERT INTO integration_published_events(event_id,property_id,publish_seq,body,body_hash)
      VALUES(fact.event_id,target_property,head_seq,raw_body,encode(sha256(convert_to(raw_body,'UTF8')),'hex'));
    INSERT INTO integration_deliveries(event_id) VALUES(fact.event_id);
    published_count := published_count+1;
  END LOOP;
  UPDATE integration_publish_state SET head=head_seq WHERE property_id=target_property;
  RETURN published_count;
END $$;

-- Publication metadata may be appended exactly once; source facts never change.
CREATE FUNCTION qintopia_integration_outbox_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.publish_seq IS NULL AND NEW.publish_seq IS NOT NULL
    AND (to_jsonb(OLD)-'publish_seq')=(to_jsonb(NEW)-'publish_seq') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'INTEGRATION_OUTBOX_IMMUTABLE';
END $$;
CREATE TRIGGER integration_outbox_immutable BEFORE UPDATE OR DELETE ON integration_outbox FOR EACH ROW EXECUTE FUNCTION qintopia_integration_outbox_immutable();
CREATE TRIGGER integration_published_immutable BEFORE UPDATE ON integration_published_events FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER integration_delivery_audit_immutable BEFORE UPDATE OR DELETE ON integration_delivery_audit FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qintopia_integration_worker') THEN CREATE ROLE qintopia_integration_worker NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO qintopia_integration_worker;
REVOKE ALL ON integration_maintenance_refs,integration_source,integration_entity_revisions,integration_outbox,integration_publish_state,
  integration_published_events,integration_deliveries,integration_subscription_state,integration_delivery_audit FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;
GRANT SELECT ON integration_source,integration_entity_revisions,integration_publish_state,integration_published_events TO qintopia_runtime;
GRANT SELECT ON integration_source,integration_publish_state,integration_published_events,integration_deliveries,integration_subscription_state TO qintopia_integration_worker;
GRANT UPDATE ON integration_deliveries,integration_subscription_state TO qintopia_integration_worker;
GRANT INSERT ON integration_delivery_audit TO qintopia_integration_worker;
REVOKE ALL ON FUNCTION qintopia_integration_emit(text,text,text,bigint,text,text,timestamptz,text,jsonb),
  qintopia_integration_context(text,text,text,timestamptz,text),qintopia_integration_capture_order(),
  qintopia_integration_capture_context(),qintopia_integration_configure(text,text),qintopia_integration_publish(text,integer)
  FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;
GRANT EXECUTE ON FUNCTION qintopia_integration_publish(text,integer) TO qintopia_integration_worker;

-- Cleanup consumes only a contiguous, acknowledged prefix. Permanent publication
-- markers and source facts survive, so pruning payloads never makes them unpublished.
CREATE FUNCTION qintopia_integration_prune(target_property text, retain_days integer DEFAULT 30) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE state integration_publish_state%ROWTYPE; through_seq bigint;
BEGIN
  IF retain_days IS NULL OR retain_days<30 OR retain_days>3650 THEN RAISE EXCEPTION 'INTEGRATION_RETENTION_INVALID'; END IF;
  SELECT * INTO STRICT state FROM integration_publish_state WHERE property_id=target_property FOR UPDATE;
  SELECT coalesce(min(e.publish_seq)-1,state.head) INTO through_seq FROM integration_published_events e
    JOIN integration_deliveries d ON d.event_id=e.event_id
    WHERE e.property_id=target_property AND (d.state<>'accepted' OR e.published_at>clock_timestamp()-make_interval(days=>retain_days));
  DELETE FROM integration_deliveries d USING integration_published_events e
    WHERE d.event_id=e.event_id AND e.property_id=target_property AND e.publish_seq<=through_seq;
  DELETE FROM integration_published_events WHERE property_id=target_property AND publish_seq<=through_seq;
  UPDATE integration_publish_state SET floor=greatest(floor,through_seq) WHERE property_id=target_property;
  RETURN greatest(state.floor,through_seq);
END $$;
REVOKE ALL ON FUNCTION qintopia_integration_prune(text,integer) FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;
GRANT EXECUTE ON FUNCTION qintopia_integration_prune(text,integer) TO qintopia_integration_worker;

CREATE TABLE integration_control_audit (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  actor_role text NOT NULL,
  action text NOT NULL,
  config_version text NOT NULL,
  reason_code text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER integration_control_audit_immutable BEFORE UPDATE OR DELETE ON integration_control_audit FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON integration_control_audit FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;

CREATE FUNCTION qintopia_integration_control(action_name text, config_version text, reason_code text, target_event text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF config_version IS NULL OR reason_code IS NULL OR config_version !~ '^[A-Za-z0-9_.:-]{1,128}$' OR reason_code !~ '^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'INTEGRATION_CONTROL_INVALID'; END IF;
  IF action_name='PAUSE' THEN
    UPDATE integration_subscription_state SET paused=true,reason_code=qintopia_integration_control.reason_code;
  ELSIF action_name='RESUME' THEN
    IF NOT EXISTS(SELECT 1 FROM integration_source) THEN RAISE EXCEPTION 'INTEGRATION_NOT_CONFIGURED'; END IF;
    UPDATE integration_subscription_state SET paused=false,reason_code=qintopia_integration_control.reason_code;
  ELSIF action_name='REPLAY' THEN
    UPDATE integration_deliveries SET state='pending',generation=generation+1,lease_until=NULL,next_attempt_at=clock_timestamp(),
      first_attempt_at=NULL,completed_at=NULL,last_error_code=NULL WHERE event_id=target_event;
    IF NOT FOUND THEN RAISE EXCEPTION 'INTEGRATION_EVENT_NOT_RETAINED'; END IF;
    INSERT INTO integration_delivery_audit(event_id,action,result_code) VALUES(target_event,'REPLAY',qintopia_integration_control.reason_code);
  ELSE RAISE EXCEPTION 'INTEGRATION_CONTROL_INVALID'; END IF;
  INSERT INTO integration_control_audit(actor_role,action,config_version,reason_code)
    VALUES(session_user,action_name,qintopia_integration_control.config_version,qintopia_integration_control.reason_code);
END $$;
REVOKE ALL ON FUNCTION qintopia_integration_control(text,text,text,text) FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;

CREATE TRIGGER integration_maintenance_refs_immutable BEFORE UPDATE OR DELETE ON integration_maintenance_refs FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON FUNCTION qintopia_integration_write_fence() FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;

REVOKE ALL ON FUNCTION qintopia_integration_outbox_immutable() FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;

CREATE FUNCTION qintopia_integration_status(target_property text)
RETURNS TABLE(unpublished bigint,oldest_unpublished_at timestamptz,pending bigint,sending bigint,dead_letters bigint,paused boolean,head text,floor text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT (SELECT count(*) FROM integration_outbox WHERE property_id=target_property AND publish_seq IS NULL),
    (SELECT min(created_at) FROM integration_outbox WHERE property_id=target_property AND publish_seq IS NULL),
    count(*) FILTER(WHERE d.state='pending'),count(*) FILTER(WHERE d.state='sending'),count(*) FILTER(WHERE d.state='dead_letter'),
    (SELECT paused FROM integration_subscription_state),s.head::text,s.floor::text
  FROM integration_publish_state s LEFT JOIN integration_published_events e ON e.property_id=s.property_id
    LEFT JOIN integration_deliveries d ON d.event_id=e.event_id WHERE s.property_id=target_property GROUP BY s.head,s.floor
$$;
REVOKE ALL ON FUNCTION qintopia_integration_status(text) FROM PUBLIC,qintopia_runtime,qintopia_integration_worker;
GRANT EXECUTE ON FUNCTION qintopia_integration_status(text) TO qintopia_integration_worker;
