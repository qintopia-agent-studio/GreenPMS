import { DomainError, type CommandType } from "@qintopia/contracts";
import { sha256 } from "@qintopia/domain";

// Only errors for which PostgreSQL has explicitly aborted the transaction are
// retryable here. Transport failures may have an unknown commit outcome.
const retryableSqlStates = new Set(["40001", "40P01", "55P03", "57014"]);

export function classifyTransactionFailure(error: unknown) {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const sqlState = typeof fields.code === "string" && /^[0-9A-Z]{5}$/.test(fields.code) ? fields.code : undefined;
  const constraint = sqlState?.startsWith("23") && typeof fields.constraint === "string"
    && /^[a-z][a-z0-9_]{0,62}$/.test(fields.constraint) ? fields.constraint : undefined;
  const retryable = sqlState !== undefined && retryableSqlStates.has(sqlState);
  return {
    diagnostic: { sqlState, constraint, category: retryable ? "TRANSIENT" : sqlState?.startsWith("23") ? "CONSTRAINT" : "UNEXPECTED" },
    rejection: new DomainError("COMMAND_INTERRUPTED", retryable
      ? "数据库事务暂时中断；请刷新预览后重试"
      : "操作未完成，请联系管理员核查；请勿反复提交", 409, retryable)
  };
}

export function reportTransactionFailure(error: unknown, context: { commandType: CommandType; previewId: string; correlationId: string }) {
  const classified = classifyTransactionFailure(error);
  // Allowlisted metadata only: never serialize the exception, SQL, parameters,
  // detail, stack or caller-controlled correlation text (which could contain PII).
  console.error(JSON.stringify({ event: "COMMAND_TRANSACTION_FAILED", commandType: context.commandType,
    previewId: context.previewId, correlationHash: sha256(context.correlationId),
    ...classified.diagnostic, retryable: classified.rejection.retryable }));
  return classified.rejection;
}
