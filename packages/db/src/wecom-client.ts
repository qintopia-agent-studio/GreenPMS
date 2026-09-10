/** Public contract: https://developer.work.weixin.qq.com/document/path/93667 */
export type ExternalBillKind = "COLLECTION" | "REFUND";
export type ExternalBillState = "SUCCESS" | "PENDING" | "CLOSED" | "UNKNOWN";
export interface WecomBill {
  kind: ExternalBillKind;
  merchantId: string;
  reference: string;
  originalTradeNo: string;
  transactionId: string | null;
  externalUserId: string | null;
  collectorId: string | null;
  amountMinor: number | null;
  occurredAt: Date;
  state: ExternalBillState;
}
export class WecomApiError extends Error {
  constructor(readonly code: string, readonly retryable = true) { super(code); }
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WecomApiError("WECOM_INVALID_RESPONSE");
  return value as ObjectValue;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value.trim() : null;
}
function requiredText(value: unknown): string {
  const result = text(value);
  if (!result) throw new WecomApiError("WECOM_INVALID_IDENTIFIER");
  return result;
}
function amount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647 ? Number(value) : null;
}
function instant(value: unknown): Date {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 8_640_000_000_000) throw new WecomApiError("WECOM_INVALID_TIME");
  return new Date(Number(value) * 1000);
}
function refundState(value: unknown): ExternalBillState {
  return value === 2 ? "SUCCESS" : value === 0 || value === 1 || value === 5 ? "PENDING"
    : value === 3 || value === 6 || value === 7 ? "CLOSED" : "UNKNOWN";
}

export function normalizeWecomBill(value: unknown): WecomBill[] {
  const row = object(value);
  if (row.bill_type !== 0 && row.bill_type !== 1) throw new WecomApiError("WECOM_INVALID_BILL_TYPE");
  const base = { merchantId: requiredText(row.mch_id), originalTradeNo: requiredText(row.out_trade_no),
    externalUserId: text(row.external_userid), collectorId: text(row.payee_userid) };
  if (row.bill_type === 1) {
    // The standalone refund row does not contain refund_status/refund_fee.
    // Its parent refund_list supplies the verified individual amount and status.
    return [{ ...base, kind: "REFUND", reference: requiredText(row.out_refund_no),
      transactionId: null, amountMinor: null, occurredAt: instant(row.pay_time), state: "UNKNOWN" }];
  }
  const total = amount(row.total_fee);
  if (total === null) throw new WecomApiError("WECOM_INVALID_AMOUNT");
  const transactionId = requiredText(row.transaction_id);
  const bills: WecomBill[] = [{ ...base, kind: "COLLECTION", reference: transactionId, transactionId,
    amountMinor: total, occurredAt: instant(row.pay_time), state: row.trade_state === 1 || row.trade_state === 3 ? "SUCCESS" : "UNKNOWN" }];
  if (row.refund_list !== undefined && !Array.isArray(row.refund_list)) throw new WecomApiError("WECOM_INVALID_REFUNDS");
  for (const value of (row.refund_list ?? []) as unknown[]) {
    const refund = object(value);
    const refundAmount = amount(refund.refund_fee);
    if (refundAmount === null || refundAmount > total) throw new WecomApiError("WECOM_INVALID_REFUND_AMOUNT");
    bills.push({ ...base, kind: "REFUND", reference: requiredText(refund.out_refund_no), transactionId,
      collectorId: text(refund.refund_userid), amountMinor: refundAmount,
      occurredAt: instant(refund.refund_reqtime), state: refundState(refund.refund_status) });
  }
  return bills;
}

export interface WecomPage { bills: WecomBill[]; nextCursor: string | null }
export interface WecomClientConfig { corpId: string; secret: string; timeoutMs?: number }
type Transport = typeof fetch;
const apiBase = "https://qyapi.weixin.qq.com/cgi-bin/";

