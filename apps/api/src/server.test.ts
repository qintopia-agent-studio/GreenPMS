import { describe, expect, it } from "vitest";
import { webOriginAllowlist } from "./server.ts";

describe("webOriginAllowlist", () => {
  it("accepts both loopback spellings in local development", () => {
    expect(webOriginAllowlist(undefined, undefined)).toEqual([
      "http://127.0.0.1:4173",
      "http://localhost:4173"
    ]);
  });

  it("uses the configured local web port for alternate development servers", () => {
    expect(webOriginAllowlist(undefined, "4174")).toEqual([
      "http://127.0.0.1:4174",
      "http://localhost:4174"
    ]);
  });

  it("keeps an explicitly configured deployment origin strict", () => {
    expect(webOriginAllowlist("  https://pms.example.com  ", "4174")).toEqual([
      "https://pms.example.com"
    ]);
  });
});
