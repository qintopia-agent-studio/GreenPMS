LOCK TABLE command_catalog, staff_command_profile_catalog, staff_profile_assignments,
  subject_command_grants, members, membership_orders, membership_payment_facts,
  member_contracts, entitlement_lots, entitlement_ledger, orders, stays,
  collection_facts, stay_collection_membership_transfers, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE command_catalog DROP CONSTRAINT command_catalog_feature_key_check;
ALTER TABLE command_catalog ADD CONSTRAINT command_catalog_feature_key_check CHECK (
  feature_key IS NULL
  OR command_type IN (
    'COMPLETE_CLEANING',
    'CORRECT_HISTORICAL_STAY_ARRANGEMENTS',
    'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
  )
);

INSERT INTO command_catalog(command_type, command_class, feature_key) VALUES
  ('CORRECT_MEMBER_PROFILE', 'HUMAN_COMMAND', NULL),
  ('CORRECT_MEMBERSHIP_EFFECTIVE_DATE', 'HUMAN_COMMAND', NULL),
  ('BACKFILL_HISTORICAL_MEMBERSHIP', 'HUMAN_COMMAND', NULL),
  ('VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY', 'HUMAN_COMMAND', NULL)
ON CONFLICT (command_type) DO UPDATE SET
  command_class = EXCLUDED.command_class,
  feature_key = EXCLUDED.feature_key;

ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check CHECK (command_type IN (
  'CREATE_MEMBER',
  'CREATE_MEMBERSHIP_ORDER',
  'RECORD_MEMBERSHIP_PAYMENT',
  'CORRECT_MEMBERSHIP_PAYMENT',
  'ACTIVATE_MEMBERSHIP_ORDER',
  'CREATE_ORDER',
  'CORRECT_ORDER_OCCUPANT',
  'CORRECT_HISTORICAL_STAY_ARRANGEMENTS',
  'CORRECT_MEMBER_PROFILE',
  'CORRECT_MEMBERSHIP_EFFECTIVE_DATE',
  'BACKFILL_HISTORICAL_MEMBERSHIP',
  'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY',
  'RESCHEDULE_STAY',
  'EXTEND_STAY',
  'SHORTEN_STAY',
  'MOVE_UNIT',
  'REPRICE_ORDER',
  'CANCEL_ORDER',
  'MARK_NO_SHOW',
  'REVOKE_CHECK_IN',
  'LOCK_MAINTENANCE',
  'RELEASE_MAINTENANCE',
  'COMPLETE_CLEANING',
  'RECORD_COLLECTION',
  'RECORD_REFUND',
  'REVERSE_FACT',
  'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
  'CHECK_IN',
  'CHECK_OUT',
  'COMPLETE_STAY',
  'CORRECT_MEMBER_ENTITLEMENT_BALANCE',
  'ISSUE_TOKEN',
  'ROTATE_TOKEN',
  'REVOKE_TOKEN',
  'PLACE_INTERNAL_USE',
  'RELEASE_INTERNAL_USE',
  'BACKFILL_COMPLETED_STAY'
));

INSERT INTO staff_command_profile_catalog(profile, command_type, token_default) VALUES
  ('ADMIN', 'CORRECT_MEMBER_PROFILE', true),
  ('ADMIN', 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE', true),
  ('ADMIN', 'BACKFILL_HISTORICAL_MEMBERSHIP', true),
  ('ADMIN', 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY', true)
ON CONFLICT (profile, command_type) DO UPDATE SET token_default = EXCLUDED.token_default;

INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT assignment.subject_id, assignment.property_id, profile_command.command_type
FROM staff_profile_assignments AS assignment
JOIN staff_command_profile_catalog AS profile_command
  ON profile_command.profile = assignment.profile
WHERE assignment.profile = 'ADMIN'
  AND profile_command.command_type IN (
    'CORRECT_MEMBER_PROFILE',
    'CORRECT_MEMBERSHIP_EFFECTIVE_DATE',
    'BACKFILL_HISTORICAL_MEMBERSHIP',
    'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
  )
ON CONFLICT DO NOTHING;

UPDATE staff_profile_reconciliation_state
SET projection_hash = (
    SELECT encode(
      sha256(convert_to(COALESCE(string_agg(projection.row_value, E'\n' ORDER BY projection.row_value), ''), 'UTF8')),
      'hex'
    )
    FROM (
      SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value
      FROM staff_profile_assignments
      UNION ALL
      SELECT format('G|%s|%s|%s', subject_id, property_id, command_type)
      FROM subject_command_grants
    ) AS projection
  ),
  reconciled_by = current_user,
  reconciled_at = now()
WHERE singleton;

DO $$
DECLARE
  function_definition text;
  old_fragment text := $fragment$
      'RELEASE_MAINTENANCE', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS'
$fragment$;
  new_fragment text := $fragment$
      'RELEASE_MAINTENANCE', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
$fragment$;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
    INTO STRICT function_definition;
  IF position(old_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 050 could not locate the runtime room-status command allowlist';
  END IF;
  EXECUTE replace(function_definition, old_fragment, new_fragment);
  IF position(
      new_fragment
      IN pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
    ) = 0 THEN
    RAISE EXCEPTION 'migration 050 did not add the membership void reconversion room-status command';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_coverage_lifecycle_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hold_count integer;
  release_count integer;
  consume_count integer;
  restore_count integer;
  conversion_consume_count integer;
  current_status text;
BEGIN
  SELECT status INTO current_status
    FROM coverage_items
    WHERE id = NEW.id;
  SELECT count(*) FILTER (WHERE entry_type = 'HOLD')::integer,
         count(*) FILTER (WHERE entry_type = 'RELEASE')::integer,
         count(*) FILTER (WHERE entry_type = 'CONSUME')::integer,
         count(*) FILTER (WHERE entry_type = 'RESTORE')::integer,
         count(*) FILTER (WHERE entry_type = 'CONVERSION_CONSUME')::integer
    INTO hold_count, release_count, consume_count, restore_count, conversion_consume_count
    FROM entitlement_ledger
    WHERE coverage_id = NEW.id;

  IF NOT (
    (current_status = 'HELD'
      AND hold_count = 1 AND release_count = 0 AND consume_count = 0
      AND restore_count = 0 AND conversion_consume_count = 0)
    OR (current_status = 'CONSUMED' AND (
      (hold_count = 1 AND release_count = 0 AND consume_count = 1
        AND restore_count = 0 AND conversion_consume_count = 0)
      OR (hold_count = 1 AND release_count = 0 AND consume_count = 1
        AND restore_count = 1 AND conversion_consume_count = 0)
      OR (hold_count = 0 AND release_count = 0 AND consume_count = 0
        AND restore_count = 0 AND conversion_consume_count = 1)
    ))
    OR (current_status = 'RELEASED' AND (
      (hold_count = 1 AND release_count = 1 AND consume_count = 0
        AND restore_count = 0 AND conversion_consume_count = 0)
      OR (hold_count = 1 AND release_count = 0 AND consume_count = 1
        AND restore_count = 1 AND conversion_consume_count = 0)
      OR (hold_count = 0 AND release_count = 0 AND consume_count = 0
        AND restore_count = 1 AND conversion_consume_count = 1)
    ))
  ) THEN
    RAISE EXCEPTION 'coverage status and entitlement lifecycle facts must remain conserved'
      USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_lifecycle_conserved';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE membership_orders DROP CONSTRAINT membership_orders_status_check;
ALTER TABLE membership_orders ADD CONSTRAINT membership_orders_status_check
  CHECK (status IN ('DRAFT', 'ACTIVE', 'VOIDED'));

DO $$
DECLARE
  target_constraint record;
BEGIN
  FOR target_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'membership_orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status = %DRAFT%'
      AND pg_get_constraintdef(oid) LIKE '%activated_at%'
  LOOP
    EXECUTE format('ALTER TABLE membership_orders DROP CONSTRAINT %I', target_constraint.conname);
  END LOOP;
END;
$$;

ALTER TABLE membership_orders ADD CONSTRAINT membership_orders_lifecycle_state_check CHECK (
  (status = 'DRAFT'
    AND activated_at IS NULL
    AND valid_from IS NULL
    AND valid_until IS NULL
    AND contract_id IS NULL
    AND entitlement_lot_id IS NULL
    AND activated_by_command_id IS NULL)
  OR
  (status IN ('ACTIVE', 'VOIDED')
    AND activated_at IS NOT NULL
    AND valid_from IS NOT NULL
    AND valid_until IS NOT NULL
    AND contract_id IS NOT NULL
    AND entitlement_lot_id IS NOT NULL
    AND activated_by_command_id IS NOT NULL)
);

ALTER TABLE member_contracts DROP CONSTRAINT member_contracts_status_check;
ALTER TABLE member_contracts ADD CONSTRAINT member_contracts_status_check
  CHECK (status IN ('ACTIVE', 'EXPIRED', 'VOIDED'));

ALTER TABLE entitlement_lots
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD CONSTRAINT entitlement_lots_status_check CHECK (status IN ('ACTIVE', 'VOIDED'));

ALTER TABLE entitlement_ledger DROP CONSTRAINT entitlement_ledger_entry_type_check;
ALTER TABLE entitlement_ledger ADD CONSTRAINT entitlement_ledger_entry_type_check CHECK (
  entry_type IN ('ADJUST','HOLD','RELEASE','CONSUME','RESTORE','EXPIRE','CONVERSION_CONSUME','VOID')
);

DROP TRIGGER membership_payment_facts_append_only ON membership_payment_facts;
ALTER TABLE membership_payment_facts ADD COLUMN business_date date;
UPDATE membership_payment_facts AS payment
SET business_date = (payment.created_at AT TIME ZONE property_row.timezone)::date
FROM membership_orders AS membership_order
JOIN properties AS property_row ON property_row.id = membership_order.property_id
WHERE membership_order.id = payment.membership_order_id;
ALTER TABLE membership_payment_facts
  ALTER COLUMN business_date SET NOT NULL;
CREATE TRIGGER membership_payment_facts_append_only
BEFORE UPDATE OR DELETE ON membership_payment_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE INDEX collection_facts_transaction_reference_lookup_idx
  ON collection_facts ((regexp_replace(
    btrim(transaction_reference),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  )))
  WHERE transaction_reference IS NOT NULL;

CREATE INDEX membership_payment_facts_transaction_reference_lookup_idx
  ON membership_payment_facts ((regexp_replace(
    btrim(transaction_reference),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  )))
  WHERE transaction_reference IS NOT NULL;

CREATE TABLE admin_membership_payment_evidence_claims (
  normalized_reference text PRIMARY KEY,
  membership_payment_fact_id text NOT NULL UNIQUE
    REFERENCES membership_payment_facts(fact_id) DEFERRABLE INITIALLY DEFERRED,
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  correction_type text NOT NULL CHECK (correction_type IN (
    'BACKFILL_HISTORICAL_MEMBERSHIP',
    'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
  )),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT admin_membership_payment_evidence_claims_reference_trimmed CHECK (
    NULLIF(regexp_replace(
      btrim(normalized_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ), '') IS NOT NULL
    AND normalized_reference = regexp_replace(
      btrim(normalized_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    )
  )
);

CREATE OR REPLACE FUNCTION qintopia_guard_admin_membership_payment_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_reference text;
  claimed_fact_id text;
  claimed_command_id text;
BEGIN
  target_reference := NULLIF(regexp_replace(
    btrim(NEW.transaction_reference),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  ), '');
  IF target_reference IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'qintopia:membership-transaction:' || target_reference,
    0::bigint
  ));

  SELECT claim.membership_payment_fact_id, claim.command_id
    INTO claimed_fact_id, claimed_command_id
  FROM admin_membership_payment_evidence_claims AS claim
  WHERE claim.normalized_reference = target_reference;

  IF claimed_fact_id IS NOT NULL
    AND (
      TG_TABLE_NAME IS DISTINCT FROM 'membership_payment_facts'
      OR NEW.fact_id IS DISTINCT FROM claimed_fact_id
      OR NEW.command_id IS DISTINCT FROM claimed_command_id
    ) THEN
    RAISE EXCEPTION 'transaction reference is reserved as administrator correction evidence: %',
        target_reference
      USING ERRCODE = '23505',
        CONSTRAINT = 'admin_membership_payment_evidence_claims_pkey';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_admin_membership_payment_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_admin_membership_payment_evidence() FROM qintopia_runtime;

CREATE TRIGGER collection_facts_guard_admin_membership_payment_evidence
BEFORE INSERT ON collection_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_admin_membership_payment_evidence();

CREATE TRIGGER membership_payment_facts_guard_admin_membership_payment_evidence
BEFORE INSERT ON membership_payment_facts
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_admin_membership_payment_evidence();

CREATE TRIGGER admin_membership_payment_evidence_claims_append_only
BEFORE UPDATE OR DELETE ON admin_membership_payment_evidence_claims
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

REVOKE ALL ON admin_membership_payment_evidence_claims FROM PUBLIC;
REVOKE ALL ON admin_membership_payment_evidence_claims FROM qintopia_runtime;

CREATE TABLE member_profile_corrections (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_id text NOT NULL REFERENCES members(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  prior_full_name text NOT NULL,
  prior_nickname text NOT NULL,
  prior_identity_card_number text,
  prior_phone text NOT NULL,
  prior_wechat text NOT NULL,
  corrected_full_name text NOT NULL,
  corrected_nickname text NOT NULL,
  corrected_identity_card_number text,
  corrected_phone text NOT NULL,
  corrected_wechat text NOT NULL,
  changed_fields text[] NOT NULL,
  evidence_note text NOT NULL CHECK (NULLIF(btrim(evidence_note), '') IS NOT NULL),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, sequence),
  FOREIGN KEY (member_id, property_id) REFERENCES member_property_links(member_id, property_id),
  CHECK (cardinality(changed_fields) BETWEEN 1 AND 5),
  CHECK (changed_fields <@ ARRAY['fullName','nickname','identityCardNumber','phone','wechat']::text[])
);

CREATE TABLE membership_effective_date_corrections (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_id text NOT NULL REFERENCES members(id),
  membership_order_id text NOT NULL REFERENCES membership_orders(id),
  contract_id text NOT NULL REFERENCES member_contracts(id),
  entitlement_lot_id text NOT NULL REFERENCES entitlement_lots(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  prior_valid_from date NOT NULL,
  prior_valid_until date NOT NULL,
  corrected_valid_from date NOT NULL,
  corrected_valid_until date NOT NULL,
  prior_order_version integer NOT NULL CHECK (prior_order_version > 0),
  prior_contract_version integer NOT NULL CHECK (prior_contract_version > 0),
  prior_lot_version integer NOT NULL CHECK (prior_lot_version > 0),
  evidence_note text NOT NULL CHECK (NULLIF(btrim(evidence_note), '') IS NOT NULL),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_order_id, sequence),
  CHECK (corrected_valid_until >= corrected_valid_from),
  CHECK ((prior_valid_from, prior_valid_until) IS DISTINCT FROM (corrected_valid_from, corrected_valid_until))
);

CREATE TABLE historical_membership_backfills (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_id text NOT NULL REFERENCES members(id),
  membership_order_id text NOT NULL UNIQUE REFERENCES membership_orders(id),
  contract_id text NOT NULL UNIQUE REFERENCES member_contracts(id),
  entitlement_lot_id text NOT NULL UNIQUE REFERENCES entitlement_lots(id),
  payment_fact_id text NOT NULL UNIQUE REFERENCES membership_payment_facts(fact_id),
  product_id text NOT NULL REFERENCES membership_products(id),
  product_code text NOT NULL,
  product_version integer NOT NULL CHECK (product_version > 0),
  product_name text NOT NULL,
  listed_price_minor integer NOT NULL CHECK (
    listed_price_minor >= 0 AND listed_price_minor % 100 = 0
  ),
  agreed_price_minor integer NOT NULL CHECK (
    agreed_price_minor >= 0 AND agreed_price_minor % 100 = 0
  ),
  currency char(3) NOT NULL,
  entitlement_unit_kind text NOT NULL CHECK (
    entitlement_unit_kind IN ('ROOM_NIGHT', 'BED_NIGHT')
  ),
  entitlement_units integer NOT NULL CHECK (entitlement_units > 0),
  validity_period text NOT NULL CHECK (validity_period = 'P1Y'),
  allowed_room_type_code text NOT NULL,
  allowed_inventory_kind text NOT NULL CHECK (
    allowed_inventory_kind IN ('ROOM', 'BED')
  ),
  actual_membership_date date NOT NULL,
  valid_until date NOT NULL,
  business_date date NOT NULL,
  transaction_reference text NOT NULL,
  evidence_note text NOT NULL CHECK (NULLIF(btrim(evidence_note), '') IS NOT NULL),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (member_id, property_id)
    REFERENCES member_property_links(member_id, property_id),
  CHECK (valid_until >= actual_membership_date),
  CHECK (NULLIF(regexp_replace(
      btrim(transaction_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ), '') IS NOT NULL
    AND transaction_reference = regexp_replace(
      btrim(transaction_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ))
);

CREATE TABLE membership_payment_reclassifications (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_id text NOT NULL REFERENCES members(id),
  old_membership_order_id text NOT NULL REFERENCES membership_orders(id),
  old_payment_fact_id text NOT NULL UNIQUE REFERENCES membership_payment_facts(fact_id),
  old_reversal_fact_id text NOT NULL UNIQUE REFERENCES membership_payment_facts(fact_id),
  new_membership_order_id text NOT NULL REFERENCES membership_orders(id),
  new_payment_fact_id text REFERENCES membership_payment_facts(fact_id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  evidence_note text NOT NULL CHECK (NULLIF(btrim(evidence_note), '') IS NOT NULL),
  command_id text NOT NULL REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (command_id, old_payment_fact_id)
);

CREATE TABLE membership_void_reconversions (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  member_id text NOT NULL REFERENCES members(id),
  old_membership_order_id text NOT NULL UNIQUE REFERENCES membership_orders(id) DEFERRABLE INITIALLY DEFERRED,
  old_contract_id text NOT NULL UNIQUE REFERENCES member_contracts(id) DEFERRABLE INITIALLY DEFERRED,
  old_entitlement_lot_id text NOT NULL UNIQUE REFERENCES entitlement_lots(id) DEFERRABLE INITIALLY DEFERRED,
  prior_old_order_version integer NOT NULL CHECK (prior_old_order_version > 0),
  prior_old_contract_version integer NOT NULL CHECK (prior_old_contract_version > 0),
  prior_old_lot_version integer NOT NULL CHECK (prior_old_lot_version > 0),
  source_order_id text NOT NULL UNIQUE REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED,
  source_stay_id text NOT NULL UNIQUE REFERENCES stays(id) DEFERRABLE INITIALLY DEFERRED,
  prior_source_order_version integer NOT NULL CHECK (prior_source_order_version > 0),
  new_membership_order_id text NOT NULL UNIQUE REFERENCES membership_orders(id) DEFERRABLE INITIALLY DEFERRED,
  new_contract_id text NOT NULL UNIQUE REFERENCES member_contracts(id) DEFERRABLE INITIALLY DEFERRED,
  new_entitlement_lot_id text NOT NULL UNIQUE REFERENCES entitlement_lots(id) DEFERRABLE INITIALLY DEFERRED,
  replacement_payment_fact_id text REFERENCES membership_payment_facts(fact_id) DEFERRABLE INITIALLY DEFERRED,
  replacement_business_date date,
  replacement_transaction_reference text,
  actual_membership_date date NOT NULL,
  valid_until date NOT NULL,
  old_direct_collection_total_minor integer NOT NULL CHECK (old_direct_collection_total_minor >= 0),
  stay_transfer_total_minor integer NOT NULL CHECK (stay_transfer_total_minor > 0),
  membership_agreed_price_minor integer NOT NULL CHECK (membership_agreed_price_minor > 0),
  service_dates date[] NOT NULL CHECK (cardinality(service_dates) > 0),
  evidence_note text NOT NULL CHECK (NULLIF(btrim(evidence_note), '') IS NOT NULL),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (member_id, property_id)
    REFERENCES member_property_links(member_id, property_id),
  CHECK (valid_until >= actual_membership_date),
  CHECK (stay_transfer_total_minor <= membership_agreed_price_minor),
  CHECK (
    (replacement_payment_fact_id IS NULL
      AND replacement_business_date IS NULL
      AND replacement_transaction_reference IS NULL)
    OR
    (replacement_payment_fact_id IS NOT NULL
      AND replacement_business_date IS NOT NULL
      AND replacement_transaction_reference IS NOT NULL)
  ),
  CHECK (replacement_transaction_reference IS NULL
    OR (NULLIF(regexp_replace(
        btrim(replacement_transaction_reference),
        '^[[:space:]]+|[[:space:]]+$',
        '',
        'g'
      ), '') IS NOT NULL
      AND replacement_transaction_reference = regexp_replace(
        btrim(replacement_transaction_reference),
        '^[[:space:]]+|[[:space:]]+$',
        '',
        'g'
      )))
);

ALTER TABLE membership_payment_reclassifications
  ADD CONSTRAINT membership_payment_reclassifications_void_command_fk
  FOREIGN KEY (command_id) REFERENCES membership_void_reconversions(command_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX member_profile_corrections_member_idx
  ON member_profile_corrections(member_id, sequence);
CREATE INDEX membership_effective_date_corrections_member_idx
  ON membership_effective_date_corrections(member_id, created_at, id);
CREATE INDEX historical_membership_backfills_member_idx
  ON historical_membership_backfills(member_id, created_at, id);
CREATE INDEX membership_payment_reclassifications_member_idx
  ON membership_payment_reclassifications(member_id, created_at, id);
CREATE INDEX membership_void_reconversions_member_idx
  ON membership_void_reconversions(member_id, created_at, id);

CREATE OR REPLACE FUNCTION qintopia_lock_historical_membership_backfill()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF NOT EXISTS (
      SELECT 1
      FROM member_property_links
      WHERE member_id = NEW.member_id
        AND property_id = NEW.property_id
        AND xmin IS DISTINCT FROM current_xid
    ) THEN
    RAISE EXCEPTION 'admin membership correction requires a pre-existing member property link'
      USING ERRCODE = '23514',
        CONSTRAINT = 'admin_membership_correction_member_property_link_preexisting';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'qintopia:member-entitlements:' || NEW.member_id,
    0::bigint
  ));

  PERFORM member_row.id
  FROM members AS member_row
  WHERE member_row.id = NEW.member_id
  FOR UPDATE OF member_row;

  PERFORM membership_order.id
  FROM membership_orders AS membership_order
  WHERE membership_order.property_id = NEW.property_id
    AND membership_order.member_id = NEW.member_id
    AND membership_order.status <> 'VOIDED'
  ORDER BY membership_order.id
  FOR UPDATE OF membership_order;

  PERFORM contract.id
  FROM member_contracts AS contract
  WHERE contract.property_id = NEW.property_id
    AND contract.member_id = NEW.member_id
    AND contract.status = 'ACTIVE'
  ORDER BY contract.id
  FOR UPDATE OF contract;

  PERFORM lot.id
  FROM entitlement_lots AS lot
  JOIN member_contracts AS contract ON contract.id = lot.contract_id
  WHERE contract.property_id = NEW.property_id
    AND contract.member_id = NEW.member_id
    AND lot.status = 'ACTIVE'
  ORDER BY lot.id
  FOR UPDATE OF lot;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_lock_membership_void_reconversion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF NOT EXISTS (
      SELECT 1
      FROM member_property_links
      WHERE member_id = NEW.member_id
        AND property_id = NEW.property_id
        AND xmin IS DISTINCT FROM current_xid
    ) THEN
    RAISE EXCEPTION 'admin membership correction requires a pre-existing member property link'
      USING ERRCODE = '23514',
        CONSTRAINT = 'admin_membership_correction_member_property_link_preexisting';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'qintopia:member-entitlements:' || NEW.member_id,
    0::bigint
  ));

  PERFORM member_row.id
  FROM members AS member_row
  WHERE member_row.id = NEW.member_id
  FOR UPDATE OF member_row;

  PERFORM membership_order.id
  FROM membership_orders AS membership_order
  WHERE membership_order.property_id = NEW.property_id
    AND membership_order.member_id = NEW.member_id
    AND membership_order.status = 'ACTIVE'
  ORDER BY membership_order.id
  FOR UPDATE OF membership_order;

  PERFORM contract.id
  FROM member_contracts AS contract
  WHERE contract.property_id = NEW.property_id
    AND contract.member_id = NEW.member_id
    AND contract.status = 'ACTIVE'
  ORDER BY contract.id
  FOR UPDATE OF contract;

  PERFORM lot.id
  FROM entitlement_lots AS lot
  JOIN member_contracts AS contract ON contract.id = lot.contract_id
  WHERE contract.property_id = NEW.property_id
    AND contract.member_id = NEW.member_id
    AND lot.status = 'ACTIVE'
  ORDER BY lot.id
  FOR UPDATE OF lot;

  RETURN NEW;
END;
$$;

CREATE TRIGGER historical_membership_backfills_serialize
BEFORE INSERT ON historical_membership_backfills
FOR EACH ROW EXECUTE FUNCTION qintopia_lock_historical_membership_backfill();

CREATE TRIGGER membership_void_reconversions_serialize
BEFORE INSERT ON membership_void_reconversions
FOR EACH ROW EXECUTE FUNCTION qintopia_lock_membership_void_reconversion();

CREATE OR REPLACE FUNCTION qintopia_claim_admin_membership_payment_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_reference text;
  target_payment_fact_id text;
  target_command_id text;
  target_property_id text;
  target_correction_type text;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF TG_TABLE_NAME = 'historical_membership_backfills' THEN
    target_reference := NULLIF(regexp_replace(
      btrim(NEW.transaction_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ), '');
    target_payment_fact_id := NEW.payment_fact_id;
    target_command_id := NEW.command_id;
    target_property_id := NEW.property_id;
    target_correction_type := 'BACKFILL_HISTORICAL_MEMBERSHIP';
  ELSIF TG_TABLE_NAME = 'membership_void_reconversions' THEN
    target_reference := NULLIF(regexp_replace(
      btrim(NEW.replacement_transaction_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ), '');
    IF target_reference IS NULL THEN
      RETURN NEW;
    END IF;
    target_payment_fact_id := NEW.replacement_payment_fact_id;
    target_command_id := NEW.command_id;
    target_property_id := NEW.property_id;
    target_correction_type := 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY';
  ELSE
    RAISE EXCEPTION 'unsupported administrator correction evidence source: %', TG_TABLE_NAME
      USING ERRCODE = '23514',
        CONSTRAINT = 'admin_membership_payment_evidence_claim_source';
  END IF;

  IF target_reference IS NULL
    OR target_payment_fact_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM command_executions AS execution
      WHERE execution.id = target_command_id
        AND execution.command_type = target_correction_type
        AND execution.property_id = target_property_id
        AND execution.state = 'EXECUTING'
        AND execution.xmin = current_xid
    ) THEN
    RAISE EXCEPTION 'administrator correction payment evidence has an invalid command owner'
      USING ERRCODE = '23514',
        CONSTRAINT = 'admin_membership_payment_evidence_claim_command';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'qintopia:membership-transaction:' || target_reference,
    0::bigint
  ));

  IF EXISTS (
      SELECT 1
      FROM collection_facts AS fact
      WHERE fact.transaction_reference IS NOT NULL
        AND regexp_replace(
          btrim(fact.transaction_reference),
          '^[[:space:]]+|[[:space:]]+$',
          '',
          'g'
        ) = target_reference
    )
    OR EXISTS (
      SELECT 1
      FROM membership_payment_facts AS fact
      WHERE fact.transaction_reference IS NOT NULL
        AND regexp_replace(
          btrim(fact.transaction_reference),
          '^[[:space:]]+|[[:space:]]+$',
          '',
          'g'
        ) = target_reference
        AND fact.fact_id <> target_payment_fact_id
    )
    OR EXISTS (
      SELECT 1
      FROM membership_payment_facts AS fact
      WHERE fact.fact_id = target_payment_fact_id
        AND (
          regexp_replace(
            btrim(fact.transaction_reference),
            '^[[:space:]]+|[[:space:]]+$',
            '',
            'g'
          ) IS DISTINCT FROM target_reference
          OR fact.command_id IS DISTINCT FROM target_command_id
        )
    ) THEN
    RAISE EXCEPTION 'administrator correction payment evidence was already used: %',
        target_reference
      USING ERRCODE = '23505',
        CONSTRAINT = 'admin_membership_payment_evidence_claims_pkey';
  END IF;

  INSERT INTO admin_membership_payment_evidence_claims (
    normalized_reference,
    membership_payment_fact_id,
    command_id,
    correction_type
  ) VALUES (
    target_reference,
    target_payment_fact_id,
    target_command_id,
    target_correction_type
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_claim_admin_membership_payment_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_claim_admin_membership_payment_evidence() FROM qintopia_runtime;

CREATE TRIGGER historical_membership_backfills_claim_payment_evidence
AFTER INSERT ON historical_membership_backfills
FOR EACH ROW EXECUTE FUNCTION qintopia_claim_admin_membership_payment_evidence();

CREATE TRIGGER membership_void_reconversions_claim_payment_evidence
AFTER INSERT ON membership_void_reconversions
FOR EACH ROW EXECUTE FUNCTION qintopia_claim_admin_membership_payment_evidence();

-- Root graph validators run as qintopia_runtime, but this private claim table must
-- remain owner-only. Keep the elevated boundary trigger-only and return no claim data.
CREATE OR REPLACE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
  expected_claim_count integer;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'member_profile_corrections', 'membership_effective_date_corrections' THEN
      IF EXISTS (
        SELECT 1
        FROM admin_membership_payment_evidence_claims
        WHERE xmin = current_xid
      ) THEN
        RAISE EXCEPTION 'membership correction must not create payment evidence claims'
          USING ERRCODE = '23514',
            CONSTRAINT = 'admin_membership_payment_evidence_scope';
      END IF;
    WHEN 'historical_membership_backfills' THEN
      IF (SELECT count(*) FROM admin_membership_payment_evidence_claims WHERE xmin = current_xid) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM admin_membership_payment_evidence_claims
          WHERE normalized_reference = NEW.transaction_reference
            AND membership_payment_fact_id = NEW.payment_fact_id
            AND command_id = NEW.command_id
            AND correction_type = 'BACKFILL_HISTORICAL_MEMBERSHIP'
            AND created_at = transaction_timestamp()
            AND xmin = current_xid
        ) THEN
        RAISE EXCEPTION 'historical membership backfill must own one exact payment evidence claim'
          USING ERRCODE = '23514',
            CONSTRAINT = 'historical_membership_backfill_payment_evidence_scope';
      END IF;
    WHEN 'membership_void_reconversions' THEN
      expected_claim_count := CASE
        WHEN NEW.membership_agreed_price_minor > NEW.stay_transfer_total_minor THEN 1
        ELSE 0
      END;
      IF (SELECT count(*) FROM admin_membership_payment_evidence_claims WHERE xmin = current_xid)
          <> expected_claim_count
        OR (expected_claim_count = 1 AND NOT EXISTS (
          SELECT 1
          FROM admin_membership_payment_evidence_claims
          WHERE normalized_reference = NEW.replacement_transaction_reference
            AND membership_payment_fact_id = NEW.replacement_payment_fact_id
            AND command_id = NEW.command_id
            AND correction_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
            AND created_at = transaction_timestamp()
            AND xmin = current_xid
        )) THEN
        RAISE EXCEPTION 'membership void reconversion must own its exact payment evidence claim'
          USING ERRCODE = '23514',
            CONSTRAINT = 'membership_void_reconversion_payment_evidence_scope';
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported administrator correction evidence validator source: %', TG_TABLE_NAME
        USING ERRCODE = '23514',
          CONSTRAINT = 'admin_membership_payment_evidence_scope_source';
  END CASE;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_validate_admin_membership_payment_evidence_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_validate_admin_membership_payment_evidence_scope() FROM qintopia_runtime;

CREATE CONSTRAINT TRIGGER member_profile_corrections_validate_payment_evidence_scope
AFTER INSERT ON member_profile_corrections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope();
CREATE CONSTRAINT TRIGGER membership_effective_date_validate_payment_evidence_scope
AFTER INSERT ON membership_effective_date_corrections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope();
CREATE CONSTRAINT TRIGGER historical_membership_backfills_validate_payment_evidence_scope
AFTER INSERT ON historical_membership_backfills
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope();
CREATE CONSTRAINT TRIGGER membership_void_reconversions_validate_payment_evidence_scope
AFTER INSERT ON membership_void_reconversions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_payment_evidence_scope();

CREATE TRIGGER member_profile_corrections_append_only
BEFORE UPDATE OR DELETE ON member_profile_corrections
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER membership_effective_date_corrections_append_only
BEFORE UPDATE OR DELETE ON membership_effective_date_corrections
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER historical_membership_backfills_append_only
BEFORE UPDATE OR DELETE ON historical_membership_backfills
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER membership_payment_reclassifications_append_only
BEFORE UPDATE OR DELETE ON membership_payment_reclassifications
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE TRIGGER membership_void_reconversions_append_only
BEFORE UPDATE OR DELETE ON membership_void_reconversions
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

GRANT SELECT ON
  member_profile_corrections,
  membership_effective_date_corrections,
  historical_membership_backfills,
  membership_payment_reclassifications,
  membership_void_reconversions
TO qintopia_runtime;

GRANT INSERT ON
  member_profile_corrections,
  membership_effective_date_corrections,
  historical_membership_backfills,
  membership_payment_reclassifications,
  membership_void_reconversions
TO qintopia_runtime;

GRANT UPDATE (full_name, nickname, identity_card_number, phone, wechat) ON members TO qintopia_runtime;
GRANT UPDATE (status, valid_from, valid_until, version) ON member_contracts TO qintopia_runtime;
GRANT UPDATE (status, expires_on, version) ON entitlement_lots TO qintopia_runtime;
GRANT UPDATE (created_at) ON membership_payment_facts TO qintopia_runtime;
GRANT UPDATE (created_at) ON stay_collection_membership_transfers TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_protect_member_identity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'member identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW IS DISTINCT FROM OLD
    AND NOT EXISTS (
      SELECT 1
      FROM member_profile_corrections AS correction
      JOIN command_executions AS execution ON execution.id = correction.command_id
      WHERE correction.member_id = OLD.id
        AND correction.xmin = current_xid
        AND execution.xmin = current_xid
        AND execution.command_type = 'CORRECT_MEMBER_PROFILE'
        AND execution.state = 'EXECUTING'
        AND execution.property_id = correction.property_id
        AND correction.prior_full_name = OLD.full_name
        AND correction.prior_nickname = OLD.nickname
        AND correction.prior_identity_card_number IS NOT DISTINCT FROM OLD.identity_card_number
        AND correction.prior_phone = OLD.phone
        AND correction.prior_wechat = OLD.wechat
        AND correction.corrected_full_name = NEW.full_name
        AND correction.corrected_nickname = NEW.nickname
        AND correction.corrected_identity_card_number IS NOT DISTINCT FROM NEW.identity_card_number
        AND correction.corrected_phone = NEW.phone
        AND correction.corrected_wechat = NEW.wechat
    ) THEN
    RAISE EXCEPTION 'member profile changes require an exact append-only correction'
      USING ERRCODE = '55000', CONSTRAINT = 'members_profile_correction_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_protect_membership_order_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.product_code IS DISTINCT FROM OLD.product_code
    OR NEW.product_version IS DISTINCT FROM OLD.product_version
    OR NEW.product_name IS DISTINCT FROM OLD.product_name
    OR NEW.listed_price_minor IS DISTINCT FROM OLD.listed_price_minor
    OR NEW.agreed_price_minor IS DISTINCT FROM OLD.agreed_price_minor
    OR NEW.price_adjustment_minor IS DISTINCT FROM OLD.price_adjustment_minor
    OR NEW.price_adjustment_reason IS DISTINCT FROM OLD.price_adjustment_reason
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.entitlement_unit_kind IS DISTINCT FROM OLD.entitlement_unit_kind
    OR NEW.entitlement_units IS DISTINCT FROM OLD.entitlement_units
    OR NEW.allowed_room_type_code IS DISTINCT FROM OLD.allowed_room_type_code
    OR NEW.allowed_inventory_kind IS DISTINCT FROM OLD.allowed_inventory_kind
    OR NEW.created_by_command_id IS DISTINCT FROM OLD.created_by_command_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'membership order ownership, product, and price snapshot are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_identity_immutable';
  END IF;

  IF OLD.status = 'VOIDED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'voided membership orders are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_voided_immutable';
  END IF;

  IF OLD.status = 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
    IF EXISTS (
      SELECT 1
      FROM membership_effective_date_corrections AS correction
      JOIN command_executions AS execution ON execution.id = correction.command_id
      WHERE correction.membership_order_id = OLD.id
        AND correction.xmin = current_xid
        AND execution.xmin = current_xid
        AND execution.command_type = 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE'
        AND execution.state = 'EXECUTING'
        AND correction.prior_valid_from = OLD.valid_from
        AND correction.prior_valid_until = OLD.valid_until
        AND correction.corrected_valid_from = NEW.valid_from
        AND correction.corrected_valid_until = NEW.valid_until
        AND correction.prior_order_version = OLD.version
        AND NEW.status = 'ACTIVE'
        AND NEW.version = OLD.version + 1
        AND NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at
        AND NEW.contract_id IS NOT DISTINCT FROM OLD.contract_id
        AND NEW.entitlement_lot_id IS NOT DISTINCT FROM OLD.entitlement_lot_id
        AND NEW.activated_by_command_id IS NOT DISTINCT FROM OLD.activated_by_command_id
    ) THEN
      RETURN NEW;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM membership_void_reconversions AS correction
      JOIN command_executions AS execution ON execution.id = correction.command_id
      WHERE correction.old_membership_order_id = OLD.id
        AND correction.xmin = current_xid
        AND correction.prior_old_order_version = OLD.version
        AND execution.xmin = current_xid
        AND execution.command_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
        AND execution.state = 'EXECUTING'
        AND NEW.status = 'VOIDED'
        AND NEW.version = OLD.version + 1
        AND NEW.valid_from IS NOT DISTINCT FROM OLD.valid_from
        AND NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until
        AND NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at
        AND NEW.contract_id IS NOT DISTINCT FROM OLD.contract_id
        AND NEW.entitlement_lot_id IS NOT DISTINCT FROM OLD.entitlement_lot_id
        AND NEW.activated_by_command_id IS NOT DISTINCT FROM OLD.activated_by_command_id
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'active membership orders only allow typed date correction or void transition'
      USING ERRCODE = '55000', CONSTRAINT = 'membership_orders_active_correction_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_protect_order_identity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.primary_guest_snapshot IS DISTINCT FROM OLD.primary_guest_snapshot
    OR NEW.booking_channel_code IS DISTINCT FROM OLD.booking_channel_code
    OR NEW.channel_order_reference IS DISTINCT FROM OLD.channel_order_reference
    OR NEW.free_stay_reason IS DISTINCT FROM OLD.free_stay_reason
    OR NEW.free_stay_category_code IS DISTINCT FROM OLD.free_stay_category_code
    OR NEW.pricing_policy_version_id IS DISTINCT FROM OLD.pricing_policy_version_id
    OR NEW.stay_type IS DISTINCT FROM OLD.stay_type THEN
    RAISE EXCEPTION 'order identity, guest snapshot, booking channel, free-stay identity, stay type, and locked pricing policy are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id THEN
    IF OLD.member_id IS NOT NULL OR OLD.member_contract_id IS NOT NULL
      OR NEW.member_id IS NULL OR NEW.member_contract_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM amendments AS amendment
        JOIN command_executions AS execution ON execution.id = amendment.command_id
        JOIN membership_orders AS membership_order
          ON membership_order.created_by_command_id = execution.id
          AND membership_order.activated_by_command_id = execution.id
        JOIN member_contracts AS contract ON contract.id = membership_order.contract_id
        WHERE amendment.order_id = NEW.id
          AND amendment.amendment_type = execution.command_type
          AND amendment.prior_version = OLD.version
          AND amendment.new_version = NEW.version
          AND execution.command_type IN (
            'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
            'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
          )
          AND execution.state = 'EXECUTING'
          AND execution.property_id = NEW.property_id
          AND membership_order.property_id = NEW.property_id
          AND membership_order.status = 'ACTIVE'
          AND membership_order.member_id = NEW.member_id
          AND membership_order.contract_id = NEW.member_contract_id
          AND contract.member_id = NEW.member_id
          AND contract.property_id = NEW.property_id
          AND contract.membership_order_id = membership_order.id
      ) THEN
      RAISE EXCEPTION 'order membership identity can only be linked once by a typed conversion amendment'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_has_typed_runtime_command_evidence(
  target_command_id text,
  expected_command_type text,
  expected_property_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM command_executions AS execution
    JOIN command_catalog AS catalog
      ON catalog.command_type = execution.command_type
    JOIN subjects AS subject_row
      ON subject_row.id = execution.subject_id
      AND subject_row.status = 'ACTIVE'
    JOIN subject_property_grants AS property_grant
      ON property_grant.subject_id = execution.subject_id
      AND property_grant.property_id = execution.property_id
      AND property_grant.access_level = 'WRITE'
    JOIN subject_command_grants AS command_grant
      ON command_grant.subject_id = execution.subject_id
      AND command_grant.property_id = execution.property_id
      AND command_grant.command_type = execution.command_type
    JOIN command_receipts AS receipt
      ON receipt.command_id = execution.id
      AND receipt.execution_status = 'EXECUTED'
      AND receipt.business_committed
      AND receipt.xmin = (pg_current_xact_id()::text)::xid
    JOIN audit_entries AS audit
      ON audit.command_id = execution.id
      AND audit.subject_id = execution.subject_id
      AND audit.credential_id = execution.credential_id
      AND audit.action = execution.command_type
      AND audit.decision = 'ALLOWED'
      AND audit.correlation_id = execution.correlation_id
      AND audit.xmin = (pg_current_xact_id()::text)::xid
    WHERE execution.id = target_command_id
      AND execution.command_type = expected_command_type
      AND execution.property_id = expected_property_id
      AND execution.state = 'APPLIED'
      AND execution.xmin = (pg_current_xact_id()::text)::xid
      AND catalog.command_class = 'HUMAN_COMMAND'
      AND catalog.feature_key IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM web_sessions AS session_row
          WHERE session_row.id = execution.credential_id
            AND session_row.subject_id = execution.subject_id
            AND session_row.revoked_at IS NULL
            AND session_row.expires_at > statement_timestamp()
        )
        OR EXISTS (
          SELECT 1
          FROM api_tokens AS token
          JOIN token_command_ceilings AS ceiling
            ON ceiling.token_id = token.id
            AND ceiling.subject_id = token.subject_id
            AND ceiling.property_id = token.property_scope
            AND ceiling.command_type = execution.command_type
          WHERE token.id = execution.credential_id
            AND token.subject_id = execution.subject_id
            AND token.property_scope = execution.property_id
            AND token.access_ceiling = 'WRITE'
            AND token.revoked_at IS NULL
            AND token.expires_at > statement_timestamp()
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION qintopia_has_typed_runtime_command_evidence(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_has_typed_runtime_command_evidence(text, text, text) TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_has_historical_command_fact_evidence(
  target_command_id text,
  expected_command_type text,
  expected_property_id text,
  expected_fact_id text,
  expected_resource_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM command_executions AS execution
    JOIN command_receipts AS receipt
      ON receipt.command_id = execution.id
      AND receipt.execution_status = 'EXECUTED'
      AND receipt.business_committed
      AND jsonb_typeof(receipt.fact_refs) = 'array'
      AND receipt.fact_refs @> jsonb_build_array(expected_fact_id)
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(receipt.fact_refs) = 'array'
            THEN receipt.fact_refs ELSE '[]'::jsonb END
        ) AS fact_ref(value)
        WHERE jsonb_typeof(fact_ref.value) IS DISTINCT FROM 'string'
      )
      AND (
        expected_resource_id IS NULL
        OR (
          jsonb_typeof(receipt.resource_refs) = 'array'
          AND receipt.resource_refs @> jsonb_build_array(expected_resource_id)
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(receipt.resource_refs) = 'array'
                THEN receipt.resource_refs ELSE '[]'::jsonb END
            ) AS resource_ref(value)
            WHERE jsonb_typeof(resource_ref.value) IS DISTINCT FROM 'string'
          )
        )
      )
    JOIN audit_entries AS audit
      ON audit.command_id = execution.id
      AND audit.subject_id = execution.subject_id
      AND audit.credential_id = execution.credential_id
      AND audit.action = execution.command_type
      AND audit.decision = 'ALLOWED'
      AND audit.correlation_id = execution.correlation_id
    WHERE execution.id = target_command_id
      AND execution.command_type = expected_command_type
      AND execution.property_id = expected_property_id
      AND execution.state = 'APPLIED'
      AND (SELECT count(*)
        FROM audit_entries AS allowed_audit
        WHERE allowed_audit.command_id = execution.id
          AND allowed_audit.decision = 'ALLOWED'
      ) = 1
  );
