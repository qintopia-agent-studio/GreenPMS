import { sql, type Selectable, type Transaction } from "kysely";
import { DomainError, type MembershipCatalogEffect, type MembershipCatalogEntry, type MembershipCatalogInput,
  type MembershipCatalogView, type MembershipProductVersion, type MembershipValidityPeriod } from "@qintopia/contracts";
import { addMembershipValidity, stableHash } from "@qintopia/domain";
import type { DbExecutor } from "./inventory.ts";
import type { Database } from "./schema.ts";
import { lockRoomCatalog, readRoomCatalog } from "./room-catalog.ts";

export function membershipVersion(row: Selectable<Database["membership_products"]>): MembershipProductVersion {
  return { productId: row.id, code: row.code, version: row.version, name: row.name,
    listPriceMinor: row.list_price_minor, currency: row.currency, entitlementUnitKind: row.entitlement_unit_kind,
    entitlementUnits: row.entitlement_units, validityPeriod: row.validity_period as MembershipValidityPeriod,
    allowedRoomTypeCode: row.allowed_room_type_code, allowedRoomTypeCodes: row.allowed_room_type_codes ?? [row.allowed_room_type_code],
    allowedInventoryKind: row.allowed_inventory_kind };
}
export async function membershipProductsForProperty(db: DbExecutor, propertyId: string, historical = false): Promise<Array<Selectable<Database["membership_products"]> & { catalog_revision: number; sale_status: "ON_SALE" | "OFF_SALE"; property_id: string; allowed_room_type_names: string[] }>> {
  if (!db.isTransaction) return db.transaction().execute(trx => membershipProductsForProperty(trx, propertyId, historical));
  await lockRoomCatalog(db as Transaction<Database>, propertyId);
  let query = db.selectFrom("membership_products as p").innerJoin("membership_product_catalog as c", "c.code", "p.code")
    .selectAll("p").select(["c.revision as catalog_revision", "c.sale_status", "c.property_id"])
    .where("c.property_id", "=", propertyId);
  if (!historical) query = query.where("c.sale_status", "=", "ON_SALE").whereRef("p.id", "=", "c.current_product_id");
  const [products, rooms] = await Promise.all([query.orderBy("p.list_price_minor").orderBy("p.code").orderBy("p.version", "desc").execute(), readRoomCatalog(db, propertyId)]);
  return products.map(product => ({ ...product, allowed_room_type_names: (product.allowed_room_type_codes ?? [product.allowed_room_type_code]).map(code => rooms.types.find(type => type.code === code)?.name ?? code) }));
}
export async function requireMembershipProduct(db: DbExecutor, propertyId: string, productId: string, historical = false) {
  const product = (await membershipProductsForProperty(db, propertyId, historical)).find((row) => row.id === productId);
  if (!product) throw new DomainError("NOT_FOUND", historical ? "本门店没有该历史会员产品版本" : "会员产品已变更或停售，请刷新后重新核对", 404);
  return product;
}
export async function readMembershipCatalog(db: DbExecutor, propertyId: string): Promise<MembershipCatalogView> {
  if (!db.isTransaction) return db.transaction().execute(trx => readMembershipCatalog(trx, propertyId));
  await lockRoomCatalog(db as Transaction<Database>, propertyId);
  const [heads, products, changes] = await Promise.all([
    db.selectFrom("membership_product_catalog").selectAll().where("property_id", "=", propertyId).orderBy("created_at").orderBy("code").execute(),
    membershipProductsForProperty(db, propertyId, true),
    db.selectFrom("membership_catalog_changes as c").innerJoin("command_executions as e", "e.id", "c.command_id")
      .innerJoin("subjects as s", "s.id", "e.subject_id").selectAll("c").select("s.display_name")
      .where("c.property_id", "=", propertyId).orderBy("c.created_at", "desc").orderBy("c.id").execute()
  ]);
  return { propertyId, entries: heads.map((head) => ({ propertyId, code: head.code, revision: head.revision,
    saleStatus: head.sale_status, current: membershipVersion(products.find((p) => p.id === head.current_product_id)!) })),
    versions: products.map(membershipVersion), history: changes.map((change) => ({ id: change.id,
      effect: change.effect as MembershipCatalogEffect, reason: change.reason, operator: change.display_name, createdAt: new Date(change.created_at).toISOString() })) };
}
export async function buildMembershipCatalogEffect(db: DbExecutor, raw: Record<string, unknown>) {
  const input = raw as unknown as MembershipCatalogInput;
  const propertyId = input.propertyId;
  const catalog = await readMembershipCatalog(db, propertyId);
  const rooms = await readRoomCatalog(db, propertyId);
  if (input.expectedRoomCatalogVersion !== rooms.version) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "房型目录已变更，请刷新核对", 409);
  const before = input.action === "CREATE" ? null : catalog.entries.find((entry) => entry.code === input.code) ?? null;
  if (input.action !== "CREATE" && (!before || before.revision !== input.expectedRevision)) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员产品已变更，请刷新核对；原输入已保留", 409);
  }
  let current = before?.current;
  if (input.action === "CREATE" || input.action === "UPDATE") {
    const spec = input.specification;
    if (!spec || typeof spec.name !== "string" || !spec.name.trim() || spec.name.trim().length > 100 || /[\u0000-\u001f]/.test(spec.name)) {
      throw new DomainError("VALIDATION_ERROR", "产品名称须为 1 至 100 个字符");
    }
    if (!Number.isInteger(spec.listPriceMinor) || spec.listPriceMinor <= 0 || spec.listPriceMinor > 2_147_483_600 || spec.listPriceMinor % 100 !== 0
      || !Number.isInteger(spec.entitlementUnits) || spec.entitlementUnits <= 0 || spec.entitlementUnits > 2_147_483_647) {
      throw new DomainError("VALIDATION_ERROR", "售价须为正整数元，总夜数须为支持范围内的正整数");
    }
    addMembershipValidity(rooms.businessDate, spec.validityPeriod);
    const scope = spec.allowedRoomTypeCodes;
    if (!Array.isArray(scope) || !scope.length || new Set(scope).size !== scope.length) throw new DomainError("VALIDATION_ERROR", "请选择不重复的适用房型");
    const types = scope.map((code) => rooms.types.find((type) => type.code === code && type.active));
    const kind = types[0]?.saleMode;
    if (!kind || types.some((type) => !type || type.saleMode !== kind)
      || scope.some((code) => !rooms.rooms.some((room) => room.typeCode === code && room.active && (kind === "ROOM" || room.beds.some((bed) => bed.active))))) {
      throw new DomainError("VALIDATION_ERROR", "房型须在本门店可售，且不能混用间夜与床夜");
    }
    const property = await db.selectFrom("properties").select("currency").where("id", "=", propertyId).executeTakeFirstOrThrow();
    const code = before?.code ?? raw.generatedProductCode;
    if (typeof code !== "string" || !code) throw new DomainError("VALIDATION_ERROR", "缺少服务端产品身份");
    const version = (before?.current.version ?? 0) + 1;
    current = { ...spec, name: spec.name.trim(), allowedRoomTypeCodes: [...scope].sort(), allowedRoomTypeCode: [...scope].sort()[0]!,
      productId: `membership_product_${code}_v${version}`, code, version, currency: property.currency,
      allowedInventoryKind: kind, entitlementUnitKind: kind === "ROOM" ? "ROOM_NIGHT" : "BED_NIGHT" };
  } else if (input.action !== "SET_SALE_STATUS" || !["ON_SALE", "OFF_SALE"].includes(input.saleStatus)) {
    throw new DomainError("VALIDATION_ERROR", "不支持的会员产品操作");
  }
  if (!current) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
  const saleStatus = input.action === "SET_SALE_STATUS" ? input.saleStatus : before?.saleStatus ?? "ON_SALE";
  if (saleStatus === "ON_SALE" && current.allowedRoomTypeCodes.some((code) => !rooms.types.some((type) => type.code === code && type.active && type.saleMode === current!.allowedInventoryKind))) {
    throw new DomainError("VALIDATION_ERROR", "恢复销售前须核对适用房型仍可售");
  }
  const after: MembershipCatalogEntry = { propertyId, code: current.code, revision: (before?.revision ?? 0) + 1, saleStatus, current };
  const effect: MembershipCatalogEffect = { operation: "MANAGE_MEMBERSHIP_CATALOG", propertyId, action: input.action,
    roomCatalogVersion: rooms.version, before, after, title: input.action === "CREATE" ? "新增会员产品" : input.action === "UPDATE" ? "修改会员产品" : saleStatus === "ON_SALE" ? "恢复销售" : "停售会员产品",
    description: ["只影响此后新建的会员订单", "已建订单与已售权益继续按原规格办理"] };
  const basisVersions = { membershipCatalogRevision: before?.revision ?? 0, roomCatalogVersion: rooms.version, rooms: rooms.rooms };
  return { propertyId, effect: effect as unknown as Record<string, unknown>, effectHash: stableHash({ effect, basisVersions }), basisVersions };
}
export async function applyMembershipCatalogEffect(trx: Transaction<Database>, commandId: string, effect: Record<string, unknown>, reason: string) {
  const result = await sql<{ id: string }>`select qintopia_apply_membership_catalog(${commandId}, ${JSON.stringify(effect)}::jsonb, ${reason}) as id`.execute(trx);
  const changeId = result.rows[0]!.id;
  return { persistedResult: { ...effect, changeId }, resourceRefs: [String(effect.propertyId), changeId], factRefs: [changeId] };
}
