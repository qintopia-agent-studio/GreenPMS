-- 渠道成交、退款及纠错事实；不伪造住宿收款，不更改库存。
CREATE TABLE channel_operating_facts (
 id text PRIMARY KEY,
 property_id text NOT NULL REFERENCES properties(id),
 order_id text NOT NULL REFERENCES orders(id),
 kind text NOT NULL CHECK(kind IN ('SALE','CORRECTION','REFUND','REVERSAL')),
 amount_minor integer NOT NULL CHECK(amount_minor<>0),
 contract_effect_minor integer NOT NULL DEFAULT 0,
 currency text NOT NULL,
 business_date date NOT NULL,
 pricing_revision_id text REFERENCES pricing_revisions(id),
 references_fact_id text REFERENCES channel_operating_facts(id),
 refund_reference text,
 command_id text REFERENCES command_executions(id),
 note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='SALE' AND amount_minor>0) OR kind='CORRECTION' OR (kind='REFUND' AND amount_minor<0) OR (kind='REVERSAL' AND amount_minor>0)),
 CHECK(kind NOT IN ('REFUND','REVERSAL') OR (command_id IS NOT NULL AND references_fact_id IS NOT NULL)),
 CHECK(kind<>'REFUND' OR nullif(btrim(refund_reference),'') IS NOT NULL),
 CHECK((kind IN ('SALE','CORRECTION') AND contract_effect_minor=0) OR (kind='REFUND' AND contract_effect_minor<=0) OR (kind='REVERSAL' AND contract_effect_minor>=0))
);
CREATE INDEX channel_operating_order_idx ON channel_operating_facts(order_id,created_at,id);
CREATE INDEX channel_operating_date_idx ON channel_operating_facts(property_id,business_date);
CREATE UNIQUE INDEX channel_operating_command_kind ON channel_operating_facts(command_id,kind) WHERE command_id IS NOT NULL;
CREATE UNIQUE INDEX channel_operating_revision ON channel_operating_facts(pricing_revision_id) WHERE pricing_revision_id IS NOT NULL;
CREATE UNIQUE INDEX channel_operating_reversal ON channel_operating_facts(references_fact_id) WHERE kind='REVERSAL';

-- 期初已计收入与封账基准由受控初始化入口配置，普通运行身份只读。
CREATE TABLE operating_sales_opening (
 property_id text NOT NULL REFERENCES properties(id),
 source_kind text NOT NULL CHECK(source_kind IN ('PAYMENT_BILL','STAY_FACT','MEMBER_FACT','CHANNEL_REFUND')),
 source_id text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 currency text NOT NULL,
 evidence_note text NOT NULL CHECK(btrim(evidence_note)<>''),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(property_id,source_kind,source_id)
);
CREATE TABLE operating_sales_baselines (
 property_id text NOT NULL REFERENCES properties(id),
 month date NOT NULL CHECK(extract(day from month)=1),
 amount_minor bigint NOT NULL,
 currency text NOT NULL,
 recognition_from date NOT NULL,
 evidence_note text NOT NULL CHECK(btrim(evidence_note)<>''),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(property_id,month,currency)
);

