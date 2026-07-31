import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { businessErrorMessage, businessStatusLabel, fulfillmentAuditNote, fulfillmentReceiptCopy, fulfillmentTransitionIsExpected, guestNicknameLabel, knownCommittedCommandMessage, lodgingReceiptCopy, notifyKnownCommittedCommand, occupantSummaryItems, planBDateChangeTimeline, receiptExecutionSemanticsAreCoherent, receiptHasCommandEvidence, receiptTransactionReferenceLabel, stayDateFundsAreOperatorFacing, stayDatePreviewPricingSummary, u1PreviewHasBusinessEvidence } from "./ui.tsx";

describe("operator-facing business errors", () => {
  it("does not misreport an inventory conflict as a generic state change", () => {
    expect(businessErrorMessage(new ApiError(409, {
      code: "INVENTORY_CONFLICT",
      message: "Destination inventory is unavailable",
      correlationId: "correlation_inventory_conflict"
    }))).toBe("所选房源在目标日期区间已有占用，请重新选择房源或日期。");
    expect(businessErrorMessage(new ApiError(409, {
      code: "INVENTORY_CONFLICT",
      message: "目标房源在所选换房日期内已有占用，请选择其他房源。",
      correlationId: "correlation_inventory_conflict_cn"
    }))).toBe("目标房源在所选换房日期内已有占用，请选择其他房源。");
  });
});

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

