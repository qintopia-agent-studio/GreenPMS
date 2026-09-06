CREATE TABLE member_deletions (
  operation_id text PRIMARY KEY REFERENCES account_management_operations(id),
  member_id text NOT NULL UNIQUE REFERENCES members(id),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER member_deletions_append_only BEFORE UPDATE OR DELETE ON member_deletions
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON member_deletions FROM PUBLIC, qintopia_runtime;
GRANT SELECT ON member_deletions TO qintopia_runtime;

ALTER TABLE membership_orders DROP CONSTRAINT membership_orders_lifecycle_state_check;
ALTER TABLE membership_orders ADD CONSTRAINT membership_orders_lifecycle_state_check CHECK (
  (status IN ('DRAFT','VOIDED') AND activated_at IS NULL AND valid_from IS NULL AND valid_until IS NULL
    AND contract_id IS NULL AND entitlement_lot_id IS NULL AND activated_by_command_id IS NULL)
  OR (status IN ('ACTIVE','VOIDED') AND activated_at IS NOT NULL AND valid_from IS NOT NULL AND valid_until IS NOT NULL
    AND contract_id IS NOT NULL AND entitlement_lot_id IS NOT NULL AND activated_by_command_id IS NOT NULL)
);

ALTER TABLE membership_payment_facts ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE membership_payment_facts ADD COLUMN deletion_operation_id text REFERENCES member_deletions(operation_id);
ALTER TABLE membership_payment_facts ADD CONSTRAINT membership_payment_operation_root CHECK (
  (command_id IS NOT NULL AND deletion_operation_id IS NULL)
  OR (command_id IS NULL AND deletion_operation_id IS NOT NULL AND fact_type = 'REVERSAL')
);
ALTER TABLE entitlement_ledger ADD COLUMN deletion_operation_id text REFERENCES member_deletions(operation_id);
ALTER TABLE entitlement_ledger ADD CONSTRAINT entitlement_deletion_operation_root CHECK (
  deletion_operation_id IS NULL OR (command_id IS NULL AND entry_type = 'VOID')
);

CREATE FUNCTION qintopia_member_deletion_snapshot(target_member text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH contracts AS (SELECT * FROM member_contracts WHERE member_id = target_member),
  lots AS (SELECT * FROM entitlement_lots WHERE contract_id IN (SELECT id FROM contracts)),
  purchases AS (SELECT * FROM membership_orders WHERE member_id = target_member),
  coverage AS (SELECT * FROM coverage_items WHERE contract_id IN (SELECT id FROM contracts) OR lot_id IN (SELECT id FROM lots))
  SELECT jsonb_build_object(
    'member', (SELECT to_jsonb(m) FROM members m WHERE id = target_member),
    'purchases', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM purchases p), '[]'),
    'contracts', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM contracts c), '[]'),
    'lots', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM lots l), '[]'),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY fact_id) FROM membership_payment_facts p WHERE membership_order_id IN (SELECT id FROM purchases)), '[]'),
    'ledger', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY fact_id) FROM entitlement_ledger l WHERE lot_id IN (SELECT id FROM lots)), '[]'),
    'coverage', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM coverage c), '[]'),
    'stays', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM orders o WHERE member_id = target_member OR member_contract_id IN (SELECT id FROM contracts) OR id IN (SELECT order_id FROM coverage)), '[]'),
    'links', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY property_id) FROM member_property_links l WHERE member_id = target_member), '[]'),
    'external', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM member_external_references r WHERE member_id = target_member), '[]'),
    'transfers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM stay_collection_membership_transfers t WHERE membership_order_id IN (SELECT id FROM purchases)), '[]')
  );
