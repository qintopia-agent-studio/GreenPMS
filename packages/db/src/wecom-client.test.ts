import { describe, expect, it, vi } from "vitest";
import { normalizeWecomBill, WecomClient } from "./wecom-client.ts";
import { paymentWindows } from "./wecom-sync.ts";
const parent = { bill_type: 0, mch_id: "m1", out_trade_no: "trade1", transaction_id: "tx1", external_userid: "external1",
  payee_userid: "staff1", total_fee: 10000, pay_time: 1788220800, trade_state: 3,
  total_refund_fee: 5000, refund_list: [{ out_refund_no: "refund1", refund_fee: 2000, refund_reqtime: 1788220860, refund_status: 2 },
    { out_refund_no: "refund2", refund_fee: 3000, refund_reqtime: 1788220920, refund_status: 1 }] };
describe("WeCom external payment contract", () => {
  it("preserves the individual refund ID, amount and success state", () => {
    const bills = normalizeWecomBill(parent);
    expect(bills).toHaveLength(3);
    expect(bills[1]).toMatchObject({ reference: "refund1", transactionId: "tx1", amountMinor: 2000, state: "SUCCESS" });
    expect(bills[2]).toMatchObject({ reference: "refund2", amountMinor: 3000, state: "PENDING" });
    expect(normalizeWecomBill({ ...parent, bill_type: 1, out_refund_no: "refund1" })[0]).toMatchObject({ amountMinor: null, state: "UNKNOWN" });
  });
  it("rejects bad money and cursor values instead of silently skipping pages", async () => {
    expect(() => normalizeWecomBill({ ...parent, total_fee: 1.2 })).toThrow("WECOM_INVALID_AMOUNT");
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "secret-token", expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ errcode: 0, bill_list: [], next_cursor: 42 }));
    await expect(new WecomClient({ corpId: "corp", secret: "app-secret" }, transport).bills(new Date(1788220800000), new Date(1788220860000))).rejects.toThrow("WECOM_INVALID_CURSOR");
  });
  it("caches the token, retries expired tokens once and preserves a long cursor", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "one", expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ errcode: 42001 }))
      .mockResolvedValueOnce(Response.json({ access_token: "two", expires_in: 7200 }))
      .mockResolvedValueOnce(Response.json({ errcode: 0, bill_list: [parent], next_cursor: "c".repeat(600) }))
      .mockResolvedValueOnce(Response.json({ errcode: 0, external_contact: { external_userid: "external1", name: "旅客昵称" } }));
    const client = new WecomClient({ corpId: "corp", secret: "app-secret" }, transport);
    expect((await client.bills(new Date(1788220800000), new Date(1788220860000))).nextCursor).toHaveLength(600);
    expect(await client.nickname("external1")).toBe("旅客昵称");
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it("bounds catch-up work and never leaves a gap between daily windows", () => {
    const windows = paymentWindows(new Date("2026-08-01Z"), new Date("2026-09-10Z"));
    expect(windows).toHaveLength(7);
    expect(windows.every(([a,b]) => b.getTime()-a.getTime() <= 86400000)).toBe(true);
    expect(windows[0]![1]).toEqual(windows[1]![0]);
  });
});