export class WecomClient {
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;
  constructor(private readonly config: WecomClientConfig, private readonly transport: Transport = fetch,
    private readonly now: () => number = Date.now) {
    if (!config.corpId || !config.secret) throw new WecomApiError("WECOM_NOT_CONFIGURED", false);
  }
  private async json(url: URL, body?: unknown): Promise<ObjectValue> {
    let response: Response;
    try {
      response = await this.transport(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    } catch { throw new WecomApiError("WECOM_NETWORK_ERROR"); }
    if (!response.ok) throw new WecomApiError(`WECOM_HTTP_${response.status}`, response.status === 429 || response.status >= 500);
    // Reject unexpectedly large payloads without logging a token, URL or payer data.
    const reader = response.body?.getReader();
    if (!reader) throw new WecomApiError("WECOM_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new WecomApiError("WECOM_RESPONSE_TOO_LARGE"); }
        chunks.push(part.value);
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof WecomApiError) throw error;
      throw new WecomApiError("WECOM_INVALID_RESPONSE");
    } finally { reader.releaseLock(); }
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = (async () => {
        const url = new URL("gettoken", apiBase);
        url.searchParams.set("corpid", this.config.corpId);
        url.searchParams.set("corpsecret", this.config.secret);
        const result = await this.json(url);
        if (result.errcode !== undefined && result.errcode !== 0) throw new WecomApiError(`WECOM_${Number(result.errcode)}`, false);
        if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(result.expires_in) || Number(result.expires_in) <= 0) throw new WecomApiError("WECOM_INVALID_TOKEN_RESPONSE");
        this.token = { value: result.access_token, expiresAt: this.now() + Math.max(1, Number(result.expires_in) - 120) * 1000 };
        return this.token.value;
      })().finally(() => { this.tokenRequest = undefined; });
    }
    return this.tokenRequest;
  }
  private async call(path: string, body?: unknown, query?: Record<string, string>): Promise<ObjectValue> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const url = new URL(path, apiBase);
      url.searchParams.set("access_token", token);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      const result = await this.json(url, body);
      if ([40014, 42001, 40001].includes(Number(result.errcode)) && attempt === 0) {
        if (this.token?.value === token) this.token = undefined;
        continue;
      }
      if (result.errcode !== 0) throw new WecomApiError(`WECOM_${Number(result.errcode)}`, [45009, -1].includes(Number(result.errcode)));
      return result;
    }
    throw new WecomApiError("WECOM_INVALID_TOKEN", false);
  }
  async bills(begin: Date, end: Date, cursor?: string): Promise<WecomPage> {
    const beginSeconds = Math.floor(begin.getTime() / 1000), endSeconds = Math.floor(end.getTime() / 1000);
    // Daily windows are used by the worker; this guard is stricter than one month.
    if (!Number.isSafeInteger(beginSeconds) || !Number.isSafeInteger(endSeconds) || endSeconds <= beginSeconds || endSeconds - beginSeconds > 28 * 86400) throw new WecomApiError("WECOM_INVALID_WINDOW", false);
    const result = await this.call("externalpay/get_bill_list", { begin_time: beginSeconds, end_time: endSeconds,
      limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.bill_list)) throw new WecomApiError("WECOM_INVALID_BILLS");
    if (result.next_cursor !== undefined && result.next_cursor !== null && typeof result.next_cursor !== "string") throw new WecomApiError("WECOM_INVALID_CURSOR");
    if (typeof result.next_cursor === "string" && result.next_cursor.length > 16384) throw new WecomApiError("WECOM_INVALID_CURSOR");
    return { bills: result.bill_list.flatMap(normalizeWecomBill), nextCursor: result.next_cursor ? String(result.next_cursor) : null };
  }
  async nickname(externalUserId: string): Promise<string | null> {
    const result = await this.call("externalcontact/get", undefined, { external_userid: externalUserId });
    const contact = object(result.external_contact);
    if (contact.external_userid !== externalUserId) throw new WecomApiError("WECOM_CONTACT_ID_MISMATCH", false);
    return text(contact.name);
  }
}
