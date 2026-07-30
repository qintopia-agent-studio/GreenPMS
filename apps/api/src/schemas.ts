import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import {
  bookingChannelCodes,
  commandTypes,
  createOrderPricingBasisCodes,
  errorCauseCodes,
  errorCodes,
  freeStayCategoryCodes,
  fulfillmentRecordingModes,
  historicalRecoverableCommandTypes,
  orderArrangementChangeTypes,
  orderActionCodes,
  orderEffectiveArrangementPresentations,
  orderFulfillmentStates,
  ROOM_STATUS_MAX_QUERY_NIGHTS,
  ROOM_STATUS_OPERATIONAL_TASK_LIMIT,
  recoverableCommandTypes,
  roomStatusActionCodes,
  roomStatusBlockingFactKinds,
  roomStatusOperationalTaskKinds,
  roomStatusSourceKinds,
  roomStatusStatuses,
  stayTypes,
  type CommandType
} from "@qintopia/contracts";

const strictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const commandEnvelope = <C extends CommandType, T extends TProperties>(commandType: C, input: TObject<T>) => strictObject({
  commandType: Type.Literal(commandType),
  input
});

export const Id = Type.String({ minLength: 3, maxLength: 160 });
export const LocalDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
export const DateTime = Type.String({ format: "date-time" });
const OpaqueTokenSecret = Type.String({ minLength: 47, maxLength: 47, pattern: "^qtp_[A-Za-z0-9_-]{43}$" });
const ShortText = Type.String({ minLength: 1, maxLength: 200 });
const Note = Type.String({ minLength: 1, maxLength: 1000 });
const OptionalNote = Type.String({ maxLength: 1000 });
const SafeInteger = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const PositiveAmount = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeWholeYuanAmount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 100 });
const StayChangeTargetAmount = Type.Integer({ minimum: 0, maximum: 2_147_483_600, multipleOf: 100 });
const NonZeroInteger = Type.Union([
  Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: -1 }),
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
]);

export const AccessLevelSchema = Type.Union([Type.Literal("READ"), Type.Literal("WRITE")]);
export const InventoryUnitKindSchema = Type.Union([Type.Literal("ROOM"), Type.Literal("BED")]);
export const EntitlementUnitKindSchema = Type.Union([Type.Literal("ROOM_NIGHT"), Type.Literal("BED_NIGHT")]);
export const StayTypeSchema = Type.Union(stayTypes.map((stayType) => Type.Literal(stayType)));
export const BookingChannelCodeSchema = Type.Union(bookingChannelCodes.map((code) => Type.Literal(code)));
export const FreeStayCategoryCodeSchema = Type.Union(freeStayCategoryCodes.map((code) => Type.Literal(code)));
export const CommandTypeSchema = Type.Union(commandTypes.map((commandType) => Type.Literal(commandType)));
export const RecoverableCommandTypeSchema = Type.Union(recoverableCommandTypes.map((commandType) => Type.Literal(commandType)));
export const HistoricalCommandTypeSchema = Type.Union([
  CommandTypeSchema,
  Type.Literal("PLACE_INTERNAL_USE"),
  Type.Literal("RELEASE_INTERNAL_USE")
]);
export const HistoricalRecoverableCommandTypeSchema = Type.Union(
  historicalRecoverableCommandTypes.map((commandType) => Type.Literal(commandType))
);
export const OrderStatusSchema = Type.Union([
  Type.Literal("RESERVED"), Type.Literal("CHECKED_IN"), Type.Literal("CHECKED_OUT"),
  Type.Literal("CANCELLED"), Type.Literal("NO_SHOW")
]);

export const Money = strictObject({
  currency: Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" }),
  minorUnits: SafeInteger
});
export const NonNegativeMoney = strictObject({
  currency: Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" }),
  minorUnits: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
export const CoverageItem = strictObject({
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  unitKind: EntitlementUnitKindSchema,
  entitlementLotId: Id
});
const NightlyCashLine = strictObject({
  lineKind: Type.Optional(Type.Literal("NIGHT")),
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  amount: Money
});
const StayTotalCashLine = strictObject({
  lineKind: Type.Literal("STAY_TOTAL"),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  inventoryUnitId: Id,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  pricingBandAnchorNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)]),
  calculationSegments: Type.Array(strictObject({
    inventoryUnitId: Id,
    pricingProductCode: ShortText,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1 }),
    anchorAmountMinor: PositiveAmount,
    numeratorMinor: PositiveAmount,
    denominator: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)])
  }), { minItems: 1 }),
  amount: Money
});
export const CashLine = Type.Union([NightlyCashLine, StayTotalCashLine]);
export const AmountSummarySchema = strictObject({
  currentContractAmount: Money,
  netRecordedCollection: Money,
  collectionDifference: Money,
  refundReferenceAmount: NonNegativeMoney
});
export const CommandReasonSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 80 }),
  note: Note
});
const RecordedCommandReasonSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 80 }),
  note: OptionalNote
});

const ErrorDetailsSchema = Type.Union([
  strictObject({ serviceDate: LocalDate, claimId: Id }),
  strictObject({
    inventoryUnitCode: Type.String({ minLength: 1, maxLength: 120 }),
    overlapStartDate: LocalDate,
    overlapEndDate: LocalDate,
    claimIds: Type.Array(Id)
  }),
  strictObject({ causeCode: Type.Union(errorCauseCodes.map((code) => Type.Literal(code))) }),
  strictObject({ expiresOn: LocalDate, asOfDate: LocalDate }),
  strictObject({ businessDate: LocalDate, arrivalDate: LocalDate }),
  strictObject({ businessDate: LocalDate, departureDate: LocalDate }),
  strictObject({ remainingAvailable: SafeInteger }),
  strictObject({ expirationFactId: Id }),
  strictObject({ reversalFactId: Id }),
  strictObject({ activeRefunded: SafeInteger }),
  strictObject({ commandId: Id }),
  strictObject({ activeQuoteCount: Type.String({ pattern: "^\\d+$" }), limit: Type.Integer({ minimum: 1 }) }),
  strictObject({
    availableBalance: Type.String({ pattern: "^-?\\d+$" }),
    minimum: Type.Literal("0"),
    maximum: Type.Literal("2147483647")
  }),
  strictObject({ orderId: Id, serviceDate: LocalDate, coverageId: Id }),
  strictObject({ orderId: Id, serviceDate: LocalDate, activeClaimIds: Type.Array(Id) }),
  strictObject({ cleaningTaskId: Id, status: Type.Union([Type.Literal("PENDING"), Type.Literal("COMPLETED")]) })
]);

export const ErrorResponse = strictObject({
  code: Type.Union(errorCodes.map((code) => Type.Literal(code))),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  retryable: Type.Boolean(),
  commandId: Type.Optional(Id),
  receiptId: Type.Optional(Id),
  details: Type.Optional(ErrorDetailsSchema)
});

export const WriteHeaders = Type.Object({
  "idempotency-key": Type.String({ minLength: 1, maxLength: 160 }),
  "x-correlation-id": Type.String({ minLength: 1, maxLength: 160 })
}, { additionalProperties: true });

