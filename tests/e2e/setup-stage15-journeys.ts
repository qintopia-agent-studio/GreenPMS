import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { createDatabase } from "../../packages/db/src/database.ts";
import { getOrderView } from "../../packages/db/src/orders.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const stage15CreationTimezone = "Etc/GMT+12";
const stage15CheckoutTimezone = "Pacific/Kiritimati";
const stage15Demo = {
  propertyId: "prop_qintopia_demo",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1"
};

const defaultDatabaseUrl = process.env.STAGE15_JOURNEYS_DATABASE_URL
  ?? process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";

export interface Stage15CompleteJourneyFixture {
  propertyId: string;
  operatingBusinessDate: string;
  checkoutBusinessDate: string;
  arrivalDate: string;
  initialDepartureDate: string;
  extendedDepartureDate: string;
  moveDate: string;
  shortenedDepartureDate: string;
  expectedInitialAmountMinor: number;
  expectedExtendedAmountMinor: number;
  expectedShortenedAmountMinor: number;
  sourceUnit: { id: string; code: string; name: string };
  targetUnit: { id: string; code: string; name: string };
}

export interface Stage15JourneyEvidence {
  orderStatus: string;
  stayStatus: string;
  currentContractAmountMinor: number;
  netRecordedCollectionMinor: number;
  collectionDifferenceMinor: number;
  amendmentTypes: string[];
  pricingRevisionCount: number;
  effectiveIntervals: Array<{
    inventoryUnitId: string;
    arrivalDate: string;
    departureDate: string;
  }>;
  collectionFacts: Array<{
    factId: string;
    factType: "COLLECTION" | "REFUND" | "REVERSAL";
    amountMinor: number;
    netEffectMinor: number;
    method: string;
    transactionReference: string | null;
    referencesFactId: string | null;
  }>;
  activeClaims: Array<{
    inventoryUnitId: string;
    serviceDate: string;
  }>;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function propertyBusinessDate(db: Kysely<Database>): Promise<string> {
  const property = await db.selectFrom("properties")
    .select("timezone")
    .where("id", "=", stage15Demo.propertyId)
    .executeTakeFirstOrThrow();
  return todayInTimeZone(property.timezone);
}

export async function prepareStage15CompleteJourney(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean } = {}
): Promise<Stage15CompleteJourneyFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    // The paired UTC offsets let this test cross one real property business date while preserving PostgreSQL clock guards.
    await db.updateTable("properties")
      .set({ timezone: stage15CreationTimezone })
      .where("id", "=", stage15Demo.propertyId)
      .executeTakeFirstOrThrow();
    const operatingBusinessDate = await propertyBusinessDate(db);
    const checkoutBusinessDate = todayInTimeZone(stage15CheckoutTimezone);
    const arrivalDate = addDays(operatingBusinessDate, -2);
    const initialDepartureDate = addDays(operatingBusinessDate, 1);
    const extendedDepartureDate = addDays(operatingBusinessDate, 3);
    if (!(operatingBusinessDate < checkoutBusinessDate && checkoutBusinessDate < extendedDepartureDate)) {
      throw new Error(
        `Stage 15 timezone window must satisfy ${operatingBusinessDate} < ${checkoutBusinessDate} < ${extendedDepartureDate}`
      );
    }

    const roomCandidates = await db.selectFrom("inventory_units")
      .select(["id", "code", "name", "room_type_code", "pricing_product_code"])
      .where("property_id", "=", stage15Demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .orderBy("code")
      .execute();
    const claimedUnits = await db.selectFrom("inventory_claims as claim")
      .innerJoin("inventory_units as claimed_unit", "claimed_unit.id", "claim.inventory_unit_id")
      .select([
        "claim.inventory_unit_id as inventoryUnitId",
        "claimed_unit.parent_room_id as parentRoomId"
      ])
      .where("claim.service_date", ">=", arrivalDate)
      .where("claim.service_date", "<", extendedDepartureDate)
      .execute();
    const blockedRoomIds = new Set(claimedUnits.map((claim) => claim.parentRoomId ?? claim.inventoryUnitId));
    const compatibleUnitsByPrice = new Map<string, typeof roomCandidates>();
    for (const unit of roomCandidates) {
      if (!unit.room_type_code || !unit.pricing_product_code || blockedRoomIds.has(unit.id)) continue;
      const priceGroup = `${unit.room_type_code}:${unit.pricing_product_code}`;
      compatibleUnitsByPrice.set(priceGroup, [...(compatibleUnitsByPrice.get(priceGroup) ?? []), unit]);
    }
    const units = [...compatibleUnitsByPrice.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidates]) => candidates.sort((left, right) => left.code.localeCompare(right.code)).slice(0, 2))
      .find((candidates) => candidates.length === 2);
    if (!units) {
      throw new Error("Stage 15 requires two available rooms with the same room type and pricing product");
    }
    const [initialQuote, extendedQuote, shortenedQuote] = await Promise.all([
      createQuoteForTesting(db, {
        propertyId: stage15Demo.propertyId,
        inventoryUnitId: units[0]!.id,
        stayType: "TRANSIENT",
        arrivalDate,
        departureDate: initialDepartureDate,
        pricingPolicyVersionId: stage15Demo.publicPricingPolicyId
      }),
      createQuoteForTesting(db, {
        propertyId: stage15Demo.propertyId,
        inventoryUnitId: units[0]!.id,
        stayType: "TRANSIENT",
        arrivalDate,
        departureDate: extendedDepartureDate,
        pricingPolicyVersionId: stage15Demo.publicPricingPolicyId
      }),
      createQuoteForTesting(db, {
        propertyId: stage15Demo.propertyId,
        inventoryUnitId: units[1]!.id,
        stayType: "TRANSIENT",
        arrivalDate,
        departureDate: checkoutBusinessDate,
        pricingPolicyVersionId: stage15Demo.publicPricingPolicyId
      })
    ]);
    if (!(initialQuote.currentContractAmount.minorUnits < extendedQuote.currentContractAmount.minorUnits)
      || !(shortenedQuote.currentContractAmount.minorUnits < extendedQuote.currentContractAmount.minorUnits)) {
      throw new Error("Stage 15 expected extension to increase and shortening to reduce the exact contract amount");
    }
    return {
      propertyId: stage15Demo.propertyId,
      operatingBusinessDate,
      checkoutBusinessDate,
      arrivalDate,
      initialDepartureDate,
      extendedDepartureDate,
      moveDate: operatingBusinessDate,
      shortenedDepartureDate: checkoutBusinessDate,
      expectedInitialAmountMinor: initialQuote.currentContractAmount.minorUnits,
      expectedExtendedAmountMinor: extendedQuote.currentContractAmount.minorUnits,
      expectedShortenedAmountMinor: shortenedQuote.currentContractAmount.minorUnits,
      sourceUnit: { id: units[0]!.id, code: units[0]!.code, name: units[0]!.name },
      targetUnit: { id: units[1]!.id, code: units[1]!.code, name: units[1]!.name }
    };
  } finally {
    await db.destroy();
  }
}

