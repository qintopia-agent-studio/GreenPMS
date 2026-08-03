LOCK TABLE orders, stays, amendments, pricing_revisions, collection_facts,
  membership_orders, membership_payment_facts, member_contracts, entitlement_lots,
  entitlement_ledger, command_executions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE membership_payment_facts
  ADD COLUMN source_type text NOT NULL DEFAULT 'DIRECT_WECOM',
  ADD COLUMN source_order_id text REFERENCES orders(id),
  ADD COLUMN source_collection_fact_id text REFERENCES collection_facts(fact_id),
  ADD CONSTRAINT membership_payment_source_type_check CHECK (
    source_type IN ('DIRECT_WECOM', 'STAY_COLLECTION_TRANSFER')
  ),
  ADD CONSTRAINT membership_payment_direct_source_null CHECK (
    source_type <> 'DIRECT_WECOM'
    OR (source_order_id IS NULL AND source_collection_fact_id IS NULL)
  ),
  ADD CONSTRAINT membership_payment_transfer_source_required CHECK (
    source_type <> 'STAY_COLLECTION_TRANSFER'
    OR (source_order_id IS NOT NULL AND source_collection_fact_id IS NOT NULL)
  );

ALTER TABLE collection_facts
  ADD CONSTRAINT collection_facts_fact_id_order_id_unique UNIQUE (fact_id, order_id);

CREATE INDEX membership_payment_source_collection_idx
  ON membership_payment_facts (source_order_id, source_collection_fact_id)
  WHERE source_type = 'STAY_COLLECTION_TRANSFER';

CREATE TABLE stay_collection_membership_transfers (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  order_id text NOT NULL REFERENCES orders(id),
  source_collection_fact_id text NOT NULL REFERENCES collection_facts(fact_id),
  source_reversal_fact_id text NOT NULL REFERENCES collection_facts(fact_id),
  membership_order_id text NOT NULL REFERENCES membership_orders(id),
  membership_payment_fact_id text NOT NULL REFERENCES membership_payment_facts(fact_id),
  command_id text NOT NULL REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_collection_fact_id),
  UNIQUE (source_reversal_fact_id),
  UNIQUE (membership_payment_fact_id),
  FOREIGN KEY (source_collection_fact_id, order_id)
    REFERENCES collection_facts(fact_id, order_id)
);

CREATE INDEX stay_collection_membership_transfers_order_idx
  ON stay_collection_membership_transfers (order_id, created_at, id);

CREATE INDEX stay_collection_membership_transfers_membership_order_idx
  ON stay_collection_membership_transfers (membership_order_id, created_at, id);

CREATE OR REPLACE FUNCTION qintopia_validate_membership_payment_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_order membership_orders%ROWTYPE;
  source_fact collection_facts%ROWTYPE;
  source_property_id text;
  corrected membership_payment_facts%ROWTYPE;
  reversed membership_payment_facts%ROWTYPE;
