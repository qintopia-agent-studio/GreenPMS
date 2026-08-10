import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
  KeyObject
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { stableHash, stableJson } from "@qintopia/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "./schema.ts";
import type {
  HistoricalImportDryRunReport,
  HistoricalOrderImportManifest
} from "./historical-order-import.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_TIMESTAMP_WITH_OFFSET = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const APPROVAL_PURPOSE = "QINTOPIA_HISTORICAL_ORDER_IMPORT_APPLY" as const;
const DRY_RUN_PURPOSE = "QINTOPIA_HISTORICAL_ORDER_IMPORT_DRY_RUN" as const;
const RECOVERY_ATTESTATION_PURPOSE = "QINTOPIA_HISTORICAL_ORDER_IMPORT_RECOVERY" as const;
const APPROVAL_SOURCE_SYSTEM = "HISTORICAL_IMPORT_APPROVAL_V1";
const MAX_APPROVAL_LIFETIME_MS = 30 * 60_000;
const MAX_DRY_RUN_AGE_MS = 30 * 60_000;
const MAX_RECOVERY_EVIDENCE_AGE_MS = 24 * 60 * 60_000;

type ObjectRecord = Record<string, unknown>;
type ApprovalKey = KeyObject | string | Buffer;
type ApprovalExecutor = Kysely<Database> | Transaction<Database>;

export interface HistoricalImportDryRunEvidence {
  evidenceVersion: 1;
  purpose: typeof DRY_RUN_PURPOSE;
  manifestHash: string;
  propertyId: string;
  targetDatabaseFingerprint: string;
  completedAt: string;
  reportHash: string;
  report: HistoricalImportDryRunReport;
  evidenceHash: string;
}

export interface HistoricalImportBackupEvidence {
  evidenceVersion: 1;
  targetDatabaseFingerprint: string;
  artifactId: string;
  artifactSha256: string;
  completedAt: string;
}

export interface HistoricalImportRestoreEvidence {
  evidenceVersion: 1;
  verificationId: string;
  backupArtifactSha256: string;
  restoredDatabaseFingerprint: string;
  completedAt: string;
  result: "PASSED";
}

export interface HistoricalImportRecoveryAttestationPayload {
  attestationVersion: 1;
  purpose: typeof RECOVERY_ATTESTATION_PURPOSE;
  backup: HistoricalImportBackupEvidence;
  restore: HistoricalImportRestoreEvidence;
}

export interface HistoricalImportRecoveryAttestation {
  keyId: string;
  signatureAlgorithm: "Ed25519";
  payload: HistoricalImportRecoveryAttestationPayload;
  signature: string;
}

export interface HistoricalImportApprovalPayload {
  approvalVersion: 1;
  purpose: typeof APPROVAL_PURPOSE;
  manifestHash: string;
  propertyId: string;
  targetDatabaseFingerprint: string;
  dryRun: {
    completedAt: string;
    reportHash: string;
    evidenceHash: string;
  };
  candidateDryRun: {
    manifestHash: string;
    propertyId: string;
    targetDatabaseFingerprint: string;
    completedAt: string;
    reportHash: string;
    evidenceHash: string;
  };
  backup: HistoricalImportBackupEvidence & { evidenceHash: string };
  restore: HistoricalImportRestoreEvidence & { evidenceHash: string };
  recoveryAttestation: {
    keyId: string;
    signatureAlgorithm: "Ed25519";
    signature: string;
    attestationHash: string;
  };
  approvedBy: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface HistoricalImportApprovalCredential {
  keyId: string;
  signatureAlgorithm: "Ed25519";
  payload: HistoricalImportApprovalPayload;
  signature: string;
}

export interface HistoricalImportApprovalConsumptionReceipt {
  approvalRunId: string;
  approvalHash: string;
  nonceHash: string;
  keyId: string;
  approvedBy: string;
}

export interface HistoricalImportApprovalAuthorization {
  readonly approvalHash: string;
  readonly credential: HistoricalImportApprovalCredential;
}

interface ApprovalConsumptionContext {
  manifestHash: string;
  propertyId: string;
  sourceSystem: string;
  cutoverAt: string;
}

const verifiedAuthorizations = new WeakSet<object>();

function fail(message: string): never {
  throw new Error(`Historical import approval validation failed: ${message}`);
}

function object(value: unknown, field: string, expectedKeys: readonly string[]): ObjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  const record = value as ObjectRecord;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} has unexpected or missing fields`);
  }
  return record;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a nonblank string`);
  if (value.length > 1_024) fail(`${field} is too long`);
  return value;
}

function exact<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) fail(`${field} must equal ${expected}`);
  return expected;
}