describe("Stay-date financial presentation", () => {
  it("does not present an external channel contract as a per-order collection balance", () => {
    expect(stayDateFundsAreOperatorFacing("CTRIP", "CHANNEL_CONTRACT")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("CTRIP", "POLICY")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("MEITUAN", "MANUAL_ADJUSTMENT")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("YOUMUDAO", "POLICY")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("WECOM", "POLICY")).toBe(true);
    expect(stayDateFundsAreOperatorFacing("WECOM", "MANUAL_ADJUSTMENT")).toBe(true);
    expect(stayDateFundsAreOperatorFacing(undefined, "CHANNEL_CONTRACT")).toBe(false);
    expect(stayDateFundsAreOperatorFacing(null, "MEMBER_ENTITLEMENT")).toBe(true);
    expect(stayDateFundsAreOperatorFacing(null, "FREE")).toBe(true);
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

  it("uses the SHORTEN_STAY Receipt completion mode for every shared success notice", async () => {
    const receipt = {
      receiptId: "receipt_shorten",
      commandId: "command_shorten",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_shorten",
      result: { completionMode: "EARLY_CHECK_OUT" },
      resourceRefs: [],
      factRefs: [],
      committedAt: "2026-07-29T10:00:00.000Z"
    };
    const notices: string[] = [];

    expect(knownCommittedCommandMessage("SHORTEN_STAY", receipt, "REFRESHED")).toBe("提前退房已完成，订单、住宿状态和房态已刷新。");
    expect(knownCommittedCommandMessage("SHORTEN_STAY", receipt, "REFRESH_FAILED")).toBe("提前退房已完成，但页面刷新失败。请点击页面上的刷新按钮查看最新结果。");
    expect(knownCommittedCommandMessage("SHORTEN_STAY", { ...receipt, result: { completionMode: "SHORTEN_IN_HOUSE" } }, "REFRESHED")).toBe("住宿已缩短，订单和房态已刷新。");

    await notifyKnownCommittedCommand({
      commandType: "SHORTEN_STAY",
      receipt,
      onCommitted: () => undefined,
      onBusinessSuccess: (message) => notices.push(message)
    });
    expect(notices).toEqual(["提前退房已完成，订单、住宿状态和房态已刷新。"]);
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
        stayTimeline: [
          { serviceDate: "2026-08-02", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-03", inventoryUnitId: "room_1" }
        ],
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
      beforeArrivalDate: "2026-08-02",
      beforeDepartureDate: "2026-08-04",
      beforeNights: 2,
      afterArrivalDate: commandType === "RESCHEDULE_STAY" ? "2026-08-03" : "2026-08-02",
      afterDepartureDate: "2026-08-05",
      afterNights: commandType === "RESCHEDULE_STAY" ? 2 : 3,
      afterTimeline: effect.after.stayTimeline,
      beforeAmount: money(20_000),
      policyBaseAmount: money(30_000),
      targetAmount: money(30_000),
      differenceFromPolicy: money(0),
      netRecordedCollection: money(10_000),
      collectionDifference: money(20_000),
      refundReferenceAmount: money(0),
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
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      after: {
        ...effect.after,
        stayTimeline: effect.after.stayTimeline.map((item, index) => (
          index === effect.after.stayTimeline.length - 1 ? { ...item, inventoryUnitId: "room_2" } : item
        ))
      }
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

  it("accepts only a complete SHORTEN_STAY effect and trusts its nonnegative refund reference", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      businessDate: "2026-08-03",
      completionMode: "EARLY_CHECK_OUT",
      before: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        nights: 4,
        currentContractAmount: money(40_000),
        stayTimeline: ["01", "02", "03", "04"].map((day) => ({ serviceDate: `2026-08-${day}`, inventoryUnitId: "room_1" }))
      },
      after: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03",
        nights: 2,
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_1" }
        ],
        pricing: { coverageSet: [], cashLines: [], cashRemainder: money(20_000), currentContractAmount: money(20_000) }
      },
      pricingDecision: {
        pricingBasis: "POLICY",
        policyBaseAmount: money(20_000),
        targetCurrentContractAmount: money(20_000),
        differenceFromPolicy: money(0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "POLICY", note: "" }
      },
      inventoryChange: { preservedDates: ["2026-08-01", "2026-08-02"], releasedDates: ["2026-08-03", "2026-08-04"], addedDates: [] },
      entitlementSummary: { currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0 },
      fundsSummary: { netRecordedCollection: money(30_000), collectionDifference: money(-10_000), factCount: 2 },
      refundReferenceAmount: money(10_000)
    };
    const input = { orderId: "order_1", newDepartureDate: "2026-08-03" };
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", effect, input)).toBe(true);
    const preview = { previewId: "preview_1", commandType: "SHORTEN_STAY", effect, effectHash: "hash", expiresAt: "2026-08-03T12:00:00.000Z" } as Parameters<typeof stayDatePreviewPricingSummary>[1];
    expect(stayDatePreviewPricingSummary("SHORTEN_STAY", preview, input)?.refundReferenceAmount).toEqual(money(10_000));
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, refundReferenceAmount: money(9_999) }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, businessDate: undefined }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, businessDate: "2026-02-30" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, businessDate: "2026-08-02" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      before: { ...effect.before, stayTimeline: undefined }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      after: {
        ...effect.after,
        stayTimeline: effect.after.stayTimeline.map((item) => ({ ...item, inventoryUnitId: "room_forged" }))
      }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, completionMode: "SHORTEN_IN_HOUSE" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, completionMode: "UNKNOWN" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, entitlementSummary: { ...effect.entitlementSummary, ledgerWriteCount: 1 } }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, fundsSummary: { ...effect.fundsSummary, factCount: -1 } }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      fundsSummary: {
        netRecordedCollection: money(2_147_503_648),
        collectionDifference: money(-2_147_483_648),
        factCount: 2
      },
      refundReferenceAmount: money(2_147_483_648)
    }, input)).toBe(false);

    const effectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = {
      orderId: "order_1",
      stayId: "stay_1",
      arrangementAmendmentId: "amendment_arrangement",
      checkoutAmendmentId: "amendment_checkout",
      staySegmentId: "segment_2",
      pricingRevisionId: "revision_2",
      completionMode: "EARLY_CHECK_OUT",
      businessDate: "2026-08-03",
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-03",
      before: effect.before,
      after: effect.after,
      pricingDecision: effect.pricingDecision,
      inventoryChange: effect.inventoryChange,
      entitlementSummary: effect.entitlementSummary,
      fundsSummary: effect.fundsSummary,
      refundReferenceAmount: effect.refundReferenceAmount,
      fulfillmentTiming: {
        effectiveDate: "2026-08-03",
        recordedBusinessDate: "2026-08-03",
        recordingMode: "ON_SCHEDULE"
      },
      effectHash
    };
    const receipt = {
      receiptId: "receipt_shorten",
      commandId: "command_shorten",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_shorten",
      result,
      resourceRefs: [
        "order_1", "stay_1", "amendment_arrangement", "amendment_checkout", "segment_2", "revision_2"
      ],
      factRefs: [],
      committedAt: "2026-08-03T10:00:00.000Z"
    };
    expect(receiptHasCommandEvidence("SHORTEN_STAY", receipt, input, effect, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", {
      ...receipt,
      result: { ...result, businessDate: undefined }
    }, input, effect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", {
      ...receipt,
      result: { ...result, businessDate: "2026-08-02" }
    }, input, effect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", receipt, input, effect,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });

  it("accepts consumed member coverage that preserves its pre-move inventory fact", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_member",
      stayId: "stay_member",
      inventoryUnitId: "room_2",
      businessDate: "2026-08-02",
      completionMode: "SHORTEN_IN_HOUSE",
      before: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        nights: 4,
        currentContractAmount: money(0),
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_2" },
          { serviceDate: "2026-08-03", inventoryUnitId: "room_2" },
          { serviceDate: "2026-08-04", inventoryUnitId: "room_2" }
        ]
      },
      after: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03",
        nights: 2,
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_2" }
        ],
        pricing: {
          coverageSet: [
            { serviceDate: "2026-08-01", inventoryUnitId: "room_1", unitKind: "ROOM_NIGHT", entitlementLotId: "lot_1" },
            { serviceDate: "2026-08-02", inventoryUnitId: "room_1", unitKind: "ROOM_NIGHT", entitlementLotId: "lot_1" }
          ],
          cashLines: [],
          cashRemainder: money(0),
          currentContractAmount: money(0)
        }
      },
      pricingDecision: {
        pricingBasis: "MEMBER_ENTITLEMENT",
        policyBaseAmount: money(0),
        targetCurrentContractAmount: money(0),
        differenceFromPolicy: money(0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "MEMBER_ENTITLEMENT", note: "" }
      },
      inventoryChange: {
        preservedDates: ["2026-08-01", "2026-08-02"],
        releasedDates: ["2026-08-03", "2026-08-04"],
        addedDates: []
      },
      entitlementSummary: {
        currentConsumedCoverageDates: ["2026-08-01", "2026-08-02"],
        retainedHistoricalConsumedCoverageDates: [],
        ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money(0), collectionDifference: money(0), factCount: 0 },
      refundReferenceAmount: money(0)
    };
    const input = { orderId: "order_member", newDepartureDate: "2026-08-03" };

    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", effect, input)).toBe(true);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      pricingDecision: { ...effect.pricingDecision, pricingBasis: "POLICY" }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      after: {
        ...effect.after,
        pricing: {
          ...effect.after.pricing,
          coverageSet: effect.after.pricing.coverageSet.map((item) => ({ ...item, serviceDate: "2026-08-30" }))
        }
      }
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

  it("recomputes the approved Plan B timeline instead of trusting a self-consistent server mapping", () => {
    const beforeTimeline = [
      { serviceDate: "2026-08-10", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-11", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-12", inventoryUnitId: "room_b" },
      { serviceDate: "2026-08-13", inventoryUnitId: "room_b" }
    ];

    expect(planBDateChangeTimeline(beforeTimeline, "2026-08-10", "2026-08-14", "2026-08-12", "2026-08-16"))
      .toEqual([
        { serviceDate: "2026-08-12", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-13", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-14", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-15", inventoryUnitId: "room_b" }
      ]);
    expect(planBDateChangeTimeline(beforeTimeline, "2026-08-10", "2026-08-14", "2026-08-09", "2026-08-15"))
      .toEqual([
        { serviceDate: "2026-08-09", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-10", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-11", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-12", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-13", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-14", inventoryUnitId: "room_b" }
      ]);
    expect(planBDateChangeTimeline(beforeTimeline, "2026-08-10", "2026-08-14", "2026-08-16", "2026-08-18"))
      .toEqual([
        { serviceDate: "2026-08-16", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-17", inventoryUnitId: "room_b" }
      ]);
  });

  it("fails closed for committed stay-date Receipts without complete command evidence", () => {
    const malformedReceipt = {
      receiptId: "receipt_date_change",
      commandId: "command_date_change",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_date_change",
      result: {},
      resourceRefs: [],
      factRefs: [],
      committedAt: "2026-08-01T10:00:00.000Z"
    };

    expect(receiptHasCommandEvidence("RESCHEDULE_STAY", malformedReceipt, { orderId: "order_1" })).toBe(false);
    expect(receiptHasCommandEvidence("EXTEND_STAY", malformedReceipt, { orderId: "order_1" })).toBe(false);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", malformedReceipt, { orderId: "order_1" })).toBe(false);
  });
});
