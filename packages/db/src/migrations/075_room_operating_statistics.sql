-- 经营住宿统计归属绑定实体房资产，既有房间版本与子床沿用同一设置。
CREATE TABLE room_operating_statistics (
  property_id text NOT NULL REFERENCES properties(id),
  asset_id text NOT NULL REFERENCES inventory_units(id),
  included boolean NOT NULL,
  PRIMARY KEY (property_id, asset_id)
);
REVOKE ALL ON room_operating_statistics FROM PUBLIC, qintopia_runtime;
GRANT SELECT ON room_operating_statistics TO qintopia_runtime;

-- 仅初始化迁移时已存在的正式物业 F 栋资产；不定义永久楼栋规则。
WITH initialized AS (
INSERT INTO room_operating_statistics(property_id, asset_id, included)
SELECT DISTINCT unit.property_id, COALESCE(link.asset_id, unit.id), false
FROM inventory_units AS unit LEFT JOIN room_catalog_links AS link ON link.unit_id = unit.id
WHERE unit.property_id = 'prop_qintopia' AND unit.kind = 'ROOM' AND unit.building_code = 'F'
  AND (link.unit_id IS NULL OR NOT EXISTS (SELECT 1 FROM room_catalog_links AS newer
    WHERE newer.asset_id = link.asset_id AND newer.version > link.version))
ON CONFLICT (property_id, asset_id) DO NOTHING
RETURNING property_id
)
INSERT INTO room_status_revisions(property_id, revision, updated_at)
SELECT DISTINCT property_id, 1, now() FROM initialized
ON CONFLICT (property_id) DO UPDATE SET revision = room_status_revisions.revision + 1, updated_at = EXCLUDED.updated_at;

