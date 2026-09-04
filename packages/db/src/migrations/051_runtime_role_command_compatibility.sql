LOCK TABLE inventory_units, stays, amendments, command_executions
  IN SHARE ROW EXCLUSIVE MODE;

-- MOVE_UNIT must lock the target catalog rows while it validates that they are
-- still active. PostgreSQL requires an UPDATE privilege for SELECT ... FOR
-- UPDATE, so grant one immutable column and reject every real runtime UPDATE in
-- a dedicated trigger.
GRANT UPDATE (created_at) ON inventory_units TO qintopia_runtime;

CREATE OR REPLACE FUNCTION qintopia_guard_runtime_inventory_unit_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'qintopia_runtime'
    AND session_user = 'qintopia_runtime' THEN
    RAISE EXCEPTION 'runtime inventory unit updates are forbidden'
      USING ERRCODE = '42501', CONSTRAINT = 'inventory_units_runtime_update_forbidden';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_inventory_unit_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_inventory_unit_update() FROM qintopia_runtime;

CREATE TRIGGER inventory_units_runtime_update_guard
BEFORE UPDATE ON inventory_units
FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_inventory_unit_update();

DO $$
DECLARE
  function_definition text;
  old_declaration_fragment text := $fragment$
  projection_kind text;
  current_xid xid := (pg_current_xact_id()::text)::xid;
$fragment$;
  new_declaration_fragment text := $fragment$
  projection_kind text;
  source_stay_status text;
  target_stay_status text;
  current_xid xid := (pg_current_xact_id()::text)::xid;
$fragment$;
  old_stay_fragment text := $fragment$
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
$fragment$;
  new_stay_fragment text := $fragment$
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'runtime stay updates must advance lifecycle status'
          USING ERRCODE = '23514', CONSTRAINT = 'stays_runtime_status_transition';
      END IF;
      SELECT amendment.command_id
        INTO target_command_id
      FROM amendments AS amendment
      WHERE amendment.order_id = NEW.order_id
        AND amendment.xmin = current_xid
        AND (
          (NEW.status = 'IN_HOUSE' AND amendment.amendment_type = 'CHECK_IN')
          OR (NEW.status = 'COMPLETED' AND amendment.amendment_type = 'CHECK_OUT')
          OR (NEW.status = 'CANCELLED' AND amendment.amendment_type = 'CANCEL_ORDER')
          OR (NEW.status = 'NO_SHOW' AND amendment.amendment_type = 'MARK_NO_SHOW')
          OR (NEW.status = 'CHECK_IN_REVOKED' AND amendment.amendment_type = 'REVOKE_CHECK_IN')
        )
      ORDER BY amendment.sequence DESC
      LIMIT 1;
      source_stay_status := OLD.status;
      target_stay_status := NEW.status;
      projection_kind := 'stay-status';
$fragment$;
  old_type_fragment text := $fragment$
  IF projection_kind = 'membership-activation'
$fragment$;
  new_type_fragment text := $fragment$
  IF projection_kind = 'stay-status'
    AND NOT (
      (source_stay_status = 'PLANNED'
        AND target_stay_status = 'IN_HOUSE'
        AND target_command_type = 'CHECK_IN')
      OR (source_stay_status = 'PLANNED'
        AND target_stay_status = 'COMPLETED'
        AND target_command_type IN ('COMPLETE_STAY', 'BACKFILL_COMPLETED_STAY'))
      OR (source_stay_status = 'IN_HOUSE'
        AND target_stay_status = 'COMPLETED'
        AND target_command_type IN ('CHECK_OUT', 'SHORTEN_STAY'))
      OR (source_stay_status = 'PLANNED'
        AND target_stay_status = 'CANCELLED'
        AND target_command_type = 'CANCEL_ORDER')
      OR (source_stay_status = 'PLANNED'
        AND target_stay_status = 'NO_SHOW'
        AND target_command_type = 'MARK_NO_SHOW')
      OR (source_stay_status = 'IN_HOUSE'
        AND target_stay_status = 'CHECK_IN_REVOKED'
        AND target_command_type = 'REVOKE_CHECK_IN')
  ) THEN
    RAISE EXCEPTION 'runtime stay lifecycle update requires its exact source state and command type'
      USING ERRCODE = '23514', CONSTRAINT = 'stays_runtime_status_transition';
  ELSIF projection_kind = 'membership-activation'
$fragment$;
BEGIN
  SELECT pg_get_functiondef('qintopia_guard_runtime_mutable_projection_update()'::regprocedure)
    INTO STRICT function_definition;

  IF position(old_declaration_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 051 could not locate the runtime projection declaration fragment';
  END IF;
  function_definition := replace(
    function_definition,
    old_declaration_fragment,
    new_declaration_fragment
  );

  IF position(old_stay_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 051 could not locate the runtime stay evidence fragment';
  END IF;
  function_definition := replace(function_definition, old_stay_fragment, new_stay_fragment);

  IF position(old_type_fragment IN function_definition) = 0 THEN
    RAISE EXCEPTION 'migration 051 could not locate the runtime projection type fragment';
  END IF;
  function_definition := replace(function_definition, old_type_fragment, new_type_fragment);

  EXECUTE function_definition;

  IF position(new_stay_fragment IN pg_get_functiondef(
      'qintopia_guard_runtime_mutable_projection_update()'::regprocedure
    )) = 0
    OR position(new_type_fragment IN pg_get_functiondef(
      'qintopia_guard_runtime_mutable_projection_update()'::regprocedure
    )) = 0 THEN
    RAISE EXCEPTION 'migration 051 did not install the runtime stay compatibility guard';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION qintopia_guard_runtime_mutable_projection_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_guard_runtime_mutable_projection_update() FROM qintopia_runtime;