function hash(value: unknown, field: string): string {
  const result = string(value, field);
  if (!SHA256.test(result)) fail(`${field} must be a lower-case SHA-256`);
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(result);
  const parsed = new Date(result);
  if (!match || Number.isNaN(parsed.getTime())) {
    fail(`${field} must be an ISO timestamp with an offset`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > daysInMonth) fail(`${field} must be an ISO timestamp with an offset`);
  return parsed.toISOString();
}

function nonce(value: unknown): string {
  const result = string(value, "payload.nonce");
  if (result.length !== 43 || !BASE64URL.test(result) || Buffer.from(result, "base64url").length !== 32) {
    fail("payload.nonce must be a 256-bit base64url value");
  }
  return result;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as ObjectRecord)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseReport(value: unknown): HistoricalImportDryRunReport {
  const report = value as HistoricalImportDryRunReport;
  if (!report || typeof report !== "object" || report.mode !== "DRY_RUN") fail("dry-run report must be a successful DRY_RUN report");
  hash(report.manifestHash, "dry-run report manifestHash");
  string(report.propertyId, "dry-run report propertyId");
  if (!report.expected || typeof report.expected !== "object" || !report.reconciliation || typeof report.reconciliation !== "object") {
    fail("dry-run report is incomplete");
  }
  return structuredClone(report);
}

function expectedDryRunEvidenceHash(input: {
  manifestHash: string;
  propertyId: string;
  targetDatabaseFingerprint: string;
  completedAt: string;
  reportHash: string;
  report: HistoricalImportDryRunReport;
}): string {
  return stableHash({
    evidenceVersion: 1,
    purpose: DRY_RUN_PURPOSE,
    ...input
  });
}

export function createHistoricalImportDryRunEvidence(input: {
  report: HistoricalImportDryRunReport;
  targetDatabaseFingerprint: string;
  completedAt?: string | Date;
}): HistoricalImportDryRunEvidence {
  const report = parseReport(input.report);
  const withoutHash = {
    evidenceVersion: 1 as const,
    purpose: DRY_RUN_PURPOSE,
    manifestHash: hash(report.manifestHash, "dry-run report manifestHash"),
    propertyId: string(report.propertyId, "dry-run report propertyId"),
    targetDatabaseFingerprint: hash(input.targetDatabaseFingerprint, "target database fingerprint"),
    completedAt: timestamp(
      input.completedAt instanceof Date ? input.completedAt.toISOString() : input.completedAt ?? new Date().toISOString(),
      "dry-run completedAt"
    ),
    reportHash: stableHash(report),
    report
  };
  return freeze({ ...withoutHash, evidenceHash: stableHash(withoutHash) });
}

export function parseHistoricalImportDryRunEvidence(value: unknown): HistoricalImportDryRunEvidence {
  const input = object(value, "dry-run evidence", [
    "evidenceVersion", "purpose", "manifestHash", "propertyId", "targetDatabaseFingerprint",
    "completedAt", "reportHash", "report", "evidenceHash"
  ]);
  const report = parseReport(input.report);
  const withoutHash = {
    evidenceVersion: exact(input.evidenceVersion, 1, "dry-run evidenceVersion"),
    purpose: exact(input.purpose, DRY_RUN_PURPOSE, "dry-run purpose"),
    manifestHash: hash(input.manifestHash, "dry-run manifestHash"),
    propertyId: string(input.propertyId, "dry-run propertyId"),
    targetDatabaseFingerprint: hash(input.targetDatabaseFingerprint, "dry-run target database fingerprint"),
    completedAt: timestamp(input.completedAt, "dry-run completedAt"),
    reportHash: hash(input.reportHash, "dry-run reportHash"),
    report
  };
  const evidenceHash = hash(input.evidenceHash, "dry-run evidenceHash");
  if (withoutHash.manifestHash !== report.manifestHash || withoutHash.propertyId !== report.propertyId) {
    fail("dry-run evidence identity does not match its report");
  }
  if (withoutHash.reportHash !== stableHash(report)) fail("dry-run report hash does not match");
  if (evidenceHash !== stableHash(withoutHash)) fail("dry-run evidence hash does not match");
  return freeze({ ...withoutHash, evidenceHash });
}

export function parseHistoricalImportBackupEvidence(value: unknown): HistoricalImportBackupEvidence {
  const input = object(value, "backup evidence", [
    "evidenceVersion", "targetDatabaseFingerprint", "artifactId", "artifactSha256", "completedAt"
  ]);
  return freeze({
    evidenceVersion: exact(input.evidenceVersion, 1, "backup evidenceVersion"),
    targetDatabaseFingerprint: hash(input.targetDatabaseFingerprint, "backup target database fingerprint"),
    artifactId: string(input.artifactId, "backup artifactId"),
    artifactSha256: hash(input.artifactSha256, "backup artifactSha256"),
    completedAt: timestamp(input.completedAt, "backup completedAt")
  });
}

export function parseHistoricalImportRestoreEvidence(value: unknown): HistoricalImportRestoreEvidence {
  const input = object(value, "restore evidence", [
    "evidenceVersion", "verificationId", "backupArtifactSha256", "restoredDatabaseFingerprint",
    "completedAt", "result"
  ]);
  return freeze({
    evidenceVersion: exact(input.evidenceVersion, 1, "restore evidenceVersion"),
    verificationId: string(input.verificationId, "restore verificationId"),
    backupArtifactSha256: hash(input.backupArtifactSha256, "restore backupArtifactSha256"),
    restoredDatabaseFingerprint: hash(input.restoredDatabaseFingerprint, "restore database fingerprint"),
    completedAt: timestamp(input.completedAt, "restore completedAt"),
    result: exact(input.result, "PASSED", "restore result")
  });
}

function publicKeyFor(key: ApprovalKey): KeyObject {
  try {
    if (key instanceof KeyObject) {
      if (key.type !== "public") fail("approval public key input must not be a private key");
      if (key.asymmetricKeyType !== "ed25519") fail("approval key must be Ed25519");
      return key;
    }
    try {
      createPrivateKey(key);
      fail("approval public key input must not be a private key");
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("Historical import approval validation failed:")) throw error;
    }
    const candidate = createPublicKey(key);
    if (candidate.asymmetricKeyType !== "ed25519") fail("approval key must be Ed25519");
    return candidate;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Historical import approval validation failed:")) throw error;
    fail("approval key is invalid");
  }
}