DO $migration$
DECLARE definition text;
BEGIN
  IF (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc
      WHERE oid = 'qintopia_apply_room_catalog(text,jsonb,text)'::regprocedure)
      IS DISTINCT FROM 'accc9f55576e4252b823b4341138224b6757bbc2372f6379e85b8e24685a75eb' THEN
    RAISE EXCEPTION 'unrecognized room catalog boundary';
  END IF;
  SELECT pg_get_functiondef('qintopia_apply_room_catalog(text,jsonb,text)'::regprocedure) INTO definition;
  definition := replace(definition, $old$'SET_BUILDING_ORDER','RENAME_ROOM') THEN$old$, $new$'SET_BUILDING_ORDER','RENAME_ROOM','SET_OPERATING_STATISTICS') THEN$new$);
  definition := replace(definition, $old$  IF action_name = 'SET_BUILDING_ORDER' THEN$old$, $new$
  IF action_name = 'SET_OPERATING_STATISTICS' THEN
    DECLARE
      change jsonb := approved_effect->'operatingStatisticsChange';
      selected_assets text[];
      baseline_types jsonb;
    BEGIN
      IF jsonb_typeof(change) IS DISTINCT FROM 'object'
        OR (change - 'assetIds' - 'included') <> '{}'::jsonb
        OR jsonb_typeof(change->'assetIds') IS DISTINCT FROM 'array'
        OR jsonb_typeof(change->'included') IS DISTINCT FROM 'boolean'
        OR approved_effect->'retireUnitIds' IS DISTINCT FROM '[]'::jsonb
        OR approved_effect->'insertUnits' IS DISTINCT FROM '[]'::jsonb
        OR approved_effect->'policies' IS DISTINCT FROM '[]'::jsonb
        OR approved_effect->'roomLink' IS DISTINCT FROM 'null'::jsonb
        OR approved_effect ? 'roomRename'
        OR (state.version IS NOT NULL AND ((approved_effect->'after') - 'version') IS DISTINCT FROM (state.snapshot - 'version')) THEN
        RAISE EXCEPTION 'operating statistics must preserve inventory and catalog' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(change->'assetIds') AS asset WHERE jsonb_typeof(asset) <> 'string') THEN
        RAISE EXCEPTION 'operating statistics requires asset identifiers' USING ERRCODE = '23514';
      END IF;
      SELECT array_agg(value ORDER BY value) INTO selected_assets FROM jsonb_array_elements_text(change->'assetIds');
      IF COALESCE(cardinality(selected_assets), 0) = 0
        OR cardinality(selected_assets) <> (SELECT count(DISTINCT asset) FROM unnest(selected_assets) AS asset)
        OR EXISTS (SELECT 1 FROM unnest(selected_assets) AS selected(asset) WHERE NOT EXISTS (
          SELECT 1 FROM inventory_units AS root LEFT JOIN room_catalog_links AS link ON link.unit_id = root.id
          WHERE root.id = selected.asset AND root.property_id = execution.property_id AND root.kind = 'ROOM'
            AND COALESCE(link.asset_id, root.id) = root.id)) THEN
        RAISE EXCEPTION 'operating statistics assets must belong to this property' USING ERRCODE = '23514';
      END IF;
      -- 首次维护沿用读取端的库存基线；此动作不得借初始化修改房型或价格。
      IF state.version IS NULL THEN
        WITH latest_rooms AS (
          SELECT unit.* FROM inventory_units AS unit LEFT JOIN room_catalog_links AS link ON link.unit_id = unit.id
          WHERE unit.property_id = execution.property_id AND unit.kind = 'ROOM'
            AND (link.unit_id IS NULL OR NOT EXISTS (SELECT 1 FROM room_catalog_links AS newer
              WHERE newer.asset_id = link.asset_id AND newer.version > link.version))
        ), first_rooms AS (
          SELECT DISTINCT ON (room_type_code) * FROM latest_rooms WHERE COALESCE(room_type_code, '') <> ''
          ORDER BY room_type_code, code, id
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'code', room.room_type_code,
          'name', COALESCE(NULLIF(btrim(regexp_replace(COALESCE((SELECT entry.type_name
            FROM inventory_catalog_entries AS entry JOIN catalog_import_batches AS batch ON batch.id = entry.import_batch_id
            WHERE batch.property_id = execution.property_id AND entry.type_code = room.room_type_code
            ORDER BY batch.created_at DESC LIMIT 1),
            btrim(replace(regexp_replace(room.name, '^Room\s+', '', 'i'), room.code, ''))), '^[·•]\s*', '')), ''), room.room_type_code),
          'bathroom', CASE WHEN position('private' IN room.room_type_code) > 0 THEN 'PRIVATE' ELSE 'SHARED' END,
          'saleMode', CASE WHEN room.inventory_basis = 'WHOLE_ROOM_COMBINATION' THEN 'BED' ELSE 'ROOM' END,
          'bedCount', COALESCE(room.physical_bed_count, 1), 'capacity', room.occupancy_capacity,
          'active', EXISTS (SELECT 1 FROM latest_rooms AS peer WHERE peer.room_type_code = room.room_type_code AND peer.active),
          'products', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', product.pricing_product_code, 'kind', product.kind,
            'multiplier', CASE WHEN product.kind = 'ROOM' AND room.inventory_basis = 'WHOLE_ROOM_COMBINATION'
              THEN COALESCE(product.physical_bed_count, room.physical_bed_count, 1) ELSE 1 END) ORDER BY product.code, product.id), '[]'::jsonb)
            FROM (SELECT DISTINCT ON (pricing_product_code) * FROM inventory_units
              WHERE property_id = execution.property_id AND room_type_code = room.room_type_code AND COALESCE(pricing_product_code, '') <> ''
              ORDER BY pricing_product_code, code, id) AS product)
        ) ORDER BY room.room_type_code), '[]'::jsonb) INTO baseline_types FROM first_rooms AS room;
        IF approved_effect#>'{after,rates}' IS DISTINCT FROM '[]'::jsonb
          OR ((approved_effect->'after') - 'version' - 'types' - 'rates') <> '{}'::jsonb
          OR NOT (COALESCE(approved_effect#>'{after,types}', 'null'::jsonb) @> baseline_types
            AND baseline_types @> COALESCE(approved_effect#>'{after,types}', 'null'::jsonb))
          OR jsonb_array_length(approved_effect#>'{after,types}') IS DISTINCT FROM jsonb_array_length(baseline_types) THEN
          RAISE EXCEPTION 'operating statistics must initialize the unchanged catalog baseline' USING ERRCODE = '23514';
        END IF;
      END IF;
      INSERT INTO room_operating_statistics(property_id, asset_id, included)
      SELECT execution.property_id, asset, (change->>'included')::boolean FROM unnest(selected_assets) AS asset
      ON CONFLICT (property_id, asset_id) DO UPDATE SET included = EXCLUDED.included;
    END;
  ELSIF approved_effect ? 'operatingStatisticsChange' THEN
    RAISE EXCEPTION 'only operating statistics action can change statistics settings' USING ERRCODE = '23514';
  END IF;
  IF action_name = 'SET_BUILDING_ORDER' THEN$new$);
  EXECUTE definition;
END $migration$;
