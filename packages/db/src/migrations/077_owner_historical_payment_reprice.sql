-- One fixed maintenance operation. Public historical arrangement correction guards remain unchanged.
-- Existing zero revisions stay immutable; only new ordinary WECOM revisions are checked.
CREATE FUNCTION qintopia_validate_new_wecom_positive_pricing() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.current_contract_amount_minor = 0 AND EXISTS (
    SELECT 1 FROM orders o JOIN amendments a ON a.id=NEW.amendment_id AND a.order_id=o.id
    WHERE o.id=NEW.order_id AND o.booking_channel_code='WECOM'
      AND o.stay_type <> 'FREE' AND o.member_id IS NULL AND o.member_contract_id IS NULL
      AND o.status IN ('RESERVED','CHECKED_IN','CHECKED_OUT')
      AND a.amendment_type NOT IN ('CANCEL_ORDER','MARK_NO_SHOW','REVOKE_CHECK_IN')
      -- Both typed conversions append their member revision before setting order membership.
      -- Their existing deferred conversion-graph guards require the final membership and funds chain.
      AND NOT (
        a.amendment_type IN ('CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP','VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY')
        AND NEW.pricing_basis='MEMBER_ENTITLEMENT'
        AND EXISTS(SELECT 1 FROM command_executions e WHERE e.id=a.command_id
          AND e.command_type=a.amendment_type AND e.property_id=o.property_id)
      )
  ) THEN
    RAISE EXCEPTION 'ordinary WECOM contract amount must be positive; allocate shared collections by their real amounts'
      USING ERRCODE='23514', CONSTRAINT='ordinary_wecom_positive_contract_amount';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_validate_new_wecom_positive_pricing() FROM PUBLIC, qintopia_runtime;
CREATE TRIGGER pricing_revisions_validate_wecom_positive
  BEFORE INSERT ON pricing_revisions FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_wecom_positive_pricing();

CREATE TABLE owner_historical_payment_reprices (
  command_id text PRIMARY KEY REFERENCES command_executions(id),
  property_id text NOT NULL REFERENCES properties(id),
  order_id text NOT NULL UNIQUE REFERENCES orders(id),
  plan_id text NOT NULL CHECK (plan_id = 'historical-payment-reconciliation-2026-10-27'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  amendment_id text NOT NULL UNIQUE REFERENCES amendments(id),
  prior_revision_id text NOT NULL REFERENCES pricing_revisions(id),
  pricing_revision_id text NOT NULL UNIQUE REFERENCES pricing_revisions(id),
  stay_id text NOT NULL REFERENCES stays(id),
  stay_segment_id text NOT NULL REFERENCES stay_segments(id),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  recorded_by text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, plan_id)
);
REVOKE ALL ON owner_historical_payment_reprices FROM PUBLIC, qintopia_runtime;
GRANT SELECT ON owner_historical_payment_reprices TO qintopia_runtime;
CREATE TRIGGER owner_historical_payment_reprices_append_only
  BEFORE UPDATE OR DELETE ON owner_historical_payment_reprices
  FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE FUNCTION qintopia_validate_owner_historical_payment_reprice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner_name text;
