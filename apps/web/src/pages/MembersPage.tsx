import { useEffect, useState, type FormEvent } from "react";
import { BadgeCheck, CircleDollarSign, CreditCard, PencilLine, RefreshCw, Search, UserPlus } from "lucide-react";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { CommandRequest, MemberContractDto, MemberSummaryDto, MemberViewDto, MembershipOrderSummaryDto, MembershipPaymentFactDto, MembershipProductDto } from "../types";
import {
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  CommandRecoveryBar,
  EmptyState,
  formatDate,
  formatMinor,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  Modal,
  recoveryCommandRequest,
  usePersistentCommandRecovery
} from "../ui";

export function effectiveMemberId(members: MemberSummaryDto[], requestedMemberId: string): string {
  return members.some((summary) => summary.member.id === requestedMemberId)
    ? requestedMemberId
    : members[0]?.member.id ?? "";
}

export function normalizeMemberQuery(query: string): string {
  return query.trim();
}

export function shouldClearMemberSearchAfterCommit(commandType: CommandRequest["commandType"]): boolean {
  return commandType === "CREATE_MEMBER";
}

export function formalEntitlementLotIds(membershipOrders: MembershipOrderSummaryDto[]): Set<string> {
  return new Set(membershipOrders.flatMap(({ order }) => order.entitlement_lot_id ? [order.entitlement_lot_id] : []));
}

export function yuanInputToMinor(value: string, wholeYuan = false): number | undefined {
  const normalized = value.trim();
  const pattern = wholeYuan ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(normalized)) return undefined;
  const [yuan, fraction = ""] = normalized.split(".");
  const minor = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor <= 2_147_483_647 ? minor : undefined;
}

export function parseEntitlementBalance(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : undefined;
}

export function isEntitlementLotActive(
  contract: Pick<MemberContractDto, "status" | "valid_from" | "valid_until"> | undefined,
  lotExpiresOn: string,
  asOfDate: string
): boolean {
  return contract?.status === "ACTIVE"
    && contract.valid_from <= asOfDate
    && contract.valid_until >= asOfDate
    && lotExpiresOn >= asOfDate;
}

function entitlementLabel(unitKind: "ROOM_NIGHT" | "BED_NIGHT", units: number): string {
  return `${units} ${unitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}`;
}

function productScopeLabel(product: Pick<MembershipProductDto, "code">): string {
  if (product.code === "SHARED_BATH_SINGLE_30") return "公卫单人间";
  if (product.code === "PRIVATE_BATH_SINGLE_30") return "独卫单人间";
  return "公卫四人间单床";
}

function CreateMemberDialog({ propertyId, draft, onClose, onSubmit }: {
  propertyId: string;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [fullName, setFullName] = useState(() => typeof draft?.input.fullName === "string" ? draft.input.fullName : "");
  const [identityCardNumber, setIdentityCardNumber] = useState(() => typeof draft?.input.identityCardNumber === "string" ? draft.input.identityCardNumber : "");
  const [phone, setPhone] = useState(() => typeof draft?.input.phone === "string" ? draft.input.phone : "");
  const [wechat, setWechat] = useState(() => typeof draft?.input.wechat === "string" ? draft.input.wechat : "");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      commandType: "CREATE_MEMBER",
      title: "新建会员档案",
      description: "请核对会员资料。确认后将创建档案，并加入当前门店的会员列表。",
      input: {
        propertyId,
        fullName: fullName.trim(),
        identityCardNumber: identityCardNumber.trim().toUpperCase(),
        phone: phone.trim(),
        wechat: wechat.trim()
      }
    });
  }

  return <Modal title="新建会员" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <label htmlFor="member-full-name">姓名<input id="member-full-name" value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={200} autoFocus data-testid="member-full-name" autoComplete="name" /></label>
        <label htmlFor="member-identity-card">身份证号<input id="member-identity-card" value={identityCardNumber} onChange={(event) => setIdentityCardNumber(event.target.value)} required maxLength={200} data-testid="member-identity-card" autoComplete="off" /></label>
        <label htmlFor="member-phone">手机号<input id="member-phone" value={phone} onChange={(event) => setPhone(event.target.value)} required maxLength={200} inputMode="tel" autoComplete="tel" data-testid="member-phone" /></label>
        <label htmlFor="member-wechat">微信号<input id="member-wechat" value={wechat} onChange={(event) => setWechat(event.target.value)} required maxLength={200} autoComplete="off" data-testid="member-wechat" /></label>
      </div>
      <div className="form-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>取消</button>
        <button type="submit" className="button button-primary">核对并创建</button>
      </div>
    </form>
  </Modal>;
}