$$;

REVOKE ALL ON FUNCTION qintopia_has_historical_command_fact_evidence(
  text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_has_historical_command_fact_evidence(
  text, text, text, text, text
) TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_has_exact_source_amendment_set(
  target_command_id text,
  target_command_type text,
  target_order_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH amendment_counts AS (
    SELECT
      count(*)::integer AS total_count,
      count(*) FILTER (WHERE amendment_type = 'CREATE_ORDER')::integer AS create_count,
      count(*) FILTER (WHERE amendment_type = 'CHECK_IN')::integer AS check_in_count,
      count(*) FILTER (WHERE amendment_type = 'CHECK_OUT')::integer AS check_out_count,
      count(*) FILTER (WHERE amendment_type = 'SHORTEN_STAY')::integer AS shorten_count,
      count(*) FILTER (WHERE amendment_type = target_command_type)::integer AS matching_count,
      count(*) FILTER (WHERE amendment_type NOT IN ('CREATE_ORDER', 'CHECK_IN', 'CHECK_OUT'))::integer
        AS create_other_count,
      count(*) FILTER (WHERE amendment_type NOT IN ('CHECK_IN', 'CHECK_OUT'))::integer
        AS completion_other_count,
      count(*) FILTER (WHERE amendment_type NOT IN ('SHORTEN_STAY', 'CHECK_OUT'))::integer
        AS shorten_other_count,
      count(*) FILTER (WHERE order_id IS DISTINCT FROM target_order_id)::integer AS foreign_order_count
    FROM amendments
    WHERE command_id = target_command_id
  )
  SELECT foreign_order_count = 0 AND CASE
    WHEN target_command_type = 'CREATE_ORDER' THEN
      total_count > 0
      AND create_count = 1
      AND check_in_count <= 1
      AND check_out_count <= 1
      AND (check_out_count = 0 OR check_in_count = 1)
      AND create_other_count = 0
    WHEN target_command_type IN ('COMPLETE_STAY', 'BACKFILL_COMPLETED_STAY') THEN
      total_count = 2
      AND check_in_count = 1
      AND check_out_count = 1
      AND completion_other_count = 0
    WHEN target_command_type = 'SHORTEN_STAY' THEN
      total_count > 0
      AND shorten_count = 1
      AND check_out_count <= 1
      AND shorten_other_count = 0
    ELSE total_count = 1 AND matching_count = 1
  END
  FROM amendment_counts;
$$;

REVOKE ALL ON FUNCTION qintopia_has_exact_source_amendment_set(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_has_exact_source_amendment_set(text, text, text) TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_validate_member_profile_correction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_member members%ROWTYPE;
  target_execution command_executions%ROWTYPE;
  target_audit audit_entries%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  expected_changed_fields text[];
  allowed_audit_count integer;
  allowed_preview_audit_count integer;
  preview_count integer;
  prior_correction_id text;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF TG_TABLE_NAME = 'member_property_links' THEN
    IF EXISTS (
      SELECT 1
      FROM member_profile_corrections AS correction
      WHERE correction.member_id = NEW.member_id
        AND correction.xmin = current_xid
        AND EXISTS (
          SELECT 1
          FROM member_property_links AS other_link
          WHERE other_link.member_id = correction.member_id
            AND other_link.property_id <> correction.property_id
        )
    ) THEN
      RAISE EXCEPTION 'member profile correction requires exactly one property link'
        USING ERRCODE = '23514', CONSTRAINT = 'member_profile_correction_single_property_scope';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO current_member FROM members WHERE id = NEW.member_id;
  SELECT * INTO target_execution FROM command_executions WHERE id = NEW.command_id;
  SELECT count(*)::integer INTO allowed_audit_count
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT * INTO target_audit
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT count(*)::integer INTO preview_count
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT * INTO target_preview
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT count(*)::integer INTO allowed_preview_audit_count
  FROM audit_entries
  WHERE decision = 'ALLOWED'
    AND metadata ->> 'previewId' = target_preview.id;
  SELECT prior.id INTO prior_correction_id
  FROM member_profile_corrections AS prior
  WHERE prior.member_id = NEW.member_id
    AND prior.id <> NEW.id
  ORDER BY prior.sequence DESC
  LIMIT 1;
  expected_changed_fields := array_remove(ARRAY[
    CASE WHEN NEW.prior_full_name IS DISTINCT FROM NEW.corrected_full_name THEN 'fullName' END,
    CASE WHEN NEW.prior_nickname IS DISTINCT FROM NEW.corrected_nickname THEN 'nickname' END,
    CASE WHEN NEW.prior_identity_card_number IS DISTINCT FROM NEW.corrected_identity_card_number THEN 'identityCardNumber' END,
    CASE WHEN NEW.prior_phone IS DISTINCT FROM NEW.corrected_phone THEN 'phone' END,
    CASE WHEN NEW.prior_wechat IS DISTINCT FROM NEW.corrected_wechat THEN 'wechat' END
  ]::text[], NULL);

  IF NEW.sequence IS DISTINCT FROM COALESCE((
    SELECT max(prior.sequence)
    FROM member_profile_corrections AS prior
    WHERE prior.member_id = NEW.member_id
      AND prior.id <> NEW.id
  ), 0) + 1 THEN
    RAISE EXCEPTION 'member profile correction sequence must start at one and advance exactly once'
      USING ERRCODE = '23514', CONSTRAINT = 'member_profile_correction_sequence';
  END IF;

  IF allowed_audit_count IS DISTINCT FROM 1
    OR allowed_preview_audit_count IS DISTINCT FROM 1
    OR preview_count IS DISTINCT FROM 1
    OR target_execution.id IS NULL
    OR target_execution.property_id IS DISTINCT FROM NEW.property_id
    OR target_execution.command_type IS DISTINCT FROM 'CORRECT_MEMBER_PROFILE'
    OR target_execution.state IS DISTINCT FROM 'APPLIED'
    OR target_audit.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_audit.credential_id IS DISTINCT FROM target_execution.credential_id
    OR target_audit.action IS DISTINCT FROM target_execution.command_type
    OR target_audit.correlation_id IS DISTINCT FROM target_execution.correlation_id
    OR target_audit.metadata ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_preview.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_preview.property_id IS DISTINCT FROM target_execution.property_id
    OR target_preview.command_type IS DISTINCT FROM target_execution.command_type
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.effect ->> 'operation' IS DISTINCT FROM 'CORRECT_MEMBER_PROFILE'
    OR target_preview.effect ->> 'memberId' IS DISTINCT FROM NEW.member_id
    OR target_preview.effect #>> '{before,fullName}' IS DISTINCT FROM NEW.prior_full_name
    OR target_preview.effect #>> '{before,nickname}' IS DISTINCT FROM NEW.prior_nickname
    OR target_preview.effect #>> '{before,identityCardNumber}' IS DISTINCT FROM NEW.prior_identity_card_number
    OR target_preview.effect #>> '{before,phone}' IS DISTINCT FROM NEW.prior_phone
    OR target_preview.effect #>> '{before,wechat}' IS DISTINCT FROM NEW.prior_wechat
    OR target_preview.effect #>> '{after,fullName}' IS DISTINCT FROM NEW.corrected_full_name
    OR target_preview.effect #>> '{after,nickname}' IS DISTINCT FROM NEW.corrected_nickname
    OR target_preview.effect #>> '{after,identityCardNumber}' IS DISTINCT FROM NEW.corrected_identity_card_number
    OR target_preview.effect #>> '{after,phone}' IS DISTINCT FROM NEW.corrected_phone
    OR target_preview.effect #>> '{after,wechat}' IS DISTINCT FROM NEW.corrected_wechat
    OR target_preview.effect ->> 'evidenceNote' IS DISTINCT FROM NEW.evidence_note
    OR target_preview.basis_versions IS DISTINCT FROM jsonb_build_object(
      'member', jsonb_build_object(
        'id', NEW.member_id,
        'profile', jsonb_build_object(
          'fullName', NEW.prior_full_name,
          'nickname', NEW.prior_nickname,
          'identityCardNumber', NEW.prior_identity_card_number,
          'phone', NEW.prior_phone,
          'wechat', NEW.prior_wechat
        )
      ),
      'latestCorrectionId', prior_correction_id,
      'nextCorrectionSequence', NEW.sequence
    )
    OR jsonb_typeof(target_preview.effect -> 'changedFields') IS DISTINCT FROM 'array'
    OR ARRAY(
      SELECT jsonb_array_elements_text(target_preview.effect -> 'changedFields')
    ) IS DISTINCT FROM NEW.changed_fields THEN
    RAISE EXCEPTION 'member profile correction root must match every value frozen in one used Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'member_profile_correction_preview_binding';
  END IF;

  IF NOT qintopia_has_typed_runtime_command_evidence(
      NEW.command_id,
      'CORRECT_MEMBER_PROFILE',
      NEW.property_id
    )
    OR current_member.id IS NULL
    OR current_member.full_name IS DISTINCT FROM NEW.corrected_full_name
    OR current_member.nickname IS DISTINCT FROM NEW.corrected_nickname
    OR current_member.identity_card_number IS DISTINCT FROM NEW.corrected_identity_card_number
    OR current_member.phone IS DISTINCT FROM NEW.corrected_phone
    OR current_member.wechat IS DISTINCT FROM NEW.corrected_wechat
    OR NEW.changed_fields IS DISTINCT FROM expected_changed_fields
    OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
    OR EXISTS (
      SELECT 1
      FROM members AS other_member
      WHERE other_member.phone = NEW.corrected_phone
        AND other_member.id <> NEW.member_id
    )
    OR (SELECT count(*) FROM members WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.member_id AND xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_effective_date_corrections WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM historical_membership_backfills WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_payment_reclassifications WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_void_reconversions WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_orders WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_payment_facts WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_contracts WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM entitlement_lots WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM orders WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stays WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_segments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM amendments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM pricing_revisions WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM coverage_items WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_collection_membership_transfers WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_property_links WHERE xmin = current_xid) THEN
    RAISE EXCEPTION 'member profile correction must match one exact typed projection update'
      USING ERRCODE = '23514', CONSTRAINT = 'member_profile_correction_exact_projection';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM member_property_links AS other_link
    WHERE other_link.member_id = NEW.member_id
      AND other_link.property_id <> NEW.property_id
  ) THEN
    RAISE EXCEPTION 'member profile correction requires exactly one property link'
      USING ERRCODE = '23514', CONSTRAINT = 'member_profile_correction_single_property_scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER member_profile_corrections_validate_graph
AFTER INSERT ON member_profile_corrections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_member_profile_correction();

CREATE CONSTRAINT TRIGGER member_property_links_validate_profile_correction_scope
AFTER INSERT ON member_property_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_member_profile_correction();

CREATE OR REPLACE FUNCTION qintopia_validate_membership_effective_date_correction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_order membership_orders%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  target_execution command_executions%ROWTYPE;
  target_audit audit_entries%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  allowed_audit_count integer;
  allowed_preview_audit_count integer;
  preview_count integer;
  property_today date;
  prior_correction_id text;
  current_member_balance jsonb;
  current_used_units integer;
  current_payment_fact_ids jsonb;
  current_ledger_fact_ids jsonb;
  current_coverage_states jsonb;
  current_source_states jsonb;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  SELECT * INTO target_order FROM membership_orders WHERE id = NEW.membership_order_id;
  SELECT * INTO target_contract FROM member_contracts WHERE id = NEW.contract_id;
  SELECT * INTO target_lot FROM entitlement_lots WHERE id = NEW.entitlement_lot_id;
  SELECT * INTO target_execution FROM command_executions WHERE id = NEW.command_id;
  SELECT count(*)::integer INTO allowed_audit_count
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT * INTO target_audit
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT count(*)::integer INTO preview_count
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT * INTO target_preview
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT count(*)::integer INTO allowed_preview_audit_count
  FROM audit_entries
  WHERE decision = 'ALLOWED'
    AND metadata ->> 'previewId' = target_preview.id;
  SELECT (transaction_timestamp() AT TIME ZONE timezone)::date
    INTO property_today
  FROM properties WHERE id = NEW.property_id;
  SELECT prior.id INTO prior_correction_id
  FROM membership_effective_date_corrections AS prior
  WHERE prior.membership_order_id = NEW.membership_order_id
    AND prior.id <> NEW.id
  ORDER BY prior.sequence DESC
  LIMIT 1;
  WITH lot_balances AS (
    SELECT lot.id,
        lot.unit_kind,
        CASE
          WHEN contract.status <> 'ACTIVE' OR lot.expires_on < property_today THEN 0::bigint
          ELSE lot.total_units::bigint + COALESCE(sum(ledger.quantity_delta), 0)::bigint
        END AS available_units
    FROM member_contracts AS contract
    JOIN entitlement_lots AS lot ON lot.contract_id = contract.id
    LEFT JOIN entitlement_ledger AS ledger ON ledger.lot_id = lot.id
    WHERE contract.property_id = NEW.property_id
      AND contract.member_id = NEW.member_id
      AND contract.status = 'ACTIVE'
      AND lot.status = 'ACTIVE'
    GROUP BY lot.id, lot.unit_kind, lot.total_units, lot.expires_on, contract.status
  )
  SELECT jsonb_build_object(
      'ROOM_NIGHT', COALESCE(sum(available_units) FILTER (
        WHERE unit_kind = 'ROOM_NIGHT'
      ), 0),
      'BED_NIGHT', COALESCE(sum(available_units) FILTER (
        WHERE unit_kind = 'BED_NIGHT'
      ), 0)
    )
    INTO current_member_balance
  FROM lot_balances;
  SELECT count(*)::integer INTO current_used_units
  FROM entitlement_ledger AS ledger
  WHERE ledger.lot_id = NEW.entitlement_lot_id
    AND ledger.entry_type IN ('CONSUME', 'CONVERSION_CONSUME');
  SELECT COALESCE(
      jsonb_agg(to_jsonb(payment.fact_id) ORDER BY payment.created_at, payment.fact_id),
      '[]'::jsonb
    )
    INTO current_payment_fact_ids
  FROM membership_payment_facts AS payment
  WHERE payment.membership_order_id = NEW.membership_order_id;
  SELECT COALESCE(
      jsonb_agg(to_jsonb(ledger.fact_id) ORDER BY ledger.created_at, ledger.fact_id),
      '[]'::jsonb
    )
    INTO current_ledger_fact_ids
  FROM entitlement_ledger AS ledger
  LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
  WHERE ledger.lot_id = NEW.entitlement_lot_id
    OR coverage.lot_id = NEW.entitlement_lot_id;
  SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('id', coverage.id, 'status', coverage.status)
        ORDER BY coverage.service_date, coverage.id
      ),
      '[]'::jsonb
    )
    INTO current_coverage_states
  FROM coverage_items AS coverage
  WHERE coverage.lot_id = NEW.entitlement_lot_id;
  SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'orderId', source_state.order_id,
          'version', source_state.order_version,
          'status', source_state.order_status,
          'currentRevisionId', source_state.current_revision_id,
          'stayId', source_state.stay_id,
          'stayStatus', source_state.stay_status
        ) ORDER BY source_state.order_id, source_state.stay_id
      ),
      '[]'::jsonb
    )
    INTO current_source_states
  FROM (
    SELECT
      source_order.id AS order_id,
      source_order.version AS order_version,
      source_order.status AS order_status,
      source_order.current_revision_id,
      source_stay.id AS stay_id,
      source_stay.status AS stay_status
    FROM (
      SELECT DISTINCT ledger.order_id
      FROM entitlement_ledger AS ledger
      LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
      WHERE (ledger.lot_id = NEW.entitlement_lot_id
          OR coverage.lot_id = NEW.entitlement_lot_id)
        AND ledger.entry_type IN ('HOLD','RELEASE','CONSUME','RESTORE','CONVERSION_CONSUME')
        AND ledger.order_id IS NOT NULL
    ) AS source_reference
    JOIN orders AS source_order ON source_order.id = source_reference.order_id
    JOIN stays AS source_stay ON source_stay.order_id = source_order.id
  ) AS source_state;

  IF NEW.sequence IS DISTINCT FROM COALESCE((
    SELECT max(prior.sequence)
    FROM membership_effective_date_corrections AS prior
    WHERE prior.membership_order_id = NEW.membership_order_id
      AND prior.id <> NEW.id
  ), 0) + 1 THEN
    RAISE EXCEPTION 'membership effective date correction sequence must start at one and advance exactly once'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_effective_date_correction_sequence';
  END IF;

  IF allowed_audit_count IS DISTINCT FROM 1
    OR allowed_preview_audit_count IS DISTINCT FROM 1
    OR preview_count IS DISTINCT FROM 1
    OR target_execution.id IS NULL
    OR target_execution.property_id IS DISTINCT FROM NEW.property_id
    OR target_execution.command_type IS DISTINCT FROM 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE'
    OR target_execution.state IS DISTINCT FROM 'APPLIED'
    OR target_audit.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_audit.credential_id IS DISTINCT FROM target_execution.credential_id
    OR target_audit.action IS DISTINCT FROM target_execution.command_type
    OR target_audit.correlation_id IS DISTINCT FROM target_execution.correlation_id
    OR target_audit.metadata ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_preview.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_preview.property_id IS DISTINCT FROM target_execution.property_id
    OR target_preview.command_type IS DISTINCT FROM target_execution.command_type
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.effect ->> 'operation' IS DISTINCT FROM 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE'
    OR target_preview.effect ->> 'propertyToday' IS DISTINCT FROM property_today::text
    OR target_preview.effect ->> 'memberId' IS DISTINCT FROM NEW.member_id
    OR target_preview.effect ->> 'membershipOrderId' IS DISTINCT FROM NEW.membership_order_id
    OR target_preview.effect ->> 'contractId' IS DISTINCT FROM NEW.contract_id
    OR target_preview.effect ->> 'entitlementLotId' IS DISTINCT FROM NEW.entitlement_lot_id
    OR target_preview.effect ->> 'evidenceNote' IS DISTINCT FROM NEW.evidence_note
    OR target_preview.effect #>> '{before,validFrom}' IS DISTINCT FROM NEW.prior_valid_from::text
    OR target_preview.effect #>> '{before,validUntil}' IS DISTINCT FROM NEW.prior_valid_until::text
    OR target_preview.effect #>> '{before,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.effect #>> '{after,validFrom}' IS DISTINCT FROM NEW.corrected_valid_from::text
    OR target_preview.effect #>> '{after,validUntil}' IS DISTINCT FROM NEW.corrected_valid_until::text
    OR target_preview.effect #>> '{after,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.effect #>> '{unchanged,memberId}' IS DISTINCT FROM NEW.member_id
    OR target_preview.effect #>> '{unchanged,productName}' IS DISTINCT FROM target_order.product_name
    OR target_preview.effect #>> '{unchanged,agreedPrice,minorUnits}'
      IS DISTINCT FROM target_order.agreed_price_minor::text
    OR target_preview.effect #>> '{unchanged,agreedPrice,currency}'
      IS DISTINCT FROM target_order.currency::text
    OR target_preview.effect #>> '{unchanged,entitlementUnitKind}'
      IS DISTINCT FROM target_lot.unit_kind
    OR target_preview.effect #>> '{unchanged,entitlementUnits}'
      IS DISTINCT FROM target_lot.total_units::text
    OR target_preview.effect #> '{unchanged,availableBalance}'
      IS DISTINCT FROM current_member_balance
    OR target_preview.effect #>> '{unchanged,paymentFactCount}' IS DISTINCT FROM (
      SELECT count(*)::text
      FROM membership_payment_facts
      WHERE membership_order_id = NEW.membership_order_id
    )
    OR target_preview.effect #>> '{unchanged,usedUnits}' IS DISTINCT FROM current_used_units::text
    OR target_preview.basis_versions #>> '{order,id}' IS DISTINCT FROM NEW.membership_order_id
    OR target_preview.basis_versions #>> '{order,version}' IS DISTINCT FROM NEW.prior_order_version::text
    OR target_preview.basis_versions #>> '{order,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.basis_versions #>> '{contract,id}' IS DISTINCT FROM NEW.contract_id
    OR target_preview.basis_versions #>> '{contract,version}' IS DISTINCT FROM NEW.prior_contract_version::text
    OR target_preview.basis_versions #>> '{contract,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.basis_versions #>> '{lot,id}' IS DISTINCT FROM NEW.entitlement_lot_id
    OR target_preview.basis_versions #>> '{lot,version}' IS DISTINCT FROM NEW.prior_lot_version::text
    OR target_preview.basis_versions #>> '{lot,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.basis_versions #>> '{lot,expiresOn}' IS DISTINCT FROM NEW.prior_valid_until::text
    OR NOT (target_preview.basis_versions ? 'latestCorrectionId')
    OR target_preview.basis_versions ->> 'latestCorrectionId' IS DISTINCT FROM prior_correction_id
    OR target_preview.basis_versions ->> 'nextCorrectionSequence' IS DISTINCT FROM NEW.sequence::text
    OR target_preview.basis_versions ->> 'propertyToday' IS DISTINCT FROM property_today::text
    OR target_preview.basis_versions -> 'memberBalance' IS DISTINCT FROM current_member_balance
    OR target_preview.basis_versions -> 'paymentFactIds'
      IS DISTINCT FROM current_payment_fact_ids
    OR target_preview.basis_versions -> 'ledgerFactIds'
      IS DISTINCT FROM current_ledger_fact_ids
    OR target_preview.basis_versions -> 'coverageStates'
      IS DISTINCT FROM current_coverage_states
    OR target_preview.basis_versions -> 'sourceStates'
      IS DISTINCT FROM current_source_states
    OR target_preview.effect #>> '{unchanged,lifecycleStatus}' IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'membership effective date correction root must match every value frozen in one used Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_effective_date_correction_preview_binding';
  END IF;

  IF NOT qintopia_has_typed_runtime_command_evidence(
      NEW.command_id,
      'CORRECT_MEMBERSHIP_EFFECTIVE_DATE',
      NEW.property_id
    )
    OR target_order.id IS NULL
    OR target_contract.id IS NULL
    OR target_lot.id IS NULL
    OR target_order.property_id IS DISTINCT FROM NEW.property_id
    OR target_order.member_id IS DISTINCT FROM NEW.member_id
    OR target_order.contract_id IS DISTINCT FROM target_contract.id
    OR target_order.entitlement_lot_id IS DISTINCT FROM target_lot.id
    OR target_contract.property_id IS DISTINCT FROM NEW.property_id
    OR target_contract.member_id IS DISTINCT FROM NEW.member_id
    OR target_contract.membership_order_id IS DISTINCT FROM target_order.id
    OR target_lot.contract_id IS DISTINCT FROM target_contract.id
    OR target_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_contract.status IS DISTINCT FROM 'ACTIVE'
    OR target_lot.status IS DISTINCT FROM 'ACTIVE'
    OR target_order.valid_from IS DISTINCT FROM NEW.corrected_valid_from
    OR target_order.valid_until IS DISTINCT FROM NEW.corrected_valid_until
    OR target_contract.valid_from IS DISTINCT FROM NEW.corrected_valid_from
    OR target_contract.valid_until IS DISTINCT FROM NEW.corrected_valid_until
    OR target_lot.expires_on IS DISTINCT FROM NEW.corrected_valid_until
    OR target_order.version IS DISTINCT FROM NEW.prior_order_version + 1
    OR target_contract.version IS DISTINCT FROM NEW.prior_contract_version + 1
    OR target_lot.version IS DISTINCT FROM NEW.prior_lot_version + 1
    OR target_order.entitlement_unit_kind IS DISTINCT FROM target_lot.unit_kind
    OR target_order.entitlement_units IS DISTINCT FROM target_lot.total_units
    OR (SELECT count(*) FROM entitlement_lots AS lot
      WHERE lot.contract_id = NEW.contract_id) <> 1
    OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
    OR NOT EXISTS (
      SELECT 1
      FROM membership_products AS product
      WHERE product.id = target_order.product_id
        AND product.version = target_order.product_version
        AND product.validity_period = 'P1Y'
    )
    OR NEW.corrected_valid_until IS DISTINCT FROM (NEW.corrected_valid_from + interval '1 year')::date
    OR NEW.prior_valid_from > property_today
    OR NEW.prior_valid_until < property_today
    OR NEW.corrected_valid_from > property_today
    OR NEW.corrected_valid_until < property_today
    OR EXISTS (
      SELECT 1
      FROM command_executions AS creation_execution
      WHERE creation_execution.id = target_order.created_by_command_id
        AND creation_execution.command_type IN (
          'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
          'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM entitlement_ledger AS conversion_fact
          WHERE conversion_fact.lot_id = NEW.entitlement_lot_id
            AND conversion_fact.command_id = creation_execution.id
            AND conversion_fact.entry_type = 'CONVERSION_CONSUME'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM pricing_revisions AS coverage_revision
      JOIN orders AS coverage_order ON coverage_order.id = coverage_revision.order_id
      WHERE coverage_order.property_id = NEW.property_id
        AND coverage_order.member_contract_id = target_contract.id
        AND (
          jsonb_typeof(coverage_revision.coverage_set) IS DISTINCT FROM 'array'
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(coverage_revision.coverage_set) = 'array'
                THEN coverage_revision.coverage_set ELSE '[]'::jsonb END
            ) AS coverage_item(value)
            WHERE coverage_item.value ->> 'entitlementLotId' = NEW.entitlement_lot_id
              AND (
                jsonb_typeof(coverage_item.value) IS DISTINCT FROM 'object'
                OR jsonb_typeof(coverage_item.value -> 'serviceDate') IS DISTINCT FROM 'string'
                OR jsonb_typeof(coverage_item.value -> 'inventoryUnitId') IS DISTINCT FROM 'string'
                OR jsonb_typeof(coverage_item.value -> 'unitKind') IS DISTINCT FROM 'string'
                OR jsonb_typeof(coverage_item.value -> 'entitlementLotId') IS DISTINCT FROM 'string'
                OR coverage_item.value ->> 'serviceDate' !~ '^\d{4}-\d{2}-\d{2}$'
                OR NOT pg_catalog.pg_input_is_valid(
                  coverage_item.value ->> 'serviceDate', 'date'
                )
                OR coverage_item.value ->> 'unitKind' IS DISTINCT FROM target_lot.unit_kind
                OR CASE
                  WHEN pg_catalog.pg_input_is_valid(
                    coverage_item.value ->> 'serviceDate', 'date'
                  ) THEN (coverage_item.value ->> 'serviceDate')::date
                  ELSE NULL
                END < coverage_revision.arrival_date
                OR CASE
                  WHEN pg_catalog.pg_input_is_valid(
                    coverage_item.value ->> 'serviceDate', 'date'
                  ) THEN (coverage_item.value ->> 'serviceDate')::date
                  ELSE NULL
                END >= coverage_revision.departure_date
              )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT
          coverage_revision.order_id,
          array_agg(
            DISTINCT parsed_coverage.service_date
            ORDER BY parsed_coverage.service_date
          ) AS expected_service_dates
        FROM pricing_revisions AS coverage_revision
        JOIN orders AS coverage_order ON coverage_order.id = coverage_revision.order_id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(coverage_revision.coverage_set) = 'array'
            THEN coverage_revision.coverage_set ELSE '[]'::jsonb END
        ) AS coverage_item(value)
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN coverage_item.value ->> 'serviceDate' ~ '^\d{4}-\d{2}-\d{2}$'
              AND pg_catalog.pg_input_is_valid(
                coverage_item.value ->> 'serviceDate', 'date'
              )
              THEN (coverage_item.value ->> 'serviceDate')::date
            ELSE NULL
          END AS service_date
        ) AS parsed_coverage
        WHERE coverage_order.property_id = NEW.property_id
          AND coverage_order.member_contract_id = target_contract.id
          AND NOT EXISTS (
            SELECT 1
            FROM entitlement_ledger AS conversion_fact
            WHERE conversion_fact.lot_id = NEW.entitlement_lot_id
              AND conversion_fact.order_id = coverage_revision.order_id
              AND conversion_fact.entry_type = 'CONVERSION_CONSUME'
          )
          AND coverage_item.value ->> 'entitlementLotId' = NEW.entitlement_lot_id
          AND parsed_coverage.service_date IS NOT NULL
        GROUP BY coverage_revision.order_id
      ) AS expected_coverage
      CROSS JOIN LATERAL (
        SELECT COALESCE(
            array_agg(DISTINCT coverage.service_date ORDER BY coverage.service_date),
            ARRAY[]::date[]
          ) AS actual_service_dates
        FROM coverage_items AS coverage
        WHERE coverage.order_id = expected_coverage.order_id
          AND coverage.lot_id = NEW.entitlement_lot_id
      ) AS actual_coverage
      WHERE expected_coverage.expected_service_dates IS DISTINCT FROM actual_coverage.actual_service_dates
    )
    OR EXISTS (
      SELECT 1 FROM entitlement_ledger AS ledger
      WHERE ledger.lot_id = NEW.entitlement_lot_id
        AND (
          ledger.entry_type IN ('EXPIRE', 'VOID')
          OR (ledger.entry_type = 'ADJUST' AND (
            ledger.service_date IS NOT NULL
            OR ledger.order_id IS NOT NULL
            OR ledger.coverage_id IS NOT NULL
          ))
          OR (ledger.entry_type = 'HOLD'
            AND ledger.quantity_delta IS DISTINCT FROM -1)
          OR (ledger.entry_type = 'RELEASE'
            AND ledger.quantity_delta IS DISTINCT FROM 1)
          OR (ledger.entry_type = 'CONSUME'
            AND ledger.quantity_delta IS DISTINCT FROM 0)
          OR (ledger.entry_type = 'RESTORE'
            AND ledger.quantity_delta IS DISTINCT FROM 1)
          OR (ledger.entry_type = 'CONVERSION_CONSUME'
            AND ledger.quantity_delta IS DISTINCT FROM -1)
          OR (ledger.entry_type IN ('HOLD','RELEASE','CONSUME','RESTORE','CONVERSION_CONSUME')
            AND ledger.service_date IS NULL)
          OR (ledger.service_date IS NOT NULL
            AND (ledger.service_date < NEW.corrected_valid_from
              OR ledger.service_date > NEW.corrected_valid_until))
        )
    )
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS ledger
      LEFT JOIN command_executions AS source_execution ON source_execution.id = ledger.command_id
      LEFT JOIN orders AS source_order ON source_order.id = ledger.order_id
      LEFT JOIN stays AS source_stay ON source_stay.order_id = source_order.id
      WHERE ledger.lot_id = NEW.entitlement_lot_id
        AND ledger.entry_type = 'CONVERSION_CONSUME'
        AND ledger.coverage_id IS NULL
        AND (
          source_execution.id IS NULL
          OR source_execution.command_type NOT IN (
            'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
            'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
          )
          OR source_execution.state IS DISTINCT FROM 'APPLIED'
          OR source_execution.property_id IS DISTINCT FROM NEW.property_id
          OR NOT qintopia_has_historical_command_fact_evidence(
            ledger.command_id,
            source_execution.command_type,
            NEW.property_id,
            ledger.fact_id,
            NULL
          )
          OR NOT qintopia_has_exact_source_amendment_set(
            ledger.command_id,
            source_execution.command_type,
            ledger.order_id
          )
          OR (source_execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
            AND (SELECT source_receipt.result ->> 'conversionMode'
              FROM command_receipts AS source_receipt
              WHERE source_receipt.command_id = ledger.command_id
            ) IS DISTINCT FROM 'COMPLETED')
          OR source_order.id IS NULL
          OR source_order.property_id IS DISTINCT FROM NEW.property_id
          OR source_order.member_id IS DISTINCT FROM NEW.member_id
          OR source_order.member_contract_id IS DISTINCT FROM target_contract.id
          OR source_order.status IS DISTINCT FROM 'CHECKED_OUT'
          OR source_stay.id IS NULL
          OR source_stay.status IS DISTINCT FROM 'COMPLETED'
          OR target_order.created_by_command_id IS DISTINCT FROM ledger.command_id
          OR target_order.activated_by_command_id IS DISTINCT FROM ledger.command_id
          OR (SELECT count(*)
            FROM amendments AS source_amendment
            WHERE source_amendment.command_id = ledger.command_id) <> 1
          OR NOT EXISTS (
            SELECT 1
            FROM amendments AS source_amendment
            WHERE source_amendment.command_id = ledger.command_id
              AND source_amendment.order_id = ledger.order_id
              AND source_amendment.amendment_type = source_execution.command_type
          )
          OR (source_execution.command_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
            AND NOT EXISTS (
              SELECT 1
              FROM membership_void_reconversions AS source_reconversion
              WHERE source_reconversion.command_id = ledger.command_id
                AND source_reconversion.property_id = NEW.property_id
                AND source_reconversion.member_id = NEW.member_id
                AND source_reconversion.source_order_id = ledger.order_id
                AND source_reconversion.source_stay_id = source_stay.id
                AND source_reconversion.new_membership_order_id = target_order.id
                AND source_reconversion.new_contract_id = target_contract.id
                AND source_reconversion.new_entitlement_lot_id = target_lot.id
            ))
          OR ledger.quantity_delta IS DISTINCT FROM -1
          OR ledger.service_date IS NULL
          OR ledger.service_date < source_order.arrival_date
          OR ledger.service_date >= source_order.departure_date
          OR ledger.reason IS DISTINCT FROM 'STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT
          ledger.command_id,
          ledger.order_id,
          array_agg(ledger.service_date ORDER BY ledger.service_date, ledger.fact_id)
            AS actual_service_dates
        FROM entitlement_ledger AS ledger
        WHERE ledger.lot_id = NEW.entitlement_lot_id
          AND ledger.entry_type = 'CONVERSION_CONSUME'
          AND ledger.coverage_id IS NULL
        GROUP BY ledger.command_id, ledger.order_id
      ) AS conversion
      JOIN command_executions AS source_execution
        ON source_execution.id = conversion.command_id
      JOIN orders AS source_order ON source_order.id = conversion.order_id
      LEFT JOIN stays AS source_stay ON source_stay.order_id = source_order.id
      WHERE conversion.actual_service_dates IS DISTINCT FROM ARRAY(
          SELECT source_order.arrival_date + date_offset.value
          FROM generate_series(
            0,
            source_order.departure_date - source_order.arrival_date - 1
          ) AS date_offset(value)
          ORDER BY date_offset.value
        )
        OR (SELECT count(*)
          FROM pricing_revisions AS conversion_revision
          JOIN amendments AS conversion_amendment
            ON conversion_amendment.id = conversion_revision.amendment_id
          WHERE conversion_amendment.command_id = conversion.command_id
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM amendments AS conversion_amendment
          JOIN pricing_revisions AS conversion_revision
            ON conversion_revision.amendment_id = conversion_amendment.id
          WHERE conversion_amendment.command_id = conversion.command_id
            AND conversion_amendment.order_id = conversion.order_id
            AND conversion_amendment.amendment_type = source_execution.command_type
            AND conversion_amendment.payload #> '{entitlement,serviceDates}'
              = to_jsonb(conversion.actual_service_dates)
            AND conversion_revision.order_id = conversion.order_id
            AND conversion_revision.arrival_date = source_order.arrival_date
            AND conversion_revision.departure_date = source_order.departure_date
            AND conversion_revision.pricing_basis = 'MEMBER_ENTITLEMENT'
            AND conversion_revision.current_contract_amount_minor = 0
            AND conversion_revision.manual_adjustment_minor = 0
            AND conversion_revision.coverage_set = '[]'::jsonb
            AND conversion_revision.cash_lines = '[]'::jsonb
        )
        OR (source_execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
          AND EXISTS (
            SELECT 1 FROM membership_void_reconversions AS unexpected_reconversion
            WHERE unexpected_reconversion.command_id = conversion.command_id
          ))
        OR (source_execution.command_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
          AND (SELECT count(*)
            FROM membership_void_reconversions AS source_reconversion
            WHERE source_reconversion.command_id = conversion.command_id
              AND source_reconversion.property_id = NEW.property_id
              AND source_reconversion.member_id = NEW.member_id
              AND source_reconversion.source_order_id = source_order.id
              AND source_reconversion.source_stay_id = source_stay.id
              AND source_reconversion.new_membership_order_id = target_order.id
              AND source_reconversion.new_contract_id = target_contract.id
              AND source_reconversion.new_entitlement_lot_id = target_lot.id
              AND source_reconversion.service_dates = conversion.actual_service_dates
          ) <> 1)
    )
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS ledger
      LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
      WHERE (ledger.lot_id = NEW.entitlement_lot_id
          OR coverage.lot_id = NEW.entitlement_lot_id)
        AND (
          (ledger.entry_type NOT IN ('HOLD','RELEASE','CONSUME','RESTORE','CONVERSION_CONSUME')
            AND coverage.lot_id = NEW.entitlement_lot_id)
          OR (
            ledger.entry_type IN ('HOLD','RELEASE','CONSUME','RESTORE','CONVERSION_CONSUME')
            AND (
              (ledger.coverage_id IS NULL
                AND ledger.entry_type IS DISTINCT FROM 'CONVERSION_CONSUME')
              OR (ledger.coverage_id IS NOT NULL AND (
                coverage.id IS NULL
                OR ledger.lot_id IS DISTINCT FROM coverage.lot_id
                OR ledger.order_id IS DISTINCT FROM coverage.order_id
                OR ledger.service_date IS DISTINCT FROM coverage.service_date
              ))
            )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM entitlement_ledger AS ledger
      LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
      LEFT JOIN command_executions AS source_execution
        ON source_execution.id = ledger.command_id
      LEFT JOIN orders AS source_order ON source_order.id = ledger.order_id
      LEFT JOIN stays AS source_stay ON source_stay.order_id = source_order.id
      LEFT JOIN pricing_revisions AS coverage_revision
        ON coverage_revision.id = coverage.held_by_revision_id
      LEFT JOIN amendments AS revision_amendment
        ON revision_amendment.id = coverage_revision.amendment_id
      WHERE (ledger.lot_id = NEW.entitlement_lot_id
          OR coverage.lot_id = NEW.entitlement_lot_id)
        AND ledger.coverage_id IS NOT NULL
        AND ledger.entry_type IN ('HOLD','RELEASE','CONSUME','RESTORE','CONVERSION_CONSUME')
        AND (
          coverage.id IS NULL
          OR source_execution.id IS NULL
          OR source_execution.property_id IS DISTINCT FROM NEW.property_id
          OR source_execution.state IS DISTINCT FROM 'APPLIED'
          OR NOT qintopia_has_historical_command_fact_evidence(
            ledger.command_id,
            source_execution.command_type,
            NEW.property_id,
            ledger.fact_id,
            ledger.coverage_id
          )
          OR NOT qintopia_has_exact_source_amendment_set(
            ledger.command_id,
            source_execution.command_type,
            ledger.order_id
          )
          OR source_order.id IS NULL
          OR source_order.property_id IS DISTINCT FROM NEW.property_id
          OR source_stay.id IS NULL
          OR coverage_revision.id IS NULL
          OR coverage_revision.order_id IS DISTINCT FROM source_order.id
          OR revision_amendment.id IS NULL
          OR revision_amendment.order_id IS DISTINCT FROM source_order.id
          OR (SELECT count(*)
            FROM amendments AS source_amendment
            WHERE source_amendment.command_id = ledger.command_id
              AND source_amendment.order_id = ledger.order_id
              AND source_amendment.amendment_type = CASE
                WHEN ledger.entry_type = 'CONSUME'
                  AND source_execution.command_type IN (
                    'CREATE_ORDER', 'COMPLETE_STAY', 'BACKFILL_COMPLETED_STAY'
                  )
                  THEN 'CHECK_IN'
                ELSE source_execution.command_type
              END
          ) <> 1
          OR NOT (
            (ledger.entry_type = 'HOLD'
              AND source_execution.command_type IN (
                'CREATE_ORDER', 'RESCHEDULE_STAY', 'EXTEND_STAY', 'MOVE_UNIT',
                'REPRICE_ORDER', 'REFRESH_MEMBER_COVERAGE'
              )
              AND ledger.reason = 'ORDER_COVERAGE_HOLD'
              AND revision_amendment.command_id = ledger.command_id
              AND revision_amendment.amendment_type = source_execution.command_type)
            OR (ledger.entry_type = 'RELEASE'
              AND source_execution.command_type IN (
                'RESCHEDULE_STAY', 'EXTEND_STAY', 'MOVE_UNIT',
                'REPRICE_ORDER', 'REFRESH_MEMBER_COVERAGE', 'CANCEL_ORDER', 'MARK_NO_SHOW'
              )
              AND ledger.reason = 'ORDER_COVERAGE_RELEASE')
            OR (ledger.entry_type = 'CONSUME'
              AND source_execution.command_type IN (
                'CREATE_ORDER', 'CHECK_IN', 'COMPLETE_STAY', 'BACKFILL_COMPLETED_STAY', 'EXTEND_STAY',
                'REPRICE_ORDER', 'REFRESH_MEMBER_COVERAGE'
              )
              AND ledger.reason = CASE
                WHEN source_execution.command_type = 'EXTEND_STAY'
                  THEN 'EXTEND_STAY_ENTITLEMENT_CONSUMED'
                ELSE 'CHECK_IN_ENTITLEMENT_CONSUMED'
              END)
            OR (ledger.entry_type = 'RESTORE'
              AND (
                (source_execution.command_type = 'REVOKE_CHECK_IN'
                  AND ledger.reason = 'REVOKE_CHECK_IN_ENTITLEMENT_RESTORED')
                OR (source_execution.command_type = 'SHORTEN_STAY'
                  AND ledger.reason = 'SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED'
                  AND EXISTS (
                    SELECT 1
                    FROM amendments AS conversion_amendment
                    WHERE conversion_amendment.order_id = ledger.order_id
                      AND conversion_amendment.amendment_type =
                        'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
                  ))
              ))
            OR (ledger.entry_type = 'CONVERSION_CONSUME'
              AND source_execution.command_type = 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
              AND ledger.reason = 'STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED'
              AND revision_amendment.command_id = ledger.command_id
              AND revision_amendment.amendment_type =
                'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
              AND target_order.created_by_command_id = ledger.command_id
              AND target_order.activated_by_command_id = ledger.command_id
              AND source_order.member_id IS NOT DISTINCT FROM NEW.member_id
              AND source_order.member_contract_id = target_contract.id
              AND (
                (source_order.status = 'CHECKED_IN' AND source_stay.status = 'IN_HOUSE')
                OR (source_order.status = 'CHECKED_OUT' AND source_stay.status = 'COMPLETED')
              ))
          )
          OR (source_execution.command_type IN ('CANCEL_ORDER', 'MARK_NO_SHOW', 'REVOKE_CHECK_IN')
            AND (SELECT count(*)
              FROM amendments AS terminal_amendment
              WHERE terminal_amendment.command_id = ledger.command_id
            ) <> 1)
          OR (source_execution.command_type = 'REVOKE_CHECK_IN' AND (
            source_order.status IS DISTINCT FROM 'CHECK_IN_REVOKED'
            OR source_stay.status IS DISTINCT FROM 'CHECK_IN_REVOKED'
            OR NOT EXISTS (
              SELECT 1
              FROM amendments AS revoke_amendment
              WHERE revoke_amendment.command_id = ledger.command_id
                AND revoke_amendment.order_id = ledger.order_id
                AND revoke_amendment.amendment_type = 'REVOKE_CHECK_IN'
                AND jsonb_typeof(revoke_amendment.payload -> 'unusedRoomConfirmed') = 'boolean'
                AND revoke_amendment.payload -> 'unusedRoomConfirmed' = 'true'::jsonb
                AND revoke_amendment.payload ->> 'businessDate' = source_order.arrival_date::text
            )
          ))
        )
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT
          ledger.command_id,
          ledger.order_id,
          min(coverage.held_by_revision_id) AS held_by_revision_id,
          count(DISTINCT coverage.held_by_revision_id)::integer AS revision_count,
          count(*)::integer AS fact_count,
          count(DISTINCT ledger.coverage_id)::integer AS coverage_count,
          count(DISTINCT ledger.service_date)::integer AS service_date_count,
          array_agg(ledger.service_date ORDER BY ledger.service_date, ledger.fact_id)
            AS actual_service_dates
        FROM entitlement_ledger AS ledger
        JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
        WHERE ledger.lot_id = NEW.entitlement_lot_id
          AND ledger.entry_type = 'CONVERSION_CONSUME'
          AND ledger.coverage_id IS NOT NULL
        GROUP BY ledger.command_id, ledger.order_id
      ) AS conversion
      LEFT JOIN command_executions AS source_execution
        ON source_execution.id = conversion.command_id
      LEFT JOIN orders AS source_order ON source_order.id = conversion.order_id
      LEFT JOIN stays AS source_stay ON source_stay.order_id = source_order.id
      LEFT JOIN pricing_revisions AS conversion_revision
        ON conversion_revision.id = conversion.held_by_revision_id
      WHERE source_execution.command_type IS DISTINCT FROM
          'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
        OR source_execution.state IS DISTINCT FROM 'APPLIED'
        OR source_execution.property_id IS DISTINCT FROM NEW.property_id
        OR source_order.id IS NULL
        OR source_order.property_id IS DISTINCT FROM NEW.property_id
        OR source_order.member_id IS DISTINCT FROM NEW.member_id
        OR source_stay.id IS NULL
        OR conversion_revision.id IS NULL
        OR conversion_revision.order_id IS DISTINCT FROM source_order.id
        OR conversion_revision.arrival_date IS DISTINCT FROM source_order.arrival_date
        OR source_order.departure_date > conversion_revision.departure_date
        OR (source_order.departure_date IS DISTINCT FROM conversion_revision.departure_date
          AND NOT EXISTS (
            SELECT 1
            FROM pricing_revisions AS current_revision
            JOIN amendments AS current_amendment
              ON current_amendment.id = current_revision.amendment_id
            JOIN command_executions AS current_execution
              ON current_execution.id = current_amendment.command_id
            WHERE current_revision.id = source_order.current_revision_id
              AND current_revision.order_id = source_order.id
              AND current_revision.arrival_date = source_order.arrival_date
              AND current_revision.departure_date = source_order.departure_date
              AND current_amendment.order_id = source_order.id
              AND current_amendment.amendment_type = 'SHORTEN_STAY'
              AND current_amendment.payload #>> '{after,departureDate}' =
                source_order.departure_date::text
              AND current_execution.command_type = 'SHORTEN_STAY'
              AND current_execution.property_id = NEW.property_id
              AND current_execution.state = 'APPLIED'
              AND qintopia_has_exact_source_amendment_set(
                current_execution.id, current_execution.command_type, source_order.id
              )
              AND EXISTS (
                SELECT 1
                FROM entitlement_ledger AS current_restore
                WHERE current_restore.command_id = current_execution.id
                  AND current_restore.order_id = source_order.id
                  AND current_restore.lot_id = NEW.entitlement_lot_id
                  AND current_restore.entry_type = 'RESTORE'
              )
          ))
        OR conversion_revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
        OR conversion_revision.current_contract_amount_minor IS DISTINCT FROM 0
        OR conversion_revision.manual_adjustment_minor IS DISTINCT FROM 0
        OR conversion_revision.coverage_set IS DISTINCT FROM '[]'::jsonb
        OR conversion_revision.cash_lines IS DISTINCT FROM '[]'::jsonb
        OR conversion.revision_count IS DISTINCT FROM 1
        OR conversion.fact_count IS DISTINCT FROM conversion.coverage_count
        OR conversion.fact_count IS DISTINCT FROM conversion.service_date_count
        OR (SELECT source_receipt.result ->> 'conversionMode'
          FROM command_receipts AS source_receipt
          WHERE source_receipt.command_id = conversion.command_id
        ) IS DISTINCT FROM 'IN_HOUSE'
        OR conversion.actual_service_dates IS DISTINCT FROM ARRAY(
          SELECT conversion_revision.arrival_date + date_offset.value
          FROM generate_series(
            0,
            conversion_revision.departure_date - conversion_revision.arrival_date - 1
          ) AS date_offset(value)
          ORDER BY date_offset.value
        )
        OR (SELECT count(*)
          FROM amendments AS source_amendment
          WHERE source_amendment.command_id = conversion.command_id
            AND source_amendment.order_id = conversion.order_id
            AND source_amendment.amendment_type =
              'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
        ) <> 1
        OR (SELECT count(*)
          FROM pricing_revisions AS source_revision
          JOIN amendments AS source_amendment
            ON source_amendment.id = source_revision.amendment_id
          WHERE source_amendment.command_id = conversion.command_id
        ) <> 1
        OR (SELECT source_amendment.payload #> '{entitlement,serviceDates}'
          FROM amendments AS source_amendment
          WHERE source_amendment.command_id = conversion.command_id
            AND source_amendment.order_id = conversion.order_id
            AND source_amendment.amendment_type =
              'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
        ) IS DISTINCT FROM to_jsonb(conversion.actual_service_dates)
        OR EXISTS (
          SELECT 1 FROM membership_void_reconversions AS unexpected_reconversion
          WHERE unexpected_reconversion.command_id = conversion.command_id
        )
        OR (SELECT count(*)
          FROM coverage_items AS source_coverage
          WHERE source_coverage.order_id = conversion.order_id
            AND source_coverage.lot_id = NEW.entitlement_lot_id
            AND source_coverage.held_by_revision_id = conversion_revision.id
        ) <> conversion.fact_count
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT DISTINCT source_coverage.order_id
        FROM coverage_items AS source_coverage
        JOIN orders AS candidate_order ON candidate_order.id = source_coverage.order_id
        JOIN stays AS candidate_stay ON candidate_stay.order_id = candidate_order.id
        WHERE source_coverage.lot_id = NEW.entitlement_lot_id
          AND (
            candidate_order.status = 'CHECK_IN_REVOKED'
            OR candidate_stay.status = 'CHECK_IN_REVOKED'
            OR EXISTS (
              SELECT 1
              FROM amendments AS candidate_amendment
              WHERE candidate_amendment.order_id = source_coverage.order_id
                AND candidate_amendment.amendment_type = 'REVOKE_CHECK_IN'
            )
          )
      ) AS candidate
      JOIN orders AS source_order ON source_order.id = candidate.order_id
      JOIN stays AS source_stay ON source_stay.order_id = source_order.id
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS amendment_count,
          min(source_amendment.command_id) AS command_id,
          (jsonb_agg(source_amendment.payload ORDER BY source_amendment.id) -> 0) AS payload
        FROM amendments AS source_amendment
        WHERE source_amendment.order_id = candidate.order_id
          AND source_amendment.amendment_type = 'REVOKE_CHECK_IN'
      ) AS revocation
      LEFT JOIN command_executions AS source_execution
        ON source_execution.id = revocation.command_id
      LEFT JOIN command_receipts AS source_receipt
        ON source_receipt.command_id = revocation.command_id
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS command_fact_count,
          count(*) FILTER (
            WHERE restore.order_id = candidate.order_id
              AND restore.lot_id = NEW.entitlement_lot_id
              AND restore.entry_type = 'RESTORE'
              AND restore.coverage_id IS NOT NULL
          )::integer AS fact_count,
          count(DISTINCT restore.coverage_id) FILTER (
            WHERE restore.order_id = candidate.order_id
              AND restore.lot_id = NEW.entitlement_lot_id
              AND restore.entry_type = 'RESTORE'
              AND restore.coverage_id IS NOT NULL
          )::integer AS coverage_count,
          COALESCE(
            jsonb_agg(to_jsonb(restore.fact_id) ORDER BY restore.fact_id) FILTER (
              WHERE restore.order_id = candidate.order_id
                AND restore.lot_id = NEW.entitlement_lot_id
                AND restore.entry_type = 'RESTORE'
                AND restore.coverage_id IS NOT NULL
            ),
            '[]'::jsonb
          ) AS fact_ids,
          COALESCE(
            jsonb_agg(to_jsonb(restore.coverage_id) ORDER BY restore.coverage_id) FILTER (
              WHERE restore.order_id = candidate.order_id
                AND restore.lot_id = NEW.entitlement_lot_id
                AND restore.entry_type = 'RESTORE'
                AND restore.coverage_id IS NOT NULL
            ),
            '[]'::jsonb
          ) AS coverage_ids
        FROM entitlement_ledger AS restore
        WHERE restore.command_id = revocation.command_id
      ) AS restored
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS coverage_count,
          count(*) FILTER (
            WHERE source_coverage.status IS DISTINCT FROM 'CONSUMED'
          )::integer AS invalid_status_count,
          COALESCE(
            jsonb_agg(to_jsonb(source_coverage.id) ORDER BY source_coverage.id),
            '[]'::jsonb
          ) AS coverage_ids
        FROM coverage_items AS source_coverage
        WHERE source_coverage.order_id = candidate.order_id
          AND source_coverage.lot_id = NEW.entitlement_lot_id
          AND EXISTS (
            SELECT 1
            FROM entitlement_ledger AS consumed
            WHERE consumed.coverage_id = source_coverage.id
              AND consumed.lot_id = NEW.entitlement_lot_id
              AND consumed.order_id = candidate.order_id
              AND consumed.entry_type = 'CONSUME'
          )
      ) AS original_coverage
      WHERE source_order.property_id IS DISTINCT FROM NEW.property_id
        OR (source_order.member_id IS NOT NULL
          AND source_order.member_id IS DISTINCT FROM NEW.member_id)
        OR source_order.member_contract_id IS DISTINCT FROM target_contract.id
        OR source_order.status IS DISTINCT FROM 'CHECK_IN_REVOKED'
        OR source_stay.status IS DISTINCT FROM 'CHECK_IN_REVOKED'
        OR revocation.amendment_count IS DISTINCT FROM 1
        OR revocation.command_id IS NULL
        OR source_execution.id IS NULL
        OR source_execution.command_type IS DISTINCT FROM 'REVOKE_CHECK_IN'
        OR source_execution.property_id IS DISTINCT FROM NEW.property_id
        OR source_execution.state IS DISTINCT FROM 'APPLIED'
        OR qintopia_has_exact_source_amendment_set(
          revocation.command_id, 'REVOKE_CHECK_IN', candidate.order_id
        ) IS DISTINCT FROM true
        OR jsonb_typeof(revocation.payload -> 'unusedRoomConfirmed') IS DISTINCT FROM 'boolean'
        OR revocation.payload -> 'unusedRoomConfirmed' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(revocation.payload -> 'businessDate') IS DISTINCT FROM 'string'
        OR revocation.payload ->> 'businessDate' IS DISTINCT FROM source_order.arrival_date::text
        OR source_receipt.execution_status IS DISTINCT FROM 'EXECUTED'
        OR source_receipt.business_committed IS DISTINCT FROM true
        OR jsonb_typeof(source_receipt.result #> '{entitlementTransition,from}')
          IS DISTINCT FROM 'string'
        OR source_receipt.result #>> '{entitlementTransition,from}'
          IS DISTINCT FROM 'CONSUMED'
        OR jsonb_typeof(source_receipt.result #> '{entitlementTransition,to}')
          IS DISTINCT FROM 'string'
        OR source_receipt.result #>> '{entitlementTransition,to}'
          IS DISTINCT FROM 'RESTORED'
        OR jsonb_typeof(source_receipt.result #> '{entitlementTransition,coverageCount}')
          IS DISTINCT FROM 'number'
        OR source_receipt.result #>> '{entitlementTransition,coverageCount}'
          IS DISTINCT FROM restored.fact_count::text
        OR jsonb_typeof(source_receipt.fact_refs) IS DISTINCT FROM 'array'
        OR jsonb_array_length(source_receipt.fact_refs) IS DISTINCT FROM restored.fact_count
        OR NOT source_receipt.fact_refs @> restored.fact_ids
        OR NOT restored.fact_ids @> source_receipt.fact_refs
        OR jsonb_typeof(source_receipt.resource_refs) IS DISTINCT FROM 'array'
        OR NOT source_receipt.resource_refs @> original_coverage.coverage_ids
        OR restored.command_fact_count IS DISTINCT FROM restored.fact_count
        OR restored.fact_count IS DISTINCT FROM restored.coverage_count
        OR original_coverage.coverage_count = 0
        OR restored.coverage_count IS DISTINCT FROM original_coverage.coverage_count
        OR restored.coverage_ids IS DISTINCT FROM original_coverage.coverage_ids
        OR original_coverage.invalid_status_count IS DISTINCT FROM 0
        OR (SELECT count(*)
          FROM audit_entries AS source_audit
          WHERE source_audit.command_id = revocation.command_id
            AND source_audit.decision = 'ALLOWED'
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM audit_entries AS source_audit
          WHERE source_audit.command_id = revocation.command_id
            AND source_audit.subject_id = source_execution.subject_id
            AND source_audit.credential_id = source_execution.credential_id
            AND source_audit.action = source_execution.command_type
            AND source_audit.decision = 'ALLOWED'
            AND source_audit.correlation_id = source_execution.correlation_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT DISTINCT ledger.command_id, ledger.order_id
        FROM entitlement_ledger AS ledger
        LEFT JOIN coverage_items AS coverage ON coverage.id = ledger.coverage_id
        LEFT JOIN command_executions AS source_execution
          ON source_execution.id = ledger.command_id
        WHERE (ledger.lot_id = NEW.entitlement_lot_id
            OR coverage.lot_id = NEW.entitlement_lot_id)
          AND ledger.entry_type = 'RESTORE'
          AND ledger.coverage_id IS NOT NULL
          AND source_execution.command_type = 'SHORTEN_STAY'
      ) AS shortening
      JOIN amendments AS source_amendment
        ON source_amendment.command_id = shortening.command_id
        AND source_amendment.order_id = shortening.order_id
        AND source_amendment.amendment_type = 'SHORTEN_STAY'
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS fact_count,
          count(DISTINCT restore.service_date)::integer AS service_date_count,
          COALESCE(
            jsonb_agg(
              to_jsonb(restore.service_date::text)
              ORDER BY restore.service_date, restore.fact_id
            ),
            '[]'::jsonb
          ) AS service_dates
        FROM entitlement_ledger AS restore
        WHERE restore.command_id = shortening.command_id
          AND restore.order_id = shortening.order_id
          AND restore.entry_type = 'RESTORE'
      ) AS restored
      WHERE (SELECT count(*)
          FROM amendments AS duplicate_amendment
          WHERE duplicate_amendment.command_id = shortening.command_id
            AND duplicate_amendment.order_id = shortening.order_id
            AND duplicate_amendment.amendment_type = 'SHORTEN_STAY'
        ) <> 1
        OR (SELECT count(*)
          FROM amendments AS conversion_amendment
          WHERE conversion_amendment.order_id = shortening.order_id
            AND conversion_amendment.amendment_type =
              'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP'
        ) <> 1
        OR jsonb_typeof(
          source_amendment.payload #> '{entitlementSummary,restoredFutureCoverageDates}'
        ) IS DISTINCT FROM 'array'
        OR jsonb_typeof(
          source_amendment.payload #> '{inventoryChange,releasedDates}'
        ) IS DISTINCT FROM 'array'
        OR source_amendment.payload #> '{entitlementSummary,restoredFutureCoverageDates}'
          IS DISTINCT FROM source_amendment.payload #> '{inventoryChange,releasedDates}'
        OR source_amendment.payload #> '{entitlementSummary,restoredFutureCoverageDates}'
          IS DISTINCT FROM restored.service_dates
        OR source_amendment.payload #>> '{entitlementSummary,ledgerWriteCount}'
          IS DISTINCT FROM restored.fact_count::text
        OR restored.fact_count IS DISTINCT FROM restored.service_date_count
        OR jsonb_typeof(source_amendment.payload -> 'businessDate') IS DISTINCT FROM 'string'
        OR source_amendment.payload ->> 'businessDate' !~ '^\d{4}-\d{2}-\d{2}$'
        OR NOT pg_catalog.pg_input_is_valid(
          source_amendment.payload ->> 'businessDate', 'date'
        )
        OR jsonb_typeof(source_amendment.payload #> '{after,departureDate}') IS DISTINCT FROM 'string'
        OR source_amendment.payload #>> '{after,departureDate}' !~ '^\d{4}-\d{2}-\d{2}$'
        OR NOT pg_catalog.pg_input_is_valid(
          source_amendment.payload #>> '{after,departureDate}', 'date'
        )
        OR EXISTS (
          SELECT 1
          FROM entitlement_ledger AS restore
          LEFT JOIN coverage_items AS restored_coverage
            ON restored_coverage.id = restore.coverage_id
          WHERE restore.command_id = shortening.command_id
            AND restore.order_id = shortening.order_id
            AND restore.entry_type = 'RESTORE'
            AND (
              restore.service_date < CASE
                WHEN pg_catalog.pg_input_is_valid(
                  source_amendment.payload ->> 'businessDate', 'date'
                ) THEN (source_amendment.payload ->> 'businessDate')::date
              END
              OR restore.service_date < CASE
                WHEN pg_catalog.pg_input_is_valid(
                  source_amendment.payload #>> '{after,departureDate}', 'date'
                ) THEN (source_amendment.payload #>> '{after,departureDate}')::date
              END
              OR restored_coverage.id IS NULL
              OR restored_coverage.status IS DISTINCT FROM 'RELEASED'
              OR restored_coverage.order_id IS DISTINCT FROM shortening.order_id
              OR restored_coverage.lot_id IS DISTINCT FROM restore.lot_id
              OR restored_coverage.service_date IS DISTINCT FROM restore.service_date
              OR (SELECT count(*)
                FROM entitlement_ledger AS consumed
                WHERE consumed.coverage_id = restore.coverage_id
                  AND consumed.entry_type IN ('CONSUME', 'CONVERSION_CONSUME')
              ) <> 1
            )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      LEFT JOIN orders AS coverage_order ON coverage_order.id = coverage.order_id
      LEFT JOIN inventory_units AS coverage_inventory
        ON coverage_inventory.id = coverage.inventory_unit_id
      LEFT JOIN pricing_revisions AS coverage_revision
        ON coverage_revision.id = coverage.held_by_revision_id
      WHERE coverage.lot_id = NEW.entitlement_lot_id
        AND (
          coverage_order.id IS NULL
          OR coverage_inventory.id IS NULL
          OR coverage_revision.id IS NULL
          OR coverage.contract_id IS DISTINCT FROM target_contract.id
          OR coverage_order.property_id IS DISTINCT FROM NEW.property_id
          OR coverage_inventory.property_id IS DISTINCT FROM NEW.property_id
          OR coverage.unit_kind IS DISTINCT FROM target_lot.unit_kind
          OR coverage.unit_kind IS DISTINCT FROM target_order.entitlement_unit_kind
          OR coverage.unit_kind IS DISTINCT FROM (
            CASE coverage_inventory.kind WHEN 'ROOM' THEN 'ROOM_NIGHT' ELSE 'BED_NIGHT' END
          )
          OR coverage_revision.order_id IS DISTINCT FROM coverage.order_id
          OR coverage.service_date < coverage_revision.arrival_date
          OR coverage.service_date >= coverage_revision.departure_date
          OR (coverage_order.member_id IS NOT NULL
            AND coverage_order.member_id IS DISTINCT FROM NEW.member_id)
          OR coverage_order.member_contract_id IS DISTINCT FROM target_contract.id
          OR coverage_inventory.kind IS DISTINCT FROM target_order.allowed_inventory_kind
          OR coverage_inventory.room_type_code IS DISTINCT FROM target_order.allowed_room_type_code
          OR coverage.service_date < NEW.corrected_valid_from
          OR coverage.service_date > NEW.corrected_valid_until
        )
    )
    OR EXISTS (
      SELECT 1
      FROM coverage_items AS coverage
      CROSS JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE ledger.entry_type = 'HOLD')::integer AS hold_count,
          count(*) FILTER (WHERE ledger.entry_type = 'RELEASE')::integer AS release_count,
          count(*) FILTER (WHERE ledger.entry_type = 'CONSUME')::integer AS consume_count,
          count(*) FILTER (WHERE ledger.entry_type = 'RESTORE')::integer AS restore_count,
          count(*) FILTER (
            WHERE ledger.entry_type = 'CONVERSION_CONSUME'
          )::integer AS conversion_consume_count
        FROM entitlement_ledger AS ledger
        WHERE ledger.coverage_id = coverage.id
      ) AS lifecycle
      WHERE coverage.lot_id = NEW.entitlement_lot_id
        AND NOT (
          (coverage.status = 'HELD'
            AND lifecycle.hold_count = 1
            AND lifecycle.release_count = 0
            AND lifecycle.consume_count = 0
            AND lifecycle.restore_count = 0
            AND lifecycle.conversion_consume_count = 0)
          OR (coverage.status = 'CONSUMED' AND (
            (lifecycle.hold_count = 1
              AND lifecycle.release_count = 0
              AND lifecycle.consume_count = 1
              AND lifecycle.restore_count = 0
              AND lifecycle.conversion_consume_count = 0)
            OR (lifecycle.hold_count = 1
              AND lifecycle.release_count = 0
              AND lifecycle.consume_count = 1
              AND lifecycle.restore_count = 1
              AND lifecycle.conversion_consume_count = 0)
            OR (lifecycle.hold_count = 0
              AND lifecycle.release_count = 0
              AND lifecycle.consume_count = 0
              AND lifecycle.restore_count = 0
              AND lifecycle.conversion_consume_count = 1)
          ))
          OR (coverage.status = 'RELEASED' AND (
            (lifecycle.hold_count = 1
              AND lifecycle.release_count = 1
              AND lifecycle.consume_count = 0
              AND lifecycle.restore_count = 0
              AND lifecycle.conversion_consume_count = 0)
            OR (lifecycle.hold_count = 1
              AND lifecycle.release_count = 0
              AND lifecycle.consume_count = 1
              AND lifecycle.restore_count = 1
              AND lifecycle.conversion_consume_count = 0)
            OR (lifecycle.hold_count = 0
              AND lifecycle.release_count = 0
              AND lifecycle.consume_count = 0
              AND lifecycle.restore_count = 1
              AND lifecycle.conversion_consume_count = 1)
          ))
        )
    )
    OR EXISTS (
      SELECT 1 FROM membership_payment_facts AS payment
      WHERE payment.command_id = NEW.command_id
    )
    OR EXISTS (
      SELECT 1 FROM entitlement_ledger AS ledger
      WHERE ledger.command_id = NEW.command_id
    )
    OR (SELECT count(*) FROM membership_orders WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM membership_orders
      WHERE id = NEW.membership_order_id AND xmin = current_xid)
    OR (SELECT count(*) FROM member_contracts WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM member_contracts
      WHERE id = NEW.contract_id AND xmin = current_xid)
    OR (SELECT count(*) FROM entitlement_lots WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM entitlement_lots
      WHERE id = NEW.entitlement_lot_id AND xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_profile_corrections WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM historical_membership_backfills WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_payment_reclassifications WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_void_reconversions WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM members WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_payment_facts WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM orders WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stays WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_segments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM amendments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM pricing_revisions WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM coverage_items WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_collection_membership_transfers WHERE xmin = current_xid) THEN
    RAISE EXCEPTION 'membership date correction must preserve one exact active chain'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_effective_date_correction_exact_chain';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER membership_effective_date_corrections_validate_graph
AFTER INSERT ON membership_effective_date_corrections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_effective_date_correction();

CREATE OR REPLACE FUNCTION qintopia_validate_historical_membership_backfill()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_execution command_executions%ROWTYPE;
  target_audit audit_entries%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  target_member members%ROWTYPE;
  target_order membership_orders%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  target_payment membership_payment_facts%ROWTYPE;
  target_product membership_products%ROWTYPE;
  allowed_audit_count integer;
  preview_count integer;
  property_today date;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  SELECT * INTO target_execution FROM command_executions WHERE id = NEW.command_id;
  SELECT count(*)::integer INTO allowed_audit_count
    FROM audit_entries
    WHERE command_id = NEW.command_id
      AND decision = 'ALLOWED';
  IF allowed_audit_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'historical membership backfill requires one authoritative Preview audit'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_membership_backfill_preview_binding';
  END IF;
  SELECT * INTO target_audit
    FROM audit_entries
    WHERE command_id = NEW.command_id
      AND decision = 'ALLOWED';
  SELECT count(*)::integer INTO preview_count
    FROM command_previews
    WHERE id = target_audit.metadata ->> 'previewId';
  IF preview_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'historical membership backfill requires one immutable Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_membership_backfill_preview_binding';
  END IF;
  SELECT * INTO target_preview
    FROM command_previews
    WHERE id = target_audit.metadata ->> 'previewId';
  SELECT * INTO target_member FROM members WHERE id = NEW.member_id;
  SELECT * INTO target_order FROM membership_orders WHERE id = NEW.membership_order_id;
  SELECT * INTO target_contract FROM member_contracts WHERE id = NEW.contract_id;
  SELECT * INTO target_lot FROM entitlement_lots WHERE id = NEW.entitlement_lot_id;
  SELECT * INTO target_payment FROM membership_payment_facts WHERE fact_id = NEW.payment_fact_id;
  SELECT * INTO target_product FROM membership_products WHERE id = target_order.product_id;
  SELECT (transaction_timestamp() AT TIME ZONE timezone)::date
    INTO property_today
  FROM properties WHERE id = NEW.property_id;

  IF target_execution.id IS NULL
    OR target_execution.property_id IS DISTINCT FROM NEW.property_id
    OR target_execution.command_type IS DISTINCT FROM 'BACKFILL_HISTORICAL_MEMBERSHIP'
    OR target_execution.state IS DISTINCT FROM 'APPLIED'
    OR target_audit.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_audit.credential_id IS DISTINCT FROM target_execution.credential_id
    OR target_audit.action IS DISTINCT FROM target_execution.command_type
    OR target_audit.correlation_id IS DISTINCT FROM target_execution.correlation_id
    OR target_audit.metadata ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_preview.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_preview.property_id IS DISTINCT FROM target_execution.property_id
    OR target_preview.command_type IS DISTINCT FROM target_execution.command_type
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.effect ->> 'operation' IS DISTINCT FROM 'BACKFILL_HISTORICAL_MEMBERSHIP'
    OR target_preview.effect #>> '{member,memberId}' IS DISTINCT FROM NEW.member_id
    OR target_preview.effect #>> '{member,fullName}' IS DISTINCT FROM target_member.full_name
    OR target_preview.effect #>> '{member,fullName}' IS DISTINCT FROM target_contract.member_name
    OR target_preview.effect #>> '{product,productId}' IS DISTINCT FROM NEW.product_id
    OR target_preview.effect #>> '{product,code}' IS DISTINCT FROM NEW.product_code
    OR target_preview.effect #>> '{product,version}' IS DISTINCT FROM NEW.product_version::text
    OR target_preview.effect #>> '{product,name}' IS DISTINCT FROM NEW.product_name
    OR target_preview.effect #>> '{product,listedPrice,minorUnits}' IS DISTINCT FROM NEW.listed_price_minor::text
    OR target_preview.effect #>> '{product,listedPrice,currency}' IS DISTINCT FROM NEW.currency::text
    OR target_preview.effect #>> '{product,agreedPrice,minorUnits}' IS DISTINCT FROM NEW.agreed_price_minor::text
    OR target_preview.effect #>> '{product,agreedPrice,currency}' IS DISTINCT FROM NEW.currency::text
    OR target_preview.effect #>> '{product,entitlementUnitKind}' IS DISTINCT FROM NEW.entitlement_unit_kind
    OR target_preview.effect #>> '{product,entitlementUnits}' IS DISTINCT FROM NEW.entitlement_units::text
    OR target_preview.effect #>> '{product,validityPeriod}' IS DISTINCT FROM NEW.validity_period
    OR target_preview.effect #>> '{product,allowedRoomTypeCode}' IS DISTINCT FROM NEW.allowed_room_type_code
    OR target_preview.effect #>> '{product,allowedInventoryKind}' IS DISTINCT FROM NEW.allowed_inventory_kind
    OR target_preview.effect #>> '{payment,amount,minorUnits}' IS DISTINCT FROM target_payment.amount_minor::text
    OR target_preview.effect #>> '{payment,amount,currency}' IS DISTINCT FROM target_payment.currency::text
    OR target_preview.effect #>> '{payment,businessDate}' IS DISTINCT FROM NEW.business_date::text
    OR target_preview.effect #>> '{payment,transactionReference}' IS DISTINCT FROM NEW.transaction_reference
    OR target_preview.effect #>> '{payment,note}' IS DISTINCT FROM target_payment.note
    OR target_preview.effect ->> 'validFrom' IS DISTINCT FROM NEW.actual_membership_date::text
    OR target_preview.effect ->> 'validUntil' IS DISTINCT FROM NEW.valid_until::text
    OR target_preview.effect ->> 'entitlementUnitKind' IS DISTINCT FROM NEW.entitlement_unit_kind
    OR target_preview.effect ->> 'entitlementUnits' IS DISTINCT FROM NEW.entitlement_units::text
    OR target_preview.effect ->> 'status' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.effect ->> 'evidenceNote' IS DISTINCT FROM NEW.evidence_note
    OR NEW.agreed_price_minor IS DISTINCT FROM NEW.listed_price_minor
    OR target_order.price_adjustment_minor IS DISTINCT FROM 0
    OR target_order.price_adjustment_reason IS NOT NULL THEN
    RAISE EXCEPTION 'historical membership backfill must match the product, payment, dates, and entitlement facts frozen in its Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_membership_backfill_preview_binding';
  END IF;

  IF NOT qintopia_has_typed_runtime_command_evidence(
      NEW.command_id,
      'BACKFILL_HISTORICAL_MEMBERSHIP',
      NEW.property_id
    )
    OR target_order.id IS NULL
    OR target_contract.id IS NULL
    OR target_lot.id IS NULL
    OR target_payment.fact_id IS NULL
    OR target_product.id IS NULL
    OR target_order.created_by_command_id IS DISTINCT FROM NEW.command_id
    OR target_order.activated_by_command_id IS DISTINCT FROM NEW.command_id
    OR target_order.property_id IS DISTINCT FROM NEW.property_id
    OR target_order.member_id IS DISTINCT FROM NEW.member_id
    OR target_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_order.contract_id IS DISTINCT FROM target_contract.id
    OR target_order.entitlement_lot_id IS DISTINCT FROM target_lot.id
    OR target_order.valid_from IS DISTINCT FROM NEW.actual_membership_date
    OR target_order.valid_until IS DISTINCT FROM NEW.valid_until
    OR target_order.product_id IS DISTINCT FROM NEW.product_id
    OR target_order.product_code IS DISTINCT FROM NEW.product_code
    OR target_order.product_version IS DISTINCT FROM NEW.product_version
    OR target_order.product_name IS DISTINCT FROM NEW.product_name
    OR target_order.listed_price_minor IS DISTINCT FROM NEW.listed_price_minor
    OR target_order.agreed_price_minor IS DISTINCT FROM NEW.agreed_price_minor
    OR target_order.currency IS DISTINCT FROM NEW.currency
    OR target_order.entitlement_unit_kind IS DISTINCT FROM NEW.entitlement_unit_kind
    OR target_order.entitlement_units IS DISTINCT FROM NEW.entitlement_units
    OR target_order.allowed_room_type_code IS DISTINCT FROM NEW.allowed_room_type_code
    OR target_order.allowed_inventory_kind IS DISTINCT FROM NEW.allowed_inventory_kind
    OR target_product.id IS DISTINCT FROM NEW.product_id
    OR NEW.validity_period IS DISTINCT FROM 'P1Y'
    OR target_order.product_code IS DISTINCT FROM target_product.code
    OR target_order.product_version IS DISTINCT FROM target_product.version
    OR target_order.product_name IS DISTINCT FROM target_product.name
    OR target_order.listed_price_minor IS DISTINCT FROM target_product.list_price_minor
    OR target_order.agreed_price_minor IS DISTINCT FROM target_product.list_price_minor
    OR NEW.listed_price_minor IS DISTINCT FROM target_product.list_price_minor
    OR NEW.agreed_price_minor IS DISTINCT FROM target_product.list_price_minor
    OR target_order.price_adjustment_minor IS DISTINCT FROM 0
    OR target_order.price_adjustment_reason IS NOT NULL
    OR target_order.currency IS DISTINCT FROM target_product.currency
    OR target_order.entitlement_unit_kind IS DISTINCT FROM target_product.entitlement_unit_kind
    OR target_order.entitlement_units IS DISTINCT FROM target_product.entitlement_units
    OR target_order.allowed_room_type_code IS DISTINCT FROM target_product.allowed_room_type_code
    OR target_order.allowed_inventory_kind IS DISTINCT FROM target_product.allowed_inventory_kind
    OR target_product.validity_period IS DISTINCT FROM NEW.validity_period
    OR target_product.status IS DISTINCT FROM 'PUBLISHED'
    OR target_contract.property_id IS DISTINCT FROM NEW.property_id
    OR target_contract.member_id IS DISTINCT FROM NEW.member_id
    OR target_contract.membership_order_id IS DISTINCT FROM target_order.id
    OR target_contract.status IS DISTINCT FROM 'ACTIVE'
    OR target_contract.valid_from IS DISTINCT FROM NEW.actual_membership_date
    OR target_contract.valid_until IS DISTINCT FROM NEW.valid_until
    OR target_lot.contract_id IS DISTINCT FROM target_contract.id
    OR target_lot.status IS DISTINCT FROM 'ACTIVE'
    OR target_lot.unit_kind IS DISTINCT FROM target_order.entitlement_unit_kind
    OR target_lot.total_units IS DISTINCT FROM target_order.entitlement_units
    OR target_lot.expires_on IS DISTINCT FROM NEW.valid_until
    OR target_payment.membership_order_id IS DISTINCT FROM target_order.id
    OR target_payment.command_id IS DISTINCT FROM NEW.command_id
    OR target_payment.fact_type IS DISTINCT FROM 'COLLECTION'
    OR target_payment.source_type IS DISTINCT FROM 'DIRECT_WECOM'
    OR target_payment.amount_minor <= 0
    OR target_payment.net_effect_minor IS DISTINCT FROM target_payment.amount_minor
    OR target_payment.currency IS DISTINCT FROM target_order.currency
    OR target_payment.transaction_reference IS DISTINCT FROM NEW.transaction_reference
    OR NEW.transaction_reference IS DISTINCT FROM regexp_replace(
      btrim(NEW.transaction_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    )
    OR target_payment.business_date IS DISTINCT FROM NEW.business_date
    OR target_payment.corrects_fact_id IS NOT NULL
    OR target_payment.reverses_fact_id IS NOT NULL
    OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
    OR target_order.created_at IS DISTINCT FROM transaction_timestamp()
    OR target_contract.created_at IS DISTINCT FROM transaction_timestamp()
    OR target_lot.created_at IS DISTINCT FROM transaction_timestamp()
    OR target_payment.created_at IS DISTINCT FROM transaction_timestamp()
    OR NEW.valid_until IS DISTINCT FROM (NEW.actual_membership_date + interval '1 year')::date
    OR NEW.actual_membership_date > property_today
    OR NEW.valid_until < property_today
    OR NEW.business_date > property_today
    OR (SELECT count(*) FROM membership_payment_facts WHERE membership_order_id = target_order.id) <> 1
    OR (SELECT count(*) FROM membership_orders
        WHERE member_id = NEW.member_id
          AND property_id = NEW.property_id
          AND status <> 'VOIDED') <> 1
    OR (SELECT count(*) FROM member_contracts
        WHERE member_id = NEW.member_id
          AND property_id = NEW.property_id
          AND status = 'ACTIVE') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM member_contracts
      WHERE id = target_contract.id
        AND member_id = NEW.member_id
        AND property_id = NEW.property_id
        AND status = 'ACTIVE'
    )
    OR (SELECT count(*)
        FROM entitlement_lots AS active_lot
        JOIN member_contracts AS owning_contract
          ON owning_contract.id = active_lot.contract_id
        WHERE owning_contract.member_id = NEW.member_id
          AND owning_contract.property_id = NEW.property_id
          AND active_lot.status = 'ACTIVE') <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM entitlement_lots AS active_lot
      JOIN member_contracts AS owning_contract
        ON owning_contract.id = active_lot.contract_id
      WHERE active_lot.id = target_lot.id
        AND owning_contract.member_id = NEW.member_id
        AND owning_contract.property_id = NEW.property_id
        AND active_lot.status = 'ACTIVE'
    )
    OR NOT EXISTS (
      SELECT 1 FROM member_property_links
      WHERE member_id = NEW.member_id
        AND property_id = NEW.property_id
        AND xmin IS DISTINCT FROM current_xid
    )
    OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE lot_id = target_lot.id)
    OR EXISTS (SELECT 1 FROM coverage_items WHERE lot_id = target_lot.id)
    OR EXISTS (
      SELECT 1
      FROM membership_payment_facts AS other_payment
      WHERE other_payment.fact_id <> target_payment.fact_id
        AND other_payment.transaction_reference = NEW.transaction_reference
    )
    OR EXISTS (
      SELECT 1
      FROM collection_facts AS lodging_payment
      WHERE lodging_payment.transaction_reference = NEW.transaction_reference
    )
    OR (SELECT count(*) FROM membership_orders WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM membership_orders
      WHERE id = NEW.membership_order_id
        AND created_by_command_id = NEW.command_id
        AND activated_by_command_id = NEW.command_id
        AND xmin = current_xid)
    OR (SELECT count(*) FROM member_contracts WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM member_contracts
      WHERE id = NEW.contract_id AND xmin = current_xid)
    OR (SELECT count(*) FROM entitlement_lots WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM entitlement_lots
      WHERE id = NEW.entitlement_lot_id AND xmin = current_xid)
    OR (SELECT count(*) FROM membership_payment_facts WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM membership_payment_facts
      WHERE fact_id = NEW.payment_fact_id AND command_id = NEW.command_id AND xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_profile_corrections WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_effective_date_corrections WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_payment_reclassifications WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_void_reconversions WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM members WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM entitlement_ledger WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM orders WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stays WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_segments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM amendments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM pricing_revisions WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM coverage_items WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM collection_facts WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_collection_membership_transfers WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_property_links WHERE xmin = current_xid) THEN
    RAISE EXCEPTION 'historical membership backfill must create one exact current recording'
      USING ERRCODE = '23514', CONSTRAINT = 'historical_membership_backfill_exact_chain';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER historical_membership_backfills_validate_graph
