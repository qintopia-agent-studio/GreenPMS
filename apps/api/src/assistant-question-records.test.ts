import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qintopia/db";
import type { AuthPrincipal } from "@qintopia/contracts";
import type { FastifyBaseLogger } from "fastify";
import { assistantQuestionPage, assistantQuestionTopic, createAssistantQuestionProgress, finishAssistantQuestion, redactAssistantQuestion } from "./assistant-question-records.ts";

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async (_parameters: unknown[]) => ({})) }));
vi.mock("kysely", () => ({ sql: (_strings: TemplateStringsArray, ...parameters: unknown[]) => ({ execute: () => execute(parameters) }) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("assistant question minimization", () => {
  it("redacts labeled identities, contact numbers, credentials and resource identifiers", () => {
    const input = '姓名：张三，手机号 138 0000 0000，证件 11010119900101123X，邮箱 guest@example.com，API key: "private-key"，Bearer sensitive-token，https://example.com?q=private，订单 order_private123';
    const output = redactAssistantQuestion(input);
    for (const value of ["张三", "138", "110101", "guest@example", "private-key", "sensitive-token", "example.com", "order_private123"]) expect(output).not.toContain(value);
    expect(output).toContain("[电话]"); expect(output).toContain("[凭据]");
  });
  it("normalizes full-width input and hides common long identifiers", () => {
    const output = redactAssistantQuestion("１３８００００００００ 6222 0200 0000 0000 000 550e8400-e29b-41d4-a716-446655440000 sk-privatevalue123 张三先生");
    expect(output).not.toContain("13800000000"); expect(output).not.toContain("6222"); expect(output).not.toContain("550e8400"); expect(output).not.toContain("privatevalue"); expect(output).not.toContain("张三");
  });
  it("retains operational dates, amounts, room numbers, masked phones and genuine help questions", () => {
    const input = "101 房 2026-09-15 至 2026-09-17，续住 2 晚，费用 180.50 元，手机号 138****1234；密码怎么修改？";
    expect(redactAssistantQuestion(input)).toBe(input.normalize("NFKC"));
    expect(assistantQuestionTopic(input)).toBe("STAY_EXTENSION");
    expect(assistantQuestionTopic("需要取消这个订单")).toBe("CANCELLATION");
    expect(assistantQuestionTopic("早上好")).toBe("OTHER");
  });
  it("stores only recognized page labels and bounds text size", () => {
    expect(assistantQuestionPage("订单详情")).toBe("order");
    expect(assistantQuestionPage("__proto__")).toBe("unknown");
    expect(assistantQuestionPage("toString")).toBe("unknown");
    expect(assistantQuestionPage("姓名：张三")).toBe("unknown");
    expect(redactAssistantQuestion("续住".repeat(5000)).length).toBe(8000);
  });
});

describe("long-running assistant question telemetry", () => {
  const db = {} as Kysely<Database>;
  const principal = { subjectId: "synthetic-subject", credentialId: "synthetic-session" } as AuthPrincipal;
  const warn = vi.fn(), logger = { warn } as unknown as FastifyBaseLogger;

  it("writes only on real progress, at most once a minute, with one write in flight", async () => {
    vi.useFakeTimers();
    let resolveWrite!: (value: object) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { resolveWrite = resolve; }));
    const progress = createAssistantQuestionProgress(db, logger, "synthetic-question", principal);
    progress.touch(); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).not.toHaveBeenCalled(); // elapsed time alone is not activity
    progress.touch(); progress.touch();
    expect(execute).toHaveBeenCalledExactlyOnceWith(["synthetic-question", "synthetic-subject", "synthetic-session"]);
    await vi.advanceTimersByTimeAsync(120_000); progress.touch();
    expect(execute).toHaveBeenCalledOnce();
    resolveWrite({}); await vi.advanceTimersByTimeAsync(0);
    progress.touch(); expect(execute).toHaveBeenCalledTimes(2);
    progress.dispose(); await vi.advanceTimersByTimeAsync(60_000); progress.touch();
    expect(execute).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not block or leak provider details when progress persistence fails", async () => {
    vi.useFakeTimers();
    execute.mockRejectedValueOnce(new Error("private-connection-details"));
    const missing = createAssistantQuestionProgress(db, logger, undefined, principal);
    const progress = createAssistantQuestionProgress(db, logger, "synthetic-question", principal);
    await vi.advanceTimersByTimeAsync(60_000); missing.touch(); progress.touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ code: "AI_QUESTION_PROGRESS_FAILED" }, "Assistant question progress telemetry unavailable");
    await vi.advanceTimersByTimeAsync(60_000); progress.touch(); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2); progress.dispose(); missing.dispose();
  });

  it("records durations longer than ten minutes and bounds integer overflow", async () => {
    vi.useFakeTimers(); vi.setSystemTime(3_000_000_000);
    await finishAssistantQuestion(db, logger, "synthetic-question", principal, "ANSWERED", null, new Set(), Date.now() - 900_000);
    expect(execute.mock.calls.at(-1)?.[0].at(-1)).toBe(900_000);
    await finishAssistantQuestion(db, logger, "synthetic-question", principal, "ANSWERED", null, new Set(), 0);
    expect(execute.mock.calls.at(-1)?.[0].at(-1)).toBe(2_147_483_647);
  });
});
