import { sql } from "kysely";
import { DomainError } from "@qintopia/contracts";
import type { DbExecutor } from "./inventory.ts";

export interface HistoricalOrderArchiveQuery {
  query?: string;
  recordKind?: "MIGRATED_ARCHIVE" | "NON_ACCOMMODATION_ARCHIVE";
  channelCode?: "YOUMUDAO" | "CTRIP" | "MEITUAN" | "WECOM";
  sourceStatus?: string;
  arrivalDate?: string;
  departureDate?: string;
}

export const historicalOrderArchiveListLimit = 1_000;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

const archiveListColumns = [
  "id", "property_id", "record_kind", "source_order_id", "guest_full_name", "guest_nickname",
  "mapped_channel_code", "channel_order_reference", "channel_reference_missing_reason",
  "arrival_date", "departure_date", "stay_type", "source_status",
  "historical_actual_amount_minor", "lodging_subtotal_minor", "checkout_amount_minor",
  "amount_difference_reason", "currency", "created_at"
] as const;

/**
 * Lists source-owned historical records. Phone, source IDs, import-run data, and
 * canonical payloads intentionally never cross this list boundary.
 */
export async function listHistoricalOrderArchives(
  db: DbExecutor,
  propertyId: string,
  options: HistoricalOrderArchiveQuery = {}
) {
  let selection = db.selectFrom("historical_order_archives")
    .select(archiveListColumns)
    .where("property_id", "=", propertyId);
  const normalizedQuery = options.query?.trim();
  if (normalizedQuery) {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    selection = selection.where(sql<boolean>`(
      source_order_id ILIKE ${pattern} ESCAPE '\\'
      OR guest_full_name ILIKE ${pattern} ESCAPE '\\'
      OR guest_nickname ILIKE ${pattern} ESCAPE '\\'
      OR mapped_channel_code ILIKE ${pattern} ESCAPE '\\'
      OR channel_order_reference ILIKE ${pattern} ESCAPE '\\'
      OR record_kind ILIKE ${pattern} ESCAPE '\\'
      OR source_status ILIKE ${pattern} ESCAPE '\\'
      OR arrival_date::text ILIKE ${pattern} ESCAPE '\\'
      OR departure_date::text ILIKE ${pattern} ESCAPE '\\'
    )`);
  }
  if (options.recordKind) selection = selection.where("record_kind", "=", options.recordKind);
  if (options.channelCode) selection = selection.where("mapped_channel_code", "=", options.channelCode);
  if (options.sourceStatus) selection = selection.where("source_status", "=", options.sourceStatus);
  if (options.arrivalDate) selection = selection.where("arrival_date", "=", options.arrivalDate);
  if (options.departureDate) selection = selection.where("departure_date", "=", options.departureDate);
  const archives = await selection.orderBy("arrival_date", "desc").orderBy("source_order_id")
    .limit(historicalOrderArchiveListLimit + 1)
    .execute();
  return {
    archives: archives.slice(0, historicalOrderArchiveListLimit),
    truncated: archives.length > historicalOrderArchiveListLimit
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function maskHistoricalArchivePhone(value: string | null): string | null {
  if (!value) return null;
  const characters = [...value];
  if (characters.length <= 7) return "*".repeat(Math.max(4, characters.length));
  const visible = characters.slice(-4).join("");
  return `${"*".repeat(Math.min(8, Math.max(4, characters.length - 4)))}${visible}`;
}

function evidenceFromCanonicalPayload(value: unknown) {
  const payload = objectValue(value);
  const guest = objectValue(payload.guest);
  const provenance = objectValue(payload.provenance);
  const pricing = objectValue(payload.pricing);
  const pricingEvidence = objectValue(pricing.evidence);
  return {
    guestNameProvenance: nullableText(guest.nameProvenance),
    guestNicknameProvenance: nullableText(guest.nicknameProvenance),
    guestPhoneProvenance: nullableText(guest.phoneProvenance),
    reviewConclusion: nullableText(provenance.reviewConclusion),
    reviewWorkbookHash: nullableText(provenance.reviewWorkbookHash),
    pricingEvidence: {
      auditHistoricalAmountMinor: typeof pricingEvidence.auditHistoricalAmountFen === "number" ? pricingEvidence.auditHistoricalAmountFen : null,
      checkoutAccommodationAmountMinor: typeof pricingEvidence.checkoutAccommodationAmountFen === "number" ? pricingEvidence.checkoutAccommodationAmountFen : null,
      checkoutTotalAmountMinor: typeof pricingEvidence.checkoutTotalAmountFen === "number" ? pricingEvidence.checkoutTotalAmountFen : null,
      unsettledConsumptionAmountMinor: typeof pricingEvidence.unsettledConsumptionAmountFen === "number" ? pricingEvidence.unsettledConsumptionAmountFen : null
    }
  };
}

/**
 * Returns an explicitly scoped detail projection. Keep canonical payload and
 * migration identifiers internal: they are provenance evidence, not UI data.
 */
export async function getHistoricalOrderArchive(db: DbExecutor, propertyId: string, archiveId: string) {
  const archive = await db.selectFrom("historical_order_archives as archive")
    .innerJoin("migration_order_sources as source", (join) => join
      .onRef("source.id", "=", "archive.source_id")
      .onRef("source.property_id", "=", "archive.property_id"))
    .select([
      ...archiveListColumns.map((column) => `archive.${column}` as const),
      "archive.guest_phone",
      "source.source_system",
      "source.source_row",
      "source.raw_channel",
      "source.manual_confirmation",
      "source.canonical_payload",
      "source.run_id"
    ])
    .where("archive.property_id", "=", propertyId)
    .where("archive.id", "=", archiveId)
    .executeTakeFirst();
  if (!archive) throw new DomainError("NOT_FOUND", "Historical order archive not found", 404);
  const files = await db.selectFrom("migration_import_files")
    .select(["source_role", "file_name", "sha256", "exported_at", "row_count"])
    .where("run_id", "=", archive.run_id)
    .orderBy("source_role")
    .execute();
  const manual = objectValue(archive.manual_confirmation);
  const canonicalEvidence = evidenceFromCanonicalPayload(archive.canonical_payload);
  const { source_system, source_row, raw_channel, guest_phone, manual_confirmation: _manual, canonical_payload: _canonical, run_id: _run, ...projection } = archive;
  return {
    ...projection,
    guest_phone: maskHistoricalArchivePhone(guest_phone),
    sourceEvidence: {
      sourceSystem: source_system,
      sourceRow: source_row,
      rawChannel: raw_channel,
      guestNameProvenance: canonicalEvidence.guestNameProvenance,
      guestNicknameProvenance: canonicalEvidence.guestNicknameProvenance,
      guestPhoneProvenance: canonicalEvidence.guestPhoneProvenance,
      reviewConclusion: canonicalEvidence.reviewConclusion,
      reviewWorkbookHash: canonicalEvidence.reviewWorkbookHash,
      manualConfirmation: {
        businessType: nullableText(manual.businessType),
        correctionSource: nullableText(manual.correctionSource),
        latestCorrection: nullableText(manual.latestCorrection),
        observedLifecycle: nullableText(manual.observedLifecycle),
        reason: nullableText(manual.reason),
        room: nullableText(manual.room)
      },
      files: files.map((file) => ({
        sourceRole: file.source_role,
        fileName: file.file_name,
        sha256: file.sha256,
        exportedAt: file.exported_at,
        rowCount: file.row_count
      }))
    },
    pricingEvidence: canonicalEvidence.pricingEvidence
  };
}
