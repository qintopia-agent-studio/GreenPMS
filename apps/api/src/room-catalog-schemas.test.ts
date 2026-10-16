import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { RoomCatalogEffectSchema, RoomCatalogInputSchema } from "./room-catalog-schemas";

const ajv = new Ajv({ strict: false, discriminator: true });
describe("房间分类仅允许新建单房修改，历史记录仍可读", () => {
  it("拒绝新的批量分类请求", () => {
    const validate = ajv.compile(RoomCatalogInputSchema);
    const input = { propertyId: "property", expectedVersion: 1, action: "SET_OPERATING_STATISTICS", assetIds: ["room-a"], included: false };
    expect(validate(input)).toBe(true);
    expect(validate({ ...input, assetIds: ["room-a", "room-b"] })).toBe(false);
    expect(validate({ ...input, assetIds: [] })).toBe(false);
  });
  it("历史回执仍可包含原有的多房修改结果", () => {
    const validate = ajv.compile(RoomCatalogEffectSchema.properties.operatingStatisticsChange);
    expect(validate({ assetIds: ["room-a", "room-b"], included: false })).toBe(true);
  });
});
