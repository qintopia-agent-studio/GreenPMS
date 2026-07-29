import { describe, expect, it } from "vitest";
import {
  commandShellSuccessMessage,
  initialCommandShellState,
  isU1CommandType,
  transitionCommandShell,
  u1CommandTypes
} from "./commandShellState";

describe("U1 command shell state", () => {
  it("freezes the approved command whitelist", () => {
    expect(u1CommandTypes).toHaveLength(15);
    for (const commandType of u1CommandTypes) {
      expect(isU1CommandType(commandType)).toBe(true);
      expect(commandShellSuccessMessage(commandType)).toMatch(/[。]$/);
    }
    expect(isU1CommandType("COMPLETE_CLEANING")).toBe(false);
    expect(isU1CommandType("RESCHEDULE_STAY")).toBe(true);
    expect(isU1CommandType("EXTEND_STAY")).toBe(true);
    expect(isU1CommandType("ISSUE_TOKEN")).toBe(false);
  });

  it("moves through automatic preview, one confirmation, unknown recovery and success", () => {
    const initial = initialCommandShellState({ attemptId: 7 });
    const ready = transitionCommandShell(initial, { type: "PREVIEW_READY", attemptId: 7, previewId: "preview_1" });
    expect(ready).toEqual({ accepted: true, state: { phase: "READY_TO_CONFIRM", attemptId: 7, previewId: "preview_1" } });
    const confirming = transitionCommandShell(ready.state, { type: "CONFIRM_STARTED", attemptId: 7, confirmationKey: "key_1" });
    expect(confirming.state.phase).toBe("CONFIRMING");
    const unknown = transitionCommandShell(confirming.state, { type: "RESULT_UNKNOWN", attemptId: 7, confirmationKey: "key_1" });
    expect(unknown.state.phase).toBe("RESULT_UNKNOWN");
    const succeeded = transitionCommandShell(unknown.state, { type: "SUCCEEDED", attemptId: 7, confirmationKey: "key_1" });
    expect(succeeded.state.phase).toBe("SUCCEEDED");
  });

  it("supports return, expiry and explicit zero-write failure", () => {
    const ready = transitionCommandShell(initialCommandShellState(), { type: "PREVIEW_READY", attemptId: 1, previewId: "preview_1" }).state;
    expect(transitionCommandShell(ready, { type: "RETURN_TO_EDIT", attemptId: 1 }).state.phase).toBe("EDITING");
    const expired = transitionCommandShell(ready, { type: "PREVIEW_EXPIRED", attemptId: 1 }).state;
    expect(expired.phase).toBe("PREVIEW_EXPIRED");
    expect(transitionCommandShell(expired, { type: "PREVIEW_STARTED", attemptId: 1 }).state.phase).toBe("AUTO_PREVIEWING");
    const confirming = transitionCommandShell(ready, { type: "CONFIRM_STARTED", attemptId: 1, confirmationKey: "key_1" }).state;
    expect(transitionCommandShell(confirming, { type: "NOT_EXECUTED", attemptId: 1, confirmationKey: "key_1" }).state.phase).toBe("NOT_EXECUTED");
    expect(initialCommandShellState({ attemptId: 2, confirmationKey: "key_2", notExecuted: true })).toEqual({
      phase: "NOT_EXECUTED",
      attemptId: 2,
      confirmationKey: "key_2"
    });
  });

  it("rejects illegal, stale and mismatched-key transitions", () => {
    const ready = transitionCommandShell(initialCommandShellState(), { type: "PREVIEW_READY", attemptId: 1, previewId: "preview_1" }).state;
    expect(transitionCommandShell(ready, { type: "SUCCEEDED", attemptId: 1, confirmationKey: "key_1" }).accepted).toBe(false);
    expect(transitionCommandShell(ready, { type: "RETURN_TO_EDIT", attemptId: 2 }).accepted).toBe(false);
    const confirming = transitionCommandShell(ready, { type: "CONFIRM_STARTED", attemptId: 1, confirmationKey: "key_1" }).state;
    expect(transitionCommandShell(confirming, { type: "RESULT_UNKNOWN", attemptId: 1, confirmationKey: "key_2" }).accepted).toBe(false);
    expect(transitionCommandShell(confirming, { type: "NOT_EXECUTED", attemptId: 1, confirmationKey: "key_2" }).accepted).toBe(false);
  });
});
