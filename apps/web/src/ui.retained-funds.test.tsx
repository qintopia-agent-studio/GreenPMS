import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { CommandType, PreviewDto, ReceiptDto } from "@qintopia/contracts";
import type { CommandRequest } from "./types";

// Run only CommandDialog's hooks; child rendering uses React's normal SSR dispatcher.
// This exercises its real effects and button handlers without installing a browser runtime.
const hooks = vi.hoisted(() => ({ active: false, cursor: 0, slots: [] as any[], effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  return { ...actual,
    useState(initial: any) {
      if (!hooks.active) return actual.useState(initial);
      const i = hooks.cursor++;
      hooks.slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks.slots[i].value, (value: any) => { hooks.slots[i].value = typeof value === "function" ? value(hooks.slots[i].value) : value; }];
    },
    useRef(initial: any) {
      if (!hooks.active) return actual.useRef(initial);
      const i = hooks.cursor++;
      return hooks.slots[i] ??= { current: initial };
    },
    useMemo(fn: () => any, deps: readonly unknown[]) {
      if (!hooks.active) return actual.useMemo(fn, deps);
      const i = hooks.cursor++;
      if (!sameDeps(hooks.slots[i]?.deps, deps)) hooks.slots[i] = { deps, value: fn() };
      return hooks.slots[i].value;
    },
    useEffect(fn: () => any, deps?: readonly unknown[]) {
      if (!hooks.active) return actual.useEffect(fn, deps);
      const i = hooks.cursor++;
      if (sameDeps(hooks.slots[i]?.deps, deps)) return;
      const previous = hooks.slots[i];
      hooks.slots[i] = { deps };
      hooks.effects.push(() => { previous?.cleanup?.(); hooks.slots[i].cleanup = fn(); });
    }
  };
});
import { api, ApiError } from "./api";
import { CommandDialog, CommandRecoveryBar, ReceiptPanel, commandCapabilityBusinessLabels, fundsCommandCanReturnToEdit, recoveryCommandRequest, type PersistedCommandRecovery } from "./ui";