const Nickname = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const PrimaryGuestInputSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Nickname,
  phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
});
const PrimaryGuestSnapshotSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Type.Optional(nullable(Nickname)),
  phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
});
const CommandEffectOrderOccupantSchema = strictObject({
  id: Id,
  ordinal: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Nickname,
  phone: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 80 }))),
  documentNumber: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 120 })))
});
const OrderOccupantSchema = strictObject({
  id: Id,
  orderId: Id,
  ordinal: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
  fullName: nullable(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: nullable(Nickname),
  phone: nullable(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: nullable(Type.String({ minLength: 1, maxLength: 120 })),
  createdAt: DateTime
});
const OrderOccupantPriorSnapshotSchema = strictObject({
  fullName: nullable(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: nullable(Nickname),
  phone: nullable(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: nullable(Type.String({ minLength: 1, maxLength: 120 }))
});
const OrderOccupantCorrectedSnapshotSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Nickname,
  phone: nullable(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: nullable(Type.String({ minLength: 1, maxLength: 120 }))
});
const PropertyInput = { propertyId: Id };
const OrderInput = { ...PropertyInput, orderId: Id };

// Read-only compatibility gate for exact replays persisted before nickname became required.
// This schema is never published as the command input contract.
export const HistoricalCreateOrderReplayEnvelopeSchema = strictObject({
  commandType: Type.Literal("CREATE_ORDER"),
  input: strictObject({
    ...PropertyInput,
    quoteId: Id,
    primaryGuest: strictObject({
      fullName: Type.String({ minLength: 1, maxLength: 200 }),
      phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
    }),
    bookingChannelCode: BookingChannelCodeSchema,
    channelOrderReference: Type.Optional(nullable(ShortText)),
    freeStayReason: Type.Optional(Note)
  })
});

export const CommandEnvelopeSchema = Type.Union([
  commandEnvelope("CREATE_MEMBER", strictObject({
    ...PropertyInput,
    fullName: ShortText,
    identityCardNumber: ShortText,
    phone: ShortText,
    wechat: ShortText
  })),
  commandEnvelope("CREATE_MEMBERSHIP_ORDER", strictObject({
    ...PropertyInput,
    memberId: Id,
    membershipProductId: Id,
    agreedPriceMinor: NonNegativeWholeYuanAmount,
    priceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("RECORD_MEMBERSHIP_PAYMENT", strictObject({
    ...PropertyInput,
    membershipOrderId: Id,
    amountMinor: PositiveAmount,
    transactionReference: ShortText,
    note: Type.Optional(OptionalNote)
  })),
  commandEnvelope("CORRECT_MEMBERSHIP_PAYMENT", strictObject({
    ...PropertyInput,
    membershipOrderId: Id,
    originalPaymentFactId: Id,
    correctedAmountMinor: PositiveAmount,
    correctedTransactionReference: ShortText,
    note: Type.Optional(OptionalNote)
  })),
  commandEnvelope("ACTIVATE_MEMBERSHIP_ORDER", strictObject({
    ...PropertyInput,
    membershipOrderId: Id
  })),
  commandEnvelope("CREATE_ORDER", strictObject({
    ...PropertyInput,
    quoteId: Id,
    primaryGuest: PrimaryGuestInputSchema,
    additionalGuests: Type.Optional(Type.Array(PrimaryGuestInputSchema, { maxItems: 999 })),
    bookingChannelCode: Type.Optional(BookingChannelCodeSchema),
    channelOrderReference: Type.Optional(nullable(ShortText)),
    targetCurrentContractAmountMinor: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: 2_147_483_600,
      multipleOf: 100
    })),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note),
    freeStayReason: Type.Optional(Note),
    freeStayCategoryCode: Type.Optional(FreeStayCategoryCodeSchema)
  })),
  commandEnvelope("CORRECT_ORDER_OCCUPANT", strictObject({
    ...OrderInput,
    occupantId: Id,
    expectedPriorSnapshot: OrderOccupantPriorSnapshotSchema,
    correctedSnapshot: OrderOccupantCorrectedSnapshotSchema
  })),
  commandEnvelope("RESCHEDULE_STAY", strictObject({
    ...OrderInput,
    newArrivalDate: LocalDate,
    newDepartureDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("EXTEND_STAY", strictObject({
    ...OrderInput,
    newDepartureDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("SHORTEN_STAY", strictObject({
    ...OrderInput,
    newDepartureDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("MOVE_UNIT", strictObject({ ...OrderInput, newInventoryUnitId: Id, effectiveDate: LocalDate })),
  commandEnvelope("REPRICE_ORDER", strictObject({ ...OrderInput, targetCurrentContractAmountMinor: NonNegativeWholeYuanAmount })),
  commandEnvelope("CANCEL_ORDER", strictObject(OrderInput)),
  commandEnvelope("MARK_NO_SHOW", strictObject(OrderInput)),
  commandEnvelope("LOCK_MAINTENANCE", strictObject({ ...PropertyInput, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate, reason: Note })),
  commandEnvelope("RELEASE_MAINTENANCE", strictObject({ ...PropertyInput, maintenanceLockId: Id })),
  commandEnvelope("COMPLETE_CLEANING", strictObject({ ...PropertyInput, cleaningTaskId: Id })),
  commandEnvelope("RECORD_COLLECTION", strictObject({ ...OrderInput, amountMinor: PositiveAmount, method: ShortText, transactionReference: ShortText, note: Type.Optional(OptionalNote) })),
  commandEnvelope("RECORD_REFUND", strictObject({ ...OrderInput, amountMinor: PositiveAmount, referencesFactId: Id, method: ShortText, transactionReference: ShortText, note: Type.Optional(OptionalNote) })),
  commandEnvelope("REVERSE_FACT", strictObject({ ...OrderInput, reversesFactId: Id, note: Note })),
  commandEnvelope("CHECK_IN", strictObject(OrderInput)),
  commandEnvelope("CHECK_OUT", strictObject(OrderInput)),
  commandEnvelope("REFRESH_MEMBER_COVERAGE", strictObject(OrderInput)),
  commandEnvelope("ADD_MEMBER_ENTITLEMENT_LOT", strictObject({
    ...PropertyInput,
    memberContractId: Id,
    unitKind: EntitlementUnitKindSchema,
    units: PositiveAmount,
    expiresOn: LocalDate
  })),
  commandEnvelope("ADJUST_MEMBER_ENTITLEMENT", strictObject({ ...PropertyInput, entitlementLotId: Id, quantityDelta: NonZeroInteger, adjustmentReason: Note })),
  commandEnvelope("CORRECT_MEMBER_ENTITLEMENT_BALANCE", strictObject({
    ...PropertyInput,
    entitlementLotId: Id,
    targetAvailableBalance: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    expectedAvailableBalance: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    adjustmentReason: Note
  })),
  commandEnvelope("EXPIRE_MEMBER_ENTITLEMENT", strictObject({ ...PropertyInput, entitlementLotId: Id, asOfDate: LocalDate })),
  commandEnvelope("ISSUE_TOKEN", strictObject({
    ...PropertyInput,
    subjectId: Id,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    accessCeiling: AccessLevelSchema,
    expiresAt: DateTime,
    tokenSecret: OpaqueTokenSecret
  })),
  commandEnvelope("ROTATE_TOKEN", strictObject({
    ...PropertyInput,
    tokenId: Id,
    expiresAt: Type.Optional(DateTime),
    tokenSecret: OpaqueTokenSecret
  })),
  commandEnvelope("REVOKE_TOKEN", strictObject({ ...PropertyInput, tokenId: Id }))
]);

const ConfirmBaseProperties = {
  propertyId: Id,
  confirmation: Type.Literal(true),
  expectedEffectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
};
export const ConfirmSchema = Type.Union([
  strictObject({
    ...ConfirmBaseProperties,
    commandType: Type.Literal("CREATE_ORDER"),
    reason: strictObject({ code: Type.Literal("CREATE_STANDARD_ORDER"), note: Type.Literal("") })
  }),
  strictObject({
    ...ConfirmBaseProperties,
    commandType: Type.Union(commandTypes
      .filter((commandType) => commandType !== "CREATE_ORDER")
      .map((commandType) => Type.Literal(commandType))),
    reason: CommandReasonSchema
  })
]);

const InventoryUnitRecordSchema = strictObject({
  id: Id,
  propertyId: Id,
  kind: InventoryUnitKindSchema,
  roomId: Id,
  code: Type.String({ minLength: 1, maxLength: 120 }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  catalogVersion: nullable(ShortText),
  buildingCode: nullable(ShortText),
  roomTypeCode: nullable(ShortText),
  pricingProductCode: nullable(ShortText),
  inventoryBasis: nullable(Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")])),
  codeProvenance: nullable(Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")])),
  physicalBedCount: nullable(Type.Integer({ minimum: 1, maximum: 4 })),
  occupancyCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }))
});
const PricingResultSchema = strictObject({
  coverageSet: Type.Array(CoverageItem),
  cashLines: Type.Array(CashLine),
  cashRemainder: Money,
  currentContractAmount: Money
});
const CreateOrderPricingDecisionSchema = strictObject({
  pricingBasis: Type.Union(createOrderPricingBasisCodes.map((code) => Type.Literal(code))),
  policyBaseAmount: Money,
  targetCurrentContractAmount: Money,
  differenceFromPolicy: Money,
  manualAdjustmentMinor: SafeInteger,
  differenceExceedsThreshold: Type.Boolean(),
  reason: RecordedCommandReasonSchema
});
export const QuoteSchema = strictObject({
  quoteId: Id,
  propertyId: Id,
  inventoryUnitId: Id,
  stayType: StayTypeSchema,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  pricingPolicyVersionId: Id,
  coverageSet: Type.Array(CoverageItem),
  cashLines: Type.Array(CashLine),
  cashRemainder: Money,
  currentContractAmount: Money,
  expiresAt: DateTime,
  memberId: Type.Optional(Id),
  memberContractId: Type.Optional(Id),
  inputHash: Type.String({ minLength: 64, maxLength: 64 })
});

export const QuoteRequestSchema = strictObject({
  propertyId: Id,
  inventoryUnitId: Id,
  stayType: Type.Optional(StayTypeSchema),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  pricingPolicyVersionId: Id,
  memberId: Type.Optional(Id)
});
const StayTimelineItemSchema = strictObject({ serviceDate: LocalDate, inventoryUnitId: Id });
const StayTimelineSchema = Type.Array(StayTimelineItemSchema, { minItems: 1 });
const StayChangeDateDiffSchema = strictObject({
  preservedDates: Type.Array(LocalDate),
  releasedDates: Type.Array(LocalDate),
  addedDates: Type.Array(LocalDate)
});
const StayChangeEntitlementDiffSchema = strictObject({
  preservedCoverageDates: Type.Array(LocalDate),
  releasedCoverageDates: Type.Array(LocalDate),
  addedCoverageDates: Type.Array(LocalDate),
  consumedCoverageDates: Type.Array(LocalDate)
});
const StayChangeFundsSummarySchema = strictObject({
  netRecordedCollection: Money,
  collectionDifference: Money
});
const ShortenStayFundsSummarySchema = strictObject({
  netRecordedCollection: Money,
  collectionDifference: Money,
  factCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
const ShortenStayEntitlementSummarySchema = strictObject({
  currentConsumedCoverageDates: Type.Array(LocalDate),
  retainedHistoricalConsumedCoverageDates: Type.Array(LocalDate),
  ledgerWriteCount: Type.Literal(0)
});

export const CommandEffectSchema = Type.Union([
  strictObject({
    operation: Type.Literal("CREATE_MEMBER_PROFILE"),
    memberId: Type.Null(),
    member: strictObject({
      fullName: ShortText,
      identityCardNumber: ShortText,
      phone: ShortText,
      wechat: ShortText
    }),
    propertyLink: strictObject({ operation: Type.Literal("CREATE") })
  }),
  strictObject({
    operation: Type.Literal("CREATE_MEMBERSHIP_ORDER"),
    member: strictObject({ memberId: Id, fullName: ShortText }),
    product: strictObject({
      productId: Id,
      code: ShortText,
      version: Type.Integer({ minimum: 1 }),
      name: ShortText,
      entitlementUnitKind: EntitlementUnitKindSchema,
      entitlementUnits: Type.Integer({ minimum: 1 }),
      allowedRoomTypeCode: ShortText,
      allowedInventoryKind: InventoryUnitKindSchema
    }),
    pricing: strictObject({
      listedPrice: Money,
      agreedPrice: Money,
      adjustment: Money,
      adjustmentReason: nullable(Note)
    }),
    status: Type.Literal("DRAFT")
  }),
  strictObject({
    operation: Type.Literal("RECORD_MEMBERSHIP_PAYMENT"),
    membershipOrderId: Id,
    memberName: ShortText,
    productName: ShortText,
    payment: strictObject({ amount: Money, transactionReference: ShortText, note: OptionalNote }),
    totals: strictObject({ before: Money, after: Money, agreedPrice: Money, differenceAfter: Money }),
    status: Type.Literal("DRAFT")
  }),
  strictObject({
    operation: Type.Literal("CORRECT_MEMBERSHIP_PAYMENT"),
    membershipOrderId: Id,
    memberName: ShortText,
    productName: ShortText,
    originalPaymentFactId: Id,
    original: strictObject({ amount: Money, transactionReference: ShortText }),
    replacement: strictObject({ amount: Money, transactionReference: ShortText, note: OptionalNote }),
    totals: strictObject({ before: Money, after: Money, agreedPrice: Money, differenceAfter: Money }),
    status: Type.Literal("DRAFT")
  }),
  strictObject({
    operation: Type.Literal("ACTIVATE_MEMBERSHIP_ORDER"),
    membershipOrderId: Id,
    memberName: ShortText,
    productName: ShortText,
    paymentTotal: Money,
    agreedPrice: Money,
    paymentDifference: Money,
    validFrom: LocalDate,
    validUntil: LocalDate,
    entitlementUnitKind: EntitlementUnitKindSchema,
    entitlementUnits: Type.Integer({ minimum: 1 }),
    fromStatus: Type.Literal("DRAFT"),
    toStatus: Type.Literal("ACTIVE")
  }),
  strictObject({
    quoteId: Id,
    primaryGuest: PrimaryGuestSnapshotSchema,
    occupants: Type.Optional(Type.Array(CommandEffectOrderOccupantSchema, { minItems: 1, maxItems: 1000 })),
    occupancyCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    bookingChannelCode: nullable(BookingChannelCodeSchema),
    channelOrderReference: nullable(ShortText),
    freeStayReason: nullable(Note),
    freeStayCategoryCode: nullable(FreeStayCategoryCodeSchema),
    inventoryUnit: InventoryUnitRecordSchema,
    stayType: StayTypeSchema,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    pricingPolicyVersionId: Id,
    memberId: nullable(Id),
    memberContractId: nullable(Id),
    pricingDecision: Type.Optional(CreateOrderPricingDecisionSchema),
    pricing: PricingResultSchema
  }),
  strictObject({
    operation: Type.Literal("CORRECT_ORDER_OCCUPANT"),
    orderId: Id,
    occupantId: Id,
    ordinal: Type.Integer({ minimum: 1 }),
    role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
    before: OrderOccupantPriorSnapshotSchema,
    after: OrderOccupantCorrectedSnapshotSchema
  }),
  strictObject({ inventoryUnit: InventoryUnitRecordSchema, arrivalDate: LocalDate, departureDate: LocalDate, reason: Note }),
  strictObject({ maintenanceLockId: Id, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate }),
  strictObject({
    internalUseBlockId: Id,
    inventoryUnitId: Id,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    reason: Note,
    fromStatus: Type.Literal("ACTIVE"),
    toStatus: Type.Literal("RELEASED")
  }),
  strictObject({
    cleaningTaskId: Id,
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    roomId: Id,
    serviceDate: LocalDate,
    fromStatus: Type.Literal("PENDING"),
    toStatus: Type.Literal("COMPLETED")
  }),
  strictObject({
    entitlementLotId: Id,
    contractId: Id,
    unitKind: EntitlementUnitKindSchema,
    quantityDelta: NonZeroInteger,
    adjustmentReason: Note,
    availableBefore: SafeInteger,
    availableAfter: SafeInteger
  }),
  strictObject({
    contractId: Id,
    unitKind: EntitlementUnitKindSchema,
    units: PositiveAmount,
    expiresOn: LocalDate
  }),
  strictObject({
    entitlementLotId: Id, contractId: Id, unitKind: EntitlementUnitKindSchema, expiresOn: LocalDate,
    asOfDate: LocalDate, remainingAvailable: Type.Integer({ minimum: 0 }), quantityDelta: Type.Integer({ maximum: 0 }), entryType: Type.Literal("EXPIRE")
  }),
  strictObject({ subjectId: Id, label: ShortText, accessCeiling: AccessLevelSchema, expiresAt: DateTime }),
  strictObject({
    tokenId: Id, subjectId: Id, label: ShortText, accessCeiling: AccessLevelSchema, expiresAt: DateTime,
    operation: Type.Union([Type.Literal("ROTATE"), Type.Literal("REVOKE")])
  }),
  strictObject({
    operation: Type.Union([Type.Literal("RESCHEDULE_STAY"), Type.Literal("EXTEND_STAY")]),
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    before: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      currentContractAmount: Money
    }),
    after: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      stayTimeline: StayTimelineSchema,
      pricing: PricingResultSchema
    }),
    pricingDecision: CreateOrderPricingDecisionSchema,
    inventoryChange: StayChangeDateDiffSchema,
    entitlementChange: StayChangeEntitlementDiffSchema,
    fundsSummary: StayChangeFundsSummarySchema
  }),
  strictObject({
    operation: Type.Literal("SHORTEN_STAY"),
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    businessDate: LocalDate,
    completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
    before: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      currentContractAmount: Money
    }),
    after: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      stayTimeline: StayTimelineSchema,
      pricing: PricingResultSchema
    }),
    pricingDecision: CreateOrderPricingDecisionSchema,
    inventoryChange: StayChangeDateDiffSchema,
    entitlementSummary: ShortenStayEntitlementSummarySchema,
    fundsSummary: ShortenStayFundsSummarySchema,
    refundReferenceAmount: NonNegativeMoney
  }),
  strictObject({
    orderId: Id,
    fromInventoryUnit: InventoryUnitRecordSchema,
    toInventoryUnit: InventoryUnitRecordSchema,
    effectiveDate: LocalDate,
    occupantCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    occupancyCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  strictObject({
    orderId: Id,
    inventoryUnitId: Id,
    stayTimeline: StayTimelineSchema,
    before: strictObject({ currentContractAmount: Money }),
    policyBaseAmount: Money,
    targetCurrentContractAmount: Money,
    pricing: PricingResultSchema,
    manualAdjustmentMinor: SafeInteger
  }),
  strictObject({
    orderId: Id,
    inventoryUnitId: Id,
    stayTimeline: StayTimelineSchema,
    before: strictObject({ currentContractAmount: Money }),
    pricing: PricingResultSchema
  }),
  strictObject({ orderId: Id, amountMinor: PositiveAmount, currency: Type.String({ minLength: 3, maxLength: 3 }), method: ShortText, transactionReference: nullable(ShortText), note: OptionalNote }),
  strictObject({ orderId: Id, amountMinor: PositiveAmount, currency: Type.String({ minLength: 3, maxLength: 3 }), referencesFactId: Id, method: ShortText, transactionReference: nullable(ShortText), note: OptionalNote }),
  strictObject({ orderId: Id, reversesFactId: Id, amountMinor: PositiveAmount, netEffectMinor: SafeInteger, currency: Type.String({ minLength: 3, maxLength: 3 }), note: Note }),
  strictObject({
    orderId: Id,
    fromStatus: OrderStatusSchema,
    toStatus: OrderStatusSchema,
    inventoryUnitId: Id,
    businessDate: Type.Optional(LocalDate),
    effectiveDate: Type.Optional(LocalDate),
    recordingMode: Type.Optional(Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])),
    freeStayReason: Type.Optional(nullable(Note)),
    freeStayCategoryCode: Type.Optional(nullable(FreeStayCategoryCodeSchema)),
    currentContractAmount: Type.Optional(Money),
    amounts: Type.Optional(AmountSummarySchema),
    cleaningTask: Type.Optional(strictObject({
      inventoryUnitId: Id,
      serviceDate: LocalDate,
      status: Type.Literal("PENDING")
    })),
    entitlementTransition: Type.Optional(strictObject({
      from: Type.Literal("HELD"),
      to: Type.Union([Type.Literal("CONSUMED"), Type.Literal("RELEASED")]),
      coverageCount: Type.Integer({ minimum: 0 })
    }))
  })
]);

export const PreviewSchema = strictObject({
  previewId: Id,
  commandType: HistoricalCommandTypeSchema,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: CommandEffectSchema,
  expiresAt: DateTime
});

const CreateOrderResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  segmentId: Id,
  pricingRevisionId: Id,
  pricingPolicyVersionId: Type.Optional(Id),
  primaryGuest: nullable(PrimaryGuestSnapshotSchema),
  occupants: Type.Optional(Type.Array(OrderOccupantSchema, { minItems: 1, maxItems: 1000 })),
  bookingChannelCode: nullable(BookingChannelCodeSchema),
  channelOrderReference: nullable(ShortText),
  freeStayReason: nullable(Note),
  freeStayCategoryCode: nullable(FreeStayCategoryCodeSchema),
  pricingDecision: Type.Optional(CreateOrderPricingDecisionSchema)
});
const CorrectOrderOccupantResultSchema = strictObject({
  orderId: Id,
  occupantId: Id,
  correctionId: Id,
  amendmentId: Id,
  occupant: OrderOccupantCorrectedSnapshotSchema
});
const CreateMemberResultSchema = strictObject({
  memberId: Id,
  memberCreated: Type.Literal(true)
});
const MaintenanceLockResultSchema = strictObject({ maintenanceLockId: Id });
const MaintenanceReleaseResultSchema = strictObject({ maintenanceLockId: Id, status: Type.Literal("RELEASED") });
const InternalUsePlacementResultSchema = strictObject({
  internalUseBlockId: Id,
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  status: Type.Literal("ACTIVE")
});
const InternalUseReleaseResultSchema = strictObject({ internalUseBlockId: Id, status: Type.Literal("RELEASED") });
const CleaningCompletionResultSchema = strictObject({ cleaningTaskId: Id, status: Type.Literal("COMPLETED") });
const EntitlementAdjustmentResultSchema = strictObject({
  entitlementLotId: Id,
  adjustmentFactId: Id,
  availableBefore: SafeInteger,
  availableAfter: SafeInteger,
  quantityDelta: NonZeroInteger
});
const EntitlementLotAddedResultSchema = strictObject({ entitlementLotId: Id, contractId: Id, adjustmentFactId: Id, units: PositiveAmount });
const EntitlementExpirationResultSchema = strictObject({
  entitlementLotId: Id,
  contractId: Id,
  factId: Id,
  entryType: Type.Literal("EXPIRE"),
  expiredUnits: Type.Integer({ minimum: 0 }),
  remainingAvailable: Type.Literal(0),
  asOfDate: LocalDate
});
const TokenIssueResultSchema = strictObject({
  tokenId: Id,
  subjectId: Id,
  accessCeiling: AccessLevelSchema,
  expiresAt: DateTime
});
const TokenRotationResultSchema = strictObject({
  tokenId: Id,
  rotatedFromTokenId: Id,
  subjectId: Id,
  accessCeiling: AccessLevelSchema,
  expiresAt: DateTime
});
const TokenRevocationResultSchema = strictObject({ tokenId: Id, revoked: Type.Literal(true) });
const StayChangeResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementChange: StayChangeEntitlementDiffSchema,
  fundsSummary: StayChangeFundsSummarySchema
});
const ShortenStayResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  arrangementAmendmentId: Id,
  checkoutAmendmentId: nullable(Id),
  staySegmentId: Id,
  pricingRevisionId: Id,
  completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementSummary: ShortenStayEntitlementSummarySchema,
  fundsSummary: ShortenStayFundsSummarySchema,
  refundReferenceAmount: NonNegativeMoney,
  fulfillmentTiming: nullable(strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Literal("ON_SCHEDULE")
  }))
});
const MoveUnitResultSchema = strictObject({
  orderId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id
});
const RepriceResultSchema = strictObject({
  orderId: Id, amendmentId: Id, pricingRevisionId: Id,
  policyBaseAmount: Money,
  targetCurrentContractAmount: Money,
  manualAdjustmentMinor: SafeInteger
});
const CoverageRefreshResultSchema = strictObject({ orderId: Id, amendmentId: Id, pricingRevisionId: Id });
const CollectionFactResultSchema = strictObject({
  orderId: Id,
  factId: Id,
  factType: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  netEffectMinor: SafeInteger,
  transactionReference: nullable(ShortText)
});
const OrderStatusResultSchema = strictObject({
  orderId: Id,
  amendmentId: Id,
  status: OrderStatusSchema,
  pricingRevisionId: Type.Optional(Id),
  cleaningTaskId: Type.Optional(Id),
  fulfillmentTiming: Type.Optional(strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
  })),
  entitlementTransition: Type.Optional(strictObject({
    from: Type.Literal("HELD"),
    to: Type.Union([Type.Literal("CONSUMED"), Type.Literal("RELEASED")]),
    coverageCount: Type.Integer({ minimum: 0 })
  }))
});
const PreviewReceiptResultSchema = strictObject({ preview: PreviewSchema });
const QuoteReceiptResultSchema = strictObject({ quote: QuoteSchema });
const MembershipOrderCreatedResultSchema = strictObject({
  membershipOrderId: Id,
  status: Type.Literal("DRAFT")
});
const MembershipPaymentRecordedResultSchema = strictObject({
  membershipOrderId: Id,
  paymentFactId: Id,
  status: Type.Literal("DRAFT")
});
const MembershipPaymentCorrectedResultSchema = strictObject({
  membershipOrderId: Id,
  originalPaymentFactId: Id,
  reversalFactId: Id,
  replacementFactId: Id,
  status: Type.Literal("DRAFT")
});
const MembershipOrderActivatedResultSchema = strictObject({
  membershipOrderId: Id,
  status: Type.Literal("ACTIVE"),
  contractId: Id,
  entitlementLotId: Id,
  validFrom: LocalDate,
  validUntil: LocalDate,
  entitlementUnits: Type.Integer({ minimum: 1 })
});

