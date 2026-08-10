import { createHash, randomBytes, scryptSync } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import pg, { type Client } from "pg";

const APPLY_CONFIRMATION = "DELETE_EXACT_QINTOPIA_ACCEPTANCE_SNAPSHOT";
const PURGE_LOCK_NAME = "qintopia:production-acceptance-purge:v1";
const DEMO_PASSWORD_SALT = "qintopia-demo-v1";
const DEMO_PASSWORD = "demo-pass-2026";
const REQUIRED_MIGRATION = "037_historical_order_import.sql";

const productionAcceptanceOrderIds = [
  "order_b8a87ffe-72b2-4d7e-88c7-ba54ec1ad585",
  "order_567aa352-0453-40e6-a1b3-513cf5b3dd1c",
  "order_3e3eace9-77c7-4988-b5b1-dd779b8d9400",
  "order_694c51f5-b4ed-4a0e-b1ee-89388ee87228",
  "order_57715571-cc3e-464f-8fe3-8c9f03b70334",
  "order_917f942d-94ce-4a0d-a1de-d8ac89090455",
  "order_17efc59c-a331-43eb-a3df-f29221ff94a0"
] as const;

const purgeCountTables = [
  "orders",
  "stays",
  "amendments",
  "stay_segments",
  "pricing_revisions",
  "collection_facts",
  "order_occupants",
  "order_occupant_corrections",
  "coverage_items",
  "entitlement_ledger",
  "inventory_claims",
  "inventory_room_days",
  "inventory_bed_days",
  "cleaning_tasks",
  "maintenance_locks",
  "internal_use_blocks",
  "stay_collection_membership_transfers",
  "quotes",
  "members",
  "member_property_links",
  "member_external_references",
  "member_contracts",
  "entitlement_lots",
  "membership_orders",
  "membership_payment_facts",
  "command_previews",
  "command_executions",
  "command_receipts",
  "audit_entries",
  "subjects",
  "subject_property_grants",
  "api_tokens",
  "web_sessions",
  "migration_import_runs",
  "migration_import_files",
  "migration_order_sources",
  "historical_order_archives",
  "migration_order_targets",
  "migration_overdue_inventory_holds",
  "migration_overdue_inventory_hold_releases"
] as const;

type PurgeCountTable = typeof purgeCountTables[number];

export interface ProductionAcceptancePurgeSpec {
  version: 1;
  propertyId: string;
  orderIds: readonly string[];
  orderSources: ReadonlyArray<{
    orderId: string;
    createdAtUtc: string;
    createCommandId: string;
    credentialId: string;
  }>;
  sourceCreatedBeforeExclusive: string;
  expectedCounts: Readonly<Record<PurgeCountTable, number>>;
  preservedCounts: Readonly<Record<typeof catalogTables[number], number>>;
  preservedPricingPolicyIds: readonly string[];
  preservedRoomStatusRevision: number;
  expectedOperatorAuthVersion: number;
  demo: {
    memberId: string;
    memberContractId: string;
    entitlementLotId: string;
    membershipOrderId: string;
    membershipPaymentFactId: string;
    operatorSubjectId: string;
    agentSubjectId: string;
  };
}