function privateKeyFor(key: ApprovalKey): KeyObject {
  try {
    if (key instanceof KeyObject) {
      if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
        fail("approval private key must be Ed25519");
      }
      return key;
    }
    const candidate = createPrivateKey(key);
    if (candidate.asymmetricKeyType !== "ed25519") fail("approval private key must be Ed25519");
    return candidate;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Historical import approval validation failed:")) throw error;
    fail("approval private key is invalid");
  }
}

export function historicalImportApprovalKeyId(key: ApprovalKey): string {
  const der = publicKeyFor(key).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function historicalImportApprovalPrivateKeyId(privateKey: KeyObject): string {
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function assertRecoveryEvidencePair(
  backup: HistoricalImportBackupEvidence,
  restore: HistoricalImportRestoreEvidence
): void {
  if (restore.backupArtifactSha256 !== backup.artifactSha256) {
    fail("restore verification does not reference the attested backup artifact");
  }
  if (restore.restoredDatabaseFingerprint === backup.targetDatabaseFingerprint) {
    fail("restore verification must run against a separate database");
  }
  if (new Date(restore.completedAt).getTime() < new Date(backup.completedAt).getTime()) {
    fail("restore verification must complete after its backup");
  }
}

function recoveryAttestationBody(payload: HistoricalImportRecoveryAttestationPayload): Buffer {
  return Buffer.from(stableJson(payload), "utf8");
}

export function parseHistoricalImportRecoveryAttestation(value: unknown): HistoricalImportRecoveryAttestation {
  const input = object(value, "recovery attestation", ["keyId", "signatureAlgorithm", "payload", "signature"]);
  const payloadInput = object(input.payload, "recovery attestation payload", [
    "attestationVersion", "purpose", "backup", "restore"
  ]);
  const backup = parseHistoricalImportBackupEvidence(payloadInput.backup);
  const restore = parseHistoricalImportRestoreEvidence(payloadInput.restore);
  assertRecoveryEvidencePair(backup, restore);
  const signature = string(input.signature, "recovery attestation signature");
  if (!BASE64URL.test(signature)) fail("recovery attestation signature must be base64url");
  return freeze({
    keyId: hash(input.keyId, "recovery attestation keyId"),
    signatureAlgorithm: exact(input.signatureAlgorithm, "Ed25519", "recovery attestation signatureAlgorithm"),
    payload: {
      attestationVersion: exact(payloadInput.attestationVersion, 1, "recovery attestation version"),
      purpose: exact(payloadInput.purpose, RECOVERY_ATTESTATION_PURPOSE, "recovery attestation purpose"),
      backup,
      restore
    },
    signature
  });
}

export function issueHistoricalImportRecoveryAttestation(input: {
  backupEvidence: HistoricalImportBackupEvidence | unknown;
  restoreEvidence: HistoricalImportRestoreEvidence | unknown;
}, privateKeyInput: ApprovalKey): HistoricalImportRecoveryAttestation {
  const backup = parseHistoricalImportBackupEvidence(input.backupEvidence);
  const restore = parseHistoricalImportRestoreEvidence(input.restoreEvidence);
  assertRecoveryEvidencePair(backup, restore);
  const privateKey = privateKeyFor(privateKeyInput);
  const payload: HistoricalImportRecoveryAttestationPayload = {
    attestationVersion: 1,
    purpose: RECOVERY_ATTESTATION_PURPOSE,
    backup,
    restore
  };
  return freeze({
    keyId: historicalImportApprovalPrivateKeyId(privateKey),
    signatureAlgorithm: "Ed25519",
    payload,
    signature: sign(null, recoveryAttestationBody(payload), privateKey).toString("base64url")
  });
}

export function verifyHistoricalImportRecoveryAttestation(
  value: HistoricalImportRecoveryAttestation | unknown,
  publicKeyInput: ApprovalKey
): HistoricalImportRecoveryAttestation {
  const attestation = parseHistoricalImportRecoveryAttestation(value);
  const publicKey = publicKeyFor(publicKeyInput);
  if (attestation.keyId !== historicalImportApprovalKeyId(publicKey)) {
    fail("recovery attestation key id does not match the configured public key");
  }
  if (!verify(
    null,
    recoveryAttestationBody(attestation.payload),
    publicKey,
    Buffer.from(attestation.signature, "base64url")
  )) {
    fail("recovery attestation signature is invalid");
  }
  return attestation;
}

export async function inspectHistoricalImportBackupArtifact(path: string): Promise<{
  sha256: string;
  completedAt: string;
}> {
  let artifact;
  try {
    artifact = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    fail("backup artifact must be a readable regular file and not a symbolic link");
  }
  try {
    const metadata = await artifact.stat();
    if (!metadata.isFile()) fail("backup artifact must be a regular file");
    if ((metadata.mode & 0o077) !== 0) fail("backup artifact must be owner-private");
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (currentUid !== null && metadata.uid !== currentUid) fail("backup artifact must be owned by the current user");
    const digest = createHash("sha256");
    const stream = artifact.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk as Buffer);
    const afterRead = await artifact.stat();
    if (afterRead.dev !== metadata.dev
      || afterRead.ino !== metadata.ino
      || afterRead.size !== metadata.size
      || afterRead.mtimeMs !== metadata.mtimeMs
      || afterRead.ctimeMs !== metadata.ctimeMs) {
      fail("backup artifact changed while it was being verified");
    }
    return { sha256: digest.digest("hex"), completedAt: metadata.mtime.toISOString() };
  } finally {
    await artifact.close();
  }
}

export async function hashHistoricalImportBackupArtifact(path: string): Promise<string> {
  return (await inspectHistoricalImportBackupArtifact(path)).sha256;
}

function signatureBody(payload: HistoricalImportApprovalPayload): Buffer {
  return Buffer.from(stableJson(payload), "utf8");
}

function assertEvidenceTimeline(payload: HistoricalImportApprovalPayload): void {
  const issuedAtMs = new Date(payload.issuedAt).getTime();
  const expiresAtMs = new Date(payload.expiresAt).getTime();
  const dryRunAtMs = new Date(payload.dryRun.completedAt).getTime();
  const candidateDryRunAtMs = new Date(payload.candidateDryRun.completedAt).getTime();
  const backupAtMs = new Date(payload.backup.completedAt).getTime();
  const restoreAtMs = new Date(payload.restore.completedAt).getTime();
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > MAX_APPROVAL_LIFETIME_MS) {
    fail("approval lifetime must be positive and no longer than 30 minutes");
  }
  if (dryRunAtMs > issuedAtMs || issuedAtMs - dryRunAtMs > MAX_DRY_RUN_AGE_MS) {
    fail("dry-run evidence must be successful within 30 minutes before approval");
  }
  if (candidateDryRunAtMs > issuedAtMs || issuedAtMs - candidateDryRunAtMs > MAX_DRY_RUN_AGE_MS) {
    fail("candidate dry-run evidence must be successful within 30 minutes before approval");
  }
  if (backupAtMs > issuedAtMs || restoreAtMs > issuedAtMs
    || issuedAtMs - backupAtMs > MAX_RECOVERY_EVIDENCE_AGE_MS
    || issuedAtMs - restoreAtMs > MAX_RECOVERY_EVIDENCE_AGE_MS) {
    fail("recovery evidence must be completed within 24 hours before approval");
  }
  if (restoreAtMs < backupAtMs) fail("restore verification must complete after its backup");
  if (candidateDryRunAtMs < restoreAtMs) fail("candidate dry-run must complete after the backup restore");
  if (payload.backup.targetDatabaseFingerprint !== payload.targetDatabaseFingerprint) {
    fail("backup evidence is for a different target database");
  }
  if (payload.restore.backupArtifactSha256 !== payload.backup.artifactSha256) {
    fail("restore verification does not reference the approved backup artifact");
  }
  if (payload.restore.restoredDatabaseFingerprint === payload.targetDatabaseFingerprint) {
    fail("restore verification must run against a separate database");
  }
  if (payload.candidateDryRun.targetDatabaseFingerprint !== payload.restore.restoredDatabaseFingerprint) {
    fail("candidate dry-run is not from the restored database");
  }
  if (payload.candidateDryRun.manifestHash !== payload.manifestHash
    || payload.candidateDryRun.propertyId !== payload.propertyId) {
    fail("candidate dry-run manifest or property does not match production");
  }
  if (payload.candidateDryRun.reportHash !== payload.dryRun.reportHash) {
    fail("candidate and production dry-run reports do not match");
  }
}

