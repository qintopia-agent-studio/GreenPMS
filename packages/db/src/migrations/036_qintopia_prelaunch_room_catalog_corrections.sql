LOCK TABLE inventory_units IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE inventory_claims IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE coverage_items IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    WITH reclassified_units(id) AS (
      VALUES
        ('unit_room_d_gen_02'),
        ('unit_room_d_gen_04'),
        ('unit_room_104'),
        ('unit_room_104_bed_a'),
        ('unit_room_104_bed_b'),
        ('unit_room_104_bed_c'),
        ('unit_room_104_bed_d'),
        ('unit_room_105'),
        ('unit_room_105_bed_a'),
        ('unit_room_105_bed_b'),
        ('unit_room_105_bed_c'),
        ('unit_room_105_bed_d'),
        ('unit_room_106'),
        ('unit_room_106_bed_a'),
        ('unit_room_106_bed_b'),
        ('unit_room_106_bed_c'),
        ('unit_room_106_bed_d'),
        ('unit_room_108'),
        ('unit_room_108_bed_a'),
        ('unit_room_108_bed_b'),
        ('unit_room_108_bed_c'),
        ('unit_room_108_bed_d'),
        ('unit_room_204'),
        ('unit_room_204_bed_a'),
        ('unit_room_204_bed_b'),
        ('unit_room_204_bed_c'),
        ('unit_room_204_bed_d'),
        ('unit_room_206'),
        ('unit_room_206_bed_a'),
        ('unit_room_206_bed_b'),
        ('unit_room_206_bed_c'),
        ('unit_room_206_bed_d'),
        ('unit_room_301'),
        ('unit_room_303'),
        ('unit_room_305'),
        ('unit_room_308')
    )
    SELECT 1
    FROM inventory_units AS unit
    JOIN reclassified_units ON reclassified_units.id = unit.id
    WHERE unit.property_id = 'prop_qintopia_demo'
      AND (
        EXISTS (
          SELECT 1
          FROM inventory_claims AS claim
          WHERE claim.inventory_unit_id = unit.id
            AND claim.active IS TRUE
        )
        OR EXISTS (
          SELECT 1
          FROM coverage_items AS coverage
          WHERE coverage.inventory_unit_id = unit.id
            AND coverage.status = 'HELD'
        )
      )
  ) THEN
    RAISE EXCEPTION 'prelaunch room catalog correction cannot reclassify inventory units with active claims or held coverage'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE inventory_units DISABLE TRIGGER inventory_units_protect_identity;