AFTER INSERT ON historical_membership_backfills
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_historical_membership_backfill();

CREATE OR REPLACE FUNCTION qintopia_guard_runtime_membership_projection_update_050()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
  target_command_type text;
  target_property_id text;
  target_member_id text;
  projection_kind text;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF current_user IS DISTINCT FROM 'qintopia_runtime'
    OR session_user IS DISTINCT FROM 'qintopia_runtime' THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'membership_orders' THEN
      target_property_id := NEW.property_id;
      target_member_id := NEW.member_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'runtime membership order version must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_orders_runtime_version_chain';
      END IF;

      SELECT correction.command_id
        INTO target_command_id
      FROM membership_effective_date_corrections AS correction
      WHERE correction.membership_order_id = NEW.id
        AND correction.xmin = current_xid
        AND correction.prior_order_version = OLD.version
        AND correction.prior_valid_from = OLD.valid_from
        AND correction.prior_valid_until = OLD.valid_until
        AND correction.corrected_valid_from = NEW.valid_from
        AND correction.corrected_valid_until = NEW.valid_until
      LIMIT 1;
      IF target_command_id IS NOT NULL THEN
        projection_kind := 'membership-date-correction';
      ELSE
        SELECT correction.command_id
          INTO target_command_id
        FROM membership_void_reconversions AS correction
        WHERE correction.old_membership_order_id = NEW.id
          AND correction.xmin = current_xid
          AND OLD.status = 'ACTIVE'
          AND NEW.status = 'VOIDED'
        LIMIT 1;
        IF target_command_id IS NOT NULL THEN
          projection_kind := 'membership-void';
        ELSIF NEW.activated_by_command_id IS DISTINCT FROM OLD.activated_by_command_id THEN
          target_command_id := NEW.activated_by_command_id;
          projection_kind := 'membership-activation';
        ELSE
          SELECT fact.command_id
            INTO target_command_id
          FROM membership_payment_facts AS fact
          WHERE fact.membership_order_id = NEW.id
            AND fact.xmin = current_xid
          ORDER BY fact.created_at DESC, fact.fact_id DESC
          LIMIT 1;
          projection_kind := 'membership-payment';
        END IF;
      END IF;

      IF projection_kind = 'membership-payment'
        AND ROW(
          NEW.status,
          NEW.activated_at,
          NEW.valid_from,
          NEW.valid_until,
          NEW.contract_id,
          NEW.entitlement_lot_id,
          NEW.activated_by_command_id
        ) IS DISTINCT FROM ROW(
          OLD.status,
          OLD.activated_at,
          OLD.valid_from,
          OLD.valid_until,
          OLD.contract_id,
          OLD.entitlement_lot_id,
          OLD.activated_by_command_id
        ) THEN
        RAISE EXCEPTION 'runtime membership payment may only advance order version metadata'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_orders_runtime_payment_columns';
      ELSIF projection_kind = 'membership-activation'
        AND (OLD.status IS DISTINCT FROM 'DRAFT' OR NEW.status IS DISTINCT FROM 'ACTIVE') THEN
        RAISE EXCEPTION 'runtime membership activation must transition one draft order to active'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_orders_runtime_activation_columns';
      ELSIF projection_kind = 'membership-date-correction'
        AND ROW(
          NEW.status,
          NEW.activated_at,
          NEW.contract_id,
          NEW.entitlement_lot_id,
          NEW.activated_by_command_id
        ) IS DISTINCT FROM ROW(
          OLD.status,
          OLD.activated_at,
          OLD.contract_id,
          OLD.entitlement_lot_id,
          OLD.activated_by_command_id
        ) THEN
        RAISE EXCEPTION 'runtime membership date correction may only change dates and version metadata'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_orders_runtime_date_columns';
      ELSIF projection_kind = 'membership-void'
        AND (
          OLD.status IS DISTINCT FROM 'ACTIVE'
          OR NEW.status IS DISTINCT FROM 'VOIDED'
          OR ROW(
            NEW.activated_at,
            NEW.valid_from,
            NEW.valid_until,
            NEW.contract_id,
            NEW.entitlement_lot_id,
            NEW.activated_by_command_id
          ) IS DISTINCT FROM ROW(
            OLD.activated_at,
            OLD.valid_from,
            OLD.valid_until,
            OLD.contract_id,
            OLD.entitlement_lot_id,
            OLD.activated_by_command_id
          )
        ) THEN
        RAISE EXCEPTION 'runtime membership void may only change status and version metadata'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_orders_runtime_void_columns';
      END IF;

    WHEN 'member_contracts' THEN
      target_property_id := NEW.property_id;
      target_member_id := NEW.member_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'runtime member contract version must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_runtime_version_chain';
      END IF;
      SELECT correction.command_id
        INTO target_command_id
      FROM membership_effective_date_corrections AS correction
      WHERE correction.contract_id = NEW.id
        AND correction.xmin = current_xid
        AND correction.prior_contract_version = OLD.version
        AND correction.prior_valid_from = OLD.valid_from
        AND correction.prior_valid_until = OLD.valid_until
        AND correction.corrected_valid_from = NEW.valid_from
        AND correction.corrected_valid_until = NEW.valid_until
      LIMIT 1;
      IF target_command_id IS NOT NULL THEN
        projection_kind := 'membership-date-correction';
      ELSE
        SELECT correction.command_id
          INTO target_command_id
        FROM membership_void_reconversions AS correction
        WHERE correction.old_contract_id = NEW.id
          AND correction.xmin = current_xid
          AND correction.prior_old_contract_version = OLD.version
          AND OLD.status = 'ACTIVE'
          AND NEW.status = 'VOIDED'
        LIMIT 1;
        IF target_command_id IS NOT NULL THEN
          projection_kind := 'membership-void';
        ELSE
          SELECT ledger.command_id
            INTO target_command_id
          FROM entitlement_ledger AS ledger
          JOIN entitlement_lots AS lot ON lot.id = ledger.lot_id
          WHERE lot.contract_id = NEW.id
            AND ledger.xmin = current_xid
          ORDER BY ledger.created_at DESC, ledger.fact_id DESC
          LIMIT 1;
          projection_kind := 'entitlement-version';
        END IF;
      END IF;

      IF projection_kind = 'membership-date-correction'
        AND ROW(
          NEW.id,
          NEW.property_id,
          NEW.member_id,
          NEW.member_name,
          NEW.status,
          NEW.membership_order_id,
          NEW.created_at
        ) IS DISTINCT FROM ROW(
          OLD.id,
          OLD.property_id,
          OLD.member_id,
          OLD.member_name,
          OLD.status,
          OLD.membership_order_id,
          OLD.created_at
        ) THEN
        RAISE EXCEPTION 'runtime membership date correction may only change contract dates and version'
          USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_runtime_date_columns';
      ELSIF projection_kind = 'membership-void'
        AND (
          OLD.status IS DISTINCT FROM 'ACTIVE'
          OR NEW.status IS DISTINCT FROM 'VOIDED'
          OR ROW(
            NEW.id,
            NEW.property_id,
            NEW.member_id,
            NEW.member_name,
            NEW.valid_from,
            NEW.valid_until,
            NEW.membership_order_id,
            NEW.created_at
          ) IS DISTINCT FROM ROW(
            OLD.id,
            OLD.property_id,
            OLD.member_id,
            OLD.member_name,
            OLD.valid_from,
            OLD.valid_until,
            OLD.membership_order_id,
            OLD.created_at
          )
        ) THEN
        RAISE EXCEPTION 'runtime membership void may only change contract status and version'
          USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_runtime_void_columns';
      ELSIF projection_kind = 'entitlement-version'
        AND (
          OLD.status IS DISTINCT FROM 'ACTIVE'
          OR NEW.status IS DISTINCT FROM 'ACTIVE'
          OR ROW(
            NEW.id,
            NEW.property_id,
            NEW.member_id,
            NEW.member_name,
            NEW.status,
            NEW.valid_from,
            NEW.valid_until,
            NEW.membership_order_id,
            NEW.created_at
          ) IS DISTINCT FROM ROW(
            OLD.id,
            OLD.property_id,
            OLD.member_id,
            OLD.member_name,
            OLD.status,
            OLD.valid_from,
            OLD.valid_until,
            OLD.membership_order_id,
            OLD.created_at
          )
        ) THEN
        RAISE EXCEPTION 'runtime entitlement commands may only advance contract version'
          USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_runtime_entitlement_columns';
      END IF;

    WHEN 'entitlement_lots' THEN
      SELECT contract.property_id, contract.member_id
        INTO target_property_id, target_member_id
      FROM member_contracts AS contract
      WHERE contract.id = NEW.contract_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'runtime entitlement lot version must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'entitlement_lots_runtime_version_chain';
      END IF;
      SELECT correction.command_id
        INTO target_command_id
      FROM membership_effective_date_corrections AS correction
      WHERE correction.entitlement_lot_id = NEW.id
        AND correction.xmin = current_xid
        AND correction.prior_lot_version = OLD.version
        AND correction.prior_valid_until = OLD.expires_on
        AND correction.corrected_valid_until = NEW.expires_on
      LIMIT 1;
      IF target_command_id IS NOT NULL THEN
        projection_kind := 'membership-date-correction';
      ELSE
        SELECT correction.command_id
          INTO target_command_id
        FROM membership_void_reconversions AS correction
        WHERE correction.old_entitlement_lot_id = NEW.id
          AND correction.xmin = current_xid
          AND correction.prior_old_lot_version = OLD.version
          AND OLD.status = 'ACTIVE'
          AND NEW.status = 'VOIDED'
        LIMIT 1;
        IF target_command_id IS NOT NULL THEN
          projection_kind := 'membership-void';
        ELSE
          SELECT ledger.command_id
            INTO target_command_id
          FROM entitlement_ledger AS ledger
          WHERE ledger.lot_id = NEW.id
            AND ledger.xmin = current_xid
          ORDER BY ledger.created_at DESC, ledger.fact_id DESC
          LIMIT 1;
          projection_kind := 'entitlement-version';
        END IF;
      END IF;

      IF projection_kind = 'membership-date-correction'
        AND ROW(
          NEW.id,
          NEW.contract_id,
          NEW.unit_kind,
          NEW.total_units,
          NEW.status,
          NEW.created_at
        ) IS DISTINCT FROM ROW(
          OLD.id,
          OLD.contract_id,
          OLD.unit_kind,
          OLD.total_units,
          OLD.status,
          OLD.created_at
        ) THEN
        RAISE EXCEPTION 'runtime membership date correction may only change lot expiry and version'
          USING ERRCODE = '23514', CONSTRAINT = 'entitlement_lots_runtime_date_columns';
      ELSIF projection_kind = 'membership-void'
        AND (
          OLD.status IS DISTINCT FROM 'ACTIVE'
          OR NEW.status IS DISTINCT FROM 'VOIDED'
          OR ROW(
            NEW.id,
            NEW.contract_id,
            NEW.unit_kind,
            NEW.total_units,
            NEW.expires_on,
            NEW.created_at
          ) IS DISTINCT FROM ROW(
            OLD.id,
            OLD.contract_id,
            OLD.unit_kind,
            OLD.total_units,
            OLD.expires_on,
            OLD.created_at
          )
        ) THEN
        RAISE EXCEPTION 'runtime membership void may only change lot status and version'
          USING ERRCODE = '23514', CONSTRAINT = 'entitlement_lots_runtime_void_columns';
      ELSIF projection_kind = 'entitlement-version'
        AND (
          OLD.status IS DISTINCT FROM 'ACTIVE'
          OR NEW.status IS DISTINCT FROM 'ACTIVE'
          OR ROW(
            NEW.id,
            NEW.contract_id,
            NEW.unit_kind,
            NEW.total_units,
            NEW.expires_on,
            NEW.status,
            NEW.created_at
          ) IS DISTINCT FROM ROW(
            OLD.id,
            OLD.contract_id,
            OLD.unit_kind,
            OLD.total_units,
            OLD.expires_on,
            OLD.status,
            OLD.created_at
          )
        ) THEN
        RAISE EXCEPTION 'runtime entitlement commands may only advance lot version'
          USING ERRCODE = '23514', CONSTRAINT = 'entitlement_lots_runtime_entitlement_columns';
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported membership projection table %', TG_TABLE_NAME
        USING ERRCODE = '42501';
  END CASE;

  SELECT command_type
    INTO target_command_type
  FROM command_executions
  WHERE id = target_command_id;

  IF target_command_type IS NULL
    OR NOT qintopia_has_typed_runtime_command_evidence(
      target_command_id,
      target_command_type,
      target_property_id
    ) THEN
    RAISE EXCEPTION 'runtime % updates require same-transaction typed command evidence', TG_TABLE_NAME
      USING ERRCODE = '42501', CONSTRAINT = 'runtime_membership_projection_typed_command_required';
  END IF;

  IF projection_kind = 'membership-activation'
    AND target_command_type NOT IN (
      'ACTIVATE_MEMBERSHIP_ORDER',
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'BACKFILL_HISTORICAL_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ) THEN
    RAISE EXCEPTION 'runtime membership activation requires its typed activation command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'membership-payment'
    AND target_command_type NOT IN ('RECORD_MEMBERSHIP_PAYMENT', 'CORRECT_MEMBERSHIP_PAYMENT') THEN
    RAISE EXCEPTION 'runtime membership payment version requires its typed payment command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'membership-date-correction'
    AND target_command_type IS DISTINCT FROM 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE' THEN
    RAISE EXCEPTION 'runtime membership date correction requires its typed correction command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'membership-void'
    AND target_command_type IS DISTINCT FROM 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY' THEN
    RAISE EXCEPTION 'runtime membership void requires its typed correction command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'entitlement-version'
    AND target_command_type NOT IN (
      'ADD_MEMBER_ENTITLEMENT_LOT', 'ADJUST_MEMBER_ENTITLEMENT',
      'CORRECT_MEMBER_ENTITLEMENT_BALANCE', 'EXPIRE_MEMBER_ENTITLEMENT',
      'CREATE_ORDER', 'RESCHEDULE_STAY', 'EXTEND_STAY', 'SHORTEN_STAY',
      'MOVE_UNIT', 'REPRICE_ORDER', 'REFRESH_MEMBER_COVERAGE',
      'CANCEL_ORDER', 'MARK_NO_SHOW', 'REVOKE_CHECK_IN',
      'CHECK_IN', 'COMPLETE_STAY', 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ) THEN
    RAISE EXCEPTION 'runtime entitlement version requires an entitlement-changing command'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'membership_orders'
    AND projection_kind = 'membership-activation'
    AND target_command_type IN (
      'ACTIVATE_MEMBERSHIP_ORDER',
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'BACKFILL_HISTORICAL_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    )
    AND (
      (SELECT count(*) FROM membership_orders
       WHERE property_id = target_property_id
         AND member_id = target_member_id
         AND status = 'ACTIVE') <> 1
      OR (SELECT count(*) FROM member_contracts
          WHERE property_id = target_property_id
            AND member_id = target_member_id
            AND status = 'ACTIVE') <> 1
      OR (SELECT count(*)
          FROM entitlement_lots AS lot
          JOIN member_contracts AS contract ON contract.id = lot.contract_id
          WHERE contract.property_id = target_property_id
            AND contract.member_id = target_member_id
            AND lot.status = 'ACTIVE') <> 1
    ) THEN
    RAISE EXCEPTION 'runtime membership activation must leave exactly one active member entitlement chain'
      USING ERRCODE = '23514',
        CONSTRAINT = 'membership_orders_runtime_single_active_chain';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_membership_projection_update_050() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_membership_projection_update_050() FROM qintopia_runtime;

DROP TRIGGER membership_orders_runtime_projection_guard ON membership_orders;
DROP TRIGGER member_contracts_runtime_projection_guard ON member_contracts;
DROP TRIGGER entitlement_lots_runtime_projection_guard ON entitlement_lots;

CREATE CONSTRAINT TRIGGER membership_orders_runtime_projection_guard
AFTER UPDATE ON membership_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_membership_projection_update_050();
CREATE CONSTRAINT TRIGGER member_contracts_runtime_projection_guard
AFTER UPDATE ON member_contracts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_membership_projection_update_050();
CREATE CONSTRAINT TRIGGER entitlement_lots_runtime_projection_guard
AFTER UPDATE ON entitlement_lots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_membership_projection_update_050();

CREATE OR REPLACE FUNCTION qintopia_guard_runtime_order_projection_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
  target_command_type text;
  target_amendment_type text;
  target_payload jsonb;
  current_xid xid := (pg_current_xact_id()::text)::xid;
  version_step_count integer;
BEGIN
  IF current_user IS DISTINCT FROM 'qintopia_runtime'
    OR session_user IS DISTINCT FROM 'qintopia_runtime' THEN
    RETURN NEW;
  END IF;

  SELECT execution.id,
      execution.command_type,
      amendment.amendment_type,
      amendment.payload
    INTO target_command_id,
      target_command_type,
      target_amendment_type,
      target_payload
  FROM amendments AS amendment
  JOIN command_executions AS execution ON execution.id = amendment.command_id
  JOIN command_catalog AS catalog ON catalog.command_type = execution.command_type
  JOIN subjects AS subject_row
    ON subject_row.id = execution.subject_id
    AND subject_row.status = 'ACTIVE'
  JOIN subject_property_grants AS property_grant
    ON property_grant.subject_id = execution.subject_id
    AND property_grant.property_id = execution.property_id
    AND property_grant.access_level = 'WRITE'
  WHERE amendment.order_id = NEW.id
    AND amendment.new_version = NEW.version
    AND amendment.xmin = current_xid
    AND execution.xmin = current_xid
    AND execution.property_id = NEW.property_id
    AND execution.state = 'APPLIED'
    AND catalog.command_class = 'HUMAN_COMMAND'
    AND catalog.feature_key IS NULL
    AND (
      amendment.amendment_type = execution.command_type
      OR (execution.command_type = 'CREATE_ORDER' AND amendment.amendment_type IN ('CHECK_IN', 'CHECK_OUT'))
      OR (execution.command_type = 'SHORTEN_STAY' AND amendment.amendment_type = 'CHECK_OUT')
      OR (execution.command_type = 'COMPLETE_STAY' AND amendment.amendment_type = 'CHECK_OUT')
      OR (execution.command_type = 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS'
        AND amendment.amendment_type = 'CORRECT_HISTORICAL_STAY_ARRANGEMENT')
    )
    AND EXISTS (
      SELECT 1 FROM subject_command_grants AS command_grant
      WHERE command_grant.subject_id = execution.subject_id
        AND command_grant.property_id = execution.property_id
        AND command_grant.command_type = execution.command_type
    )
    AND (
      EXISTS (
        SELECT 1 FROM web_sessions AS session_row
        WHERE session_row.id = execution.credential_id
          AND session_row.subject_id = execution.subject_id
          AND session_row.revoked_at IS NULL
          AND session_row.expires_at > statement_timestamp()
      )
      OR EXISTS (
        SELECT 1 FROM api_tokens AS token
        WHERE token.id = execution.credential_id
          AND token.subject_id = execution.subject_id
          AND token.property_scope = execution.property_id
          AND token.access_ceiling = 'WRITE'
          AND token.revoked_at IS NULL
          AND token.expires_at > statement_timestamp()
          AND EXISTS (
            SELECT 1 FROM token_command_ceilings AS ceiling
            WHERE ceiling.token_id = token.id
              AND ceiling.subject_id = token.subject_id
              AND ceiling.property_id = token.property_scope
              AND ceiling.command_type = execution.command_type
          )
      )
    )
    AND EXISTS (
      SELECT 1 FROM command_receipts AS receipt
      WHERE receipt.command_id = execution.id
        AND receipt.execution_status = 'EXECUTED'
        AND receipt.business_committed
        AND receipt.xmin = current_xid
    )
    AND EXISTS (
      SELECT 1 FROM audit_entries AS audit
      WHERE audit.command_id = execution.id
        AND audit.decision = 'ALLOWED'
        AND audit.action = execution.command_type
        AND audit.xmin = current_xid
    )
  ORDER BY amendment.sequence DESC
  LIMIT 1;

  IF target_command_id IS NULL THEN
    RAISE EXCEPTION 'runtime order projection updates require same-transaction typed command evidence'
      USING ERRCODE = '42501', CONSTRAINT = 'orders_runtime_typed_command_required';
  END IF;

  IF NEW.version = OLD.version THEN
    IF target_command_type IS DISTINCT FROM 'CREATE_ORDER'
      OR NEW.version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'runtime order projection version must advance with its typed amendment'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_version_chain';
    END IF;
  ELSE
    IF NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'runtime order projection version must advance with its typed amendment'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_version_chain';
    END IF;
    SELECT count(DISTINCT amendment.new_version)::integer
      INTO version_step_count
    FROM amendments AS amendment
    WHERE amendment.order_id = NEW.id
      AND amendment.command_id = target_command_id
      AND amendment.xmin = current_xid
      AND amendment.new_version > OLD.version
      AND amendment.new_version <= NEW.version;
    IF version_step_count IS DISTINCT FROM NEW.version - OLD.version THEN
      RAISE EXCEPTION 'runtime order projection version chain is incomplete'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_version_chain';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND target_payload ->> 'toStatus' IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'runtime order status must match its typed amendment payload'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_status_projection';
  END IF;

  IF NEW.arrival_date IS DISTINCT FROM OLD.arrival_date
    OR NEW.departure_date IS DISTINCT FROM OLD.departure_date THEN
    IF NOT EXISTS (
      SELECT 1 FROM amendments AS amendment
      WHERE amendment.order_id = NEW.id
        AND amendment.command_id = target_command_id
        AND amendment.xmin = current_xid
        AND amendment.payload #>> '{after,arrivalDate}' = NEW.arrival_date::text
        AND amendment.payload #>> '{after,departureDate}' = NEW.departure_date::text
    ) THEN
      RAISE EXCEPTION 'runtime order dates must match a typed amendment payload'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_date_projection';
    END IF;
  END IF;

  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
    AND NOT EXISTS (
      SELECT 1
      FROM pricing_revisions AS revision
      JOIN amendments AS amendment ON amendment.id = revision.amendment_id
      WHERE revision.id = NEW.current_revision_id
        AND revision.order_id = NEW.id
        AND revision.xmin = current_xid
        AND amendment.command_id = target_command_id
        AND amendment.xmin = current_xid
    ) THEN
    RAISE EXCEPTION 'runtime current pricing revision must be created by the same typed command'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_revision_projection';
  END IF;

  IF (NEW.member_id IS DISTINCT FROM OLD.member_id
      OR NEW.member_contract_id IS DISTINCT FROM OLD.member_contract_id)
    AND target_command_type NOT IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ) THEN
    RAISE EXCEPTION 'runtime membership projection requires a typed conversion command'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_membership_projection';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_order_projection_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_order_projection_update() FROM qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_validate_stay_collection_membership_transfer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_fact collection_facts%ROWTYPE;
  source_reversal collection_facts%ROWTYPE;
  membership_payment membership_payment_facts%ROWTYPE;
  membership_order membership_orders%ROWTYPE;
  source_property_id text;
  source_property_timezone text;
  execution_type text;
  active_refunded_minor bigint;
  residual_minor bigint;
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  SELECT * INTO source_fact FROM collection_facts WHERE fact_id = NEW.source_collection_fact_id FOR UPDATE;
  SELECT * INTO source_reversal FROM collection_facts WHERE fact_id = NEW.source_reversal_fact_id FOR UPDATE;
  SELECT * INTO membership_payment FROM membership_payment_facts WHERE fact_id = NEW.membership_payment_fact_id FOR UPDATE;
  SELECT * INTO membership_order FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  SELECT source_order.property_id, property_row.timezone
    INTO source_property_id, source_property_timezone
  FROM orders AS source_order
  JOIN properties AS property_row ON property_row.id = source_order.property_id
  WHERE source_order.id = NEW.order_id;
  SELECT command_type INTO execution_type FROM command_executions WHERE id = NEW.command_id;

  IF source_fact.fact_id IS NULL
    OR source_reversal.fact_id IS NULL
    OR membership_payment.fact_id IS NULL
    OR membership_order.id IS NULL
    OR source_property_id IS NULL
    OR execution_type NOT IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ) THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires complete facts and its typed command'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_complete';
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
    OR membership_order.property_id IS DISTINCT FROM NEW.property_id
    OR source_fact.order_id IS DISTINCT FROM NEW.order_id
    OR source_fact.fact_type IS DISTINCT FROM 'COLLECTION'
    OR source_fact.method IS DISTINCT FROM 'WECOM'
    OR NULLIF(btrim(source_fact.transaction_reference), '') IS NULL THEN
    RAISE EXCEPTION 'stay-to-membership transfer source must be one same-property WECOM collection'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source';
  END IF;
  IF EXISTS (
    SELECT 1 FROM collection_facts AS reversal
    WHERE reversal.reverses_fact_id = source_fact.fact_id
      AND reversal.fact_id IS DISTINCT FROM source_reversal.fact_id
  ) THEN
    RAISE EXCEPTION 'reversed lodging collections cannot be transferred to membership'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_reversed';
  END IF;
  SELECT COALESCE(sum(refund.amount_minor), 0)
    INTO active_refunded_minor
  FROM collection_facts AS refund
  WHERE refund.fact_type = 'REFUND'
    AND refund.references_fact_id = source_fact.fact_id
    AND NOT EXISTS (
      SELECT 1 FROM collection_facts AS reversal
      WHERE reversal.reverses_fact_id = refund.fact_id
    );
  IF execution_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    AND active_refunded_minor > 0 THEN
    RAISE EXCEPTION 'refunded lodging collections cannot be transferred to membership'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_refunded';
  END IF;
  residual_minor := source_fact.amount_minor - active_refunded_minor;
  IF residual_minor <= 0 THEN
    RAISE EXCEPTION 'fully refunded lodging collections cannot create a transfer fact'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_source_refunded';
  END IF;
  IF source_reversal.order_id IS DISTINCT FROM NEW.order_id
    OR source_reversal.fact_type IS DISTINCT FROM 'REVERSAL'
    OR source_reversal.reverses_fact_id IS DISTINCT FROM source_fact.fact_id
    OR source_reversal.command_id IS DISTINCT FROM NEW.command_id
    OR source_reversal.amount_minor IS DISTINCT FROM residual_minor
    OR source_reversal.net_effect_minor IS DISTINCT FROM -residual_minor
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
    OR membership_payment.amount_minor IS DISTINCT FROM residual_minor
    OR membership_payment.net_effect_minor IS DISTINCT FROM residual_minor
    OR membership_payment.currency IS DISTINCT FROM source_fact.currency
    OR membership_payment.business_date IS DISTINCT FROM (
      source_fact.created_at AT TIME ZONE source_property_timezone
    )::date THEN
    RAISE EXCEPTION 'stay-to-membership transfer requires a matching membership payment fact'
      USING ERRCODE = '23514', CONSTRAINT = 'stay_membership_transfer_payment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_lodging_funds_after_membership_transfer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  order_property_id text;
  prior_conversion_command_id text;