export async function advanceStage15CompleteJourneyBusinessDate(
  expectedBusinessDate: string,
  databaseUrl = defaultDatabaseUrl
): Promise<void> {
  const db = createDatabase(databaseUrl);
  try {
    await db.updateTable("properties")
      .set({ timezone: stage15CheckoutTimezone })
      .where("id", "=", stage15Demo.propertyId)
      .executeTakeFirstOrThrow();
    const actualBusinessDate = await propertyBusinessDate(db);
    if (actualBusinessDate !== expectedBusinessDate) {
      throw new Error(`Stage 15 expected the next business date ${expectedBusinessDate}, received ${actualBusinessDate}`);
    }
  } finally {
    await db.destroy();
  }
}

export async function inspectStage15CompleteJourney(
  orderId: string,
  databaseUrl = defaultDatabaseUrl
): Promise<Stage15JourneyEvidence> {
  const db = createDatabase(databaseUrl);
  try {
    const view = await getOrderView(db, orderId);
    const activeClaims = view.segments.length
      ? await db.selectFrom("inventory_claims")
        .select(["inventory_unit_id", "service_date"])
        .where("source_type", "=", "ORDER_SEGMENT")
        .where("source_id", "in", view.segments.map((segment) => segment.id))
        .where("active", "=", true)
        .orderBy("service_date")
        .orderBy("inventory_unit_id")
        .execute()
      : [];
    return {
      orderStatus: view.order.status,
      stayStatus: view.stay.status,
      currentContractAmountMinor: view.amounts.currentContractAmount.minorUnits,
      netRecordedCollectionMinor: view.amounts.netRecordedCollection.minorUnits,
      collectionDifferenceMinor: view.amounts.collectionDifference.minorUnits,
      amendmentTypes: view.amendments.map((amendment) => amendment.amendment_type),
      pricingRevisionCount: view.pricingRevisions.length,
      effectiveIntervals: view.effectiveArrangement.intervals.map((interval) => ({
        inventoryUnitId: interval.inventoryUnitId,
        arrivalDate: interval.arrivalDate,
        departureDate: interval.departureDate
      })),
      collectionFacts: view.collectionFacts.map((fact) => ({
        factId: fact.fact_id,
        factType: fact.fact_type,
        amountMinor: fact.amount_minor,
        netEffectMinor: fact.net_effect_minor,
        method: fact.method,
        transactionReference: fact.transaction_reference,
        referencesFactId: fact.references_fact_id
      })),
      activeClaims: activeClaims.map((claim) => ({
        inventoryUnitId: claim.inventory_unit_id,
        serviceDate: claim.service_date
      }))
    };
  } finally {
    await db.destroy();
  }
}
