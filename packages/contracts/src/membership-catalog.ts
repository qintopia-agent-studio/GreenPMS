export type MembershipValidityPeriod = `P${number}M` | `P${number}Y`;
export type MembershipSaleStatus = "ON_SALE" | "OFF_SALE";
export interface MembershipProductSpecification {
  name: string;
  listPriceMinor: number;
  allowedRoomTypeCodes: string[];
  entitlementUnits: number;
  validityPeriod: MembershipValidityPeriod;
}
export interface MembershipProductVersion extends MembershipProductSpecification {
  productId: string;
  code: string;
  version: number;
  currency: string;
  entitlementUnitKind: "ROOM_NIGHT" | "BED_NIGHT";
  allowedInventoryKind: "ROOM" | "BED";
  allowedRoomTypeCode: string;
}
export interface MembershipCatalogEntry {
  propertyId: string;
  code: string;
  revision: number;
  saleStatus: MembershipSaleStatus;
  current: MembershipProductVersion;
}
export type MembershipCatalogInput = { propertyId: string; expectedRoomCatalogVersion: number } & (
  | { action: "CREATE"; specification: MembershipProductSpecification }
  | { action: "UPDATE"; code: string; expectedRevision: number; specification: MembershipProductSpecification }
  | { action: "SET_SALE_STATUS"; code: string; expectedRevision: number; saleStatus: MembershipSaleStatus }
);
export interface MembershipCatalogEffect {
  operation: "MANAGE_MEMBERSHIP_CATALOG";
  propertyId: string;
  action: MembershipCatalogInput["action"];
  roomCatalogVersion: number;
  before: MembershipCatalogEntry | null;
  after: MembershipCatalogEntry;
  title: string;
  description: string[];
}
export interface MembershipCatalogView {
  propertyId: string;
  entries: MembershipCatalogEntry[];
  versions: MembershipProductVersion[];
  history: { id: string; effect: MembershipCatalogEffect; reason: string; operator: string; createdAt: string }[];
}