BEGIN
  PERFORM 1 FROM orders WHERE id = NEW.order_id FOR UPDATE;
  SELECT property_id INTO order_property_id FROM orders WHERE id = NEW.order_id;
  SELECT command_id INTO prior_conversion_command_id
  FROM amendments
  WHERE order_id = NEW.order_id
    AND amendment_type IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    )
  ORDER BY sequence DESC
  LIMIT 1;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
  FROM command_executions WHERE id = NEW.command_id;

  IF prior_conversion_command_id IS NULL THEN
    IF execution_type IS NULL
      OR execution_type NOT IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ) THEN
      RETURN NEW;
    END IF;
    IF execution_state = 'EXECUTING'
      AND execution_property_id = order_property_id
      AND NEW.fact_type = 'REVERSAL'
      AND EXISTS (
        SELECT 1 FROM membership_orders
        WHERE created_by_command_id = NEW.command_id
          AND property_id = order_property_id
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stay conversion may initially append only its typed lodging reversals'
      USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_initial_lodging_fund_shape';
  END IF;

  IF prior_conversion_command_id = NEW.command_id
    AND execution_type IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    )
    AND execution_state = 'EXECUTING'
    AND execution_property_id = order_property_id
    AND NEW.fact_type = 'REVERSAL' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lodging funds are closed after a stay converts to membership'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_lodging_funds_closed';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  execution_type text;
  execution_state text;
  execution_property_id text;
  target_membership_order membership_orders%ROWTYPE;