export const ExecutedCommandResultSchema = Type.Union([
  QuoteReceiptResultSchema,
  CreateMemberResultSchema,
  MembershipOrderCreatedResultSchema,
  MembershipPaymentRecordedResultSchema,
  MembershipPaymentCorrectedResultSchema,
  MembershipOrderActivatedResultSchema,
  CreateOrderResultSchema,
  CorrectOrderOccupantResultSchema,
  MaintenanceLockResultSchema,
  MaintenanceReleaseResultSchema,
  InternalUsePlacementResultSchema,
  InternalUseReleaseResultSchema,
  CleaningCompletionResultSchema,
  EntitlementAdjustmentResultSchema,
  EntitlementLotAddedResultSchema,
  EntitlementExpirationResultSchema,
  TokenIssueResultSchema,
  TokenRotationResultSchema,
  TokenRevocationResultSchema,
  StayChangeResultSchema,
  ShortenStayResultSchema,
  MoveUnitResultSchema,
  RepriceResultSchema,
  CoverageRefreshResultSchema,
  CollectionFactResultSchema,
  OrderStatusResultSchema,
  PreviewReceiptResultSchema
]);

export const ReceiptSchema = strictObject({
  receiptId: Id,
  commandId: Id,
  executionStatus: Type.Union([Type.Literal("EXECUTED"), Type.Literal("NOT_EXECUTED"), Type.Literal("UNKNOWN")]),
  businessCommitted: Type.Boolean(),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  result: Type.Optional(ExecutedCommandResultSchema),
  error: Type.Optional(ErrorResponse),
  resourceRefs: Type.Array(Id),
  factRefs: Type.Array(Id),
  committedAt: Type.Optional(DateTime)
});

