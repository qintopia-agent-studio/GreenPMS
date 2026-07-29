import { describe, expect, it } from "vitest";
import { businessStatusLabel, fulfillmentAuditNote, fulfillmentReceiptCopy, fulfillmentTransitionIsExpected, guestNicknameLabel, lodgingReceiptCopy, notifyKnownCommittedCommand, occupantSummaryItems, receiptExecutionSemanticsAreCoherent, receiptTransactionReferenceLabel, stayDatePreviewPricingSummary, u1PreviewHasBusinessEvidence } from "./ui.tsx";

describe("Fulfillment business presentation", () => {
  it("uses one Chinese lifecycle vocabulary without protocol or enum labels", () => {
    expect(["RESERVED", "PLANNED", "CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "COMPLETED"].map(businessStatusLabel))
      .toEqual(["已预订", "已预订", "在住", "在住", "已退房", "已完成"]);
  });

  it("summarizes current check-in and check-out results without promising a cleaning task", () => {
    expect(fulfillmentReceiptCopy("CHECK_IN", true)).toEqual({
      heading: "办理入住已完成",
      description: "住宿状态已更新为在住；本次不涉及会员权益。"
    });
    expect(fulfillmentReceiptCopy("CHECK_IN", true, 2)).toEqual({
      heading: "办理入住已完成",
      description: "住宿状态已更新为在住；本次核销 2 晚已冻结的会员权益。"
    });
    expect(fulfillmentReceiptCopy("CHECK_OUT", true)).toEqual({
      heading: "办理退房已完成",
      description: "住宿状态已更新为已退房，后续库存已按当前住宿事实释放。"
    });
    expect(fulfillmentReceiptCopy("CHECK_OUT", true).description).not.toContain("清洁");
    // Historical recovery records still need readable copy after the workflow is disabled.
    expect(fulfillmentReceiptCopy("COMPLETE_CLEANING", true)).toEqual({
      heading: "清洁已完成",
      description: "清洁任务已更新为已完成，住宿历史保持不变。"
    });
    expect(JSON.stringify(fulfillmentReceiptCopy("CHECK_OUT", false))).not.toMatch(/Preview|Confirm|Receipt|Command|CHECKED/);
  });

  it("only accepts the authoritative transition for each fulfillment command", () => {
    expect(fulfillmentTransitionIsExpected("CHECK_IN", {
      fromStatus: "RESERVED", toStatus: "CHECKED_IN",
      businessDate: "2026-07-25", effectiveDate: "2026-07-25", recordingMode: "ON_SCHEDULE"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_OUT", {
      fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT",
      businessDate: "2026-07-26", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("COMPLETE_CLEANING", { fromStatus: "PENDING", toStatus: "COMPLETED" })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_IN", { fromStatus: "RESERVED", toStatus: "CHECKED_OUT" })).toBe(false);
    expect(fulfillmentTransitionIsExpected("CHECK_OUT", {
      fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT",
      businessDate: "2026-07-24", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(false);
  });

  it("explains a late-recorded check-out without treating the record date as the departure date", () => {
    expect(fulfillmentReceiptCopy("CHECK_OUT", true, 0, {
      effectiveDate: "2026-07-25",
      recordedBusinessDate: "2026-07-26",
      recordingMode: "LATE_RECORDED"
    })).toEqual({
      heading: "迟录退房已完成",
      description: "退房按原计划退房日 2026-07-25 生效，于 2026-07-26 营业日迟录；订单金额保持不变，住宿库存已释放。"
    });
  });

  it("uses stable audit notes when an operator leaves a lodging note empty", () => {
    expect(fulfillmentAuditNote("CHECK_IN", { recordingMode: "ON_SCHEDULE" }, "")).toBe("按计划办理入住");
    expect(fulfillmentAuditNote("CHECK_OUT", { recordingMode: "ON_SCHEDULE" }, "   ")).toBe("按计划办理退房");
    expect(fulfillmentAuditNote("CHECK_OUT", { recordingMode: "LATE_RECORDED" }, "\n")).toBe("迟录计划退房");
  });

  it("trims and preserves an operator-provided lodging note", () => {
    expect(fulfillmentAuditNote("CHECK_IN", { recordingMode: "ON_SCHEDULE" }, "  已核对证件  ")).toBe("已核对证件");
    expect(fulfillmentAuditNote("CHECK_OUT", { recordingMode: "LATE_RECORDED" }, "  客人昨晚已离店  ")).toBe("客人昨晚已离店");
  });
});

describe("Receipt transaction reference labels", () => {
  it("distinguishes reversal non-applicability from a historical missing collection or refund reference", () => {
    expect(receiptTransactionReferenceLabel({ factType: "REVERSAL", transactionReference: null })).toBe("不适用");
    expect(receiptTransactionReferenceLabel({ factType: "COLLECTION", transactionReference: null })).toBe("历史未记录");
    expect(receiptTransactionReferenceLabel({ factType: "REFUND", transactionReference: "TXN-REFUND-001" })).toBe("TXN-REFUND-001");
  });
});

describe("Guest nickname labels", () => {
  it("keeps a recorded nickname and derives an explicit historical compatibility label", () => {
    expect(guestNicknameLabel({ fullName: "Legal Name", nickname: "山风" })).toBe("山风");
    expect(guestNicknameLabel({ fullName: "Legacy Missing" })).toBe("历史未记录");
    expect(guestNicknameLabel({ fullName: "Legacy Null", nickname: null })).toBe("历史未记录");
  });
});

describe("Occupant command summaries", () => {
  it("keeps occupant order and excludes phone and document details from the compact summary", () => {
    const summary = occupantSummaryItems([{
      id: "occupant_primary",
      ordinal: 1,
      role: "PRIMARY",
      nickname: "山风",
      fullName: "主要姓名",
      phone: "13800000000",
      documentNumber: "PRIVATE-DOC"
    }, {
      id: "occupant_additional",
      ordinal: 2,
      role: "ADDITIONAL",
      nickname: "小满",
      fullName: "同行姓名"
    }]);

    expect(summary).toEqual([
      { key: "occupant_primary", roleLabel: "主要 / 联系人", nickname: "山风", fullName: "主要姓名" },
      { key: "occupant_additional", roleLabel: "同行人 1", nickname: "小满", fullName: "同行姓名" }
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/13800000000|PRIVATE-DOC/);
  });

  it("keeps the accepted member-stay receipt copy while adding occupant summaries separately", () => {
    expect(lodgingReceiptCopy(true, true)).toEqual({
      heading: "会员住宿订单已创建",
      description: "住宿日期、库存和会员权益覆盖已按核对结果记录。"
    });
    expect(lodgingReceiptCopy(false, true)).toEqual({
      heading: "会员住宿订单未创建",
      description: "本次操作没有写入住宿订单或会员权益变动。"
    });
    expect(lodgingReceiptCopy(true, false)).toEqual({
      heading: "住宿订单已创建",
      description: "住宿日期、库存和住宿人名单已按核对结果记录。"
    });
    expect(lodgingReceiptCopy(false, false)).toEqual({
      heading: "住宿订单未创建",
      description: "本次操作没有写入住宿订单。"
    });
  });
});

describe("Committed command projection refresh", () => {
  it("keeps a known committed result terminal when the page refresh callback fails", async () => {
    const committedReceipt = {
      receiptId: "receipt_committed",
      commandId: "command_committed",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_committed",
      result: { maintenanceLockId: "lock_committed" },
      resourceRefs: ["lock_committed"],
      factRefs: [],
      committedAt: "2026-07-27T10:00:00.000Z"
    };
    const notices: Array<{ message: string; receiptId: string }> = [];

    const outcome = await notifyKnownCommittedCommand({
      commandType: "LOCK_MAINTENANCE",
      receipt: committedReceipt,
      onCommitted: () => {
        throw new Error("projection refresh failed");
      },
      onBusinessSuccess: (message, receipt) => notices.push({ message, receiptId: receipt.receiptId })
    });

    expect(outcome).toBe("REFRESH_FAILED");
    expect(notices).toEqual([{
      message: "设置维修锁房已完成，但页面刷新失败。请点击页面上的刷新按钮查看最新结果。",
      receiptId: committedReceipt.receiptId
    }]);
    expect(notices[0]?.message).not.toMatch(/未写入|结果未知|重新提交/);
  });
});

describe("U1 confirmation evidence", () => {
  const money = (minorUnits: number) => ({ minorUnits, currency: "CNY" });

  it("fails closed for incomplete maintenance and fulfillment effects", () => {
    expect(u1PreviewHasBusinessEvidence("LOCK_MAINTENANCE", {
      inventoryUnit: { code: "101", name: "四人间" },
      arrivalDate: "2026-07-27",
      departureDate: "2026-07-28",
      reason: "维修"
    })).toBe(true);
    expect(u1PreviewHasBusinessEvidence("LOCK_MAINTENANCE", {
      arrivalDate: "2026-07-27",
      departureDate: "2026-07-28",
      reason: "维修"
    })).toBe(false);
    const releaseEffect = {
      maintenanceLockId: "maintenance_lock_1",
      inventoryUnitId: "inventory_unit_1",
      arrivalDate: "2026-07-27",
      departureDate: "2026-07-28"
    };
    const releaseInput = { maintenanceLockId: "maintenance_lock_1" };
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", releaseEffect, releaseInput)).toBe(true);
    for (const key of Object.keys(releaseEffect)) {
      expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", { ...releaseEffect, [key]: undefined }, releaseInput), key).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", releaseEffect, { maintenanceLockId: "maintenance_lock_2" })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", { ...releaseEffect, departureDate: releaseEffect.arrivalDate }, releaseInput)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", { ...releaseEffect, arrivalDate: "2026-02-30" }, releaseInput)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("CHECK_OUT", {
      fromStatus: "CHECKED_IN",
      toStatus: "CHECKED_OUT",
      businessDate: "2026-07-27",
      effectiveDate: "2026-07-27",
      recordingMode: "ON_SCHEDULE"
    })).toBe(true);
    expect(u1PreviewHasBusinessEvidence("CHECK_OUT", {
      fromStatus: "CHECKED_IN",
      toStatus: "CHECKED_OUT"
    })).toBe(false);
  });

  it("requires the authoritative reprice identity, pricing, and amount evidence", () => {
    const effect = {
      orderId: "order_1",
      inventoryUnitId: "inventory_unit_1",
      stayTimeline: [{ serviceDate: "2026-07-27", inventoryUnitId: "inventory_unit_1" }],
      before: { currentContractAmount: money(13_000) },
      policyBaseAmount: money(13_000),
      targetCurrentContractAmount: money(11_000),
      manualAdjustmentMinor: -2_000,
      pricing: {
        coverageSet: [],
        cashLines: [{
          lineKind: "NIGHT",
          serviceDate: "2026-07-27",
          inventoryUnitId: "inventory_unit_1",
          description: "单人间住宿",
          amount: money(13_000)
        }],
        cashRemainder: money(13_000),
        currentContractAmount: money(11_000)
      }
    };
    const input = { orderId: "order_1", targetCurrentContractAmountMinor: 11_000 };
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", effect, input)).toBe(true);
    for (const key of Object.keys(effect)) {
      expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, [key]: undefined }, input), key).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", effect, { ...input, orderId: "order_2" })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", effect, { ...input, targetCurrentContractAmountMinor: 10_900 })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      pricing: { ...effect.pricing, currentContractAmount: money(10_900) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, targetCurrentContractAmount: { minorUnits: 11_000, currency: "USD" } }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, manualAdjustmentMinor: -1_900 }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, stayTimeline: [] }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      stayTimeline: [{ serviceDate: "2026-07-27", inventoryUnitId: "inventory_unit_2" }]
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      stayTimeline: [
        { serviceDate: "2026-07-27", inventoryUnitId: "inventory_unit_1" },
        { serviceDate: "2026-07-29", inventoryUnitId: "inventory_unit_1" }
      ]
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      targetCurrentContractAmount: money(11_050)
    }, { ...input, targetCurrentContractAmountMinor: 11_050 })).toBe(false);
    for (const key of Object.keys(effect.pricing)) {
      expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
        ...effect,
        pricing: { ...effect.pricing, [key]: undefined }
      }, input), `pricing.${key}`).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      pricing: {
        ...effect.pricing,
        cashLines: [{ ...effect.pricing.cashLines[0], serviceDate: "2026-07-28" }]
      }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      pricingDecision: {
        policyBaseAmount: money(13_000),
        targetCurrentContractAmount: money(11_000)
      }
    }, input)).toBe(false);
  });

  it.each(["RESCHEDULE_STAY", "EXTEND_STAY"] as const)("requires coherent %s date, pricing, entitlement, inventory and funds evidence", (commandType) => {
    const beforeArrivalDate = "2026-08-02";
    const beforeDepartureDate = "2026-08-04";
    const afterArrivalDate = commandType === "RESCHEDULE_STAY" ? "2026-08-03" : beforeArrivalDate;
    const afterDepartureDate = "2026-08-05";
    const effect = {
      operation: commandType,
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      before: {
        arrivalDate: beforeArrivalDate,
        departureDate: beforeDepartureDate,
        nights: 2,
        currentContractAmount: money(20_000)
      },
      after: {
        arrivalDate: afterArrivalDate,
        departureDate: afterDepartureDate,
        nights: commandType === "RESCHEDULE_STAY" ? 2 : 3,
        stayTimeline: commandType === "RESCHEDULE_STAY"
          ? [
              { serviceDate: "2026-08-03", inventoryUnitId: "room_1" },
              { serviceDate: "2026-08-04", inventoryUnitId: "room_1" }
            ]
          : [
              { serviceDate: "2026-08-02", inventoryUnitId: "room_1" },
              { serviceDate: "2026-08-03", inventoryUnitId: "room_1" },
              { serviceDate: "2026-08-04", inventoryUnitId: "room_1" }
            ],
        pricing: {
          coverageSet: [],
          cashLines: [],
          cashRemainder: money(30_000),
          currentContractAmount: money(30_000)
        }
      },
      pricingDecision: {
        pricingBasis: "POLICY",
        policyBaseAmount: money(30_000),
        targetCurrentContractAmount: money(30_000),
        differenceFromPolicy: money(0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "POLICY", note: "" }
      },
      inventoryChange: commandType === "RESCHEDULE_STAY"
        ? { preservedDates: ["2026-08-03"], releasedDates: ["2026-08-02"], addedDates: ["2026-08-04"] }
        : { preservedDates: ["2026-08-02", "2026-08-03"], releasedDates: [], addedDates: ["2026-08-04"] },
      entitlementChange: {
        preservedCoverageDates: [],
        releasedCoverageDates: [],
        addedCoverageDates: [],
        consumedCoverageDates: []
      },
      fundsSummary: {
        netRecordedCollection: money(10_000),
        collectionDifference: money(20_000)
      }
    };
    const input = {
      orderId: "order_1",
      ...(commandType === "RESCHEDULE_STAY" ? { newArrivalDate: afterArrivalDate } : {}),
      newDepartureDate: afterDepartureDate
    };
    expect(u1PreviewHasBusinessEvidence(commandType, effect, input)).toBe(true);
    const preview = {
      previewId: "preview_1",
      commandType,
      effect,
      effectHash: "effect_hash_1",
      expiresAt: "2026-08-01T12:00:00.000Z"
    } as Parameters<typeof stayDatePreviewPricingSummary>[1];
    expect(stayDatePreviewPricingSummary(commandType, preview, input)).toEqual({
      beforeAmount: money(20_000),
      policyBaseAmount: money(30_000),
      targetAmount: money(30_000),
      differenceFromPolicy: money(0),
      netRecordedCollection: money(10_000),
      collectionDifference: money(20_000),
      pricingBasis: "POLICY"
    });
    expect(stayDatePreviewPricingSummary(commandType, { ...preview, effect: { ...effect, fundsSummary: undefined } }, input)).toBeUndefined();
    for (const key of ["before", "after", "pricingDecision", "inventoryChange", "entitlementChange", "fundsSummary"] as const) {
      expect(u1PreviewHasBusinessEvidence(commandType, { ...effect, [key]: undefined }, input), key).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      fundsSummary: { ...effect.fundsSummary, collectionDifference: money(19_900) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      after: { ...effect.after, nights: 99 }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      pricingDecision: { ...effect.pricingDecision, differenceFromPolicy: money(100) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      inventoryChange: { ...effect.inventoryChange, addedDates: ["2026-08-30"] }
    }, input)).toBe(false);

    const memberCoverageDates = commandType === "RESCHEDULE_STAY"
      ? ["2026-08-03", "2026-08-04"]
      : ["2026-08-02", "2026-08-03", "2026-08-04"];
    const memberEffect = {
      ...effect,
      before: { ...effect.before, currentContractAmount: money(0) },
      after: {
        ...effect.after,
        pricing: {
          ...effect.after.pricing,
          coverageSet: memberCoverageDates.map((serviceDate) => ({
            serviceDate,
            inventoryUnitId: "room_1",
            unitKind: "ROOM_NIGHT",
            entitlementLotId: "lot_1"
          })),
          cashRemainder: money(0),
          currentContractAmount: money(0)
        }
      },
      pricingDecision: {
        ...effect.pricingDecision,
        pricingBasis: "MEMBER_ENTITLEMENT",
        policyBaseAmount: money(0),
        targetCurrentContractAmount: money(0),
        differenceFromPolicy: money(0)
      },
      entitlementChange: commandType === "RESCHEDULE_STAY"
        ? {
            preservedCoverageDates: ["2026-08-03"],
            releasedCoverageDates: ["2026-08-02"],
            addedCoverageDates: ["2026-08-04"],
            consumedCoverageDates: []
          }
        : {
            preservedCoverageDates: ["2026-08-02", "2026-08-03"],
            releasedCoverageDates: [],
            addedCoverageDates: ["2026-08-04"],
            consumedCoverageDates: ["2026-08-04"]
          },
      fundsSummary: {
        netRecordedCollection: money(0),
        collectionDifference: money(0)
      }
    };
    expect(u1PreviewHasBusinessEvidence(commandType, memberEffect, input)).toBe(true);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: { ...memberEffect.entitlementChange, preservedCoverageDates: [] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: { ...memberEffect.entitlementChange, addedCoverageDates: [] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: { ...memberEffect.entitlementChange, releasedCoverageDates: ["2026-08-30"] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: {
        ...memberEffect.entitlementChange,
        consumedCoverageDates: commandType === "RESCHEDULE_STAY" ? ["2026-08-04"] : []
      }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      pricingDecision: { ...memberEffect.pricingDecision, pricingBasis: "POLICY" }
    }, input)).toBe(false);
  });

  it("rejects contradictory Receipt execution semantics", () => {
    const base = {
      receiptId: "receipt_1",
      commandId: "command_1",
      correlationId: "correlation_1",
      resourceRefs: [],
      factRefs: []
    };
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "EXECUTED", businessCommitted: true })).toBe(true);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "NOT_EXECUTED", businessCommitted: false })).toBe(true);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "UNKNOWN", businessCommitted: false })).toBe(true);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "NOT_EXECUTED", businessCommitted: true })).toBe(false);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "EXECUTED", businessCommitted: false })).toBe(false);
  });
});