BEGIN
  PERFORM 1 FROM membership_orders WHERE id = NEW.membership_order_id FOR UPDATE;
  SELECT * INTO target_membership_order FROM membership_orders WHERE id = NEW.membership_order_id;
  SELECT command_type, state, property_id
    INTO execution_type, execution_state, execution_property_id
  FROM command_executions WHERE id = NEW.command_id;

  IF NOT EXISTS (
    SELECT 1 FROM command_executions AS creation
    WHERE creation.id = target_membership_order.created_by_command_id
      AND creation.command_type IN (
        'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
        'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
      )
  ) THEN
    RETURN NEW;
  END IF;
  IF target_membership_order.created_by_command_id = NEW.command_id
    AND execution_type IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    )
    AND execution_state = 'EXECUTING'
    AND execution_property_id = target_membership_order.property_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'membership funds are closed for membership orders created from lodging conversion'
    USING ERRCODE = '23514', CONSTRAINT = 'stage13_conversion_membership_funds_closed';
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_conversion_consume_entitlement_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  execution_type text;
  execution_state text;
  target_order orders%ROWTYPE;
  target_stay stays%ROWTYPE;
  target_lot entitlement_lots%ROWTYPE;
  target_contract member_contracts%ROWTYPE;
  target_membership_order membership_orders%ROWTYPE;
  target_coverage coverage_items%ROWTYPE;
  coverage_inventory_kind text;
  coverage_room_type_code text;