export function issueHistoricalImportApproval(input: {
  dryRunEvidence: HistoricalImportDryRunEvidence | unknown;
  candidateDryRunEvidence: HistoricalImportDryRunEvidence | unknown;
  recoveryAttestation: HistoricalImportRecoveryAttestation | unknown;
  recoveryPublicKey: ApprovalKey;
  approvedBy: string;
  issuedAt?: string | Date;
  expiresAt: string | Date;
  nonce?: string;
}, privateKeyInput: ApprovalKey): HistoricalImportApprovalCredential {
  const dryRun = parseHistoricalImportDryRunEvidence(input.dryRunEvidence);
  if (input.candidateDryRunEvidence === undefined) fail("candidate dry-run evidence is required");
  const candidateDryRun = parseHistoricalImportDryRunEvidence(input.candidateDryRunEvidence);
  const recoveryAttestation = verifyHistoricalImportRecoveryAttestation(
    input.recoveryAttestation,
    input.recoveryPublicKey
  );
  const { backup, restore } = recoveryAttestation.payload;
  const privateKey = privateKeyFor(privateKeyInput);
  if (historicalImportApprovalPrivateKeyId(privateKey) === recoveryAttestation.keyId) {
    fail("approval and recovery attestation must use independent keys");
  }
  const payload: HistoricalImportApprovalPayload = {
    approvalVersion: 1,
    purpose: APPROVAL_PURPOSE,
    manifestHash: dryRun.manifestHash,
    propertyId: dryRun.propertyId,
    targetDatabaseFingerprint: dryRun.targetDatabaseFingerprint,
    dryRun: {
      completedAt: dryRun.completedAt,
      reportHash: dryRun.reportHash,
      evidenceHash: dryRun.evidenceHash
    },
    candidateDryRun: {
      manifestHash: candidateDryRun.manifestHash,
      propertyId: candidateDryRun.propertyId,
      targetDatabaseFingerprint: candidateDryRun.targetDatabaseFingerprint,
      completedAt: candidateDryRun.completedAt,
      reportHash: candidateDryRun.reportHash,
      evidenceHash: candidateDryRun.evidenceHash
    },
    backup: { ...backup, evidenceHash: stableHash(backup) },
    restore: { ...restore, evidenceHash: stableHash(restore) },
    recoveryAttestation: {
      keyId: recoveryAttestation.keyId,
      signatureAlgorithm: recoveryAttestation.signatureAlgorithm,
      signature: recoveryAttestation.signature,
      attestationHash: stableHash(recoveryAttestation)
    },
    approvedBy: string(input.approvedBy, "approvedBy"),
    issuedAt: timestamp(input.issuedAt instanceof Date ? input.issuedAt.toISOString() : input.issuedAt ?? new Date().toISOString(), "issuedAt"),
    expiresAt: timestamp(input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt, "expiresAt"),
    nonce: nonce(input.nonce ?? randomBytes(32).toString("base64url"))
  };
  assertEvidenceTimeline(payload);
  const credential: HistoricalImportApprovalCredential = {
    keyId: historicalImportApprovalPrivateKeyId(privateKey),
    signatureAlgorithm: "Ed25519",
    payload,
    signature: sign(null, signatureBody(payload), privateKey).toString("base64url")
  };
  return freeze(credential);
}