-- 仅保存当前有效退款号的占用；历史事实始终追加，误录撤销后才释放退款号。
CREATE TABLE channel_refund_claims (
 property_id text NOT NULL REFERENCES properties(id),
 channel_code text NOT NULL CHECK(channel_code IN ('YOUMUDAO','CTRIP','MEITUAN')),
 refund_reference text NOT NULL CHECK(btrim(refund_reference)<>''),
 fact_id text NOT NULL UNIQUE REFERENCES channel_operating_facts(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(property_id,channel_code,refund_reference)
);

-- 将既有渠道计价证据转为可追溯成交事实，不将取消清零当退款。
DO $$
DECLARE r record; net bigint; delta bigint; prior integer; first_day date;
BEGIN
 FOR r IN SELECT p.*,o.property_id,o.booking_channel_code,a.amendment_type,a.command_id,prop.timezone
   FROM pricing_revisions p JOIN orders o ON o.id=p.order_id JOIN amendments a ON a.id=p.amendment_id
   JOIN properties prop ON prop.id=o.property_id
   WHERE o.booking_channel_code IN ('YOUMUDAO','CTRIP','MEITUAN') AND o.stay_type<>'FREE'
     AND o.member_id IS NULL AND o.member_contract_id IS NULL
   ORDER BY o.id,p.revision_no
 LOOP
   SELECT COALESCE(sum(amount_minor),0),min(business_date) INTO net,first_day FROM channel_operating_facts WHERE order_id=r.order_id;
   SELECT current_contract_amount_minor INTO prior FROM pricing_revisions WHERE order_id=r.order_id AND revision_no<r.revision_no ORDER BY revision_no DESC LIMIT 1;
   delta:=CASE WHEN r.amendment_type='REPRICE_ORDER' THEN r.current_contract_amount_minor-COALESCE(prior,0)
     WHEN r.revision_no=1 OR r.amendment_type IN ('RESCHEDULE_STAY','EXTEND_STAY','SHORTEN_STAY','MOVE_UNIT') THEN greatest(0,r.current_contract_amount_minor-net) ELSE 0 END;
   IF delta<>0 THEN
     INSERT INTO channel_operating_facts(id,property_id,order_id,kind,amount_minor,currency,business_date,pricing_revision_id,command_id,note,created_at)
       VALUES('channel_'||r.id,r.property_id,r.order_id,CASE WHEN r.amendment_type='REPRICE_ORDER' THEN 'CORRECTION' ELSE 'SALE' END,
         delta,r.currency,CASE WHEN r.amendment_type='REPRICE_ORDER' THEN COALESCE(first_day,(r.created_at AT TIME ZONE r.timezone)::date) ELSE (r.created_at AT TIME ZONE r.timezone)::date END,
         r.id,r.command_id,'从已有计价修订承接；取消不等同于退款',r.created_at);
   END IF;
 END LOOP;
END $$;

CREATE FUNCTION qintopia_guard_channel_operating_fact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o orders%ROWTYPE; original channel_operating_facts%ROWTYPE; available bigint; c command_executions%ROWTYPE; revision pricing_revisions%ROWTYPE; amendment amendments%ROWTYPE; expected bigint; prior integer; expected_day date; local_today date; current_contract integer;
BEGIN
 SELECT * INTO STRICT o FROM orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.property_id<>NEW.property_id OR COALESCE(o.booking_channel_code,'') NOT IN ('YOUMUDAO','CTRIP','MEITUAN')
    OR o.stay_type='FREE' OR o.member_id IS NOT NULL OR o.member_contract_id IS NOT NULL THEN
   RAISE EXCEPTION 'channel operating fact requires an external-channel lodging order' USING ERRCODE='23514';
 END IF;
 IF NEW.command_id IS NOT NULL THEN
   SELECT * INTO STRICT c FROM command_executions WHERE id=NEW.command_id;
   IF c.state<>'EXECUTING' OR c.property_id<>NEW.property_id OR (NEW.kind='REFUND' AND c.command_type<>'RECORD_REFUND') OR (NEW.kind='REVERSAL' AND c.command_type<>'REVERSE_FACT') THEN
     RAISE EXCEPTION 'channel operating fact command mismatch' USING ERRCODE='23514';
   END IF;
 END IF;
 IF NEW.currency IS DISTINCT FROM (SELECT currency FROM properties WHERE id=NEW.property_id) THEN
   RAISE EXCEPTION 'channel currency mismatch' USING ERRCODE='23514';
 END IF;
 SELECT (now() AT TIME ZONE timezone)::date INTO local_today FROM properties WHERE id=NEW.property_id;
 IF NEW.business_date>local_today THEN RAISE EXCEPTION 'channel fact business date cannot be in future' USING ERRCODE='23514'; END IF;
 IF NEW.kind IN ('SALE','CORRECTION') THEN
   IF NEW.pricing_revision_id IS NULL OR NEW.command_id IS NULL THEN RAISE EXCEPTION 'new channel sale requires its committed pricing command' USING ERRCODE='23514'; END IF;
   SELECT * INTO STRICT revision FROM pricing_revisions WHERE id=NEW.pricing_revision_id;
   SELECT * INTO STRICT amendment FROM amendments WHERE id=revision.amendment_id;
   IF revision.order_id<>NEW.order_id OR amendment.command_id IS DISTINCT FROM NEW.command_id OR revision.currency<>NEW.currency THEN
     RAISE EXCEPTION 'channel pricing evidence mismatch' USING ERRCODE='23514';
   END IF;
   SELECT COALESCE(sum(amount_minor),0) INTO available FROM channel_operating_facts WHERE order_id=NEW.order_id;
   available:=available-COALESCE((SELECT amount_minor FROM operating_sales_opening WHERE property_id=NEW.property_id AND source_kind='CHANNEL_REFUND' AND source_id=NEW.order_id),0);
   SELECT (revision.created_at AT TIME ZONE timezone)::date INTO expected_day FROM properties WHERE id=NEW.property_id;
   IF NEW.kind='CORRECTION' THEN
     IF amendment.amendment_type<>'REPRICE_ORDER' THEN RAISE EXCEPTION 'channel correction requires REPRICE_ORDER' USING ERRCODE='23514'; END IF;
     SELECT current_contract_amount_minor INTO STRICT prior FROM pricing_revisions WHERE order_id=NEW.order_id AND revision_no<revision.revision_no ORDER BY revision_no DESC LIMIT 1;
     expected:=revision.current_contract_amount_minor-prior;
     SELECT COALESCE(min(business_date),expected_day) INTO expected_day FROM channel_operating_facts WHERE order_id=NEW.order_id AND kind='SALE';
   ELSE
     IF revision.revision_no<>1 AND amendment.amendment_type NOT IN ('RESCHEDULE_STAY','EXTEND_STAY','SHORTEN_STAY','MOVE_UNIT') THEN RAISE EXCEPTION 'invalid channel sale operation' USING ERRCODE='23514'; END IF;
     expected:=greatest(0,revision.current_contract_amount_minor-available);
   END IF;
   IF NEW.amount_minor<>expected OR NEW.business_date<>expected_day THEN RAISE EXCEPTION 'channel sale amount/date differs from pricing evidence' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.kind IN ('REFUND','REVERSAL') AND NOT EXISTS(SELECT 1 FROM operating_sales_baselines WHERE property_id=NEW.property_id) THEN
   RAISE EXCEPTION 'operating sales opening has not been initialized' USING ERRCODE='23514';
 END IF;
 IF NEW.kind IN ('REFUND','REVERSAL') AND EXISTS(SELECT 1 FROM operating_sales_baselines WHERE property_id=NEW.property_id AND month=date_trunc('month',NEW.business_date)::date) THEN
   RAISE EXCEPTION 'closed month cannot receive a new channel refund' USING ERRCODE='23514';
 END IF;
 IF NEW.kind IN ('REFUND','REVERSAL') THEN
   SELECT * INTO STRICT original FROM channel_operating_facts WHERE id=NEW.references_fact_id;
   IF original.order_id<>NEW.order_id OR original.property_id<>NEW.property_id OR original.currency<>NEW.currency
      OR (NEW.kind='REFUND' AND original.kind<>'SALE')
      OR (NEW.kind='REVERSAL' AND (original.kind<>'REFUND' OR NEW.amount_minor<>-original.amount_minor)) THEN
     RAISE EXCEPTION 'channel refund source mismatch' USING ERRCODE='23514';
   END IF;
 END IF;
 IF NEW.kind='REFUND' AND NEW.business_date<original.business_date THEN RAISE EXCEPTION 'refund predates source sale' USING ERRCODE='23514'; END IF;
 IF NEW.kind='REVERSAL' AND NEW.business_date<>original.business_date THEN RAISE EXCEPTION 'reversal must correct original business date' USING ERRCODE='23514'; END IF;
 IF NEW.kind='REFUND' AND EXISTS(SELECT 1 FROM channel_operating_facts f JOIN orders other_order ON other_order.id=f.order_id
   WHERE f.property_id=NEW.property_id AND other_order.booking_channel_code=o.booking_channel_code
     AND f.kind='REFUND' AND f.refund_reference=NEW.refund_reference
     AND NOT EXISTS(SELECT 1 FROM channel_operating_facts v WHERE v.references_fact_id=f.id AND v.kind='REVERSAL')) THEN
   RAISE EXCEPTION 'channel refund reference already recorded' USING ERRCODE='23505';
 END IF;
 IF NEW.kind='REFUND' THEN
   INSERT INTO channel_refund_claims(property_id,channel_code,refund_reference,fact_id) VALUES(NEW.property_id,o.booking_channel_code,NEW.refund_reference,NEW.id);
 ELSIF NEW.kind='REVERSAL' THEN
   DELETE FROM channel_refund_claims WHERE fact_id=original.id;
 END IF;
 SELECT COALESCE(sum(amount_minor),0) INTO available FROM channel_operating_facts WHERE order_id=NEW.order_id;
 available:=available-COALESCE((SELECT amount_minor FROM operating_sales_opening WHERE property_id=NEW.property_id AND source_kind='CHANNEL_REFUND' AND source_id=NEW.order_id),0);
 IF available+NEW.amount_minor<0 THEN RAISE EXCEPTION 'channel refund/correction exceeds recognized balance' USING ERRCODE='23514'; END IF;
 SELECT current_contract_amount_minor INTO current_contract FROM pricing_revisions WHERE id=o.current_revision_id;
 IF NEW.kind='REFUND' AND NEW.contract_effect_minor IS DISTINCT FROM least(current_contract,available+NEW.amount_minor)-current_contract THEN
   RAISE EXCEPTION 'channel refund contract adjustment mismatch' USING ERRCODE='23514';
 END IF;
 IF NEW.kind='REVERSAL' AND NEW.contract_effect_minor IS DISTINCT FROM -original.contract_effect_minor THEN
   RAISE EXCEPTION 'channel reversal contract adjustment mismatch' USING ERRCODE='23514';
 END IF;

 RETURN NEW;
END $$;
CREATE TRIGGER channel_operating_guard BEFORE INSERT ON channel_operating_facts FOR EACH ROW EXECUTE FUNCTION qintopia_guard_channel_operating_fact();
CREATE TRIGGER channel_operating_immutable BEFORE UPDATE OR DELETE ON channel_operating_facts FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_immutable();
CREATE TRIGGER opening_sales_immutable BEFORE UPDATE OR DELETE ON operating_sales_opening FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_immutable();
CREATE TRIGGER baseline_sales_immutable BEFORE UPDATE OR DELETE ON operating_sales_baselines FOR EACH ROW EXECUTE FUNCTION qintopia_allocation_immutable();
GRANT SELECT,INSERT ON channel_operating_facts TO qintopia_runtime;
GRANT SELECT ON operating_sales_opening,operating_sales_baselines TO qintopia_runtime;

CREATE FUNCTION qintopia_assert_channel_operating_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c command_executions%ROWTYPE; receipt command_receipts%ROWTYPE; amendment amendments%ROWTYPE; final_amount integer;
BEGIN
 SELECT * INTO STRICT c FROM command_executions WHERE id=NEW.command_id;
 SELECT * INTO STRICT receipt FROM command_receipts WHERE command_id=NEW.command_id;
 IF c.state<>'APPLIED' OR NOT receipt.business_committed OR receipt.execution_status<>'EXECUTED'
  OR (NEW.kind IN ('REFUND','REVERSAL') AND receipt.result->>'factId' IS DISTINCT FROM NEW.id) THEN
  RAISE EXCEPTION 'channel fact requires its committed command receipt' USING ERRCODE='23514';
 END IF;
 IF NEW.kind IN ('REFUND','REVERSAL') THEN
   SELECT * INTO STRICT amendment FROM amendments WHERE command_id=NEW.command_id AND order_id=NEW.order_id AND amendment_type=c.command_type;
   SELECT p.current_contract_amount_minor INTO final_amount FROM orders o JOIN pricing_revisions p ON p.id=o.current_revision_id WHERE o.id=NEW.order_id;
   IF amendment.payload->>'channelOperating' IS DISTINCT FROM 'true'
     OR (amendment.payload->>'contractTargetMinor')::bigint IS DISTINCT FROM final_amount
     OR (amendment.payload->>'contractTargetMinor')::bigint-(amendment.payload->>'contractBeforeMinor')::bigint IS DISTINCT FROM NEW.contract_effect_minor THEN
     RAISE EXCEPTION 'channel refund must atomically update its current settlement amount' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER channel_operating_commit AFTER INSERT ON channel_operating_facts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_assert_channel_operating_commit();
REVOKE ALL ON channel_refund_claims FROM PUBLIC,qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_guard_channel_operating_fact(),qintopia_assert_channel_operating_commit() FROM PUBLIC;