const commands = ["RETAIN_ORDER_FUNDS", "APPLY_RETAINED_FUNDS", "RELEASE_RETAINED_FUNDS", "REFUND_RETAINED_FUNDS"] as const;
function requestFor(commandType: typeof commands[number]): CommandRequest {
  return { commandType, title: commandCapabilityBusinessLabels[commandType], description: "仅处理现有资金归属。",
    input: { propertyId: "property_1", orderId: "order_1", amountMinor: 60000,
      ...(commandType === "RETAIN_ORDER_FUNDS" ? { sourceFactId: "source_1", ownerName: "留存客户", ownerContact: "核验联系方式", confirmationNote: "客户确认下次使用" }
        : { retainedFundId: "retained_1", ...(commandType === "APPLY_RETAINED_FUNDS" ? { authorizationNote: "归属人授权本订单使用" } : { note: "客户确认处理" }) }),
      ...(commandType === "REFUND_RETAINED_FUNDS" ? { externalPaymentBillId: "bill_1", refundReference: "refund_1" } : {}) }
  };
}
function previewFor(request: CommandRequest): PreviewDto {
  return { previewId: "preview_1", commandType: request.commandType as CommandType, expiresAt: new Date(Date.now() + 60000).toISOString(),
    effectHash: "a".repeat(64), effect: { operation: request.commandType, ...request.input }, warnings: [] } as PreviewDto;
}
function receiptFor(commandType: CommandType): ReceiptDto {
  return { receiptId: "receipt_1", commandId: "command_1", correlationId: "correlation_1", committedAt: "2026-10-02T00:00:00Z",
    executionStatus: "EXECUTED", businessCommitted: true, resourceRefs: ["order_1", "retained_1"], factRefs: [],
    result: { operation: commandType, orderId: "order_1", retainedFundId: "retained_1", amountMinor: 60000, remainingMinor: 20000 } };
}
function recoveryFor(commandType: CommandType): PersistedCommandRecovery {
  return { version: 1, propertyId: "property_1", commandType, confirmationKey: "original_key", targetRefs: ["order_1"],
    state: "UNKNOWN", updatedAt: "2026-10-02T00:00:00Z" } as PersistedCommandRecovery;
}
function walk(node: ReactNode, predicate: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) return node.map(n => walk(n, predicate)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<any>;
  return predicate(element) ? element : walk(element.props.children, predicate) ?? walk(element.props.footer, predicate);
}
const markup = (tree: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, tree));
function mount(props: Parameters<typeof CommandDialog>[0]) {
  let tree: ReactElement;
  const render = () => {
    hooks.cursor = 0; hooks.active = true;
    try { tree = CommandDialog(props); } finally { hooks.active = false; }
    const pending = hooks.effects.splice(0); pending.forEach(effect => effect());
    return tree;
  };
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } return tree!; };
  render();
  return { render, settle, button: (id: string) => walk(tree!, element => element.props["data-testid"] === id),
    clickText: (text: string) => {
      const button = walk(tree!, element => element.type === "button" && markup(element).includes(text));
      expect(button, text).toBeDefined(); button!.props.onClick();
    } };
}
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.spyOn(api, "commandMetadata").mockReturnValue({ idempotencyKey: "preview_key", correlationId: "preview_correlation" });
  vi.spyOn(api, "recoveryKey").mockReturnValue("confirmation_key");
});
afterEach(() => { hooks.slots.forEach(slot => slot?.cleanup?.()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(commands)("%s retained funds command shell", (command) => {
  it("automatically previews the original input and enables only explicit staff confirmation with the retained summary", async () => {
    const request = requestFor(command);
    const preview = vi.spyOn(api, "preview").mockResolvedValue({ preview: previewFor(request), receipt: receiptFor(command) });
    const confirm = vi.spyOn(api, "confirm").mockResolvedValue(receiptFor(command));
    const onCommitted = vi.fn();
    const dialog = mount({ request, onClose: vi.fn(), onCommitted });
    const html = markup(await dialog.settle());
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]![0]).toEqual({ commandType: command, input: request.input });
    expect(confirm).not.toHaveBeenCalled();
    expect(html).toContain(`请核对${request.title}`);
    expect(html).not.toContain("生成服务端预览");
    expect(html).not.toContain("本次会员操作");
    expect(html).not.toContain("reason-heading");
    if (command === "REFUND_RETAINED_FUNDS") expect(html).toContain("refund_1");
    const button = dialog.button("confirm-command")!;
    expect(button.props.disabled).toBe(false);
    expect(markup(button)).toContain(`确认${request.title}`);
    button.props.onClick();
    const resultHtml = markup(await dialog.settle());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]!.slice(0, 4)).toEqual(["preview_1", "property_1", command, "a".repeat(64)]);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(resultHtml).toContain(`${request.title}已完成`);
    expect(resultHtml).toContain("留存余额");
    expect(resultHtml).not.toContain("会员");
    expect(dialog.button("confirm-command")).toBeUndefined();
  });
  it("keeps an uncertain confirmation on the original-key recovery path, never sending another preview or confirmation", async () => {
    const request = requestFor(command);
    const preview = vi.spyOn(api, "preview").mockResolvedValue({ preview: previewFor(request), receipt: receiptFor(command) });
    const confirm = vi.spyOn(api, "confirm").mockRejectedValue(new Error("network lost"));
    const resolve = vi.spyOn(api, "resolveCommandResult").mockResolvedValue(receiptFor(command));
    const dialog = mount({ request, onClose: vi.fn() });
    await dialog.settle(); dialog.button("confirm-command")!.props.onClick();
    const uncertainHtml = markup(await dialog.settle());
    expect(uncertainHtml).toContain(`${request.title}结果需要查询`);
    expect(uncertainHtml).toContain("不会重复写入留存或订单资金记录");
    expect(dialog.button("confirm-command")).toBeUndefined();
    dialog.clickText(`查询${request.title}结果`);
    const recoveredHtml = markup(await dialog.settle());
    expect(resolve.mock.calls[0]!.slice(0, 3)).toEqual(["property_1", command, "confirmation_key"]);
    expect(recoveredHtml).toContain(`${request.title}已完成`);
    expect(recoveredHtml).toContain("没有重复写入留存或订单资金记录");
    expect(preview).toHaveBeenCalledTimes(1); expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("restores a persisted operation as query-only and gives the recovery bar business labels", async () => {
    const recovery = recoveryFor(command);
    const request = recoveryCommandRequest(recovery);
    expect(request.title).toBe(`查询${commandCapabilityBusinessLabels[command]}结果`);
    const preview = vi.spyOn(api, "preview"); const confirm = vi.spyOn(api, "confirm");
    const resolve = vi.spyOn(api, "resolveCommandResult").mockResolvedValue(receiptFor(command));
    const dialog = mount({ request, initialConfirmationKey: recovery.confirmationKey, onClose: vi.fn() });
    await dialog.settle(); dialog.clickText(`查询${commandCapabilityBusinessLabels[command]}结果`); await dialog.settle();
    expect(resolve.mock.calls[0]!.slice(0, 3)).toEqual(["property_1", command, "original_key"]);
    expect(preview).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    const html = markup(<CommandRecoveryBar recovery={recovery} onOpen={vi.fn()}/>);
    expect(html).toContain(`${commandCapabilityBusinessLabels[command]}结果需要恢复查询`);
    expect(html).not.toContain(command); expect(html).not.toContain("原命令");
  });
  it("respects blocked writes and pre-send editor safety", async () => {
    const preview = vi.spyOn(api, "preview"); const confirm = vi.spyOn(api, "confirm");
    const dialog = mount({ request: requestFor(command), onClose: vi.fn(), writeBlocked: true });
    await dialog.settle(); expect(preview).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    const flags = { commandType: command, hasEditor: true, busy: false, recoveryOnly: false, networkUncertain: false, hasConfirmationKey: false, hasReceipt: false };
    expect(fundsCommandCanReturnToEdit(flags)).toBe(true);
    for (const flag of ["busy", "recoveryOnly", "networkUncertain", "hasConfirmationKey", "hasReceipt"] as const)
      expect(fundsCommandCanReturnToEdit({ ...flags, [flag]: true })).toBe(false);
  });
  it("requires a new review when the server preview has expired", async () => {
    const request = requestFor(command);
    vi.spyOn(api, "preview").mockResolvedValue({ preview: { ...previewFor(request), expiresAt: new Date(Date.now() - 1000).toISOString() }, receipt: receiptFor(command) });
    const confirm = vi.spyOn(api, "confirm");
    const dialog = mount({ request, onClose: vi.fn() });
    const html = markup(await dialog.settle());
    expect(html).toContain("核对已失效"); expect(html).toContain("重新载入核对信息");
    expect(dialog.button("confirm-command")).toBeUndefined(); expect(confirm).not.toHaveBeenCalled();
  });
  it("returns the preserved draft only before submission when an editor is provided", async () => {
    const request = requestFor(command);
    vi.spyOn(api, "preview").mockResolvedValue({ preview: previewFor(request), receipt: receiptFor(command) });
    const confirm = vi.spyOn(api, "confirm"); const onClose = vi.fn(); const onReturnToEdit = vi.fn();
    const dialog = mount({ request, onClose, onReturnToEdit });
    await dialog.settle();
    dialog.button("command-return-to-edit")!.props.onClick(); await dialog.settle();
    expect(onClose).toHaveBeenCalledTimes(1); expect(onReturnToEdit).toHaveBeenCalledTimes(1);
    const draft = onReturnToEdit.mock.calls[0]![0] as CommandRequest;
    expect(draft.input).toEqual(request.input); expect(draft.commandType).toBe(command);
    expect(draft.initialReason?.code).toBe(command); expect(confirm).not.toHaveBeenCalled();
  });
  it("describes not-executed receipts without asserting successful funds changes", () => {
    const { result: _result, ...identity } = receiptFor(command);
    const receipt: ReceiptDto = { ...identity, businessCommitted: false, executionStatus: "NOT_EXECUTED",
      error: { code: "VALIDATION_ERROR", message: "本次余额不足，请重新核对。", correlationId: "correlation_1", retryable: false } };
    const html = markup(<ReceiptPanel receipt={receipt} businessCommand={command}/>);
    expect(html).toContain(`${commandCapabilityBusinessLabels[command]}未执行`);
    expect(html).toContain("没有写入留存或订单资金记录"); expect(html).not.toContain("留存余额");
  });
});

it("preserves deterministic preview failure and prevents confirmation without a preview", async () => {
  vi.spyOn(api, "preview").mockRejectedValue(new ApiError(409, { code: "FUNDS_CONFLICT", message: "留存余额不足", correlationId: "c", retryable: false }));
  const confirm = vi.spyOn(api, "confirm");
  const dialog = mount({ request: requestFor("APPLY_RETAINED_FUNDS"), onClose: vi.fn() });
  const html = markup(await dialog.settle());
  expect(html).toContain("填写内容需要修改"); expect(dialog.button("confirm-command")).toBeUndefined(); expect(confirm).not.toHaveBeenCalled();
});

it("does not start an automatic preview when the recovery coordinator denies the lease", async () => {
  const preview = vi.spyOn(api, "preview"); const confirm = vi.spyOn(api, "confirm");
  const dialog = mount({ request: requestFor("RETAIN_ORDER_FUNDS"), onClose: vi.fn(), onProgress: () => false });
  const html = markup(await dialog.settle());
  expect(html).toContain("本次核对尚未开始"); expect(preview).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});
