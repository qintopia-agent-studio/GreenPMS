-- A priority swap moves the complete provider configuration without changing
-- either provider's enabled state or inventing a historical test result.
-- New/changed connections and explicitly re-enabled providers remain guarded
-- by the controlled save function; runtime has no direct table write access.
-- The remaining backup configuration constraint still requires a complete
-- HTTPS URL/model/key whenever the backup is enabled.
ALTER TABLE ai_model_settings DROP CONSTRAINT ai_enabled_backup_tested;
ALTER TABLE ai_model_settings
  ADD COLUMN conversation_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT ai_conversation_version_valid CHECK (conversation_version >= 0);
UPDATE ai_model_settings SET conversation_version = version;

-- Repair only an immediately preceding 079 promotion whose complete audit
-- chain proves it disabled an unchanged, previously enabled legacy primary.
-- A later save, missing history or any configuration mismatch prevents repair.
-- This is a migration action: schema_migrations records its execution. Preserve
-- the original administrator attribution, timestamp, credentials and test state.
WITH affected AS (
  SELECT s.scope_id, s.version
  FROM ai_model_settings s
  JOIN LATERAL (
    SELECT a.* FROM ai_settings_audit a WHERE a.scope_id = s.scope_id ORDER BY a.id DESC LIMIT 1
  ) latest ON latest.version = s.version AND latest.operation = 'PROMOTE' AND latest.provider_role = 'primary'
    AND latest.property_id = s.management_property_id AND latest.actor_subject_id = s.updated_by
    AND latest.enabled AND latest.provider_enabled AND latest.base_url = s.base_url
    AND latest.model = s.model AND latest.provider_name = s.provider_name
  JOIN LATERAL (
    SELECT a.* FROM ai_settings_audit a WHERE a.scope_id = s.scope_id AND a.version < latest.version
      AND a.operation = 'SAVE' AND a.provider_role = 'primary' ORDER BY a.version DESC, a.id DESC LIMIT 1
  ) previous ON previous.enabled AND previous.provider_enabled AND previous.property_id = s.management_property_id
    AND previous.base_url = s.backup_base_url AND previous.model = s.backup_model AND previous.provider_name = s.backup_name
  WHERE s.enabled AND s.provider_enabled AND s.provider_tested_at IS NOT NULL
    AND NOT s.backup_enabled AND s.backup_tested_at IS NULL
    AND s.backup_base_url ~ '^https://' AND length(s.backup_model) BETWEEN 1 AND 120
    AND length(s.backup_encrypted_key) BETWEEN 1 AND 10000
    AND NOT EXISTS (
      SELECT 1 FROM ai_settings_audit a WHERE a.scope_id = s.scope_id
        AND a.version > previous.version AND a.version < latest.version
        AND (a.operation <> 'SAVE' OR a.provider_role <> 'backup' OR a.property_id <> s.management_property_id)
    )
    AND (SELECT count(*) = latest.version - previous.version + 1
      AND count(DISTINCT a.version) = latest.version - previous.version + 1
      FROM ai_settings_audit a WHERE a.scope_id = s.scope_id AND a.version BETWEEN previous.version AND latest.version)
)
UPDATE ai_model_settings s SET backup_enabled = true, version = s.version + 1,
  conversation_version = s.conversation_version + 1
FROM affected a WHERE s.scope_id = a.scope_id AND s.version = a.version;

