-- Keep the deployed primary credentials in place; no test success is invented
-- for historical settings. The empty backup is disabled until configured/tested.
ALTER TABLE ai_model_settings
  ADD COLUMN provider_name text NOT NULL DEFAULT '主供应商',
  ADD COLUMN provider_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN provider_tested_at timestamptz,
  ADD COLUMN backup_name text NOT NULL DEFAULT '备用供应商',
  ADD COLUMN backup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN backup_base_url text NOT NULL DEFAULT '',
  ADD COLUMN backup_model text NOT NULL DEFAULT '',
  ADD COLUMN backup_encrypted_key text NOT NULL DEFAULT '',
  ADD COLUMN backup_tested_at timestamptz,
  ADD CONSTRAINT ai_provider_names_valid CHECK (length(provider_name) BETWEEN 1 AND 80 AND length(backup_name) BETWEEN 1 AND 80),
  ADD CONSTRAINT ai_backup_configuration_valid CHECK (
    (backup_base_url = '' AND backup_model = '' AND backup_encrypted_key = '' AND NOT backup_enabled AND backup_tested_at IS NULL)
    OR (backup_base_url ~ '^https://' AND length(backup_base_url) <= 2048 AND length(backup_model) BETWEEN 1 AND 120
        AND length(backup_encrypted_key) BETWEEN 1 AND 10000)),
  ADD CONSTRAINT ai_enabled_backup_tested CHECK (NOT backup_enabled OR backup_tested_at IS NOT NULL);

ALTER TABLE ai_settings_audit
  ADD COLUMN provider_role text NOT NULL DEFAULT 'primary' CHECK (provider_role IN ('primary', 'backup')),
  ADD COLUMN operation text NOT NULL DEFAULT 'SAVE' CHECK (operation IN ('SAVE', 'PROMOTE')),
  ADD COLUMN provider_name text NOT NULL DEFAULT '主供应商',
  ADD COLUMN provider_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN test_passed boolean NOT NULL DEFAULT false;

CREATE FUNCTION qintopia_save_ai_provider_settings(actor_id text, session_id text, property_id text, expected_version integer,
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
  -- A previously running unchanged primary remains usable after migration.
  -- New/changed credentials and a re-enabled untested provider require a test.
  IF new_provider_enabled AND next_tested_at IS NULL
    AND NOT (provider_role = 'primary' AND current_settings.scope_id IS NOT NULL
      AND previous_enabled AND NOT changed AND (current_settings.enabled OR NOT new_enabled)) THEN RAISE EXCEPTION 'AI_TEST_REQUIRED'; END IF;
  IF provider_role = 'backup' AND new_enabled AND NOT current_settings.enabled
    AND current_settings.provider_enabled AND current_settings.provider_tested_at IS NULL THEN RAISE EXCEPTION 'AI_TEST_REQUIRED'; END IF;

  next_version := expected_version + 1;
  IF current_settings.scope_id IS NULL THEN
    INSERT INTO ai_model_settings(scope_id, management_property_id, version, enabled, base_url, model, encrypted_key,
      updated_by, updated_at, provider_name, provider_enabled, provider_tested_at)
      VALUES ('installation', property_id, next_version, new_enabled, new_base_url, btrim(new_model), next_key,
        actor_id, clock_timestamp(), btrim(new_name), new_provider_enabled, next_tested_at);
  ELSIF provider_role = 'primary' THEN
    UPDATE ai_model_settings SET version = next_version, enabled = new_enabled, base_url = new_base_url,
      model = btrim(new_model), encrypted_key = next_key, provider_name = btrim(new_name),
      provider_enabled = new_provider_enabled, provider_tested_at = next_tested_at,
      updated_by = actor_id, updated_at = clock_timestamp() WHERE scope_id = 'installation';
  ELSE
    UPDATE ai_model_settings SET version = next_version, enabled = new_enabled, backup_base_url = new_base_url,
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

CREATE FUNCTION qintopia_promote_ai_backup(actor_id text, session_id text, property_id text, expected_version integer)
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
  IF NOT current_settings.backup_enabled OR current_settings.backup_tested_at IS NULL THEN RAISE EXCEPTION 'AI_TEST_REQUIRED'; END IF;
  next_version := expected_version + 1;
  UPDATE ai_model_settings SET version = next_version,
    provider_name = current_settings.backup_name, provider_enabled = current_settings.backup_enabled,
    base_url = current_settings.backup_base_url, model = current_settings.backup_model,
    encrypted_key = current_settings.backup_encrypted_key, provider_tested_at = current_settings.backup_tested_at,
    backup_name = current_settings.provider_name,
    backup_enabled = current_settings.provider_enabled AND current_settings.provider_tested_at IS NOT NULL,
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

-- Keep the former signature available without leaving an untested-activation
-- bypass. The same lock/CAS/authorization remain inside the new entry point.
CREATE OR REPLACE FUNCTION qintopia_save_ai_settings(actor_id text, session_id text, property_id text, expected_version integer,
  new_enabled boolean, new_base_url text, new_model text, new_encrypted_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_settings ai_model_settings;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:ai-settings:installation', 0));
  SELECT * INTO current_settings FROM ai_model_settings WHERE scope_id = 'installation';
  RETURN qintopia_save_ai_provider_settings(actor_id, session_id, property_id, expected_version, new_enabled,
    'primary', coalesce(current_settings.provider_name, '主供应商'),
    CASE WHEN current_settings.scope_id IS NULL THEN new_enabled ELSE current_settings.provider_enabled END,
    new_base_url, new_model, new_encrypted_key, false);
END;
$$;
REVOKE ALL ON FUNCTION qintopia_save_ai_settings(text,text,text,integer,boolean,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_save_ai_settings(text,text,text,integer,boolean,text,text,text) TO qintopia_runtime;