export const QuoteCommandResponseSchema = strictObject({
  quote: QuoteSchema,
  receipt: ReceiptSchema
});

export const CommandResultRecoverySchema = Type.Union([
  ReceiptSchema,
  strictObject({ executionStatus: Type.Literal("NOT_EXECUTED"), businessCommitted: Type.Literal(false) }),
  strictObject({
    executionStatus: Type.Literal("UNKNOWN"),
    businessCommitted: Type.Literal(false),
    commandId: Type.Optional(Id),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 }))
  })
]);

export const AvailabilityUnitSchema = strictObject({
  id: Id,
  propertyId: Id,
  kind: InventoryUnitKindSchema,
  roomId: Id,
  code: Type.String({ minLength: 1, maxLength: 120 }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  catalogVersion: nullable(ShortText),
  buildingCode: nullable(ShortText),
  roomTypeCode: nullable(ShortText),
  pricingProductCode: nullable(ShortText),
  inventoryBasis: nullable(Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")])),
  codeProvenance: nullable(Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")])),
  physicalBedCount: nullable(Type.Integer({ minimum: 1, maximum: 4 })),
  occupancyCapacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  nights: Type.Array(strictObject({
    serviceDate: LocalDate,
    available: Type.Boolean(),
    blockingClaimIds: Type.Array(Id)
  })),
  available: Type.Boolean()
});

export const RoomStatusStatusSchema = Type.Union(roomStatusStatuses.map((status) => Type.Literal(status)));
export const RoomStatusSourceKindSchema = Type.Union(roomStatusSourceKinds.map((kind) => Type.Literal(kind)));
export const RoomStatusActionCodeSchema = Type.Union(roomStatusActionCodes.map((code) => Type.Literal(code)));
export const RoomStatusOperationalTaskKindSchema = Type.Union(roomStatusOperationalTaskKinds.map((kind) => Type.Literal(kind)));
export const RoomStatusSalesModeSchema = Type.Union([
  Type.Literal("WHOLE_ROOM"), Type.Literal("BED_SPLIT"), Type.Literal("UNAVAILABLE")
]);
export const RoomStatusQuerySchema = strictObject({
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  page: Type.Optional(Type.Integer({ minimum: 0 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  roomType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  salesMode: Type.Optional(RoomStatusSalesModeSchema),
  status: Type.Optional(RoomStatusStatusSchema),
  minCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  unitKind: Type.Optional(InventoryUnitKindSchema)
});
const RoomStatusDisplayText = Type.String({ minLength: 1 });
export const RoomStatusReferenceSchema = strictObject({
  type: Type.Union([
    Type.Literal("CLAIM"), Type.Literal("ORDER"), Type.Literal("STAY"), Type.Literal("OPERATIONS"),
    Type.Literal("BLOCK"), Type.Literal("INVENTORY_UNIT"), Type.Literal("RECEIPT")
  ]),
  id: Id,
  label: RoomStatusDisplayText,
  href: nullable(Type.String({ minLength: 1, maxLength: 500 }))
});
export const RoomStatusActionSchema = strictObject({
  code: RoomStatusActionCodeSchema,
  enabled: Type.Boolean(),
  disabledReason: nullable(Type.String({ minLength: 1, maxLength: 1000 })),
  requiresFullInterval: Type.Boolean(),
  targetReference: nullable(RoomStatusReferenceSchema)
});
export const RoomStatusHistorySchema = strictObject({
  action: Type.String({ minLength: 1, maxLength: 200 }),
  actorId: nullable(Id),
  source: Type.Union([Type.Literal("WEB_SESSION"), Type.Literal("API_TOKEN"), Type.Literal("SYSTEM"), Type.Literal("UNKNOWN")]),
  occurredAt: DateTime,
  commandId: nullable(Id),
  receiptId: nullable(Id),
  correlationId: nullable(Type.String({ minLength: 1, maxLength: 160 }))
});
export const RoomStatusConflictSchema = strictObject({
  id: Id,
  blockingFactKind: Type.Union(roomStatusBlockingFactKinds.map((kind) => Type.Literal(kind))),
  claimId: nullable(Id),
  claimIds: Type.Array(Id),
  requestedInventoryUnitId: Id,
  actualInventoryUnitId: Id,
  roomId: Id,
  startDate: LocalDate,
  endDate: LocalDate,
  sourceKind: RoomStatusSourceKindSchema,
  sourceReference: RoomStatusReferenceSchema,
  reason: RoomStatusDisplayText,
  blocking: Type.Literal(true)
});
export const RoomStatusOccupantSchema = strictObject({
  occupantId: Id,
  nickname: nullable(RoomStatusDisplayText)
});
export const RoomStatusIntervalSchema = strictObject({
  id: Id,
  displayInventoryUnitId: Id,
  actualInventoryUnitId: Id,
  roomId: Id,
  startDate: LocalDate,
  endDate: LocalDate,
  sourceStartDate: LocalDate,
  sourceEndDate: LocalDate,
  status: RoomStatusStatusSchema,
  available: Type.Boolean(),
  blocking: Type.Boolean(),
  sourceKind: RoomStatusSourceKindSchema,
  label: RoomStatusDisplayText,
  primaryOccupantLabel: nullable(ShortText),
  occupantCount: Type.Integer({ minimum: 0, maximum: 1000 }),
  occupants: Type.Array(RoomStatusOccupantSchema, { maxItems: 1000 }),
  reason: nullable(RoomStatusDisplayText),
  claimIds: Type.Array(Id),
  references: Type.Array(RoomStatusReferenceSchema),
  conflicts: Type.Array(RoomStatusConflictSchema),
  history: Type.Array(RoomStatusHistorySchema),
  allowedActions: Type.Array(RoomStatusActionSchema)
});
export const RoomStatusOperationalTaskSchema = strictObject({
  taskKind: RoomStatusOperationalTaskKindSchema,
  businessDate: LocalDate,
  id: Id,
  displayInventoryUnitId: Id,
  actualInventoryUnitId: Id,
  roomId: Id,
  startDate: LocalDate,
  endDate: LocalDate,
  sourceStartDate: LocalDate,
  sourceEndDate: LocalDate,
  status: RoomStatusStatusSchema,
  available: Type.Boolean(),
  blocking: Type.Boolean(),
  sourceKind: RoomStatusSourceKindSchema,
  label: RoomStatusDisplayText,
  primaryOccupantLabel: nullable(ShortText),
  occupantCount: Type.Integer({ minimum: 0, maximum: 1000 }),
  occupants: Type.Array(RoomStatusOccupantSchema, { maxItems: 1000 }),
  reason: nullable(RoomStatusDisplayText),
  claimIds: Type.Array(Id),
  references: Type.Array(RoomStatusReferenceSchema),
  conflicts: Type.Array(RoomStatusConflictSchema),
  history: Type.Array(RoomStatusHistorySchema),
  allowedActions: Type.Array(RoomStatusActionSchema)
});
export const RoomStatusDaySchema = strictObject({
  serviceDate: LocalDate,
  status: RoomStatusStatusSchema,
  available: Type.Boolean(),
  intervalIds: Type.Array(Id),
  conflicts: Type.Array(RoomStatusConflictSchema)
});
export const RoomStatusBedOccupantSchema = strictObject({
  occupantId: Id,
  inventoryUnitId: Id,
  inventoryUnitCode: RoomStatusDisplayText,
  primaryOccupantLabel: nullable(ShortText),
  sourceReference: strictObject({
    type: Type.Literal("ORDER"),
    id: Id,
    label: RoomStatusDisplayText,
    href: nullable(Type.String({ minLength: 1, maxLength: 500 }))
  })
});
export const RoomStatusBedOccupancySchema = strictObject({
  serviceDate: LocalDate,
  occupiedBedCount: Type.Integer({ minimum: 1 }),
  totalBedCount: Type.Integer({ minimum: 1 }),
  occupants: Type.Array(RoomStatusBedOccupantSchema, { minItems: 1 })
});
const RoomStatusUnitBase = {
  id: Id,
  propertyId: Id,
  roomId: Id,
  code: RoomStatusDisplayText,
  name: RoomStatusDisplayText,
  active: Type.Boolean(),
  salesMode: RoomStatusSalesModeSchema,
  buildingCode: nullable(ShortText),
  roomTypeCode: nullable(ShortText),
  pricingProductCode: nullable(ShortText),
  capacity: Type.Integer({ minimum: 1 }),
  occupancyCapacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  childUnitIds: Type.Array(Id),
  bedOccupancies: Type.Array(RoomStatusBedOccupancySchema),
  days: Type.Array(RoomStatusDaySchema),
  intervals: Type.Array(RoomStatusIntervalSchema),
  conflicts: Type.Array(RoomStatusConflictSchema),
  allowedActions: Type.Array(RoomStatusActionSchema)
};
const RoomStatusBedUnitSchema = strictObject({
  ...RoomStatusUnitBase,
  parentRoomId: Id,
  kind: Type.Literal("BED"),
  children: Type.Array(Type.Never(), { maxItems: 0 })
});
export const RoomStatusUnitSchema = strictObject({
  ...RoomStatusUnitBase,
  parentRoomId: Type.Null(),
  kind: Type.Literal("ROOM"),
  children: Type.Array(RoomStatusBedUnitSchema)
});
export const RoomStatusBoardSchema = strictObject({
  propertyId: Id,
  businessDate: LocalDate,
  range: strictObject({ arrivalDate: LocalDate, departureDate: LocalDate }),
  dates: Type.Array(LocalDate, { maxItems: ROOM_STATUS_MAX_QUERY_NIGHTS }),
  asOf: DateTime,
  freshUntil: DateTime,
  revision: Type.String({ minLength: 1, maxLength: 80, pattern: "^\\d+$" }),
  accessLevel: AccessLevelSchema,
  projectionState: Type.Union([Type.Literal("READY"), Type.Literal("PARTIAL")]),
  filterOptions: strictObject({
    roomTypeCodes: Type.Array(ShortText),
    salesModes: Type.Array(RoomStatusSalesModeSchema),
    statuses: Type.Array(RoomStatusStatusSchema),
    capacities: Type.Array(Type.Integer({ minimum: 1 })),
    unitKinds: Type.Array(InventoryUnitKindSchema)
  }),
  page: strictObject({
    index: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 1, maximum: 200 }),
    totalRooms: Type.Integer({ minimum: 0 }),
    totalPages: Type.Integer({ minimum: 0 })
  }),
  operationalTasks: Type.Array(RoomStatusOperationalTaskSchema, { maxItems: ROOM_STATUS_OPERATIONAL_TASK_LIMIT }),
  rooms: Type.Array(RoomStatusUnitSchema)
});

export const LoginSchema = strictObject({
  username: Type.String({ minLength: 1, maxLength: 120 }),
  password: Type.String({ minLength: 1, maxLength: 200 })
});
export const LoginResponseSchema = strictObject({ subjectId: Id, displayName: ShortText, expiresAt: DateTime });
export const MeResponseSchema = strictObject({
  subjectId: Id,
  displayName: ShortText,
  credentialType: Type.Union([Type.Literal("SESSION"), Type.Literal("TOKEN")]),
  propertyAccess: Type.Record(Type.String({ minLength: 3, maxLength: 160 }), AccessLevelSchema)
});

const PropertyRowSchema = strictObject({
  id: Id, code: ShortText, name: ShortText, timezone: ShortText,
  currency: Type.String({ minLength: 3, maxLength: 3 }), created_at: DateTime
});
const InventoryUnitRowSchema = strictObject({
  id: Id, property_id: Id, kind: InventoryUnitKindSchema, parent_room_id: nullable(Id), code: ShortText,
  name: ShortText, active: Type.Boolean(), catalog_version: nullable(ShortText), building_code: nullable(ShortText),
  room_type_code: nullable(ShortText), pricing_product_code: nullable(ShortText),
  inventory_basis: nullable(Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")])),
  code_provenance: nullable(Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")])),
  physical_bed_count: nullable(Type.Integer({ minimum: 1, maximum: 4 })),
  occupancy_capacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  created_at: DateTime
});
const PricingPolicyRowSchema = strictObject({
  id: Id, property_id: Id, code: ShortText, version: Type.Integer({ minimum: 1 }), stay_type: nullable(StayTypeSchema),
  calculation_kind: Type.Union([Type.Literal("FLAT_NIGHTLY"), Type.Literal("DURATION_BAND_TOTAL"), Type.Literal("FREE")]),
  nightly_rate_minor: nullable(Type.Integer({ minimum: 0 })),
  product_anchor_rates_minor: nullable(Type.Record(Type.String({ minLength: 1, maxLength: 200 }), strictObject({ "1": PositiveAmount, "7": PositiveAmount, "14": PositiveAmount, "30": PositiveAmount }))),
  effective_from: nullable(LocalDate), effective_until: nullable(LocalDate),
  rounding_rule: nullable(Type.Literal("FINAL_TOTAL_WHOLE_YUAN_HALF_UP")),
  currency: Type.String({ minLength: 3, maxLength: 3 }), status: Type.Literal("PUBLISHED"), created_at: DateTime
});
const MemberContractRowSchema = strictObject({
  id: Id, property_id: Id, member_id: nullable(Id), member_name: ShortText,
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("EXPIRED")]),
  valid_from: LocalDate, valid_until: LocalDate, version: Type.Integer({ minimum: 1 }), created_at: DateTime
});
const MemberRowSchema = strictObject({
  id: Id,
  identity_card_number: ShortText,
  full_name: ShortText,
  phone: ShortText,
  wechat: ShortText,
  created_at: DateTime
});

export const MetaResponseSchema = strictObject({
  properties: Type.Array(PropertyRowSchema),
  inventoryUnits: Type.Array(InventoryUnitRowSchema),
  pricingPolicyVersions: Type.Array(PricingPolicyRowSchema),
  members: Type.Array(MemberRowSchema),
  memberContracts: Type.Array(MemberContractRowSchema)
});

const ReferenceExecutionStateSchema = Type.Literal("REFERENCE_ONLY");
const ReferenceCurrencySchema = Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" });
const ReferenceSourceSchema = {
  sourceSheet: ShortText,
  sourceRange: Type.String({ minLength: 1, maxLength: 200 })
};
const ReferenceCatalogBatchSchema = strictObject({
  id: Id,
  propertyId: Id,
  sourceRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  sourceVersionDate: nullable(LocalDate),
  contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  executionState: ReferenceExecutionStateSchema,
  createdAt: DateTime
});
const ReferenceInventoryCatalogEntrySchema = strictObject({
  id: Id,
  typeCode: ShortText,
  typeName: ShortText,
  bathroomType: Type.Union([Type.Literal("SHARED"), Type.Literal("ENSUITE")]),
  sellUnitKind: InventoryUnitKindSchema,
  physicalRoomCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  physicalBedCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  unitsPerRoom: nullable(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  sellableUnitCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  separateElectricityCharge: Type.Literal(false),
  executionState: ReferenceExecutionStateSchema,
  ...ReferenceSourceSchema
});
const ReferencePhysicalRoomSchema = strictObject({
  operationalCode: ShortText,
  buildingCode: ShortText,
  roomTypeKey: ShortText,
  sourceCode: nullable(ShortText),
  sourceLabel: ShortText,
  codeProvenance: Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")]),
  physicalBedCount: Type.Integer({ minimum: 1, maximum: 4 }),
  physicalBedCodes: nullable(Type.Array(Type.String({ minLength: 1, maxLength: 4 }), { minItems: 2, maxItems: 4, uniqueItems: true })),
  saleMode: Type.Union([Type.Literal("INDEPENDENT_ROOM"), Type.Literal("BED_WITH_WHOLE_ROOM_COMBINATION")])
});
const ReferencePricingRuleSchema = strictObject({
  code: ShortText,
  version: Type.Integer({ minimum: 1 }),
  calculationKind: Type.Literal("DURATION_BAND_TOTAL"),
  effectiveFrom: LocalDate,
  effectiveUntil: Type.Null(),
  transientMaximumNightsExclusive: Type.Literal(7),
  bands: Type.Array(strictObject({
    minimumNights: Type.Integer({ minimum: 1 }),
    maximumNightsExclusive: nullable(Type.Integer({ minimum: 2 })),
    anchorNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)])
  }), { minItems: 4, maxItems: 4 }),
  rounding: strictObject({
    stage: Type.Literal("FINAL_STAY_TOTAL"),
    unit: Type.Literal("CNY_YUAN"),
    mode: Type.Literal("HALF_UP_POSITIVE")
  }),
  shorteningBasis: Type.Literal("FULL_STAY_FROM_ORIGINAL_ARRIVAL"),
  extensionBasis: Type.Literal("FULL_STAY_FROM_ORIGINAL_ARRIVAL"),
  crossCalendarMonthTreatment: Type.Literal("NO_SPLIT"),
  antiInversionRule: Type.Literal("NONE"),
  separateElectricityCharge: Type.Literal(false)
});
const ReferencePricingProductSchema = strictObject({
  productCode: ShortText,
  roomTypeKey: ShortText,
  inventoryUnitKind: InventoryUnitKindSchema,
  anchorMultiplier: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(4)]),
  anchorsMinor: strictObject({
    "1": PositiveAmount,
    "7": PositiveAmount,
    "14": PositiveAmount,
    "30": PositiveAmount
  }),
  derivation: Type.Union([Type.Literal("SOURCE_PUBLISHED"), Type.Literal("BED_ANCHORS_TIMES_PHYSICAL_BEDS")])
});
const ReferenceRateSchema = strictObject({
  id: Id,
  inventoryCatalogEntryId: Id,
  packageNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)]),
  packageAmountMinor: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  currency: ReferenceCurrencySchema,
  executionState: ReferenceExecutionStateSchema,
  ...ReferenceSourceSchema
});
const ReferenceMembershipProductSchema = strictObject({
  id: Id,
  inventoryCatalogEntryId: Id,
  code: ShortText,
  name: ShortText,
  priceMinor: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  currency: ReferenceCurrencySchema,
  salesLimit: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  entitlementNights: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  validityPeriod: Type.String({ minLength: 2, maxLength: 80, pattern: "^P" }),
  executionState: ReferenceExecutionStateSchema,
  terms: strictObject({
    entitlementUnit: EntitlementUnitKindSchema,
    quotaMeaning: Type.Literal("MEMBERSHIP_SLOTS_NOT_INVENTORY"),
    validityStartsAt: Type.Literal("PAYMENT_DATE"),
    membershipRules: strictObject({
      bookingRule: Type.String({ minLength: 1, maxLength: 1000 }),
      refundPolicy: Type.Literal("NON_REFUNDABLE_MEMBERSHIP"),
      refundRule: Type.String({ minLength: 1, maxLength: 1000 }),
      overriddenSourceRefundRule: Type.String({ minLength: 1, maxLength: 1000 }),
      refundCalculation: Type.Null(),
      sourceRange: Type.String({ minLength: 1, maxLength: 200 })
    })
  }),
  ...ReferenceSourceSchema
});

