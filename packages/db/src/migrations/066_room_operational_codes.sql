-- Operational room/bed codes must never rewrite canonical inventory snapshots.
DO $migration$
DECLARE definition text;
BEGIN
  IF (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc
      WHERE oid = 'qintopia_apply_room_catalog(text,jsonb,text)'::regprocedure)
      <> '23bd6ef1430e90c04407cdcda5be5a65d2f22c41ef19a490ec410bf9f96b77e8' THEN
    RAISE EXCEPTION 'unrecognized room catalog boundary';
  END IF;
  SELECT pg_get_functiondef('qintopia_apply_room_catalog(text,jsonb,text)'::regprocedure) INTO definition;
  definition := replace(definition, '''PUBLISH_RATES'',''SET_BUILDING_ORDER'') THEN', '''PUBLISH_RATES'',''SET_BUILDING_ORDER'',''RENAME_ROOM'') THEN');
  definition := replace(definition, $old$  IF action_name = 'SET_BUILDING_ORDER' THEN$old$, $new$
  IF action_name = 'RENAME_ROOM' OR (action_name = 'SAVE_ROOM' AND approved_effect->'roomRename' IS NOT NULL) THEN
    DECLARE
      renamed inventory_units%ROWTYPE;
      new_code text := approved_effect#>>'{roomRename,afterCode}';
      expected_codes jsonb := COALESCE(state.snapshot->'unitCodes', '{}'::jsonb);
      changed_ids text[];
    BEGIN
      SELECT * INTO renamed FROM inventory_units WHERE id = approved_effect#>>'{roomRename,roomId}'
        AND property_id = execution.property_id AND kind = 'ROOM' AND active FOR UPDATE;
      IF renamed.id IS NULL OR new_code IS NULL OR btrim(new_code) = '' OR new_code <> btrim(new_code)
        OR length(new_code) > 60 OR new_code ~ '[[:cntrl:]]'
        OR approved_effect#>>'{roomRename,beforeCode}' IS DISTINCT FROM COALESCE(expected_codes->>renamed.id, renamed.code)
        OR new_code = COALESCE(expected_codes->>renamed.id, renamed.code)
        OR approved_effect->'retireUnitIds' IS DISTINCT FROM '[]'::jsonb
        OR approved_effect->'insertUnits' IS DISTINCT FROM '[]'::jsonb
        OR approved_effect->'policies' IS DISTINCT FROM '[]'::jsonb
        OR approved_effect->'roomLink' IS DISTINCT FROM 'null'::jsonb
        OR (state.version IS NOT NULL AND ((approved_effect->'after') - 'version' - 'unitCodes') IS DISTINCT FROM (state.snapshot - 'version' - 'unitCodes'))
        OR (state.version IS NULL AND approved_effect#>'{after,rates}' IS DISTINCT FROM '[]'::jsonb) THEN
        RAISE EXCEPTION 'room rename must preserve inventory, pricing and catalog structure' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM inventory_units WHERE parent_room_id = renamed.id
        AND left(code, length(renamed.code) + 1) <> renamed.code || '-') THEN
        RAISE EXCEPTION 'room rename requires consistent child codes' USING ERRCODE = '23514';
      END IF;
      SELECT array_agg(id), expected_codes || jsonb_object_agg(id,
        CASE WHEN id = renamed.id THEN new_code ELSE new_code || substr(code, length(renamed.code) + 1) END)
      INTO changed_ids, expected_codes FROM inventory_units WHERE id = renamed.id OR parent_room_id = renamed.id;
      IF approved_effect#>'{after,unitCodes}' IS DISTINCT FROM expected_codes THEN
        RAISE EXCEPTION 'room rename must change exactly the room and its child labels' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM inventory_units AS other
        WHERE other.property_id = execution.property_id AND (other.active OR other.kind = 'ROOM') AND NOT (other.id = ANY(changed_ids))
        AND EXISTS (SELECT 1 FROM unnest(changed_ids) AS changed(id)
          WHERE expected_codes->>changed.id IN (other.code, COALESCE(expected_codes->>other.id, other.code)))) THEN
        RAISE EXCEPTION 'room or bed operational code already exists' USING ERRCODE = '23514';
      END IF;
    END;
  ELSE
    IF COALESCE(approved_effect#>'{after,unitCodes}', '{}'::jsonb) IS DISTINCT FROM COALESCE(state.snapshot->'unitCodes', '{}'::jsonb)
      OR approved_effect->'roomRename' IS NOT NULL THEN
      RAISE EXCEPTION 'only a room rename can change operational codes' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(approved_effect->'insertUnits') AS added
      JOIN inventory_units AS existing ON existing.property_id = execution.property_id AND existing.active
      WHERE NOT (approved_effect->'retireUnitIds') ? existing.id
        AND added->>'code' = COALESCE(state.snapshot->'unitCodes'->>existing.id, existing.code)) THEN
      RAISE EXCEPTION 'new inventory conflicts with an operational code' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF action_name = 'SET_BUILDING_ORDER' THEN$new$);
  EXECUTE definition;
END $migration$;