WITH corrected_rooms(id, code, building_code, room_type_code, pricing_product_code, inventory_basis, code_provenance, physical_bed_count, occupancy_capacity, name) AS (
  VALUES
    ('unit_room_d_gen_02', 'D02', 'D', 'shared_bath_standard', 'shared_bath_standard_room', 'INDEPENDENT', 'PMS_GENERATED', 2, 2, 'D02 · 标间（公卫）'),
    ('unit_room_d_gen_04', 'D04', 'D', 'shared_bath_single', 'shared_bath_single_room', 'INDEPENDENT', 'PMS_GENERATED', 1, 1, 'D04 · 单人间（公卫）'),
    ('unit_room_104', '104', '1', 'shared_bath_quad', 'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4, 4, '104 · 四人间（公卫）'),
    ('unit_room_105', '105', '1', 'shared_bath_double', 'shared_bath_double_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 2, 2, '105 · 两人间（公卫）'),
    ('unit_room_106', '106', '1', 'shared_bath_quad', 'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4, 4, '106 · 四人间（公卫）'),
    ('unit_room_108', '108', '1', 'shared_bath_double', 'shared_bath_double_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 2, 2, '108 · 两人间（公卫）'),
    ('unit_room_204', '204', '2', 'shared_bath_quad', 'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4, 4, '204 · 四人间（公卫）'),
    ('unit_room_206', '206', '2', 'shared_bath_double', 'shared_bath_double_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 2, 2, '206 · 两人间（公卫）'),
    ('unit_room_301', '301', '3', 'shared_bath_standard', 'shared_bath_standard_room', 'INDEPENDENT', 'SOURCE_EXPLICIT', 2, 2, '301 · 标间（公卫）'),
    ('unit_room_303', '303', '3', 'shared_bath_standard', 'shared_bath_standard_room', 'INDEPENDENT', 'SOURCE_EXPLICIT', 2, 2, '303 · 标间（公卫）'),
    ('unit_room_305', '305', '3', 'shared_bath_single', 'shared_bath_single_room', 'INDEPENDENT', 'SOURCE_EXPLICIT', 1, 1, '305 · 单人间（公卫）'),
    ('unit_room_308', '308', '3', 'shared_bath_single', 'shared_bath_single_room', 'INDEPENDENT', 'SOURCE_EXPLICIT', 1, 1, '308 · 单人间（公卫）'),
    ('unit_room_101', '101', '1', 'shared_bath_quad', 'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4, 4, '101 · 四人间（公卫）'),
    ('unit_room_102', '102', '1', 'shared_bath_quad', 'shared_bath_quad_whole_room', 'WHOLE_ROOM_COMBINATION', 'SOURCE_EXPLICIT', 4, 4, '102 · 四人间（公卫）')
)
UPDATE inventory_units AS unit
SET catalog_version = 'qintopia-2026-feishu-revision-561-user-confirmed-v5',
    building_code = corrected.building_code,
    room_type_code = corrected.room_type_code,
    pricing_product_code = corrected.pricing_product_code,
    inventory_basis = corrected.inventory_basis,
    code_provenance = corrected.code_provenance,
    physical_bed_count = corrected.physical_bed_count,
    occupancy_capacity = corrected.occupancy_capacity,
    code = corrected.code,
    name = corrected.name,
    active = TRUE
FROM corrected_rooms AS corrected
WHERE unit.property_id = 'prop_qintopia_demo'
  AND unit.id = corrected.id
  AND unit.kind = 'ROOM';

WITH active_beds(id, parent_room_id, code, building_code, room_type_code, pricing_product_code, code_provenance, name) AS (
  VALUES
    ('unit_room_101_bed_a', 'unit_room_101', '101-A', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '101 · 床位 A'),
    ('unit_room_101_bed_b', 'unit_room_101', '101-B', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '101 · 床位 B'),
    ('unit_room_101_bed_c', 'unit_room_101', '101-C', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '101 · 床位 C'),
    ('unit_room_101_bed_d', 'unit_room_101', '101-D', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '101 · 床位 D'),
    ('unit_room_102_bed_a', 'unit_room_102', '102-A', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '102 · 床位 A'),
    ('unit_room_102_bed_b', 'unit_room_102', '102-B', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '102 · 床位 B'),
    ('unit_room_102_bed_c', 'unit_room_102', '102-C', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '102 · 床位 C'),
    ('unit_room_102_bed_d', 'unit_room_102', '102-D', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '102 · 床位 D'),
    ('unit_room_104_bed_a', 'unit_room_104', '104-A', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '104 · 床位 A'),
    ('unit_room_104_bed_b', 'unit_room_104', '104-B', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '104 · 床位 B'),
    ('unit_room_104_bed_c', 'unit_room_104', '104-C', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '104 · 床位 C'),
    ('unit_room_104_bed_d', 'unit_room_104', '104-D', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '104 · 床位 D'),
    ('unit_room_105_bed_a', 'unit_room_105', '105-A', '1', 'shared_bath_double', 'shared_bath_double_bed', 'SOURCE_EXPLICIT', '105 · 床位 A'),
    ('unit_room_105_bed_b', 'unit_room_105', '105-B', '1', 'shared_bath_double', 'shared_bath_double_bed', 'SOURCE_EXPLICIT', '105 · 床位 B'),
    ('unit_room_106_bed_a', 'unit_room_106', '106-A', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '106 · 床位 A'),
    ('unit_room_106_bed_b', 'unit_room_106', '106-B', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '106 · 床位 B'),
    ('unit_room_106_bed_c', 'unit_room_106', '106-C', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '106 · 床位 C'),
    ('unit_room_106_bed_d', 'unit_room_106', '106-D', '1', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '106 · 床位 D'),
    ('unit_room_108_bed_a', 'unit_room_108', '108-A', '1', 'shared_bath_double', 'shared_bath_double_bed', 'SOURCE_EXPLICIT', '108 · 床位 A'),
    ('unit_room_108_bed_b', 'unit_room_108', '108-B', '1', 'shared_bath_double', 'shared_bath_double_bed', 'SOURCE_EXPLICIT', '108 · 床位 B'),
    ('unit_room_204_bed_a', 'unit_room_204', '204-A', '2', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '204 · 床位 A'),
    ('unit_room_204_bed_b', 'unit_room_204', '204-B', '2', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '204 · 床位 B'),
    ('unit_room_204_bed_c', 'unit_room_204', '204-C', '2', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '204 · 床位 C'),
    ('unit_room_204_bed_d', 'unit_room_204', '204-D', '2', 'shared_bath_quad', 'shared_bath_quad_bed', 'SOURCE_EXPLICIT', '204 · 床位 D'),
    ('unit_room_206_bed_a', 'unit_room_206', '206-A', '2', 'shared_bath_double', 'shared_bath_double_bed', 'SOURCE_EXPLICIT', '206 · 床位 A'),
    ('unit_room_206_bed_b', 'unit_room_206', '206-B', '2', 'shared_bath_double', 'shared_bath_double_bed', 'SOURCE_EXPLICIT', '206 · 床位 B')
)
INSERT INTO inventory_units (
  id,
  property_id,
  kind,
  parent_room_id,
  code,
  name,
  active,
  catalog_version,
  building_code,
  room_type_code,
  pricing_product_code,
  inventory_basis,
  code_provenance,
  physical_bed_count,
  occupancy_capacity
)
SELECT
  active_beds.id,
  'prop_qintopia_demo',
  'BED',
  active_beds.parent_room_id,
  active_beds.code,
  active_beds.name,
  TRUE,
  'qintopia-2026-feishu-revision-561-user-confirmed-v5',
  active_beds.building_code,
  active_beds.room_type_code,
  active_beds.pricing_product_code,
  'INDEPENDENT',
  active_beds.code_provenance,
  NULL,
  1
FROM active_beds
JOIN inventory_units AS parent
  ON parent.property_id = 'prop_qintopia_demo'
  AND parent.id = active_beds.parent_room_id
  AND parent.kind = 'ROOM'
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  active = TRUE,
  catalog_version = EXCLUDED.catalog_version,
  building_code = EXCLUDED.building_code,
  room_type_code = EXCLUDED.room_type_code,
  pricing_product_code = EXCLUDED.pricing_product_code,
  inventory_basis = EXCLUDED.inventory_basis,
  code_provenance = EXCLUDED.code_provenance,
  physical_bed_count = EXCLUDED.physical_bed_count,
  occupancy_capacity = EXCLUDED.occupancy_capacity;

UPDATE inventory_units AS unit
SET active = FALSE,
    catalog_version = 'qintopia-2026-feishu-revision-561-user-confirmed-v5',
    name = CASE unit.id
      WHEN 'unit_room_105_bed_c' THEN '105 · 床位 C（已下线）'
      WHEN 'unit_room_105_bed_d' THEN '105 · 床位 D（已下线）'
      WHEN 'unit_room_108_bed_c' THEN '108 · 床位 C（已下线）'
      WHEN 'unit_room_108_bed_d' THEN '108 · 床位 D（已下线）'
      WHEN 'unit_room_206_bed_c' THEN '206 · 床位 C（已下线）'
      WHEN 'unit_room_206_bed_d' THEN '206 · 床位 D（已下线）'
      ELSE unit.name
    END
WHERE unit.property_id = 'prop_qintopia_demo'
  AND unit.id IN (
    'unit_room_105_bed_c',
    'unit_room_105_bed_d',
    'unit_room_108_bed_c',
    'unit_room_108_bed_d',
    'unit_room_206_bed_c',
    'unit_room_206_bed_d'
  );

UPDATE inventory_units
SET catalog_version = 'qintopia-2026-feishu-revision-561-user-confirmed-v5'
WHERE property_id = 'prop_qintopia_demo'
  AND catalog_version IN (
    'qintopia-2026-feishu-revision-561-user-confirmed-v3',
    'qintopia-2026-feishu-revision-561-user-confirmed-v4'
  );

SET CONSTRAINTS inventory_units_validate_hierarchy IMMEDIATE;

ALTER TABLE inventory_units ENABLE TRIGGER inventory_units_protect_identity;
