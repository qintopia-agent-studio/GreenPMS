ALTER TABLE wechat_member_bindings
  ALTER COLUMN verified_by DROP NOT NULL,
  DROP CONSTRAINT wechat_member_bindings_verification_check,
  ADD CONSTRAINT wechat_member_bindings_verification_check CHECK (
    (verification = 'SMS_OTP' AND verified_by IS NULL) OR
    (verification IN ('IN_PERSON', 'REGISTERED_PHONE') AND verified_by IS NOT NULL)
  );

CREATE TABLE wechat_member_sms_challenges (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  property_id text NOT NULL REFERENCES properties(id),
  session_hash text NOT NULL,
  wechat_key text NOT NULL,
  phone_key text NOT NULL,
  member_id text REFERENCES members(id),
  code_mac text NOT NULL,
  attempts_left smallint NOT NULL DEFAULT 5 CHECK (attempts_left BETWEEN 0 AND 5),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX wechat_member_sms_phone ON wechat_member_sms_challenges(app_id, property_id, phone_key, issued_at DESC);
CREATE INDEX wechat_member_sms_identity ON wechat_member_sms_challenges(app_id, property_id, wechat_key, issued_at DESC);
CREATE INDEX wechat_member_sms_expiry ON wechat_member_sms_challenges(issued_at);
CREATE INDEX members_active_sms_phone ON members(regexp_replace(phone, '[[:space:]()-]', '', 'g')) WHERE deleted_at IS NULL;

REVOKE ALL ON wechat_member_sms_challenges FROM PUBLIC, qintopia_runtime, qintopia_ai_analytics_reader;
GRANT SELECT, INSERT, UPDATE (attempts_left) ON wechat_member_sms_challenges TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_prune_wechat_member_sessions() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.wechat_member_sessions WHERE expires_at <= now();
  DELETE FROM public.wechat_member_sms_challenges WHERE issued_at <= now() - interval '24 hours'
$$;

UPDATE wechat_member_sessions SET pairing_hash = NULL, pairing_expires_at = NULL WHERE pairing_hash IS NOT NULL;