$$;
REVOKE ALL ON FUNCTION qintopia_member_deletion_snapshot(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_member_deletion_snapshot(text) TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_member_deletion_basis(target_member_id text, target_property_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  basis jsonb := qintopia_member_deletion_snapshot(target_member_id);
  blocked text;
  room_nights bigint;
  bed_nights bigint;
  reversal_amount bigint;
BEGIN
  IF basis->'member' IS NULL OR basis->'member' = 'null' OR basis->'member'->>'deleted_at' IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'links') l WHERE l->>'property_id' = target_property_id) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'links') l WHERE l->>'property_id' <> target_property_id)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'contracts') c WHERE c->>'property_id' <> target_property_id)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'purchases') p WHERE p->>'property_id' <> target_property_id)
    OR jsonb_array_length(basis->'external') > 0 THEN
    blocked := '该会员存在其他门店或外部关联，不能删除。';
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'ledger') l WHERE l->>'entry_type' IN ('CONSUME','CONVERSION_CONSUME','RESTORE','ADJUST'))
    OR jsonb_array_length(basis->'transfers') > 0 THEN
    blocked := '该会员已有权益核销、余额调整或住宿转会员记录，不能删除。';
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'stays') o WHERE o->>'status' NOT IN ('CANCELLED','NO_SHOW'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'coverage') c WHERE c->>'status' <> 'RELEASED') THEN
    blocked := '请先取消关联预订并释放权益，再删除会员。';
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'purchases') p WHERE p->>'status' = 'ACTIVE' AND (
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'contracts') c WHERE c->>'id' = p->>'contract_id' AND c->>'membership_order_id' = p->>'id')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'lots') l WHERE l->>'id' = p->>'entitlement_lot_id' AND l->>'contract_id' = p->>'contract_id')))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'contracts') c WHERE
      c->>'membership_order_id' IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'purchases') p
        WHERE p->>'id' = c->>'membership_order_id' AND p->>'contract_id' = c->>'id'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'payments') p WHERE p->>'source_type' <> 'DIRECT_WECOM') THEN
    blocked := '会员业务记录不完整或包含转入收款，不能直接删除。';
  END IF;
  SELECT COALESCE(sum(balance) FILTER (WHERE unit_kind = 'ROOM_NIGHT'),0),
    COALESCE(sum(balance) FILTER (WHERE unit_kind = 'BED_NIGHT'),0) INTO room_nights, bed_nights
  FROM (SELECT l->>'unit_kind' AS unit_kind, (l->>'total_units')::bigint + COALESCE((
    SELECT sum((e->>'quantity_delta')::bigint) FROM jsonb_array_elements(basis->'ledger') e WHERE e->>'lot_id' = l->>'id'),0) AS balance
    FROM jsonb_array_elements(basis->'lots') l WHERE l->>'status' = 'ACTIVE') balances;
  SELECT COALESCE(sum((p->>'amount_minor')::bigint),0) INTO reversal_amount FROM jsonb_array_elements(basis->'payments') p
    WHERE p->>'fact_type' = 'COLLECTION' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'payments') r WHERE r->>'reverses_fact_id' = p->>'fact_id');
  IF room_nights < 0 OR bed_nights < 0 OR reversal_amount > 2147483647 THEN blocked := '会员权益或收款汇总异常，不能删除。'; END IF;
  RETURN jsonb_build_object('memberId',target_member_id,'fullName',basis->'member'->>'full_name',
    'nickname',basis->'member'->>'nickname','phone',basis->'member'->>'phone',
    'version',encode(sha256(convert_to(basis::text,'UTF8')),'hex'),'canDelete',blocked IS NULL,'blockedReason',blocked,
    'membershipOrderCount',jsonb_array_length(basis->'purchases'),'roomNights',room_nights,'bedNights',bed_nights,'reversalAmountMinor',reversal_amount);
END;
$$;