function parseBackupWithHash(value: unknown): HistoricalImportApprovalPayload["backup"] {
  const input = object(value, "payload.backup", [
    "evidenceVersion", "targetDatabaseFingerprint", "artifactId", "artifactSha256", "completedAt", "evidenceHash"
  ]);
  const evidence = parseHistoricalImportBackupEvidence({
    evidenceVersion: input.evidenceVersion,
    targetDatabaseFingerprint: input.targetDatabaseFingerprint,
    artifactId: input.artifactId,
    artifactSha256: input.artifactSha256,
    completedAt: input.completedAt
  });
  const evidenceHash = hash(input.evidenceHash, "payload.backup.evidenceHash");
  if (evidenceHash !== stableHash(evidence)) fail("backup evidence hash does not match");
  return { ...evidence, evidenceHash };
}

function parseRestoreWithHash(value: unknown): HistoricalImportApprovalPayload["restore"] {
  const input = object(value, "payload.restore", [
    "evidenceVersion", "verificationId", "backupArtifactSha256", "restoredDatabaseFingerprint",
    "completedAt", "result", "evidenceHash"
  ]);
  const evidence = parseHistoricalImportRestoreEvidence({
    evidenceVersion: input.evidenceVersion,
    verificationId: input.verificationId,
    backupArtifactSha256: input.backupArtifactSha256,
    restoredDatabaseFingerprint: input.restoredDatabaseFingerprint,
    completedAt: input.completedAt,
    result: input.result
  });
  const evidenceHash = hash(input.evidenceHash, "payload.restore.evidenceHash");
  if (evidenceHash !== stableHash(evidence)) fail("restore evidence hash does not match");
  return { ...evidence, evidenceHash };
}

function parseRecoveryAttestationBinding(
  value: unknown,
  backupWithHash: HistoricalImportApprovalPayload["backup"],
  restoreWithHash: HistoricalImportApprovalPayload["restore"]
): HistoricalImportApprovalPayload["recoveryAttestation"] {
  const input = object(value, "payload.recoveryAttestation", [
    "keyId", "signatureAlgorithm", "signature", "attestationHash"
  ]);
  const binding = {
    keyId: hash(input.keyId, "payload.recoveryAttestation.keyId"),
    signatureAlgorithm: exact(input.signatureAlgorithm, "Ed25519", "payload.recoveryAttestation.signatureAlgorithm"),
    signature: string(input.signature, "payload.recoveryAttestation.signature"),
    attestationHash: hash(input.attestationHash, "payload.recoveryAttestation.attestationHash")
  };
  if (!BASE64URL.test(binding.signature)) fail("payload.recoveryAttestation.signature must be base64url");
  const attestation = recoveryAttestationFromApprovalEvidence(backupWithHash, restoreWithHash, binding);
  if (binding.attestationHash !== stableHash(attestation)) {
    fail("recovery attestation hash does not match its signed evidence");
  }
  return binding;
}

function recoveryAttestationFromApprovalEvidence(
  backupWithHash: HistoricalImportApprovalPayload["backup"],
  restoreWithHash: HistoricalImportApprovalPayload["restore"],
  binding: HistoricalImportApprovalPayload["recoveryAttestation"]
): HistoricalImportRecoveryAttestation {
  const { evidenceHash: _backupEvidenceHash, ...backup } = backupWithHash;
  const { evidenceHash: _restoreEvidenceHash, ...restore } = restoreWithHash;
  return {
    keyId: binding.keyId,
    signatureAlgorithm: binding.signatureAlgorithm,
    payload: {
      attestationVersion: 1,
      purpose: RECOVERY_ATTESTATION_PURPOSE,
      backup,
      restore
    },
    signature: binding.signature
  };
}

