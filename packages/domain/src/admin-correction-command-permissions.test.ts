import { describe, expect, it } from "vitest";
import { commandTypes, currentReleaseFeatures } from "@qintopia/contracts";
import {
  administratorCommandGrants,
  ordinaryStaffCommandGrants
} from "./command-permissions.ts";

const administratorCorrections = [
  "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
  "CORRECT_MEMBER_PROFILE",
  "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
  "BACKFILL_HISTORICAL_MEMBERSHIP",
  "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
] as const;

describe("step 9 administrator correction grants", () => {
  it("publishes five exact administrator-only commands with their release gates enabled", () => {
    expect(commandTypes).toEqual(expect.arrayContaining([...administratorCorrections]));
    expect(administratorCommandGrants).toEqual(expect.arrayContaining([...administratorCorrections]));
    expect(ordinaryStaffCommandGrants).not.toEqual(expect.arrayContaining([...administratorCorrections]));

    expect(currentReleaseFeatures).toMatchObject({
      historicalStayArrangementCorrection: true,
      memberProfileCorrection: true,
      membershipEffectiveDateCorrection: true,
      historicalMembershipBackfill: true,
      membershipConversionVoidCorrection: true
    });
  });
});