BEGIN
  NEW.transaction_reference := NULLIF(
    regexp_replace(btrim(NEW.transaction_reference), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  NEW.source_order_id := NULLIF(btrim(NEW.source_order_id), '');
  NEW.source_collection_fact_id := NULLIF(btrim(NEW.source_collection_fact_id), '');

  SELECT * INTO target_order FROM membership_orders WHERE id = NEW.membership_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership payment requires an existing membership order'
      USING ERRCODE = '23503', CONSTRAINT = 'membership_payment_order_required';
  END IF;
  IF NEW.currency IS DISTINCT FROM target_order.currency THEN
    RAISE EXCEPTION 'membership payment currency must match its membership order'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_currency_match';
  END IF;

  IF NEW.source_type = 'DIRECT_WECOM' THEN
    IF NEW.source_order_id IS NOT NULL OR NEW.source_collection_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'direct membership payments cannot carry lodging source fields'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_direct_source_null';
    END IF;
  ELSIF NEW.source_type = 'STAY_COLLECTION_TRANSFER' THEN
    IF NEW.fact_type IS DISTINCT FROM 'COLLECTION'
      OR NEW.net_effect_minor IS DISTINCT FROM NEW.amount_minor
      OR NEW.transaction_reference IS NOT NULL
      OR NEW.corrects_fact_id IS NOT NULL
      OR NEW.reverses_fact_id IS NOT NULL
      OR NEW.source_order_id IS NULL
      OR NEW.source_collection_fact_id IS NULL THEN
      RAISE EXCEPTION 'transferred lodging collection has an invalid membership payment shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_transfer_shape';
    END IF;
    SELECT * INTO source_fact
      FROM collection_facts
      WHERE fact_id = NEW.source_collection_fact_id;
    SELECT property_id INTO source_property_id
      FROM orders
      WHERE id = source_fact.order_id;
    IF NOT FOUND
      OR source_fact.order_id IS DISTINCT FROM NEW.source_order_id
      OR source_property_id IS DISTINCT FROM target_order.property_id
      OR source_fact.fact_type IS DISTINCT FROM 'COLLECTION'
      OR source_fact.method IS DISTINCT FROM 'WECOM'
      OR NULLIF(btrim(source_fact.transaction_reference), '') IS NULL
      OR source_fact.amount_minor IS DISTINCT FROM NEW.amount_minor
      OR source_fact.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'transferred membership payment must match an intact WECOM lodging collection'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_transfer_source';
    END IF;
  ELSE
    RAISE EXCEPTION 'membership payment source type is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_source_type_check';
  END IF;

  IF NEW.fact_type = 'COLLECTION' THEN
    IF NEW.net_effect_minor IS DISTINCT FROM NEW.amount_minor
      OR NEW.reverses_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'membership collection has an invalid shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_collection_shape';
    END IF;
    IF NEW.source_type = 'DIRECT_WECOM' AND NEW.transaction_reference IS NULL THEN
      RAISE EXCEPTION 'direct membership collection requires a transaction reference'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_collection_shape';
    END IF;
    IF NEW.source_type = 'DIRECT_WECOM'
      AND NEW.transaction_reference IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM stay_collection_membership_transfers AS transfer
        JOIN collection_facts AS source
          ON source.order_id = transfer.order_id
        WHERE transfer.membership_order_id = NEW.membership_order_id
          AND source.fact_type = 'COLLECTION'
          AND source.transaction_reference = NEW.transaction_reference
      ) THEN
      RAISE EXCEPTION 'direct membership collection must not reuse a lodging transaction reference from the converted order'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_conversion_direct_reference_new';
    END IF;
    IF NEW.corrects_fact_id IS NOT NULL THEN
      SELECT * INTO corrected FROM membership_payment_facts WHERE fact_id = NEW.corrects_fact_id;
      IF NOT FOUND
        OR corrected.fact_type <> 'COLLECTION'
        OR corrected.source_type <> 'DIRECT_WECOM'
        OR corrected.membership_order_id <> NEW.membership_order_id THEN
        RAISE EXCEPTION 'replacement collection must correct a direct collection in the same membership order'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_correction_target';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM membership_payment_facts WHERE reverses_fact_id = NEW.corrects_fact_id) THEN
        RAISE EXCEPTION 'replacement collection requires a reversal of the corrected fact'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_correction_reversal_required';
      END IF;
    END IF;
  ELSE
    IF NEW.source_type <> 'DIRECT_WECOM'
      OR NEW.corrects_fact_id IS NOT NULL
      OR NEW.reverses_fact_id IS NULL
      OR NEW.transaction_reference IS NOT NULL THEN
      RAISE EXCEPTION 'membership reversal has an invalid shape'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_shape';
    END IF;
    SELECT * INTO reversed FROM membership_payment_facts WHERE fact_id = NEW.reverses_fact_id;
    IF NOT FOUND
      OR reversed.fact_type <> 'COLLECTION'
      OR reversed.source_type <> 'DIRECT_WECOM'
      OR reversed.membership_order_id <> NEW.membership_order_id THEN
      RAISE EXCEPTION 'membership reversal must reverse a direct collection in the same membership order'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_target';
    END IF;
    IF NEW.amount_minor IS DISTINCT FROM reversed.amount_minor
      OR NEW.net_effect_minor IS DISTINCT FROM -reversed.net_effect_minor
      OR NEW.currency IS DISTINCT FROM reversed.currency THEN
      RAISE EXCEPTION 'membership reversal must negate the original collection'
        USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_reversal_amount';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stay_collection_membership_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_fact collection_facts%ROWTYPE;
  source_reversal collection_facts%ROWTYPE;
  membership_payment membership_payment_facts%ROWTYPE;
  membership_order membership_orders%ROWTYPE;
  source_property_id text;
  execution_type text;
  active_refunded_minor bigint;
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  SELECT * INTO source_fact FROM collection_facts WHERE fact_id = NEW.source_collection_fact_id FOR UPDATE;
  SELECT * INTO source_reversal FROM collection_facts WHERE fact_id = NEW.source_reversal_fact_id FOR UPDATE;
  SELECT * INTO membership_payment FROM membership_payment_facts WHERE fact_id = NEW.membership_payment_fact_id FOR UPDATE;
  SELECT * INTO membership_order FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  SELECT property_id INTO source_property_id FROM orders WHERE id = NEW.order_id;
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;

  IF source_fact.fact_id IS NULL
    OR source_reversal.fact_id IS NULL
    OR membership_payment.fact_id IS NULL
    OR membership_order.id IS NULL
    OR source_property_id IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires complete source and destination facts'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_complete';
  END IF;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires its typed command'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_command';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stay_collection_membership_transfers AS existing
    WHERE existing.order_id = NEW.order_id
      AND (existing.command_id IS DISTINCT FROM NEW.command_id
        OR existing.membership_order_id IS DISTINCT FROM NEW.membership_order_id)
  ) THEN
    RAISE EXCEPTION 'one lodging order can be converted to membership only once'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_one_conversion_per_order';
  END IF;
  IF NEW.property_id IS DISTINCT FROM source_property_id
    OR membership_order.property_id IS DISTINCT FROM NEW.property_id THEN
    RAISE EXCEPTION 'stay-to-membership transfer must stay inside one property'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_property';
  END IF;
  IF source_fact.order_id IS DISTINCT FROM NEW.order_id
    OR source_fact.fact_type IS DISTINCT FROM 'COLLECTION'
    OR source_fact.method IS DISTINCT FROM 'WECOM'
    OR NULLIF(btrim(source_fact.transaction_reference), '') IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership transfer source must be a WECOM lodging collection'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM collection_facts AS reversal
    WHERE reversal.reverses_fact_id = source_fact.fact_id
      AND reversal.fact_id IS DISTINCT FROM source_reversal.fact_id
  ) THEN
    RAISE EXCEPTION 'reversed lodging collections cannot be transferred to membership'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_reversed';
  END IF;
  SELECT COALESCE(SUM(refund.amount_minor), 0)
    INTO active_refunded_minor
    FROM collection_facts AS refund
    WHERE refund.fact_type = 'REFUND'
      AND refund.references_fact_id = source_fact.fact_id
      AND NOT EXISTS (
        SELECT 1 FROM collection_facts AS reversal
        WHERE reversal.reverses_fact_id = refund.fact_id
      );
  IF active_refunded_minor > 0 THEN
    RAISE EXCEPTION 'refunded lodging collections cannot be transferred to membership'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_refunded';
  END IF;
  IF source_reversal.order_id IS DISTINCT FROM NEW.order_id
    OR source_reversal.fact_type IS DISTINCT FROM 'REVERSAL'
    OR source_reversal.reverses_fact_id IS DISTINCT FROM source_fact.fact_id
    OR source_reversal.command_id IS DISTINCT FROM NEW.command_id
    OR source_reversal.amount_minor IS DISTINCT FROM source_fact.amount_minor
    OR source_reversal.net_effect_minor IS DISTINCT FROM -source_fact.net_effect_minor
    OR source_reversal.currency IS DISTINCT FROM source_fact.currency THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires an exact lodging reversal'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_reversal';
  END IF;
  IF membership_payment.membership_order_id IS DISTINCT FROM NEW.membership_order_id
    OR membership_payment.fact_type IS DISTINCT FROM 'COLLECTION'
    OR membership_payment.source_type IS DISTINCT FROM 'STAY_COLLECTION_TRANSFER'
    OR membership_payment.source_order_id IS DISTINCT FROM NEW.order_id
    OR membership_payment.source_collection_fact_id IS DISTINCT FROM source_fact.fact_id
    OR membership_payment.command_id IS DISTINCT FROM NEW.command_id
    OR membership_payment.transaction_reference IS NOT NULL
    OR membership_payment.amount_minor IS DISTINCT FROM source_fact.amount_minor
    OR membership_payment.net_effect_minor IS DISTINCT FROM source_fact.amount_minor
    OR membership_payment.currency IS DISTINCT FROM source_fact.currency THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires a matching membership payment fact'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_payment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stay_collection_membership_transfers_validate_insert
