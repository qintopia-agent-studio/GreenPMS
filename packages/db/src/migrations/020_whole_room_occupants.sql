ALTER TABLE inventory_units
  ADD COLUMN occupancy_capacity integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT inventory_units_occupancy_capacity_shape CHECK (
    (kind = 'BED' AND occupancy_capacity = 1)
    OR (kind = 'ROOM' AND occupancy_capacity BETWEEN 1 AND 1000)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_units
    WHERE kind = 'ROOM'
      AND (
        room_type_code IS NULL
        OR room_type_code NOT IN (
          'private_bath_standard',
          'private_bath_king',
          'private_bath_single',
          'private_bath_suite',
          'shared_bath_standard',
          'shared_bath_single',
          'shared_bath_double',
          'shared_bath_quad'
        )
      )
  ) THEN
    RAISE EXCEPTION 'cannot derive occupancy capacity for unknown room_type_code'
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_units_occupancy_capacity_room_type_known';
  END IF;
END;
$$;

UPDATE inventory_units
SET occupancy_capacity = CASE room_type_code
  WHEN 'private_bath_standard' THEN 2
  WHEN 'private_bath_king' THEN 2
  WHEN 'private_bath_single' THEN 1
  WHEN 'private_bath_suite' THEN 2
  WHEN 'shared_bath_standard' THEN 2
  WHEN 'shared_bath_single' THEN 1
  WHEN 'shared_bath_double' THEN 2
  WHEN 'shared_bath_quad' THEN 4
END
WHERE kind = 'ROOM';

CREATE OR REPLACE FUNCTION qintopia_protect_inventory_unit_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory unit identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.property_id IS DISTINCT FROM OLD.property_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.parent_room_id IS DISTINCT FROM OLD.parent_room_id
    OR NEW.catalog_version IS DISTINCT FROM OLD.catalog_version
    OR NEW.building_code IS DISTINCT FROM OLD.building_code
    OR NEW.room_type_code IS DISTINCT FROM OLD.room_type_code
    OR NEW.pricing_product_code IS DISTINCT FROM OLD.pricing_product_code
    OR NEW.inventory_basis IS DISTINCT FROM OLD.inventory_basis
    OR NEW.code_provenance IS DISTINCT FROM OLD.code_provenance
    OR NEW.physical_bed_count IS DISTINCT FROM OLD.physical_bed_count
    OR NEW.occupancy_capacity IS DISTINCT FROM OLD.occupancy_capacity
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory unit property, hierarchy, catalog identity, and pricing product are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE order_occupants (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  ordinal integer NOT NULL,
  role text NOT NULL,
  full_name text,
  nickname text,
  phone text,
  document_number text,
  created_by_command_id text REFERENCES command_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_occupants_ordinal_positive CHECK (ordinal > 0),
  CONSTRAINT order_occupants_role_known CHECK (role IN ('PRIMARY', 'ADDITIONAL')),
  CONSTRAINT order_occupants_primary_ordinal_shape CHECK (
    (ordinal = 1 AND role = 'PRIMARY') OR (ordinal > 1 AND role = 'ADDITIONAL')
  ),
  CONSTRAINT order_occupants_order_ordinal_unique UNIQUE (order_id, ordinal)
);

INSERT INTO order_occupants (
  id,
  order_id,
  ordinal,
  role,
  full_name,
  nickname,
  phone,
  document_number,
  created_by_command_id,
  created_at
)
SELECT
  'occupant_legacy_' || md5(booking.id),
  booking.id,
  1,
  'PRIMARY',
  NULLIF(btrim(booking.primary_guest_snapshot ->> 'fullName'), ''),
  NULLIF(btrim(booking.primary_guest_snapshot ->> 'nickname'), ''),
  NULLIF(btrim(booking.primary_guest_snapshot ->> 'phone'), ''),
  NULLIF(btrim(booking.primary_guest_snapshot ->> 'documentNumber'), ''),
  NULL,
  booking.created_at
