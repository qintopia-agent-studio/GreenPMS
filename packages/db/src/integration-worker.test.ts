import { describe, it, expect, vi } from "vitest";
import { httpsDeliveryTransport, classifyDelivery, eventSignature, validateDeliveryConfig, type IntegrationDeliveryConfig } from "./integration-worker.ts";
const config: IntegrationDeliveryConfig = { endpoint: "https://receiver.invalid/api/v1/ingress/pms/events", sourceInstance: "synthetic-pms", propertyIds: ["fixture-property"], keyId: "test", signingKey: "synthetic-test-only-key-material-32", timeoutMs: 1000, leaseMs: 10000 };
describe("fixed PMS delivery protocol", () => {
    it("accepts only matching durable ACKs", () => {
        expect(classifyDelivery({ status: 202, body: '{"status":"accepted","event_id":"event","receipt_id":"receipt"}', retryAfter: null }, "event")).toEqual({ kind: "accepted", receipt: "receipt" });
        for (const body of ['{}', '{"status":"accepted","event_id":"other","receipt_id":"receipt"}', '{"status":"accepted","event_id":"event","receipt_id":""}'])
            expect(classifyDelivery({ status: 202, body, retryAfter: null }, "event").kind).toBe("retry");
        expect(classifyDelivery({ status: 200, body: '{"status":"duplicate","event_id":"event","receipt_id":"receipt"}', retryAfter: null }, "event").kind).toBe("accepted");
    });
    it("isolates protocol conflicts, pauses credential failures, bounds retry-after", () => {
        for (const status of [400, 409, 413, 422])
            expect(classifyDelivery({ status, body: "", retryAfter: null }, "event").kind).toBe("dead_letter");
        for (const status of [401, 403])
            expect(classifyDelivery({ status, body: "", retryAfter: null }, "event").kind).toBe("pause");
        expect(classifyDelivery({ status: 429, body: "", retryAfter: "9999999" }, "event")).toMatchObject({ kind: "retry", retryAfterMs: 900000 });
        expect(classifyDelivery({ status: 302, body: "", retryAfter: null }, "event").kind).toBe("retry");
    });
    it("signs exact bytes and changes delivery headers on replay", () => {
        // Independently computed with Python hashlib/hmac.
        expect(eventSignature('{"x":"汉字"}', "1", "delivery", config.signingKey)).toBe("67802a2a4dd569df28e13e91b6746820543e5e5143db28901d05221ba1d93f69");
        expect(eventSignature('{"x":"汉字"}', "1", "delivery", config.signingKey)).not.toBe(eventSignature('{ "x":"汉字"}', "1", "delivery", config.signingKey));
        expect(eventSignature('{}', "1", "delivery", config.signingKey)).not.toBe(eventSignature('{}', "2", "new-delivery", config.signingKey));
    });
    it("rejects arbitrary callback paths, cleartext, URL credentials, short leases", () => {
        expect(() => validateDeliveryConfig(config)).not.toThrow();
        for (const endpoint of ["http://receiver.invalid/api/v1/ingress/pms/events", "https://receiver.invalid/other", "https://receiver.invalid/api/v1/ingress/pms/events?callback=x", "https://user@receiver.invalid/api/v1/ingress/pms/events"]) {
            expect(() => validateDeliveryConfig({ ...config, endpoint })).toThrow();
        }
        expect(() => validateDeliveryConfig({ ...config, leaseMs: 1000 })).toThrow();
    });
    it("never follows redirects and bounds ACK response bytes without network access", async () => {
        const request=vi.fn().mockResolvedValueOnce(new Response("",{status:302,headers:{location:"https://other.invalid"}}))
            .mockResolvedValueOnce(new Response("x".repeat(4097),{status:202}));
        vi.stubGlobal("fetch",request);
        try {
            expect((await httpsDeliveryTransport(config.endpoint,"{}",{},1000)).status).toBe(302);
            expect(request).toHaveBeenCalledTimes(1);
            expect(request.mock.calls[0]![1]).toMatchObject({redirect:"manual",method:"POST",body:"{}"});
            expect((await httpsDeliveryTransport(config.endpoint,"{}",{},1000)).body).toBe("");
        } finally {vi.unstubAllGlobals();}
    });

});
