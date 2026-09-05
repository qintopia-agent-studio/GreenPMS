import { describe, expect, it } from "vitest";
import { assertTemporaryOtherRoomAcceptanceDatabaseUrl } from "../tests/e2e/setup-temporary-other-room-acceptance.ts";

const localTarget = "postgres://test:test@127.0.0.1:55433/qintopia_temporary_other_room_acceptance";

describe("temporary other-room acceptance database boundary", () => {
  it("allows only the named local acceptance database", () => {
    expect(() => assertTemporaryOtherRoomAcceptanceDatabaseUrl(localTarget)).not.toThrow();
    expect(() => assertTemporaryOtherRoomAcceptanceDatabaseUrl(localTarget.replace("127.0.0.1:55433", "localhost:55432"))).not.toThrow();
  });

  it.each([
    localTarget.replace("127.0.0.1", "example.invalid"),
    localTarget.replace("qintopia_temporary_other_room_acceptance", "qintopia"),
    `${localTarget}?host=example.invalid`,
    `${localTarget}?dbname=qintopia`,
    `${localTarget}#another-target`
  ])("rejects a non-isolated or overridden connection target: %s", (target) => {
    expect(() => assertTemporaryOtherRoomAcceptanceDatabaseUrl(target)).toThrow("Refusing acceptance setup");
  });
});