BEFORE INSERT ON stay_collection_membership_transfers
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stay_collection_membership_transfer();

CREATE TRIGGER stay_collection_membership_transfers_append_only
BEFORE UPDATE OR DELETE ON stay_collection_membership_transfers
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE OR REPLACE FUNCTION qintopia_reject_lodging_funds_after_membership_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM stay_collection_membership_transfers
    WHERE order_id = NEW.order_id
  ) THEN
    RETURN NEW;
  END IF;
  SELECT command_type INTO execution_type
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    AND NEW.fact_type = 'REVERSAL' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lodging funds are closed after stay collections transfer to membership'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_lodging_funds_closed';
END;
$$;

CREATE TRIGGER collection_facts_stage13_reject_after_transfer
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_lodging_funds_after_membership_transfer();

CREATE OR REPLACE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
BEGIN
  PERFORM 1 FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1
    FROM stay_collection_membership_transfers
    WHERE membership_order_id = NEW.membership_order_id
  ) THEN
    RETURN NEW;
  END IF;
  SELECT command_type, state
    INTO execution_type, execution_state
    FROM command_executions
    WHERE id = NEW.command_id;
  IF execution_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    AND execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'membership funds are closed for membership orders created from lodging collection transfer'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_funds_closed';
END;
$$;

