-- Immutable versions remain untouched; mutable sale state belongs to a property.
CREATE FUNCTION qintopia_membership_validity_valid(period text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN period ~ '^P[1-9][0-9]{0,9}(M|Y)$'
    THEN substring(period FROM 2 FOR length(period)-2)::bigint <= 2147483647 ELSE false END;
$$;
CREATE FUNCTION qintopia_membership_valid_until(start_date date, period text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE amount bigint; months bigint; result date;
BEGIN
  IF NOT qintopia_membership_validity_valid(period) OR start_date IS NULL THEN
    RAISE EXCEPTION 'invalid membership validity period' USING ERRCODE = '23514';
  END IF;
  amount := substring(period FROM 2 FOR length(period)-2)::bigint;
  months := amount * CASE WHEN right(period, 1) = 'Y' THEN 12 ELSE 1 END;
  IF extract(year FROM start_date) < 1 OR extract(year FROM start_date) * 12 + extract(month FROM start_date) - 1 + months >= 120000 THEN
    RAISE EXCEPTION 'membership expiration exceeds supported date range' USING ERRCODE = '23514';
  END IF;
  result := (start_date + make_interval(months => months::integer))::date;
  RETURN result;
END $$;
ALTER TABLE membership_products DROP CONSTRAINT membership_products_validity_period_check;
ALTER TABLE membership_products ADD CONSTRAINT membership_products_validity_period_check CHECK (qintopia_membership_validity_valid(validity_period));
ALTER TABLE historical_membership_backfills DROP CONSTRAINT historical_membership_backfills_validity_period_check;
ALTER TABLE historical_membership_backfills ADD CONSTRAINT historical_membership_backfills_validity_period_check CHECK (qintopia_membership_validity_valid(validity_period));
ALTER TABLE membership_orders ADD COLUMN validity_period text NOT NULL DEFAULT 'P1Y'
  CONSTRAINT membership_orders_validity_period_check CHECK (qintopia_membership_validity_valid(validity_period));
ALTER TABLE membership_products ADD CONSTRAINT membership_products_id_code_unique UNIQUE (id, code);
CREATE TABLE membership_product_catalog (
  code text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  current_product_id text NOT NULL,
  sale_status text NOT NULL CHECK (sale_status IN ('ON_SALE','OFF_SALE')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (current_product_id, code) REFERENCES membership_products(id, code)
);
CREATE TABLE membership_catalog_changes (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id),
  command_id text NOT NULL UNIQUE REFERENCES command_executions(id),
  effect jsonb NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER membership_catalog_changes_append_only BEFORE UPDATE OR DELETE ON membership_catalog_changes
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();
CREATE FUNCTION qintopia_membership_catalog_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'membership catalog cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'membership catalog identity or revision is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_catalog_identity BEFORE UPDATE OR DELETE ON membership_product_catalog
FOR EACH ROW EXECUTE FUNCTION qintopia_membership_catalog_identity();
CREATE FUNCTION qintopia_membership_version_catalog_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM membership_product_catalog WHERE code = NEW.code) THEN
    RAISE EXCEPTION 'new membership version requires a property catalog' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER membership_version_catalog_guard AFTER INSERT ON membership_products
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_membership_version_catalog_guard();

CREATE FUNCTION qintopia_initialize_membership_catalog(target_property text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM properties WHERE id = target_property) THEN RAISE EXCEPTION 'membership catalog property missing'; END IF;
  IF EXISTS (SELECT 1 FROM membership_product_catalog WHERE property_id <> target_property) THEN
    RAISE EXCEPTION 'membership template ownership already assigned';
  END IF;
  INSERT INTO membership_product_catalog(code, property_id, current_product_id, sale_status, revision)
  SELECT code, target_property, id, 'ON_SALE', 1 FROM membership_products
  WHERE id IN ('membership_product_shared_bath_single_v1','membership_product_private_bath_single_v1',
    'membership_product_shared_bath_quad_v1','membership_product_private_bath_shared_v1')
  ON CONFLICT (code) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION qintopia_initialize_membership_catalog(text) FROM PUBLIC, qintopia_runtime;

DO $$ DECLARE target_property text; property_count integer;
BEGIN
  IF (SELECT count(*) FROM membership_products) <> 4 OR EXISTS (
    SELECT 1 FROM membership_products p FULL JOIN (VALUES
      ('membership_product_shared_bath_single_v1','SHARED_BATH_SINGLE_30','公卫单人间会员',162000,'ROOM_NIGHT','shared_bath_single','ROOM',NULL::text[]),
      ('membership_product_private_bath_single_v1','PRIVATE_BATH_SINGLE_30','独卫单人间会员',216000,'ROOM_NIGHT','private_bath_single','ROOM',NULL::text[]),
      ('membership_product_shared_bath_quad_v1','SHARED_BATH_QUAD_30','公卫四人间会员',93600,'BED_NIGHT','shared_bath_quad','BED',NULL::text[]),
      ('membership_product_private_bath_shared_v1','PRIVATE_BATH_SHARED_30','独卫标间／大床通用会员',280000,'ROOM_NIGHT','private_bath_standard','ROOM',ARRAY['private_bath_standard','private_bath_king'])
    ) AS expected(id,code,name,price,unit,anchor,kind,scope) ON p.id = expected.id
    WHERE p.id IS NULL OR expected.id IS NULL OR p.code IS DISTINCT FROM expected.code OR p.version <> 1
      OR p.name IS DISTINCT FROM expected.name OR p.list_price_minor IS DISTINCT FROM expected.price
      OR p.currency <> 'CNY' OR p.entitlement_unit_kind IS DISTINCT FROM expected.unit OR p.entitlement_units <> 30
      OR p.validity_period <> 'P1Y' OR p.allowed_room_type_code IS DISTINCT FROM expected.anchor
      OR p.allowed_inventory_kind IS DISTINCT FROM expected.kind OR p.allowed_room_type_codes IS DISTINCT FROM expected.scope
      OR p.status <> 'PUBLISHED'
  ) THEN RAISE EXCEPTION 'membership catalog migration: unknown or changed legacy templates; explicit ownership mapping required'; END IF;
  SELECT count(*), min(id) INTO property_count, target_property FROM properties;
  IF property_count > 1 THEN RAISE EXCEPTION 'membership catalog migration: ambiguous property ownership'; END IF;
  IF property_count = 0 THEN
    IF EXISTS (SELECT 1 FROM membership_orders) OR EXISTS (SELECT 1 FROM historical_membership_backfills) THEN
      RAISE EXCEPTION 'membership catalog migration: orphan business references';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM membership_orders WHERE property_id <> target_property)
      OR EXISTS (SELECT 1 FROM historical_membership_backfills WHERE property_id <> target_property) THEN
      RAISE EXCEPTION 'membership catalog migration: conflicting business ownership';
    END IF;
    PERFORM qintopia_initialize_membership_catalog(target_property);
  END IF;
END $$;

CREATE FUNCTION qintopia_membership_validity_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE product membership_products%ROWTYPE; head membership_product_catalog%ROWTYPE; command_type text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.validity_period IS DISTINCT FROM OLD.validity_period THEN
      RAISE EXCEPTION 'membership validity snapshot is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT product FROM membership_products WHERE id = NEW.product_id;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('qintopia:room-catalog:' || NEW.property_id, 0::bigint));
  SELECT * INTO STRICT head FROM membership_product_catalog WHERE code = product.code;
  IF head.property_id IS DISTINCT FROM NEW.property_id OR NEW.validity_period IS DISTINCT FROM product.validity_period THEN
    RAISE EXCEPTION 'membership product ownership or validity mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'membership_orders' THEN
    SELECT e.command_type INTO command_type FROM command_executions e WHERE e.id = NEW.created_by_command_id;
    IF COALESCE(command_type, '') NOT IN ('BACKFILL_HISTORICAL_MEMBERSHIP','VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY')
      AND (head.sale_status <> 'ON_SALE' OR head.current_product_id <> product.id) THEN
      RAISE EXCEPTION 'membership product is no longer on sale' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_orders_validity_snapshot BEFORE INSERT OR UPDATE ON membership_orders
FOR EACH ROW EXECUTE FUNCTION qintopia_membership_validity_snapshot_guard();
CREATE TRIGGER historical_membership_backfills_validity_snapshot BEFORE INSERT OR UPDATE ON historical_membership_backfills
FOR EACH ROW EXECUTE FUNCTION qintopia_membership_validity_snapshot_guard();
GRANT SELECT ON membership_product_catalog, membership_catalog_changes TO qintopia_runtime;
REVOKE ALL ON FUNCTION qintopia_membership_validity_valid(text), qintopia_membership_valid_until(date,text),
  qintopia_membership_catalog_identity(), qintopia_membership_version_catalog_guard(), qintopia_membership_validity_snapshot_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_membership_validity_valid(text), qintopia_membership_valid_until(date,text) TO qintopia_runtime;

LOCK TABLE command_catalog, staff_command_profile_catalog, subject_command_grants,
  inventory_units, inventory_claims, coverage_items IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO command_catalog(command_type, command_class) VALUES ('MANAGE_MEMBERSHIP_CATALOG', 'HUMAN_COMMAND');
DO $$ DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
  WHERE conrelid = 'subject_command_grants'::regclass AND conname = 'subject_command_grants_human_exact_check';
  IF position('''CORRECT_ORDER_OCCUPANT''::text' IN definition) = 0 THEN RAISE EXCEPTION 'catalog grant constraint not recognized'; END IF;
  definition := replace(definition, '''CORRECT_ORDER_OCCUPANT''::text', '''CORRECT_ORDER_OCCUPANT''::text, ''MANAGE_MEMBERSHIP_CATALOG''::text');
  ALTER TABLE subject_command_grants DROP CONSTRAINT subject_command_grants_human_exact_check;
  EXECUTE 'ALTER TABLE subject_command_grants ADD CONSTRAINT subject_command_grants_human_exact_check ' || definition;
END $$;
INSERT INTO staff_command_profile_catalog(profile, command_type, token_default) VALUES ('ADMIN', 'MANAGE_MEMBERSHIP_CATALOG', false);
INSERT INTO subject_command_grants(subject_id, property_id, command_type)
SELECT subject_id, property_id, 'MANAGE_MEMBERSHIP_CATALOG' FROM staff_profile_assignments WHERE profile = 'ADMIN';
UPDATE staff_profile_reconciliation_state SET projection_hash = (
  SELECT encode(sha256(convert_to(COALESCE(string_agg(row_value, E'\n' ORDER BY row_value), ''), 'UTF8')), 'hex')
  FROM (
    SELECT format('A|%s|%s|%s', subject_id, property_id, profile) AS row_value FROM staff_profile_assignments
    UNION ALL SELECT format('G|%s|%s|%s', subject_id, property_id, command_type) FROM subject_command_grants
  ) AS projection
), reconciled_by = current_user, reconciled_at = now() WHERE singleton;


CREATE FUNCTION qintopia_apply_membership_catalog(target_command text, approved_effect jsonb, reason_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE execution command_executions%ROWTYPE; head membership_product_catalog%ROWTYPE;
  next_head jsonb := approved_effect->'after'; product jsonb := approved_effect#>'{after,current}';
  action_name text := approved_effect->>'action'; change_id text := 'membership_catalog_change_' || target_command;
  room_version integer; scope text[]; inventory_kind text; actual_before jsonb;
BEGIN
  SELECT * INTO execution FROM command_executions WHERE id = target_command FOR UPDATE;
  IF execution.command_type IS DISTINCT FROM 'MANAGE_MEMBERSHIP_CATALOG' OR execution.state IS DISTINCT FROM 'EXECUTING'
    OR approved_effect->>'operation' IS DISTINCT FROM execution.command_type
    OR approved_effect->>'propertyId' IS DISTINCT FROM execution.property_id
    OR next_head->>'propertyId' IS DISTINCT FROM execution.property_id OR COALESCE(btrim(reason_note),'') = '' THEN
    RAISE EXCEPTION 'membership catalog requires executing typed command and reason' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('qintopia:room-catalog:' || execution.property_id, 0::bigint));
  IF NOT EXISTS (SELECT 1 FROM staff_profile_assignments a
    JOIN subjects s ON s.id = a.subject_id
    JOIN subject_property_grants g ON g.subject_id = s.id AND g.property_id = a.property_id
    JOIN subject_command_grants c ON c.subject_id = s.id AND c.property_id = a.property_id
    JOIN web_sessions w ON w.subject_id = s.id AND w.id = execution.credential_id
    WHERE a.subject_id = execution.subject_id AND a.property_id = execution.property_id AND a.profile = 'ADMIN'
      AND s.status = 'ACTIVE' AND g.access_level = 'WRITE' AND c.command_type = execution.command_type
      AND w.revoked_at IS NULL AND w.expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'membership catalog requires administrator session' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM command_previews WHERE subject_id = execution.subject_id AND property_id = execution.property_id
    AND command_type = execution.command_type AND status = 'OPEN' AND effect = approved_effect AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'membership catalog requires matching open preview' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE((SELECT version FROM room_catalog_state WHERE property_id = execution.property_id),0) INTO room_version;
  IF room_version IS DISTINCT FROM (approved_effect->>'roomCatalogVersion')::integer THEN
    RAISE EXCEPTION 'membership room catalog changed' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO head FROM membership_product_catalog WHERE code = next_head->>'code' FOR UPDATE;
  IF action_name = 'CREATE' THEN
    IF head.code IS NOT NULL OR approved_effect->'before' IS DISTINCT FROM 'null'::jsonb
      OR (next_head->>'revision')::integer IS DISTINCT FROM 1 OR (product->>'version')::integer IS DISTINCT FROM 1
      OR next_head->>'saleStatus' IS DISTINCT FROM 'ON_SALE' THEN
      RAISE EXCEPTION 'invalid new membership catalog' USING ERRCODE = '23514';
    END IF;
  ELSIF action_name IN ('UPDATE','SET_SALE_STATUS') THEN
    IF head.property_id IS DISTINCT FROM execution.property_id OR head.code IS NULL
      OR head.revision IS DISTINCT FROM (approved_effect#>>'{before,revision}')::integer
      OR head.current_product_id IS DISTINCT FROM approved_effect#>>'{before,current,productId}'
      OR (next_head->>'revision')::integer IS DISTINCT FROM head.revision + 1 THEN
      RAISE EXCEPTION 'membership catalog revision conflict' USING ERRCODE = '40001';
    END IF;
    SELECT jsonb_build_object('propertyId',head.property_id,'code',head.code,'revision',head.revision,'saleStatus',head.sale_status,
      'current',jsonb_build_object('productId',p.id,'code',p.code,'version',p.version,'name',p.name,'listPriceMinor',p.list_price_minor,
        'currency',p.currency,'entitlementUnitKind',p.entitlement_unit_kind,'entitlementUnits',p.entitlement_units,
        'validityPeriod',p.validity_period,'allowedRoomTypeCode',p.allowed_room_type_code,
        'allowedRoomTypeCodes',COALESCE(p.allowed_room_type_codes,ARRAY[p.allowed_room_type_code]),'allowedInventoryKind',p.allowed_inventory_kind))
      INTO actual_before FROM membership_products p WHERE p.id=head.current_product_id;
    IF approved_effect->'before' IS DISTINCT FROM actual_before THEN
      RAISE EXCEPTION 'membership prior specification mismatch' USING ERRCODE = '23514';
    END IF;
    IF action_name = 'UPDATE' AND (next_head->>'saleStatus' IS DISTINCT FROM head.sale_status
      OR (product->>'version')::integer IS DISTINCT FROM (SELECT version + 1 FROM membership_products WHERE id = head.current_product_id)) THEN
      RAISE EXCEPTION 'invalid membership version update' USING ERRCODE = '23514';
    END IF;
    IF action_name = 'SET_SALE_STATUS' AND product IS DISTINCT FROM approved_effect#>'{before,current}' THEN
      RAISE EXCEPTION 'sale status cannot change membership specification' USING ERRCODE = '23514';
    END IF;
  ELSE RAISE EXCEPTION 'unsupported membership catalog action' USING ERRCODE = '23514'; END IF;
  IF product->>'currency' IS DISTINCT FROM (SELECT currency FROM properties WHERE id=execution.property_id) THEN
    RAISE EXCEPTION 'membership currency mismatch' USING ERRCODE = '23514';
  END IF;
  IF product->>'code' IS DISTINCT FROM next_head->>'code' THEN RAISE EXCEPTION 'membership code mismatch' USING ERRCODE = '23514'; END IF;
  SELECT array_agg(value ORDER BY value) INTO scope FROM jsonb_array_elements_text(product->'allowedRoomTypeCodes');
  inventory_kind := product->>'allowedInventoryKind';
  IF action_name <> 'SET_SALE_STATUS' OR next_head->>'saleStatus' = 'ON_SALE' THEN
    IF scope IS NULL OR NOT qintopia_membership_scope_valid(product->>'allowedRoomTypeCode',scope)
      OR inventory_kind NOT IN ('ROOM','BED') OR product->>'entitlementUnitKind' IS DISTINCT FROM inventory_kind || '_NIGHT'
      OR EXISTS (SELECT 1 FROM unnest(scope) AS selected(scope_code) WHERE NOT EXISTS (
        SELECT 1 FROM inventory_units u WHERE u.property_id = execution.property_id AND u.room_type_code = selected.scope_code AND u.active
          AND u.kind = inventory_kind AND (inventory_kind = 'BED' OR u.inventory_basis IS DISTINCT FROM 'WHOLE_ROOM_COMBINATION')
      )) OR EXISTS (SELECT 1 FROM room_catalog_state r, jsonb_array_elements(r.snapshot->'types') t
        WHERE r.property_id = execution.property_id AND t->>'code' = ANY(scope)
          AND ((t->>'active')::boolean IS DISTINCT FROM true OR t->>'saleMode' IS DISTINCT FROM inventory_kind)) THEN
      RAISE EXCEPTION 'membership room types must be active and share sale mode' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF action_name <> 'SET_SALE_STATUS' THEN
    IF btrim(product->>'name') = '' OR length(product->>'name') > 100 OR product->>'name' ~ '[[:cntrl:]]'
      OR (product->>'listPriceMinor')::integer <= 0 OR (product->>'listPriceMinor')::integer % 100 <> 0 THEN RAISE EXCEPTION 'invalid membership name or price' USING ERRCODE = '23514'; END IF;
    PERFORM qintopia_membership_valid_until((clock_timestamp() AT TIME ZONE (SELECT timezone FROM properties WHERE id=execution.property_id))::date, product->>'validityPeriod');
    INSERT INTO membership_products(id,code,version,name,list_price_minor,currency,entitlement_unit_kind,entitlement_units,
      validity_period,allowed_room_type_code,allowed_room_type_codes,allowed_inventory_kind,status)
    VALUES(product->>'productId',product->>'code',(product->>'version')::integer,product->>'name',(product->>'listPriceMinor')::integer,
      (SELECT currency FROM properties WHERE id=execution.property_id),product->>'entitlementUnitKind',(product->>'entitlementUnits')::integer,
      product->>'validityPeriod',product->>'allowedRoomTypeCode',scope,inventory_kind,'PUBLISHED');
  END IF;
  IF action_name = 'CREATE' THEN
    INSERT INTO membership_product_catalog(code,property_id,current_product_id,sale_status,revision)
    VALUES(next_head->>'code',execution.property_id,product->>'productId','ON_SALE',1);
  ELSE
    UPDATE membership_product_catalog SET current_product_id=product->>'productId',sale_status=next_head->>'saleStatus',
      revision=revision+1,updated_at=now() WHERE code=head.code;
  END IF;
  INSERT INTO membership_catalog_changes(id,property_id,command_id,effect,reason)
  VALUES(change_id,execution.property_id,target_command,approved_effect,reason_note);
  RETURN change_id;
END $$;
REVOKE ALL ON FUNCTION qintopia_apply_membership_catalog(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_apply_membership_catalog(text,jsonb,text) TO qintopia_runtime;

-- Keep each existing provenance/financial guard, replacing only duration predicates.
DO $migration$
DECLARE signature text; definition text; updated text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['qintopia_validate_membership_effective_date_correction()',
    'qintopia_validate_historical_membership_backfill()', 'qintopia_validate_membership_void_reconversion()'] LOOP
    definition := pg_get_functiondef(to_regprocedure(signature));
    IF definition IS NULL THEN RAISE EXCEPTION 'membership migration missing guard: %', signature; END IF;
    updated := definition;
    IF signature = 'qintopia_validate_membership_effective_date_correction()' THEN
      updated := replace(updated, $old$product.validity_period = 'P1Y'$old$, 'product.validity_period = target_order.validity_period');
      updated := replace(updated, $old$(NEW.corrected_valid_from + interval '1 year')::date$old$,
        'qintopia_membership_valid_until(NEW.corrected_valid_from, target_order.validity_period)');
    ELSIF signature = 'qintopia_validate_historical_membership_backfill()' THEN
      updated := replace(updated, $old$NEW.validity_period IS DISTINCT FROM 'P1Y'$old$,
        'NEW.validity_period IS DISTINCT FROM target_product.validity_period OR NEW.validity_period IS DISTINCT FROM target_order.validity_period');
      updated := replace(updated, $old$(NEW.actual_membership_date + interval '1 year')::date$old$,
        'qintopia_membership_valid_until(NEW.actual_membership_date, NEW.validity_period)');
    ELSIF signature = 'qintopia_validate_membership_void_reconversion()' THEN
      updated := replace(updated, $old$(NEW.actual_membership_date + interval '1 year')::date$old$,
        'qintopia_membership_valid_until(NEW.actual_membership_date, new_order.validity_period)');
    END IF;
    IF updated = definition THEN RAISE EXCEPTION 'membership migration unrecognized guard: %', signature; END IF;
    EXECUTE updated;
  END LOOP;
END $migration$;

CREATE FUNCTION qintopia_membership_catalog_commit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE command_row command_executions%ROWTYPE; change membership_catalog_changes%ROWTYPE;
BEGIN
  SELECT * INTO command_row FROM command_executions WHERE id = CASE WHEN TG_TABLE_NAME = 'command_executions' THEN NEW.id ELSE to_jsonb(NEW)->>'command_id' END;
  IF command_row.command_type <> 'MANAGE_MEMBERSHIP_CATALOG' THEN RETURN NEW; END IF;
  SELECT * INTO change FROM membership_catalog_changes WHERE command_id = command_row.id;
  IF command_row.state <> 'APPLIED' AND change.id IS NULL THEN RETURN NEW; END IF;
  IF command_row.state IS DISTINCT FROM 'APPLIED' OR change.id IS NULL
    OR NOT EXISTS (SELECT 1 FROM command_receipts WHERE command_id = command_row.id AND business_committed
      AND execution_status = 'EXECUTED' AND result = change.effect || jsonb_build_object('changeId', change.id))
    OR NOT EXISTS (SELECT 1 FROM audit_entries WHERE command_id = command_row.id AND decision = 'ALLOWED'
      AND action = command_row.command_type AND reason->>'note' = change.reason
      AND EXISTS (SELECT 1 FROM command_previews WHERE id = metadata->>'previewId' AND status = 'USED' AND effect = change.effect)) THEN
    RAISE EXCEPTION 'catalog command requires matching change, receipt and audit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER command_executions_membership_catalog_guard AFTER INSERT OR UPDATE ON command_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_membership_catalog_commit_guard();
CREATE CONSTRAINT TRIGGER membership_catalog_changes_commit_guard AFTER INSERT ON membership_catalog_changes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qintopia_membership_catalog_commit_guard();
REVOKE ALL ON FUNCTION qintopia_membership_catalog_commit_guard() FROM PUBLIC;
