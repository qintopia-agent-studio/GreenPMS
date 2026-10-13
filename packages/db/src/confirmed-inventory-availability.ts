/** User-confirmed historical operation evidence; not a change to inventory creation/audit records. */
export interface ConfirmedInventoryAvailability {
  unitId: string;
  recordedAt: string;
  availableFrom: string;
  confirmedOn: string;
  source: string;
}

// These exact immutable unit versions were registered late, not physically opened on registration day.
// availableFrom is the earliest evidenced occupied day, NOT a claim that the room was absent before it.
const qintopiaEvidence: readonly ConfirmedInventoryAvailability[] = Object.freeze([
  {
    unitId: "unit_catalog_82d573b21dbc9978cbb90fb9",
    recordedAt: "2026-09-15T12:20:31.255Z",
    availableFrom: "2026-08-30",
    confirmedOn: "2026-10-13",
    source: "docs/implementation/confirmed-inventory-availability.md#f栋01与03"
  },
  {
    unitId: "unit_catalog_ad4e44c4b7db013e34017613",
    recordedAt: "2026-09-15T12:19:43.014Z",
    availableFrom: "2026-08-31",
    confirmedOn: "2026-10-13",
    source: "docs/implementation/confirmed-inventory-availability.md#f栋01与03"
  }
]);

export function confirmedInventoryAvailability(propertyId: string): readonly ConfirmedInventoryAvailability[] {
  // Never apply this confirmation to demo databases or another property with similar room names.
  return propertyId === "prop_qintopia" ? qintopiaEvidence : [];
}