export const productionAcceptancePurgeSpec: ProductionAcceptancePurgeSpec = {
  version: 1,
  propertyId: "prop_qintopia_demo",
  orderIds: productionAcceptanceOrderIds,
  orderSources: [
    { orderId: productionAcceptanceOrderIds[0], createdAtUtc: "2026-08-05T09:45:35.057084Z", createCommandId: "command_a011aba1-bde9-4466-9c08-a0d0a5f73602", credentialId: "session_2c1cb68a-a192-46f4-b076-e90af7a5fa0b" },
    { orderId: productionAcceptanceOrderIds[1], createdAtUtc: "2026-08-05T10:00:57.608164Z", createCommandId: "command_3bd6af41-aedc-45f8-9945-cf29c08c4f47", credentialId: "token_f1f75f8e-74d4-4faf-862e-47de7207cc2c" },
    { orderId: productionAcceptanceOrderIds[2], createdAtUtc: "2026-08-06T03:30:37.388922Z", createCommandId: "command_d76d5024-6964-4d4a-8b0b-b98f299e82dd", credentialId: "session_6e34ccf8-521d-4afa-8f01-dc03e066272b" },
    { orderId: productionAcceptanceOrderIds[3], createdAtUtc: "2026-08-06T03:44:14.259519Z", createCommandId: "command_4040ad0d-a4f7-4a87-af0f-052fb9df021e", credentialId: "session_6e34ccf8-521d-4afa-8f01-dc03e066272b" },
    { orderId: productionAcceptanceOrderIds[4], createdAtUtc: "2026-08-06T04:08:08.234049Z", createCommandId: "command_40997677-3134-43d0-ace6-fa5f8957b69b", credentialId: "session_6e34ccf8-521d-4afa-8f01-dc03e066272b" },
    { orderId: productionAcceptanceOrderIds[5], createdAtUtc: "2026-08-07T08:47:04.392380Z", createCommandId: "command_b4619377-2845-41fc-a301-1455e8730b2f", credentialId: "session_4e80a784-a815-4447-a681-3bfbfaad404e" },
    { orderId: productionAcceptanceOrderIds[6], createdAtUtc: "2026-08-07T10:04:06.610384Z", createCommandId: "command_c21e63bd-d8f8-4a78-826f-6dc7e50fef94", credentialId: "session_4e80a784-a815-4447-a681-3bfbfaad404e" }
  ],
  sourceCreatedBeforeExclusive: "2026-08-10T16:00:00.000Z",
  expectedCounts: {
    orders: 7,
    stays: 7,
    amendments: 17,
    stay_segments: 9,
    pricing_revisions: 15,
    collection_facts: 1,
    order_occupants: 7,
    order_occupant_corrections: 0,
    coverage_items: 0,
    entitlement_ledger: 0,
    inventory_claims: 53,
    inventory_room_days: 52,
    inventory_bed_days: 7,
    cleaning_tasks: 0,
    maintenance_locks: 0,
    internal_use_blocks: 0,
    stay_collection_membership_transfers: 0,
    quotes: 46,
    members: 1,
    member_property_links: 1,
    member_external_references: 0,
    member_contracts: 1,
    entitlement_lots: 1,
    membership_orders: 1,
    membership_payment_facts: 1,
    command_previews: 27,
    command_executions: 93,
    command_receipts: 93,
    audit_entries: 93,
    subjects: 2,
    subject_property_grants: 2,
    api_tokens: 4,
    web_sessions: 14,
    migration_import_runs: 0,
    migration_import_files: 0,
    migration_order_sources: 0,
    historical_order_archives: 0,
    migration_order_targets: 0,
    migration_overdue_inventory_holds: 0,
    migration_overdue_inventory_hold_releases: 0
  },
  preservedCounts: {
    properties: 1,
    catalog_import_batches: 0,
    inventory_catalog_entries: 0,
    reference_rate_entries: 0,
    reference_membership_products: 0,
    inventory_units: 96,
    pricing_policy_versions: 2,
    membership_products: 3,
    room_status_revisions: 1
  },
  preservedPricingPolicyIds: ["policy_free_v1", "policy_qintopia_public_2026_rev561_v1"],
  preservedRoomStatusRevision: 17,
  expectedOperatorAuthVersion: 1,
  demo: {
    memberId: "member_demo_profile",
    memberContractId: "member_demo_contract",
    entitlementLotId: "lot_demo_room_nights",
    membershipOrderId: "membership_order_demo_shared_single",
    membershipPaymentFactId: "membership_payment_demo_shared_single",
    operatorSubjectId: "subject_demo_operator",
    agentSubjectId: "subject_demo_agent"
  }
};

type PurgeMode = "inspect" | "dry-run" | "apply";

interface PurgeOptions {
  databaseUrl: string;
  mode?: PurgeMode;
  applyConfirmation?: string | undefined;
  applicationStoppedConfirmation?: string | undefined;
  demoSeedDisabledConfirmation?: string | undefined;
  approvalToken?: string | undefined;
  operatorPasswordFile?: string | undefined;
  operatorDisplayName?: string | undefined;
  /** Test fixtures only. The production CLI never accepts an alternate target. */
  testSpec?: ProductionAcceptancePurgeSpec | undefined;
}

interface PurgeEvidence {
  evidenceVersion: 1;
  target: {
    propertyId: string;
    orderIds: string[];
    sourceCreatedBeforeExclusive: string;
  };
  database: {
    databaseName: string;
    serverAddress: string | null;
    serverPort: number | null;
    systemIdentifier: string;
    postmasterStartedAt: string;
    migrationNamesSha256: string;
  };
  counts: Record<PurgeCountTable, number>;
  orderEvidence: Array<{
    id: string;
    status: string;
    stayType: string;
    arrivalDate: string;
    departureDate: string;
    migrationSourceId: null;
    createdAt: string;
    rowSha256: string;
  }>;
  sourceWindow: {
    earliestOrderCreatedAt: string;
    latestOrderCreatedAt: string;
    earliestCommandCreatedAt: string | null;
    latestCommandCreatedAt: string | null;
    commandTypes: Record<string, number>;
  };
  rowSetSha256: Record<PurgeCountTable, string>;
  catalog: {
    counts: Record<string, number>;
    rowSetSha256: Record<string, string>;
    combinedSha256: string;
  };
  authentication: {
    operatorAuthVersion: number;
    operatorCredentialState: "DEMO_DEFAULT";
    agentCredentialState: "DEMO_DEFAULT";
    tokenIds: string[];
    sessionsSha256: string;
  };
}