CREATE FUNCTION qintopia_require_live_membership_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE linked_member_id text;
BEGIN
  IF TG_TABLE_NAME = 'membership_payment_facts' THEN
    SELECT m.member_id INTO linked_member_id FROM membership_orders m WHERE m.id = NEW.membership_order_id;
  ELSIF TG_TABLE_NAME IN ('coverage_items','entitlement_lots') THEN
    SELECT c.member_id INTO linked_member_id FROM member_contracts c WHERE c.id = NEW.contract_id;
  ELSE
    SELECT c.member_id INTO linked_member_id FROM entitlement_lots l JOIN member_contracts c ON c.id = l.contract_id WHERE l.id = NEW.lot_id;
  END IF;
  IF linked_member_id IS NOT NULL THEN
    PERFORM id FROM members WHERE id = linked_member_id AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'member has been deleted or is unavailable' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_TABLE_NAME IN ('membership_payment_facts','entitlement_ledger') THEN
   IF NEW.deletion_operation_id IS NOT NULL THEN
    IF current_user = 'qintopia_runtime' OR NOT EXISTS(SELECT 1 FROM member_deletions d
      WHERE d.operation_id = NEW.deletion_operation_id AND d.member_id = linked_member_id AND d.xmin = (pg_current_xact_id()::text)::xid) THEN
      RAISE EXCEPTION 'deletion child requires a current controlled deletion' USING ERRCODE='23514';
    END IF;
   END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER membership_payment_active_member BEFORE INSERT ON membership_payment_facts FOR EACH ROW EXECUTE FUNCTION qintopia_require_live_membership_reference();
CREATE TRIGGER entitlement_ledger_active_member BEFORE INSERT ON entitlement_ledger FOR EACH ROW EXECUTE FUNCTION qintopia_require_live_membership_reference();
CREATE TRIGGER coverage_items_active_member BEFORE INSERT OR UPDATE ON coverage_items FOR EACH ROW EXECUTE FUNCTION qintopia_require_live_membership_reference();
CREATE TRIGGER entitlement_lots_active_member BEFORE INSERT ON entitlement_lots FOR EACH ROW EXECUTE FUNCTION qintopia_require_live_membership_reference();

-- Extend existing identity guards only for an exact, current deletion root.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_protect_membership_order_identity()'::regprocedure) INTO definition;
  IF position('IF OLD.status = ''ACTIVE'' AND NEW IS DISTINCT FROM OLD THEN' IN definition) = 0 THEN RAISE EXCEPTION 'unexpected membership identity guard'; END IF;
  definition := replace(definition, 'IF OLD.status = ''ACTIVE'' AND NEW IS DISTINCT FROM OLD THEN', $patch$
  IF NEW.status = 'VOIDED' AND OLD.status IN ('DRAFT','ACTIVE')
    AND NEW.version = OLD.version + 1
    AND (to_jsonb(NEW) - ARRAY['status','version','updated_at']) = (to_jsonb(OLD) - ARRAY['status','version','updated_at'])
    AND current_user <> 'qintopia_runtime' AND EXISTS(SELECT 1 FROM member_deletions d
      WHERE d.member_id = OLD.member_id AND d.xmin = current_xid
        AND d.snapshot->'purchases' @> jsonb_build_array(to_jsonb(OLD))) THEN RETURN NEW; END IF;
  IF OLD.status = 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN$patch$);
  EXECUTE definition;
  SELECT pg_get_functiondef('qintopia_validate_membership_void_entitlement_fact()'::regprocedure) INTO definition;
  IF position('IF NEW.entry_type <> ''VOID'' THEN RETURN NEW; END IF;' IN definition) = 0 THEN RAISE EXCEPTION 'unexpected VOID guard'; END IF;
  EXECUTE replace(definition, 'IF NEW.entry_type <> ''VOID'' THEN RETURN NEW; END IF;', $patch$
  IF NEW.entry_type <> 'VOID' THEN RETURN NEW; END IF;
  IF NEW.deletion_operation_id IS NOT NULL AND current_user <> 'qintopia_runtime'
    AND NEW.command_id IS NULL AND NEW.order_id IS NULL AND NEW.coverage_id IS NULL AND NEW.service_date IS NULL
    AND NEW.reason = 'ERRONEOUS_MEMBER_DELETED' AND EXISTS(
      SELECT 1 FROM member_deletions d, LATERAL jsonb_array_elements(d.snapshot->'lots') l
      WHERE d.operation_id = NEW.deletion_operation_id AND d.xmin = (pg_current_xact_id()::text)::xid
        AND l->>'id' = NEW.lot_id AND l->>'status' = 'ACTIVE'
        AND NEW.quantity_delta = -((l->>'total_units')::bigint + COALESCE((SELECT sum((e->>'quantity_delta')::bigint)
          FROM jsonb_array_elements(d.snapshot->'ledger') e WHERE e->>'lot_id' = NEW.lot_id),0))
    ) THEN RETURN NEW; END IF;$patch$);
