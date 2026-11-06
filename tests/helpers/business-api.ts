import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CommandType, PreviewDto, ReceiptDto } from "@qintopia/contracts";
import { demo } from "../../packages/db/src/seed.ts";

type Reason = { code: string; note: string };
type PreviewResponse = { preview: PreviewDto; receipt: ReceiptDto };

/** Public HTTP protocol assertions shared by synthetic daily-business journeys. */
export function createBusinessApi(app: FastifyInstance, token: string = demo.writeToken) {
  const headers = { authorization: `Bearer ${token}` };
  const metadata = (key: string) => ({ ...headers, "idempotency-key": key, "x-correlation-id": `daily-${key}` });
  async function get<T = any>(url: string): Promise<T> {
    const response = await app.inject({ url, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<T>();
  }
  async function preview(commandType: CommandType, input: Record<string, unknown>, key: string): Promise<PreviewResponse> {
    const response = await app.inject({ method: "POST", url: "/api/v1/command-previews",
      headers: metadata(key), payload: { commandType, input: { propertyId: demo.propertyId, ...input } } });
    expect(response.statusCode, response.body).toBe(200);
    const prepared = response.json<PreviewResponse>();
    expect(prepared.preview).toMatchObject({ commandType, effectHash: expect.any(String) });
    expect(prepared.receipt).toMatchObject({ commandType: `PREVIEW:${commandType}`, executionStatus: "EXECUTED",
      businessCommitted: true, result: { preview: { previewId: prepared.preview.previewId } } });
    return prepared;
  }
  async function confirm(prepared: PreviewDto, key: string, reason?: Reason, status = 200): Promise<ReceiptDto> {
    const response = await app.inject({ method: "POST", url: `/api/v1/command-previews/${prepared.previewId}/confirm`,
      headers: metadata(key), payload: { propertyId: demo.propertyId, commandType: prepared.commandType,
        confirmation: true, expectedEffectHash: prepared.effectHash,
        reason: reason ?? (prepared.commandType === "CREATE_ORDER"
          ? { code: "CREATE_STANDARD_ORDER", note: "" }
          : { code: prepared.commandType, note: "Synthetic API business confirmation" }) } });
    expect(response.statusCode, response.body).toBe(status);
    return response.json<ReceiptDto>();
  }
  async function readReceipt(receipt: ReceiptDto) {
    for (const url of [`/api/v1/commands/${receipt.commandId}`, `/api/v1/receipts/${receipt.receiptId}`]) {
      expect(await get(url)).toEqual(receipt);
    }
  }
  async function execute(commandType: CommandType, input: Record<string, unknown>, key: string,
    options: { snapshot: () => Promise<unknown>; reason?: Reason }): Promise<ReceiptDto> {
    const before = await options.snapshot();
    const prepared = await preview(commandType, input, `${key}-preview`);
    expect(await options.snapshot(), `${commandType}: preview must not change target business state`).toEqual(before);
    expect(await preview(commandType, input, `${key}-preview`)).toEqual(prepared);
    await readReceipt(prepared.receipt);
    expect(await options.snapshot()).toEqual(before);

    const receipt = await confirm(prepared.preview, `${key}-confirm`, options.reason);
    expect(receipt).toMatchObject({ commandType, executionStatus: "EXECUTED", businessCommitted: true });
    expect(receipt.commandId).not.toBe(prepared.receipt.commandId);
    expect(receipt.result).not.toHaveProperty("preview");
    const committed = await options.snapshot();
    expect(await confirm(prepared.preview, `${key}-confirm`, options.reason)).toEqual(receipt);
    const query = new URLSearchParams({ propertyId: String(input.propertyId ?? demo.propertyId), commandType, idempotencyKey: `${key}-confirm` });
    expect(await get(`/api/v1/command-results?${query}`)).toEqual(receipt);
    await readReceipt(receipt);
    await readReceipt(prepared.receipt);
    expect(await options.snapshot(), `${commandType}: replay and recovery must not duplicate business effects`).toEqual(committed);
    return receipt;
  }
  return { headers, get, preview, confirm, execute };
}
