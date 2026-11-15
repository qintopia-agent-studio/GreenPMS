-- Preserve every original product, sold snapshot and historical fact. NULL means
-- the original singleton; only newly sold shared products carry a scope array.
ALTER TABLE membership_products ADD COLUMN allowed_room_type_codes text[];
ALTER TABLE membership_orders ADD COLUMN allowed_room_type_codes text[];
ALTER TABLE historical_membership_backfills ADD COLUMN allowed_room_type_codes text[];

CREATE FUNCTION qintopia_membership_scope_valid(anchor text, scope text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT scope IS NULL OR (
    cardinality(scope) > 0 AND array_ndims(scope) = 1 AND array_lower(scope, 1) = 1
    AND anchor = ANY(scope) AND array_position(scope, NULL) IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(scope) code WHERE btrim(code) = '')
    AND cardinality(scope) = (SELECT count(DISTINCT code) FROM unnest(scope) code)
  );
$$;
ALTER TABLE membership_products ADD CONSTRAINT membership_products_scope_valid CHECK (qintopia_membership_scope_valid(allowed_room_type_code, allowed_room_type_codes));
ALTER TABLE membership_orders ADD CONSTRAINT membership_orders_scope_valid CHECK (qintopia_membership_scope_valid(allowed_room_type_code, allowed_room_type_codes));
ALTER TABLE historical_membership_backfills ADD CONSTRAINT historical_membership_backfills_scope_valid CHECK (qintopia_membership_scope_valid(allowed_room_type_code, allowed_room_type_codes));

CREATE FUNCTION qintopia_membership_room_matches(anchor text, scope text[], actual text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(actual = ANY(COALESCE(scope, ARRAY[anchor])), false);
$$;

CREATE FUNCTION qintopia_guard_membership_scope_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE product membership_products%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.allowed_room_type_codes IS DISTINCT FROM OLD.allowed_room_type_codes THEN
      RAISE EXCEPTION 'membership scope snapshot is immutable' USING ERRCODE = '23514', CONSTRAINT = 'membership_scope_immutable';
    END IF;
  ELSE
    SELECT * INTO STRICT product FROM membership_products WHERE id = NEW.product_id;
    IF NEW.allowed_room_type_codes IS DISTINCT FROM product.allowed_room_type_codes
      OR NEW.allowed_room_type_code IS DISTINCT FROM product.allowed_room_type_code
      OR NEW.allowed_inventory_kind IS DISTINCT FROM product.allowed_inventory_kind
      OR NEW.entitlement_unit_kind IS DISTINCT FROM product.entitlement_unit_kind THEN
      RAISE EXCEPTION 'membership scope must match its immutable product' USING ERRCODE = '23514', CONSTRAINT = 'membership_scope_product_match';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER membership_orders_scope_snapshot BEFORE INSERT OR UPDATE ON membership_orders FOR EACH ROW EXECUTE FUNCTION qintopia_guard_membership_scope_snapshot();
CREATE TRIGGER historical_membership_backfills_scope_snapshot BEFORE INSERT OR UPDATE ON historical_membership_backfills FOR EACH ROW EXECUTE FUNCTION qintopia_guard_membership_scope_snapshot();

INSERT INTO membership_products (id, code, version, name, list_price_minor, currency,
  entitlement_unit_kind, entitlement_units, validity_period, allowed_room_type_code,
  allowed_room_type_codes, allowed_inventory_kind, status)
VALUES ('membership_product_private_bath_shared_v1', 'PRIVATE_BATH_SHARED_30', 1,
  '独卫标间／大床通用会员', 280000, 'CNY', 'ROOM_NIGHT', 30, 'P1Y',
  'private_bath_standard', ARRAY['private_bath_standard', 'private_bath_king'], 'ROOM', 'PUBLISHED');

-- A room move follows the actual coverage sources, whose per-date uniqueness
-- is enforced by the existing coverage/ledger guards. Unrelated expired contracts
-- cannot introduce ambiguity; every used snapshot must cover both room types.
CREATE FUNCTION qintopia_order_room_types_match(order_id text, first_type text, second_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT first_type IS NOT DISTINCT FROM second_type OR EXISTS (
    SELECT 1 FROM orders o WHERE o.id = order_id AND (
      (EXISTS (SELECT 1 FROM coverage_items c WHERE c.order_id = o.id AND c.status IN ('HELD', 'CONSUMED'))
        AND NOT EXISTS (
          SELECT 1 FROM coverage_items c LEFT JOIN membership_orders m
            ON m.contract_id = c.contract_id AND m.entitlement_lot_id = c.lot_id
            AND m.property_id = o.property_id AND m.member_id = o.member_id
          WHERE c.order_id = o.id AND c.status IN ('HELD', 'CONSUMED')
            AND (m.id IS NULL OR m.status <> 'ACTIVE'
              OR m.allowed_inventory_kind <> 'ROOM' OR m.entitlement_unit_kind <> 'ROOM_NIGHT'
              OR NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, first_type)
              OR NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, second_type))
        ))
      OR (NOT EXISTS (SELECT 1 FROM coverage_items c WHERE c.order_id = o.id AND c.status IN ('HELD', 'CONSUMED'))
        AND (SELECT count(*) = 1 FROM membership_orders m
          WHERE m.property_id = o.property_id AND m.member_id = o.member_id AND m.status = 'ACTIVE'
            AND (o.member_contract_id IS NULL OR m.contract_id = o.member_contract_id)
            AND m.valid_from < o.departure_date AND m.valid_until >= o.arrival_date
            AND m.allowed_inventory_kind = 'ROOM' AND m.entitlement_unit_kind = 'ROOM_NIGHT'
            AND qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, first_type)
            AND qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, second_type)))
    )
  );
