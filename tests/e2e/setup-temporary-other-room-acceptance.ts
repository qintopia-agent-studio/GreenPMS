import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const propertyId = "prop_qintopia_demo";
const acceptanceDatabaseName = "qintopia_temporary_other_room_acceptance";
const defaultDatabaseUrl = process.env.TEMPORARY_OTHER_ROOM_ACCEPTANCE_DATABASE_URL
  ?? `postgres://qintopia:qintopia@127.0.0.1:55432/${acceptanceDatabaseName}`;

const ordinaryPrincipal: AuthPrincipal = {
  subjectId: "subject_demo_agent",
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Temporary other-room acceptance setup",
  ...authScope()
};

const administratorPrincipal: AuthPrincipal = {
  subjectId: "subject_demo_administrator",
  credentialId: "token_demo_admin_write",
  credentialType: "TOKEN",
  displayName: "Temporary other-room acceptance administrator setup",
  ...authScope({ profile: "administrator" })
};

const products = {
  sharedSingle: {
    id: "membership_product_shared_bath_single_v1",
    priceMinor: 162_000
  },
  privateSingle: {
    id: "membership_product_private_bath_single_v1",
    priceMinor: 216_000
  },
  sharedQuadBed: {
    id: "membership_product_shared_bath_quad_v1",
    priceMinor: 93_600
  }
} as const;

type Product = (typeof products)[keyof typeof products];

interface PreparedMember {
  memberId: string;
  name: string;
  phone: string;
  membershipOrderId: string;
  entitlementLotId: string | null;
}

export interface TemporaryOtherRoomAcceptanceFixture {
  propertyId: string;
  businessDate: string;
  ordinaryCheckout: { orderId: string; unitCode: string; nickname: string };
  accounts: {
    operator: { username: string; password: string };
    administrator: { username: string; password: string };
  };
  dates: {
    primary: { arrivalDate: string; departureDate: string };
    permissions: { arrivalDate: string; departureDate: string };
    concurrency: { arrivalDate: string; departureDate: string };
    terminalLifecycle: { arrivalDate: string; departureDate: string };
  };
  units: {
    sharedSingle: string[];
    privateSingle: string[];
    otherWholeRoom: string;
    bed: string;
    concurrencyTarget: string;
  };
  members: {
    sharedSingle: PreparedMember;
    privateSingle: PreparedMember;
    bed: PreparedMember;
    draft: PreparedMember;
    expired: PreparedMember;
    oneNightBalance: PreparedMember;
    exactMatch: PreparedMember;
    operatorPermission: PreparedMember;
    administratorPermission: PreparedMember;
    concurrencyA: PreparedMember;
    concurrencyB: PreparedMember;
    terminalLifecycle: PreparedMember;
  };
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function assertTemporaryOtherRoomAcceptanceDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  if (
    parsed.protocol !== "postgres:"
    || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
    || databaseName !== acceptanceDatabaseName
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(
      `Refusing acceptance setup: use the local ${acceptanceDatabaseName} database only`
    );
  }
}