export interface ProductionAcceptancePurgeReport {
  mode: PurgeMode;
  approvalToken: string;
  evidence: PurgeEvidence;
  deletionCounts: Partial<Record<PurgeCountTable | "operator_subject_rotated" | "agent_subject_deleted", number>>;
  committed: boolean;
}

const catalogTables = [
  "properties",
  "catalog_import_batches",
  "inventory_catalog_entries",
  "reference_rate_entries",
  "reference_membership_products",
  "inventory_units",
  "pricing_policy_versions",
  "membership_products",
  "room_status_revisions"
] as const;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePgValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePgValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalizePgValue(child)]));
  }
  return value;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Purge preflight rejected: ${message}`);
}

function assertExactCount(name: string, actual: number, expected: number): void {
  assertCondition(actual === expected, `${name} expected ${expected} rows, observed ${actual}`);
}

function quoteIdentifier(value: string): string {
  assertCondition(/^[a-z][a-z0-9_]*$/.test(value), `unsafe SQL identifier ${value}`);
  return `"${value}"`;
}

function requireTestSpec(testSpec: ProductionAcceptancePurgeSpec | undefined): ProductionAcceptancePurgeSpec {
  if (!testSpec) return productionAcceptancePurgeSpec;
  assertCondition(process.env.NODE_ENV === "test", "alternate purge specs are test-only");
  return testSpec;
}

async function countRows(client: Client, table: PurgeCountTable): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`);
  return Number(result.rows[0]?.count ?? -1);
}

async function tableSnapshot(client: Client, table: string): Promise<{ count: number; sha256: string }> {
  const result = await client.query<{ row: unknown }>(
    `SELECT to_jsonb(snapshot_row) AS row FROM ${quoteIdentifier(table)} AS snapshot_row ORDER BY to_jsonb(snapshot_row)::text`
  );
  const rows = result.rows.map(({ row }) => normalizePgValue(row));
  return { count: rows.length, sha256: sha256(stableJson(rows)) };
}

async function catalogSnapshot(client: Client): Promise<PurgeEvidence["catalog"]> {
  const counts: Record<string, number> = {};
  const rowSetSha256: Record<string, string> = {};
  for (const table of catalogTables) {
    const snapshot = await tableSnapshot(client, table);
    counts[table] = snapshot.count;
    rowSetSha256[table] = snapshot.sha256;
  }
  return { counts, rowSetSha256, combinedSha256: sha256(stableJson({ counts, rowSetSha256 })) };
}