CREATE OR REPLACE FUNCTION qintopia_save_ai_provider_settings(actor_id text, session_id text, property_id text, expected_version integer,
  new_enabled boolean, provider_role text, new_name text, new_provider_enabled boolean,
  new_base_url text, new_model text, new_encrypted_key text, test_passed boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_settings ai_model_settings; next_version integer;
  previous_url text; previous_model text; previous_key text; previous_enabled boolean;
  previous_tested_at timestamptz; next_tested_at timestamptz; next_key text; changed boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-settings:installation', 0));
  PERFORM 1 FROM subjects s JOIN web_sessions w ON w.subject_id = s.id
    JOIN subject_property_grants g ON g.subject_id = s.id
    JOIN staff_profile_assignments p ON p.subject_id = s.id AND p.property_id = g.property_id
    WHERE s.id = actor_id AND s.status = 'ACTIVE' AND w.id = session_id
      AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()
      AND g.property_id = qintopia_save_ai_provider_settings.property_id AND g.access_level = 'WRITE' AND p.profile = 'ADMIN'
    FOR SHARE OF s, w, g, p;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_FORBIDDEN'; END IF;
  SELECT * INTO current_settings FROM ai_model_settings WHERE scope_id = 'installation' FOR UPDATE;
  IF current_settings.scope_id IS NOT NULL AND current_settings.management_property_id <> property_id THEN RAISE EXCEPTION 'AI_FORBIDDEN'; END IF;
  IF expected_version IS NULL OR coalesce(current_settings.version, 0) <> expected_version THEN RAISE EXCEPTION 'AI_STALE'; END IF;
  IF provider_role IS NULL OR provider_role NOT IN ('primary', 'backup') OR new_enabled IS NULL OR new_provider_enabled IS NULL
    OR test_passed IS NULL OR new_name IS NULL OR length(btrim(new_name)) NOT BETWEEN 1 AND 80
    OR new_base_url IS NULL OR new_model IS NULL OR new_base_url !~ '^https://' OR length(new_base_url) > 2048
    OR length(btrim(new_model)) NOT BETWEEN 1 AND 120
    OR new_encrypted_key IS NOT NULL AND length(new_encrypted_key) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'AI_INVALID'; END IF;
  IF current_settings.scope_id IS NULL AND provider_role <> 'primary' THEN RAISE EXCEPTION 'AI_PRIMARY_REQUIRED'; END IF;

  IF provider_role = 'primary' THEN
    previous_url := current_settings.base_url; previous_model := current_settings.model;
    previous_key := current_settings.encrypted_key; previous_enabled := current_settings.provider_enabled;
    previous_tested_at := current_settings.provider_tested_at;
  ELSE
    previous_url := current_settings.backup_base_url; previous_model := current_settings.backup_model;
    previous_key := nullif(current_settings.backup_encrypted_key, ''); previous_enabled := current_settings.backup_enabled;
    previous_tested_at := current_settings.backup_tested_at;
  END IF;
  IF (previous_key IS NULL OR previous_url IS DISTINCT FROM new_base_url) AND new_encrypted_key IS NULL THEN RAISE EXCEPTION 'AI_KEY_REQUIRED'; END IF;
  next_key := coalesce(new_encrypted_key, previous_key);
  changed := previous_url IS DISTINCT FROM new_base_url OR previous_model IS DISTINCT FROM new_model
    OR previous_key IS DISTINCT FROM next_key;
  next_tested_at := CASE WHEN test_passed THEN clock_timestamp() WHEN changed THEN NULL ELSE previous_tested_at END;
  -- An already enabled unchanged provider remains usable in either slot.
  -- New/changed credentials and a re-enabled untested provider require a test.
  IF new_provider_enabled AND next_tested_at IS NULL
    AND NOT (current_settings.scope_id IS NOT NULL
      AND previous_enabled AND NOT changed AND (current_settings.enabled OR NOT new_enabled)) THEN RAISE EXCEPTION 'AI_TEST_REQUIRED'; END IF;
  -- Turning the installation back on must not activate an untested provider
  -- indirectly through an edit to the other slot.
  IF new_enabled AND NOT current_settings.enabled AND (
      provider_role = 'backup' AND current_settings.provider_enabled AND current_settings.provider_tested_at IS NULL
      OR provider_role = 'primary' AND current_settings.backup_enabled AND current_settings.backup_tested_at IS NULL
    ) THEN RAISE EXCEPTION 'AI_TEST_REQUIRED'; END IF;

  next_version := expected_version + 1;
  IF current_settings.scope_id IS NULL THEN
    INSERT INTO ai_model_settings(scope_id, management_property_id, version, conversation_version, enabled, base_url, model, encrypted_key,
      updated_by, updated_at, provider_name, provider_enabled, provider_tested_at)
      VALUES ('installation', property_id, next_version, 1, new_enabled, new_base_url, btrim(new_model), next_key,
        actor_id, clock_timestamp(), btrim(new_name), new_provider_enabled, next_tested_at);
  ELSIF provider_role = 'primary' THEN
    UPDATE ai_model_settings SET version = next_version, conversation_version = current_settings.conversation_version + 1,
      enabled = new_enabled, base_url = new_base_url,
      model = btrim(new_model), encrypted_key = next_key, provider_name = btrim(new_name),
      provider_enabled = new_provider_enabled, provider_tested_at = next_tested_at,
      updated_by = actor_id, updated_at = clock_timestamp() WHERE scope_id = 'installation';
  ELSE
    UPDATE ai_model_settings SET version = next_version, conversation_version = current_settings.conversation_version + 1,
      enabled = new_enabled, backup_base_url = new_base_url,
      backup_model = btrim(new_model), backup_encrypted_key = next_key, backup_name = btrim(new_name),
      backup_enabled = new_provider_enabled, backup_tested_at = next_tested_at,
      updated_by = actor_id, updated_at = clock_timestamp() WHERE scope_id = 'installation';
  END IF;
  INSERT INTO ai_settings_audit(scope_id, version, actor_subject_id, property_id, enabled, base_url, model, key_replaced,
    provider_role, operation, provider_name, provider_enabled, test_passed)
    VALUES ('installation', next_version, actor_id, property_id, new_enabled, new_base_url, btrim(new_model), new_encrypted_key IS NOT NULL,
      provider_role, 'SAVE', btrim(new_name), new_provider_enabled, test_passed);
  RETURN next_version;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_save_ai_provider_settings(text,text,text,integer,boolean,text,text,boolean,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_save_ai_provider_settings(text,text,text,integer,boolean,text,text,boolean,text,text,text,boolean) TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_promote_ai_backup(actor_id text, session_id text, property_id text, expected_version integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_settings ai_model_settings; next_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-settings:installation', 0));
  PERFORM 1 FROM subjects s JOIN web_sessions w ON w.subject_id = s.id
    JOIN subject_property_grants g ON g.subject_id = s.id
    JOIN staff_profile_assignments p ON p.subject_id = s.id AND p.property_id = g.property_id
    WHERE s.id = actor_id AND s.status = 'ACTIVE' AND w.id = session_id
      AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()
      AND g.property_id = qintopia_promote_ai_backup.property_id AND g.access_level = 'WRITE' AND p.profile = 'ADMIN'
    FOR SHARE OF s, w, g, p;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_FORBIDDEN'; END IF;
  SELECT * INTO current_settings FROM ai_model_settings WHERE scope_id = 'installation' FOR UPDATE;
  IF current_settings.scope_id IS NULL OR current_settings.management_property_id <> property_id THEN RAISE EXCEPTION 'AI_FORBIDDEN'; END IF;
  IF expected_version IS NULL OR current_settings.version <> expected_version THEN RAISE EXCEPTION 'AI_STALE'; END IF;
  IF NOT current_settings.backup_enabled THEN RAISE EXCEPTION 'AI_TEST_REQUIRED'; END IF;
  next_version := expected_version + 1;
  UPDATE ai_model_settings SET version = next_version,
    provider_name = current_settings.backup_name, provider_enabled = current_settings.backup_enabled,
    base_url = current_settings.backup_base_url, model = current_settings.backup_model,
    encrypted_key = current_settings.backup_encrypted_key, provider_tested_at = current_settings.backup_tested_at,
    backup_name = current_settings.provider_name,
    backup_enabled = current_settings.provider_enabled,
    backup_base_url = current_settings.base_url, backup_model = current_settings.model,
    backup_encrypted_key = current_settings.encrypted_key, backup_tested_at = current_settings.provider_tested_at,
    updated_by = actor_id, updated_at = clock_timestamp() WHERE scope_id = 'installation';
  INSERT INTO ai_settings_audit(scope_id, version, actor_subject_id, property_id, enabled, base_url, model, key_replaced,
    provider_role, operation, provider_name, provider_enabled, test_passed)
    VALUES ('installation', next_version, actor_id, property_id, current_settings.enabled,
      current_settings.backup_base_url, current_settings.backup_model, false,
      'primary', 'PROMOTE', current_settings.backup_name, current_settings.backup_enabled, false);
  RETURN next_version;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_promote_ai_backup(text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_promote_ai_backup(text,text,text,integer) TO qintopia_runtime;