export const ReferenceCatalogResponseSchema = strictObject({
  batch: ReferenceCatalogBatchSchema,
  inventoryEntries: Type.Array(ReferenceInventoryCatalogEntrySchema),
  rates: Type.Array(ReferenceRateSchema),
  rooms: Type.Array(ReferencePhysicalRoomSchema),
  pricingRule: ReferencePricingRuleSchema,
  pricingProducts: Type.Array(ReferencePricingProductSchema),
  rejectedSourceFigures: Type.Array(strictObject({ name: ShortText, value: SafeInteger, reason: Note })),
  membershipProducts: Type.Array(ReferenceMembershipProductSchema),
  unresolvedIssues: Type.Array(strictObject({
    code: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.String({ minLength: 1, maxLength: 1000 })
  }))
});

export const OrderRowSchema = strictObject({
  id: Id,
  property_id: Id,
  status: OrderStatusSchema,
  stay_type: StayTypeSchema,
  arrival_date: LocalDate,
  departure_date: LocalDate,
  primary_guest_snapshot: PrimaryGuestSnapshotSchema,
  booking_channel_code: nullable(BookingChannelCodeSchema),
  channel_order_reference: nullable(ShortText),
  free_stay_reason: nullable(Note),
  free_stay_category_code: nullable(FreeStayCategoryCodeSchema),
  pricing_policy_version_id: Id,
  member_id: nullable(Id),
  member_contract_id: nullable(Id),
  current_revision_id: nullable(Id),
  version: Type.Integer({ minimum: 1 }),
  created_at: DateTime,
  updated_at: DateTime
});
export const OrdersListResponseSchema = strictObject({ orders: Type.Array(OrderRowSchema) });

