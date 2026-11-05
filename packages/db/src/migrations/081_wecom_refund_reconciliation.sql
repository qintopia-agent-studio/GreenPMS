-- A narrowly evidenced exception for recording an original payment together
-- with refunds that already happened. Ordinary source freezing is unchanged.
LOCK TABLE collection_facts, external_payment_allocations, external_payment_allocation_releases,
  external_payment_bills, command_previews, command_executions, command_receipts IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE wecom_refund_reconciliations (
  command_id text PRIMARY KEY REFERENCES command_executions(id),
  preview_id text NOT NULL UNIQUE REFERENCES command_previews(id),
  source_fact_id text NOT NULL UNIQUE REFERENCES collection_facts(fact_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON wecom_refund_reconciliations FROM PUBLIC;
GRANT SELECT, INSERT ON wecom_refund_reconciliations TO qintopia_runtime;
CREATE TRIGGER wecom_refund_reconciliation_immutable BEFORE UPDATE OR DELETE ON wecom_refund_reconciliations
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

-- incoming_minor is zero after the collection allocation has been inserted,
-- or its amount in the BEFORE INSERT source-freeze guard.
CREATE FUNCTION qintopia_wecom_refund_reconciliation_safe(command_key text, source_key text, bill_key text, incoming_minor bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE proof record; expected jsonb; part jsonb; collected bigint; refunded bigint; matched_count integer;
  source_remaining bigint; pending_refunds bigint; successful_refunds bigint; actual_refund bigint;
BEGIN
  SELECT g.*,p.effect,p.normalized_input,c.property_id,c.subject_id,c.command_type,c.state,
    f.order_id,f.amount_minor,f.command_id AS fact_command_id,f.external_payment_bill_id,
    b.amount_minor AS bill_amount,b.reference,b.source_id,b.merchant_id,b.original_trade_no
  INTO proof FROM wecom_refund_reconciliations g JOIN command_previews p ON p.id=g.preview_id
  JOIN command_executions c ON c.id=g.command_id JOIN collection_facts f ON f.fact_id=g.source_fact_id
  JOIN orders o ON o.id=f.order_id JOIN external_payment_bills b ON b.id=f.external_payment_bill_id
  JOIN external_payment_sources s ON s.id=b.source_id
  WHERE g.command_id=command_key AND g.source_fact_id=source_key AND b.id=bill_key
    AND c.command_type='RECORD_REFUND' AND c.state IN ('EXECUTING','APPLIED')
    AND p.command_type=c.command_type AND p.property_id=c.property_id AND p.subject_id=c.subject_id
    AND p.effect->>'operation'='RECONCILE_WECOM_REFUNDS'
    AND p.effect->>'orderId'=o.id AND p.effect->>'orderStatus'=o.status
    AND (p.basis_versions->>'orderVersion')::integer=o.version
    AND o.property_id=c.property_id AND o.property_id=b.property_id
    AND o.stay_type<>'FREE' AND (o.booking_channel_code IS NULL OR o.booking_channel_code='WECOM')
    AND o.member_id IS NULL AND o.member_contract_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM amendments a WHERE a.order_id=o.id AND a.amendment_type='CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP')
    AND f.command_id=c.id AND f.fact_type='COLLECTION' AND f.method='WECOM' AND f.currency='CNY'
    AND f.references_fact_id IS NULL AND f.reverses_fact_id IS NULL AND f.net_effect_minor=f.amount_minor
    AND f.pricing_revision_id=o.current_revision_id AND b.kind='COLLECTION' AND b.state='SUCCESS'
    AND b.amount_minor>0 AND NOT b.needs_review AND s.enabled AND b.occurred_at>=s.matching_since
    AND f.transaction_reference=b.reference AND p.effect->>'currency'='CNY'
    AND p.effect#>>'{source,externalPaymentBillId}'=b.id
    AND p.effect#>>'{source,transactionReference}'=b.reference
    AND (p.effect#>>'{source,occurredAt}')::timestamptz=b.occurred_at
    AND (p.effect#>>'{source,amountMinor}')::integer=f.amount_minor
    AND nullif(btrim(p.effect->>'note'),'') IS NOT NULL AND f.note=p.effect->>'note'
    AND p.normalized_input->>'propertyId'=o.property_id AND p.normalized_input->>'orderId'=o.id
    AND p.normalized_input#>'{reconciliation,source}'=jsonb_build_object('externalPaymentBillId',b.id,'amountMinor',f.amount_minor)
    AND btrim(p.normalized_input#>>'{reconciliation,note}')=p.effect->>'note'
    AND NOT EXISTS(SELECT 1 FROM external_payment_bills d WHERE d.property_id=b.property_id AND d.kind=b.kind AND d.reference=b.reference AND d.id<>b.id)
    AND NOT EXISTS(SELECT 1 FROM external_payment_matches m WHERE m.bill_id=b.id AND m.membership_payment_fact_id IS NOT NULL);
  IF NOT FOUND THEN RETURN false; END IF;
  expected:=proof.effect->'refunds';
  IF jsonb_typeof(expected) IS DISTINCT FROM 'array' OR jsonb_array_length(expected) NOT BETWEEN 1 AND 50
    OR jsonb_typeof(proof.normalized_input#>'{reconciliation,refunds}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(proof.normalized_input#>'{reconciliation,refunds}')<>jsonb_array_length(expected)
    OR (SELECT count(DISTINCT value->>'externalPaymentBillId') FROM jsonb_array_elements(expected))<>jsonb_array_length(expected)
    THEN RETURN false; END IF;
  -- Historical split/manual facts may predate source allocation. Their business
  -- amounts are already registered even when the whole-bill linker found none.
  -- A transfer to membership preserves the original cash source; its internal
  -- reversal cannot make the same cash available for a new collection.
  IF EXISTS(SELECT 1 FROM external_payment_bills b
    WHERE (b.id=bill_key OR EXISTS(SELECT 1 FROM jsonb_array_elements(expected) p
      WHERE p.value->>'externalPaymentBillId'=b.id)) AND (
      EXISTS(SELECT 1 FROM collection_facts f JOIN orders o ON o.id=f.order_id
        WHERE o.property_id=b.property_id AND f.method='WECOM' AND f.fact_type=b.kind
          AND f.command_id IS DISTINCT FROM command_key
          AND (f.external_payment_bill_id=b.id OR CASE WHEN b.kind='COLLECTION' THEN f.transaction_reference ELSE f.refund_reference END=b.reference)
          AND NOT EXISTS(SELECT 1 FROM collection_facts r WHERE r.reverses_fact_id=f.fact_id
            AND NOT EXISTS(SELECT 1 FROM stay_collection_membership_transfers t
              WHERE t.property_id=o.property_id AND t.source_collection_fact_id=f.fact_id AND t.source_reversal_fact_id=r.fact_id))
          AND f.amount_minor<>(SELECT COALESCE(sum(a.amount_minor),0) FROM external_payment_allocations a
            WHERE a.bill_id=b.id AND a.collection_fact_id=f.fact_id
              AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)))
      OR EXISTS(SELECT 1 FROM membership_payment_facts f JOIN membership_orders o ON o.id=f.membership_order_id
        WHERE b.kind='COLLECTION' AND o.property_id=b.property_id AND f.fact_type='COLLECTION'
          AND f.source_type='DIRECT_WECOM' AND f.transaction_reference=b.reference
          AND NOT EXISTS(SELECT 1 FROM membership_payment_facts r WHERE r.reverses_fact_id=f.fact_id))
    )) THEN RETURN false; END IF;
  collected:=proof.amount_minor; refunded:=0;
  FOR part IN SELECT value FROM jsonb_array_elements(expected) LOOP
    SELECT count(*),COALESCE(sum(f.amount_minor),0) INTO matched_count,actual_refund
    FROM collection_facts f JOIN external_payment_allocations a ON a.collection_fact_id=f.fact_id
    JOIN external_payment_bills r ON r.id=a.bill_id JOIN external_payment_sources s ON s.id=r.source_id
    WHERE f.command_id=command_key AND f.order_id=proof.order_id AND f.fact_type='REFUND'
      AND f.references_fact_id=source_key AND f.external_payment_bill_id=r.id AND f.refund_reference=r.reference
      AND f.method='WECOM' AND f.currency='CNY' AND f.note=proof.effect->>'note'
      AND f.net_effect_minor=-f.amount_minor AND f.amount_minor=(part->>'amountMinor')::integer
      AND a.origin='CONFIRMED' AND a.command_id=command_key AND a.amount_minor=f.amount_minor
      AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)
      AND r.id=part->>'externalPaymentBillId' AND r.reference=part->>'refundReference'
      AND r.occurred_at=(part->>'occurredAt')::timestamptz
      AND r.kind='REFUND' AND r.state='SUCCESS' AND r.amount_minor>0 AND NOT r.needs_review
      AND s.enabled AND r.occurred_at>=s.matching_since
      AND r.property_id=proof.property_id AND r.source_id=proof.source_id AND r.merchant_id=proof.merchant_id
      AND r.transaction_id=proof.reference
      AND NOT EXISTS(SELECT 1 FROM external_payment_bills d WHERE d.property_id=r.property_id AND d.kind=r.kind AND d.reference=r.reference AND d.id<>r.id)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(proof.normalized_input#>'{reconciliation,refunds}') i
        WHERE i.value=jsonb_build_object('externalPaymentBillId',r.id,'amountMinor',f.amount_minor));
    IF matched_count<>1 THEN RETURN false; END IF;
    refunded:=refunded+actual_refund;
  END LOOP;
  IF refunded<=0 OR refunded>collected OR (proof.effect->>'collectedMinor')::bigint<>collected
    OR (proof.effect->>'refundedMinor')::bigint<>refunded OR (proof.effect->>'netEffectMinor')::bigint<>collected-refunded
    OR (SELECT count(*) FROM collection_facts f WHERE f.command_id=command_key)<>jsonb_array_length(expected)+1
    THEN RETURN false; END IF;
  -- Review/ambiguous successful refunds never qualify for a source exception.
  IF EXISTS(SELECT 1 FROM external_payment_bills r WHERE r.property_id=proof.property_id AND r.source_id=proof.source_id
    AND r.merchant_id=proof.merchant_id AND r.kind='REFUND' AND r.state='SUCCESS'
    AND (r.transaction_id=proof.reference OR r.original_trade_no=proof.original_trade_no)
    AND (r.amount_minor IS NULL OR r.needs_review OR r.transaction_id IS DISTINCT FROM proof.reference
      OR EXISTS(SELECT 1 FROM external_payment_bills d WHERE d.property_id=r.property_id AND d.kind=r.kind AND d.reference=r.reference AND d.id<>r.id)))
    THEN RETURN false; END IF;
  SELECT proof.bill_amount-COALESCE(sum(a.amount_minor),0)-incoming_minor INTO source_remaining
    FROM external_payment_allocations a WHERE a.bill_id=bill_key
      AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id);
  SELECT COALESCE(sum(r.amount_minor-COALESCE((SELECT sum(a.amount_minor) FROM external_payment_allocations a
      WHERE a.bill_id=r.id AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)),0)),0),
      COALESCE(sum(r.amount_minor),0)
    INTO pending_refunds,successful_refunds FROM external_payment_bills r
    WHERE r.property_id=proof.property_id AND r.source_id=proof.source_id AND r.merchant_id=proof.merchant_id
      AND r.kind='REFUND' AND r.state='SUCCESS' AND r.transaction_id=proof.reference;
  RETURN source_remaining>=0 AND pending_refunds>=0 AND successful_refunds<=proof.bill_amount
    AND (collected=refunded OR source_remaining>=pending_refunds);
END $$;

CREATE OR REPLACE FUNCTION qintopia_allocation_unassigned_refund_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text; must_check boolean:=true;
BEGIN
 IF TG_TABLE_NAME='external_payment_allocations' THEN k:=NEW.bill_id; must_check:=NEW.origin='CONFIRMED';
 ELSIF TG_TABLE_NAME='external_payment_allocation_releases' THEN SELECT bill_id INTO k FROM external_payment_allocations WHERE id=NEW.allocation_id;
 ELSIF TG_TABLE_NAME='retained_funds' THEN k:=NEW.bill_id;
 ELSE SELECT bill_id INTO k FROM retained_funds WHERE id=NEW.retained_fund_id; must_check:=NEW.kind<>'REFUND'; END IF;
 IF must_check AND EXISTS(SELECT 1 FROM external_payment_bills c JOIN external_payment_bills r ON r.source_id=c.source_id AND r.merchant_id=c.merchant_id AND r.transaction_id=c.reference AND r.kind='REFUND' AND r.state='SUCCESS'
  WHERE c.id=k AND c.kind='COLLECTION' AND (r.amount_minor IS NULL OR r.needs_review OR r.amount_minor>(SELECT COALESCE(sum(a.amount_minor),0) FROM external_payment_allocations a WHERE a.bill_id=r.id AND NOT EXISTS(SELECT 1 FROM external_payment_allocation_releases x WHERE x.allocation_id=a.id)))) THEN
  -- Only a newly evidenced collection allocation may use the group exception.
  -- Release/retention/ordinary allocation paths retain their exact freeze.
  IF TG_TABLE_NAME='external_payment_allocations' THEN
    IF NEW.origin='CONFIRMED' AND qintopia_wecom_refund_reconciliation_safe(NEW.command_id,NEW.collection_fact_id,NEW.bill_id,NEW.amount_minor) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'unassigned successful refund freezes source funds' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION qintopia_wecom_refund_reconciliation_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE command_key text; proof record; actual_ids jsonb; expected_refs jsonb;
BEGIN
 command_key:=NEW.command_id;
 SELECT g.*,p.effect,p.effect_hash,p.status,p.used_at,c.state,c.property_id,c.subject_id,c.command_type,
   f.external_payment_bill_id,r.result,r.fact_refs,r.business_committed,r.execution_status
 INTO proof FROM wecom_refund_reconciliations g JOIN command_previews p ON p.id=g.preview_id
 JOIN command_executions c ON c.id=g.command_id JOIN collection_facts f ON f.fact_id=g.source_fact_id
 LEFT JOIN command_receipts r ON r.command_id=c.id WHERE g.command_id=command_key;
 IF NOT FOUND THEN
   IF TG_TABLE_NAME='collection_facts' THEN
     IF NEW.fact_type='COLLECTION' AND EXISTS(SELECT 1 FROM command_executions WHERE id=command_key AND command_type='RECORD_REFUND') THEN
       RAISE EXCEPTION 'refund command collection requires reconciliation proof' USING ERRCODE='23514';
     END IF;
   END IF;
   RETURN NULL;
 END IF;
 IF proof.state<>'APPLIED' OR proof.status<>'USED' OR proof.used_at IS NULL
   OR proof.business_committed IS DISTINCT FROM true OR proof.execution_status IS DISTINCT FROM 'EXECUTED'
   OR proof.result->>'sourceFactId' IS DISTINCT FROM proof.source_fact_id
   OR proof.result->>'effectHash' IS DISTINCT FROM btrim(proof.effect_hash)
   OR proof.result-'sourceFactId'-'refundFactIds'-'effectHash' IS DISTINCT FROM proof.effect
   OR NOT qintopia_wecom_refund_reconciliation_safe(command_key,proof.source_fact_id,proof.external_payment_bill_id,0)
   OR NOT EXISTS(SELECT 1 FROM external_payment_allocations a WHERE a.collection_fact_id=proof.source_fact_id
     AND a.command_id=command_key AND a.origin='CONFIRMED' AND a.bill_id=proof.external_payment_bill_id
     AND a.amount_minor=(proof.effect->>'collectedMinor')::integer)
   OR NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.command_id=command_key AND a.subject_id=proof.subject_id
     AND a.action='RECORD_REFUND' AND a.decision='ALLOWED' AND a.metadata->>'previewId'=proof.preview_id
     AND a.metadata->>'effectHash'=btrim(proof.effect_hash)) THEN
   RAISE EXCEPTION 'incomplete or inconsistent refund reconciliation proof' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_agg(f.fact_id ORDER BY item.ordinality) INTO actual_ids
 FROM jsonb_array_elements(proof.effect->'refunds') WITH ORDINALITY item(value,ordinality)
 JOIN collection_facts f ON f.command_id=command_key AND f.fact_type='REFUND'
   AND f.external_payment_bill_id=item.value->>'externalPaymentBillId';
 expected_refs:=jsonb_build_array(proof.source_fact_id)||actual_ids;
 IF actual_ids IS DISTINCT FROM proof.result->'refundFactIds' OR expected_refs IS DISTINCT FROM proof.fact_refs THEN
   RAISE EXCEPTION 'refund reconciliation receipt fact references mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wecom_refund_reconciliation_complete AFTER INSERT ON wecom_refund_reconciliations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_wecom_refund_reconciliation_complete();
CREATE CONSTRAINT TRIGGER wecom_refund_reconciliation_fact_proof AFTER INSERT ON collection_facts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_wecom_refund_reconciliation_complete();
REVOKE ALL ON FUNCTION qintopia_wecom_refund_reconciliation_safe(text,text,text,bigint),
  qintopia_wecom_refund_reconciliation_complete() FROM PUBLIC, qintopia_runtime;