export function parseHistoricalImportApprovalCredential(value: unknown): HistoricalImportApprovalCredential {
  const input = object(value, "approval credential", ["keyId", "signatureAlgorithm", "payload", "signature"]);
  const payloadInput = object(input.payload, "payload", [
    "approvalVersion", "purpose", "manifestHash", "propertyId", "targetDatabaseFingerprint",
    "dryRun", "candidateDryRun", "backup", "restore", "recoveryAttestation",
    "approvedBy", "issuedAt", "expiresAt", "nonce"
  ]);
  const dryRunInput = object(payloadInput.dryRun, "payload.dryRun", ["completedAt", "reportHash", "evidenceHash"]);
  const candidateDryRunInput = object(payloadInput.candidateDryRun, "payload.candidateDryRun", [
    "manifestHash", "propertyId", "targetDatabaseFingerprint", "completedAt", "reportHash", "evidenceHash"
  ]);
  const backup = parseBackupWithHash(payloadInput.backup);
  const restore = parseRestoreWithHash(payloadInput.restore);
  const payload: HistoricalImportApprovalPayload = {
    approvalVersion: exact(payloadInput.approvalVersion, 1, "payload.approvalVersion"),
    purpose: exact(payloadInput.purpose, APPROVAL_PURPOSE, "payload.purpose"),
    manifestHash: hash(payloadInput.manifestHash, "payload.manifestHash"),
    propertyId: string(payloadInput.propertyId, "payload.propertyId"),
    targetDatabaseFingerprint: hash(payloadInput.targetDatabaseFingerprint, "payload.targetDatabaseFingerprint"),
    dryRun: {
      completedAt: timestamp(dryRunInput.completedAt, "payload.dryRun.completedAt"),
      reportHash: hash(dryRunInput.reportHash, "payload.dryRun.reportHash"),
      evidenceHash: hash(dryRunInput.evidenceHash, "payload.dryRun.evidenceHash")
    },
    candidateDryRun: {
      manifestHash: hash(candidateDryRunInput.manifestHash, "payload.candidateDryRun.manifestHash"),
      propertyId: string(candidateDryRunInput.propertyId, "payload.candidateDryRun.propertyId"),
      targetDatabaseFingerprint: hash(candidateDryRunInput.targetDatabaseFingerprint, "payload.candidateDryRun.targetDatabaseFingerprint"),
      completedAt: timestamp(candidateDryRunInput.completedAt, "payload.candidateDryRun.completedAt"),
      reportHash: hash(candidateDryRunInput.reportHash, "payload.candidateDryRun.reportHash"),
      evidenceHash: hash(candidateDryRunInput.evidenceHash, "payload.candidateDryRun.evidenceHash")
    },
    backup,
    restore,
    recoveryAttestation: parseRecoveryAttestationBinding(payloadInput.recoveryAttestation, backup, restore),
    approvedBy: string(payloadInput.approvedBy, "payload.approvedBy"),
    issuedAt: timestamp(payloadInput.issuedAt, "payload.issuedAt"),
    expiresAt: timestamp(payloadInput.expiresAt, "payload.expiresAt"),
    nonce: nonce(payloadInput.nonce)
  };
  const signature = string(input.signature, "signature");
  if (!BASE64URL.test(signature)) fail("signature must be base64url");
  const keyId = hash(input.keyId, "keyId");
  if (keyId === payload.recoveryAttestation.keyId) {
    fail("approval and recovery attestation must use independent keys");
  }
  return freeze({
    keyId,
    signatureAlgorithm: exact(input.signatureAlgorithm, "Ed25519", "signatureAlgorithm"),
    payload,
    signature
  });
}

export function verifyHistoricalImportApproval(
  value: HistoricalImportApprovalCredential | unknown,
  publicKeyInput: ApprovalKey,
  context: {
    manifestHash: string;
    propertyId: string;
    targetDatabaseFingerprint: string;
    dryRunReport: HistoricalImportDryRunReport;
    now?: Date;
  },
  recoveryPublicKeyInput: ApprovalKey
): HistoricalImportApprovalCredential {
  const credential = verifyHistoricalImportApprovalSignature(value, publicKeyInput, recoveryPublicKeyInput);
  assertHistoricalImportApprovalIdentity(credential, context);
  const now = context.now ?? new Date();
  if (new Date(credential.payload.issuedAt).getTime() > now.getTime()) fail("approval was issued in the future");
  if (now.getTime() >= new Date(credential.payload.expiresAt).getTime()) fail("approval credential has expired");
  if (now.getTime() - new Date(credential.payload.dryRun.completedAt).getTime() > MAX_DRY_RUN_AGE_MS) {
    fail("approved dry-run report is no longer recent");
  }
  if (now.getTime() - new Date(credential.payload.candidateDryRun.completedAt).getTime() > MAX_DRY_RUN_AGE_MS) {
    fail("approved candidate dry-run report is no longer recent");
  }
  const report = parseReport(context.dryRunReport);
  if (report.manifestHash !== credential.payload.manifestHash || report.propertyId !== credential.payload.propertyId
    || stableHash(report) !== credential.payload.dryRun.reportHash) {
    fail("current dry-run report does not match the approved dry-run report");
  }
  if (credential.payload.dryRun.evidenceHash !== expectedDryRunEvidenceHash({
    manifestHash: credential.payload.manifestHash,
    propertyId: credential.payload.propertyId,
    targetDatabaseFingerprint: credential.payload.targetDatabaseFingerprint,
    completedAt: credential.payload.dryRun.completedAt,
    reportHash: credential.payload.dryRun.reportHash,
    report
  })) {
    fail("production dry-run evidence hash does not match the current report");
  }
  if (credential.payload.candidateDryRun.evidenceHash !== expectedDryRunEvidenceHash({
    manifestHash: credential.payload.candidateDryRun.manifestHash,
    propertyId: credential.payload.candidateDryRun.propertyId,
    targetDatabaseFingerprint: credential.payload.candidateDryRun.targetDatabaseFingerprint,
    completedAt: credential.payload.candidateDryRun.completedAt,
    reportHash: credential.payload.candidateDryRun.reportHash,
    report
  })) {
    fail("candidate dry-run evidence hash does not match the approved report");
  }
  return credential;
}

