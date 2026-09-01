import { describe, expect, it } from "vitest";
import {
  assertVisualFixtureTargetAuthorized,
  parseVisualFixtureArguments,
  visualAcceptanceScenarioDefinitions
} from "../tests/e2e/setup-room-status-visual-acceptance.ts";

describe("room-status visual acceptance fixture target guard", () => {
  const qintopiaUrl = "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";

  it("defaults to isolated fixture mode without production-style confirmations", () => {
    expect(parseVisualFixtureArguments([])).toEqual({
      allowQintopiaWrite: false,
      confirmedEmptyDatabase: null,
      confirmWritersStopped: false
    });
    expect(assertVisualFixtureTargetAuthorized(
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e",
      parseVisualFixtureArguments([])
    )).toBe("ISOLATED");
    for (const databaseUrl of [
      "postgres://qintopia:qintopia@db.example.com:55432/qintopia_e2e",
      "postgres://qintopia:qintopia@127.0.0.1:55432/customer_data",
      "postgres://qintopia:qintopia@127.0.0.1:5432/qintopia_e2e",
      "mysql://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e"
    ]) {
      expect(() => assertVisualFixtureTargetAuthorized(databaseUrl, parseVisualFixtureArguments([])))
        .toThrow("may reset only");
    }
  });

  it("rejects connection-string overrides before selecting any fixture target", () => {
    for (const databaseUrl of [
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e?host=evil.example",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e#host=evil.example",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia?port=5432"
    ]) {
      expect(() => assertVisualFixtureTargetAuthorized(databaseUrl, parseVisualFixtureArguments([])))
        .toThrow("must not contain query parameters or fragments");
    }
  });

  it("requires all real-database confirmations before writing qintopia", () => {
    expect(() => assertVisualFixtureTargetAuthorized(qintopiaUrl, {
      allowQintopiaWrite: false,
      confirmedEmptyDatabase: "qintopia",
      confirmWritersStopped: true
    })).toThrow("requires");
    expect(() => assertVisualFixtureTargetAuthorized(qintopiaUrl, {
      allowQintopiaWrite: true,
      confirmedEmptyDatabase: null,
      confirmWritersStopped: true
    })).toThrow("requires");
    expect(() => assertVisualFixtureTargetAuthorized(qintopiaUrl, {
      allowQintopiaWrite: true,
      confirmedEmptyDatabase: "qintopia",
      confirmWritersStopped: false
    })).toThrow("requires");
    expect(assertVisualFixtureTargetAuthorized(qintopiaUrl, {
      allowQintopiaWrite: true,
      confirmedEmptyDatabase: "qintopia",
      confirmWritersStopped: true
    })).toBe("QINTOPIA");
  });

  it("refuses lookalike acceptance databases instead of resetting an arbitrary local database", () => {
    expect(() => assertVisualFixtureTargetAuthorized(
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_visual_acceptance",
      {
        allowQintopiaWrite: false,
        confirmedEmptyDatabase: null,
        confirmWritersStopped: false
      }
    )).toThrow("exact local qintopia_e2e");
  });

  it("keeps every debt counterexample, source badge, and two-bed visual case explicit", () => {
    expect(visualAcceptanceScenarioDefinitions.futurePartialArrears).toMatchObject({
      roomCode: "C01",
      expected: expect.stringContaining("部分收款仍显示欠款")
    });
    expect(visualAcceptanceScenarioDefinitions.externalChannelDebtExcluded.expected).toContain("不显示欠款");
    expect(visualAcceptanceScenarioDefinitions.freeStayDebtExcluded.expected).toContain("不显示欠款");
    expect(visualAcceptanceScenarioDefinitions.memberCoverageDebtExcluded.expected).toContain("不显示欠款");
    expect(visualAcceptanceScenarioDefinitions.youmudaoSourceBadge).toMatchObject({
      channelCode: "YOUMUDAO",
      badge: "Y"
    });
    expect(visualAcceptanceScenarioDefinitions.externalChannelDebtExcluded).toMatchObject({
      channelCode: "CTRIP",
      badge: "X"
    });
    expect(visualAcceptanceScenarioDefinitions.meituanSourceBadge).toMatchObject({
      channelCode: "MEITUAN",
      badge: "M"
    });
    expect(visualAcceptanceScenarioDefinitions.freeStayDebtExcluded.badge).toBe("F");
    expect(visualAcceptanceScenarioDefinitions.memberCoverageDebtExcluded.badge).toBe("H");
    expect(visualAcceptanceScenarioDefinitions.twoBedSplit).toMatchObject({
      roomCode: "105",
      unitCode: "105-A",
      emptyBedCode: "105-B",
      expected: expect.stringMatching(/A 床位行不显示比例.*父房显示 1\/2/)
    });
  });
});