function CreateMembershipOrderDialog({ propertyId, member, products, draft, onClose, onSubmit }: {
  propertyId: string;
  member: MemberViewDto["member"];
  products: MembershipProductDto[];
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [productId, setProductId] = useState(() => typeof draft?.input.membershipProductId === "string" ? draft.input.membershipProductId : products[0]?.id ?? "");
  const selectedProduct = products.find((product) => product.id === productId) ?? products[0];
  const [agreedPriceYuan, setAgreedPriceYuan] = useState(() => typeof draft?.input.agreedPriceMinor === "number" ? String(draft.input.agreedPriceMinor / 100) : selectedProduct ? String(selectedProduct.list_price_minor / 100) : "");
  const [adjustmentReason, setAdjustmentReason] = useState(() => typeof draft?.input.priceAdjustmentReason === "string" ? draft.input.priceAdjustmentReason : "");
  const [validationError, setValidationError] = useState<string>();

  function selectProduct(nextId: string) {
    setProductId(nextId);
    const product = products.find((candidate) => candidate.id === nextId);
    setAgreedPriceYuan(product ? String(product.list_price_minor / 100) : "");
    setAdjustmentReason("");
    setValidationError(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct) return;
    const agreedPriceMinor = yuanInputToMinor(agreedPriceYuan, true);
    if (agreedPriceMinor === undefined) {
      setValidationError("成交价必须是非负人民币整数元");
      return;
    }
    if (agreedPriceMinor !== selectedProduct.list_price_minor && !adjustmentReason.trim()) {
      setValidationError("修改成交价时必须填写调价原因");
      return;
    }
    onSubmit({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      title: "创建会员订单",
      description: `为 ${member.full_name} 创建 ${selectedProduct.name}，确认后订单保持待生效。`,
      input: {
        propertyId,
        memberId: member.id,
        membershipProductId: selectedProduct.id,
        agreedPriceMinor,
        ...(agreedPriceMinor !== selectedProduct.list_price_minor ? { priceAdjustmentReason: adjustmentReason.trim() } : {})
      }
    });
  }

  return <Modal title="办理会员" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="span-two">会员产品<select value={productId} onChange={(event) => selectProduct(event.target.value)} required data-testid="membership-product">
          {products.map((product) => <option key={product.id} value={product.id}>{product.name} · {formatMinor(product.list_price_minor, product.currency)}</option>)}
        </select></label>
        {selectedProduct ? <div className="membership-product-summary span-two" aria-label="会员产品信息">
          <div><span>默认价</span><strong>{formatMinor(selectedProduct.list_price_minor, selectedProduct.currency)}</strong></div>
          <div><span>发放权益</span><strong>{entitlementLabel(selectedProduct.entitlement_unit_kind, selectedProduct.entitlement_units)}</strong></div>
          <div><span>适用范围</span><strong>{productScopeLabel(selectedProduct)}</strong></div>
          <div><span>有效期</span><strong>生效日起一年</strong></div>
        </div> : null}
        <label>实际成交价（人民币元）<input type="number" min="0" step="1" inputMode="numeric" value={agreedPriceYuan} onChange={(event) => { setAgreedPriceYuan(event.target.value); setValidationError(undefined); }} required data-testid="membership-agreed-price-yuan" /></label>
        {selectedProduct && yuanInputToMinor(agreedPriceYuan, true) !== selectedProduct.list_price_minor ? <label>调价原因<textarea rows={3} value={adjustmentReason} onChange={(event) => { setAdjustmentReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} data-testid="membership-price-adjustment-reason" /></label> : null}
      </div>
      {validationError ? <InlineError error={new Error(validationError)} /> : null}
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">核对会员订单</button></div>
    </form>
  </Modal>;
}

function MembershipPaymentDialog({ propertyId, summary, correction, draft, onClose, onSubmit }: {
  propertyId: string;
  summary: MembershipOrderSummaryDto;
  correction?: MembershipPaymentFactDto;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const draftAmount = draft?.commandType === "CORRECT_MEMBERSHIP_PAYMENT" ? draft.input.correctedAmountMinor : draft?.input.amountMinor;
  const draftReference = draft?.commandType === "CORRECT_MEMBERSHIP_PAYMENT" ? draft.input.correctedTransactionReference : draft?.input.transactionReference;
  const [amountYuan, setAmountYuan] = useState(() => typeof draftAmount === "number" ? String(draftAmount / 100) : correction ? String(correction.amount_minor / 100) : "");
  const [transactionReference, setTransactionReference] = useState(() => typeof draftReference === "string" ? draftReference : correction?.transaction_reference ?? "");
  const [note, setNote] = useState(() => typeof draft?.input.note === "string" ? draft.input.note : "");
  const [validationError, setValidationError] = useState<string>();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = yuanInputToMinor(amountYuan);
    if (!amountMinor) {
      setValidationError("收款金额必须大于 0，最多保留两位小数");
      return;
    }
    if (!transactionReference.trim()) {
      setValidationError("必须填写企微交易单号");
      return;
    }
    onSubmit(correction ? {
      commandType: "CORRECT_MEMBERSHIP_PAYMENT",
      title: "更正企微收款",
      description: "确认后将冲销原收款并追加更正后的企微收款，原记录不会被删除。",
      input: { propertyId, membershipOrderId: summary.order.id, originalPaymentFactId: correction.fact_id, correctedAmountMinor: amountMinor, correctedTransactionReference: transactionReference.trim(), ...(note.trim() ? { note: note.trim() } : {}) }
    } : {
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      title: "登记企微收款",
      description: "确认本次独立企微收款的金额和交易单号。",
      input: { propertyId, membershipOrderId: summary.order.id, amountMinor, transactionReference: transactionReference.trim(), ...(note.trim() ? { note: note.trim() } : {}) }
    });
  }
  return <Modal title={correction ? "更正企微收款" : "登记企微收款"} onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <label>收款金额（人民币元）<input type="number" min="0.01" step="0.01" inputMode="decimal" value={amountYuan} onChange={(event) => { setAmountYuan(event.target.value); setValidationError(undefined); }} required data-testid="membership-payment-yuan" /></label>
        <label>企微交易单号<input value={transactionReference} onChange={(event) => { setTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="membership-payment-reference" /></label>
        <label className="span-two">备注（可选）<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></label>
      </div>
      {validationError ? <InlineError error={new Error(validationError)} /> : null}
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">{correction ? "核对更正内容" : "核对收款信息"}</button></div>
    </form>
  </Modal>;
}

function MemberList({ members, selectedMemberId, onSelect }: {
  members: MemberSummaryDto[];
  selectedMemberId: string;
  onSelect: (memberId: string) => void;
}) {
  return <section className="member-list-panel" aria-labelledby="member-list-heading">
    <div className="section-title-row">
      <h2 id="member-list-heading">会员列表</h2>
      <span>{members.length} 位</span>
    </div>
    <ul className="member-list">
      {members.map(({ member }) => <li key={member.id}>
        <button
          type="button"
          className="member-list-item"
          aria-pressed={member.id === selectedMemberId}
          onClick={() => onSelect(member.id)}
          data-testid="member-list-item"
        >
          <strong>{member.full_name}</strong>
          <span>{member.phone}</span>
          <small>{member.identity_card_number}</small>
          <small>微信：{member.wechat}</small>
        </button>
      </li>)}
    </ul>
  </section>;
}

function MemberProfile({ member }: { member: MemberViewDto }) {
  return <section className="member-profile-panel" aria-labelledby="member-profile-heading">
    <div className="section-title-row">
      <div>
        <span className="section-kicker">会员档案</span>
        <h2 id="member-profile-heading">{member.member.full_name}</h2>
      </div>
    </div>
    <dl className="member-profile-fields">
      <div><dt>姓名</dt><dd>{member.member.full_name}</dd></div>
      <div><dt>身份证号</dt><dd>{member.member.identity_card_number}</dd></div>
      <div><dt>手机号</dt><dd>{member.member.phone}</dd></div>
      <div><dt>微信号</dt><dd>{member.member.wechat}</dd></div>
    </dl>
  </section>;
}

export function ledgerEntryLabel(
  entryType: MemberViewDto["ledger"][number]["entry_type"],
  reason?: string
): string {
  if (entryType === "ADJUST") return "余额更正";
  if (entryType === "HOLD") return "预订冻结";
  if (entryType === "RELEASE") return "冻结释放";
  if (entryType === "CONSUME") return reason === "EXTEND_STAY_ENTITLEMENT_CONSUMED" ? "续住核销" : "入住核销";
  return "权益到期";
}

export function ledgerEntryDisplayQuantity(
  entryType: MemberViewDto["ledger"][number]["entry_type"],
  quantityDelta: number
): { label: string; quantity: number; prefix: string; tone: string } {
  if (entryType === "CONSUME") return { label: "本次核销", quantity: 1, prefix: "", tone: "is-negative" };
  return {
    label: "余额",
    quantity: quantityDelta,
    prefix: quantityDelta > 0 ? "+" : "",
    tone: quantityDelta > 0 ? "is-positive" : quantityDelta < 0 ? "is-negative" : ""
  };
}

function CorrectEntitlementBalanceDialog({ propertyId, lot, currentBalance, draft, onClose, onSubmit }: {
  propertyId: string;
  lot: MemberViewDto["lots"][number];
  currentBalance: number;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const [targetBalance, setTargetBalance] = useState(() => typeof draft?.input.targetAvailableBalance === "number" ? String(draft.input.targetAvailableBalance) : String(currentBalance));
  const [reason, setReason] = useState(() => typeof draft?.input.adjustmentReason === "string" ? draft.input.adjustmentReason : "");
  const [validationError, setValidationError] = useState<string>();
  const unit = lot.unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = parseEntitlementBalance(targetBalance);
    if (target === undefined) {
      setValidationError(`更正后剩余${unit}数必须是非负整数`);
      return;
    }
    if (target === currentBalance) {
      setValidationError("更正后余额必须与当前余额不同");
      return;
    }
    if (!reason.trim()) {
      setValidationError("必须填写余额更正原因");
      return;
    }
    onSubmit({
      commandType: "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
      title: "更正会员余额",
      description: `确认后系统将从当前 ${currentBalance} ${unit}更正为 ${target} ${unit}，并保留原账本历史。`,
      input: {
        propertyId,
        entitlementLotId: lot.id,
        expectedAvailableBalance: currentBalance,
        targetAvailableBalance: target,
        adjustmentReason: reason.trim()
      }
    });
  }

  return <Modal title="更正会员余额" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <label>当前可用余额<input value={`${currentBalance} ${unit}`} disabled /></label>
        <label>{`更正后剩余${unit}数`}<input type="number" min="0" step="1" inputMode="numeric" value={targetBalance} onChange={(event) => { setTargetBalance(event.target.value); setValidationError(undefined); }} required data-testid="target-entitlement-balance" /></label>
        <label className="span-two">更正原因<textarea rows={3} value={reason} onChange={(event) => { setReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} data-testid="entitlement-adjustment-reason" /></label>
      </div>
      {validationError ? <InlineError error={new Error(validationError)} /> : null}
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">核对余额更正</button></div>
    </form>
  </Modal>;
}

function MemberEntitlementsPanel({ view, disabled, onCorrect }: {
  view: MemberViewDto;
  disabled: boolean;
  onCorrect: (lot: MemberViewDto["lots"][number], currentBalance: number) => void;
}) {
  const balanceByLot = new Map(view.lotBalances.map((balance) => [balance.lotId, balance.availableUnits]));
  const orderByLot = new Map(view.membershipOrders.flatMap((summary) => summary.order.entitlement_lot_id ? [[summary.order.entitlement_lot_id, summary.order] as const] : []));
  const formalLotIds = formalEntitlementLotIds(view.membershipOrders);
  const formalLots = view.lots.filter((lot) => formalLotIds.has(lot.id));
  const formalLedger = view.ledger.filter((entry) => formalLotIds.has(entry.lot_id));
  const contractById = new Map(view.contracts.map((contract) => [contract.id, contract]));
  const lotById = new Map(formalLots.map((lot) => [lot.id, lot]));
  const formalBalance = formalLots.reduce((total, lot) => {
    total[lot.unit_kind] += balanceByLot.get(lot.id) ?? 0;
    return total;
  }, { ROOM_NIGHT: 0, BED_NIGHT: 0 });
  return <section className="member-entitlements-panel" aria-labelledby="member-entitlements-heading">
    <div className="section-title-row">
      <div><span className="section-kicker">会员权益</span><h2 id="member-entitlements-heading">可住宿余额</h2></div>
      <span>截至 {formatDate(view.balanceAsOfDate)}</span>
    </div>
    <div className="member-balance-summary" data-testid="member-balance-summary">
      <div><span>间夜余额</span><strong>{formalBalance.ROOM_NIGHT} 间夜</strong></div>
      <div><span>床夜余额</span><strong>{formalBalance.BED_NIGHT} 床夜</strong></div>
    </div>
    {!formalLots.length ? <EmptyState title="尚无可住宿权益" detail="会员订单生效后，系统会在这里显示对应的间夜或床夜。" /> : <div className="member-entitlement-lots">
      {formalLots.map((lot) => {
        const order = orderByLot.get(lot.id)!;
        const contract = contractById.get(lot.contract_id);
        const available = balanceByLot.get(lot.id) ?? 0;
        const unit = lot.unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜";
        const active = isEntitlementLotActive(contract, lot.expires_on, view.balanceAsOfDate);
        return <article key={lot.id} className="member-entitlement-lot" data-testid="member-entitlement-lot">
          <div className="member-entitlement-heading"><div><h3>{order.product_name}</h3><p>{active ? "有效" : "已失效"}</p></div><strong>{available} {unit}</strong></div>
          <dl>
            <div><dt>会员类型</dt><dd>{order.product_name}</dd></div>
            <div><dt>有效期</dt><dd>{contract ? `${formatDate(contract.valid_from)} 至 ${formatDate(contract.valid_until)}` : `至 ${formatDate(lot.expires_on)}`}</dd></div>
            <div><dt>初始发放</dt><dd>{lot.total_units} {unit}</dd></div>
            <div><dt>当前可用</dt><dd><strong>{available} {unit}</strong></dd></div>
          </dl>
          {active ? <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => onCorrect(lot, available)} data-testid="correct-entitlement-balance"><PencilLine aria-hidden="true" size={15} />更正余额</button> : null}
        </article>;
      })}
    </div>}
    <section className="member-ledger-history" aria-labelledby="member-ledger-heading" data-testid="member-ledger-history">
      <div className="membership-subheading"><h3 id="member-ledger-heading">权益变动历史</h3><span>{formalLedger.length} 条</span></div>
      {!formalLedger.length ? <p className="membership-empty-line">尚无冻结、释放、核销或更正记录</p> : <ol>
        {[...formalLedger].reverse().map((entry) => {
          const lot = lotById.get(entry.lot_id);
          const order = orderByLot.get(entry.lot_id)!;
          const unit = lot?.unit_kind === "BED_NIGHT" ? "床夜" : "间夜";
          const displayQuantity = ledgerEntryDisplayQuantity(entry.entry_type, entry.quantity_delta);
          return <li key={entry.fact_id} data-testid={`member-ledger-entry-${entry.entry_type.toLowerCase()}`}>
            <div><strong>{ledgerEntryLabel(entry.entry_type, entry.reason)}</strong><span className={displayQuantity.tone} data-testid="member-ledger-quantity">{displayQuantity.label} {displayQuantity.prefix}{displayQuantity.quantity} {unit}</span></div>
            <small>{order.product_name} · {entry.service_date ? `住宿日期 ${formatDate(entry.service_date)}` : formatDate(entry.created_at)}</small>
            {entry.entry_type === "ADJUST" ? <p>{entry.reason}</p> : null}
          </li>;
        })}
      </ol>}
    </section>
  </section>;
}

function MembershipOrdersPanel({ view, disabled, onCreate, onPayment, onCorrect, onActivate }: {
  view: MemberViewDto;
  disabled: boolean;
  onCreate: () => void;
  onPayment: (summary: MembershipOrderSummaryDto) => void;
  onCorrect: (summary: MembershipOrderSummaryDto, fact: MembershipPaymentFactDto) => void;
  onActivate: (summary: MembershipOrderSummaryDto) => void;
}) {
  return <section className="membership-orders-panel" aria-labelledby="membership-orders-heading">
    <div className="section-title-row">
      <div><span className="section-kicker">会员购买</span><h2 id="membership-orders-heading">会员订单</h2></div>
      <button type="button" className="button button-primary" onClick={onCreate} disabled={disabled || view.membershipProducts.length === 0} data-testid="create-membership-order"><CreditCard aria-hidden="true" size={17} />办理会员</button>
    </div>
    {!view.membershipOrders.length ? <EmptyState title="尚无会员订单" detail="办理会员后，可登记多笔企微收款并由工作人员明确生效。" /> : <div className="membership-order-list">
      {view.membershipOrders.map((summary) => {
        const { order, paymentFacts } = summary;
        const reversedIds = new Set(paymentFacts.filter((fact) => fact.reverses_fact_id).map((fact) => fact.reverses_fact_id));
        const activeCollections = paymentFacts.filter((fact) => fact.fact_type === "COLLECTION" && !reversedIds.has(fact.fact_id));
        return <article className="membership-order-item" key={order.id} data-testid="membership-order-item">
          <div className="membership-order-heading">
            <div><h3>{order.product_name}</h3><p>{entitlementLabel(order.entitlement_unit_kind, order.entitlement_units)} · {order.allowed_inventory_kind === "ROOM" ? "按房使用" : "按床使用"}</p></div>
            <span className={`membership-status membership-status-${order.status.toLowerCase()}`}>{order.status === "ACTIVE" ? "已生效" : "待生效"}</span>
          </div>
          <dl className="membership-order-pricing">
            <div><dt>标价</dt><dd>{formatMinor(order.listed_price_minor, order.currency)}</dd></div>
            <div><dt>成交价</dt><dd><strong>{formatMinor(order.agreed_price_minor, order.currency)}</strong></dd></div>
            <div><dt>调价差额</dt><dd>{formatMinor(order.price_adjustment_minor, order.currency)}</dd></div>
            <div><dt>有效收款</dt><dd><strong>{formatMinor(summary.paymentTotalMinor, order.currency)}</strong></dd></div>
          </dl>
          {order.price_adjustment_reason ? <p className="membership-adjustment-reason"><span>调价原因</span>{order.price_adjustment_reason}</p> : null}
          <div className={`membership-payment-difference ${summary.paymentDifferenceMinor === 0 ? "is-balanced" : ""}`} data-testid="membership-payment-difference">
            {summary.paymentDifferenceMinor === 0
              ? "收款合计与成交价一致"
              : summary.paymentDifferenceMinor < 0
                ? `收款比成交价少 ${formatMinor(Math.abs(summary.paymentDifferenceMinor), order.currency)}`
                : `收款比成交价多 ${formatMinor(summary.paymentDifferenceMinor, order.currency)}`}
            <small>仅提示差额，不代表自动到账、结清或改价。</small>
          </div>
          {order.status === "ACTIVE" ? <div className="membership-activation-summary" data-testid="membership-activation-summary"><BadgeCheck aria-hidden="true" size={18} /><div><strong>{formatDate(order.valid_from ?? undefined)} 至 {formatDate(order.valid_until ?? undefined)}</strong><span>已发放 {entitlementLabel(order.entitlement_unit_kind, order.entitlement_units)}</span></div></div> : null}
          <section className="membership-payments" aria-label={`${order.product_name}企微收款`}>
            <div className="membership-subheading"><h4>企微收款记录</h4><span>{activeCollections.length} 笔有效收款</span></div>
            {!paymentFacts.length ? <p className="membership-empty-line">尚未登记企微收款</p> : <ol>
              {paymentFacts.map((fact) => {
                const reversed = fact.fact_type === "COLLECTION" && reversedIds.has(fact.fact_id);
                return <li key={fact.fact_id} className={fact.fact_type === "REVERSAL" || reversed ? "is-reversed" : ""}>
                  <div>
                    <strong>{fact.fact_type === "REVERSAL" ? "冲销原收款" : fact.corrects_fact_id ? "更正后收款" : "企微收款"}</strong>
                    <span>{formatMinor(fact.net_effect_minor, fact.currency)}</span>
                    {fact.transaction_reference ? <code>{fact.transaction_reference}</code> : null}
                    {reversed ? <small>已由后续更正冲销</small> : fact.note ? <small>{fact.note}</small> : null}
                  </div>
                  {order.status === "DRAFT" && fact.fact_type === "COLLECTION" && !reversed ? <button type="button" className="button button-secondary button-small" onClick={() => onCorrect(summary, fact)} disabled={disabled}><PencilLine aria-hidden="true" size={15} />更正</button> : null}
                </li>;
              })}
            </ol>}
          </section>
          {order.status === "DRAFT" ? <div className="membership-order-actions">
            <button type="button" className="button button-secondary" onClick={() => onPayment(summary)} disabled={disabled} data-testid="record-membership-payment"><CircleDollarSign aria-hidden="true" size={17} />登记企微收款</button>
            <button type="button" className="button button-primary" onClick={() => onActivate(summary)} disabled={disabled} data-testid="activate-membership-order"><BadgeCheck aria-hidden="true" size={17} />生效会员订单</button>
          </div> : null}
        </article>;
      })}
    </div>}
  </section>;
}

export function MembersPage() {
  const { principal, propertyId, refreshMeta } = useWorkspace();
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [members, setMembers] = useState<MemberSummaryDto[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [member, setMember] = useState<MemberViewDto>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMember, setLoadingMember] = useState(false);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [creatingMember, setCreatingMember] = useState(false);
  const [creatingMembershipOrder, setCreatingMembershipOrder] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<MembershipOrderSummaryDto>();
  const [correctingPayment, setCorrectingPayment] = useState<{ summary: MembershipOrderSummaryDto; fact: MembershipPaymentFactDto }>();
  const [correctingEntitlement, setCorrectingEntitlement] = useState<{ lot: MemberViewDto["lots"][number]; currentBalance: number }>();
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string>();
  const commandsBlocked = commandRecovery.blocked;

  useEffect(() => {
    setCreatingMember(false);
    setCreatingMembershipOrder(false);
    setPaymentOrder(undefined);
    setCorrectingPayment(undefined);
    setCorrectingEntitlement(undefined);
    setCommand(undefined);
    setCommandDraft(undefined);
    setRecoveryDialogOpen(false);
    setRecoveryError(undefined);
    setCommandNotice(undefined);
    setSelectedMemberId("");
  }, [propertyId]);

  useEffect(() => {
    let current = true;
    setLoadingList(true);
    setError(undefined);
    setMembers([]);
    setMember(undefined);
    api.members(propertyId, searchQuery || undefined)
      .then((response) => {
        if (current) setMembers(response.members);
      })
      .catch((nextError) => {
        if (current) setError(nextError);
      })
      .finally(() => {
        if (current) setLoadingList(false);
      });
    return () => { current = false; };
  }, [propertyId, searchQuery, refreshToken]);

  const currentMemberId = effectiveMemberId(members, selectedMemberId);

  useEffect(() => {
    if (!currentMemberId) {
      setMember(undefined);
      setLoadingMember(false);
      return;
    }
    let current = true;
    setMember(undefined);
    setLoadingMember(true);
    setError(undefined);
    api.member(currentMemberId, propertyId)
      .then((response) => current && setMember(response))
      .catch((nextError) => {
        if (current) {
          setMember(undefined);
          setError(nextError);
        }
      })
      .finally(() => current && setLoadingMember(false));
    return () => { current = false; };
  }, [currentMemberId, propertyId, refreshToken]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelectedMemberId("");
    setSearchQuery(normalizeMemberQuery(searchInput));
  }

  function refresh() {
    setRefreshToken((value) => value + 1);
    void refreshMeta();
  }

  function startCommand(request: CommandRequest) {
    if (commandsBlocked) return;
    setRecoveryDialogOpen(false);
    setCommandDraft(undefined);
    setCommand(request);
  }

  function submitBusinessCommand(request: CommandRequest) {
    setCreatingMembershipOrder(false);
    setPaymentOrder(undefined);
    setCorrectingPayment(undefined);
    setCorrectingEntitlement(undefined);
    startCommand(request);
  }

  function applyCommittedReceipt(receipt: { result?: Record<string, unknown> }) {
    const nextMemberId = receipt.result && typeof receipt.result.memberId === "string" ? receipt.result.memberId : undefined;
    if (nextMemberId) setSelectedMemberId(nextMemberId);
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    if (context || (commandRecovery.pending && isTerminalCommandRecovery(commandRecovery.pending.state))) {
      refreshAfterClose ||= commandRecovery.pending?.state === "EXECUTED";
      if (context?.receipt.businessCommitted) applyCommittedReceipt(context.receipt);
      if (commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已完成操作的本地恢复记录；为避免重复建档，写入继续暂停"));
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) refresh();
  }

  function returnCommandToEdit(request: CommandRequest) {
    setCommandDraft(request);
    if (request.commandType === "CREATE_MEMBER") {
      setCreatingMember(true);
      return;
    }
    if (!member) return;
    if (request.commandType === "CREATE_MEMBERSHIP_ORDER") {
      setCreatingMembershipOrder(true);
      return;
    }
    const membershipOrderId = request.input.membershipOrderId;
    const summary = typeof membershipOrderId === "string"
      ? member.membershipOrders.find((candidate) => candidate.order.id === membershipOrderId)
      : undefined;
    if (!summary) return;
    if (request.commandType === "RECORD_MEMBERSHIP_PAYMENT") {
      setPaymentOrder(summary);
    } else if (request.commandType === "CORRECT_MEMBERSHIP_PAYMENT") {
      const originalFactId = request.input.originalPaymentFactId;
      const fact = typeof originalFactId === "string" ? summary.paymentFacts.find((candidate) => candidate.fact_id === originalFactId) : undefined;
      if (fact) setCorrectingPayment({ summary, fact });
    } else if (request.commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") {
      const lotId = request.input.entitlementLotId;
      const lot = typeof lotId === "string" ? member.lots.find((candidate) => candidate.id === lotId) : undefined;
      const currentBalance = request.input.expectedAvailableBalance;
      if (lot && typeof currentBalance === "number") setCorrectingEntitlement({ lot, currentBalance });
    }
  }

  return <div className="members-page">
    <header className="page-heading page-heading-actions">
      <div><p className="eyebrow">会员管理</p><h1>会员档案</h1><p>查询和维护当前门店的会员资料</p></div>
      <button className="button button-secondary" type="button" onClick={refresh} disabled={loadingList || loadingMember}><RefreshCw className={loadingList || loadingMember ? "spin" : ""} aria-hidden="true" size={17} />刷新</button>
      <button className="button button-primary" type="button" onClick={() => setCreatingMember(true)} disabled={commandsBlocked} data-testid="create-member"><UserPlus aria-hidden="true" size={17} />新建会员</button>
    </header>

    <InlineError error={recoveryError} title="恢复记录未完成" />
    <InlineError error={commandRecovery.error} title="本地操作恢复记录不可用" />
    <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
    {commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="member-command-recovery" businessFacing /> : null}

    <form className="member-search" role="search" aria-label="搜索会员" onSubmit={search}>
      <label htmlFor="member-search-query">搜索会员<input id="member-search-query" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="姓名、身份证号、手机号或微信号" data-testid="member-search-query" /></label>
      <button className="button button-secondary" type="submit" disabled={loadingList}><Search aria-hidden="true" size={17} />搜索</button>
      {searchQuery ? <button className="button button-secondary" type="button" onClick={() => { setSearchInput(""); setSearchQuery(""); setSelectedMemberId(""); }}>清除</button> : null}
    </form>

    <InlineError error={error} title="无法载入会员档案" />
    {loadingList ? <LoadingBlock label="正在载入会员列表" /> : !members.length ? <EmptyState title="未找到会员" detail="可更换搜索条件，或新建一位会员。" /> : <div className="member-directory">
      <MemberList members={members} selectedMemberId={currentMemberId} onSelect={setSelectedMemberId} />
      {loadingMember ? <LoadingBlock label="正在载入会员档案" /> : member ? <div className="member-detail-stack">
        <MemberProfile member={member} />
        <MemberEntitlementsPanel view={member} disabled={commandsBlocked} onCorrect={(lot, currentBalance) => setCorrectingEntitlement({ lot, currentBalance })} />
        <MembershipOrdersPanel
          view={member}
          disabled={commandsBlocked}
          onCreate={() => setCreatingMembershipOrder(true)}
          onPayment={setPaymentOrder}
          onCorrect={(summary, fact) => setCorrectingPayment({ summary, fact })}
          onActivate={(summary) => startCommand({
            commandType: "ACTIVATE_MEMBERSHIP_ORDER",
            title: "生效会员订单",
            description: "确认当前企微收款合计和差额后，使会员订单生效并从今天起计算一年有效期。",
            input: { propertyId, membershipOrderId: summary.order.id }
          })}
        />
      </div> : null}
    </div>}

    {creatingMember ? <CreateMemberDialog propertyId={propertyId} {...(commandDraft?.commandType === "CREATE_MEMBER" ? { draft: commandDraft } : {})} onClose={() => { setCreatingMember(false); setCommandDraft(undefined); }} onSubmit={(request) => { if (commandsBlocked) return; setCreatingMember(false); startCommand(request); }} /> : null}
    {creatingMembershipOrder && member ? <CreateMembershipOrderDialog propertyId={propertyId} member={member.member} products={member.membershipProducts} {...(commandDraft?.commandType === "CREATE_MEMBERSHIP_ORDER" ? { draft: commandDraft } : {})} onClose={() => { setCreatingMembershipOrder(false); setCommandDraft(undefined); }} onSubmit={submitBusinessCommand} /> : null}
    {paymentOrder ? <MembershipPaymentDialog propertyId={propertyId} summary={paymentOrder} {...(commandDraft?.commandType === "RECORD_MEMBERSHIP_PAYMENT" ? { draft: commandDraft } : {})} onClose={() => { setPaymentOrder(undefined); setCommandDraft(undefined); }} onSubmit={submitBusinessCommand} /> : null}
    {correctingPayment ? <MembershipPaymentDialog propertyId={propertyId} summary={correctingPayment.summary} correction={correctingPayment.fact} {...(commandDraft?.commandType === "CORRECT_MEMBERSHIP_PAYMENT" ? { draft: commandDraft } : {})} onClose={() => { setCorrectingPayment(undefined); setCommandDraft(undefined); }} onSubmit={submitBusinessCommand} /> : null}
    {correctingEntitlement ? <CorrectEntitlementBalanceDialog propertyId={propertyId} lot={correctingEntitlement.lot} currentBalance={correctingEntitlement.currentBalance} {...(commandDraft?.commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE" ? { draft: commandDraft } : {})} onClose={() => { setCorrectingEntitlement(undefined); setCommandDraft(undefined); }} onSubmit={(request) => { setCorrectingEntitlement(undefined); submitBusinessCommand(request); }} /> : null}
    {command ? <CommandDialog
      key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}` : "new-member-command"}
      request={command}
      onClose={closeCommandDialog}
      {...(recoveryDialogOpen && commandRecovery.pending ? {
        initialConfirmationKey: commandRecovery.pending.confirmationKey
      } : {})}
      onCommitted={async (receipt) => {
        const clearSearch = shouldClearMemberSearchAfterCommit(command.commandType);
        const nextMemberId = receipt.result && typeof receipt.result.memberId === "string"
          ? receipt.result.memberId
          : currentMemberId || undefined;
        const [listResponse, memberResponse] = await Promise.all([
          api.members(propertyId, clearSearch ? undefined : searchQuery || undefined),
          nextMemberId ? api.member(nextMemberId, propertyId) : Promise.resolve(undefined)
        ]);
        setMembers(listResponse.members);
        if (memberResponse) setMember(memberResponse);
        applyCommittedReceipt(receipt);
        if (clearSearch) {
          setSearchInput("");
          setSearchQuery("");
        }
      }}
      onProgress={(progress) => commandRecovery.track(command, progress)}
      onBusinessSuccess={(message) => setCommandNotice(message)}
      onBusinessNotExecuted={(message) => setCommandNotice(message)}
      onReturnToEdit={returnCommandToEdit}
    /> : null}
  </div>;
}
