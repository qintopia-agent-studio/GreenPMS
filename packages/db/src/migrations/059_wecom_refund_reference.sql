-- Preserve historical facts and the original collection reference. New WECOM
-- refunds additionally identify their own external refund, not the payment.
ALTER TABLE collection_facts ADD COLUMN refund_reference text;

CREATE FUNCTION qintopia_validate_wecom_refund_reference() RETURNS trigger
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
        AND f.refund_reference=NEW.refund_reference) THEN
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

CREATE TRIGGER collection_facts_validate_refund_reference
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_wecom_refund_reference();
REVOKE ALL ON FUNCTION qintopia_validate_wecom_refund_reference() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_validate_wecom_refund_reference() TO qintopia_runtime;
