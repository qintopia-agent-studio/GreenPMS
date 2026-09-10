import { createHash } from "node:crypto";
/** RFC 8785 subset negotiated for PMS v1: no numbers or undefined. */
export function canonicalProjectionJson(value: unknown): string {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "string") {
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
            throw new Error("INVALID_UNICODE");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${Array.from(value, canonicalProjectionJson).join(",")}]`;
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${canonicalProjectionJson(key)}:${canonicalProjectionJson(record[key])}`).join(",")}}`;
    }
    throw new Error("INVALID_PROJECTION_VALUE");
}
export function pmsProjectionHash(projection: Record<string, unknown>): string {
    const { projection_hash: _hash, observed_at: _time, read_context: _context, ...stable } = projection;
    return createHash("sha256").update(canonicalProjectionJson(stable)).digest("hex");
}