BEGIN
  IF NEW.entry_type <> 'CONVERSION_CONSUME' THEN RETURN NEW; END IF;
  SELECT command_type, state INTO execution_type, execution_state
  FROM command_executions WHERE id = NEW.command_id;
  SELECT * INTO target_order FROM orders WHERE id = NEW.order_id;
  SELECT * INTO target_stay FROM stays WHERE order_id = NEW.order_id;
  SELECT * INTO target_lot FROM entitlement_lots WHERE id = NEW.lot_id;
  SELECT * INTO target_contract FROM member_contracts WHERE id = target_lot.contract_id;
  SELECT * INTO target_membership_order FROM membership_orders WHERE entitlement_lot_id = NEW.lot_id;
  IF NEW.coverage_id IS NOT NULL THEN
    SELECT * INTO target_coverage FROM coverage_items WHERE id = NEW.coverage_id;
    SELECT kind, room_type_code INTO coverage_inventory_kind, coverage_room_type_code
    FROM inventory_units WHERE id = target_coverage.inventory_unit_id;
  END IF;

  IF execution_type NOT IN (
      'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    )
    OR execution_state IS DISTINCT FROM 'EXECUTING'
    OR target_order.id IS NULL
    OR target_stay.id IS NULL
    OR target_lot.id IS NULL
    OR target_contract.id IS NULL
    OR target_membership_order.id IS NULL
    OR target_membership_order.status IS DISTINCT FROM 'ACTIVE'
    OR target_membership_order.contract_id IS DISTINCT FROM target_contract.id
    OR target_membership_order.property_id IS DISTINCT FROM target_order.property_id
    OR target_membership_order.member_id IS DISTINCT FROM target_order.member_id
    OR target_order.member_contract_id IS DISTINCT FROM target_contract.id
    OR target_membership_order.activated_by_command_id IS DISTINCT FROM NEW.command_id
    OR NEW.quantity_delta IS DISTINCT FROM -1
    OR NEW.service_date IS NULL
    OR NEW.service_date < target_order.arrival_date
    OR NEW.service_date >= target_order.departure_date
    OR NEW.reason IS DISTINCT FROM 'STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED'
    OR NOT (
      (target_order.status = 'CHECKED_OUT'
        AND target_stay.status = 'COMPLETED'
        AND NEW.coverage_id IS NULL)
      OR (target_order.status = 'CHECKED_IN'
        AND target_stay.status = 'IN_HOUSE'
        AND NEW.coverage_id IS NOT NULL
        AND target_coverage.id IS NOT NULL
        AND target_coverage.order_id = target_order.id
        AND target_coverage.contract_id = target_contract.id
        AND target_coverage.lot_id = target_lot.id
        AND target_coverage.service_date = NEW.service_date
        AND target_coverage.status = 'CONSUMED'
        AND target_coverage.held_by_revision_id = target_order.current_revision_id
        AND target_coverage.unit_kind = target_membership_order.entitlement_unit_kind
        AND coverage_inventory_kind = target_membership_order.allowed_inventory_kind
        AND coverage_room_type_code = target_membership_order.allowed_room_type_code)
    ) THEN
    RAISE EXCEPTION 'conversion consumption entitlement fact has an invalid in-house or completed-stay shape'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_conversion_consume_shape';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_membership_void_entitlement_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_lot entitlement_lots%ROWTYPE;
BEGIN
  IF NEW.entry_type <> 'VOID' THEN RETURN NEW; END IF;
  SELECT * INTO target_lot FROM entitlement_lots WHERE id = NEW.lot_id;
  IF target_lot.id IS NULL
    OR NEW.quantity_delta IS DISTINCT FROM -target_lot.total_units
    OR NEW.service_date IS NOT NULL
    OR NEW.order_id IS NOT NULL
    OR NEW.coverage_id IS NOT NULL
    OR NEW.reason IS DISTINCT FROM 'ERRONEOUS_MEMBERSHIP_VOIDED'
    OR NOT EXISTS (
      SELECT 1
      FROM membership_void_reconversions AS correction
      JOIN command_executions AS execution ON execution.id = correction.command_id
      WHERE correction.old_entitlement_lot_id = NEW.lot_id
        AND correction.command_id = NEW.command_id
        AND correction.xmin = (pg_current_xact_id()::text)::xid
        AND execution.xmin = (pg_current_xact_id()::text)::xid
        AND execution.command_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
        AND execution.state = 'EXECUTING'
    ) THEN
    RAISE EXCEPTION 'membership VOID entitlement fact requires one exact typed void command'
      USING ERRCODE = '23514', CONSTRAINT = 'entitlement_ledger_membership_void_shape';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlement_ledger_validate_membership_void
BEFORE INSERT ON entitlement_ledger
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_void_entitlement_fact();

CREATE OR REPLACE FUNCTION qintopia_validate_membership_void_reconversion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_execution command_executions%ROWTYPE;
  target_audit audit_entries%ROWTYPE;
  target_preview command_previews%ROWTYPE;
  target_member members%ROWTYPE;
  old_order membership_orders%ROWTYPE;
  old_contract member_contracts%ROWTYPE;
  old_lot entitlement_lots%ROWTYPE;
  source_order orders%ROWTYPE;
  source_stay stays%ROWTYPE;
  source_revision pricing_revisions%ROWTYPE;
  prior_source_revision pricing_revisions%ROWTYPE;
  conversion_amendment amendments%ROWTYPE;
  new_order membership_orders%ROWTYPE;
  new_contract member_contracts%ROWTYPE;
  new_lot entitlement_lots%ROWTYPE;
  replacement_payment membership_payment_facts%ROWTYPE;
  old_collection_count integer;
  old_collection_total bigint;
  old_reversal_count integer;
  old_reversal_total bigint;
  transfer_count integer;
  transfer_total bigint;
  transfer_payment_total bigint;
  source_collection_count integer;
  new_conversion_count integer;
  new_conversion_delta bigint;
  reclassification_count integer;
  reclassification_total bigint;
  identity_row_count integer;
  identity_phone_matched boolean;
  identity_document_matched boolean;
  identity_conflict_count integer;
  property_timezone text;
  property_today date;
  replacement_direct_total bigint;
  source_timeline_count integer;
  source_service_dates date[];
  source_inventory_mismatch_count integer;
  allowed_audit_count integer;
  allowed_preview_audit_count integer;
  preview_count integer;
  old_direct_preview_mismatch_count integer;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  SELECT * INTO target_execution FROM command_executions WHERE id = NEW.command_id;
  SELECT count(*)::integer INTO allowed_audit_count
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT * INTO target_audit
  FROM audit_entries
  WHERE command_id = NEW.command_id
    AND decision = 'ALLOWED';
  SELECT count(*)::integer INTO preview_count
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT * INTO target_preview
  FROM command_previews
  WHERE id = target_audit.metadata ->> 'previewId';
  SELECT count(*)::integer INTO allowed_preview_audit_count
  FROM audit_entries
  WHERE decision = 'ALLOWED'
    AND metadata ->> 'previewId' = target_preview.id;
  SELECT * INTO target_member FROM members WHERE id = NEW.member_id;
  SELECT * INTO old_order FROM membership_orders WHERE id = NEW.old_membership_order_id;
  SELECT * INTO old_contract FROM member_contracts WHERE id = NEW.old_contract_id;
  SELECT * INTO old_lot FROM entitlement_lots WHERE id = NEW.old_entitlement_lot_id;
  SELECT * INTO source_order FROM orders WHERE id = NEW.source_order_id;
  SELECT * INTO source_stay FROM stays WHERE id = NEW.source_stay_id;
  SELECT * INTO source_revision FROM pricing_revisions WHERE id = source_order.current_revision_id;
  SELECT * INTO conversion_amendment FROM amendments WHERE id = source_revision.amendment_id;
  SELECT * INTO prior_source_revision
  FROM pricing_revisions
  WHERE order_id = source_order.id
    AND revision_no = source_revision.revision_no - 1;
  SELECT * INTO new_order FROM membership_orders WHERE id = NEW.new_membership_order_id;
  SELECT * INTO new_contract FROM member_contracts WHERE id = NEW.new_contract_id;
  SELECT * INTO new_lot FROM entitlement_lots WHERE id = NEW.new_entitlement_lot_id;
  IF NEW.replacement_payment_fact_id IS NOT NULL THEN
    SELECT * INTO replacement_payment
    FROM membership_payment_facts WHERE fact_id = NEW.replacement_payment_fact_id;
  END IF;
  SELECT timezone,
      (transaction_timestamp() AT TIME ZONE timezone)::date
    INTO property_timezone, property_today
  FROM properties WHERE id = NEW.property_id;
  replacement_direct_total := NEW.membership_agreed_price_minor::bigint
    - NEW.stay_transfer_total_minor::bigint;

  WITH latest_arrangement AS (
    SELECT segment.*, amendment.payload
    FROM stay_segments AS segment
    JOIN amendments AS amendment ON amendment.id = segment.amendment_id
    WHERE segment.stay_id = source_stay.id
    ORDER BY segment.sequence DESC
    LIMIT 1
  ), source_timeline AS (
    SELECT latest.arrival_date + day_offset.days AS service_date,
        latest.inventory_unit_id
    FROM latest_arrangement AS latest
    CROSS JOIN LATERAL generate_series(
      0,
      latest.departure_date - latest.arrival_date - 1
    ) AS day_offset(days)
    WHERE latest.segment_type = 'INITIAL'
    UNION ALL
    SELECT (item.value ->> 'serviceDate')::date AS service_date,
        item.value ->> 'inventoryUnitId' AS inventory_unit_id
    FROM latest_arrangement AS latest
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(COALESCE(
          latest.payload #> '{after,stayTimeline}',
          latest.payload -> 'stayTimeline'
        )) = 'array'
        THEN COALESCE(
          latest.payload #> '{after,stayTimeline}',
          latest.payload -> 'stayTimeline'
        )
        ELSE '[]'::jsonb
      END
    ) AS item(value)
    WHERE latest.segment_type <> 'INITIAL'
  )
  SELECT count(*)::integer,
      COALESCE(
        array_agg(DISTINCT timeline.service_date ORDER BY timeline.service_date),
        ARRAY[]::date[]
      ),
      count(*) FILTER (WHERE unit.id IS NULL
        OR unit.property_id IS DISTINCT FROM NEW.property_id
        OR unit.kind IS DISTINCT FROM new_order.allowed_inventory_kind
        OR unit.room_type_code IS DISTINCT FROM new_order.allowed_room_type_code)::integer
    INTO source_timeline_count, source_service_dates, source_inventory_mismatch_count
  FROM source_timeline AS timeline
  LEFT JOIN inventory_units AS unit ON unit.id = timeline.inventory_unit_id;

  SELECT count(*)::integer, COALESCE(sum(amount_minor), 0)::bigint
    INTO old_collection_count, old_collection_total
  FROM membership_payment_facts
  WHERE membership_order_id = old_order.id
    AND fact_type = 'COLLECTION'
    AND command_id IS DISTINCT FROM NEW.command_id;
  WITH preview_collections AS (
    SELECT item.ordinality, item.value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(target_preview.effect #> '{oldMembership,directCollections}') = 'array'
        THEN target_preview.effect #> '{oldMembership,directCollections}'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS item(value, ordinality)
  ), frozen_collections AS (
    SELECT row_number() OVER (
        ORDER BY payment.created_at, payment.fact_id
      )::bigint AS ordinality,
      payment.*
    FROM membership_payment_facts AS payment
    WHERE payment.membership_order_id = old_order.id
      AND payment.fact_type = 'COLLECTION'
      AND payment.command_id IS DISTINCT FROM NEW.command_id
  )
  SELECT count(*)::integer INTO old_direct_preview_mismatch_count
  FROM preview_collections AS preview
  FULL JOIN frozen_collections AS payment USING (ordinality)
  WHERE preview.value IS NULL
    OR payment.fact_id IS NULL
    OR preview.value ->> 'factId' IS DISTINCT FROM payment.fact_id
    OR jsonb_typeof(preview.value -> 'amount') IS DISTINCT FROM 'object'
    OR preview.value #>> '{amount,minorUnits}' IS DISTINCT FROM payment.amount_minor::text
    OR preview.value #>> '{amount,currency}' IS DISTINCT FROM payment.currency::text
    OR preview.value ->> 'transactionReference' IS DISTINCT FROM NULLIF(regexp_replace(
      btrim(payment.transaction_reference),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ), '')
    OR preview.value ->> 'businessDate' IS DISTINCT FROM payment.business_date::text;
  SELECT count(*)::integer, COALESCE(sum(amount_minor), 0)::bigint
    INTO old_reversal_count, old_reversal_total
  FROM membership_payment_facts
  WHERE membership_order_id = old_order.id
    AND fact_type = 'REVERSAL'
    AND command_id = NEW.command_id;
  SELECT count(*)::integer, COALESCE(sum(amount_minor), 0)::bigint
    INTO reclassification_count, reclassification_total
  FROM membership_payment_reclassifications
  WHERE command_id = NEW.command_id;
  SELECT count(*)::integer,
      COALESCE(sum(source.amount_minor), 0)::bigint,
      COALESCE(sum(payment.amount_minor), 0)::bigint
    INTO transfer_count, transfer_total, transfer_payment_total
  FROM stay_collection_membership_transfers AS transfer
  JOIN collection_facts AS source ON source.fact_id = transfer.source_collection_fact_id
  JOIN membership_payment_facts AS payment ON payment.fact_id = transfer.membership_payment_fact_id
  WHERE transfer.command_id = NEW.command_id
    AND transfer.order_id = source_order.id
    AND transfer.membership_order_id = new_order.id;
  SELECT count(*)::integer INTO source_collection_count
  FROM collection_facts
  WHERE order_id = source_order.id
    AND fact_type = 'COLLECTION';
  SELECT count(*)::integer, COALESCE(sum(quantity_delta), 0)::bigint
    INTO new_conversion_count, new_conversion_delta
  FROM entitlement_ledger
  WHERE lot_id = new_lot.id
    AND command_id = NEW.command_id
    AND entry_type = 'CONVERSION_CONSUME';

  WITH primary_identity AS (
    SELECT
      NULLIF(regexp_replace(
        CASE WHEN latest.corrected_phone IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM order_occupant_corrections AS marker
            WHERE marker.occupant_id = occupant.id
          ) THEN occupant.phone ELSE latest.corrected_phone END,
        '[[:space:]]+', '', 'g'), '') AS source_phone,
      regexp_replace(member_row.phone, '[[:space:]]+', '', 'g') AS member_phone,
      NULLIF(upper(btrim(
        CASE WHEN latest.corrected_document_number IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM order_occupant_corrections AS marker
            WHERE marker.occupant_id = occupant.id
          ) THEN occupant.document_number ELSE latest.corrected_document_number END
      )), '') AS source_document_number,
      NULLIF(upper(btrim(member_row.identity_card_number)), '') AS member_document_number
    FROM order_occupants AS occupant
    LEFT JOIN LATERAL (
      SELECT corrected_phone, corrected_document_number
      FROM order_occupant_corrections
      WHERE occupant_id = occupant.id
      ORDER BY sequence DESC
      LIMIT 1
    ) AS latest ON TRUE
    JOIN members AS member_row ON member_row.id = NEW.member_id
    WHERE occupant.order_id = source_order.id
      AND occupant.role = 'PRIMARY'
  )
  SELECT
    count(*)::integer,
    COALESCE(bool_or(source_phone IS NOT NULL AND source_phone = member_phone), false),
    COALESCE(bool_or(source_document_number IS NOT NULL
      AND member_document_number IS NOT NULL
      AND source_document_number = member_document_number), false),
    count(*) FILTER (WHERE
      source_document_number IS NOT NULL
      AND member_document_number IS NOT NULL
      AND source_document_number IS DISTINCT FROM member_document_number
    )::integer
  INTO identity_row_count, identity_phone_matched, identity_document_matched, identity_conflict_count
  FROM primary_identity;

  IF allowed_audit_count IS DISTINCT FROM 1
    OR allowed_preview_audit_count IS DISTINCT FROM 1
    OR preview_count IS DISTINCT FROM 1
    OR target_execution.id IS NULL
    OR target_execution.property_id IS DISTINCT FROM NEW.property_id
    OR target_execution.command_type IS DISTINCT FROM 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    OR target_execution.state IS DISTINCT FROM 'APPLIED'
    OR target_audit.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_audit.credential_id IS DISTINCT FROM target_execution.credential_id
    OR target_audit.action IS DISTINCT FROM target_execution.command_type
    OR target_audit.correlation_id IS DISTINCT FROM target_execution.correlation_id
    OR target_audit.metadata ->> 'previewId' IS DISTINCT FROM target_preview.id
    OR target_audit.metadata ->> 'effectHash' IS DISTINCT FROM target_preview.effect_hash
    OR target_preview.subject_id IS DISTINCT FROM target_execution.subject_id
    OR target_preview.property_id IS DISTINCT FROM target_execution.property_id
    OR target_preview.command_type IS DISTINCT FROM target_execution.command_type
    OR target_preview.status IS DISTINCT FROM 'USED'
    OR target_preview.used_at IS NULL
    OR target_preview.effect ->> 'operation'
      IS DISTINCT FROM 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    OR conversion_amendment.payload IS DISTINCT FROM target_preview.effect
    OR target_preview.effect ->> 'evidenceNote' IS DISTINCT FROM NEW.evidence_note
    OR target_preview.effect #>> '{member,memberId}' IS DISTINCT FROM NEW.member_id
    OR target_preview.effect #>> '{member,fullName}' IS DISTINCT FROM target_member.full_name
    OR target_preview.effect #>> '{member,fullName}' IS DISTINCT FROM new_contract.member_name
    OR target_preview.effect #>> '{oldMembership,membershipOrderId}'
      IS DISTINCT FROM NEW.old_membership_order_id
    OR target_preview.effect #>> '{oldMembership,contractId}' IS DISTINCT FROM NEW.old_contract_id
    OR target_preview.effect #>> '{oldMembership,entitlementLotId}'
      IS DISTINCT FROM NEW.old_entitlement_lot_id
    OR target_preview.effect #>> '{oldMembership,productId}' IS DISTINCT FROM old_order.product_id
    OR target_preview.effect #>> '{oldMembership,status}' IS DISTINCT FROM 'ACTIVE'
    OR old_direct_preview_mismatch_count IS DISTINCT FROM 0
    OR target_preview.effect #>> '{sourceStay,orderId}' IS DISTINCT FROM NEW.source_order_id
    OR target_preview.effect #>> '{sourceStay,stayId}' IS DISTINCT FROM NEW.source_stay_id
    OR target_preview.effect #>> '{sourceStay,arrivalDate}' IS DISTINCT FROM source_order.arrival_date::text
    OR target_preview.effect #>> '{sourceStay,departureDate}' IS DISTINCT FROM source_order.departure_date::text
    OR target_preview.effect #> '{sourceStay,serviceDates}' IS DISTINCT FROM to_jsonb(NEW.service_dates)
    OR target_preview.effect #>> '{sourceStay,identityEvidence,phoneMatched}'
      IS DISTINCT FROM identity_phone_matched::text
    OR target_preview.effect #>> '{sourceStay,identityEvidence,documentMatched}'
      IS DISTINCT FROM identity_document_matched::text
    OR target_preview.effect #>> '{funds,oldDirectCollectionTotal,minorUnits}'
      IS DISTINCT FROM NEW.old_direct_collection_total_minor::text
    OR target_preview.effect #>> '{funds,oldDirectCollectionTotal,currency}'
      IS DISTINCT FROM old_order.currency::text
    OR target_preview.effect #>> '{funds,oldReversalTotal,minorUnits}'
      IS DISTINCT FROM NEW.old_direct_collection_total_minor::text
    OR target_preview.effect #>> '{funds,oldReversalTotal,currency}'
      IS DISTINCT FROM old_order.currency::text
    OR target_preview.effect #>> '{funds,stayTransferTotal,minorUnits}'
      IS DISTINCT FROM NEW.stay_transfer_total_minor::text
    OR target_preview.effect #>> '{funds,stayTransferTotal,currency}'
      IS DISTINCT FROM old_order.currency::text
    OR target_preview.effect #>> '{funds,membershipAgreedPrice,minorUnits}'
      IS DISTINCT FROM NEW.membership_agreed_price_minor::text
    OR target_preview.effect #>> '{funds,membershipAgreedPrice,currency}'
      IS DISTINCT FROM old_order.currency::text
    OR target_preview.effect #> '{funds,reclassificationOnly}' IS DISTINCT FROM 'true'::jsonb
    OR (
      NEW.replacement_payment_fact_id IS NULL
      AND target_preview.effect #> '{funds,replacementDirectPayment}' IS DISTINCT FROM 'null'::jsonb
    )
    OR (
      NEW.replacement_payment_fact_id IS NOT NULL
      AND (
        jsonb_typeof(target_preview.effect #> '{funds,replacementDirectPayment}') IS DISTINCT FROM 'object'
        OR target_preview.effect #>> '{funds,replacementDirectPayment,amount,minorUnits}'
          IS DISTINCT FROM replacement_direct_total::text
        OR target_preview.effect #>> '{funds,replacementDirectPayment,amount,currency}'
          IS DISTINCT FROM old_order.currency::text
        OR target_preview.effect #>> '{funds,replacementDirectPayment,businessDate}'
          IS DISTINCT FROM NEW.replacement_business_date::text
        OR target_preview.effect #>> '{funds,replacementDirectPayment,transactionReference}'
          IS DISTINCT FROM NEW.replacement_transaction_reference
      )
    )
    OR target_preview.effect #>> '{newMembership,productId}' IS DISTINCT FROM new_order.product_id
    OR target_preview.effect #>> '{newMembership,productName}' IS DISTINCT FROM new_order.product_name
    OR target_preview.effect #>> '{newMembership,validFrom}' IS DISTINCT FROM NEW.actual_membership_date::text
    OR target_preview.effect #>> '{newMembership,validUntil}' IS DISTINCT FROM NEW.valid_until::text
    OR target_preview.effect #>> '{entitlement,unitKind}' IS DISTINCT FROM new_order.entitlement_unit_kind
    OR target_preview.effect #>> '{entitlement,totalUnits}' IS DISTINCT FROM new_order.entitlement_units::text
    OR target_preview.effect #>> '{entitlement,consumedUnits}'
      IS DISTINCT FROM cardinality(NEW.service_dates)::text
    OR target_preview.effect #>> '{entitlement,remainingUnits}'
      IS DISTINCT FROM (new_order.entitlement_units - cardinality(NEW.service_dates))::text
    OR target_preview.effect #> '{entitlement,serviceDates}' IS DISTINCT FROM to_jsonb(NEW.service_dates)
    OR target_preview.basis_versions #>> '{oldOrder,id}' IS DISTINCT FROM NEW.old_membership_order_id
    OR target_preview.basis_versions #>> '{oldOrder,version}' IS DISTINCT FROM NEW.prior_old_order_version::text
    OR target_preview.basis_versions #>> '{oldOrder,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.basis_versions #>> '{oldContract,id}' IS DISTINCT FROM NEW.old_contract_id
    OR target_preview.basis_versions #>> '{oldContract,version}' IS DISTINCT FROM NEW.prior_old_contract_version::text
    OR target_preview.basis_versions #>> '{oldContract,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.basis_versions #>> '{oldLot,id}' IS DISTINCT FROM NEW.old_entitlement_lot_id
    OR target_preview.basis_versions #>> '{oldLot,version}' IS DISTINCT FROM NEW.prior_old_lot_version::text
    OR target_preview.basis_versions #>> '{oldLot,status}' IS DISTINCT FROM 'ACTIVE'
    OR target_preview.basis_versions #>> '{sourceOrder,id}' IS DISTINCT FROM NEW.source_order_id
    OR target_preview.basis_versions #>> '{sourceOrder,version}' IS DISTINCT FROM NEW.prior_source_order_version::text
    OR target_preview.basis_versions #>> '{sourceOrder,status}' IS DISTINCT FROM 'CHECKED_OUT'
    OR target_preview.basis_versions #>> '{sourceStay,id}' IS DISTINCT FROM NEW.source_stay_id
    OR target_preview.basis_versions #>> '{sourceStay,status}' IS DISTINCT FROM 'COMPLETED'
    OR target_preview.basis_versions #>> '{sourceArrangement,arrivalDate}'
      IS DISTINCT FROM source_order.arrival_date::text
    OR target_preview.basis_versions #>> '{sourceArrangement,departureDate}'
      IS DISTINCT FROM source_order.departure_date::text
    OR target_preview.basis_versions -> 'activeMembershipOrderIds'
      IS DISTINCT FROM jsonb_build_array(NEW.old_membership_order_id)
    OR target_preview.basis_versions -> 'activeContractIds'
      IS DISTINCT FROM jsonb_build_array(NEW.old_contract_id)
    OR target_preview.basis_versions -> 'activeEntitlementLotIds'
      IS DISTINCT FROM jsonb_build_array(NEW.old_entitlement_lot_id)
    OR target_preview.basis_versions #>> '{sourceIdentity,phoneMatched}'
      IS DISTINCT FROM identity_phone_matched::text
    OR target_preview.basis_versions #>> '{sourceIdentity,documentMatched}'
      IS DISTINCT FROM identity_document_matched::text
    OR target_preview.basis_versions ->> 'propertyToday' IS DISTINCT FROM property_today::text THEN
    RAISE EXCEPTION 'membership void and stay reconversion root must match every value frozen in one used Preview'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_void_reconversion_preview_binding';
  END IF;

  IF NOT qintopia_has_typed_runtime_command_evidence(
      NEW.command_id,
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY',
      NEW.property_id
    )
    OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
    OR old_order.id IS NULL
    OR old_contract.id IS NULL
    OR old_lot.id IS NULL
    OR source_order.id IS NULL
    OR source_stay.id IS NULL
    OR source_revision.id IS NULL
    OR new_order.id IS NULL
    OR new_contract.id IS NULL
    OR new_lot.id IS NULL
    OR old_order.property_id IS DISTINCT FROM NEW.property_id
    OR old_order.member_id IS DISTINCT FROM NEW.member_id
    OR old_order.status IS DISTINCT FROM 'VOIDED'
    OR old_order.contract_id IS DISTINCT FROM old_contract.id
    OR old_order.entitlement_lot_id IS DISTINCT FROM old_lot.id
    OR old_order.version IS DISTINCT FROM NEW.prior_old_order_version + 1
    OR old_contract.property_id IS DISTINCT FROM NEW.property_id
    OR old_contract.member_id IS DISTINCT FROM NEW.member_id
    OR old_contract.membership_order_id IS DISTINCT FROM old_order.id
    OR old_contract.status IS DISTINCT FROM 'VOIDED'
    OR old_contract.version IS DISTINCT FROM NEW.prior_old_contract_version + 1
    OR old_lot.contract_id IS DISTINCT FROM old_contract.id
    OR old_lot.status IS DISTINCT FROM 'VOIDED'
    OR old_lot.version IS DISTINCT FROM NEW.prior_old_lot_version + 1
    OR old_lot.unit_kind IS DISTINCT FROM old_order.entitlement_unit_kind
    OR old_lot.total_units IS DISTINCT FROM old_order.entitlement_units
    OR source_order.property_id IS DISTINCT FROM NEW.property_id
    OR source_order.status IS DISTINCT FROM 'CHECKED_OUT'
    OR source_stay.order_id IS DISTINCT FROM source_order.id
    OR source_stay.status IS DISTINCT FROM 'COMPLETED'
    OR source_order.stay_type IS NOT DISTINCT FROM 'FREE'
    OR source_order.booking_channel_code IS DISTINCT FROM 'WECOM'
    OR source_order.member_id IS DISTINCT FROM NEW.member_id
    OR source_order.member_contract_id IS DISTINCT FROM new_contract.id
    OR source_order.version IS DISTINCT FROM NEW.prior_source_order_version + 1
    OR conversion_amendment.id IS NULL
    OR conversion_amendment.order_id IS DISTINCT FROM source_order.id
    OR conversion_amendment.command_id IS DISTINCT FROM NEW.command_id
    OR conversion_amendment.amendment_type IS DISTINCT FROM 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    OR conversion_amendment.prior_version IS DISTINCT FROM NEW.prior_source_order_version
    OR conversion_amendment.new_version IS DISTINCT FROM NEW.prior_source_order_version + 1
    OR conversion_amendment.created_at IS DISTINCT FROM transaction_timestamp()
    OR prior_source_revision.id IS NULL
    OR prior_source_revision.order_id IS DISTINCT FROM source_order.id
    OR prior_source_revision.revision_no + 1 IS DISTINCT FROM source_revision.revision_no
    OR prior_source_revision.current_contract_amount_minor < NEW.stay_transfer_total_minor
    OR prior_source_revision.currency IS DISTINCT FROM old_order.currency
    OR source_revision.order_id IS DISTINCT FROM source_order.id
    OR source_revision.amendment_id IS DISTINCT FROM conversion_amendment.id
    OR source_revision.policy_version_id IS DISTINCT FROM prior_source_revision.policy_version_id
    OR source_revision.arrival_date IS DISTINCT FROM source_order.arrival_date
    OR source_revision.departure_date IS DISTINCT FROM source_order.departure_date
    OR source_revision.coverage_set IS DISTINCT FROM '[]'::jsonb
    OR source_revision.cash_lines IS DISTINCT FROM '[]'::jsonb
    OR source_revision.policy_base_amount_minor IS DISTINCT FROM 0
    OR source_revision.current_contract_amount_minor IS DISTINCT FROM 0
    OR source_revision.pricing_basis IS DISTINCT FROM 'MEMBER_ENTITLEMENT'
    OR source_revision.manual_adjustment_minor IS DISTINCT FROM 0
    OR source_revision.currency IS DISTINCT FROM old_order.currency
    OR source_revision.created_at IS DISTINCT FROM transaction_timestamp()
    OR identity_row_count <> 1
    OR NOT identity_phone_matched
    OR identity_conflict_count <> 0
    OR new_order.created_by_command_id IS DISTINCT FROM NEW.command_id
    OR new_order.activated_by_command_id IS DISTINCT FROM NEW.command_id
    OR new_order.property_id IS DISTINCT FROM NEW.property_id
    OR new_order.member_id IS DISTINCT FROM NEW.member_id
    OR new_order.product_id IS DISTINCT FROM old_order.product_id
    OR new_order.product_code IS DISTINCT FROM old_order.product_code
    OR new_order.product_version IS DISTINCT FROM old_order.product_version
    OR new_order.product_name IS DISTINCT FROM old_order.product_name
    OR new_order.listed_price_minor IS DISTINCT FROM old_order.listed_price_minor
    OR new_order.agreed_price_minor IS DISTINCT FROM old_order.agreed_price_minor
    OR new_order.price_adjustment_minor IS DISTINCT FROM old_order.price_adjustment_minor
    OR new_order.price_adjustment_reason IS DISTINCT FROM old_order.price_adjustment_reason
    OR new_order.currency IS DISTINCT FROM old_order.currency
    OR new_order.entitlement_unit_kind IS DISTINCT FROM old_order.entitlement_unit_kind
    OR new_order.entitlement_units IS DISTINCT FROM old_order.entitlement_units
    OR new_order.allowed_room_type_code IS DISTINCT FROM old_order.allowed_room_type_code
    OR new_order.allowed_inventory_kind IS DISTINCT FROM old_order.allowed_inventory_kind
    OR new_order.status IS DISTINCT FROM 'ACTIVE'
    OR new_order.valid_from IS DISTINCT FROM NEW.actual_membership_date
    OR new_order.valid_until IS DISTINCT FROM NEW.valid_until
    OR new_order.contract_id IS DISTINCT FROM new_contract.id
    OR new_order.entitlement_lot_id IS DISTINCT FROM new_lot.id
    OR new_order.created_at IS DISTINCT FROM transaction_timestamp()
    OR new_contract.property_id IS DISTINCT FROM NEW.property_id
    OR new_contract.member_id IS DISTINCT FROM NEW.member_id
    OR new_contract.membership_order_id IS DISTINCT FROM new_order.id
    OR new_contract.status IS DISTINCT FROM 'ACTIVE'
    OR new_contract.valid_from IS DISTINCT FROM NEW.actual_membership_date
    OR new_contract.valid_until IS DISTINCT FROM NEW.valid_until
    OR new_contract.created_at IS DISTINCT FROM transaction_timestamp()
    OR new_lot.contract_id IS DISTINCT FROM new_contract.id
    OR new_lot.status IS DISTINCT FROM 'ACTIVE'
    OR new_lot.unit_kind IS DISTINCT FROM new_order.entitlement_unit_kind
    OR new_lot.total_units IS DISTINCT FROM new_order.entitlement_units
    OR new_lot.expires_on IS DISTINCT FROM NEW.valid_until
    OR new_lot.created_at IS DISTINCT FROM transaction_timestamp()
    OR NEW.valid_until IS DISTINCT FROM (NEW.actual_membership_date + interval '1 year')::date
    OR property_today IS NULL
    OR NEW.actual_membership_date > property_today
    OR NEW.valid_until < property_today
    OR (SELECT count(*) FROM membership_orders
        WHERE property_id = NEW.property_id
          AND member_id = NEW.member_id
          AND status = 'ACTIVE') <> 1
    OR (SELECT count(*) FROM member_contracts
        WHERE property_id = NEW.property_id
          AND member_id = NEW.member_id
          AND status = 'ACTIVE') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM member_contracts
      WHERE id = new_contract.id
        AND property_id = NEW.property_id
        AND member_id = NEW.member_id
        AND status = 'ACTIVE'
    )
    OR (SELECT count(*)
        FROM entitlement_lots AS active_lot
        JOIN member_contracts AS owning_contract
          ON owning_contract.id = active_lot.contract_id
        WHERE owning_contract.property_id = NEW.property_id
          AND owning_contract.member_id = NEW.member_id
          AND active_lot.status = 'ACTIVE') <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM entitlement_lots AS active_lot
      JOIN member_contracts AS owning_contract
        ON owning_contract.id = active_lot.contract_id
      WHERE active_lot.id = new_lot.id
        AND owning_contract.property_id = NEW.property_id
        AND owning_contract.member_id = NEW.member_id
        AND active_lot.status = 'ACTIVE'
    )
    OR NOT EXISTS (
      SELECT 1 FROM member_property_links
      WHERE member_id = NEW.member_id
        AND property_id = NEW.property_id
        AND xmin IS DISTINCT FROM current_xid
    )
    OR old_collection_count < 1
    OR old_collection_total IS DISTINCT FROM NEW.old_direct_collection_total_minor::bigint
    OR old_reversal_count IS DISTINCT FROM old_collection_count
    OR old_reversal_total IS DISTINCT FROM old_collection_total
    OR reclassification_count IS DISTINCT FROM old_collection_count
    OR reclassification_total IS DISTINCT FROM old_collection_total
    OR transfer_count IS DISTINCT FROM source_collection_count
    OR transfer_count < 1
    OR transfer_total IS DISTINCT FROM NEW.stay_transfer_total_minor::bigint
    OR transfer_payment_total IS DISTINCT FROM transfer_total
    OR NEW.membership_agreed_price_minor IS DISTINCT FROM new_order.agreed_price_minor
    OR replacement_direct_total < 0
    OR (replacement_direct_total = 0
      AND (NEW.replacement_payment_fact_id IS NOT NULL
        OR NEW.replacement_business_date IS NOT NULL
        OR NEW.replacement_transaction_reference IS NOT NULL
        OR replacement_payment.fact_id IS NOT NULL))
    OR (replacement_direct_total > 0 AND (
      replacement_payment.fact_id IS NULL
      OR NEW.replacement_payment_fact_id IS NULL
      OR NEW.replacement_business_date IS NULL
      OR NEW.replacement_transaction_reference IS NULL
      OR replacement_payment.membership_order_id IS DISTINCT FROM new_order.id
      OR replacement_payment.command_id IS DISTINCT FROM NEW.command_id
      OR replacement_payment.fact_type IS DISTINCT FROM 'COLLECTION'
      OR replacement_payment.source_type IS DISTINCT FROM 'DIRECT_WECOM'
      OR replacement_payment.amount_minor IS DISTINCT FROM replacement_direct_total
      OR replacement_payment.net_effect_minor IS DISTINCT FROM replacement_payment.amount_minor
      OR replacement_payment.currency IS DISTINCT FROM new_order.currency
      OR NULLIF(btrim(replacement_payment.transaction_reference), '') IS NULL
      OR replacement_payment.transaction_reference IS DISTINCT FROM
        btrim(replacement_payment.transaction_reference)
      OR replacement_payment.transaction_reference IS DISTINCT FROM
        NEW.replacement_transaction_reference
      OR replacement_payment.business_date IS DISTINCT FROM
        NEW.replacement_business_date
      OR replacement_payment.corrects_fact_id IS NOT NULL
      OR replacement_payment.reverses_fact_id IS NOT NULL
      OR NEW.replacement_business_date > property_today
    ))
    OR (SELECT count(*) FROM membership_payment_facts
        WHERE membership_order_id = new_order.id)
      <> transfer_count + (CASE WHEN replacement_direct_total > 0 THEN 1 ELSE 0 END)
    OR (SELECT COALESCE(sum(net_effect_minor), 0) FROM membership_payment_facts
        WHERE membership_order_id = new_order.id) <> NEW.membership_agreed_price_minor
    OR EXISTS (
      SELECT 1 FROM collection_facts AS other_source
      WHERE other_source.transaction_reference = replacement_payment.transaction_reference
    )
    OR EXISTS (
      SELECT 1 FROM membership_payment_facts AS other_payment
      WHERE other_payment.fact_id <> replacement_payment.fact_id
        AND other_payment.transaction_reference = replacement_payment.transaction_reference
    )
    OR EXISTS (
      SELECT 1 FROM membership_payment_facts AS payment
      WHERE payment.membership_order_id = old_order.id
        AND payment.command_id IS DISTINCT FROM NEW.command_id
        AND (payment.fact_type IS DISTINCT FROM 'COLLECTION'
          OR payment.source_type IS DISTINCT FROM 'DIRECT_WECOM'
          OR payment.amount_minor <= 0
          OR payment.net_effect_minor IS DISTINCT FROM payment.amount_minor
          OR payment.currency IS DISTINCT FROM old_order.currency
          OR NULLIF(btrim(payment.transaction_reference), '') IS NULL
          OR payment.corrects_fact_id IS NOT NULL
          OR payment.reverses_fact_id IS NOT NULL)
    )
    OR EXISTS (
      SELECT 1
      FROM collection_facts AS historical_source_fact
      WHERE historical_source_fact.order_id = source_order.id
        AND historical_source_fact.command_id IS DISTINCT FROM NEW.command_id
        AND historical_source_fact.fact_type IS DISTINCT FROM 'COLLECTION'
    )
    OR EXISTS (
      SELECT 1
      FROM stay_collection_membership_transfers AS transfer
      JOIN collection_facts AS source
        ON source.fact_id = transfer.source_collection_fact_id
      JOIN membership_payment_facts AS payment
        ON payment.fact_id = transfer.membership_payment_fact_id
      WHERE transfer.command_id = NEW.command_id
        AND payment.business_date IS DISTINCT FROM (
          source.created_at AT TIME ZONE property_timezone
        )::date
    )
    OR EXISTS (
      SELECT 1 FROM membership_payment_facts AS reversal
      WHERE reversal.membership_order_id = old_order.id
        AND reversal.command_id = NEW.command_id
        AND (reversal.fact_type IS DISTINCT FROM 'REVERSAL'
          OR reversal.source_type IS DISTINCT FROM 'DIRECT_WECOM'
          OR reversal.business_date IS DISTINCT FROM (
            SELECT original_payment.business_date
            FROM membership_payment_facts AS original_payment
            WHERE original_payment.fact_id = reversal.reverses_fact_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM membership_payment_reclassifications AS reclassification
            WHERE reclassification.command_id = NEW.command_id
              AND reclassification.property_id = NEW.property_id
              AND reclassification.member_id = NEW.member_id
              AND reclassification.old_membership_order_id = old_order.id
              AND reclassification.old_payment_fact_id = reversal.reverses_fact_id
              AND reclassification.old_reversal_fact_id = reversal.fact_id
              AND reclassification.new_membership_order_id = new_order.id
              AND reclassification.new_payment_fact_id IS NOT DISTINCT FROM replacement_payment.fact_id
              AND reclassification.amount_minor = reversal.amount_minor
              AND reclassification.currency = reversal.currency
          ))
    )
    OR (SELECT count(*) FROM entitlement_ledger
        WHERE lot_id = old_lot.id
          AND entry_type = 'VOID'
          AND command_id = NEW.command_id
          AND quantity_delta = -old_lot.total_units
          AND service_date IS NULL
          AND order_id IS NULL
          AND coverage_id IS NULL) <> 1
    OR (SELECT count(*) FROM entitlement_ledger WHERE lot_id = old_lot.id) <> 1
    OR EXISTS (SELECT 1 FROM coverage_items WHERE lot_id = old_lot.id)
    OR EXISTS (SELECT 1 FROM stay_collection_membership_transfers WHERE membership_order_id = old_order.id)
    OR new_conversion_count IS DISTINCT FROM cardinality(NEW.service_dates)
    OR new_conversion_delta IS DISTINCT FROM -cardinality(NEW.service_dates)::bigint
    OR new_order.entitlement_units < cardinality(NEW.service_dates)
    OR source_timeline_count IS DISTINCT FROM cardinality(NEW.service_dates)
    OR source_service_dates IS DISTINCT FROM (
      SELECT COALESCE(
        array_agg(item.service_date ORDER BY item.service_date),
        ARRAY[]::date[]
      )
      FROM unnest(NEW.service_dates) AS item(service_date)
    )
    OR source_inventory_mismatch_count <> 0
    OR EXISTS (
      SELECT item.service_date
      FROM unnest(NEW.service_dates) AS item(service_date)
      GROUP BY item.service_date HAVING count(*) <> 1
    )
    OR EXISTS (
      SELECT 1 FROM unnest(NEW.service_dates) AS item(service_date)
      WHERE item.service_date < NEW.actual_membership_date OR item.service_date > NEW.valid_until
    )
    OR EXISTS (
      SELECT 1 FROM unnest(NEW.service_dates) AS item(service_date)
      WHERE NOT EXISTS (
        SELECT 1 FROM entitlement_ledger AS ledger
        WHERE ledger.lot_id = new_lot.id
          AND ledger.command_id = NEW.command_id
          AND ledger.entry_type = 'CONVERSION_CONSUME'
          AND ledger.quantity_delta = -1
          AND ledger.service_date = item.service_date
          AND ledger.order_id = source_order.id
          AND ledger.coverage_id IS NULL
      )
    )
    OR EXISTS (SELECT 1 FROM coverage_items WHERE lot_id = new_lot.id)
    OR (SELECT count(*) FROM membership_void_reconversions WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM membership_void_reconversions
      WHERE id = NEW.id AND xmin = current_xid)
    OR (SELECT count(*) FROM membership_orders WHERE xmin = current_xid) <> 2
    OR EXISTS (SELECT 1 FROM membership_orders
      WHERE xmin = current_xid AND id NOT IN (old_order.id, new_order.id))
    OR (SELECT count(*) FROM member_contracts WHERE xmin = current_xid) <> 2
    OR EXISTS (SELECT 1 FROM member_contracts
      WHERE xmin = current_xid AND id NOT IN (old_contract.id, new_contract.id))
    OR (SELECT count(*) FROM entitlement_lots WHERE xmin = current_xid) <> 2
    OR EXISTS (SELECT 1 FROM entitlement_lots
      WHERE xmin = current_xid AND id NOT IN (old_lot.id, new_lot.id))
    OR (SELECT count(*) FROM orders WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM orders WHERE id = source_order.id AND xmin = current_xid)
    OR (SELECT count(*) FROM membership_payment_facts WHERE xmin = current_xid)
      <> old_collection_count + transfer_count
        + (CASE WHEN replacement_direct_total > 0 THEN 1 ELSE 0 END)
    OR EXISTS (
      SELECT 1 FROM membership_payment_facts
      WHERE xmin = current_xid
        AND created_at IS DISTINCT FROM transaction_timestamp()
    )
    OR (SELECT count(*) FROM collection_facts WHERE xmin = current_xid) <> transfer_count
    OR EXISTS (
      SELECT 1 FROM collection_facts
      WHERE xmin = current_xid
        AND created_at IS DISTINCT FROM transaction_timestamp()
    )
    OR (SELECT count(*) FROM stay_collection_membership_transfers WHERE xmin = current_xid) <> transfer_count
    OR EXISTS (
      SELECT 1 FROM stay_collection_membership_transfers
      WHERE xmin = current_xid
        AND created_at IS DISTINCT FROM transaction_timestamp()
    )
    OR (SELECT count(*) FROM entitlement_ledger WHERE xmin = current_xid)
      <> cardinality(NEW.service_dates) + 1
    OR EXISTS (
      SELECT 1 FROM entitlement_ledger
      WHERE xmin = current_xid
        AND created_at IS DISTINCT FROM transaction_timestamp()
    )
    OR (SELECT count(*) FROM membership_payment_reclassifications WHERE xmin = current_xid)
      <> old_collection_count
    OR EXISTS (
      SELECT 1 FROM membership_payment_reclassifications
      WHERE xmin = current_xid
        AND created_at IS DISTINCT FROM transaction_timestamp()
    )
    OR (SELECT count(*) FROM amendments WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM amendments
      WHERE id = conversion_amendment.id AND xmin = current_xid)
    OR (SELECT count(*) FROM pricing_revisions WHERE xmin = current_xid) <> 1
    OR NOT EXISTS (SELECT 1 FROM pricing_revisions
      WHERE id = source_revision.id AND xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_profile_corrections WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM membership_effective_date_corrections WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM historical_membership_backfills WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM members WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stays WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM stay_segments WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM coverage_items WHERE xmin = current_xid)
    OR EXISTS (SELECT 1 FROM member_property_links WHERE xmin = current_xid)
    OR (SELECT count(*) FROM amendments
        WHERE order_id = source_order.id
          AND command_id = NEW.command_id
          AND amendment_type = 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
          AND prior_version = NEW.prior_source_order_version
          AND new_version = NEW.prior_source_order_version + 1) <> 1 THEN
    RAISE EXCEPTION 'membership void and stay reconversion must conserve one complete typed graph'
      USING ERRCODE = '23514', CONSTRAINT = 'membership_void_reconversion_exact_graph';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER membership_void_reconversions_validate_graph
