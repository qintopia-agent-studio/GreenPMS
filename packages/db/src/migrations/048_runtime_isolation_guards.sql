CREATE TABLE staff_command_profile_catalog (
  profile text NOT NULL CHECK (profile IN ('STAFF', 'ADMIN')),
  command_type text NOT NULL REFERENCES command_catalog(command_type),
  token_default boolean NOT NULL,
  PRIMARY KEY (profile, command_type)
);

INSERT INTO staff_command_profile_catalog(profile, command_type, token_default) VALUES
  ('STAFF', 'CREATE_MEMBER', true),
  ('STAFF', 'CREATE_MEMBERSHIP_ORDER', true),
  ('STAFF', 'RECORD_MEMBERSHIP_PAYMENT', true),
  ('STAFF', 'CORRECT_MEMBERSHIP_PAYMENT', true),
  ('STAFF', 'ACTIVATE_MEMBERSHIP_ORDER', true),
  ('STAFF', 'CREATE_ORDER', true),
  ('STAFF', 'RESCHEDULE_STAY', true),
  ('STAFF', 'EXTEND_STAY', true),
  ('STAFF', 'SHORTEN_STAY', true),
  ('STAFF', 'MOVE_UNIT', true),
  ('STAFF', 'REPRICE_ORDER', true),
  ('STAFF', 'CANCEL_ORDER', true),
  ('STAFF', 'MARK_NO_SHOW', true),
  ('STAFF', 'REVOKE_CHECK_IN', true),
  ('STAFF', 'LOCK_MAINTENANCE', true),
  ('STAFF', 'RELEASE_MAINTENANCE', true),
  ('STAFF', 'RECORD_COLLECTION', true),
  ('STAFF', 'RECORD_REFUND', true),
  ('STAFF', 'REVERSE_FACT', true),
  ('STAFF', 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP', true),
  ('STAFF', 'CHECK_IN', true),
  ('STAFF', 'CHECK_OUT', true),
  ('STAFF', 'COMPLETE_STAY', true),
  ('STAFF', 'CORRECT_MEMBER_ENTITLEMENT_BALANCE', true);

INSERT INTO staff_command_profile_catalog(profile, command_type, token_default)
SELECT 'ADMIN', command_type, token_default
FROM staff_command_profile_catalog
WHERE profile = 'STAFF';

INSERT INTO staff_command_profile_catalog(profile, command_type, token_default) VALUES
  ('ADMIN', 'CORRECT_ORDER_OCCUPANT', true),
  ('ADMIN', 'ISSUE_TOKEN', true),
  ('ADMIN', 'ROTATE_TOKEN', true),
  ('ADMIN', 'REVOKE_TOKEN', true),
  ('ADMIN', 'COMPLETE_CLEANING', false),
  ('ADMIN', 'CORRECT_HISTORICAL_STAY_ARRANGEMENTS', false),
  ('ADMIN', 'VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY', false);

CREATE TABLE staff_profile_assignments (
  subject_id text NOT NULL,
  property_id text NOT NULL,
  profile text NOT NULL CHECK (profile IN ('STAFF', 'ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, property_id),
  CONSTRAINT staff_profile_assignments_write_grant_fk
    FOREIGN KEY (subject_id, property_id)
    REFERENCES subject_property_grants(subject_id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE staff_profile_reconciliation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  manifest_name text NOT NULL CHECK (manifest_name ~ '^[a-z][a-z0-9_-]*$'),
  manifest_hash char(64) NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  projection_hash char(64) NOT NULL CHECK (projection_hash ~ '^[a-f0-9]{64}$'),
  reconciled_by text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION qintopia_reconcile_staff_profile_manifest(
  target_manifest_name text,
  target_manifest jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  canonical_manifest jsonb;
  invalid_mappings text;
  target_manifest_hash text;
  target_projection_hash text;
BEGIN
  IF current_user IS DISTINCT FROM session_user
    OR current_user = 'qintopia_runtime'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_class
      WHERE oid = 'public.subject_command_grants'::regclass
        AND relowner = current_user::regrole
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_class
      WHERE oid = 'public.token_command_ceilings'::regclass
        AND relowner = current_user::regrole
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_class
      WHERE oid = 'public.staff_profile_assignments'::regclass
        AND relowner = current_user::regrole
    ) THEN
    RAISE EXCEPTION 'staff profile reconciliation requires the direct migration object owner session'
      USING ERRCODE = '42501';
  END IF;

  IF target_manifest_name IS NULL
    OR target_manifest_name !~ '^[a-z][a-z0-9_-]*$'
    OR jsonb_typeof(target_manifest) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'staff profile manifest name or payload is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(target_manifest) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item.value) AS key)
        IS DISTINCT FROM ARRAY['profile', 'propertyId', 'subjectId']::text[]
      OR item.value ->> 'subjectId' IS NULL
      OR item.value ->> 'subjectId' ~ '^[[:space:]]*$'
      OR item.value ->> 'propertyId' IS NULL
      OR item.value ->> 'propertyId' ~ '^[[:space:]]*$'
      OR item.value ->> 'profile' NOT IN ('STAFF', 'ADMIN')
  ) THEN
    RAISE EXCEPTION 'staff profile manifest entries must contain exactly subjectId, propertyId, and STAFF|ADMIN profile'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(target_manifest)
      AS item("subjectId" text, "propertyId" text, profile text)
    GROUP BY item."subjectId", item."propertyId"
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'staff profile manifest contains duplicate subject/property mappings'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'subjectId', item."subjectId",
          'propertyId', item."propertyId",
          'profile', item.profile
        )
        ORDER BY item."subjectId", item."propertyId"
      ),
      '[]'::jsonb
    )
    INTO canonical_manifest
  FROM jsonb_to_recordset(target_manifest)
    AS item("subjectId" text, "propertyId" text, profile text);

  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:protocol-epoch', 0::bigint));

  PERFORM subject_row.id
  FROM subjects AS subject_row
  JOIN jsonb_to_recordset(canonical_manifest)
    AS item("subjectId" text, "propertyId" text, profile text)
    ON item."subjectId" = subject_row.id
  ORDER BY subject_row.id
  FOR UPDATE;

  PERFORM grant_row.subject_id
  FROM subject_property_grants AS grant_row
  ORDER BY grant_row.subject_id, grant_row.property_id
  FOR UPDATE;

  SELECT string_agg(format('%s@%s', item."subjectId", item."propertyId"), ', ' ORDER BY item."subjectId", item."propertyId")
    INTO invalid_mappings
  FROM jsonb_to_recordset(canonical_manifest)
    AS item("subjectId" text, "propertyId" text, profile text)
  LEFT JOIN subject_property_grants AS grant_row
    ON grant_row.subject_id = item."subjectId"
    AND grant_row.property_id = item."propertyId"
  WHERE grant_row.access_level IS DISTINCT FROM 'WRITE';

  IF invalid_mappings IS NOT NULL THEN
    RAISE EXCEPTION 'reviewed staff profile manifest % contains missing or non-WRITE mappings: %', target_manifest_name, invalid_mappings
      USING ERRCODE = '23514', CONSTRAINT = 'staff_profile_manifest_write_only';
  END IF;

  DELETE FROM staff_profile_assignments;

  -- Existing WRITE principals retain the frozen ordinary-staff baseline. Only
  -- an explicit reviewed manifest tuple can elevate a pair to ADMIN.
  INSERT INTO staff_profile_assignments(subject_id, property_id, profile)
  SELECT subject_id, property_id, 'STAFF'
  FROM subject_property_grants
  WHERE access_level = 'WRITE';

  INSERT INTO staff_profile_assignments(subject_id, property_id, profile)
  SELECT item."subjectId", item."propertyId", item.profile
  FROM jsonb_to_recordset(canonical_manifest)
    AS item("subjectId" text, "propertyId" text, profile text)
  ON CONFLICT (subject_id, property_id) DO UPDATE SET
    profile = EXCLUDED.profile,
    created_at = now();

  INSERT INTO subject_command_grants(subject_id, property_id, command_type)
  SELECT assignment.subject_id, assignment.property_id, profile_command.command_type
  FROM staff_profile_assignments AS assignment
  JOIN staff_command_profile_catalog AS profile_command
    ON profile_command.profile = assignment.profile
  ON CONFLICT DO NOTHING;

  INSERT INTO subject_command_grants(subject_id, property_id, command_type)
  SELECT DISTINCT execution.subject_id,
    execution.property_id,
    regexp_replace(execution.command_type, '^PREVIEW:', '')
  FROM command_executions AS execution
  JOIN staff_profile_assignments AS assignment
    ON assignment.subject_id = execution.subject_id
    AND assignment.property_id = execution.property_id
  JOIN command_catalog AS catalog
    ON catalog.command_type = regexp_replace(execution.command_type, '^PREVIEW:', '')
    AND catalog.command_class = 'HISTORICAL_READ'
  ON CONFLICT DO NOTHING;

  DELETE FROM subject_command_grants AS grant_row
  WHERE NOT EXISTS (
      SELECT 1
      FROM staff_profile_assignments AS assignment
      JOIN staff_command_profile_catalog AS profile_command
        ON profile_command.profile = assignment.profile
        AND profile_command.command_type = grant_row.command_type
      WHERE assignment.subject_id = grant_row.subject_id
        AND assignment.property_id = grant_row.property_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM staff_profile_assignments AS assignment
      JOIN command_catalog AS catalog
        ON catalog.command_type = grant_row.command_type
        AND catalog.command_class = 'HISTORICAL_READ'
      JOIN command_executions AS execution
        ON execution.subject_id = grant_row.subject_id
        AND execution.property_id = grant_row.property_id
        AND regexp_replace(execution.command_type, '^PREVIEW:', '') = grant_row.command_type
      WHERE assignment.subject_id = grant_row.subject_id
        AND assignment.property_id = grant_row.property_id
    );

  -- Reconciliation never expands an existing Token. Historical-read rows may
  -- remain readable, but disabled or non-default feature rows are removed so
  -- a later feature enable cannot turn a hidden ceiling into executable scope.
  DELETE FROM token_command_ceilings AS ceiling
  WHERE NOT EXISTS (
    SELECT 1
    FROM api_tokens AS token
    JOIN subject_command_grants AS subject_grant
      ON subject_grant.subject_id = ceiling.subject_id
      AND subject_grant.property_id = ceiling.property_id
      AND subject_grant.command_type = ceiling.command_type
    JOIN command_catalog AS catalog
      ON catalog.command_type = ceiling.command_type
    WHERE token.id = ceiling.token_id
      AND token.subject_id = ceiling.subject_id
      AND token.property_scope = ceiling.property_id
      AND token.access_ceiling = 'WRITE'
      AND (
        catalog.command_class = 'HISTORICAL_READ'
        OR (
          catalog.command_class = 'HUMAN_COMMAND'
          AND EXISTS (
            SELECT 1
            FROM staff_profile_assignments AS assignment
            JOIN staff_command_profile_catalog AS profile_command
              ON profile_command.profile = assignment.profile
              AND profile_command.command_type = ceiling.command_type
              AND profile_command.token_default
            WHERE assignment.subject_id = ceiling.subject_id
              AND assignment.property_id = ceiling.property_id
          )
        )
      )
  );

  SELECT encode(sha256(convert_to(canonical_manifest::text, 'UTF8')), 'hex')
    INTO target_manifest_hash;

  SELECT encode(sha256(convert_to(COALESCE(string_agg(projection.row_value, E'\n' ORDER BY projection.row_value), ''), 'UTF8')), 'hex')
    INTO target_projection_hash
  FROM (
    SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value
    FROM staff_profile_assignments
    UNION ALL
    SELECT format('G|%s|%s|%s', subject_id, property_id, command_type)
    FROM subject_command_grants
  ) AS projection;

  INSERT INTO staff_profile_reconciliation_state(
    singleton,
    manifest_name,
    manifest_hash,
    projection_hash,
    reconciled_by,
    reconciled_at
  ) VALUES (
    true,
    target_manifest_name,
    target_manifest_hash,
    target_projection_hash,
    current_user,
    now()
  )
  ON CONFLICT (singleton) DO UPDATE SET
    manifest_name = EXCLUDED.manifest_name,
    manifest_hash = EXCLUDED.manifest_hash,
    projection_hash = EXCLUDED.projection_hash,
    reconciled_by = EXCLUDED.reconciled_by,
    reconciled_at = EXCLUDED.reconciled_at;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_reconcile_staff_profile_manifest(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_reconcile_staff_profile_manifest(text, jsonb) FROM qintopia_runtime;

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
  JOIN command_executions AS execution
    ON execution.id = amendment.command_id
  JOIN command_catalog AS catalog
    ON catalog.command_type = execution.command_type
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
    )
    AND EXISTS (
      SELECT 1
      FROM subject_command_grants AS command_grant
      WHERE command_grant.subject_id = execution.subject_id
        AND command_grant.property_id = execution.property_id
        AND command_grant.command_type = execution.command_type
    )
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
        WHERE token.id = execution.credential_id
          AND token.subject_id = execution.subject_id
          AND token.property_scope = execution.property_id
          AND token.access_ceiling = 'WRITE'
          AND token.revoked_at IS NULL
          AND token.expires_at > statement_timestamp()
          AND EXISTS (
            SELECT 1
            FROM token_command_ceilings AS ceiling
            WHERE ceiling.token_id = token.id
              AND ceiling.subject_id = token.subject_id
              AND ceiling.property_id = token.property_scope
              AND ceiling.command_type = execution.command_type
          )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM command_receipts AS receipt
      WHERE receipt.command_id = execution.id
        AND receipt.execution_status = 'EXECUTED'
        AND receipt.business_committed
        AND receipt.xmin = current_xid
    )
    AND EXISTS (
      SELECT 1
      FROM audit_entries AS audit
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
      SELECT 1
      FROM amendments AS amendment
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
      JOIN amendments AS amendment
        ON amendment.id = revision.amendment_id
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
    AND target_command_type IS DISTINCT FROM 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP' THEN
    RAISE EXCEPTION 'runtime membership projection requires the typed conversion command'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_runtime_membership_projection';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_order_projection_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_order_projection_update() FROM qintopia_runtime;

CREATE CONSTRAINT TRIGGER orders_runtime_projection_guard
AFTER UPDATE ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_order_projection_update();

CREATE OR REPLACE FUNCTION qintopia_guard_runtime_token_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
  expected_command_type text;
  mutation_token_id text;
  source_token_id text;
  target_token_id text;
  target_subject_id text;
  target_property_id text;
  target_label text;
  target_access_ceiling text;
  target_expires_at timestamptz;
  target_rotated_from_id text;
  target_command_id text;
  target_receipt_result jsonb;
  source_was_active_credential boolean := false;
BEGIN
  IF current_user IS DISTINCT FROM 'qintopia_runtime'
    OR session_user IS DISTINCT FROM 'qintopia_runtime' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'api_tokens' AND TG_OP = 'UPDATE' THEN
    mutation_token_id := NEW.id;
    source_token_id := OLD.id;
    source_was_active_credential := OLD.revoked_at IS NULL
      AND OLD.replaced_by_id IS NULL
      AND OLD.expires_at > statement_timestamp();

    IF OLD.revoked_at IS NOT NULL
      OR OLD.replaced_by_id IS NOT NULL
      OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'runtime Token mutations require same-transaction typed command evidence'
        USING ERRCODE = '42501', CONSTRAINT = 'api_tokens_runtime_typed_command_required';
    END IF;

    IF NEW.replaced_by_id IS NULL THEN
      expected_command_type := 'REVOKE_TOKEN';
      target_token_id := NEW.id;
      target_subject_id := NEW.subject_id;
      target_property_id := NEW.property_scope;
      target_label := NEW.label;
      target_access_ceiling := NEW.access_ceiling;
      target_expires_at := NEW.expires_at;
      target_rotated_from_id := NEW.rotated_from_id;
    ELSE
      expected_command_type := 'ROTATE_TOKEN';
      SELECT replacement.id,
          replacement.subject_id,
          replacement.property_scope,
          replacement.label,
          replacement.access_ceiling,
          replacement.expires_at,
          replacement.rotated_from_id
        INTO target_token_id,
          target_subject_id,
          target_property_id,
          target_label,
          target_access_ceiling,
          target_expires_at,
          target_rotated_from_id
      FROM api_tokens AS replacement
      WHERE replacement.id = NEW.replaced_by_id
        AND replacement.xmin = current_xid
        AND replacement.rotated_from_id = OLD.id
        AND replacement.subject_id = OLD.subject_id
        AND replacement.property_scope = OLD.property_scope
        AND replacement.access_ceiling = OLD.access_ceiling
        AND replacement.revoked_at IS NULL
        AND replacement.replaced_by_id IS NULL;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'api_tokens' THEN
      mutation_token_id := NEW.id;
    ELSE
      mutation_token_id := NEW.token_id;
    END IF;

    SELECT token_row.id,
        token_row.subject_id,
        token_row.property_scope,
        token_row.label,
        token_row.access_ceiling,
        token_row.expires_at,
        token_row.rotated_from_id
      INTO target_token_id,
        target_subject_id,
        target_property_id,
        target_label,
        target_access_ceiling,
        target_expires_at,
        target_rotated_from_id
    FROM api_tokens AS token_row
    WHERE token_row.id = mutation_token_id
      AND token_row.xmin = current_xid
      AND token_row.revoked_at IS NULL
      AND token_row.replaced_by_id IS NULL;

    IF target_rotated_from_id IS NULL THEN
      expected_command_type := 'ISSUE_TOKEN';
    ELSE
      expected_command_type := 'ROTATE_TOKEN';
      source_token_id := target_rotated_from_id;
    END IF;
  END IF;

  IF target_token_id IS NULL
    OR expected_command_type IS NULL
    OR target_property_id IS NULL
    OR target_subject_id IS NULL
    OR target_access_ceiling NOT IN ('READ', 'WRITE')
    OR (expected_command_type IN ('ISSUE_TOKEN', 'ROTATE_TOKEN')
      AND target_expires_at <= statement_timestamp())
    OR NOT EXISTS (
      SELECT 1
      FROM subjects AS target_subject
      JOIN subject_property_grants AS target_property_grant
        ON target_property_grant.subject_id = target_subject.id
        AND target_property_grant.property_id = target_property_id
      WHERE target_subject.id = target_subject_id
        AND target_subject.status = 'ACTIVE'
        AND (
          target_access_ceiling = 'READ'
          OR target_property_grant.access_level = 'WRITE'
        )
    )
    OR (target_access_ceiling = 'READ' AND EXISTS (
      SELECT 1
      FROM token_command_ceilings AS target_ceiling
      WHERE target_ceiling.token_id = target_token_id
    ))
    OR EXISTS (
      SELECT 1
      FROM token_command_ceilings AS target_ceiling
      WHERE target_ceiling.token_id = target_token_id
        AND (
          target_ceiling.subject_id IS DISTINCT FROM target_subject_id
          OR target_ceiling.property_id IS DISTINCT FROM target_property_id
          OR NOT EXISTS (
            SELECT 1
            FROM subject_command_grants AS target_grant
            WHERE target_grant.subject_id = target_subject_id
              AND target_grant.property_id = target_property_id
              AND target_grant.command_type = target_ceiling.command_type
          )
        )
    ) THEN
    RAISE EXCEPTION 'runtime Token mutations require same-transaction typed command evidence'
      USING ERRCODE = '42501', CONSTRAINT = 'api_tokens_runtime_typed_command_required';
  END IF;

  IF expected_command_type = 'ROTATE_TOKEN' THEN
    IF source_token_id IS NULL THEN
      source_token_id := target_rotated_from_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM api_tokens AS source_token
      WHERE source_token.id = source_token_id
        AND source_token.xmin = current_xid
        AND source_token.subject_id = target_subject_id
        AND source_token.property_scope = target_property_id
        AND source_token.access_ceiling = target_access_ceiling
        AND source_token.revoked_at IS NOT NULL
        AND source_token.replaced_by_id = target_token_id
    ) THEN
      RAISE EXCEPTION 'runtime Token mutations require same-transaction typed command evidence'
        USING ERRCODE = '42501', CONSTRAINT = 'api_tokens_runtime_typed_command_required';
    END IF;
  END IF;

  SELECT execution.id, receipt.result
    INTO target_command_id, target_receipt_result
  FROM command_executions AS execution
  JOIN command_catalog AS catalog
    ON catalog.command_type = execution.command_type
  JOIN subjects AS caller_subject
    ON caller_subject.id = execution.subject_id
    AND caller_subject.status = 'ACTIVE'
  JOIN subject_property_grants AS caller_property_grant
    ON caller_property_grant.subject_id = execution.subject_id
    AND caller_property_grant.property_id = execution.property_id
    AND caller_property_grant.access_level = 'WRITE'
  JOIN subject_command_grants AS caller_command_grant
    ON caller_command_grant.subject_id = execution.subject_id
    AND caller_command_grant.property_id = execution.property_id
    AND caller_command_grant.command_type = execution.command_type
  JOIN command_receipts AS receipt
    ON receipt.command_id = execution.id
    AND receipt.execution_status = 'EXECUTED'
    AND receipt.business_committed
    AND receipt.xmin = current_xid
  JOIN audit_entries AS audit
    ON audit.command_id = execution.id
    AND audit.subject_id = execution.subject_id
    AND audit.credential_id = execution.credential_id
    AND audit.action = execution.command_type
    AND audit.decision = 'ALLOWED'
    AND audit.correlation_id = execution.correlation_id
    AND audit.xmin = current_xid
  WHERE execution.xmin = current_xid
    AND execution.state = 'APPLIED'
    AND execution.property_id = target_property_id
    AND execution.command_type = expected_command_type
    AND execution.command_type IN ('ISSUE_TOKEN', 'ROTATE_TOKEN', 'REVOKE_TOKEN')
    AND catalog.command_class = 'HUMAN_COMMAND'
    AND catalog.feature_key IS NULL
    AND (expected_command_type = 'REVOKE_TOKEN' OR CASE jsonb_typeof(receipt.result -> 'commandCeiling')
      WHEN 'array' THEN NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
          AS requested_ceiling(command_type)
        WHERE NOT EXISTS (
          SELECT 1
          FROM subject_command_grants AS caller_ceiling_grant
          JOIN staff_profile_assignments AS caller_assignment
            ON caller_assignment.subject_id = caller_ceiling_grant.subject_id
            AND caller_assignment.property_id = caller_ceiling_grant.property_id
          JOIN staff_command_profile_catalog AS caller_profile_command
            ON caller_profile_command.profile = caller_assignment.profile
            AND caller_profile_command.command_type = caller_ceiling_grant.command_type
            AND caller_profile_command.token_default
          JOIN command_catalog AS caller_ceiling_catalog
            ON caller_ceiling_catalog.command_type = caller_ceiling_grant.command_type
            AND caller_ceiling_catalog.command_class = 'HUMAN_COMMAND'
          WHERE caller_ceiling_grant.subject_id = execution.subject_id
            AND caller_ceiling_grant.property_id = execution.property_id
            AND caller_ceiling_grant.command_type = requested_ceiling.command_type
        )
      )
      ELSE false
    END)
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
        FROM api_tokens AS caller_token
        WHERE caller_token.id = execution.credential_id
          AND caller_token.subject_id = execution.subject_id
          AND caller_token.property_scope = execution.property_id
          AND caller_token.access_ceiling = 'WRITE'
          AND caller_token.expires_at > statement_timestamp()
          AND (
            caller_token.revoked_at IS NULL
            OR (
              caller_token.id = source_token_id
              AND caller_token.xmin = current_xid
              AND caller_token.revoked_at IS NOT NULL
              AND (
                source_was_active_credential
                OR (
                  expected_command_type = 'ROTATE_TOKEN'
                  AND caller_token.replaced_by_id = target_token_id
                )
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM token_command_ceilings AS caller_command_ceiling
            WHERE caller_command_ceiling.token_id = caller_token.id
              AND caller_command_ceiling.subject_id = caller_token.subject_id
              AND caller_command_ceiling.property_id = caller_token.property_scope
              AND caller_command_ceiling.command_type = execution.command_type
          )
          AND (
            expected_command_type = 'REVOKE_TOKEN'
            OR target_expires_at <= caller_token.expires_at
          )
          AND (expected_command_type = 'REVOKE_TOKEN' OR NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE jsonb_typeof(receipt.result -> 'commandCeiling')
                WHEN 'array' THEN receipt.result -> 'commandCeiling'
                ELSE '[]'::jsonb
              END
            )
              AS requested_ceiling(command_type)
            WHERE NOT EXISTS (
                SELECT 1
                FROM token_command_ceilings AS caller_ceiling
                WHERE caller_ceiling.token_id = caller_token.id
                  AND caller_ceiling.subject_id = caller_token.subject_id
                  AND caller_ceiling.property_id = caller_token.property_scope
                  AND caller_ceiling.command_type = requested_ceiling.command_type
              )
          ))
      )
    )
    AND jsonb_typeof(receipt.result) = 'object'
    AND receipt.result ->> 'tokenId' = target_token_id
    AND receipt.result ->> 'subjectId' = target_subject_id
    AND receipt.result ->> 'subjectDisplayName' = (
      SELECT target_subject.display_name
      FROM subjects AS target_subject
      WHERE target_subject.id = target_subject_id
    )
    AND receipt.result ->> 'label' = target_label
    AND receipt.result ->> 'accessCeiling' = target_access_ceiling
    AND CASE jsonb_typeof(receipt.result -> 'expiresAt')
      WHEN 'string' THEN (receipt.result ->> 'expiresAt')::timestamptz = target_expires_at
      ELSE false
    END
    AND CASE jsonb_typeof(receipt.result -> 'persistedCommandCeiling')
      WHEN 'array' THEN ARRAY(
        SELECT receipt_ceiling.command_type
        FROM jsonb_array_elements_text(receipt.result -> 'persistedCommandCeiling')
          AS receipt_ceiling(command_type)
        ORDER BY receipt_ceiling.command_type
      ) = ARRAY(
        SELECT persisted_ceiling.command_type
        FROM token_command_ceilings AS persisted_ceiling
        WHERE persisted_ceiling.token_id = target_token_id
          AND persisted_ceiling.subject_id = target_subject_id
          AND persisted_ceiling.property_id = target_property_id
        ORDER BY persisted_ceiling.command_type
      )
      ELSE false
    END
    AND CASE jsonb_typeof(receipt.result -> 'commandCeiling')
      WHEN 'array' THEN
        jsonb_array_length(receipt.result -> 'commandCeiling') = (
          SELECT count(DISTINCT requested_ceiling.command_type)::integer
          FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
            AS requested_ceiling(command_type)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
            AS requested_ceiling(command_type)
          WHERE NOT EXISTS (
            SELECT 1
            FROM token_command_ceilings AS persisted_ceiling
            WHERE persisted_ceiling.token_id = target_token_id
              AND persisted_ceiling.subject_id = target_subject_id
              AND persisted_ceiling.property_id = target_property_id
              AND persisted_ceiling.command_type = requested_ceiling.command_type
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
            AS requested_ceiling(command_type)
          WHERE NOT EXISTS (
            SELECT 1
            FROM subject_command_grants AS target_grant
            JOIN staff_profile_assignments AS target_assignment
              ON target_assignment.subject_id = target_grant.subject_id
              AND target_assignment.property_id = target_grant.property_id
            JOIN staff_command_profile_catalog AS target_profile_command
              ON target_profile_command.profile = target_assignment.profile
              AND target_profile_command.command_type = target_grant.command_type
              AND target_profile_command.token_default
            JOIN command_catalog AS target_catalog
              ON target_catalog.command_type = target_grant.command_type
              AND target_catalog.command_class = 'HUMAN_COMMAND'
            WHERE target_grant.subject_id = target_subject_id
              AND target_grant.property_id = target_property_id
              AND target_grant.command_type = requested_ceiling.command_type
          )
        )
      ELSE false
    END
    AND CASE expected_command_type
      WHEN 'REVOKE_TOKEN' THEN
        receipt.result -> 'revoked' = 'true'::jsonb
        AND receipt.result -> 'historicalReadCeilingPreserved' = 'false'::jsonb
        AND ARRAY(
          SELECT receipt_ceiling.command_type
          FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
            AS receipt_ceiling(command_type)
          ORDER BY receipt_ceiling.command_type
        ) = ARRAY(
          SELECT persisted_ceiling.command_type
          FROM token_command_ceilings AS persisted_ceiling
          JOIN command_catalog AS persisted_catalog
            ON persisted_catalog.command_type = persisted_ceiling.command_type
            AND persisted_catalog.command_class = 'HUMAN_COMMAND'
          JOIN staff_profile_assignments AS target_assignment
            ON target_assignment.subject_id = target_subject_id
            AND target_assignment.property_id = target_property_id
          JOIN staff_command_profile_catalog AS target_profile_command
            ON target_profile_command.profile = target_assignment.profile
            AND target_profile_command.command_type = persisted_ceiling.command_type
            AND target_profile_command.token_default
          WHERE persisted_ceiling.token_id = target_token_id
            AND persisted_ceiling.subject_id = target_subject_id
            AND persisted_ceiling.property_id = target_property_id
          ORDER BY persisted_ceiling.command_type
        )
      WHEN 'ISSUE_TOKEN' THEN
        NOT (receipt.result ? 'rotatedFromTokenId')
        AND ARRAY(
          SELECT requested_ceiling.command_type
          FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
            AS requested_ceiling(command_type)
          ORDER BY requested_ceiling.command_type
        ) = ARRAY(
          SELECT persisted_ceiling.command_type
          FROM jsonb_array_elements_text(receipt.result -> 'persistedCommandCeiling')
            AS persisted_ceiling(command_type)
          ORDER BY persisted_ceiling.command_type
        )
      WHEN 'ROTATE_TOKEN' THEN
        receipt.result ->> 'rotatedFromTokenId' = source_token_id
        AND CASE jsonb_typeof(receipt.result -> 'previousExpiresAt')
          WHEN 'string' THEN (receipt.result ->> 'previousExpiresAt')::timestamptz = (
            SELECT source_token.expires_at
            FROM api_tokens AS source_token
            WHERE source_token.id = source_token_id
              AND source_token.subject_id = target_subject_id
              AND source_token.property_scope = target_property_id
          )
          ELSE false
        END
        AND CASE jsonb_typeof(receipt.result -> 'previousPersistedCommandCeiling')
          WHEN 'array' THEN ARRAY(
            SELECT receipt_ceiling.command_type
            FROM jsonb_array_elements_text(receipt.result -> 'previousPersistedCommandCeiling')
              AS receipt_ceiling(command_type)
            ORDER BY receipt_ceiling.command_type
          ) = ARRAY(
            SELECT source_ceiling.command_type
            FROM token_command_ceilings AS source_ceiling
            WHERE source_ceiling.token_id = source_token_id
              AND source_ceiling.subject_id = target_subject_id
              AND source_ceiling.property_id = target_property_id
            ORDER BY source_ceiling.command_type
          )
          ELSE false
        END
        AND CASE jsonb_typeof(receipt.result -> 'previousCommandCeiling')
          WHEN 'array' THEN ARRAY(
            SELECT receipt_ceiling.command_type
            FROM jsonb_array_elements_text(receipt.result -> 'previousCommandCeiling')
              AS receipt_ceiling(command_type)
            ORDER BY receipt_ceiling.command_type
          ) = ARRAY(
            SELECT source_ceiling.command_type
            FROM token_command_ceilings AS source_ceiling
            JOIN command_catalog AS source_catalog
              ON source_catalog.command_type = source_ceiling.command_type
              AND source_catalog.command_class = 'HUMAN_COMMAND'
            JOIN staff_profile_assignments AS target_assignment
              ON target_assignment.subject_id = target_subject_id
              AND target_assignment.property_id = target_property_id
            JOIN staff_command_profile_catalog AS target_profile_command
              ON target_profile_command.profile = target_assignment.profile
              AND target_profile_command.command_type = source_ceiling.command_type
              AND target_profile_command.token_default
            WHERE source_ceiling.token_id = source_token_id
              AND source_ceiling.subject_id = target_subject_id
              AND source_ceiling.property_id = target_property_id
            ORDER BY source_ceiling.command_type
          )
          ELSE false
        END
        AND ARRAY(
          SELECT requested_ceiling.command_type
          FROM jsonb_array_elements_text(receipt.result -> 'commandCeiling')
            AS requested_ceiling(command_type)
          ORDER BY requested_ceiling.command_type
        ) = ARRAY(
          SELECT persisted_ceiling.command_type
          FROM jsonb_array_elements_text(receipt.result -> 'persistedCommandCeiling')
            AS persisted_ceiling(command_type)
          ORDER BY persisted_ceiling.command_type
        )
        AND receipt.result -> 'historicalReadCeilingPreserved' = 'false'::jsonb
      ELSE false
    END
  ORDER BY execution.created_at DESC, execution.id DESC
  LIMIT 1;

  IF target_command_id IS NULL OR target_receipt_result IS NULL THEN
    RAISE EXCEPTION 'runtime Token mutations require same-transaction typed command evidence'
      USING ERRCODE = '42501', CONSTRAINT = 'api_tokens_runtime_typed_command_required';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_token_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_token_mutation() FROM qintopia_runtime;

CREATE CONSTRAINT TRIGGER api_tokens_runtime_token_mutation_guard
AFTER INSERT OR UPDATE ON api_tokens
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation();

CREATE CONSTRAINT TRIGGER token_command_ceilings_runtime_token_mutation_guard
AFTER INSERT ON token_command_ceilings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation();

CREATE OR REPLACE FUNCTION qintopia_guard_runtime_mutable_projection_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_command_id text;
  target_command_type text;
  target_property_id text;
  source_claim_id text;
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
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'runtime membership order version must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'membership_orders_runtime_version_chain';
      END IF;
      IF NEW.activated_by_command_id IS DISTINCT FROM OLD.activated_by_command_id THEN
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

    WHEN 'member_contracts' THEN
      target_property_id := NEW.property_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'runtime member contract version must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'member_contracts_runtime_version_chain';
      END IF;
      SELECT ledger.command_id
        INTO target_command_id
      FROM entitlement_ledger AS ledger
      JOIN entitlement_lots AS lot ON lot.id = ledger.lot_id
      WHERE lot.contract_id = NEW.id
        AND ledger.xmin = current_xid
      ORDER BY ledger.created_at DESC, ledger.fact_id DESC
      LIMIT 1;
      projection_kind := 'entitlement-version';

    WHEN 'entitlement_lots' THEN
      SELECT contract.property_id
        INTO target_property_id
      FROM member_contracts AS contract
      WHERE contract.id = NEW.contract_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'runtime entitlement lot version must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'entitlement_lots_runtime_version_chain';
      END IF;
      SELECT ledger.command_id
        INTO target_command_id
      FROM entitlement_ledger AS ledger
      WHERE ledger.lot_id = NEW.id
        AND ledger.xmin = current_xid
      ORDER BY ledger.created_at DESC, ledger.fact_id DESC
      LIMIT 1;
      projection_kind := 'entitlement-version';

    WHEN 'stays' THEN
      SELECT order_row.property_id
        INTO target_property_id
      FROM orders AS order_row
      WHERE order_row.id = NEW.order_id;
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'runtime stay updates must advance lifecycle status'
          USING ERRCODE = '23514', CONSTRAINT = 'stays_runtime_status_transition';
      END IF;
      SELECT amendment.command_id
        INTO target_command_id
      FROM amendments AS amendment
      WHERE amendment.order_id = NEW.order_id
        AND amendment.xmin = current_xid
        AND amendment.payload ->> 'toStatus' = NEW.status
      ORDER BY amendment.sequence DESC
      LIMIT 1;
      projection_kind := 'stay-status';

    WHEN 'coverage_items' THEN
      SELECT order_row.property_id
        INTO target_property_id
      FROM orders AS order_row
      WHERE order_row.id = NEW.order_id;
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'runtime coverage updates must advance lifecycle status'
          USING ERRCODE = '23514', CONSTRAINT = 'coverage_items_runtime_status_transition';
      END IF;
      SELECT ledger.command_id
        INTO target_command_id
      FROM entitlement_ledger AS ledger
      WHERE ledger.coverage_id = NEW.id
        AND ledger.xmin = current_xid
        AND (
          (NEW.status = 'RELEASED' AND ledger.entry_type IN ('RELEASE', 'RESTORE'))
          OR (NEW.status = 'CONSUMED' AND ledger.entry_type IN ('CONSUME', 'CONVERSION_CONSUME'))
        )
      ORDER BY ledger.created_at DESC, ledger.fact_id DESC
      LIMIT 1;
      projection_kind := 'coverage-status';

    WHEN 'inventory_room_days' THEN
      SELECT unit.property_id
        INTO target_property_id
      FROM inventory_units AS unit
      WHERE unit.id = NEW.room_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1
        OR NEW.whole_claim_id IS NOT DISTINCT FROM OLD.whole_claim_id THEN
        RAISE EXCEPTION 'runtime room-day updates must change one typed claim pointer and advance version once'
          USING ERRCODE = '23514', CONSTRAINT = 'inventory_room_days_runtime_pointer_transition';
      END IF;
      source_claim_id := COALESCE(NEW.whole_claim_id, OLD.whole_claim_id);
      projection_kind := CASE WHEN NEW.whole_claim_id IS NULL THEN 'inventory-release' ELSE 'inventory-create' END;

    WHEN 'inventory_bed_days' THEN
      SELECT unit.property_id
        INTO target_property_id
      FROM inventory_units AS unit
      WHERE unit.id = NEW.bed_id;
      IF NEW.version IS DISTINCT FROM OLD.version + 1
        OR NEW.bed_claim_id IS NOT DISTINCT FROM OLD.bed_claim_id THEN
        RAISE EXCEPTION 'runtime bed-day updates must change one typed claim pointer and advance version once'
          USING ERRCODE = '23514', CONSTRAINT = 'inventory_bed_days_runtime_pointer_transition';
      END IF;
      source_claim_id := COALESCE(NEW.bed_claim_id, OLD.bed_claim_id);
      projection_kind := CASE WHEN NEW.bed_claim_id IS NULL THEN 'inventory-release' ELSE 'inventory-create' END;

    WHEN 'inventory_claims' THEN
      target_property_id := NEW.property_id;
      IF OLD.active IS DISTINCT FROM true
        OR NEW.active IS DISTINCT FROM false
        OR NEW.released_at IS NULL THEN
        RAISE EXCEPTION 'runtime inventory claims only support one complete release'
          USING ERRCODE = '23514', CONSTRAINT = 'inventory_claims_runtime_release_transition';
      END IF;
      source_claim_id := NEW.id;
      projection_kind := 'inventory-release';

    WHEN 'maintenance_locks' THEN
      target_property_id := NEW.property_id;
      target_command_id := NEW.released_by_command_id;
      projection_kind := 'maintenance-release';

    WHEN 'cleaning_tasks' THEN
      target_property_id := NEW.property_id;
      target_command_id := NEW.completed_by_command_id;
      projection_kind := 'cleaning-complete';

    WHEN 'room_status_revisions' THEN
      target_property_id := NEW.property_id;
      IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
        RAISE EXCEPTION 'runtime room-status revision must advance exactly once'
          USING ERRCODE = '23514', CONSTRAINT = 'room_status_revisions_runtime_version_chain';
      END IF;
      SELECT execution.id
        INTO target_command_id
      FROM command_executions AS execution
      WHERE execution.property_id = NEW.property_id
        AND execution.state = 'APPLIED'
        AND execution.xmin = current_xid
      ORDER BY execution.created_at DESC, execution.id DESC
      LIMIT 1;
      projection_kind := 'room-status-revision';

    ELSE
      RAISE EXCEPTION 'unsupported runtime mutable projection table %', TG_TABLE_NAME
        USING ERRCODE = '42501';
  END CASE;

  IF source_claim_id IS NOT NULL THEN
    IF projection_kind = 'inventory-create' THEN
      SELECT COALESCE(
        (
          SELECT amendment.command_id
          FROM inventory_claims AS claim
          JOIN stay_segments AS segment
            ON claim.source_type = 'ORDER_SEGMENT'
            AND segment.id = claim.source_id
          JOIN amendments AS amendment ON amendment.id = segment.amendment_id
          WHERE claim.id = source_claim_id
            AND claim.active
            AND claim.xmin = current_xid
            AND amendment.xmin = current_xid
          LIMIT 1
        ),
        (
          SELECT lock_row.created_by_command_id
          FROM inventory_claims AS claim
          JOIN maintenance_locks AS lock_row
            ON claim.source_type = 'MAINTENANCE'
            AND lock_row.id = claim.source_id
          WHERE claim.id = source_claim_id
            AND claim.active
            AND claim.xmin = current_xid
            AND lock_row.xmin = current_xid
          LIMIT 1
        )
      ) INTO target_command_id;
    ELSE
      SELECT COALESCE(
        (
          SELECT amendment.command_id
          FROM inventory_claims AS claim
          JOIN stay_segments AS segment
            ON claim.source_type = 'ORDER_SEGMENT'
            AND segment.id = claim.source_id
          JOIN stays AS stay_row ON stay_row.id = segment.stay_id
          JOIN amendments AS amendment
            ON amendment.order_id = stay_row.order_id
            AND amendment.xmin = current_xid
          WHERE claim.id = source_claim_id
            AND NOT claim.active
            AND claim.xmin = current_xid
          ORDER BY amendment.sequence DESC
          LIMIT 1
        ),
        (
          SELECT lock_row.released_by_command_id
          FROM inventory_claims AS claim
          JOIN maintenance_locks AS lock_row
            ON claim.source_type = 'MAINTENANCE'
            AND lock_row.id = claim.source_id
          WHERE claim.id = source_claim_id
            AND NOT claim.active
            AND claim.xmin = current_xid
            AND lock_row.xmin = current_xid
          LIMIT 1
        )
      ) INTO target_command_id;
    END IF;
  END IF;

  SELECT execution.command_type
    INTO target_command_type
  FROM command_executions AS execution
  JOIN command_catalog AS catalog ON catalog.command_type = execution.command_type
  JOIN subjects AS subject_row
    ON subject_row.id = execution.subject_id
    AND subject_row.status = 'ACTIVE'
  JOIN subject_property_grants AS property_grant
    ON property_grant.subject_id = execution.subject_id
    AND property_grant.property_id = execution.property_id
    AND property_grant.access_level = 'WRITE'
  WHERE execution.id = target_command_id
    AND execution.xmin = current_xid
    AND execution.property_id = target_property_id
    AND execution.state = 'APPLIED'
    AND catalog.command_class = 'HUMAN_COMMAND'
    AND catalog.feature_key IS NULL
    AND EXISTS (
      SELECT 1
      FROM subject_command_grants AS command_grant
      WHERE command_grant.subject_id = execution.subject_id
        AND command_grant.property_id = execution.property_id
        AND command_grant.command_type = execution.command_type
    )
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
        WHERE token.id = execution.credential_id
          AND token.subject_id = execution.subject_id
          AND token.property_scope = execution.property_id
          AND token.access_ceiling = 'WRITE'
          AND token.revoked_at IS NULL
          AND token.expires_at > statement_timestamp()
          AND EXISTS (
            SELECT 1
            FROM token_command_ceilings AS ceiling
            WHERE ceiling.token_id = token.id
              AND ceiling.subject_id = token.subject_id
              AND ceiling.property_id = token.property_scope
              AND ceiling.command_type = execution.command_type
          )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM command_receipts AS receipt
      WHERE receipt.command_id = execution.id
        AND receipt.execution_status = 'EXECUTED'
        AND receipt.business_committed
        AND receipt.xmin = current_xid
    )
    AND EXISTS (
      SELECT 1
      FROM audit_entries AS audit
      WHERE audit.command_id = execution.id
        AND audit.decision = 'ALLOWED'
        AND audit.action = execution.command_type
        AND audit.xmin = current_xid
    );

  IF target_command_type IS NULL THEN
    RAISE EXCEPTION 'runtime % updates require same-transaction typed command evidence', TG_TABLE_NAME
      USING ERRCODE = '42501', CONSTRAINT = 'runtime_mutable_projection_typed_command_required';
  END IF;

  IF projection_kind = 'membership-activation'
    AND target_command_type NOT IN ('ACTIVATE_MEMBERSHIP_ORDER', 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP') THEN
    RAISE EXCEPTION 'runtime membership activation requires its typed activation command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'membership-payment'
    AND target_command_type NOT IN ('RECORD_MEMBERSHIP_PAYMENT', 'CORRECT_MEMBERSHIP_PAYMENT') THEN
    RAISE EXCEPTION 'runtime membership payment version requires its typed payment command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'maintenance-release'
    AND target_command_type IS DISTINCT FROM 'RELEASE_MAINTENANCE' THEN
    RAISE EXCEPTION 'runtime maintenance release requires its typed release command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'cleaning-complete'
    AND target_command_type IS DISTINCT FROM 'COMPLETE_CLEANING' THEN
    RAISE EXCEPTION 'runtime cleaning completion requires its typed completion command'
      USING ERRCODE = '23514';
  ELSIF projection_kind = 'room-status-revision'
    AND target_command_type NOT IN (
      'CREATE_ORDER', 'CORRECT_ORDER_OCCUPANT', 'RESCHEDULE_STAY', 'SHORTEN_STAY',
      'EXTEND_STAY', 'MOVE_UNIT', 'REPRICE_ORDER', 'RECORD_COLLECTION',
      'RECORD_REFUND', 'REVERSE_FACT', 'REFRESH_MEMBER_COVERAGE', 'CANCEL_ORDER',
      'MARK_NO_SHOW', 'REVOKE_CHECK_IN', 'CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP',
      'CHECK_IN', 'CHECK_OUT', 'COMPLETE_STAY', 'LOCK_MAINTENANCE',
      'RELEASE_MAINTENANCE'
    ) THEN
    RAISE EXCEPTION 'runtime room-status revision requires a room-status-visible command'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_mutable_projection_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_mutable_projection_update() FROM qintopia_runtime;

CREATE CONSTRAINT TRIGGER membership_orders_runtime_projection_guard
AFTER UPDATE ON membership_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER member_contracts_runtime_projection_guard
AFTER UPDATE ON member_contracts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER entitlement_lots_runtime_projection_guard
AFTER UPDATE ON entitlement_lots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER stays_runtime_projection_guard
AFTER UPDATE ON stays
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER coverage_items_runtime_projection_guard
AFTER UPDATE ON coverage_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER inventory_room_days_runtime_projection_guard
AFTER UPDATE ON inventory_room_days
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER inventory_bed_days_runtime_projection_guard
AFTER UPDATE ON inventory_bed_days
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER inventory_claims_runtime_projection_guard
AFTER UPDATE ON inventory_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER maintenance_locks_runtime_projection_guard
AFTER UPDATE ON maintenance_locks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER cleaning_tasks_runtime_projection_guard
AFTER UPDATE ON cleaning_tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

CREATE CONSTRAINT TRIGGER room_status_revisions_runtime_projection_guard
AFTER UPDATE ON room_status_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_mutable_projection_update();

REVOKE ALL ON staff_command_profile_catalog FROM qintopia_runtime;
REVOKE ALL ON staff_profile_assignments FROM qintopia_runtime;
REVOKE ALL ON staff_profile_reconciliation_state FROM qintopia_runtime;
GRANT SELECT ON staff_command_profile_catalog TO qintopia_runtime;
GRANT SELECT ON staff_profile_assignments TO qintopia_runtime;
GRANT SELECT ON staff_profile_reconciliation_state TO qintopia_runtime;
