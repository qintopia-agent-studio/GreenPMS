-- Member identity rework: identity card becomes optional, phone becomes the
-- unique member identifier, and members gain a required nickname.
-- Stay-to-membership conversion identity guard now matches by phone.

ALTER TABLE members ALTER COLUMN identity_card_number DROP NOT NULL;
ALTER TABLE members DROP CONSTRAINT members_identity_card_number_key;
ALTER TABLE members DROP CONSTRAINT members_identity_card_number_nonblank;
ALTER TABLE members ADD CONSTRAINT members_identity_card_number_nonblank
  CHECK (identity_card_number IS NULL OR identity_card_number !~ '^[[:space:]]*$');

ALTER TABLE members ADD COLUMN nickname text;
UPDATE members SET nickname = full_name WHERE nickname IS NULL;
ALTER TABLE members ALTER COLUMN nickname SET NOT NULL;
ALTER TABLE members ADD CONSTRAINT members_nickname_nonblank
  CHECK (nickname !~ '^[[:space:]]*$');

UPDATE members SET phone = regexp_replace(phone, '[[:space:]]+', '', 'g');
ALTER TABLE members ADD CONSTRAINT members_phone_unique UNIQUE (phone);

CREATE OR REPLACE FUNCTION qintopia_normalize_new_member_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_card_number IS NOT NULL THEN
    NEW.identity_card_number := upper(btrim(NEW.identity_card_number));
  END IF;
  NEW.phone := regexp_replace(NEW.phone, '[[:space:]]+', '', 'g');
  NEW.nickname := btrim(NEW.nickname);
  RETURN NEW;
END;
$$;

DROP TRIGGER members_normalize_new_identity ON members;
CREATE TRIGGER members_normalize_new_identity
BEFORE INSERT OR UPDATE OF identity_card_number, phone, nickname ON members
FOR EACH ROW EXECUTE FUNCTION qintopia_normalize_new_member_identity();

CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command_v033(target_command_id text)
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
      SELECT corrected_phone
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
          CASE WHEN latest.corrected_phone IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM order_occupant_corrections AS marker
              WHERE marker.occupant_id = occupant.id
            )
            THEN occupant.phone
            ELSE latest.corrected_phone
          END,
          '[[:space:]]+', '', 'g'
        ),
        ''
      ) = regexp_replace(member_row.phone, '[[:space:]]+', '', 'g');
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
      SELECT 1
      FROM membership_payment_facts AS payment
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