CREATE TRIGGER membership_payment_stage13_reject_after_transfer
BEFORE INSERT ON membership_payment_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_membership_funds_after_stay_transfer();

CREATE OR REPLACE FUNCTION qintopia_require_transfer_membership_payment_bridge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type <> 'STAY_COLLECTION_TRANSFER' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stay_collection_membership_transfers
    WHERE membership_payment_fact_id = NEW.fact_id
      AND membership_order_id = NEW.membership_order_id
      AND source_collection_fact_id = NEW.source_collection_fact_id
      AND order_id = NEW.source_order_id
      AND command_id = NEW.command_id
  ) THEN
    RAISE EXCEPTION 'transferred membership payment requires a stay transfer bridge'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_payment_transfer_bridge_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER membership_payment_transfer_bridge_required
AFTER INSERT ON membership_payment_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.source_type = 'STAY_COLLECTION_TRANSFER')
EXECUTE FUNCTION qintopia_require_transfer_membership_payment_bridge();

ALTER TABLE entitlement_ledger DROP CONSTRAINT entitlement_ledger_entry_type_check;
ALTER TABLE entitlement_ledger ADD CONSTRAINT entitlement_ledger_entry_type_check CHECK (
  entry_type IN ('ADJUST','HOLD','RELEASE','CONSUME','RESTORE','EXPIRE','CONVERSION_CONSUME')
);

CREATE UNIQUE INDEX entitlement_ledger_one_conversion_consume_per_lot_order_date_idx
  ON entitlement_ledger (lot_id, order_id, service_date)
  WHERE entry_type = 'CONVERSION_CONSUME';