FROM orders AS booking;

CREATE OR REPLACE FUNCTION qintopia_validate_new_order_occupant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_command_id IS NULL THEN
    RAISE EXCEPTION 'new order occupants require a creating command'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_created_by_command_required';
  END IF;
  IF EXISTS (SELECT 1 FROM amendments WHERE order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'order occupant list is frozen after initial order creation'
      USING ERRCODE = '55000', CONSTRAINT = 'order_occupants_initial_list_frozen';
  END IF;

  NEW.full_name := NULLIF(btrim(NEW.full_name), '');
  NEW.nickname := NULLIF(btrim(NEW.nickname), '');
  NEW.phone := NULLIF(btrim(NEW.phone), '');
  NEW.document_number := NULLIF(btrim(NEW.document_number), '');

  IF NEW.full_name IS NULL OR char_length(NEW.full_name) > 200 THEN
    RAISE EXCEPTION 'new order occupants require a full name of at most 200 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_full_name_required';
  END IF;
  IF NEW.nickname IS NULL OR char_length(NEW.nickname) > 200 THEN
    RAISE EXCEPTION 'new order occupants require a nickname of at most 200 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_nickname_required';
  END IF;
  IF NEW.phone IS NOT NULL AND char_length(NEW.phone) > 80 THEN
    RAISE EXCEPTION 'order occupant phone exceeds 80 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_phone_length';
  END IF;
  IF NEW.document_number IS NOT NULL AND char_length(NEW.document_number) > 120 THEN
    RAISE EXCEPTION 'order occupant document number exceeds 120 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'order_occupants_document_number_length';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_occupants_validate_new
BEFORE INSERT ON order_occupants
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_order_occupant();

CREATE TRIGGER order_occupants_append_only
BEFORE UPDATE OR DELETE ON order_occupants
FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation();

CREATE OR REPLACE FUNCTION qintopia_validate_order_occupant_set() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_order_id text;
  occupant_count integer;
  primary_count integer;
  unit_capacity integer;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    target_order_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'order_occupants' THEN
    target_order_id := NEW.order_id;
  ELSE
    SELECT stay.order_id
      INTO target_order_id
      FROM stays AS stay
      WHERE stay.id = NEW.stay_id;
    IF target_order_id IS NULL THEN
      RAISE EXCEPTION 'stay segment requires a resolvable order'
        USING ERRCODE = '23514', CONSTRAINT = 'stay_segments_occupant_order_required';
    END IF;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE ordinal = 1 AND role = 'PRIMARY')::integer
    INTO occupant_count, primary_count
    FROM order_occupants
    WHERE order_id = target_order_id;

  IF occupant_count < 1 OR primary_count <> 1 THEN
    RAISE EXCEPTION 'orders require exactly one primary occupant at ordinal 1'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_primary_occupant_required';
  END IF;

  SELECT unit.occupancy_capacity
    INTO unit_capacity
    FROM stays AS stay
    JOIN stay_segments AS segment ON segment.stay_id = stay.id
    JOIN inventory_units AS unit ON unit.id = segment.inventory_unit_id
    WHERE stay.order_id = target_order_id
    ORDER BY segment.sequence DESC
    LIMIT 1;

  IF unit_capacity IS NULL THEN
    RAISE EXCEPTION 'order occupants require an order stay inventory segment'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_occupant_inventory_required';
  END IF;
  IF occupant_count > unit_capacity THEN
    RAISE EXCEPTION 'order occupant count exceeds inventory occupancy capacity'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_occupancy_capacity_exceeded';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER orders_validate_occupant_set
AFTER INSERT ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_order_occupant_set();

CREATE CONSTRAINT TRIGGER order_occupants_validate_set
AFTER INSERT ON order_occupants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_order_occupant_set();

CREATE CONSTRAINT TRIGGER stay_segments_validate_occupant_set
AFTER INSERT ON stay_segments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION qintopia_validate_order_occupant_set();