const StaySegmentRowSchema = strictObject({
  id: Id, stay_id: Id, sequence: Type.Integer({ minimum: 1 }), inventory_unit_id: Id,
  arrival_date: LocalDate, departure_date: LocalDate, segment_type: ShortText,
  supersedes_segment_id: nullable(Id), amendment_id: Id, created_at: DateTime
});
const CreateOrderAmendmentPayloadSchema = strictObject({
  quoteId: Id,
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  primaryGuest: Type.Optional(PrimaryGuestSnapshotSchema),
  occupants: Type.Optional(Type.Array(CommandEffectOrderOccupantSchema, { minItems: 1, maxItems: 1000 })),
  bookingChannelCode: Type.Optional(nullable(BookingChannelCodeSchema)),
  channelOrderReference: Type.Optional(nullable(ShortText)),
  freeStayReason: Type.Optional(nullable(Note)),
  freeStayCategoryCode: Type.Optional(nullable(FreeStayCategoryCodeSchema)),
  pricingDecision: Type.Optional(CreateOrderPricingDecisionSchema)
});
const AmendmentRowSchema = strictObject({
  id: Id, order_id: Id, sequence: Type.Integer({ minimum: 1 }), amendment_type: CommandTypeSchema,
  reason_code: Type.String({ minLength: 1, maxLength: 80 }), reason_note: OptionalNote,
  prior_version: Type.Integer({ minimum: 0 }), new_version: Type.Integer({ minimum: 1 }),
  payload: Type.Union([CreateOrderAmendmentPayloadSchema, CommandEffectSchema]),
  command_id: nullable(Id),
  actor: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  created_at: DateTime
});
const PricingRevisionRowSchema = strictObject({
  id: Id, order_id: Id, revision_no: Type.Integer({ minimum: 1 }), amendment_id: Id, policy_version_id: Id,
  arrival_date: LocalDate, departure_date: LocalDate, coverage_set: Type.Array(CoverageItem), cash_lines: Type.Array(CashLine),
  policy_base_amount_minor: SafeInteger,
  pricing_basis: Type.Union(createOrderPricingBasisCodes.map((code) => Type.Literal(code))),
  manual_adjustment_minor: SafeInteger,
  current_contract_amount_minor: SafeInteger,
  difference_from_policy_minor: SafeInteger,
  reason: RecordedCommandReasonSchema,
  currency: Type.String({ minLength: 3, maxLength: 3 }), created_at: DateTime
});
const CoverageRowSchema = strictObject({
  id: Id, order_id: Id, contract_id: Id, lot_id: Id, inventory_unit_id: Id, service_date: LocalDate,
  unit_kind: EntitlementUnitKindSchema,
  status: Type.Union([Type.Literal("HELD"), Type.Literal("CONSUMED"), Type.Literal("RELEASED")]),
  held_by_revision_id: Id, created_at: DateTime, updated_at: DateTime
});
const CleaningTaskSummarySchema = strictObject({
  id: Id,
  inventoryUnitId: Id,
  serviceDate: LocalDate,
  status: Type.Union([Type.Literal("PENDING"), Type.Literal("COMPLETED")]),
  createdAt: DateTime,
  completedAt: nullable(DateTime),
  createdBy: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  completedBy: nullable(strictObject({ subjectId: Id, displayName: ShortText }))
});
const OrderFulfillmentRecordProperties = {
  plannedBusinessDate: LocalDate,
  recordedBusinessDate: nullable(LocalDate),
  recordingMode: Type.Union(fulfillmentRecordingModes.map((mode) => Type.Literal(mode))),
  recordedAt: DateTime,
  actor: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  reason: strictObject({ code: ShortText, note: Note })
};
const CheckInFulfillmentRecordSchema = strictObject({
  type: Type.Literal("CHECK_IN"),
  ...OrderFulfillmentRecordProperties
});
const CheckOutFulfillmentRecordSchema = strictObject({
  type: Type.Literal("CHECK_OUT"),
  ...OrderFulfillmentRecordProperties
});
const OrderFulfillmentProjectionSchema = strictObject({
  state: Type.Union(orderFulfillmentStates.map((state) => Type.Literal(state))),
  checkIn: nullable(CheckInFulfillmentRecordSchema),
  checkOut: nullable(CheckOutFulfillmentRecordSchema)
});
const OrderArrangementIntervalSchema = strictObject({
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate
});
const OrderArrangementSchema = strictObject({
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  intervals: Type.Array(OrderArrangementIntervalSchema, { minItems: 1 })
});
const OrderEffectiveArrangementSchema = strictObject({
  ...OrderArrangementSchema.properties,
  presentation: Type.Union(orderEffectiveArrangementPresentations.map((presentation) => Type.Literal(presentation))),
  businessDate: LocalDate
});
const OrderArrangementHistoryItemSchema = strictObject({
  type: Type.Union(orderArrangementChangeTypes.map((type) => Type.Literal(type))),
  before: nullable(OrderArrangementSchema),
  after: OrderArrangementSchema,
  reason: RecordedCommandReasonSchema,
  actor: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  recordedAt: DateTime,
  pricingSummary: strictObject({
    policyBaseAmount: Money,
    currentContractAmount: Money,
    differenceFromPolicy: Money
  }),
  fundsSummary: strictObject({
    netRecordedCollection: Money,
    collectionDifference: Money,
    refundReferenceAmount: NonNegativeMoney,
    factCount: Type.Integer({ minimum: 0 })
  })
});
export const CollectionFactRowSchema = strictObject({
  fact_id: Id, order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount, net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), references_fact_id: nullable(Id), reverses_fact_id: nullable(Id),
  method: ShortText, note: OptionalNote, transaction_reference: nullable(ShortText), pricing_revision_id: Id, command_id: Id, created_at: DateTime
});