async function execute(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  commandType: CommandType,
  input: Record<string, unknown>,
  key: string
): Promise<ReceiptDto> {
  const envelope = { commandType, input } as CommandEnvelope;
  const prepared = await createCommandPreview(db, principal, envelope, {
    idempotencyKey: `${key}-preview`,
    correlationId: key
  });
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: commandType, note: "准备会员临时安排其他整间房型人工验收数据" }
  }, {
    idempotencyKey: `${key}-confirm`,
    correlationId: key
  });
  if (!receipt.businessCommitted) {
    throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus} ${receipt.error?.message ?? ""}`.trim());
  }
  return receipt;
}

async function createMember(
  db: Kysely<Database>,
  key: string,
  ordinal: number,
  name: string
): Promise<{ memberId: string; name: string; phone: string }> {
  const phone = `13966${String(ordinal).padStart(6, "0")}`;
  const receipt = await execute(db, ordinaryPrincipal, "CREATE_MEMBER", {
    propertyId,
    fullName: name,
    nickname: name,
    identityCardNumber: `TEMP-OTHER-ROOM-${String(ordinal).padStart(4, "0")}`,
    phone,
    wechat: `temporary-other-room-${key}`
  }, `${key}-member`);
  const memberId = receipt.result?.memberId;
  if (typeof memberId !== "string") throw new Error(`${key} did not create a member`);
  return { memberId, name, phone };
}

async function prepareMembership(
  db: Kysely<Database>,
  options: {
    key: string;
    ordinal: number;
    name: string;
    product: Product;
    activate?: boolean;
  }
): Promise<PreparedMember> {
  const member = await createMember(db, options.key, options.ordinal, options.name);
  const order = await execute(db, ordinaryPrincipal, "CREATE_MEMBERSHIP_ORDER", {
    propertyId,
    memberId: member.memberId,
    membershipProductId: options.product.id,
    agreedPriceMinor: options.product.priceMinor
  }, `${options.key}-membership-order`);
  const membershipOrderId = order.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") {
    throw new Error(`${options.key} did not create a membership order`);
  }
  if (options.activate === false) {
    return { ...member, membershipOrderId, entitlementLotId: null };
  }
  await execute(db, ordinaryPrincipal, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId,
    membershipOrderId,
    amountMinor: options.product.priceMinor,
    transactionReference: `WX-TEMP-OTHER-ROOM-${options.key.toUpperCase()}`
  }, `${options.key}-membership-payment`);
  const activation = await execute(db, ordinaryPrincipal, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId,
    membershipOrderId
  }, `${options.key}-membership-activation`);
  const entitlementLotId = activation.result?.entitlementLotId;
  if (typeof entitlementLotId !== "string") {
    throw new Error(`${options.key} did not activate an entitlement lot`);
  }
  return { ...member, membershipOrderId, entitlementLotId };
}

async function requireUnitCodes(db: Kysely<Database>, options: {
  roomTypeCode: string;
  kind: "ROOM" | "BED";
  minimum: number;
}): Promise<string[]> {
  const units = await db.selectFrom("inventory_units")
    .select("code")
    .where("property_id", "=", propertyId)
    .where("kind", "=", options.kind)
    .where("room_type_code", "=", options.roomTypeCode)
    .where("active", "=", true)
    .orderBy("code")
    .execute();
  if (units.length < options.minimum) {
    throw new Error(`Acceptance setup needs ${options.minimum} active ${options.kind} units for ${options.roomTypeCode}`);
  }
  return units.map((unit) => unit.code);
}

export async function prepareTemporaryOtherRoomAcceptance(
  databaseUrl = defaultDatabaseUrl
): Promise<TemporaryOtherRoomAcceptanceFixture> {
  assertTemporaryOtherRoomAcceptanceDatabaseUrl(databaseUrl);
  const db = await resetDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const sharedSingleUnits = await requireUnitCodes(db, {
      roomTypeCode: "shared_bath_single",
      kind: "ROOM",
      minimum: 3
    });
    const privateSingleUnits = await requireUnitCodes(db, {
      roomTypeCode: "private_bath_single",
      kind: "ROOM",
      minimum: 3
    });
    const bedUnits = await requireUnitCodes(db, {
      roomTypeCode: "shared_bath_quad",
      kind: "BED",
      minimum: 1
    });
    const otherWholeRoom = await db.selectFrom("inventory_units")
      .select("code")
      .where("property_id", "=", propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .where("room_type_code", "not in", ["shared_bath_single", "private_bath_single"])
      .orderBy("code")
      .executeTakeFirstOrThrow();

    const memberDefinitions = [
      ["shared-single", 1, "验收-公卫整房会员", products.sharedSingle],
      ["private-single", 2, "验收-独卫整房会员", products.privateSingle],
      ["bed", 3, "验收-公卫四人间床位会员", products.sharedQuadBed],
      ["expired", 5, "验收-已过期整房会员", products.sharedSingle],
      ["one-night", 6, "验收-仅剩一晚整房会员", products.sharedSingle],
      ["exact-match", 7, "验收-普通匹配整房会员", products.sharedSingle],
      ["operator-permission", 8, "验收-普通员工临时安排", products.sharedSingle],
      ["admin-permission", 9, "验收-管理员临时安排", products.sharedSingle],
      ["concurrency-a", 10, "验收-并发会员甲", products.sharedSingle],
      ["concurrency-b", 11, "验收-并发会员乙", products.sharedSingle],
      ["terminal-lifecycle", 12, "验收-取消未到与限制", products.sharedSingle]
    ] as const;
    const prepared = new Map<string, PreparedMember>();
    for (const [key, ordinal, name, product] of memberDefinitions) {
      const prepare = () => prepareMembership(db, { key, ordinal, name, product });
      prepared.set(key, key === "expired"
        ? await withPropertyClockForTesting(new Date(`${addDays(businessDate, -400)}T12:00:00+08:00`), prepare)
        : await prepare());
    }
    const draft = await prepareMembership(db, {
      key: "draft",
      ordinal: 4,
      name: "验收-未生效整房会员",
      product: products.sharedSingle,
      activate: false
    });
    const expired = prepared.get("expired")!;
    const oneNightBalance = prepared.get("one-night")!;
    await execute(db, administratorPrincipal, "CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
      propertyId,
      entitlementLotId: oneNightBalance.entitlementLotId,
      expectedAvailableBalance: 30,
      targetAvailableBalance: 1,
      adjustmentReason: "构造本地人工验收专用的一晚余额"
    }, "one-night-membership-balance");

    const checkoutUnit = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", propertyId)
      .where("code", "=", "A02")
      .executeTakeFirstOrThrow();
    const checkoutNickname = "验收-今日普通退房";
    const checkoutOrderId = await withPropertyClockForTesting(
      new Date(`${addDays(businessDate, -1)}T12:00:00+08:00`),
      async () => {
        const quote = await createQuoteForTesting(db, {
          propertyId,
          inventoryUnitId: checkoutUnit.id,
          arrivalDate: addDays(businessDate, -1),
          departureDate: businessDate,
          pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1",
          stayType: "TRANSIENT"
        });
        const order = await execute(db, ordinaryPrincipal, "CREATE_ORDER", {
          propertyId,
          quoteId: quote.quoteId,
          primaryGuest: { fullName: checkoutNickname, nickname: checkoutNickname, phone: "13966000013", documentNumber: "TEMP-OTHER-ROOM-0013" },
          bookingChannelCode: "WECOM",
          channelOrderReference: null
        }, "ordinary-checkout-create");
        const orderId = order.result?.orderId;
        if (typeof orderId !== "string") throw new Error("Ordinary checkout fixture was not created");
        await execute(db, ordinaryPrincipal, "RECORD_COLLECTION", {
          propertyId, orderId, amountMinor: quote.currentContractAmount.minorUnits,
          method: "WECOM", transactionReference: "WX-TEMP-OTHER-ROOM-CHECKOUT"
        }, "ordinary-checkout-collection");
        await execute(db, ordinaryPrincipal, "CHECK_IN", { propertyId, orderId }, "ordinary-checkout-check-in");
        return orderId;
      }
    );

    return {
      propertyId,
      businessDate,
      ordinaryCheckout: { orderId: checkoutOrderId, unitCode: checkoutUnit.code, nickname: checkoutNickname },
      accounts: {
        operator: { username: "operator", password: "demo-pass-2026" },
        administrator: { username: "admin", password: "demo-pass-2026" }
      },
      dates: {
        primary: { arrivalDate: businessDate, departureDate: addDays(businessDate, 2) },
        permissions: { arrivalDate: addDays(businessDate, 6), departureDate: addDays(businessDate, 8) },
        concurrency: { arrivalDate: addDays(businessDate, 10), departureDate: addDays(businessDate, 12) },
        terminalLifecycle: { arrivalDate: addDays(businessDate, 14), departureDate: addDays(businessDate, 16) }
      },
      units: {
        sharedSingle: sharedSingleUnits.slice(0, 3),
        privateSingle: privateSingleUnits.slice(0, 3),
        otherWholeRoom: otherWholeRoom.code,
        bed: bedUnits[0]!,
        concurrencyTarget: privateSingleUnits[2]!
      },
      members: {
        sharedSingle: prepared.get("shared-single")!,
        privateSingle: prepared.get("private-single")!,
        bed: prepared.get("bed")!,
        draft,
        expired,
        oneNightBalance,
        exactMatch: prepared.get("exact-match")!,
        operatorPermission: prepared.get("operator-permission")!,
        administratorPermission: prepared.get("admin-permission")!,
        concurrencyA: prepared.get("concurrency-a")!,
        concurrencyB: prepared.get("concurrency-b")!,
        terminalLifecycle: prepared.get("terminal-lifecycle")!
      }
    };
  } finally {
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith("setup-temporary-other-room-acceptance.ts")) {
  void prepareTemporaryOtherRoomAcceptance().then((fixture) => {
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
