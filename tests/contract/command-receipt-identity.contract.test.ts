import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { CommandType, PreviewDto, ReceiptDto } from "@qintopia/contracts";
import type { Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let db: Kysely<Database>;
let app: FastifyInstance;
let sequence = 0;
const headers = { authorization: `Bearer ${demo.writeToken}` };
const clock = <T>(day: string, run: () => Promise<T>) =>
  withPropertyClockForTesting(new Date(`${day}T04:00:00Z`), run);
const metadata = (key: string) => ({ ...headers, "idempotency-key": key, "x-correlation-id": "receipt-identity-journey" });

async function preview(commandType: CommandType, input: Record<string, unknown>, key: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/command-previews",
    headers: metadata(key), payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ preview: PreviewDto; receipt: ReceiptDto }>();
}

async function confirm(prepared: PreviewDto, key: string, status = 200) {
  const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${prepared.previewId}/confirm`,
    headers: metadata(key), payload: {
      propertyId: demo.propertyId, commandType: prepared.commandType, confirmation: true,
      expectedEffectHash: prepared.effectHash,
      reason: prepared.commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" }
        : { code: prepared.commandType, note: "Synthetic conversation: authorized normal fulfillment" }
    } });
  expect(response.statusCode, response.body).toBe(status);
  return response.json<ReceiptDto>();
}

async function readOrder(orderId: string) {
  const response = await app.inject({ url: `/api/v1/orders/${orderId}`, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function assertReceiptReads(receipt: ReceiptDto) {
  for (const url of [`/api/v1/commands/${receipt.commandId}`, `/api/v1/receipts/${receipt.receiptId}`]) {
    const response = await app.inject({ url, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(receipt);
  }
}

async function createInHouseOrder(unitId: string) {
  return clock("2026-11-05", async () => {
    const key = `receipt-identity-${++sequence}`;
    const response = await app.inject({ method: "POST", url: "/api/v1/quotes", headers: metadata(`${key}-quote`),
      payload: { propertyId: demo.propertyId, inventoryUnitId: unitId, stayType: "FREE",
        arrivalDate: "2026-11-05", departureDate: "2026-11-06", pricingPolicyVersionId: demo.freePolicyId } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().receipt.commandType).toBe("CREATE_QUOTE");
    const prepared = await preview("CREATE_ORDER", { quoteId: response.json().quote.quoteId,
      primaryGuest: { fullName: "Synthetic Guest", nickname: key },
      freeStayReason: "Synthetic API contract fixture", freeStayCategoryCode: "VOLUNTEER" }, `${key}-create-preview`);
    const created = await confirm(prepared.preview, `${key}-create-confirm`);
    const orderId = created.result!.orderId as string;
    const checkIn = await preview("CHECK_IN", { orderId }, `${key}-checkin-preview`);
    await confirm(checkIn.preview, `${key}-checkin-confirm`);
    return orderId;
  });
}

beforeAll(async () => {
  db = await resetTestDatabase();
  app = await buildServer(db);
  await app.ready();
});
afterAll(async () => { if (app) await app.close(); else await db?.destroy(); });

describe("command identity across the public API", () => {
  it("keeps checkout preview success separate from the committed business outcome and recovers the correct receipt", async () => {
    const orderId = await createInHouseOrder(demo.roomId);
    await clock("2026-11-06", async () => {
      const before = await readOrder(orderId);
      const prepared = await preview("CHECK_OUT", { orderId }, "identity-checkout-preview");
      expect(prepared.receipt).toMatchObject({ commandType: "PREVIEW:CHECK_OUT", executionStatus: "EXECUTED",
        businessCommitted: true, result: { preview: { previewId: prepared.preview.previewId } } });
      expect(prepared.preview.effect).toMatchObject({ orderId, fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT" });
      const afterPreview = await readOrder(orderId);
      expect(afterPreview.order).toEqual(before.order);
      expect(afterPreview.stay.status).toBe("IN_HOUSE");
      expect(afterPreview.fulfillment.checkOut).toBeNull();
      expect(afterPreview.amendments).toEqual(before.amendments);
      expect(await preview("CHECK_OUT", { orderId }, "identity-checkout-preview")).toEqual(prepared);
      await assertReceiptReads(prepared.receipt);

      const receipt = await confirm(prepared.preview, "identity-checkout-confirm");
      expect(receipt).toMatchObject({ commandType: "CHECK_OUT", executionStatus: "EXECUTED", businessCommitted: true,
        result: { orderId, status: "CHECKED_OUT", amendmentId: expect.any(String) } });
      expect(receipt.commandId).not.toBe(prepared.receipt.commandId);
      expect(receipt.result).not.toHaveProperty("preview");
      // Lost confirm responses are recovered by the original confirmation identity, not the preview ID.
      const recovered = await app.inject({ url: `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=CHECK_OUT&idempotencyKey=identity-checkout-confirm`, headers });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json()).toEqual(receipt);
      expect(await confirm(prepared.preview, "identity-checkout-confirm")).toEqual(receipt);
      await assertReceiptReads(receipt);
      // The preview's permanent receipt remains a preview after confirmation.
      await assertReceiptReads(prepared.receipt);
      const order = await readOrder(orderId);
      expect(order.order.status).toBe("CHECKED_OUT");
      expect(order.stay.status).toBe("COMPLETED");
      expect(order.fulfillment.checkOut).not.toBeNull();
      expect(order.amendments.filter((item: { amendment_type: string }) => item.amendment_type === "CHECK_OUT")).toHaveLength(1);
      expect(await db.selectFrom("inventory_claims").select("id").where("active", "=", true)
        .where("source_type", "=", "ORDER_SEGMENT")
        .where("source_id", "in", order.segments.map((item: { id: string }) => item.id)).execute()).toHaveLength(0);
    });
  });

  it("identifies a rejected confirmation without treating its successful preview as a completed checkout", async () => {
    const orderId = await createInHouseOrder(demo.secondRoomId);
    await clock("2026-11-06", async () => {
      const previousTtl = process.env.PREVIEW_TTL_SECONDS;
      let prepared: Awaited<ReturnType<typeof preview>>;
      try {
        process.env.PREVIEW_TTL_SECONDS = "0";
        prepared = await preview("CHECK_OUT", { orderId }, "identity-expired-preview");
      } finally {
        if (previousTtl === undefined) delete process.env.PREVIEW_TTL_SECONDS;
        else process.env.PREVIEW_TTL_SECONDS = previousTtl;
      }
      const receipt = await confirm(prepared.preview, "identity-expired-confirm", 409);
      expect(prepared.receipt.commandType).toBe("PREVIEW:CHECK_OUT");
      expect(receipt).toMatchObject({ commandType: "CHECK_OUT", executionStatus: "NOT_EXECUTED",
        businessCommitted: false, error: { code: "PREVIEW_STALE" } });
      await assertReceiptReads(receipt);
      const order = await readOrder(orderId);
      expect(order.order.status).toBe("CHECKED_IN");
      expect(order.stay.status).toBe("IN_HOUSE");
      expect(order.fulfillment.checkOut).toBeNull();
    });
  });
});