export const OrderDetailResponseSchema = strictObject({
  accessLevel: AccessLevelSchema,
  allowedActions: Type.Array(strictObject({
    code: Type.Union(orderActionCodes.map((code) => Type.Literal(code))),
    enabled: Type.Boolean(),
    disabledReason: nullable(ShortText)
  })),
  order: OrderRowSchema,
  occupants: Type.Array(OrderOccupantSchema, { minItems: 1, maxItems: 1000 }),
  occupantCorrections: Type.Array(strictObject({
    id: Id,
    orderId: Id,
    occupantId: Id,
    sequence: Type.Integer({ minimum: 1 }),
    priorSnapshot: OrderOccupantPriorSnapshotSchema,
    correctedSnapshot: OrderOccupantCorrectedSnapshotSchema,
    reason: strictObject({ code: ShortText, note: Note }),
    actor: strictObject({ subjectId: Id, displayName: ShortText }),
    amendmentId: Id,
    commandId: Id,
    createdAt: DateTime
  })),
  stay: strictObject({ id: Id, status: Type.Union([
    Type.Literal("PLANNED"), Type.Literal("IN_HOUSE"), Type.Literal("COMPLETED"),
    Type.Literal("CANCELLED"), Type.Literal("NO_SHOW")
  ]) }),
  currentSegment: strictObject({ id: Id, sequence: Type.Integer({ minimum: 1 }), inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate }),
  segments: Type.Array(StaySegmentRowSchema),
  originalArrangement: OrderArrangementSchema,
  effectiveArrangement: OrderEffectiveArrangementSchema,
  fulfillment: OrderFulfillmentProjectionSchema,
  arrangementHistory: Type.Array(OrderArrangementHistoryItemSchema, { minItems: 1 }),
  amendments: Type.Array(AmendmentRowSchema),
  pricingRevisions: Type.Array(PricingRevisionRowSchema),
  coverageSet: Type.Array(CoverageRowSchema),
  collectionFacts: Type.Array(CollectionFactRowSchema),
  cleaningTasks: Type.Array(CleaningTaskSummarySchema),
  amounts: AmountSummarySchema
});