END;
$$;

CREATE FUNCTION qintopia_delete_member_business(actor_id text, session_id text, target_property text,
  operation_id text, request_key text, payload_hash text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  deletion_member_id text := input->>'targetId';
  basis jsonb;
  snapshot jsonb;
  output jsonb;
  entry record;
  deletion_time timestamptz := clock_timestamp();
BEGIN
  PERFORM id FROM members WHERE id = deletion_member_id FOR UPDATE;
  PERFORM id FROM membership_orders WHERE membership_orders.member_id = deletion_member_id ORDER BY id FOR UPDATE;
  PERFORM id FROM member_contracts WHERE member_contracts.member_id = deletion_member_id ORDER BY id FOR UPDATE;
  PERFORM l.id FROM entitlement_lots l JOIN member_contracts c ON c.id=l.contract_id WHERE c.member_id=deletion_member_id ORDER BY l.id FOR UPDATE OF l;
  basis := qintopia_member_deletion_basis(deletion_member_id,target_property);
  IF basis IS NULL THEN RAISE EXCEPTION 'MANAGEMENT_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF basis->>'version' IS DISTINCT FROM input->>'expectedVersion' THEN RAISE EXCEPTION 'MANAGEMENT_STALE' USING ERRCODE='P0001'; END IF;
  IF basis->>'canDelete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'MANAGEMENT_MEMBER_LINKED' USING ERRCODE='P0001'; END IF;
  IF (basis->>'reversalAmountMinor')::bigint > 0 AND input->>'confirmErroneousPayments' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'MANAGEMENT_PAYMENT_CONFIRMATION' USING ERRCODE='P0001';
  END IF;
  snapshot := qintopia_member_deletion_snapshot(deletion_member_id);
  output := jsonb_build_object('operationId',operation_id,'action','DELETE_MEMBER','targetId',deletion_member_id,
    'displayName',basis->>'fullName','completedAt',deletion_time);
  INSERT INTO account_management_operations VALUES(operation_id,actor_id,session_id,target_property,request_key,payload_hash,
    'DELETE_MEMBER',deletion_member_id,input->>'reason',output,deletion_time);
  INSERT INTO member_deletions VALUES(operation_id,deletion_member_id,snapshot,deletion_time);
  FOR entry IN SELECT p.* FROM membership_payment_facts p JOIN membership_orders o ON o.id=p.membership_order_id
    WHERE o.member_id=deletion_member_id AND p.fact_type='COLLECTION'
      AND NOT EXISTS(SELECT 1 FROM membership_payment_facts r WHERE r.reverses_fact_id=p.fact_id) ORDER BY p.fact_id LOOP
    INSERT INTO membership_payment_facts(fact_id,membership_order_id,fact_type,amount_minor,net_effect_minor,currency,
      reverses_fact_id,note,command_id,business_date,deletion_operation_id)
    VALUES('member_delete_payment_' || gen_random_uuid()::text,entry.membership_order_id,'REVERSAL',entry.amount_minor,
      -entry.net_effect_minor,entry.currency,entry.fact_id,input->>'reason',NULL,entry.business_date,operation_id);
  END LOOP;
  FOR entry IN SELECT l.*, l.total_units + COALESCE((SELECT sum(quantity_delta) FROM entitlement_ledger WHERE lot_id=l.id),0) AS remaining
    FROM entitlement_lots l JOIN member_contracts c ON c.id=l.contract_id WHERE c.member_id=deletion_member_id AND l.status='ACTIVE' ORDER BY l.id LOOP
    INSERT INTO entitlement_ledger(fact_id,lot_id,entry_type,quantity_delta,reason,deletion_operation_id)
      VALUES('member_delete_entitlement_' || gen_random_uuid()::text,entry.id,'VOID',-entry.remaining,'ERRONEOUS_MEMBER_DELETED',operation_id);
    UPDATE entitlement_lots SET status='VOIDED',version=version+1 WHERE id=entry.id;
  END LOOP;
  UPDATE member_contracts SET status='VOIDED',version=version+1 WHERE member_contracts.member_id=deletion_member_id AND status<>'VOIDED';
  UPDATE membership_orders SET status='VOIDED',version=version+1,updated_at=deletion_time WHERE membership_orders.member_id=deletion_member_id AND status<>'VOIDED';
  UPDATE members SET deleted_at=deletion_time WHERE id=deletion_member_id;
  RETURN output;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_delete_member_business(text,text,text,text,text,text,jsonb) FROM PUBLIC, qintopia_runtime;

DO $$
DECLARE definition text; start_at integer; end_at integer;
BEGIN
  SELECT pg_get_functiondef('qintopia_manage_account(text,text,text,text,text,text,text,text,jsonb)'::regprocedure) INTO definition;
  IF position('AND secret_hash = session_hash AND' IN definition) = 0 THEN RAISE EXCEPTION 'unexpected management session guard'; END IF;
  definition := replace(definition, 'AND secret_hash = session_hash AND',
    'AND secret_hash = encode(sha256(convert_to(session_hash, ''UTF8'')), ''hex'') AND');
  start_at := position('    PERFORM id FROM members WHERE id = target_id FOR UPDATE;' IN definition);
  end_at := position('  ELSE' || chr(10) || '    IF operation = ''CREATE_STAFF'' THEN' IN definition);
  IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'unexpected management deletion branch'; END IF;
  EXECUTE substring(definition FROM 1 FOR start_at-1)
    || '    output := qintopia_delete_member_business(actor_id,session_id,target_property,operation_id,request_key,payload_hash,input);' || chr(10)
    || substring(definition FROM end_at);
END;
$$;

CREATE FUNCTION qintopia_validate_member_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.member_id AND deleted_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM membership_orders WHERE member_id=NEW.member_id AND status<>'VOIDED')
    OR EXISTS(SELECT 1 FROM member_contracts WHERE member_id=NEW.member_id AND status<>'VOIDED')
    OR EXISTS(SELECT 1 FROM entitlement_lots l JOIN member_contracts c ON c.id=l.contract_id WHERE c.member_id=NEW.member_id AND l.status<>'VOIDED')
    OR EXISTS(SELECT 1 FROM membership_payment_facts p JOIN membership_orders o ON o.id=p.membership_order_id
      WHERE o.member_id=NEW.member_id GROUP BY p.membership_order_id HAVING sum(p.net_effect_minor)<>0)
    OR EXISTS(SELECT 1 FROM entitlement_lots l JOIN member_contracts c ON c.id=l.contract_id
      WHERE c.member_id=NEW.member_id AND l.total_units + COALESCE((SELECT sum(quantity_delta) FROM entitlement_ledger WHERE lot_id=l.id),0)<>0)
    OR NOT EXISTS(SELECT 1 FROM account_management_operations op WHERE op.id=NEW.operation_id AND op.action='DELETE_MEMBER' AND op.target_id=NEW.member_id)
    OR NOT EXISTS(SELECT 1 FROM audit_entries WHERE id=NEW.operation_id AND action='DELETE_MEMBER' AND decision='ALLOWED') THEN
    RAISE EXCEPTION 'member deletion must atomically void membership, reverse payments and retain audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER member_deletions_validate AFTER INSERT ON member_deletions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_validate_member_deletion();