function verifyHistoricalImportApprovalSignature(
  value: HistoricalImportApprovalCredential | unknown,
  publicKeyInput: ApprovalKey,
  recoveryPublicKeyInput: ApprovalKey
): HistoricalImportApprovalCredential {
  const credential = parseHistoricalImportApprovalCredential(value);
  const publicKey = publicKeyFor(publicKeyInput);
  if (credential.keyId !== historicalImportApprovalKeyId(publicKey)) fail("approval key id does not match the configured public key");
  if (!verify(null, signatureBody(credential.payload), publicKey, Buffer.from(credential.signature, "base64url"))) {
    fail("approval signature is invalid");
  }
  verifyHistoricalImportRecoveryAttestation(recoveryAttestationFromApprovalEvidence(
    credential.payload.backup,
    credential.payload.restore,
    credential.payload.recoveryAttestation
  ), recoveryPublicKeyInput);
  assertEvidenceTimeline(credential.payload);
  return credential;
}

function assertHistoricalImportApprovalIdentity(
  credential: HistoricalImportApprovalCredential,
  context: { manifestHash: string; propertyId: string; targetDatabaseFingerprint: string }
): void {
  if (credential.payload.manifestHash !== hash(context.manifestHash, "context manifestHash")) fail("approval is for a different manifest");
  if (credential.payload.propertyId !== string(context.propertyId, "context propertyId")) fail("approval is for a different property");
  if (credential.payload.targetDatabaseFingerprint !== hash(context.targetDatabaseFingerprint, "context target database fingerprint")) {
    fail("approval is for a different target database");
  }
}

function record(value: unknown): ObjectRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : null;
}

async function existingApprovalConsumption(
  db: ApprovalExecutor,
  credential: HistoricalImportApprovalCredential,
  approvalHash: string,
  nonceHash: string,
  context: ApprovalConsumptionContext
): Promise<HistoricalImportApprovalConsumptionReceipt | null> {
  const existing = await db.selectFrom("migration_import_runs")
    .select([
      "id",
      "request_hash",
      "manifest_hash",
      "cutover_observed_at",
      "cutover_business_date",
      "state",
      "input_summary",
      "reconciliation_summary"
    ])
    .where("property_id", "=", context.propertyId)
    .where("source_system", "=", APPROVAL_SOURCE_SYSTEM)
    .where("idempotency_key", "=", nonceHash)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.request_hash !== approvalHash) {
    fail("approval nonce is already bound to a different approval hash");
  }
  const input = record(existing.input_summary);
  const reconciliation = record(existing.reconciliation_summary);
  const cutoverAt = existing.cutover_observed_at instanceof Date
    ? existing.cutover_observed_at
    : new Date(existing.cutover_observed_at);
  if (existing.manifest_hash !== context.manifestHash
    || existing.state !== "APPLIED"
    || Number.isNaN(cutoverAt.getTime())
    || cutoverAt.getTime() !== new Date(context.cutoverAt).getTime()
    || existing.cutover_business_date !== context.cutoverAt.slice(0, 10)
    || input?.approvalHash !== approvalHash
    || input?.keyId !== credential.keyId
    || input?.approvedBy !== credential.payload.approvedBy
    || input?.targetDatabaseFingerprint !== credential.payload.targetDatabaseFingerprint
    || input?.recoveryAttestationKeyId !== credential.payload.recoveryAttestation.keyId
    || input?.recoveryAttestationHash !== credential.payload.recoveryAttestation.attestationHash
    || input?.sourceSystem !== context.sourceSystem
    || reconciliation?.credentialConsumed !== true
    || reconciliation?.nonceHash !== nonceHash) {
    fail("existing approval consumption conflicts with the requested import");
  }
  return freeze({
    approvalRunId: existing.id,
    approvalHash,
    nonceHash,
    keyId: credential.keyId,
    approvedBy: credential.payload.approvedBy
  });
}

export async function historicalImportDatabaseFingerprint(db: ApprovalExecutor): Promise<string> {
  let result;
  try {
    result = await sql<{
      database_name: string;
      database_oid: string;
      system_identifier: string;
      postmaster_started_epoch: string;
    }>`
      SELECT
        current_database() AS database_name,
        database.oid::text AS database_oid,
        control.system_identifier::text AS system_identifier,
        extract(epoch FROM pg_postmaster_start_time())::numeric::text AS postmaster_started_epoch
      FROM pg_database AS database
      CROSS JOIN pg_control_system() AS control
      WHERE database.datname = current_database()
    `.execute(db);
  } catch {
    fail("target database identity is unavailable");
  }
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) fail("target database identity is unavailable");
  return stableHash({
    fingerprintVersion: 4,
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    systemIdentifier: row.system_identifier,
    postmasterStartedEpoch: row.postmaster_started_epoch
  });
}

export async function authorizeHistoricalImportApply(
  db: Kysely<Database>,
  manifest: HistoricalOrderImportManifest,
  dryRunReport: HistoricalImportDryRunReport,
  credentialValue: HistoricalImportApprovalCredential | unknown,
  publicKey: ApprovalKey,
  recoveryPublicKey: ApprovalKey,
  now = new Date()
): Promise<HistoricalImportApprovalAuthorization> {
  const targetDatabaseFingerprint = await historicalImportDatabaseFingerprint(db);
  const signedCredential = verifyHistoricalImportApprovalSignature(credentialValue, publicKey, recoveryPublicKey);
  assertHistoricalImportApprovalIdentity(signedCredential, {
    manifestHash: manifest.manifestHash,
    propertyId: dryRunReport.propertyId,
    targetDatabaseFingerprint
  });
  const approvalHash = stableHash(signedCredential);
  const nonceHash = stableHash({ purpose: APPROVAL_PURPOSE, nonce: signedCredential.payload.nonce });
  const existing = await existingApprovalConsumption(db, signedCredential, approvalHash, nonceHash, {
    manifestHash: manifest.manifestHash,
    propertyId: dryRunReport.propertyId,
    sourceSystem: manifest.sourceSystem,
    cutoverAt: manifest.cutoverAt
  });
  const credential = existing ? signedCredential : verifyHistoricalImportApproval(signedCredential, publicKey, {
    manifestHash: manifest.manifestHash,
    propertyId: dryRunReport.propertyId,
    targetDatabaseFingerprint,
    dryRunReport,
    now
  }, recoveryPublicKey);
  const authorization = freeze({ approvalHash, credential });
  verifiedAuthorizations.add(authorization);
  return authorization;
}