CREATE OR REPLACE FUNCTION qintopia_validate_conversion_consume_entitlement_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  target_order orders%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_membership_order membership_orders%ROWTYPE;
BEGIN
  IF NEW.entry_type <> 'CONVERSION_CONSUME' THEN
    RETURN NEW;
  END IF;
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;
  SELECT * INTO target_order FROM orders WHERE id = NEW.order_id;
  SELECT * INTO target_lot FROM entitlement_lots WHERE id = NEW.lot_id;
  SELECT * INTO target_contract FROM member_contracts WHERE id = target_lot.contract_id;
  SELECT * INTO target_membership_order
    FROM membership_orders
    WHERE entitlement_lot_id = NEW.lot_id;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
    OR target_order.id IS NULL
    OR target_lot.id IS NULL
    OR target_contract.id IS NULL
    OR target_membership_order.id IS NULL
    OR target_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_membership_order.contract_id IS DISTINCT FROM target_contract.id
    OR target_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_membership_order.activated_by_command_id IS DISTINCT FROM NEW.command_id
    OR NEW.quantity_delta IS DISTINCT FROM -1
    OR NEW.service_date IS NULL
    OR NEW.coverage_id IS NOT NULL
    OR NULLIF(btrim(NEW.reason), '') IS NULL THEN
    RAISE EXCEPTION 'conversion consumption entitlement fact has an invalid shape'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_conversion_consume_shape';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlement_ledger_validate_conversion_consume
BEFORE INSERT ON entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_conversion_consume_entitlement_fact();

CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command(target_command_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  amendment_count integer;
  target_amendment amendments%ROWTYPE;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_revision pricing_revisions%ROWTYPE;
  target_membership_order membership_orders%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  membership_order_count integer;
  identity_match_count integer;
  transfer_count integer;
  transfer_source_total bigint;
  transfer_reversal_total bigint;
  transfer_membership_total bigint;
  direct_membership_total bigint;
  actual_lodging_net bigint;
  conversion_ledger_count integer;
  conversion_ledger_delta bigint;
  expected_nights integer;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
    FROM command_executions
    WHERE id = target_command_id;
  IF execution_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO amendment_count
    FROM amendments WHERE command_id = target_command_id;
  IF execution_state IS DISTINCT FROM 'APPLIED' THEN
    RETURN;
  END IF;

  SELECT * INTO target_amendment
    FROM amendments
    WHERE command_id = target_command_id
      AND amendment_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP';
  IF amendment_count <> 1 OR NOT FOUND THEN
    RAISE EXCEPTION 'stay-to-membership conversion requires exactly one typed amendment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_amendment';
  END IF;
  SELECT * INTO STRICT target_order FROM orders WHERE id = target_amendment.order_id;
  SELECT * INTO STRICT target_stay FROM stays WHERE order_id = target_order.id;
  SELECT * INTO STRICT target_revision FROM pricing_revisions WHERE id = target_order.current_revision_id;
  SELECT count(*)::integer INTO membership_order_count
    FROM membership_orders
    WHERE created_by_command_id = target_command_id
      AND activated_by_command_id = target_command_id;
  SELECT * INTO target_membership_order
    FROM membership_orders
    WHERE created_by_command_id = target_command_id
      AND activated_by_command_id = target_command_id;

  IF execution_property_id IS DISTINCT FROM target_order.property_id
    OR target_order.status IS DISTINCT FROM 'CHECKED_OUT'
    OR target_stay.status IS DISTINCT FROM 'COMPLETED'
    OR target_order.member_id IS NOT NULL
    OR target_order.member_contract_id IS NOT NULL
    OR target_order.booking_channel_code IS DISTINCT FROM 'WECOM'
    OR target_order.current_revision_id IS DISTINCT FROM target_revision.id
    OR target_order.version IS DISTINCT FROM target_amendment.new_version
    OR target_revision.amendment_id IS DISTINCT FROM target_amendment.id
    OR target_revision.current_contract_amount_minor IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'stay-to-membership conversion must leave one completed ordinary lodging order at zero amount'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_order_state';
  END IF;

  IF membership_order_count <> 1
    OR target_membership_order.id IS NULL
    OR target_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_membership_order.contract_id IS NULL
    OR target_membership_order.entitlement_lot_id IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership conversion requires one active membership order created by the same command'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_order';
  END IF;
  SELECT * INTO target_contract
    FROM member_contracts WHERE id = target_membership_order.contract_id;
  SELECT * INTO target_lot
    FROM entitlement_lots WHERE id = target_membership_order.entitlement_lot_id;
  IF target_contract.id IS NULL
    OR target_lot.id IS NULL
    OR target_contract.membership_order_id IS DISTINCT FROM target_membership_order.id
    OR target_contract.member_id IS DISTINCT FROM target_membership_order.member_id
    OR target_contract.property_id IS DISTINCT FROM target_membership_order.property_id
    OR target_lot.contract_id IS DISTINCT FROM target_contract.id
    OR target_lot.unit_kind IS DISTINCT FROM target_membership_order.entitlement_unit_kind
    OR target_lot.total_units IS DISTINCT FROM target_membership_order.entitlement_units THEN
    RAISE EXCEPTION 'stay-to-membership conversion contract and entitlement lot must match the membership order'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_contract_lot';
  END IF;
  SELECT count(*)::integer INTO identity_match_count
    FROM order_occupants AS occupant
    LEFT JOIN LATERAL (
      SELECT corrected_document_number
      FROM order_occupant_corrections
      WHERE occupant_id = occupant.id
      ORDER BY sequence DESC
      LIMIT 1
    ) AS latest ON TRUE
    JOIN members AS member_row
      ON member_row.id = target_membership_order.member_id
    WHERE occupant.order_id = target_order.id
      AND occupant.role = 'PRIMARY'
      AND NULLIF(
        regexp_replace(
          upper(CASE WHEN latest.corrected_document_number IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM order_occupant_corrections AS marker
              WHERE marker.occupant_id = occupant.id
            )
            THEN occupant.document_number
            ELSE latest.corrected_document_number
          END),
          '[[:space:]]+', '', 'g'
        ),
        ''
      ) = regexp_replace(upper(member_row.identity_card_number), '[[:space:]]+', '', 'g');
  IF identity_match_count <> 1 THEN
    RAISE EXCEPTION 'stay-to-membership conversion member identity must match the latest primary guest identity'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_member_identity';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stay_segments AS segment
    JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
    WHERE segment.stay_id = target_stay.id
      AND (unit.kind IS DISTINCT FROM target_membership_order.allowed_inventory_kind
        OR unit.room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code)
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion membership product must match every lodging segment'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_product_match';
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(source.amount_minor), 0)::bigint,
         COALESCE(sum(reversal.amount_minor), 0)::bigint,
         COALESCE(sum(payment.amount_minor), 0)::bigint
    INTO transfer_count, transfer_source_total, transfer_reversal_total, transfer_membership_total
    FROM stay_collection_membership_transfers AS transfer
    JOIN collection_facts AS source
      ON source.fact_id = transfer.source_collection_fact_id
    JOIN collection_facts AS reversal
      ON reversal.fact_id = transfer.source_reversal_fact_id
    JOIN membership_payment_facts AS payment
      ON payment.fact_id = transfer.membership_payment_fact_id
    WHERE transfer.command_id = target_command_id
      AND transfer.order_id = target_order.id
      AND transfer.membership_order_id = target_membership_order.id;
  SELECT COALESCE(sum(amount_minor), 0)::bigint
    INTO direct_membership_total
    FROM membership_payment_facts
    WHERE membership_order_id = target_membership_order.id
      AND source_type = 'DIRECT_WECOM'
      AND fact_type = 'COLLECTION';
  SELECT COALESCE(sum(net_effect_minor), 0)::bigint
    INTO actual_lodging_net
    FROM collection_facts
    WHERE order_id = target_order.id;
  IF EXISTS (
    SELECT 1 FROM stay_collection_membership_transfers AS transfer
    WHERE transfer.membership_order_id = target_membership_order.id
      AND (transfer.command_id IS DISTINCT FROM target_command_id
        OR transfer.order_id IS DISTINCT FROM target_order.id)
  )
    OR EXISTS (
      SELECT 1 FROM membership_payment_facts AS payment
      WHERE payment.membership_order_id = target_membership_order.id
        AND (payment.command_id IS DISTINCT FROM target_command_id
          OR payment.fact_type IS DISTINCT FROM 'COLLECTION'
          OR payment.corrects_fact_id IS NOT NULL
          OR payment.reverses_fact_id IS NOT NULL)
    )
    OR transfer_count < 1
    OR transfer_source_total IS DISTINCT FROM transfer_reversal_total
    OR transfer_source_total IS DISTINCT FROM transfer_membership_total
    OR transfer_source_total + direct_membership_total IS DISTINCT FROM target_membership_order.agreed_price_minor
    OR actual_lodging_net IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'stay-to-membership conversion must conserve lodging and membership funds'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_funds_conserved';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM membership_payment_facts AS direct
    JOIN stay_collection_membership_transfers AS transfer
      ON transfer.membership_order_id = direct.membership_order_id
    JOIN collection_facts AS source
      ON source.order_id = transfer.order_id
    WHERE direct.membership_order_id = target_membership_order.id
      AND direct.source_type = 'DIRECT_WECOM'
      AND direct.fact_type = 'COLLECTION'
      AND source.fact_type = 'COLLECTION'
      AND direct.transaction_reference = source.transaction_reference
  ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion direct payment must use a new transaction reference'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_direct_reference_new';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM stay_collection_membership_transfers AS transfer
    WHERE transfer.order_id = target_order.id
      AND transfer.command_id IS DISTINCT FROM target_command_id
  ) THEN
    RAISE EXCEPTION 'one lodging order can be converted to membership only once'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_one_per_order';
  END IF;

  expected_nights := target_order.departure_date - target_order.arrival_date;
  SELECT count(*)::integer, COALESCE(sum(quantity_delta), 0)::bigint
    INTO conversion_ledger_count, conversion_ledger_delta
    FROM entitlement_ledger
    WHERE command_id = target_command_id
      AND order_id = target_order.id
      AND lot_id = target_membership_order.entitlement_lot_id
      AND entry_type = 'CONVERSION_CONSUME';
  IF conversion_ledger_count IS DISTINCT FROM expected_nights
    OR conversion_ledger_delta IS DISTINCT FROM -expected_nights
    OR target_membership_order.entitlement_units < expected_nights
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS ledger
      WHERE ledger.command_id = target_command_id
        AND ledger.entry_type = 'CONVERSION_CONSUME'
        AND (ledger.order_id IS DISTINCT FROM target_order.id
          OR ledger.lot_id IS DISTINCT FROM target_membership_order.entitlement_lot_id
          OR ledger.quantity_delta IS DISTINCT FROM -1
          OR ledger.coverage_id IS NOT NULL
          OR ledger.service_date < target_order.arrival_date
          OR ledger.service_date >= target_order.departure_date)
    ) THEN
    RAISE EXCEPTION 'stay-to-membership conversion must consume exactly this completed stay once'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_entitlement';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER command_executions_stage13_validate_stay_conversion
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_execution();

CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER transfers_stage13_validate_stay_conversion
AFTER INSERT ON stay_collection_membership_transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child();

CREATE CONSTRAINT TRIGGER collection_facts_stage13_validate_stay_conversion
AFTER INSERT ON collection_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child();

CREATE CONSTRAINT TRIGGER membership_payment_facts_stage13_validate_stay_conversion
AFTER INSERT ON membership_payment_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child();

CREATE CONSTRAINT TRIGGER entitlement_ledger_stage13_validate_stay_conversion
AFTER INSERT ON entitlement_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.entry_type = 'CONVERSION_CONSUME')
EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child();