BEGIN
  SELECT pg_get_userbyid(datdba) INTO owner_name FROM pg_database WHERE datname = current_database();
  IF current_user IS DISTINCT FROM session_user OR current_user IS DISTINCT FROM owner_name
    OR current_user = 'qintopia_runtime' OR NEW.recorded_by IS DISTINCT FROM owner_name THEN
    RAISE EXCEPTION 'historical payment repricing requires the direct database owner session' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM orders o
    JOIN stays s ON s.id = NEW.stay_id AND s.order_id = o.id
    JOIN stay_segments segment ON segment.id = NEW.stay_segment_id AND segment.stay_id = s.id
    JOIN pricing_revisions prior ON prior.id = NEW.prior_revision_id AND prior.order_id = o.id
    JOIN pricing_revisions revision ON revision.id = NEW.pricing_revision_id AND revision.order_id = o.id
    JOIN amendments a ON a.id = NEW.amendment_id AND a.order_id = o.id
    JOIN command_executions e ON e.id = NEW.command_id
    JOIN command_receipts receipt ON receipt.command_id = e.id
    JOIN audit_entries audit ON audit.command_id = e.id AND audit.decision = 'ALLOWED'
    WHERE o.id = NEW.order_id AND o.property_id = NEW.property_id
      AND o.status = 'CHECKED_OUT' AND s.status = 'COMPLETED'
      AND o.booking_channel_code = 'WECOM' AND o.stay_type <> 'FREE'
      AND o.member_id IS NULL AND o.member_contract_id IS NULL
      AND o.arrival_date = DATE '2026-10-02' AND o.departure_date = DATE '2026-10-03'
      AND segment.inventory_unit_id = 'unit_room_d_gen_04'
      AND segment.arrival_date = o.arrival_date AND segment.departure_date = o.departure_date
      AND NOT EXISTS(SELECT 1 FROM stay_segments later WHERE later.stay_id=s.id AND later.sequence>segment.sequence)
      AND o.version = NEW.expected_version + 1 AND o.current_revision_id = revision.id
      AND prior.current_contract_amount_minor = 0 AND prior.currency = 'CNY' AND prior.policy_base_amount_minor = 13000
      AND EXISTS(SELECT 1 FROM pricing_revisions original WHERE original.order_id=o.id
        AND original.revision_no<prior.revision_no AND original.current_contract_amount_minor=13000
        AND original.policy_base_amount_minor=13000 AND original.currency='CNY')
      AND revision.current_contract_amount_minor = 13000 AND revision.currency = prior.currency
      AND revision.revision_no = prior.revision_no + 1 AND revision.amendment_id = a.id
      AND revision.policy_version_id = prior.policy_version_id
      AND revision.arrival_date = prior.arrival_date AND revision.departure_date = prior.departure_date
      AND revision.arrival_date = o.arrival_date AND revision.departure_date = o.departure_date
      AND revision.policy_base_amount_minor = prior.policy_base_amount_minor
      AND revision.coverage_set = prior.coverage_set AND revision.cash_lines = prior.cash_lines
      AND revision.manual_adjustment_minor = 13000 - prior.policy_base_amount_minor
      AND revision.pricing_basis = CASE WHEN prior.policy_base_amount_minor = 13000 THEN 'POLICY' ELSE 'MANUAL_ADJUSTMENT' END
      AND a.amendment_type = 'REPRICE_ORDER' AND a.command_id = e.id
      AND a.prior_version = NEW.expected_version AND a.new_version = o.version AND a.sequence = o.version
      AND a.payload #>> '{maintenance,planId}' = NEW.plan_id
      AND a.payload #>> '{maintenance,planSha256}' = NEW.plan_sha256
      AND a.payload #>> '{maintenance,orderKey}' = 'D04'
      AND a.payload #>> '{before,currentContractAmount,minorUnits}' = '0'
      AND a.payload #>> '{targetCurrentContractAmount,minorUnits}' = '13000'
      AND e.command_type = 'REPRICE_ORDER' AND e.property_id = o.property_id AND e.state = 'APPLIED'
      AND e.idempotency_key = 'historical:' || NEW.plan_id || ':D04-contract'
      AND e.request_hash = NEW.plan_sha256
      AND receipt.execution_status = 'EXECUTED' AND receipt.business_committed
      AND receipt.result ->> 'orderId' = o.id
      AND receipt.result ->> 'amendmentId' = a.id
      AND receipt.result ->> 'pricingRevisionId' = revision.id
      AND receipt.result #>> '{targetCurrentContractAmount,minorUnits}' = '13000'
      AND audit.action = 'HISTORICAL_PAYMENT_RECONCILIATION'
      AND audit.subject_id = e.subject_id AND audit.credential_id = e.credential_id
      AND audit.metadata ->> 'planId' = NEW.plan_id
      AND audit.metadata ->> 'planSha256' = NEW.plan_sha256
      AND audit.metadata ->> 'step' = 'D04-contract'
      AND NOT EXISTS(SELECT 1 FROM amendments other WHERE other.command_id=e.id AND other.id<>a.id)
      AND NOT EXISTS(SELECT 1 FROM pricing_revisions other WHERE other.amendment_id=a.id AND other.id<>revision.id)
      AND NOT EXISTS(SELECT 1 FROM stay_segments other WHERE other.amendment_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM collection_facts f WHERE f.command_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM coverage_items c WHERE c.order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM entitlement_ledger l WHERE l.order_id=o.id)
  ) THEN
    RAISE EXCEPTION 'fixed owner historical payment repricing graph does not match D04 0 to 13000'
      USING ERRCODE = '23514', CONSTRAINT = 'owner_historical_payment_reprice_exact_chain';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_validate_owner_historical_payment_reprice() FROM PUBLIC, qintopia_runtime;