AFTER INSERT ON membership_void_reconversions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_membership_void_reconversion();

CREATE OR REPLACE FUNCTION qintopia_assert_admin_membership_correction_child(
  target_command_id text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_type text;
  target_property_id text;
  root_count integer;
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF target_command_id IS NULL THEN RETURN; END IF;
  SELECT command_type, property_id
    INTO target_command_type, target_property_id
  FROM command_executions
  WHERE id = target_command_id;
  IF target_command_type IS NULL
    OR target_command_type NOT IN (
    'CORRECT_MEMBER_PROFILE',
    'CORRECT_MEMBERSHIP_EFFECTIVE_DATE',
    'BACKFILL_HISTORICAL_MEMBERSHIP',
    'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
  ) THEN
    RETURN;
  END IF;
  IF NOT qintopia_has_typed_runtime_command_evidence(
    target_command_id,
    target_command_type,
    target_property_id
  ) THEN
    RAISE EXCEPTION 'admin membership correction child requires current typed command evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'admin_membership_correction_child_evidence';
  END IF;
  CASE target_command_type
    WHEN 'CORRECT_MEMBER_PROFILE' THEN
      SELECT count(*)::integer INTO root_count
      FROM member_profile_corrections
      WHERE command_id = target_command_id AND xmin = current_xid;
    WHEN 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE' THEN
      SELECT count(*)::integer INTO root_count
      FROM membership_effective_date_corrections
      WHERE command_id = target_command_id AND xmin = current_xid;
    WHEN 'BACKFILL_HISTORICAL_MEMBERSHIP' THEN
      SELECT count(*)::integer INTO root_count
      FROM historical_membership_backfills
      WHERE command_id = target_command_id AND xmin = current_xid;
    WHEN 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY' THEN
      SELECT count(*)::integer INTO root_count
      FROM membership_void_reconversions
      WHERE command_id = target_command_id AND xmin = current_xid;
  END CASE;
  IF root_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'admin membership correction child requires one current root fact'
      USING ERRCODE = '23514', CONSTRAINT = 'admin_membership_correction_child_root';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_assert_admin_membership_correction_child(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_assert_admin_membership_correction_child(text) TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_validate_admin_membership_direct_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM qintopia_assert_admin_membership_correction_child(NEW.command_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_admin_membership_order_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM qintopia_assert_admin_membership_correction_child(NEW.created_by_command_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_admin_membership_contract_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
BEGIN
  SELECT created_by_command_id INTO target_command_id
  FROM membership_orders WHERE id = NEW.membership_order_id;
  PERFORM qintopia_assert_admin_membership_correction_child(target_command_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_admin_membership_lot_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
BEGIN
  SELECT membership_order.created_by_command_id INTO target_command_id
  FROM member_contracts AS contract
  JOIN membership_orders AS membership_order
    ON membership_order.id = contract.membership_order_id
  WHERE contract.id = NEW.contract_id;
  PERFORM qintopia_assert_admin_membership_correction_child(target_command_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION qintopia_validate_admin_membership_revision_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
BEGIN
  SELECT command_id INTO target_command_id
  FROM amendments WHERE id = NEW.amendment_id;
  PERFORM qintopia_assert_admin_membership_correction_child(target_command_id);
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER membership_payment_reclassifications_validate_admin_child
AFTER INSERT ON membership_payment_reclassifications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child();
CREATE CONSTRAINT TRIGGER membership_payment_facts_validate_admin_child
AFTER INSERT ON membership_payment_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child();
CREATE CONSTRAINT TRIGGER collection_facts_validate_admin_child
AFTER INSERT ON collection_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child();
CREATE CONSTRAINT TRIGGER stay_collection_membership_transfers_validate_admin_child
AFTER INSERT ON stay_collection_membership_transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child();
CREATE CONSTRAINT TRIGGER entitlement_ledger_validate_admin_child
AFTER INSERT ON entitlement_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.command_id IS NOT NULL)
EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child();
CREATE CONSTRAINT TRIGGER amendments_validate_admin_membership_child
AFTER INSERT ON amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.command_id IS NOT NULL)
EXECUTE FUNCTION qintopia_validate_admin_membership_direct_child();
CREATE CONSTRAINT TRIGGER membership_orders_validate_admin_child
AFTER INSERT ON membership_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_order_child();
CREATE CONSTRAINT TRIGGER member_contracts_validate_admin_membership_child
AFTER INSERT ON member_contracts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_contract_child();
CREATE CONSTRAINT TRIGGER entitlement_lots_validate_admin_membership_child
AFTER INSERT ON entitlement_lots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_lot_child();
CREATE CONSTRAINT TRIGGER pricing_revisions_validate_admin_membership_child
AFTER INSERT ON pricing_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_admin_membership_revision_child();

CREATE OR REPLACE FUNCTION qintopia_require_admin_membership_correction_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  fact_count integer;
BEGIN
  IF NEW.state <> 'APPLIED'
    OR NEW.command_type NOT IN (
      'CORRECT_MEMBER_PROFILE',
      'CORRECT_MEMBERSHIP_EFFECTIVE_DATE',
      'BACKFILL_HISTORICAL_MEMBERSHIP',
      'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY'
    ) THEN
    RETURN NEW;
  END IF;
  CASE NEW.command_type
    WHEN 'CORRECT_MEMBER_PROFILE' THEN
      SELECT count(*)::integer INTO fact_count
      FROM member_profile_corrections WHERE command_id = NEW.id;
    WHEN 'CORRECT_MEMBERSHIP_EFFECTIVE_DATE' THEN
      SELECT count(*)::integer INTO fact_count
      FROM membership_effective_date_corrections WHERE command_id = NEW.id;
    WHEN 'BACKFILL_HISTORICAL_MEMBERSHIP' THEN
      SELECT count(*)::integer INTO fact_count
      FROM historical_membership_backfills WHERE command_id = NEW.id;
    WHEN 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY' THEN
      SELECT count(*)::integer INTO fact_count
      FROM membership_void_reconversions WHERE command_id = NEW.id;
  END CASE;
  IF fact_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'applied admin membership correction requires exactly one typed correction fact'
      USING ERRCODE = '23514', CONSTRAINT = 'admin_membership_correction_fact_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER command_executions_require_admin_membership_correction_fact
AFTER INSERT OR UPDATE OF state ON command_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_require_admin_membership_correction_fact();
