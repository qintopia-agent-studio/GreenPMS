import { describe, expect, it } from "vitest";
import { webOriginAllowlist } from "./server.ts";

describe("webOriginAllowlist", () => {
  it("accepts both loopback spellings in local development", () => {
    expect(webOriginAllowlist(undefined)).toEqual([
      "http://127.0.0.1:4173",
      "http://localhost:4173"
    ]);
  });

  it("keeps an explicitly configured deployment origin strict", () => {
    expect(webOriginAllowlist("  https://pms.example.com  ")).toEqual([
      "https://pms.example.com"
    ]);
  });
});