const EntitlementLotRowSchema = strictObject({
  id: Id, contract_id: Id, unit_kind: EntitlementUnitKindSchema, total_units: Type.Integer({ minimum: 0 }),
  expires_on: LocalDate, version: Type.Integer({ minimum: 1 }), created_at: DateTime
});
const MemberExternalReferenceRowSchema = strictObject({
  id: Id,
  member_id: Id,
  property_id: Id,
  provider: Type.Literal("FEISHU_BASE"),
  source_container_id: ShortText,
  source_table_id: ShortText,
  external_record_id: ShortText,
  created_at: DateTime
});
const MemberAvailableBalanceSchema = strictObject({
  ROOM_NIGHT: Type.Integer({ minimum: 0 }),
  BED_NIGHT: Type.Integer({ minimum: 0 })
});
const MemberLotBalanceSchema = strictObject({
  lotId: Id,
  unitKind: EntitlementUnitKindSchema,
  availableUnits: Type.Integer({ minimum: 0 })
});
const MembershipProductRowSchema = strictObject({
  id: Id,
  code: ShortText,
  version: Type.Integer({ minimum: 1 }),
  name: ShortText,
  list_price_minor: NonNegativeWholeYuanAmount,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  entitlement_unit_kind: EntitlementUnitKindSchema,
  entitlement_units: Type.Integer({ minimum: 1 }),
  validity_period: Type.Literal("P1Y"),
  allowed_room_type_code: ShortText,
  allowed_inventory_kind: InventoryUnitKindSchema,
  status: Type.Literal("PUBLISHED"),
  created_at: DateTime
});
const MembershipOrderRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  product_id: Id,
  product_code: ShortText,
  product_version: Type.Integer({ minimum: 1 }),
  product_name: ShortText,
  listed_price_minor: NonNegativeWholeYuanAmount,
  agreed_price_minor: NonNegativeWholeYuanAmount,
  price_adjustment_minor: SafeInteger,
  price_adjustment_reason: nullable(Note),
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  entitlement_unit_kind: EntitlementUnitKindSchema,
  entitlement_units: Type.Integer({ minimum: 1 }),
  allowed_room_type_code: ShortText,
  allowed_inventory_kind: InventoryUnitKindSchema,
  status: Type.Union([Type.Literal("DRAFT"), Type.Literal("ACTIVE")]),
  activated_at: nullable(DateTime),
  valid_from: nullable(LocalDate),
  valid_until: nullable(LocalDate),
  contract_id: nullable(Id),
  entitlement_lot_id: nullable(Id),
  version: Type.Integer({ minimum: 1 }),
  created_by_command_id: Id,
  activated_by_command_id: nullable(Id),
  created_at: DateTime,
  updated_at: DateTime
});
const MembershipPaymentFactRowSchema = strictObject({
  fact_id: Id,
  membership_order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount,
  net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  transaction_reference: nullable(ShortText),
  corrects_fact_id: nullable(Id),
  reverses_fact_id: nullable(Id),
  note: OptionalNote,
  command_id: Id,
  created_at: DateTime
});
const MembershipOrderSummarySchema = strictObject({
  order: MembershipOrderRowSchema,
  paymentFacts: Type.Array(MembershipPaymentFactRowSchema),
  paymentTotalMinor: SafeInteger,
  paymentDifferenceMinor: SafeInteger
});
const MemberSummarySchema = strictObject({
  member: MemberRowSchema
});
export const MembersQuerySchema = strictObject({
  propertyId: Id,
  query: Type.Optional(Type.String({ maxLength: 200 }))
});
export const MembersListResponseSchema = strictObject({ members: Type.Array(MemberSummarySchema) });
export const EntitlementLedgerRowSchema = strictObject({
  fact_id: Id, lot_id: Id,
  entry_type: Type.Union([Type.Literal("ADJUST"), Type.Literal("HOLD"), Type.Literal("RELEASE"), Type.Literal("CONSUME"), Type.Literal("EXPIRE")]),
  quantity_delta: SafeInteger, service_date: nullable(LocalDate), order_id: nullable(Id), coverage_id: nullable(Id),
  reason: Type.String({ minLength: 1, maxLength: 1000 }), command_id: nullable(Id), created_at: DateTime
});
export const MemberResponseSchema = strictObject({
  member: MemberRowSchema,
  contracts: Type.Array(MemberContractRowSchema),
  lots: Type.Array(EntitlementLotRowSchema),
  ledger: Type.Array(EntitlementLedgerRowSchema),
  externalReferences: Type.Array(MemberExternalReferenceRowSchema),
  lotBalances: Type.Array(MemberLotBalanceSchema),
  availableBalance: MemberAvailableBalanceSchema,
  balanceAsOfDate: LocalDate,
  membershipProducts: Type.Array(MembershipProductRowSchema),
  membershipOrders: Type.Array(MembershipOrderSummarySchema)
});

const CollectionFactResponseSchema = strictObject({
  fact_id: Id, order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount, net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), references_fact_id: nullable(Id), reverses_fact_id: nullable(Id),
  method: ShortText, note: OptionalNote, transaction_reference: nullable(ShortText), created_at: DateTime, property_id: Id
});
const EntitlementFactResponseSchema = strictObject({ ...EntitlementLedgerRowSchema.properties, property_id: Id });
export const FactResponseSchema = Type.Union([CollectionFactResponseSchema, EntitlementFactResponseSchema]);

const TokenRowSchema = strictObject({
  id: Id, label: ShortText, access_ceiling: AccessLevelSchema, property_scope: Id, expires_at: DateTime,
  revoked_at: nullable(DateTime), rotated_from_id: nullable(Id), replaced_by_id: nullable(Id), created_at: DateTime
});
export const TokensResponseSchema = strictObject({ tokens: Type.Array(TokenRowSchema) });

export const MaintenanceLockStatusSchema = Type.Union([Type.Literal("ACTIVE"), Type.Literal("RELEASED")]);
export const MaintenanceLocksQuerySchema = strictObject({
  propertyId: Id,
  status: Type.Optional(MaintenanceLockStatusSchema)
});
export const MaintenanceLockRowSchema = strictObject({
  id: Id,
  property_id: Id,
  inventory_unit_id: Id,
  arrival_date: LocalDate,
  departure_date: LocalDate,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  status: MaintenanceLockStatusSchema,
  version: Type.Integer({ minimum: 1 }),
  created_at: DateTime,
  released_at: nullable(DateTime)
});
export const MaintenanceLocksResponseSchema = strictObject({
  maintenanceLocks: Type.Array(MaintenanceLockRowSchema)
});

const AuditMetadataSchema = Type.Union([
  strictObject({ effectHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ previewId: Id, effectHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ quoteInputHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ errorCode: Type.Union(errorCodes.map((code) => Type.Literal(code))) })
]);
export const AuditResponseSchema = strictObject({
  entries: Type.Array(strictObject({
    id: Id, subject_id: Id, credential_id: Id, action: Type.String({ minLength: 1, maxLength: 200 }),
    decision: Type.Union([Type.Literal("ALLOWED"), Type.Literal("DENIED")]), command_id: nullable(Id),
    correlation_id: Type.String({ minLength: 1, maxLength: 160 }), reason: nullable(RecordedCommandReasonSchema),
    target_refs: Type.Array(Id), metadata: AuditMetadataSchema, created_at: DateTime
  }))
});

export const StoredPreviewResponseSchema = strictObject({
  id: Id,
  property_id: Id,
  command_type: HistoricalCommandTypeSchema,
  input_hash: Type.String({ minLength: 64, maxLength: 64 }),
  effect: CommandEffectSchema,
  effect_hash: Type.String({ minLength: 64, maxLength: 64 }),
  expires_at: DateTime,
  status: Type.Union([Type.Literal("OPEN"), Type.Literal("USED"), Type.Literal("EXPIRED")]),
  created_at: DateTime,
  used_at: nullable(DateTime)
});

export const IdParams = strictObject({ id: Id });
export const PreviewParams = strictObject({ previewId: Id });
