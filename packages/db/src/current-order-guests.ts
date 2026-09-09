import type { Kysely, Selectable } from "kysely";
import type { Database } from "./schema.ts";

type OccupantRow = Selectable<Database["order_occupants"]>;
type CorrectionRow = Selectable<Database["order_occupant_corrections"]>;

/** Current read projection only. Original rows and append-only corrections stay intact. */
export function projectCurrentOrderOccupants(occupants: readonly OccupantRow[], corrections: readonly CorrectionRow[]) {
  const latest = new Map<string, CorrectionRow>();
  for (const correction of corrections) {
    const prior = latest.get(correction.occupant_id);
    if (!prior || correction.sequence > prior.sequence) latest.set(correction.occupant_id, correction);
  }
  return occupants.map((occupant) => {
    const correction = latest.get(occupant.id);
    return {
      id: occupant.id, orderId: occupant.order_id, ordinal: occupant.ordinal, role: occupant.role,
      fullName: correction ? correction.corrected_full_name : occupant.full_name,
      nickname: correction ? correction.corrected_nickname : occupant.nickname,
      phone: correction ? correction.corrected_phone : occupant.phone,
      documentNumber: correction ? correction.corrected_document_number : occupant.document_number,
      createdAt: new Date(occupant.created_at).toISOString()
    };
  });
}

export function currentPrimaryGuest(
  occupants: ReturnType<typeof projectCurrentOrderOccupants>,
  original: unknown
) {
  const primary = occupants.find((occupant) => occupant.role === "PRIMARY");
  return primary ? { fullName: primary.fullName, nickname: primary.nickname, phone: primary.phone, documentNumber: primary.documentNumber } : original;
}

export async function loadCurrentPrimaryGuests(db: Kysely<Database>, orderIds: string[]) {
  if (!orderIds.length) return new Map<string, Pick<ReturnType<typeof projectCurrentOrderOccupants>[number], "fullName" | "nickname" | "phone" | "documentNumber">>();
  const [occupants, corrections] = await Promise.all([
    db.selectFrom("active_order_occupants").selectAll().where("order_id", "in", orderIds).where("role", "=", "PRIMARY").execute(),
    db.selectFrom("order_occupant_corrections").selectAll().where("order_id", "in", orderIds)
      .distinctOn("occupant_id").orderBy("occupant_id").orderBy("sequence", "desc").execute()
  ]);
  return new Map(projectCurrentOrderOccupants(occupants, corrections).map((occupant) => [
    occupant.orderId,
    { fullName: occupant.fullName, nickname: occupant.nickname, phone: occupant.phone, documentNumber: occupant.documentNumber }
  ]));
}