$$;

-- Change only membership scope predicates in the currently installed guards.
-- Existing provenance, ownership, accounting and concurrency checks remain intact.
DO $migration$
DECLARE routine record; original text; updated text; replacement record;
BEGIN
  FOR routine IN SELECT * FROM (VALUES
    ('qintopia_validate_coverage_ownership()', '7b304edb2fd2783436bc77b568370d2f2aab78820771c71fbea53f35d0d75a55', 'e6233bbe4a50a4d6a9eea4311030750a57d3ab2f13e862a0125cae7ed7346a01'),
    ('qintopia_assert_stage11_move_combination(text)', 'a20dda3b5c1103f9daa577dd09edcf4a8544a7f66c9f292d9d72d4eb172b12cf', '91cd98d47fc862dd91c8454a57ca497771d780f6bb7d9928fcceac6b908409b4'),
    ('qintopia_assert_stage11_date_change_combination(text)', '41ed485bca351d24f3fc6dba14add4627b006ea81ad96b53ef9e9b6a0c71f126', 'ee528fb0a5ce5573c558f1ee05e8d3399b1d9bc35a0ded529ae020bacd891ebb'),
    ('qintopia_validate_conversion_consume_entitlement_fact()', 'af89b532e6a6ab2c9a276610b5f4b72dffbdb858862bdf646ffaced92eaddb93', '9da328e757d777ad7c36611a87a68d231d5f6fd6690f35c9d376d6517867dcaf'),
    ('qintopia_assert_stage13_stay_conversion_command_v033(text)', 'b4270521bdc3cb0eda81d6cb6e65ba353239a6a01e712534cf99d954b293bb63', '36297eb71b15c6ca4ff887805d94112246492e5c6fd718fd6903315a33f759d3'),
    ('qintopia_assert_converted_stay_fulfillment_command(text)', '7b22fe62a3610462c82a4a54f95d62e478996454dfc312ff8e90c189dfa222a0', '1ee7afb83a223322b49218cd666d45c0c24c14b887244232c5566119434e0304'),
    ('qintopia_validate_membership_effective_date_correction()', '2a934ecfb22c081fbf886b07f624858e20ccde7a291c80ab982a5596bf829c63', '97125ffced9ae1d76d17a97bf16cc0857734a33e041b03b63f51e7a12387a92e'),
    ('qintopia_validate_membership_void_reconversion()', '028e6a3435a8c1b049f17b8f5235b663a87aaba0fba515277ea1586a0e07011e', 'fe713a7a385c69715fc9f6d1af5b1ec92e9c8944edec93ae856f555adea06d11'),
    ('qintopia_validate_temporary_other_room_create_order()', '7591e6b8e9d6cac8f3625807ab56ec2f743b3d4f96accd8c7d759a9c435c72b8', '164da03059d257973ee957a3465e1fd4c7d8520d54a04d1db043db9cb9d81b50'),
    ('qintopia_apply_room_catalog(text,jsonb,text)', '807c241b0ae02dc56d8a8d572d835884adff965942bb78470bfb1570693bd400', 'b264c78496af279f37ca7c5a71bf950ef5cb678df0bb37ff8cea0e3762655676'),
    ('qintopia_cross_room_upgrade_matches(text,text,text,date)', '4b365a2a000b4cc2794c9805de1ea6374e319016b57c0062bb8484664eee40b2', '57dc896ff3bc7ac53b48ca78f7e144597b5347e35c8648bc1e3e1de75cce48f4')
  ) AS expected(signature, body_hash, migrated_body_hash)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(routine.signature)
      AND encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = routine.body_hash) THEN
      RAISE EXCEPTION 'membership scope migration baseline guard not recognized: %', routine.signature;
    END IF;
    original := pg_get_functiondef(to_regprocedure(routine.signature)); updated := original;
    FOR replacement IN SELECT * FROM (VALUES
      ($scope$target_membership_order.allowed_room_type_code IS DISTINCT FROM unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$target_membership_order.allowed_room_type_code <> unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$target_membership_order.allowed_room_type_code = unit.room_type_code$scope$, $scope$qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$unit.room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$unit.room_type_code <> target_membership_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$unit.room_type_code = target_membership_order.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$target_membership_order.allowed_room_type_code IS DISTINCT FROM coverage_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, coverage_room_type_code)$scope$),
      ($scope$target_membership_order.allowed_room_type_code <> coverage_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, coverage_room_type_code)$scope$),
      ($scope$target_membership_order.allowed_room_type_code = coverage_room_type_code$scope$, $scope$qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, coverage_room_type_code)$scope$),
      ($scope$coverage_room_type_code IS DISTINCT FROM target_membership_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, coverage_room_type_code)$scope$),
      ($scope$coverage_room_type_code <> target_membership_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, coverage_room_type_code)$scope$),
      ($scope$coverage_room_type_code = target_membership_order.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(target_membership_order.allowed_room_type_code, target_membership_order.allowed_room_type_codes, coverage_room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code IS DISTINCT FROM target_unit_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, target_unit_room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code <> target_unit_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, target_unit_room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code = target_unit_room_type_code$scope$, $scope$qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, target_unit_room_type_code)$scope$),
      ($scope$target_unit_room_type_code IS DISTINCT FROM membership.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, target_unit_room_type_code)$scope$),
      ($scope$target_unit_room_type_code <> membership.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, target_unit_room_type_code)$scope$),
      ($scope$target_unit_room_type_code = membership.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, target_unit_room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code IS DISTINCT FROM coverage_unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, coverage_unit.room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code <> coverage_unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, coverage_unit.room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code = coverage_unit.room_type_code$scope$, $scope$qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, coverage_unit.room_type_code)$scope$),
      ($scope$coverage_unit.room_type_code IS DISTINCT FROM membership.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, coverage_unit.room_type_code)$scope$),
      ($scope$coverage_unit.room_type_code <> membership.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, coverage_unit.room_type_code)$scope$),
      ($scope$coverage_unit.room_type_code = membership.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, coverage_unit.room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code IS DISTINCT FROM inventory.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, inventory.room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code <> inventory.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, inventory.room_type_code)$scope$),
      ($scope$membership.allowed_room_type_code = inventory.room_type_code$scope$, $scope$qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, inventory.room_type_code)$scope$),
      ($scope$inventory.room_type_code IS DISTINCT FROM membership.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, inventory.room_type_code)$scope$),
      ($scope$inventory.room_type_code <> membership.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, inventory.room_type_code)$scope$),
      ($scope$inventory.room_type_code = membership.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(membership.allowed_room_type_code, membership.allowed_room_type_codes, inventory.room_type_code)$scope$),
      ($scope$target_order.allowed_room_type_code IS DISTINCT FROM coverage_inventory.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_order.allowed_room_type_code, target_order.allowed_room_type_codes, coverage_inventory.room_type_code)$scope$),
      ($scope$target_order.allowed_room_type_code <> coverage_inventory.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_order.allowed_room_type_code, target_order.allowed_room_type_codes, coverage_inventory.room_type_code)$scope$),
      ($scope$target_order.allowed_room_type_code = coverage_inventory.room_type_code$scope$, $scope$qintopia_membership_room_matches(target_order.allowed_room_type_code, target_order.allowed_room_type_codes, coverage_inventory.room_type_code)$scope$),
      ($scope$coverage_inventory.room_type_code IS DISTINCT FROM target_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_order.allowed_room_type_code, target_order.allowed_room_type_codes, coverage_inventory.room_type_code)$scope$),
      ($scope$coverage_inventory.room_type_code <> target_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(target_order.allowed_room_type_code, target_order.allowed_room_type_codes, coverage_inventory.room_type_code)$scope$),
      ($scope$coverage_inventory.room_type_code = target_order.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(target_order.allowed_room_type_code, target_order.allowed_room_type_codes, coverage_inventory.room_type_code)$scope$),
      ($scope$new_order.allowed_room_type_code IS DISTINCT FROM unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(new_order.allowed_room_type_code, new_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$new_order.allowed_room_type_code <> unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(new_order.allowed_room_type_code, new_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$new_order.allowed_room_type_code = unit.room_type_code$scope$, $scope$qintopia_membership_room_matches(new_order.allowed_room_type_code, new_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$unit.room_type_code IS DISTINCT FROM new_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(new_order.allowed_room_type_code, new_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$unit.room_type_code <> new_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(new_order.allowed_room_type_code, new_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$unit.room_type_code = new_order.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(new_order.allowed_room_type_code, new_order.allowed_room_type_codes, unit.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code IS DISTINCT FROM u.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, u.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code <> u.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, u.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code = u.room_type_code$scope$, $scope$qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, u.room_type_code)$scope$),
      ($scope$u.room_type_code IS DISTINCT FROM m.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, u.room_type_code)$scope$),
      ($scope$u.room_type_code <> m.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, u.room_type_code)$scope$),
      ($scope$u.room_type_code = m.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, u.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code IS DISTINCT FROM target_segment_unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, target_segment_unit.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code <> target_segment_unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, target_segment_unit.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code = target_segment_unit.room_type_code$scope$, $scope$qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, target_segment_unit.room_type_code)$scope$),
      ($scope$target_segment_unit.room_type_code IS DISTINCT FROM m.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, target_segment_unit.room_type_code)$scope$),
      ($scope$target_segment_unit.room_type_code <> m.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, target_segment_unit.room_type_code)$scope$),
      ($scope$target_segment_unit.room_type_code = m.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, target_segment_unit.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code IS DISTINCT FROM different_segment_unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, different_segment_unit.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code <> different_segment_unit.room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, different_segment_unit.room_type_code)$scope$),
      ($scope$m.allowed_room_type_code = different_segment_unit.room_type_code$scope$, $scope$qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, different_segment_unit.room_type_code)$scope$),
      ($scope$different_segment_unit.room_type_code IS DISTINCT FROM m.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, different_segment_unit.room_type_code)$scope$),
      ($scope$different_segment_unit.room_type_code <> m.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, different_segment_unit.room_type_code)$scope$),
      ($scope$different_segment_unit.room_type_code = m.allowed_room_type_code$scope$, $scope$qintopia_membership_room_matches(m.allowed_room_type_code, m.allowed_room_type_codes, different_segment_unit.room_type_code)$scope$),
      ($scope$membership_room_type_code text;$scope$, $scope$membership_room_type_code text;
  membership_room_type_codes text[];$scope$),
      ($scope$SELECT id, status, allowed_room_type_code, allowed_inventory_kind, entitlement_unit_kind$scope$, $scope$SELECT id, status, allowed_room_type_code, allowed_room_type_codes, allowed_inventory_kind, entitlement_unit_kind$scope$),
      ($scope$INTO membership_order_id, membership_status, membership_room_type_code,$scope$, $scope$INTO membership_order_id, membership_status, membership_room_type_code, membership_room_type_codes,$scope$),
      ($scope$membership_room_type_code IS DISTINCT FROM inventory_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(membership_room_type_code, membership_room_type_codes, inventory_room_type_code)$scope$),
      ($scope$      membership_order.allowed_room_type_code,$scope$, $scope$      membership_order.allowed_room_type_code, membership_order.allowed_room_type_codes,$scope$),
      ($scope$allowed_room_type_code IS DISTINCT FROM arrangement ->> 'actualRoomTypeCode'$scope$, $scope$NOT qintopia_membership_room_matches(allowed_room_type_code, allowed_room_type_codes, arrangement ->> 'actualRoomTypeCode')$scope$),
      ($scope$allowed_room_type_code = arrangement ->> 'actualRoomTypeCode'$scope$, $scope$qintopia_membership_room_matches(allowed_room_type_code, allowed_room_type_codes, arrangement ->> 'actualRoomTypeCode')$scope$),
      ($scope$target_amendment.payload #>> '{toInventoryUnit,roomTypeCode}'
        IS DISTINCT FROM conversion_membership_order.allowed_room_type_code$scope$, $scope$NOT qintopia_membership_room_matches(conversion_membership_order.allowed_room_type_code, conversion_membership_order.allowed_room_type_codes, target_amendment.payload #>> '{toInventoryUnit,roomTypeCode}')$scope$),
      ($scope$prior_unit.room_type_code IS DISTINCT FROM target_unit_room_type_code$scope$, $scope$NOT qintopia_order_room_types_match(target_order.id, prior_unit.room_type_code, target_unit_room_type_code)$scope$),
      ($scope$coverage_unit.room_type_code IS DISTINCT FROM target_unit_room_type_code$scope$, $scope$NOT qintopia_order_room_types_match(target_order.id, coverage_unit.room_type_code, target_unit_room_type_code)$scope$),
      ($scope$timeline_unit.room_type_code IS NOT DISTINCT FROM unit.room_type_code$scope$, $scope$qintopia_order_room_types_match(target_order.id, timeline_unit.room_type_code, unit.room_type_code)$scope$),
      ($scope$FROM membership_orders AS membership JOIN properties AS property ON property.id = membership.property_id
    WHERE membership.property_id = execution.property_id AND membership.allowed_room_type_code = ANY(affected_types)$scope$, $scope$FROM membership_orders AS membership JOIN properties AS property ON property.id = membership.property_id
    CROSS JOIN LATERAL unnest(coalesce(membership.allowed_room_type_codes, ARRAY[membership.allowed_room_type_code])) AS promised(room_type_code)
    WHERE membership.property_id = execution.property_id AND promised.room_type_code = ANY(affected_types)$scope$),
      ($scope$room_type_code = membership.allowed_room_type_code AND NOT (id = ANY(retiring))$scope$, $scope$room_type_code = promised.room_type_code AND NOT (id = ANY(retiring))$scope$),
      ($scope$replacement->>'room_type_code' = membership.allowed_room_type_code$scope$, $scope$replacement->>'room_type_code' = promised.room_type_code$scope$)
    ) AS replacements(before_text, after_text) LOOP
      updated := replace(updated, replacement.before_text, replacement.after_text);
    END LOOP;
    IF updated IS NOT DISTINCT FROM original THEN
      RAISE EXCEPTION 'membership scope migration did not update required guard: %', routine.signature;
    END IF;
    EXECUTE updated;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(routine.signature)
      AND encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = routine.migrated_body_hash) THEN
      RAISE EXCEPTION 'membership scope migration result guard not recognized: %', routine.signature;
    END IF;
  END LOOP;
END;
$migration$;
REVOKE ALL ON FUNCTION qintopia_guard_membership_scope_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_membership_scope_valid(text,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_membership_room_matches(text,text[],text) FROM PUBLIC;
REVOKE ALL ON FUNCTION qintopia_order_room_types_match(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qintopia_membership_scope_valid(text,text[]), qintopia_membership_room_matches(text,text[],text), qintopia_order_room_types_match(text,text,text) TO qintopia_runtime;