async function assertExactIds(
  client: Client,
  table: string,
  column: string,
  expectedIds: readonly string[],
  where = "TRUE",
  parameters: unknown[] = []
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT ${quoteIdentifier(column)} AS id FROM ${quoteIdentifier(table)} WHERE ${where} ORDER BY ${quoteIdentifier(column)}`,
    parameters
  );
  const actual = result.rows.map(({ id }) => id);
  const expected = [...expectedIds].sort();
  assertCondition(stableJson(actual) === stableJson(expected), `${table}.${column} allowlist mismatch`);
}

async function collectPreflightEvidence(client: Client, spec: ProductionAcceptancePurgeSpec): Promise<PurgeEvidence> {
  assertCondition(spec.orderIds.length === 7 || process.env.NODE_ENV === "test", "production allowlist must contain exactly seven orders");
  assertCondition(new Set(spec.orderIds).size === spec.orderIds.length, "order allowlist contains duplicates");
  assertCondition(spec.expectedCounts.orders === spec.orderIds.length, "order count does not match the allowlist");

  const isolation = await client.query<{ isolation: string }>("SELECT current_setting('transaction_isolation') AS isolation");
  assertCondition(isolation.rows[0]?.isolation === "serializable", "transaction isolation is not SERIALIZABLE");

  const identity = await client.query<{
    database_name: string;
    server_address: string | null;
    server_port: number | null;
    system_identifier: string;
    postmaster_started_at: Date;
  }>(`
    SELECT current_database() AS database_name,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port,
           (pg_control_system()).system_identifier::text AS system_identifier,
           pg_postmaster_start_time() AS postmaster_started_at
  `);
  assertCondition(identity.rows.length === 1, "database identity could not be established");

  const migrations = await client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  assertCondition(migrations.rows.some(({ name }) => name === REQUIRED_MIGRATION), `${REQUIRED_MIGRATION} is not applied`);

  const properties = await client.query<{ id: string }>("SELECT id FROM properties ORDER BY id");
  assertCondition(properties.rows.length === 1 && properties.rows[0]?.id === spec.propertyId, "property scope is not the exact QinTopia property");

  const counts = {} as Record<PurgeCountTable, number>;
  const rowSetSha256 = {} as Record<PurgeCountTable, string>;
  for (const table of purgeCountTables) {
    const count = await countRows(client, table);
    counts[table] = count;
    assertExactCount(table, count, spec.expectedCounts[table]);
    rowSetSha256[table] = (await tableSnapshot(client, table)).sha256;
  }

  const catalog = await catalogSnapshot(client);
  for (const table of catalogTables) assertExactCount(`preserved ${table}`, catalog.counts[table] ?? -1, spec.preservedCounts[table]);
  assertCondition(catalog.counts.properties === 1, "property catalog must contain exactly one property");
  await assertExactIds(client, "pricing_policy_versions", "id", spec.preservedPricingPolicyIds);
  const roomRevision = await client.query<{ property_id: string; revision: string }>("SELECT property_id, revision::text AS revision FROM room_status_revisions");
  assertCondition(roomRevision.rows.length === 1 && roomRevision.rows[0]?.property_id === spec.propertyId && roomRevision.rows[0]?.revision === String(spec.preservedRoomStatusRevision), "room-status revision is not the inspected acceptance snapshot");

  await assertExactIds(client, "orders", "id", spec.orderIds);
  const orderResult = await client.query<{
    id: string;
    status: string;
    stay_type: string;
    arrival_date: string;
    departure_date: string;
    migration_source_id: string | null;
    created_at_utc: string;
    row: unknown;
  }>(`
    SELECT id, status, stay_type, arrival_date::text, departure_date::text,
           migration_source_id,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_utc,
           to_jsonb(orders) AS row
      FROM orders
     WHERE id = ANY($1::text[])
     ORDER BY id
  `, [[...spec.orderIds]]);
  const cutoff = new Date(spec.sourceCreatedBeforeExclusive);
  assertCondition(Number.isFinite(cutoff.getTime()), "source creation cutoff is invalid");
  const orderEvidence = orderResult.rows.map((row) => {
    assertCondition(row.migration_source_id === null, `order ${row.id} has migration provenance`);
    assertCondition(new Date(row.created_at_utc) < cutoff, `order ${row.id} was created outside the accepted source window`);
    return {
      id: row.id,
      status: row.status,
      stayType: row.stay_type,
      arrivalDate: row.arrival_date,
      departureDate: row.departure_date,
      migrationSourceId: null,
      createdAt: row.created_at_utc,
      rowSha256: sha256(stableJson(normalizePgValue(row.row)))
    };
  });
  const sourceRows = await client.query<{
    order_id: string;
    created_at_utc: string;
    create_command_id: string;
    credential_id: string;
    subject_id: string;
    command_type: string;
  }>(`
    SELECT booking.id AS order_id,
           to_char(booking.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_utc,
           amendment.command_id AS create_command_id,
           command.credential_id,
           command.subject_id,
           command.command_type
      FROM orders AS booking
      JOIN amendments AS amendment
        ON amendment.order_id = booking.id
       AND amendment.sequence = 1
       AND amendment.amendment_type = 'CREATE_ORDER'
      JOIN command_executions AS command ON command.id = amendment.command_id
     WHERE booking.id = ANY($1::text[])
     ORDER BY booking.id
  `, [[...spec.orderIds]]);
  assertExactCount("order source rows", sourceRows.rows.length, spec.orderIds.length);
  const expectedSources = [...spec.orderSources].sort((left, right) => left.orderId.localeCompare(right.orderId));
  const actualSources = sourceRows.rows.map((row) => {
    assertCondition(row.subject_id === spec.demo.operatorSubjectId && row.command_type === "CREATE_ORDER", `order ${row.order_id} has unknown command provenance`);
    return {
      orderId: row.order_id,
      createdAtUtc: row.created_at_utc,
      createCommandId: row.create_command_id,
      credentialId: row.credential_id
    };
  });
  assertCondition(stableJson(actualSources) === stableJson(expectedSources), "order creation time or command provenance drifted from the inspected allowlist");

  const relationChecks = await client.query<{
    unknown_stays: string;
    unknown_amendments: string;
    unknown_segments: string;
    unknown_revisions: string;
    unknown_collections: string;
    unknown_occupants: string;
    unknown_corrections: string;
    unknown_coverages: string;
    unknown_ledger: string;
    unknown_claims: string;
    unknown_cleaning: string;
    unknown_transfers: string;
    unknown_room_days: string;
    unknown_bed_days: string;
  }>(`
    WITH target_orders AS (SELECT unnest($1::text[]) AS id),
         target_stays AS (SELECT id FROM stays WHERE order_id IN (SELECT id FROM target_orders)),
         target_segments AS (SELECT id FROM stay_segments WHERE stay_id IN (SELECT id FROM target_stays)),
         target_claims AS (SELECT id FROM inventory_claims WHERE source_type = 'ORDER_SEGMENT' AND source_id IN (SELECT id FROM target_segments))
    SELECT
      (SELECT count(*) FROM stays WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_stays,
      (SELECT count(*) FROM amendments WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_amendments,
      (SELECT count(*) FROM stay_segments WHERE stay_id NOT IN (SELECT id FROM target_stays))::text AS unknown_segments,
      (SELECT count(*) FROM pricing_revisions WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_revisions,
      (SELECT count(*) FROM collection_facts WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_collections,
      (SELECT count(*) FROM order_occupants WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_occupants,
      (SELECT count(*) FROM order_occupant_corrections WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_corrections,
      (SELECT count(*) FROM coverage_items WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_coverages,
      (SELECT count(*) FROM entitlement_ledger WHERE (order_id IS NULL OR NOT (order_id = ANY($1::text[]))) AND lot_id <> $2)::text AS unknown_ledger,
      (SELECT count(*) FROM inventory_claims WHERE id NOT IN (SELECT id FROM target_claims))::text AS unknown_claims,
      (SELECT count(*) FROM cleaning_tasks WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_cleaning,
      (SELECT count(*) FROM stay_collection_membership_transfers WHERE order_id NOT IN (SELECT id FROM target_orders))::text AS unknown_transfers,
      (SELECT count(*) FROM inventory_room_days WHERE whole_claim_id IS NOT NULL AND whole_claim_id NOT IN (SELECT id FROM target_claims))::text AS unknown_room_days,
      (SELECT count(*) FROM inventory_bed_days WHERE bed_claim_id IS NOT NULL AND bed_claim_id NOT IN (SELECT id FROM target_claims))::text AS unknown_bed_days
  `, [[...spec.orderIds], spec.demo.entitlementLotId]);
  const unknownRelations = relationChecks.rows[0];
  assertCondition(unknownRelations && Object.values(unknownRelations).every((count) => Number(count) === 0), "unknown order dependency rows exist");

  const nonOrderBusiness = await client.query<{
    maintenance: string;
    internal_use: string;
  }>("SELECT (SELECT count(*) FROM maintenance_locks)::text AS maintenance, (SELECT count(*) FROM internal_use_blocks)::text AS internal_use");
  assertCondition(Number(nonOrderBusiness.rows[0]?.maintenance) === 0, "maintenance data is outside the acceptance-order purge boundary");
  assertCondition(Number(nonOrderBusiness.rows[0]?.internal_use) === 0, "internal-use data is outside the acceptance-order purge boundary");

  await assertExactIds(client, "members", "id", [spec.demo.memberId]);
  await assertExactIds(client, "member_contracts", "id", [spec.demo.memberContractId]);
  await assertExactIds(client, "entitlement_lots", "id", [spec.demo.entitlementLotId]);
  await assertExactIds(client, "membership_orders", "id", [spec.demo.membershipOrderId]);
  await assertExactIds(client, "membership_payment_facts", "fact_id", [spec.demo.membershipPaymentFactId]);
  const memberGraph = await client.query<{ valid: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM members AS member
        JOIN member_property_links AS link ON link.member_id = member.id AND link.property_id = $1
        JOIN member_contracts AS contract ON contract.member_id = member.id AND contract.property_id = $1
        JOIN entitlement_lots AS lot ON lot.contract_id = contract.id
        JOIN membership_orders AS membership ON membership.member_id = member.id
          AND membership.property_id = $1
          AND membership.contract_id = contract.id
          AND membership.entitlement_lot_id = lot.id
        JOIN membership_payment_facts AS payment ON payment.membership_order_id = membership.id
       WHERE member.id = $2
         AND contract.id = $3
         AND contract.membership_order_id = $4
         AND contract.migration_source_id IS NULL
         AND lot.id = $5
         AND lot.migration_source_id IS NULL
         AND membership.id = $4
         AND payment.fact_id = $6
         AND payment.source_type = 'DIRECT_WECOM'
    ) AS valid
  `, [spec.propertyId, spec.demo.memberId, spec.demo.memberContractId, spec.demo.membershipOrderId, spec.demo.entitlementLotId, spec.demo.membershipPaymentFactId]);
  assertCondition(memberGraph.rows[0]?.valid, "demo member graph does not exactly match the seeded graph");

  const demoPasswordHash = scryptSync(DEMO_PASSWORD, DEMO_PASSWORD_SALT, 64).toString("hex");
  const subjects = await client.query<{
    id: string;
    username: string;
    display_name: string;
    password_salt: string;
    password_hash: string;
    status: string;
    auth_version: number;
  }>("SELECT id, username, display_name, password_salt, password_hash, status, auth_version FROM subjects ORDER BY id");
  const operator = subjects.rows.find(({ id }) => id === spec.demo.operatorSubjectId);
  const agent = subjects.rows.find(({ id }) => id === spec.demo.agentSubjectId);
  assertCondition(subjects.rows.length === 2 && operator && agent, "subject allowlist does not match the two demo subjects");
  assertCondition(operator.username === "operator" && operator.display_name === "Demo Operator" && operator.status === "ACTIVE", "operator subject identity drifted");
  assertCondition(agent.username === "agent-demo" && agent.display_name === "Demo Agent" && agent.status === "ACTIVE", "agent subject identity drifted");
  assertCondition(operator.auth_version === spec.expectedOperatorAuthVersion && agent.auth_version === 1, "demo subject authentication version drifted");
  assertCondition(operator.password_salt === DEMO_PASSWORD_SALT && operator.password_hash === demoPasswordHash, "operator no longer has the expected demo credential state");
  assertCondition(agent.password_salt === DEMO_PASSWORD_SALT && agent.password_hash === demoPasswordHash, "agent no longer has the expected demo credential state");

  const grants = await client.query<{ subject_id: string; property_id: string; access_level: string }>("SELECT subject_id, property_id, access_level FROM subject_property_grants ORDER BY subject_id");
  assertCondition(grants.rows.length === 2, "subject grants count drifted");
  assertCondition(grants.rows.every((row) => [spec.demo.operatorSubjectId, spec.demo.agentSubjectId].includes(row.subject_id) && row.property_id === spec.propertyId && row.access_level === "WRITE"), "subject grants are outside the demo boundary");

  const tokens = await client.query<{ id: string; subject_id: string; property_scope: string }>("SELECT id, subject_id, property_scope FROM api_tokens ORDER BY id");
  assertCondition(tokens.rows.every((row) => [spec.demo.operatorSubjectId, spec.demo.agentSubjectId].includes(row.subject_id) && row.property_scope === spec.propertyId), "API tokens are outside the demo subject/property boundary");
  const sessions = await client.query<{ id: string; subject_id: string }>("SELECT id, subject_id FROM web_sessions ORDER BY id");
  assertCondition(sessions.rows.every((row) => [spec.demo.operatorSubjectId, spec.demo.agentSubjectId].includes(row.subject_id)), "web sessions are outside the demo subject boundary");

  const commands = await client.query<{ command_type: string; created_at: Date }>(`
    SELECT command_type, created_at FROM command_executions
     WHERE subject_id = $1 AND property_id = $2
     ORDER BY created_at, id
  `, [spec.demo.operatorSubjectId, spec.propertyId]);
  assertExactCount("operator command executions", commands.rows.length, spec.expectedCounts.command_executions);
  assertCondition(commands.rows.every(({ created_at }) => created_at < cutoff), "command execution was created outside the accepted source window");
  const commandTypes: Record<string, number> = {};
  for (const { command_type } of commands.rows) commandTypes[command_type] = (commandTypes[command_type] ?? 0) + 1;
  const previews = await client.query<{ created_at: Date }>("SELECT created_at FROM command_previews WHERE subject_id = $1 AND property_id = $2", [spec.demo.operatorSubjectId, spec.propertyId]);
  assertExactCount("operator command previews", previews.rows.length, spec.expectedCounts.command_previews);
  assertCondition(previews.rows.every(({ created_at }) => created_at < cutoff), "command preview was created outside the accepted source window");
  const protocolRelations = await client.query<{ unknown_receipts: string; unknown_audits: string; invalid_receipt_cardinality: string; invalid_audit_cardinality: string }>(`
    SELECT
      (SELECT count(*) FROM command_receipts AS receipt LEFT JOIN command_executions AS command ON command.id = receipt.command_id WHERE command.id IS NULL)::text AS unknown_receipts,
      (SELECT count(*) FROM audit_entries AS audit LEFT JOIN command_executions AS command ON command.id = audit.command_id WHERE command.id IS NULL OR audit.subject_id <> $1)::text AS unknown_audits,
      (SELECT count(*) FROM (SELECT command.id FROM command_executions AS command LEFT JOIN command_receipts AS receipt ON receipt.command_id = command.id GROUP BY command.id HAVING count(receipt.id) <> 1) AS invalid)::text AS invalid_receipt_cardinality,
      (SELECT count(*) FROM (SELECT command.id FROM command_executions AS command LEFT JOIN audit_entries AS audit ON audit.command_id = command.id GROUP BY command.id HAVING count(audit.id) <> 1) AS invalid)::text AS invalid_audit_cardinality
  `, [spec.demo.operatorSubjectId]);
  const protocol = protocolRelations.rows[0];
  assertCondition(protocol && Number(protocol.unknown_receipts) === 0 && Number(protocol.unknown_audits) === 0, "protocol evidence is not owned by the exact acceptance command set");
  assertCondition(protocol && Number(protocol.invalid_receipt_cardinality) === 0 && Number(protocol.invalid_audit_cardinality) === 0, "command protocol cardinality drifted");

  const identityRow = identity.rows[0]!;
  const orderTimes = orderEvidence.map(({ createdAt }) => createdAt).sort();
  const commandTimes = commands.rows.map(({ created_at }) => created_at.toISOString()).sort();
  return {
    evidenceVersion: 1,
    target: {
      propertyId: spec.propertyId,
      orderIds: [...spec.orderIds].sort(),
      sourceCreatedBeforeExclusive: spec.sourceCreatedBeforeExclusive
    },
    database: {
      databaseName: identityRow.database_name,
      serverAddress: identityRow.server_address,
      serverPort: identityRow.server_port,
      systemIdentifier: identityRow.system_identifier,
      postmasterStartedAt: identityRow.postmaster_started_at.toISOString(),
      migrationNamesSha256: sha256(stableJson(migrations.rows.map(({ name }) => name)))
    },
    counts,
    orderEvidence,
    sourceWindow: {
      earliestOrderCreatedAt: orderTimes[0]!,
      latestOrderCreatedAt: orderTimes.at(-1)!,
      earliestCommandCreatedAt: commandTimes[0] ?? null,
      latestCommandCreatedAt: commandTimes.at(-1) ?? null,
      commandTypes: Object.fromEntries(Object.entries(commandTypes).sort(([left], [right]) => left.localeCompare(right)))
    },
    rowSetSha256,
    catalog,
    authentication: {
      operatorAuthVersion: operator.auth_version,
      operatorCredentialState: "DEMO_DEFAULT",
      agentCredentialState: "DEMO_DEFAULT",
      tokenIds: tokens.rows.map(({ id }) => id),
      sessionsSha256: sha256(stableJson(sessions.rows.map(normalizePgValue)))
    }
  };
}

async function readPrivatePassword(path: string): Promise<string> {
  assertCondition(isAbsolute(path), "operator password file path must be absolute");
  const stat = await lstat(path);
  assertCondition(stat.isFile() && !stat.isSymbolicLink(), "operator password path must be a regular non-symlink file");
  assertCondition((stat.mode & 0o077) === 0, "operator password file must not grant group or other permissions");
  if (typeof process.geteuid === "function") assertCondition(stat.uid === process.geteuid(), "operator password file must be owned by the purge process user");
  assertCondition(stat.size > 0 && stat.size <= 1024, "operator password file has an invalid size");
  const password = await readFile(path, "utf8");
  assertCondition(!password.includes("\n") && !password.includes("\r"), "operator password file must contain exactly one password without a newline");
  assertCondition(password.length >= 20 && password.length <= 256, "operator password must be between 20 and 256 characters");
  assertCondition(password !== DEMO_PASSWORD, "operator password must not reuse the demo password");
  return password;
}

async function truncateExactSnapshot(
  client: Client,
  spec: ProductionAcceptancePurgeSpec,
  password: string,
  operatorDisplayName: string,
  catalogBefore: PurgeEvidence["catalog"],
  priorOperatorAuthVersion: number
): Promise<ProductionAcceptancePurgeReport["deletionCounts"]> {
  const deletionCounts: ProductionAcceptancePurgeReport["deletionCounts"] = { ...spec.expectedCounts };
  const truncateList = purgeCountTables.map(quoteIdentifier).join(", ");
  await client.query(`TRUNCATE TABLE ${truncateList} RESTRICT`);

  const newSalt = randomBytes(32).toString("hex");
  const newPasswordHash = scryptSync(password, newSalt, 64).toString("hex");
  const insertedOperator = await client.query(`
    INSERT INTO subjects (id, username, display_name, password_salt, password_hash, status, auth_version)
    VALUES ($1, 'operator', $2, $3, $4, 'ACTIVE', $5)
  `, [spec.demo.operatorSubjectId, operatorDisplayName, newSalt, newPasswordHash, priorOperatorAuthVersion + 1]);
  assertExactCount("created formal operator subject", insertedOperator.rowCount ?? 0, 1);
  const insertedGrant = await client.query(`
    INSERT INTO subject_property_grants (subject_id, property_id, access_level)
    VALUES ($1, $2, 'WRITE')
  `, [spec.demo.operatorSubjectId, spec.propertyId]);
  assertExactCount("created formal operator grant", insertedGrant.rowCount ?? 0, 1);
  deletionCounts.agent_subject_deleted = 1;
  deletionCounts.operator_subject_rotated = 1;

  const remainingCounts = {} as Record<PurgeCountTable, number>;
  for (const table of purgeCountTables) remainingCounts[table] = await countRows(client, table);
  for (const table of purgeCountTables) {
    if (table === "subjects" || table === "subject_property_grants") continue;
    assertExactCount(`remaining ${table}`, remainingCounts[table], 0);
  }
  assertExactCount("remaining subjects", remainingCounts.subjects, 1);
  assertExactCount("remaining subject grants", remainingCounts.subject_property_grants, 1);
  const retainedOperator = await client.query<{ valid: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM subjects AS subject
      JOIN subject_property_grants AS property_grant ON property_grant.subject_id = subject.id
       AND property_grant.property_id = $1 AND property_grant.access_level = 'WRITE'
      WHERE subject.id = $2
        AND subject.username = 'operator'
        AND subject.display_name = $3
        AND subject.status = 'ACTIVE'
        AND subject.auth_version = $4
        AND subject.password_salt <> $5
        AND subject.password_hash <> $6
    ) AS valid
  `, [spec.propertyId, spec.demo.operatorSubjectId, operatorDisplayName, priorOperatorAuthVersion + 1, DEMO_PASSWORD_SALT, scryptSync(DEMO_PASSWORD, DEMO_PASSWORD_SALT, 64).toString("hex")]);
  assertCondition(retainedOperator.rows[0]?.valid, "retained operator was not safely converted from demo credentials");

  const catalogAfter = await catalogSnapshot(client);
  assertCondition(stableJson(catalogAfter) === stableJson(catalogBefore), "property, inventory, pricing, or reference catalog changed during purge");
  return deletionCounts;
}

export async function purgeProductionAcceptanceData(options: PurgeOptions): Promise<ProductionAcceptancePurgeReport> {
  const mode = options.mode ?? "inspect";
  assertCondition(["inspect", "dry-run", "apply"].includes(mode), `unsupported mode ${String(mode)}`);
  assertCondition(options.databaseUrl.trim() !== "", "DATABASE_URL is required");
  const spec = requireTestSpec(options.testSpec);

  if (mode === "apply") {
    assertCondition(options.applyConfirmation === APPLY_CONFIRMATION, `apply requires PURGE_PRODUCTION_ACCEPTANCE_APPLY=${APPLY_CONFIRMATION}`);
    assertCondition(options.applicationStoppedConfirmation === "CONFIRMED", "apply requires PURGE_PRODUCTION_APPLICATION_STOPPED=CONFIRMED");
    assertCondition(options.demoSeedDisabledConfirmation === "CONFIRMED", "apply requires PURGE_PRODUCTION_DEMO_SEED_DISABLED=CONFIRMED");
    assertCondition(options.approvalToken && /^[0-9a-f]{64}$/.test(options.approvalToken), "apply requires a 64-character inspection approval token");
    assertCondition(options.operatorPasswordFile, "apply requires PURGE_PRODUCTION_OPERATOR_PASSWORD_FILE");
  }

  const password = mode === "apply"
    ? await readPrivatePassword(options.operatorPasswordFile!)
    : "dry-run-password-never-committed";
  const operatorDisplayName = options.operatorDisplayName?.trim() || "QinTopia Operator";
  assertCondition(operatorDisplayName.length >= 3 && operatorDisplayName.length <= 80, "operator display name must be between 3 and 80 characters");

  const client = new pg.Client({ connectionString: options.databaseUrl, application_name: "qintopia-production-acceptance-purge-v1" });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE${mode === "inspect" ? " READ ONLY" : ""}`);
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))", [PURGE_LOCK_NAME]);
    if (mode !== "inspect") {
      await client.query(`LOCK TABLE ${purgeCountTables.map(quoteIdentifier).join(", ")} IN ACCESS EXCLUSIVE MODE`);
      await client.query(`LOCK TABLE ${catalogTables.map(quoteIdentifier).join(", ")} IN SHARE MODE`);
    }
    const evidence = await collectPreflightEvidence(client, spec);
    const approvalToken = sha256(stableJson(evidence));

    if (mode === "inspect") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { mode, approvalToken, evidence, deletionCounts: {}, committed: false };
    }
    if (mode === "apply") assertCondition(options.approvalToken === approvalToken, "approval token does not match the locked production snapshot");

    const deletionCounts = await truncateExactSnapshot(client, spec, password, operatorDisplayName, evidence.catalog, evidence.authentication.operatorAuthVersion);
    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { mode, approvalToken, evidence, deletionCounts, committed: false };
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return { mode, approvalToken, evidence, deletionCounts, committed: true };
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original failure remains authoritative; closing the client releases all locks.
      }
    }
    throw error;
  } finally {
    await client.end();
  }
}

function parseMode(arguments_: string[]): PurgeMode {
  if (arguments_.length === 0) return "inspect";
  if (arguments_.length === 2 && arguments_[0] === "--mode" && ["inspect", "dry-run", "apply"].includes(arguments_[1] ?? "")) {
    return arguments_[1] as PurgeMode;
  }
  throw new Error("Usage: purge-production-acceptance-data.ts [--mode inspect|dry-run|apply]");
}

async function runCli(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  assertCondition(databaseUrl, "DATABASE_URL is required; this command has no fallback database");
  const report = await purgeProductionAcceptanceData({
    databaseUrl,
    mode,
    ...(mode === "apply" ? {
      applyConfirmation: process.env.PURGE_PRODUCTION_ACCEPTANCE_APPLY,
      applicationStoppedConfirmation: process.env.PURGE_PRODUCTION_APPLICATION_STOPPED,
      demoSeedDisabledConfirmation: process.env.PURGE_PRODUCTION_DEMO_SEED_DISABLED,
      approvalToken: process.env.PURGE_PRODUCTION_ACCEPTANCE_APPROVAL_TOKEN,
      operatorPasswordFile: process.env.PURGE_PRODUCTION_OPERATOR_PASSWORD_FILE,
      operatorDisplayName: process.env.PURGE_PRODUCTION_OPERATOR_DISPLAY_NAME
    } : {})
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
