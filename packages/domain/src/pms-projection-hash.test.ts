import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import fixture from "../../../tests/fixtures/pms-integration/order-projection.json";
import { canonicalProjectionJson, pmsProjectionHash } from "./pms-projection-hash.ts";
import { PmsOrderProjectionSchema } from "../../contracts/src/pms-integration.ts";
describe("shared Agent OS projection fixture", () => {
    it("matches the independent Python hash including versions beyond JS safe integers", () => {
        expect(Value.Check(PmsOrderProjectionSchema, fixture)).toBe(true);
        expect(pmsProjectionHash(fixture)).toBe("b46f00b6121e9f6bda068dcbef5b7219c4f35dee0b07d82b21d46c6a1cc79399");
        expect(pmsProjectionHash({ ...fixture, observed_at: "next", read_context: { business_date: "next" } })).toBe(fixture.projection_hash);
        expect(pmsProjectionHash({ ...fixture, order_revision: "9007199254740994" })).not.toBe(fixture.projection_hash);
    });
    it("sorts UTF-16 keys and rejects unsupported data without silently dropping fields", () => {
        expect(canonicalProjectionJson({ "\uE000": "汉字", "😀": "quote\"\n" })).toBe('{"😀":"quote\\\"\\n","":"汉字"}');
        for (const value of [1, undefined, NaN, new Date(), { x: undefined }, "\uD800", "\uDC00"]) {
            expect(() => canonicalProjectionJson(value)).toThrow();
        }
    });
});
