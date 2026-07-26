import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Copy, KeyRound, RefreshCw, RotateCw, ShieldOff, Trash2 } from "lucide-react";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { ClientCommandMetadata, CommandRequest, PendingTokenCommand, RetainedTokenSecret, TokenDto, TrackedCommandState } from "../types";
import { CommandDialog, EmptyState, formatDateTime, InlineError, LoadingBlock, Modal, StatusBadge, type CommandDialogProgress } from "../ui";

export const TOKEN_SECRET_BYTES = 32;
export type TokenLifecycleStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "ROTATED";

export function generateTokenSecret(fillRandomBytes: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = fillRandomBytes(new Uint8Array(TOKEN_SECRET_BYTES));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_SECRET_BYTES) {
    throw new RangeError(`Token secret entropy must contain exactly ${TOKEN_SECRET_BYTES} bytes`);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `qtp_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function tokenLifecycleStatus(token: TokenDto, now = new Date()): TokenLifecycleStatus {
  if (token.replaced_by_id) return "ROTATED";
  if (token.revoked_at) return "REVOKED";
  if (new Date(token.expires_at).getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

type NewRetainedTokenSecret = Pick<RetainedTokenSecret, "propertyId" | "operation" | "label" | "value">;

export function updateMatchingRetainedSecret(
  current: RetainedTokenSecret | undefined,
  operationId: string,
  patch: Partial<Omit<RetainedTokenSecret, "operationId">>
): RetainedTokenSecret | undefined {
  return current?.operationId === operationId ? { ...current, ...patch } : current;
}

export function updateMatchingRetainedSecretForAttempt(
  current: RetainedTokenSecret | undefined,
  operationId: string,
  activeAttemptId: string | undefined,
  progressAttemptId: string,
  patch: Partial<Omit<RetainedTokenSecret, "operationId">>
): RetainedTokenSecret | undefined {
  if (activeAttemptId !== progressAttemptId) return current;
  return updateMatchingRetainedSecret(current, operationId, patch);
}

export function retainedTokenCommandUnresolved(secret: RetainedTokenSecret): boolean {
  return trackedCommandUnresolved(secret.state);
}

function trackedCommandUnresolved(state: TrackedCommandState): boolean {
  return state === "PREVIEWING" || state === "PREVIEW_UNKNOWN" || state === "PREVIEWED" || state === "CONFIRMING" || state === "UNKNOWN";
}

interface TrackedCommandPatch {
  state: TrackedCommandState;
  previewMetadata?: ClientCommandMetadata;
  previewId?: string;
  confirmationKey?: string;
}

interface TokenCommandDialogState {
  request: CommandRequest;
  operationId: string;
  attemptId: string;
  initialPreviewMetadata?: ClientCommandMetadata;
  initialConfirmationKey?: string;
}

function trackedPatch(progress: CommandDialogProgress): TrackedCommandPatch {
  if (progress.state === "PREVIEWING") return { state: "PREVIEWING", previewMetadata: progress.previewMetadata };
  if (progress.state === "PREVIEW_UNKNOWN") return { state: "PREVIEW_UNKNOWN", previewMetadata: progress.previewMetadata };
  if (progress.state === "PREVIEW_FAILED") return { state: "NOT_EXECUTED", previewMetadata: progress.previewMetadata };
  if (progress.state === "PREVIEWED") {
    return { state: "PREVIEWED", previewMetadata: progress.previewMetadata, previewId: progress.previewId };
  }
  if (progress.state === "CONFIRMING") {
    return { state: "CONFIRMING", previewId: progress.previewId, confirmationKey: progress.confirmationKey };
  }
  if (progress.state === "FAILED_NOT_EXECUTED") return { state: "NOT_EXECUTED", confirmationKey: progress.confirmationKey };
  if (progress.state === "UNKNOWN") return { state: "UNKNOWN", confirmationKey: progress.confirmationKey };
  return {
    state: progress.receipt.businessCommitted ? "EXECUTED" : "NOT_EXECUTED",
    confirmationKey: progress.confirmationKey
  };
}

function toLocalDateTimeInput(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultExpiration(): string {
  return toLocalDateTimeInput(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
}

function SecretValue({ value }: { value: string }) {
  const [copyStatus, setCopyStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请手动保存");
    }
  }

  return (
    <div className="token-secret-value">
      <label>一次性 Token secret
        <input value={value} readOnly spellCheck={false} autoComplete="off" />
      </label>
      <button className="button button-secondary" type="button" onClick={() => void copy()}><Copy aria-hidden="true" size={16} />复制</button>
      <span className="sr-status" aria-live="polite">{copyStatus}</span>
    </div>
  );
}

function TokenSecretDialog({ operation, token, accessGrant, onClose, onSubmit }: {
  operation: "ISSUE" | "ROTATE";
  token?: TokenDto;
  accessGrant: "READ" | "WRITE";
  onClose: () => void;
  onSubmit: (request: CommandRequest, retained: NewRetainedTokenSecret) => void;
}) {
  const { principal, propertyId } = useWorkspace();
  const [label, setLabel] = useState(token?.label ?? "External agent");
  const [accessCeiling, setAccessCeiling] = useState<"READ" | "WRITE">(token?.access_ceiling ?? "READ");
  const [expiresAt, setExpiresAt] = useState(() => token ? toLocalDateTimeInput(token.expires_at) : defaultExpiration());
  const [secret] = useState(() => generateTokenSecret());
  const [saved, setSaved] = useState(false);
  const [validationError, setValidationError] = useState<unknown>();
  const isIssue = operation === "ISSUE";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    if (!saved) {
      setValidationError(new Error("请先确认已安全保存一次性 secret"));
      return;
    }
    if (isIssue && !label.trim()) {
      setValidationError(new Error("请填写 Token 标签"));
      return;
    }
    if (!isIssue && !token) {
      setValidationError(new Error("轮换目标 Token 不存在"));
      return;
    }
    const expiration = new Date(expiresAt);
    if (Number.isNaN(expiration.getTime()) || expiration.getTime() <= Date.now()) {
      setValidationError(new Error("Token 过期时间必须晚于当前时间"));
      return;
    }
    const request: CommandRequest = isIssue ? {
      commandType: "ISSUE_TOKEN",
      title: "签发外围客户端 Token",
      description: "服务端仅持久化 secret 的 SHA-256 哈希；Preview 与 Receipt 均不会返回明文 secret。",
      input: {
        propertyId,
        subjectId: principal.subjectId,
        label: label.trim(),
        accessCeiling,
        expiresAt: expiration.toISOString(),
        tokenSecret: secret
      }
    } : {
      commandType: "ROTATE_TOKEN",
      title: `轮换 Token · ${token?.label ?? ""}`,
      description: "确认后旧 Token 立即撤销并形成轮换链；服务端仅持久化新 secret 的哈希。",
      input: {
        propertyId,
        tokenId: token!.id,
        expiresAt: expiration.toISOString(),
        tokenSecret: secret
      }
    };
    onSubmit(request, {
      propertyId,
      operation,
      label: isIssue ? label.trim() : token!.label,
      value: secret
    });
  }

  return (
    <Modal title={isIssue ? "签发 Token" : "轮换 Token"} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <InlineError error={validationError} title="无法继续" />
        <div className="form-grid">
          {isIssue ? <label htmlFor="token-label">标签<input id="token-label" value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={200} /></label> : (
            <dl className="token-operation-context"><div><dt>旧 Token</dt><dd><code>{token?.id}</code></dd></div><div><dt>标签</dt><dd>{token?.label}</dd></div></dl>
          )}
          {isIssue ? <label htmlFor="token-access-ceiling">权限上限
            <select id="token-access-ceiling" value={accessCeiling} onChange={(event) => setAccessCeiling(event.target.value as "READ" | "WRITE")}>
              <option value="READ">READ</option>
              {accessGrant === "WRITE" ? <option value="WRITE">WRITE</option> : null}
            </select>
          </label> : null}
          <label htmlFor="token-expires-at">过期时间<input id="token-expires-at" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></label>
          <SecretValue value={secret} />
          <label className="token-saved-confirmation"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} required /><span>我已将一次性 secret 安全保存；关闭后服务端无法找回。</span></label>
        </div>
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={!saved}>继续生成 Preview</button></div>
      </form>
    </Modal>
  );
}

function RetainedSecretPanel({ secret, onClear, onRecover }: {
  secret: RetainedTokenSecret;
  onClear: () => void;
  onRecover: () => void;
}) {
  const unresolved = retainedTokenCommandUnresolved(secret);
  const stateText: Record<RetainedTokenSecret["state"], string> = {
    LOCAL_ONLY: "命令尚未确认；请勿生成另一个 secret。",
    PREVIEWING: "Preview 请求已发送，正在等待服务端结果。",
    PREVIEW_UNKNOWN: "Preview 响应中断；必须复用原幂等键重试。",
    PREVIEWED: "Preview 已生成但尚未 Confirm。",
    CONFIRMING: "Confirm 已发送，正在等待服务端结果。",
    UNKNOWN: "响应中断；必须使用原幂等键恢复结果。",
    EXECUTED: "命令已提交；请确认外围客户端已保存后再清除。",
    NOT_EXECUTED: "服务端确认命令未执行，可以清除或重新开始。"
  };
  return (
    <section className="retained-secret-panel" aria-labelledby="retained-secret-heading">
      <div className="retained-secret-heading"><KeyRound aria-hidden="true" size={20} /><div><h2 id="retained-secret-heading">尚未清除的一次性 secret</h2><p>{stateText[secret.state]}</p></div></div>
      <dl className="retained-secret-meta"><div><dt>操作</dt><dd>{secret.operation}</dd></div><div><dt>状态</dt><dd><StatusBadge value={secret.state} /></dd></div><div><dt>标签</dt><dd>{secret.label}</dd></div><div><dt>物业</dt><dd><code>{secret.propertyId}</code></dd></div>{secret.previewId ? <div><dt>Preview</dt><dd><code>{secret.previewId}</code></dd></div> : null}</dl>
      <SecretValue value={secret.value} />
      {unresolved && (secret.confirmationKey || secret.previewMetadata) ? <button className="button button-secondary" type="button" onClick={onRecover}><RefreshCw aria-hidden="true" size={16} />{secret.confirmationKey ? "恢复命令结果" : "重试 Preview"}</button> : null}
      <button className="button button-danger" type="button" onClick={onClear} disabled={unresolved}><Trash2 aria-hidden="true" size={16} />清除本地 secret</button>
    </section>
  );
}

function PendingTokenCommandPanel({ pending, onRecover, onClear }: {
  pending: PendingTokenCommand;
  onRecover: () => void;
  onClear: () => void;
}) {
  const unresolved = trackedCommandUnresolved(pending.state);
  return (
    <section className="retained-secret-panel" aria-labelledby="pending-token-command-heading">
      <div className="retained-secret-heading"><ShieldOff aria-hidden="true" size={20} /><div><h2 id="pending-token-command-heading">待处理 Token 命令</h2><p>关闭弹窗不会丢失 Preview 或 Confirm 的恢复身份。</p></div></div>
      <dl className="retained-secret-meta"><div><dt>命令</dt><dd>{pending.request.commandType}</dd></div><div><dt>状态</dt><dd><StatusBadge value={pending.state} /></dd></div>{pending.previewId ? <div><dt>Preview</dt><dd><code>{pending.previewId}</code></dd></div> : null}</dl>
      {unresolved && (pending.confirmationKey || pending.previewMetadata) ? <button className="button button-secondary" type="button" onClick={onRecover}><RefreshCw aria-hidden="true" size={16} />{pending.confirmationKey ? "恢复命令结果" : "重试 Preview"}</button> : null}
      <button className="button button-secondary" type="button" onClick={onClear} disabled={unresolved}>清除已解析命令</button>
    </section>
  );
}

export function TokensPage() {
  const {
    principal,
    propertyId,
    retainedTokenSecret,
    setRetainedTokenSecret,
    pendingTokenCommand,
    setPendingTokenCommand
  } = useWorkspace();
  const [tokens, setTokens] = useState<TokenDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [secretAction, setSecretAction] = useState<{ operation: "ISSUE" | "ROTATE"; token?: TokenDto }>();
  const [command, setCommand] = useState<TokenCommandDialogState>();
  const activeCommandAttemptRef = useRef<string | undefined>(undefined);
  const accessGrant = principal.propertyAccess[propertyId] ?? "READ";
  const canWrite = accessGrant === "WRITE";

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    setTokens([]);
    api.tokens(propertyId)
      .then((response) => current && setTokens(response.tokens))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [propertyId, refreshToken]);

  useEffect(() => () => {
    activeCommandAttemptRef.current = undefined;
  }, []);

  const counts = useMemo(() => tokens.reduce<Record<TokenLifecycleStatus, number>>((result, token) => {
    result[tokenLifecycleStatus(token)] += 1;
    return result;
  }, { ACTIVE: 0, EXPIRED: 0, REVOKED: 0, ROTATED: 0 }), [tokens]);

  function openCommand(nextCommand: Omit<TokenCommandDialogState, "attemptId">) {
    const attemptId = crypto.randomUUID();
    activeCommandAttemptRef.current = attemptId;
    setCommand({ ...nextCommand, attemptId });
  }

  function closeCommand(attemptId: string) {
    if (activeCommandAttemptRef.current !== attemptId) return;
    activeCommandAttemptRef.current = undefined;
    setCommand(undefined);
  }

  function submitSecretCommand(request: CommandRequest, retained: NewRetainedTokenSecret) {
    const operationId = crypto.randomUUID();
    setRetainedTokenSecret({ ...retained, operationId, command: request, state: "LOCAL_ONLY" });
    setSecretAction(undefined);
    openCommand({ request, operationId });
  }

  function applySecretProgress(operationId: string, attemptId: string, progress: CommandDialogProgress) {
    if (activeCommandAttemptRef.current !== attemptId) return;
    const patch = trackedPatch(progress);
    setRetainedTokenSecret((current) => updateMatchingRetainedSecretForAttempt(
      current,
      operationId,
      activeCommandAttemptRef.current,
      attemptId,
      patch
    ));
    setPendingTokenCommand((current) => (
      activeCommandAttemptRef.current === attemptId && current?.operationId === operationId ? { ...current, ...patch } : current
    ));
    if (progress.state === "RESOLVED" && progress.receipt.businessCommitted) {
      setRefreshToken((value) => value + 1);
    }
  }

  function recoverRetainedSecret() {
    if (!retainedTokenSecret || (!retainedTokenSecret.confirmationKey && !retainedTokenSecret.previewMetadata)) return;
    openCommand({
      request: retainedTokenSecret.command,
      operationId: retainedTokenSecret.operationId,
      ...(retainedTokenSecret.previewMetadata ? { initialPreviewMetadata: retainedTokenSecret.previewMetadata } : {}),
      ...(retainedTokenSecret.confirmationKey ? { initialConfirmationKey: retainedTokenSecret.confirmationKey } : {})
    });
  }

  function recoverPendingTokenCommand() {
    if (!pendingTokenCommand || (!pendingTokenCommand.confirmationKey && !pendingTokenCommand.previewMetadata)) return;
    openCommand({
      request: pendingTokenCommand.request,
      operationId: pendingTokenCommand.operationId,
      ...(pendingTokenCommand.previewMetadata ? { initialPreviewMetadata: pendingTokenCommand.previewMetadata } : {}),
      ...(pendingTokenCommand.confirmationKey ? { initialConfirmationKey: pendingTokenCommand.confirmationKey } : {})
    });
  }

  function revoke(token: TokenDto) {
    const operationId = crypto.randomUUID();
    const request: CommandRequest = {
      commandType: "REVOKE_TOKEN",
      title: `撤销 Token · ${token.label}`,
      description: "确认后该 Token 立即失效；撤销事实及 Receipt 将永久保留。",
      input: { propertyId, tokenId: token.id }
    };
    setPendingTokenCommand({ operationId, request, state: "LOCAL_ONLY" });
    openCommand({ request, operationId });
  }

  return (
    <div className="tokens-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">外部系统接入</p><h1>Token 生命周期</h1><p>当前主体的物业范围 Token、权限上限与轮换链</p></div>
        <div className="token-page-actions"><button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新</button><button className="button button-primary" type="button" onClick={() => setSecretAction({ operation: "ISSUE" })} disabled={!canWrite || loading || Boolean(error) || Boolean(retainedTokenSecret) || Boolean(pendingTokenCommand)}><KeyRound aria-hidden="true" size={17} />签发 Token</button></div>
      </header>

      {retainedTokenSecret ? <RetainedSecretPanel secret={retainedTokenSecret} onClear={() => setRetainedTokenSecret(undefined)} onRecover={recoverRetainedSecret} /> : null}
      {pendingTokenCommand ? <PendingTokenCommandPanel pending={pendingTokenCommand} onRecover={recoverPendingTokenCommand} onClear={() => setPendingTokenCommand(undefined)} /> : null}
      {!canWrite ? <div className="token-readonly-notice"><ShieldOff aria-hidden="true" size={18} /><p>当前主体在该物业只有 READ 权限，可以查看 Token，但不能签发、轮换或撤销。</p></div> : null}

      <section className="token-principal-band" aria-label="Token 主体与状态汇总">
        <div><span>真实主体</span><strong>{principal.displayName}</strong><code>{principal.subjectId}</code></div>
        <div><span>物业授权</span><StatusBadge value={accessGrant} /></div>
        <div className="token-counts"><span>ACTIVE {counts.ACTIVE}</span><span>EXPIRED {counts.EXPIRED}</span><span>REVOKED {counts.REVOKED}</span><span>ROTATED {counts.ROTATED}</span></div>
      </section>

      <InlineError error={error} title="无法载入 Token" />
      {loading ? <LoadingBlock label="正在载入 Token" /> : error ? null : tokens.length ? (
        <div className="table-region token-table-region" role="region" aria-label="当前主体 Token" tabIndex={0}>
          <table className="data-table token-table">
            <thead><tr><th scope="col">Token / 标签</th><th scope="col">权限</th><th scope="col">状态</th><th scope="col">过期时间</th><th scope="col">轮换链</th><th scope="col">操作</th></tr></thead>
            <tbody>{tokens.map((token) => {
              const status = tokenLifecycleStatus(token);
              const revoked = status === "REVOKED" || status === "ROTATED";
              return <tr key={token.id}>
                <th scope="row"><strong>{token.label}</strong><code>{token.id}</code><small>{formatDateTime(token.created_at)}</small></th>
                <td><StatusBadge value={token.access_ceiling} /></td>
                <td><StatusBadge value={status} />{token.revoked_at ? <small>{formatDateTime(token.revoked_at)}</small> : null}</td>
                <td>{formatDateTime(token.expires_at)}</td>
                <td className="token-chain"><span>来自 <code>{token.rotated_from_id ?? "-"}</code></span><span>替换为 <code>{token.replaced_by_id ?? "-"}</code></span></td>
                <td><div className="row-actions"><button className="button button-compact button-secondary" type="button" onClick={() => setSecretAction({ operation: "ROTATE", token })} disabled={!canWrite || revoked || Boolean(retainedTokenSecret) || Boolean(pendingTokenCommand)}><RotateCw aria-hidden="true" size={16} />轮换</button><button className="icon-button danger-icon" type="button" onClick={() => revoke(token)} disabled={!canWrite || revoked || Boolean(retainedTokenSecret) || Boolean(pendingTokenCommand)} aria-label={`撤销 Token ${token.id}`} title="撤销"><ShieldOff aria-hidden="true" size={17} /></button></div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      ) : <EmptyState title="当前主体没有 Token" detail="签发第一个受物业和主体授权收窄的外围客户端 Token。" />}

      {secretAction ? <TokenSecretDialog operation={secretAction.operation} {...(secretAction.token ? { token: secretAction.token } : {})} accessGrant={accessGrant} onClose={() => setSecretAction(undefined)} onSubmit={submitSecretCommand} /> : null}
      {command ? <CommandDialog
        request={command.request}
        onClose={() => closeCommand(command.attemptId)}
        {...(command.initialPreviewMetadata ? { initialPreviewMetadata: command.initialPreviewMetadata } : {})}
        {...(command.initialConfirmationKey ? { initialConfirmationKey: command.initialConfirmationKey } : {})}
        onProgress={(progress: CommandDialogProgress) => applySecretProgress(command.operationId, command.attemptId, progress)}
      /> : null}
    </div>
  );
}
