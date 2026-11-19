CREATE TABLE wechat_member_sessions (
  secret_hash text PRIMARY KEY,
  app_id text NOT NULL,
  property_id text NOT NULL REFERENCES properties(id),
  open_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  pairing_hash text UNIQUE,
  pairing_expires_at timestamptz,
  CHECK ((pairing_hash IS NULL) = (pairing_expires_at IS NULL))
);
CREATE INDEX wechat_member_sessions_expiry ON wechat_member_sessions(expires_at);
CREATE INDEX wechat_member_sessions_identity ON wechat_member_sessions(app_id, property_id, open_id);

CREATE TABLE wechat_member_bindings (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  property_id text NOT NULL,
  member_id text NOT NULL,
  open_id text,
  verified_by text NOT NULL REFERENCES subjects(id),
  verification text NOT NULL CHECK (verification IN ('IN_PERSON','REGISTERED_PHONE')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  subscription_template text,
  revoked_at timestamptz,
  revoked_by text REFERENCES subjects(id),
  FOREIGN KEY (member_id, property_id) REFERENCES member_property_links(member_id, property_id),
  CHECK ((revoked_at IS NULL) = (open_id IS NOT NULL)),
  CHECK (open_id IS NOT NULL OR subscription_template IS NULL)
);
CREATE UNIQUE INDEX wechat_member_bindings_member ON wechat_member_bindings(app_id, property_id, member_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX wechat_member_bindings_wechat ON wechat_member_bindings(app_id, property_id, open_id) WHERE revoked_at IS NULL;
CREATE TRIGGER wechat_member_active_profile BEFORE INSERT ON wechat_member_bindings
FOR EACH ROW EXECUTE FUNCTION qintopia_require_active_member();

CREATE FUNCTION qintopia_unlink_deleted_wechat_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.wechat_member_sessions s
    SET expires_at = NEW.deleted_at, pairing_hash = NULL, pairing_expires_at = NULL
    FROM public.wechat_member_bindings b
    WHERE b.member_id = NEW.id AND b.revoked_at IS NULL
      AND (s.app_id, s.property_id, s.open_id) = (b.app_id, b.property_id, b.open_id);
  UPDATE public.wechat_member_bindings
    SET revoked_at = NEW.deleted_at, open_id = NULL, subscription_template = NULL
    WHERE member_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION qintopia_unlink_deleted_wechat_member() FROM PUBLIC;
CREATE TRIGGER wechat_member_profile_deleted AFTER UPDATE OF deleted_at ON members
FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION qintopia_unlink_deleted_wechat_member();

CREATE TABLE wechat_member_expiry_notices (
  app_id text NOT NULL,
  order_id text NOT NULL REFERENCES membership_orders(id),
  expires_on date NOT NULL,
  lead_days integer NOT NULL CHECK (lead_days IN (60,30)),
  binding_id text NOT NULL REFERENCES wechat_member_bindings(id),
  state text NOT NULL CHECK (state IN ('UNKNOWN','ACCEPTED','REJECTED','RETRY')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  error_code integer,
  PRIMARY KEY (app_id, order_id, expires_on, lead_days)
);

REVOKE ALL ON wechat_member_sessions, wechat_member_bindings, wechat_member_expiry_notices FROM PUBLIC, qintopia_runtime, qintopia_ai_analytics_reader;
GRANT SELECT, INSERT ON wechat_member_sessions, wechat_member_bindings, wechat_member_expiry_notices TO qintopia_runtime;
GRANT UPDATE (expires_at, pairing_hash, pairing_expires_at) ON wechat_member_sessions TO qintopia_runtime;
GRANT UPDATE (open_id, subscription_template, revoked_at, revoked_by) ON wechat_member_bindings TO qintopia_runtime;
GRANT UPDATE (binding_id, state, attempted_at, error_code) ON wechat_member_expiry_notices TO qintopia_runtime;

CREATE FUNCTION qintopia_prune_wechat_member_sessions() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.wechat_member_sessions WHERE expires_at <= now()
$$;
REVOKE ALL ON FUNCTION qintopia_prune_wechat_member_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_prune_wechat_member_sessions() TO qintopia_runtime;
