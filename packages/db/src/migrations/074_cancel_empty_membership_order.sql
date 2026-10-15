-- 空白会员订单取消：保留订单，使用既有 VOIDED 终态及独立追加式审计。
CREATE TABLE membership_order_cancellations (
  membership_order_id text PRIMARY KEY REFERENCES membership_orders(id),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  prior_version integer NOT NULL CHECK (prior_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER membership_order_cancellations_append_only
BEFORE UPDATE OR DELETE ON membership_order_cancellations
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON membership_order_cancellations FROM PUBLIC, qintopia_runtime;
GRANT SELECT, INSERT ON membership_order_cancellations TO qintopia_runtime;

INSERT INTO command_catalog(command_type, command_class) VALUES ('CANCEL_MEMBERSHIP_ORDER','HUMAN_COMMAND');
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
    WHERE conrelid='subject_command_grants'::regclass AND conname='subject_command_grants_human_exact_check';
  IF position('''ACTIVATE_MEMBERSHIP_ORDER''::text' IN definition)=0 THEN RAISE EXCEPTION 'missing membership grant baseline'; END IF;
  definition := replace(definition, '''ACTIVATE_MEMBERSHIP_ORDER''::text', '''ACTIVATE_MEMBERSHIP_ORDER''::text, ''CANCEL_MEMBERSHIP_ORDER''::text');
  ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
  EXECUTE 'ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check '||definition;
END $$;
INSERT INTO staff_command_profile_catalog(profile,command_type,token_default)
  SELECT profile,'CANCEL_MEMBERSHIP_ORDER',token_default FROM staff_command_profile_catalog WHERE command_type='CREATE_MEMBERSHIP_ORDER';
INSERT INTO subject_command_grants(subject_id,property_id,command_type)
  SELECT subject_id,property_id,'CANCEL_MEMBERSHIP_ORDER' FROM subject_command_grants WHERE command_type='CREATE_MEMBERSHIP_ORDER';
-- 已有 token 的权限上限不变。
UPDATE staff_profile_reconciliation_state SET projection_hash=(SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value,E'\n' ORDER BY row_value),''),'UTF8')),'hex') FROM (
 SELECT format('A|%s|%s|%s',subject_id,property_id,profile) AS row_value FROM staff_profile_assignments UNION ALL SELECT format('G|%s|%s|%s',subject_id,property_id,command_type) FROM subject_command_grants) projection),reconciled_by=current_user,reconciled_at=now() WHERE singleton;

CREATE FUNCTION qintopia_validate_membership_order_cancellation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog, public AS $$
DECLARE target membership_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT target FROM membership_orders WHERE id=NEW.membership_order_id FOR UPDATE;
  IF target.status <> 'DRAFT' OR target.version <> NEW.prior_version
    OR num_nonnulls(target.contract_id,target.entitlement_lot_id,target.activated_at,target.activated_by_command_id,target.valid_from,target.valid_until) <> 0
    OR EXISTS(SELECT 1 FROM membership_payment_facts WHERE membership_order_id=target.id)
    OR EXISTS(SELECT 1 FROM member_contracts WHERE membership_order_id=target.id)
    OR NOT EXISTS(SELECT 1 FROM command_executions WHERE id=NEW.command_id
      AND command_type='CANCEL_MEMBERSHIP_ORDER' AND property_id=target.property_id
      AND state='EXECUTING' AND xmin=(pg_current_xact_id()::text)::xid)
    OR NEW.created_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'only an untouched draft membership order can be cancelled by its executing command' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_order_cancellation_validate BEFORE INSERT ON membership_order_cancellations
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_order_cancellation();

CREATE FUNCTION qintopia_validate_membership_order_cancellation_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog, public AS $$
DECLARE target membership_orders%ROWTYPE;
BEGIN
  SELECT * INTO STRICT target FROM membership_orders WHERE id=NEW.membership_order_id;
  IF target.status <> 'VOIDED' OR target.version <> NEW.prior_version+1
    OR num_nonnulls(target.contract_id,target.entitlement_lot_id,target.activated_at,target.activated_by_command_id,target.valid_from,target.valid_until) <> 0
    OR EXISTS(SELECT 1 FROM membership_payment_facts WHERE membership_order_id=target.id)
    OR EXISTS(SELECT 1 FROM member_contracts WHERE membership_order_id=target.id)
    OR NOT qintopia_has_typed_runtime_command_evidence(NEW.command_id,'CANCEL_MEMBERSHIP_ORDER',target.property_id) THEN
    RAISE EXCEPTION 'membership cancellation requires an empty voided order and complete typed command evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER membership_order_cancellation_complete AFTER INSERT ON membership_order_cancellations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_order_cancellation_completion();

-- 在既有不可变与投影守卫中仅增加完整取消证据的窄分支，保留原纠错/删除路径。
DO $$ DECLARE definition text; anchor text; BEGIN
  SELECT pg_get_functiondef('qintopia_protect_membership_order_identity()'::regprocedure) INTO definition;
  anchor := 'IF OLD.status = ''VOIDED'' AND NEW IS DISTINCT FROM OLD THEN';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'missing membership identity baseline'; END IF;
  definition := replace(definition,anchor,$patch$
  IF OLD.status = 'DRAFT' AND NEW.status = 'VOIDED'
    AND EXISTS(SELECT 1 FROM membership_order_cancellations c WHERE c.membership_order_id=OLD.id AND c.xmin=current_xid) THEN
    IF NEW.version <> OLD.version+1
      OR (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at']) THEN
      RAISE EXCEPTION 'membership cancellation may only change status and version metadata' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'VOIDED' AND NEW IS DISTINCT FROM OLD THEN$patch$);
  EXECUTE definition;
  SELECT pg_get_functiondef('qintopia_guard_runtime_membership_projection_update_050()'::regprocedure) INTO definition;
  anchor := 'CASE TG_TABLE_NAME';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'missing membership projection baseline'; END IF;
  definition := replace(definition,anchor,$patch$
  IF TG_TABLE_NAME = 'membership_orders' THEN
    IF OLD.status='DRAFT' AND NEW.status='VOIDED' AND NEW.version=OLD.version+1
      AND (to_jsonb(NEW)-ARRAY['status','version','updated_at']) = (to_jsonb(OLD)-ARRAY['status','version','updated_at'])
      AND EXISTS(SELECT 1 FROM membership_order_cancellations c
        WHERE c.membership_order_id=NEW.id AND c.prior_version=OLD.version AND c.xmin=current_xid
          AND qintopia_has_typed_runtime_command_evidence(c.command_id,'CANCEL_MEMBERSHIP_ORDER',NEW.property_id)) THEN RETURN NEW; END IF;
  END IF;
  CASE TG_TABLE_NAME$patch$);
  EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION qintopia_validate_membership_order_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_validate_membership_order_cancellation_completion() FROM PUBLIC;
