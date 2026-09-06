ALTER TABLE members ADD COLUMN deleted_at timestamptz;
ALTER TABLE members DROP CONSTRAINT members_phone_unique;
CREATE UNIQUE INDEX members_phone_unique ON members(phone) WHERE deleted_at IS NULL;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('qintopia_validate_member_profile_correction()'::regprocedure) INTO definition;
  IF position('WHERE other_member.phone = NEW.corrected_phone' IN definition) = 0 THEN
    RAISE EXCEPTION 'unexpected member profile correction guard';
  END IF;
  EXECUTE replace(definition, 'WHERE other_member.phone = NEW.corrected_phone',
    'WHERE other_member.deleted_at IS NULL AND other_member.phone = NEW.corrected_phone');
END;
$$;

CREATE TABLE account_management_operations (
  id text PRIMARY KEY,
  actor_subject_id text NOT NULL REFERENCES subjects(id),
  credential_id text NOT NULL,
  property_id text NOT NULL REFERENCES properties(id),
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('CREATE_STAFF','RESET_PASSWORD','CHANGE_PASSWORD','DISABLE_STAFF','ENABLE_STAFF','REVOKE_SESSIONS','DELETE_STAFF','DELETE_MEMBER')),
  target_id text NOT NULL,
  reason text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_subject_id, request_id)
);
CREATE TRIGGER account_management_operations_append_only
BEFORE UPDATE OR DELETE ON account_management_operations
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
REVOKE ALL ON account_management_operations FROM PUBLIC, qintopia_runtime;
GRANT SELECT ON account_management_operations TO qintopia_runtime;

CREATE FUNCTION qintopia_require_new_active_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'new member must be active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER members_new_active_guard BEFORE INSERT ON members
FOR EACH ROW EXECUTE FUNCTION qintopia_require_new_active_member();

CREATE OR REPLACE FUNCTION qintopia_protect_member_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  current_xid xid := (pg_current_xact_id()::text)::xid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'member identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'member identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF current_user = 'qintopia_runtime' OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
      OR (to_jsonb(NEW) - 'deleted_at') IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at')
      OR NOT EXISTS (
        SELECT 1 FROM account_management_operations
        WHERE action = 'DELETE_MEMBER' AND target_id = OLD.id AND xmin = current_xid
      ) THEN
      RAISE EXCEPTION 'member deletion requires a controlled operation' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'deleted member is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND NOT EXISTS (
    SELECT 1 FROM member_profile_corrections AS correction
    JOIN command_executions AS execution ON execution.id = correction.command_id
    WHERE correction.member_id = OLD.id AND correction.xmin = current_xid AND execution.xmin = current_xid
      AND execution.command_type = 'CORRECT_MEMBER_PROFILE' AND execution.state = 'EXECUTING'
      AND execution.property_id = correction.property_id
      AND correction.prior_full_name = OLD.full_name AND correction.prior_nickname = OLD.nickname
      AND correction.prior_identity_card_number IS NOT DISTINCT FROM OLD.identity_card_number
      AND correction.prior_phone = OLD.phone AND correction.prior_wechat = OLD.wechat
      AND correction.corrected_full_name = NEW.full_name AND correction.corrected_nickname = NEW.nickname
      AND correction.corrected_identity_card_number IS NOT DISTINCT FROM NEW.identity_card_number
      AND correction.corrected_phone = NEW.phone AND correction.corrected_wechat = NEW.wechat
  ) THEN
    RAISE EXCEPTION 'member profile changes require an exact append-only correction'
      USING ERRCODE = '55000', CONSTRAINT = 'members_profile_correction_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION qintopia_require_active_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.member_id IS NOT NULL THEN
    PERFORM id FROM members WHERE id = NEW.member_id AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member has been deleted or is unavailable'
        USING ERRCODE = '23514', CONSTRAINT = 'active_member_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['membership_orders','member_contracts','orders','quotes',
    'member_property_links','member_external_references','member_profile_corrections',
    'membership_effective_date_corrections','historical_membership_backfills',
    'membership_payment_reclassifications','membership_void_reconversions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF member_id ON %I FOR EACH ROW EXECUTE FUNCTION qintopia_require_active_member()',
      target_table || '_active_member_guard', target_table);
  END LOOP;
