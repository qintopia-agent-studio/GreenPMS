import { Type, type TProperties } from "@sinclair/typebox";
const obj = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 160 });
const positive = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
export const MembershipValiditySchema = Type.String({ pattern: "^P[1-9][0-9]*(M|Y)$", maxLength: 12 });
const saleStatus = Type.Union([Type.Literal("ON_SALE"), Type.Literal("OFF_SALE")]);
export const MembershipSpecificationSchema = obj({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  listPriceMinor: Type.Integer({ minimum: 100, maximum: 2_147_483_600, multipleOf: 100 }),
  allowedRoomTypeCodes: Type.Array(id, { minItems: 1, uniqueItems: true }),
  entitlementUnits: positive,
  validityPeriod: MembershipValiditySchema
});
const version = obj({ ...MembershipSpecificationSchema.properties, productId: id, code: id, version: positive,
  currency: Type.String({ minLength: 3, maxLength: 3 }), allowedRoomTypeCode: id,
  entitlementUnitKind: Type.Union([Type.Literal("ROOM_NIGHT"), Type.Literal("BED_NIGHT")]),
  allowedInventoryKind: Type.Union([Type.Literal("ROOM"), Type.Literal("BED")]) });
const entry = obj({ propertyId: id, code: id, revision: positive, saleStatus, current: version });
const common = { propertyId: id, expectedRoomCatalogVersion: Type.Integer({ minimum: 0 }) };
const existing = { ...common, code: id, expectedRevision: positive };
export const MembershipCatalogInputSchema = Type.Unsafe({ type: "object", discriminator: { propertyName: "action" }, oneOf: [
  obj({ ...common, action: Type.Literal("CREATE"), specification: MembershipSpecificationSchema }),
  obj({ ...existing, action: Type.Literal("UPDATE"), specification: MembershipSpecificationSchema }),
  obj({ ...existing, action: Type.Literal("SET_SALE_STATUS"), saleStatus })
] });
export const MembershipCatalogEffectSchema = obj({ operation: Type.Literal("MANAGE_MEMBERSHIP_CATALOG"), propertyId: id,
  action: Type.Union([Type.Literal("CREATE"), Type.Literal("UPDATE"), Type.Literal("SET_SALE_STATUS")]),
  roomCatalogVersion: Type.Integer({ minimum: 0 }), before: Type.Union([entry, Type.Null()]), after: entry,
  title: Type.String(), description: Type.Array(Type.String()) });
export const MembershipCatalogResultSchema = obj({ ...MembershipCatalogEffectSchema.properties, changeId: id });
export const MembershipCatalogViewSchema = obj({ propertyId: id, entries: Type.Array(entry), versions: Type.Array(version),
  history: Type.Array(obj({ id, effect: MembershipCatalogEffectSchema, reason: Type.String(), operator: Type.String(), createdAt: Type.String() })) });