export async function consumeHistoricalImportApproval(
  trx: Transaction<Database>,
  authorization: HistoricalImportApprovalAuthorization,
  context: ApprovalConsumptionContext
): Promise<HistoricalImportApprovalConsumptionReceipt> {
  if (!trx.isTransaction) fail("approval must be consumed inside the import transaction");
  if (!authorization || typeof authorization !== "object" || !verifiedAuthorizations.has(authorization)) {
    fail("apply requires a verified approval authorization");
  }
  const credential = authorization.credential;
  if (credential.payload.manifestHash !== context.manifestHash || credential.payload.propertyId !== context.propertyId) {
    fail("verified approval does not match the import transaction");
  }
  const currentFingerprint = await historicalImportDatabaseFingerprint(trx);
  if (credential.payload.targetDatabaseFingerprint !== currentFingerprint) {
    fail("target database identity changed after approval verification");
  }
  const nonceHash = stableHash({ purpose: APPROVAL_PURPOSE, nonce: credential.payload.nonce });
  const replay = await existingApprovalConsumption(
    trx,
    credential,
    authorization.approvalHash,
    nonceHash,
    context
  );
  if (replay) return replay;
  const databaseClock = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx);
  const consumedAt = databaseClock.rows[0]?.now;
  if (!(consumedAt instanceof Date)
    || new Date(credential.payload.issuedAt).getTime() > consumedAt.getTime()
    || consumedAt.getTime() >= new Date(credential.payload.expiresAt).getTime()) {
    fail("approval credential expired before transaction consumption");
  }
  if (consumedAt.getTime() - new Date(credential.payload.dryRun.completedAt).getTime() > MAX_DRY_RUN_AGE_MS) {
    fail("approved dry-run report became stale before transaction consumption");
  }
  if (consumedAt.getTime() - new Date(credential.payload.candidateDryRun.completedAt).getTime() > MAX_DRY_RUN_AGE_MS) {
    fail("approved candidate dry-run report became stale before transaction consumption");
  }
  const approvalRunId = `migration_approval_${randomUUID()}`;
  const inserted = await trx.insertInto("migration_import_runs").values({
    id: approvalRunId,
    property_id: context.propertyId,
    source_system: APPROVAL_SOURCE_SYSTEM,
    idempotency_key: nonceHash,
    request_hash: authorization.approvalHash,
    manifest_hash: context.manifestHash,
    correlation_id: `historical-import-approval:${nonceHash.slice(0, 16)}`,
    cutover_observed_at: context.cutoverAt,
    cutover_business_date: context.cutoverAt.slice(0, 10),
    state: "EXECUTING",
    input_summary: {
      approvalHash: authorization.approvalHash,
      keyId: credential.keyId,
      approvedBy: credential.payload.approvedBy,
      targetDatabaseFingerprint: credential.payload.targetDatabaseFingerprint,
      dryRunReportHash: credential.payload.dryRun.reportHash,
      dryRunEvidenceHash: credential.payload.dryRun.evidenceHash,
      candidateDatabaseFingerprint: credential.payload.candidateDryRun.targetDatabaseFingerprint,
      candidateDryRunReportHash: credential.payload.candidateDryRun.reportHash,
      candidateDryRunEvidenceHash: credential.payload.candidateDryRun.evidenceHash,
      backupEvidenceHash: credential.payload.backup.evidenceHash,
      restoreEvidenceHash: credential.payload.restore.evidenceHash,
      recoveryAttestationKeyId: credential.payload.recoveryAttestation.keyId,
      recoveryAttestationHash: credential.payload.recoveryAttestation.attestationHash,
      issuedAt: credential.payload.issuedAt,
      expiresAt: credential.payload.expiresAt,
      sourceSystem: context.sourceSystem
    },
    reconciliation_summary: null,
    completed_at: null
  }).onConflict((conflict) => conflict
    .columns(["property_id", "source_system", "idempotency_key"])
    .doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!inserted) {
    const racedReplay = await existingApprovalConsumption(
      trx,
      credential,
      authorization.approvalHash,
      nonceHash,
      context
    );
    if (racedReplay) return racedReplay;
    fail("approval credential consumption conflicted with another transaction");
  }
  const completed = await trx.updateTable("migration_import_runs").set({
    state: "APPLIED",
    reconciliation_summary: { credentialConsumed: true, nonceHash },
    completed_at: consumedAt
  }).where("id", "=", approvalRunId).where("state", "=", "EXECUTING").executeTakeFirst();
  if (completed.numUpdatedRows !== 1n) fail("approval consumption could not be completed atomically");
  return {
    approvalRunId,
    approvalHash: authorization.approvalHash,
    nonceHash,
    keyId: credential.keyId,
    approvedBy: credential.payload.approvedBy
  };
}
