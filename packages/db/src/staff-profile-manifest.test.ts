import { describe, expect, it } from "vitest";
import { resolveStaffProfileManifest } from "./staff-profile-manifest.ts";

describe("reviewed staff profile manifests", () => {
  it("binds the verified QinTopia production administrator to the production property", () => {
    expect(resolveStaffProfileManifest("qintopia_production_20260904")).toEqual({
      name: "qintopia_production_20260904",
      entries: [
        {
          subjectId: "subject_qintopia_admin",
          propertyId: "prop_qintopia",
          profile: "ADMIN"
        }
      ]
    });
  });

  it("keeps production and demo identities in separate manifests", () => {
    const production = resolveStaffProfileManifest("qintopia_production_20260904");
    const demo = resolveStaffProfileManifest("demo");

    expect(production.entries.some((productionEntry) => demo.entries.some((demoEntry) =>
      productionEntry.subjectId === demoEntry.subjectId
      && productionEntry.propertyId === demoEntry.propertyId
    ))).toBe(false);
    expect(production.entries).not.toContainEqual(expect.objectContaining({
      subjectId: expect.stringContaining("demo")
    }));
  });
});