END;
$$;

CREATE FUNCTION qintopia_member_deletion_basis(target_member_id text, target_property_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'memberId', member.id, 'fullName', member.full_name, 'nickname', member.nickname, 'phone', member.phone,
    'version', encode(sha256(convert_to(to_jsonb(member)::text, 'UTF8')), 'hex'),
    'canDelete', NOT EXISTS(SELECT 1 FROM membership_orders WHERE member_id = member.id)
      AND NOT EXISTS(SELECT 1 FROM orders WHERE member_id = member.id)
      AND NOT EXISTS(SELECT 1 FROM member_contracts WHERE member_id = member.id)
      AND NOT EXISTS(SELECT 1 FROM member_external_references WHERE member_id = member.id)
      AND NOT EXISTS(SELECT 1 FROM member_property_links WHERE member_id = member.id AND property_id <> target_property_id)
  ) FROM members AS member
  WHERE member.id = target_member_id AND member.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM member_property_links WHERE member_id = member.id AND property_id = target_property_id);
$$;
REVOKE ALL ON FUNCTION qintopia_member_deletion_basis(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_member_deletion_basis(text,text) TO qintopia_runtime;

CREATE FUNCTION qintopia_manage_account(
  actor_id text, session_id text, session_hash text, target_property text,
  operation_id text, request_key text, payload_hash text, operation text, input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor subjects%ROWTYPE;
  target subjects%ROWTYPE;
  prior account_management_operations%ROWTYPE;
  target_id text := input->>'targetId';
  target_basis jsonb;
  output jsonb;
  management_time timestamptz;
BEGIN
  IF operation NOT IN ('CREATE_STAFF','RESET_PASSWORD','CHANGE_PASSWORD','DISABLE_STAFF','ENABLE_STAFF','REVOKE_SESSIONS','DELETE_STAFF','DELETE_MEMBER')
    OR input->>'confirmation' IS DISTINCT FROM 'true'
    OR NULLIF(btrim(input->>'reason'), '') IS NULL
    OR length(input->>'reason') > 500 OR length(request_key) NOT BETWEEN 1 AND 160
    OR payload_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'MANAGEMENT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('qintopia:protocol-epoch', 0::bigint));
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:account-management', 0::bigint));
  PERFORM id FROM subjects WHERE id IN (actor_id, target_id) ORDER BY id FOR UPDATE;
  SELECT * INTO actor FROM subjects WHERE id = actor_id;
  management_time := clock_timestamp();
  IF actor.id IS NULL OR actor.status <> 'ACTIVE' OR NOT EXISTS (
    SELECT 1 FROM web_sessions WHERE id = session_id AND subject_id = actor_id
      AND secret_hash = session_hash AND revoked_at IS NULL AND expires_at > management_time FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'MANAGEMENT_SESSION' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM subject_property_grants WHERE subject_id = actor_id
      AND property_id = target_property AND access_level = 'WRITE' FOR SHARE)
    OR (operation <> 'CHANGE_PASSWORD' AND NOT EXISTS (
      SELECT 1 FROM staff_profile_assignments WHERE subject_id = actor_id
        AND property_id = target_property AND profile = 'ADMIN'
    )) THEN
    RAISE EXCEPTION 'MANAGEMENT_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO prior FROM account_management_operations WHERE actor_subject_id = actor_id AND request_id = request_key;
  IF FOUND THEN
    IF prior.request_hash <> payload_hash OR prior.credential_id <> session_id THEN
      RAISE EXCEPTION 'MANAGEMENT_REUSED' USING ERRCODE = 'P0001';
    END IF;
    RETURN prior.result;
  END IF;
  IF operation = 'DELETE_MEMBER' THEN
    PERFORM id FROM members WHERE id = target_id FOR UPDATE;
    target_basis := qintopia_member_deletion_basis(target_id, target_property);
    IF target_basis IS NULL THEN RAISE EXCEPTION 'MANAGEMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
    IF target_basis->>'version' IS DISTINCT FROM input->>'expectedVersion' THEN
      RAISE EXCEPTION 'MANAGEMENT_STALE' USING ERRCODE = 'P0001';
    END IF;
    IF target_basis->>'canDelete' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'MANAGEMENT_MEMBER_LINKED' USING ERRCODE = 'P0001';
    END IF;
    output := jsonb_build_object('operationId', operation_id, 'action', operation, 'targetId', target_id,
      'displayName', target_basis->>'fullName', 'completedAt', management_time);
    INSERT INTO account_management_operations VALUES(operation_id, actor_id, session_id, target_property,
      request_key, payload_hash, operation, target_id, input->>'reason', output, management_time);
    UPDATE members SET deleted_at = management_time WHERE id = target_id;
  ELSE
    IF operation = 'CREATE_STAFF' THEN
      IF input->>'username' !~ '^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,63}$'
        OR NULLIF(btrim(input->>'displayName'), '') IS NULL OR length(input->>'displayName') > 80
        OR NULLIF(target_id, '') IS NULL THEN
        RAISE EXCEPTION 'MANAGEMENT_INVALID' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS(SELECT 1 FROM subjects WHERE username = input->>'username' OR id = target_id) THEN
        RAISE EXCEPTION 'MANAGEMENT_USERNAME' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      SELECT * INTO target FROM subjects WHERE id = target_id;
      IF target.id IS NULL THEN RAISE EXCEPTION 'MANAGEMENT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
      IF operation = 'CHANGE_PASSWORD' THEN
        IF target.id <> actor_id OR input->>'verifiedPasswordHash' IS DISTINCT FROM target.password_hash THEN
          RAISE EXCEPTION 'MANAGEMENT_PASSWORD' USING ERRCODE = 'P0001';
        END IF;
      ELSIF target.id = actor_id
        OR EXISTS(SELECT 1 FROM staff_profile_assignments WHERE subject_id = target.id AND profile = 'ADMIN')
        OR NOT EXISTS(SELECT 1 FROM staff_profile_assignments WHERE subject_id = target.id
          AND property_id = target_property AND profile = 'STAFF')
        OR EXISTS(SELECT 1 FROM subject_property_grants WHERE subject_id = target.id AND property_id <> target_property) THEN
        RAISE EXCEPTION 'MANAGEMENT_FORBIDDEN' USING ERRCODE = 'P0001';
      END IF;
      IF input->>'expectedVersion' IS DISTINCT FROM target.auth_version::text THEN
        RAISE EXCEPTION 'MANAGEMENT_STALE' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF operation IN ('CREATE_STAFF','RESET_PASSWORD','CHANGE_PASSWORD') THEN
      IF input->>'passwordHash' !~ '^[a-f0-9]{128}$' OR length(input->>'passwordSalt') NOT BETWEEN 24 AND 160 THEN
        RAISE EXCEPTION 'MANAGEMENT_INVALID' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF operation = 'CREATE_STAFF' THEN
      INSERT INTO subjects(id, username, display_name, password_salt, password_hash, status, auth_version)
        VALUES(target_id, input->>'username', btrim(input->>'displayName'), input->>'passwordSalt', input->>'passwordHash', 'ACTIVE', 1);
      INSERT INTO subject_property_grants(subject_id, property_id, access_level) VALUES(target_id, target_property, 'WRITE');
      INSERT INTO staff_profile_assignments(subject_id, property_id, profile) VALUES(target_id, target_property, 'STAFF');
      INSERT INTO subject_command_grants(subject_id, property_id, command_type)
        SELECT target_id, target_property, command_type FROM staff_command_profile_catalog WHERE profile = 'STAFF';
    ELSIF operation = 'DELETE_STAFF' THEN
      IF NOT EXISTS(SELECT 1 FROM account_management_operations AS creation
        WHERE creation.action = 'CREATE_STAFF' AND creation.target_id = target.id AND creation.property_id = target_property) THEN
        RAISE EXCEPTION 'MANAGEMENT_STAFF_INITIALIZED' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS(SELECT 1 FROM web_sessions WHERE subject_id = target.id)
        OR EXISTS(SELECT 1 FROM api_tokens WHERE subject_id = target.id)
        OR EXISTS(SELECT 1 FROM command_executions WHERE subject_id = target.id)
        OR EXISTS(SELECT 1 FROM command_previews WHERE subject_id = target.id)
        OR EXISTS(SELECT 1 FROM audit_entries WHERE subject_id = target.id)
        OR EXISTS(SELECT 1 FROM security_audit_entries WHERE subject_id = target.id)
        OR EXISTS(SELECT 1 FROM quotes WHERE requester_subject_id = target.id)
        OR EXISTS(SELECT 1 FROM account_management_operations WHERE actor_subject_id = target.id) THEN
        RAISE EXCEPTION 'MANAGEMENT_STAFF_USED' USING ERRCODE = 'P0001';
      END IF;
      DELETE FROM subject_command_grants WHERE subject_id = target.id;
      DELETE FROM staff_profile_assignments WHERE subject_id = target.id;
      DELETE FROM subject_property_grants WHERE subject_id = target.id;
      DELETE FROM subjects WHERE id = target.id;
    ELSE
      UPDATE subjects SET auth_version = auth_version + 1,
        status = CASE WHEN operation = 'DISABLE_STAFF' THEN 'DISABLED' WHEN operation = 'ENABLE_STAFF' THEN 'ACTIVE' ELSE status END,
        password_hash = CASE WHEN operation IN ('RESET_PASSWORD','CHANGE_PASSWORD') THEN input->>'passwordHash' ELSE password_hash END,
        password_salt = CASE WHEN operation IN ('RESET_PASSWORD','CHANGE_PASSWORD') THEN input->>'passwordSalt' ELSE password_salt END
      WHERE id = target.id;
      UPDATE web_sessions SET revoked_at = management_time WHERE subject_id = target.id AND revoked_at IS NULL;
      IF operation = 'DISABLE_STAFF' THEN
        UPDATE api_tokens SET revoked_at = management_time WHERE subject_id = target.id AND revoked_at IS NULL;
      END IF;
    END IF;
    IF operation IN ('CREATE_STAFF','DELETE_STAFF') THEN
      UPDATE staff_profile_reconciliation_state SET projection_hash = (
        SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value, E'\n' ORDER BY row_value), ''), 'UTF8')), 'hex')
        FROM (
          SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value FROM staff_profile_assignments
          UNION ALL SELECT format('G|%s|%s|%s', subject_id, property_id, command_type) FROM subject_command_grants
        ) AS projection
      ), reconciled_by = current_user, reconciled_at = management_time WHERE singleton;
    END IF;
    output := jsonb_build_object('operationId', operation_id, 'action', operation, 'targetId', target_id,
      'displayName', CASE WHEN operation = 'CREATE_STAFF' THEN input->>'displayName' ELSE target.display_name END,
      'completedAt', management_time);
    INSERT INTO account_management_operations VALUES(operation_id, actor_id, session_id, target_property,
      request_key, payload_hash, operation, target_id, input->>'reason', output, management_time);
  END IF;
  INSERT INTO audit_entries(id, subject_id, credential_id, action, decision, correlation_id, reason, target_refs, metadata)
    VALUES(operation_id, actor_id, session_id, operation, 'ALLOWED', request_key,
      jsonb_build_object('note', input->>'reason'), jsonb_build_array(target_id), output);
  RETURN output;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_manage_account(text,text,text,text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_manage_account(text,text,text,text,text,text,text,text,jsonb) TO qintopia_runtime;
