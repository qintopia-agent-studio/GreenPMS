DO $$
DECLARE
  granted_role record;
BEGIN
  IF current_user = 'qintopia_runtime' THEN
    RAISE EXCEPTION 'migration 047 must run as the migration owner, not qintopia_runtime';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qintopia_runtime') THEN
    ALTER ROLE qintopia_runtime
      WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    CREATE ROLE qintopia_runtime
      WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS runtime_role
      ON runtime_role.oid = membership.member
      AND runtime_role.rolname = 'qintopia_runtime'
    JOIN pg_roles AS granted
      ON granted.oid = membership.roleid
  LOOP
    EXECUTE format('REVOKE %I FROM qintopia_runtime', granted_role.rolname);
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS runtime_role ON runtime_role.oid = membership.member
    WHERE runtime_role.rolname = 'qintopia_runtime'
  ) THEN
    RAISE EXCEPTION 'qintopia_runtime must not retain any role memberships';
  END IF;
END;
$$;

ALTER ROLE qintopia_runtime RESET ALL;
ALTER ROLE qintopia_runtime SET search_path = public;

DO $$
BEGIN
  EXECUTE format('ALTER ROLE qintopia_runtime IN DATABASE %I RESET ALL', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM qintopia_runtime', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO qintopia_runtime', current_database());
END;
$$;

REVOKE ALL ON PARAMETER session_replication_role FROM qintopia_runtime;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM qintopia_runtime;
GRANT USAGE ON SCHEMA public TO qintopia_runtime;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM qintopia_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO qintopia_runtime;

GRANT INSERT ON
  amendments,
  api_tokens,
  audit_entries,
  cleaning_tasks,
  collection_facts,
  command_executions,
  command_previews,
  command_receipts,
  coverage_items,
  entitlement_ledger,
  entitlement_lots,
  inventory_bed_days,
  inventory_claims,
  inventory_room_days,
  maintenance_locks,
  member_contracts,
  member_property_links,
  members,
  membership_orders,
  membership_payment_facts,
  order_occupant_corrections,
  order_occupants,
  orders,
  pricing_revisions,
  quotes,
  room_status_revisions,
  security_audit_entries,
  stay_collection_membership_transfers,
  stay_segments,
  stays,
  token_command_ceilings,
  web_sessions
TO qintopia_runtime;

GRANT UPDATE (revoked_at) ON web_sessions TO qintopia_runtime;
GRANT UPDATE (state, completed_at) ON command_executions TO qintopia_runtime;
GRANT UPDATE (status, used_at) ON command_previews TO qintopia_runtime;
GRANT UPDATE (revoked_at, replaced_by_id) ON api_tokens TO qintopia_runtime;

-- PostgreSQL row locks (`FOR SHARE` / `FOR UPDATE`) require UPDATE privilege.
-- These grants are only lock affordances; the trigger below keeps runtime from
-- mutating authorization identity tables directly.
GRANT UPDATE (created_at) ON
  subjects,
  subject_property_grants,
  subject_command_grants,
  token_command_ceilings,
  order_occupants
TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_reject_runtime_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'qintopia_runtime' THEN
    RAISE EXCEPTION 'qintopia_runtime may lock authorization rows but must not mutate them directly';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subjects_reject_runtime_identity_mutation ON subjects;
CREATE TRIGGER subjects_reject_runtime_identity_mutation
BEFORE UPDATE OR DELETE ON subjects
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_runtime_identity_mutation();

DROP TRIGGER IF EXISTS subject_property_grants_reject_runtime_identity_mutation ON subject_property_grants;
CREATE TRIGGER subject_property_grants_reject_runtime_identity_mutation
BEFORE UPDATE OR DELETE ON subject_property_grants
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_runtime_identity_mutation();

DROP TRIGGER IF EXISTS subject_command_grants_reject_runtime_identity_mutation ON subject_command_grants;
CREATE TRIGGER subject_command_grants_reject_runtime_identity_mutation
BEFORE UPDATE OR DELETE ON subject_command_grants
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_runtime_identity_mutation();

DROP TRIGGER IF EXISTS token_command_ceilings_reject_runtime_identity_mutation ON token_command_ceilings;
CREATE TRIGGER token_command_ceilings_reject_runtime_identity_mutation
BEFORE UPDATE OR DELETE ON token_command_ceilings
FOR EACH ROW EXECUTE FUNCTION qintopia_reject_runtime_identity_mutation();

GRANT UPDATE (
  status,
  activated_at,
  valid_from,
  valid_until,
  contract_id,
  entitlement_lot_id,
  version,
  activated_by_command_id,
  updated_at
) ON membership_orders TO qintopia_runtime;
GRANT UPDATE (version) ON member_contracts TO qintopia_runtime;
GRANT UPDATE (version) ON entitlement_lots TO qintopia_runtime;
GRANT UPDATE (
  status,
  arrival_date,
  departure_date,
  current_revision_id,
  member_id,
  member_contract_id,
  version,
  updated_at
) ON orders TO qintopia_runtime;
GRANT UPDATE (status) ON stays TO qintopia_runtime;
GRANT UPDATE (status, updated_at) ON coverage_items TO qintopia_runtime;
GRANT UPDATE (whole_claim_id, version, updated_at) ON inventory_room_days TO qintopia_runtime;
GRANT UPDATE (bed_claim_id, version, updated_at) ON inventory_bed_days TO qintopia_runtime;
GRANT UPDATE (active, released_at) ON inventory_claims TO qintopia_runtime;
GRANT UPDATE (status, version, released_by_command_id, released_at) ON maintenance_locks TO qintopia_runtime;
GRANT UPDATE (status, version, completed_by_command_id, completed_at) ON cleaning_tasks TO qintopia_runtime;
GRANT UPDATE (revision, updated_at) ON room_status_revisions TO qintopia_runtime;

-- Future migrations inherit read access only. Any new API-write surface must
-- add its own INSERT or column-level UPDATE grants in the same migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM qintopia_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO qintopia_runtime;