CREATE CONSTRAINT TRIGGER owner_historical_payment_reprices_validate
  AFTER INSERT ON owner_historical_payment_reprices DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION qintopia_validate_owner_historical_payment_reprice();

CREATE FUNCTION qintopia_reprice_fixed_historical_d04(
  target_property_id text, target_order_id text, target_expected_version integer,
  target_plan_sha256 text, target_subject_id text, target_credential_id text,
  target_command_id text, target_amendment_id text, target_revision_id text,
  target_receipt_id text, target_audit_id text
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  target_order orders%ROWTYPE;
  prior_revision pricing_revisions%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_segment stay_segments%ROWTYPE;
  plan_id constant text := 'historical-payment-reconciliation-2026-10-27';
  note constant text := '固定历史合付款收口：恢复D04真实合同金额';
  effect jsonb;
  result jsonb;
  refs jsonb;
  audit_reason jsonb;
BEGIN
  IF current_user IS DISTINCT FROM session_user OR current_user = 'qintopia_runtime'
    OR current_user IS DISTINCT FROM (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) THEN
    RAISE EXCEPTION 'historical payment repricing requires the direct database owner session' USING ERRCODE='42501';
  END IF;
  IF target_plan_sha256 IS NULL OR target_plan_sha256 !~ '^[a-f0-9]{64}$'
    OR target_expected_version IS NULL OR target_expected_version < 1 THEN
    RAISE EXCEPTION 'approved plan hash and expected version are required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('historical-payment-reconciliation:' || target_property_id,0));
  SELECT * INTO STRICT target_order FROM orders WHERE id=target_order_id AND property_id=target_property_id FOR UPDATE;
  SELECT * INTO STRICT prior_revision FROM pricing_revisions WHERE id=target_order.current_revision_id AND order_id=target_order.id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id=target_order.id FOR UPDATE;
  SELECT * INTO STRICT target_segment FROM stay_segments WHERE stay_id=target_stay.id ORDER BY sequence DESC LIMIT 1;
  IF target_order.version <> target_expected_version OR target_order.status <> 'CHECKED_OUT'
    OR target_stay.status <> 'COMPLETED' OR target_order.booking_channel_code IS DISTINCT FROM 'WECOM'
    OR target_order.stay_type = 'FREE' OR target_order.member_id IS NOT NULL OR target_order.member_contract_id IS NOT NULL
    OR target_order.arrival_date <> DATE '2026-10-02' OR target_order.departure_date <> DATE '2026-10-03'
    OR target_segment.inventory_unit_id <> 'unit_room_d_gen_04'
    OR target_segment.arrival_date <> target_order.arrival_date OR target_segment.departure_date <> target_order.departure_date
    OR prior_revision.current_contract_amount_minor <> 0 OR prior_revision.currency <> 'CNY' OR prior_revision.policy_base_amount_minor <> 13000
    OR NOT EXISTS(SELECT 1 FROM pricing_revisions original WHERE original.order_id=target_order.id
      AND original.revision_no<prior_revision.revision_no AND original.current_contract_amount_minor=13000
      AND original.policy_base_amount_minor=13000 AND original.currency='CNY')
    OR prior_revision.arrival_date <> target_order.arrival_date OR prior_revision.departure_date <> target_order.departure_date
    OR EXISTS(SELECT 1 FROM coverage_items WHERE order_id=target_order.id)
    OR EXISTS(SELECT 1 FROM entitlement_ledger WHERE order_id=target_order.id)
    OR EXISTS(SELECT 1 FROM amendments WHERE order_id=target_order.id AND amendment_type='CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP')
    OR EXISTS(SELECT 1 FROM owner_historical_payment_reprices previous WHERE previous.property_id=target_property_id AND previous.plan_id='historical-payment-reconciliation-2026-10-27') THEN
    RAISE EXCEPTION 'fixed D04 historical repricing preconditions changed' USING ERRCODE='23514';
  END IF;
  refs := jsonb_build_array(target_order_id,target_amendment_id,target_revision_id);
  audit_reason := jsonb_build_object('code','HISTORICAL_PAYMENT_RECONCILIATION','note',note);
  effect := jsonb_build_object(
    'orderId',target_order_id,
    'before',jsonb_build_object('currentContractAmount',jsonb_build_object('currency','CNY','minorUnits',0)),
    'policyBaseAmount',jsonb_build_object('currency','CNY','minorUnits',prior_revision.policy_base_amount_minor),
    'targetCurrentContractAmount',jsonb_build_object('currency','CNY','minorUnits',13000),
    'manualAdjustmentMinor',13000-prior_revision.policy_base_amount_minor,
    'maintenance',jsonb_build_object('planId',plan_id,'planSha256',target_plan_sha256,'orderKey','D04')
  );
  INSERT INTO command_executions(id,subject_id,credential_id,property_id,command_type,idempotency_key,request_hash,correlation_id,state)
    VALUES(target_command_id,target_subject_id,target_credential_id,target_property_id,'REPRICE_ORDER',
      'historical:'||plan_id||':D04-contract',target_plan_sha256,plan_id||':D04-contract','EXECUTING');
  INSERT INTO amendments(id,order_id,sequence,amendment_type,reason_code,reason_note,prior_version,new_version,payload,command_id,created_at)
    VALUES(target_amendment_id,target_order_id,target_expected_version+1,'REPRICE_ORDER','HISTORICAL_PAYMENT_RECONCILIATION',note,
      target_expected_version,target_expected_version+1,effect,target_command_id,
      greatest(transaction_timestamp(),coalesce((SELECT max(created_at) FROM amendments WHERE order_id=target_order_id),'-infinity'::timestamptz)));
  INSERT INTO pricing_revisions(id,order_id,revision_no,amendment_id,policy_version_id,arrival_date,departure_date,
    coverage_set,cash_lines,policy_base_amount_minor,pricing_basis,manual_adjustment_minor,current_contract_amount_minor,currency)
    VALUES(target_revision_id,target_order_id,prior_revision.revision_no+1,target_amendment_id,prior_revision.policy_version_id,
      prior_revision.arrival_date,prior_revision.departure_date,prior_revision.coverage_set,prior_revision.cash_lines,
      prior_revision.policy_base_amount_minor,CASE WHEN prior_revision.policy_base_amount_minor=13000 THEN 'POLICY' ELSE 'MANUAL_ADJUSTMENT' END,
      13000-prior_revision.policy_base_amount_minor,13000,prior_revision.currency);
  UPDATE orders SET current_revision_id=target_revision_id,version=target_expected_version+1,updated_at=now() WHERE id=target_order_id;
  UPDATE command_executions SET state='APPLIED',completed_at=now() WHERE id=target_command_id;
  result := jsonb_build_object('orderId',target_order_id,'amendmentId',target_amendment_id,'pricingRevisionId',target_revision_id,
    'policyBaseAmount',effect->'policyBaseAmount','targetCurrentContractAmount',effect->'targetCurrentContractAmount',
    'manualAdjustmentMinor',effect->'manualAdjustmentMinor');
  INSERT INTO command_receipts(id,command_id,execution_status,business_committed,result,error,resource_refs,fact_refs,committed_at)
    VALUES(target_receipt_id,target_command_id,'EXECUTED',true,result,NULL,refs,'[]'::jsonb,now());
  INSERT INTO audit_entries(id,subject_id,credential_id,action,decision,command_id,correlation_id,reason,target_refs,metadata)
    VALUES(target_audit_id,target_subject_id,target_credential_id,'HISTORICAL_PAYMENT_RECONCILIATION','ALLOWED',target_command_id,
      plan_id||':D04-contract',audit_reason,refs,jsonb_build_object('planId',plan_id,'planSha256',target_plan_sha256,'step','D04-contract'));
  INSERT INTO owner_historical_payment_reprices(command_id,property_id,order_id,plan_id,plan_sha256,amendment_id,
    prior_revision_id,pricing_revision_id,stay_id,stay_segment_id,expected_version)
    VALUES(target_command_id,target_property_id,target_order_id,plan_id,target_plan_sha256,target_amendment_id,
      prior_revision.id,target_revision_id,target_stay.id,target_segment.id,target_expected_version);
  RETURN result || jsonb_build_object('commandId',target_command_id,'resourceRefs',refs,'factRefs','[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION qintopia_reprice_fixed_historical_d04(text,text,integer,text,text,text,text,text,text,text,text)
  FROM PUBLIC, qintopia_runtime;

