import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.ts";

export type StaffProfile = "STAFF" | "ADMIN";

export interface StaffProfileManifestEntry {
  subjectId: string;
  propertyId: string;
  profile: StaffProfile;
}

const reviewedStaffProfileManifests = {
  // Production mappings must be added here with verified subject/property IDs
  // and pass code review before deployment selects the new manifest name.
  unconfigured: [],
  // Test/demo identities are deliberately isolated from production selection.
  demo: [
    { subjectId: "subject_demo_operator", propertyId: "prop_qintopia_demo", profile: "STAFF" },
    { subjectId: "subject_demo_agent", propertyId: "prop_qintopia_demo", profile: "STAFF" },
    { subjectId: "subject_demo_administrator", propertyId: "prop_qintopia_demo", profile: "ADMIN" }
  ]
} as const satisfies Readonly<Record<string, readonly StaffProfileManifestEntry[]>>;

export type StaffProfileManifestName = keyof typeof reviewedStaffProfileManifests;

export function resolveStaffProfileManifest(name: string | undefined): {
  name: StaffProfileManifestName;
  entries: readonly StaffProfileManifestEntry[];
} {
  const normalized = name?.trim() || "unconfigured";
  if (!Object.hasOwn(reviewedStaffProfileManifests, normalized)) {
    throw new Error(
      `Unknown reviewed staff profile manifest ${JSON.stringify(normalized)}; add verified mappings in staff-profile-manifest.ts before selecting it`
    );
  }
  const manifestName = normalized as StaffProfileManifestName;
  return { name: manifestName, entries: reviewedStaffProfileManifests[manifestName] };
}

export async function reconcileStaffProfileManifest(
  db: Kysely<Database> | Transaction<Database>,
  manifestName: string | undefined
): Promise<void> {
  const manifest = resolveStaffProfileManifest(manifestName);
  await sql`
    SELECT qintopia_reconcile_staff_profile_manifest(
      ${manifest.name},
      ${JSON.stringify(manifest.entries)}::jsonb
    )
  `.execute(db);
}
