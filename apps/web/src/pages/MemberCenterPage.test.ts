import { expect, it } from "vitest";
import { acceptedSubscription } from "./MemberCenterPage";

it("records only the current template when the native WeChat subscription result is accepted", () => {
  const result = (value: string) => ({ errMsg: "subscribe:ok", subscribeDetails: JSON.stringify({ expiry: JSON.stringify({ status: value }) }) });
  expect(acceptedSubscription(result("accept"), "expiry")).toBe(true);
  for (const resultStatus of ["cancel", "reject", "filter"]) expect(acceptedSubscription(result(resultStatus), "expiry")).toBe(false);
  expect(acceptedSubscription(result("accept"), "other")).toBe(false);
  expect(acceptedSubscription(undefined, "expiry")).toBe(false);
  expect(acceptedSubscription({ errMsg: "subscribe:ok", subscribeDetails: "bad data" }, "expiry")).toBe(false);
});
