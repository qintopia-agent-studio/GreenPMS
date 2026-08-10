import { constants as fsConstants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stableHash } from "@qintopia/domain";
import { createDatabase } from "./database.ts";
import {
  authorizeHistoricalImportApply,
  createHistoricalImportDryRunEvidence,
  hashHistoricalImportBackupArtifact,
  historicalImportApprovalKeyId,
  historicalImportDatabaseFingerprint,
  inspectHistoricalImportBackupArtifact,
  issueHistoricalImportApproval,
  issueHistoricalImportRecoveryAttestation,
  parseHistoricalImportApprovalCredential,
  verifyHistoricalImportRecoveryAttestation
} from "./historical-import-approval.ts";
import {
  applyHistoricalOrderImport,
  dryRunHistoricalOrderImport,
  loadHistoricalOrderImportManifest
} from "./historical-order-import.ts";

export type HistoricalImportCliOptions =
  | { mode: "DRY_RUN"; manifestPath: string }
  | { mode: "APPLY"; manifestPath: string; approvalPath: string }
  | {
    mode: "APPROVE";
    manifestPath: string;
    backupArtifactPath: string;
    recoveryAttestationPath: string;
    approvedBy: string;
    expiresAt: string;
    outputPath: string;
  }
  | {
    mode: "ATTEST_RECOVERY";
    backupArtifactPath: string;
    artifactId: string;
    verificationId: string;
    outputPath: string;
  };

function usage(): never {
  throw new Error([
    "Usage:",
    "  import-historical-orders --attest-recovery --backup-artifact <owner-private-path> --artifact-id <id> --verification-id <id> --output <path>",
    "    Requires DATABASE_URL, QINTOPIA_HISTORICAL_IMPORT_RESTORED_DATABASE_URL, and QINTOPIA_HISTORICAL_IMPORT_RECOVERY_PRIVATE_KEY_FILE.",
    "  import-historical-orders --manifest <path> --dry-run",
    "  import-historical-orders --manifest <path> --approve --backup-artifact <owner-private-path> --recovery-attestation <owner-private-path> --approved-by <identity> --expires-at <ISO timestamp> --output <path>",
    "    Requires both database URLs, the approval private key, and a pinned recovery public key.",
    "  import-historical-orders --manifest <path> --apply --approval <path>"
  ].join("\n"));
}

export function parseHistoricalImportCliArgs(args: readonly string[]): HistoricalImportCliOptions {
  let manifestPath: string | null = null;
  let mode: "DRY_RUN" | "APPROVE" | "APPLY" | "ATTEST_RECOVERY" | null = null;
  const values = new Map<string, string>();
  const valueArguments = new Set([
    "--manifest", "--approval", "--backup-artifact", "--recovery-attestation",
    "--artifact-id", "--verification-id",
    "--approved-by", "--expires-at", "--output"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run" || arg === "--approve" || arg === "--apply" || arg === "--attest-recovery") {
      if (mode) usage();
      mode = arg === "--dry-run" ? "DRY_RUN"
        : arg === "--approve" ? "APPROVE"
          : arg === "--apply" ? "APPLY"
            : "ATTEST_RECOVERY";
      continue;
    }
    if (!valueArguments.has(arg) || values.has(arg)) usage();
    const value = args[++index];
    if (!value) usage();
    values.set(arg, value);
  }
  manifestPath = values.get("--manifest") ?? null;
  if (!mode) usage();
  if (mode === "ATTEST_RECOVERY") {
    const backupArtifactPath = values.get("--backup-artifact");
    const artifactId = values.get("--artifact-id");
    const verificationId = values.get("--verification-id");
    const outputPath = values.get("--output");
    if (!backupArtifactPath || !artifactId || !verificationId || !outputPath || values.size !== 4) usage();
    return {
      mode,
      backupArtifactPath,
      artifactId,
      verificationId,
      outputPath
    };
  }
  if (!manifestPath) usage();
  if (mode === "DRY_RUN") {
    if (values.size !== 1) usage();
    return { mode, manifestPath };
  }
  if (mode === "APPLY") {
    const approvalPath = values.get("--approval");
    if (!approvalPath || values.size !== 2) usage();
    return { mode, manifestPath, approvalPath };
  }
  const backupArtifactPath = values.get("--backup-artifact");
  const recoveryAttestationPath = values.get("--recovery-attestation");
  const approvedBy = values.get("--approved-by");
  const expiresAt = values.get("--expires-at");
  const outputPath = values.get("--output");
  if (!backupArtifactPath || !recoveryAttestationPath
    || !approvedBy || !expiresAt || !outputPath || values.size !== 6) usage();
  return {
    mode,
    manifestPath,
    backupArtifactPath,
    recoveryAttestationPath,
    approvedBy,
    expiresAt,
    outputPath
  };
}

async function readRegularFile(
  path: string,
  label: string,
  options: { maxBytes: number; ownerPrivate: boolean }
): Promise<Buffer> {
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    if (metadata.size > options.maxBytes) throw new Error("file is too large");
    if (options.ownerPrivate && (metadata.mode & 0o077) !== 0) throw new Error("permissions are broader than 0600");
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (options.ownerPrivate && currentUid !== null && metadata.uid !== currentUid) {
      throw new Error("file is owned by another user");
    }
    return await file.readFile();
  } catch {
    throw new Error(`${label} must be a readable regular file${options.ownerPrivate ? " accessible only by its owner" : ""}.`);
  } finally {
    await file?.close();
  }
}

async function readJson(path: string, label: string, privateFile = false): Promise<unknown> {
  try {
    return JSON.parse((await readRegularFile(path, label, {
      maxBytes: 1024 * 1024,
      ownerPrivate: privateFile
    })).toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} must contain valid JSON.`);
    }
    throw error;
  }
}

async function readKeyFile(path: string, secret: boolean): Promise<Buffer> {
  return readRegularFile(path, secret ? "Historical import private key" : "Historical import public key", {
    maxBytes: 64 * 1024,
    ownerPrivate: secret
  });
}

async function attestRecovery(
  options: Extract<HistoricalImportCliOptions, { mode: "ATTEST_RECOVERY" }>
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("Recovery attestation requires an explicit production DATABASE_URL.");
  }
  const privateKeyPath = process.env.QINTOPIA_HISTORICAL_IMPORT_RECOVERY_PRIVATE_KEY_FILE;
  if (!privateKeyPath) {
    throw new Error("Recovery attestation requires QINTOPIA_HISTORICAL_IMPORT_RECOVERY_PRIVATE_KEY_FILE.");
  }
  const restoredCandidateDatabaseUrl = process.env.QINTOPIA_HISTORICAL_IMPORT_RESTORED_DATABASE_URL;
  if (!restoredCandidateDatabaseUrl) {
    throw new Error("Recovery attestation requires QINTOPIA_HISTORICAL_IMPORT_RESTORED_DATABASE_URL.");
  }
  const backupArtifact = await inspectHistoricalImportBackupArtifact(options.backupArtifactPath);
  const productionDb = createDatabase();
  const restoredCandidateDb = createDatabase(restoredCandidateDatabaseUrl);
  try {
    const [productionFingerprint, restoredDatabaseFingerprint] = await Promise.all([
      historicalImportDatabaseFingerprint(productionDb),
      historicalImportDatabaseFingerprint(restoredCandidateDb)
    ]);
    if (productionFingerprint === restoredDatabaseFingerprint) {
      throw new Error("The restored candidate must be a database independent from production.");
    }
    const attestation = issueHistoricalImportRecoveryAttestation({
      backupEvidence: {
        evidenceVersion: 1,
        targetDatabaseFingerprint: productionFingerprint,
        artifactId: options.artifactId,
        artifactSha256: backupArtifact.sha256,
        completedAt: backupArtifact.completedAt
      },
      restoreEvidence: {
        evidenceVersion: 1,
        verificationId: options.verificationId,
        backupArtifactSha256: backupArtifact.sha256,
        restoredDatabaseFingerprint,
        completedAt: new Date().toISOString(),
        result: "PASSED"
      }
    }, await readKeyFile(privateKeyPath, true));
    await writeFile(options.outputPath, `${JSON.stringify(attestation, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      mode: "RECOVERY_ATTESTED",
      outputPath: options.outputPath,
      attestationHash: stableHash(attestation),
      keyId: attestation.keyId,
      backupArtifactSha256: backupArtifact.sha256,
      productionFingerprint,
      restoredDatabaseFingerprint
    })}\n`);
  } finally {
    await Promise.all([productionDb.destroy(), restoredCandidateDb.destroy()]);
  }
}

async function approve(options: Extract<HistoricalImportCliOptions, { mode: "APPROVE" }>): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("Approval issuance requires an explicit production DATABASE_URL.");
  }
  const privateKeyPath = process.env.QINTOPIA_HISTORICAL_IMPORT_APPROVAL_PRIVATE_KEY_FILE;
  if (!privateKeyPath) {
    throw new Error("Approval issuance requires QINTOPIA_HISTORICAL_IMPORT_APPROVAL_PRIVATE_KEY_FILE.");
  }
  const recoveryPublicKeyPath = process.env.QINTOPIA_HISTORICAL_IMPORT_RECOVERY_PUBLIC_KEY_FILE;
  const recoveryKeyId = process.env.QINTOPIA_HISTORICAL_IMPORT_RECOVERY_KEY_ID;
  if (!recoveryPublicKeyPath || !recoveryKeyId || !/^[0-9a-f]{64}$/.test(recoveryKeyId)) {
    throw new Error("Approval issuance requires a recovery public key file and its pinned QINTOPIA_HISTORICAL_IMPORT_RECOVERY_KEY_ID.");
  }
  const restoredCandidateDatabaseUrl = process.env.QINTOPIA_HISTORICAL_IMPORT_RESTORED_DATABASE_URL;
  if (!restoredCandidateDatabaseUrl) {
    throw new Error("Approval issuance requires QINTOPIA_HISTORICAL_IMPORT_RESTORED_DATABASE_URL.");
  }
  const manifest = await loadHistoricalOrderImportManifest(options.manifestPath);
  const recoveryPublicKey = await readKeyFile(recoveryPublicKeyPath, false);
  if (historicalImportApprovalKeyId(recoveryPublicKey) !== recoveryKeyId) {
    throw new Error("Historical import recovery public key does not match the pinned key id.");
  }
  const recoveryAttestation = verifyHistoricalImportRecoveryAttestation(
    await readJson(options.recoveryAttestationPath, "Recovery attestation", true),
    recoveryPublicKey
  );
  const { backup: backupEvidence, restore: restoreEvidence } = recoveryAttestation.payload;
  const backupArtifactSha256 = await hashHistoricalImportBackupArtifact(options.backupArtifactPath);
  if (backupArtifactSha256 !== backupEvidence.artifactSha256
    || backupArtifactSha256 !== restoreEvidence.backupArtifactSha256) {
    throw new Error("The active backup artifact SHA-256 does not match backup and restore evidence.");
  }
  const productionDb = createDatabase();
  const restoredCandidateDb = createDatabase(restoredCandidateDatabaseUrl);
  try {
    const [productionFingerprint, candidateFingerprint] = await Promise.all([
      historicalImportDatabaseFingerprint(productionDb),
      historicalImportDatabaseFingerprint(restoredCandidateDb)
    ]);
    if (productionFingerprint !== backupEvidence.targetDatabaseFingerprint) {
      throw new Error("Backup evidence is for a different production database.");
    }
    if (candidateFingerprint !== restoreEvidence.restoredDatabaseFingerprint) {
      throw new Error("Restore evidence is for a different restored candidate database.");
    }
    if (candidateFingerprint === productionFingerprint) {
      throw new Error("The restored candidate must be a database independent from production.");
    }
    const [productionReport, candidateReport] = await Promise.all([
      dryRunHistoricalOrderImport(productionDb, manifest),
      dryRunHistoricalOrderImport(restoredCandidateDb, manifest)
    ]);
    const completedAt = new Date();
    const credential = issueHistoricalImportApproval({
      dryRunEvidence: createHistoricalImportDryRunEvidence({
        report: productionReport,
        targetDatabaseFingerprint: productionFingerprint,
        completedAt
      }),
      candidateDryRunEvidence: createHistoricalImportDryRunEvidence({
        report: candidateReport,
        targetDatabaseFingerprint: candidateFingerprint,
        completedAt
      }),
      recoveryAttestation,
      recoveryPublicKey,
      approvedBy: options.approvedBy,
      expiresAt: options.expiresAt
    }, await readKeyFile(privateKeyPath, true));
    await writeFile(options.outputPath, `${JSON.stringify(credential, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      mode: "APPROVED",
      outputPath: options.outputPath,
      approvalHash: stableHash(credential),
      keyId: credential.keyId,
      manifestHash: credential.payload.manifestHash,
      expiresAt: credential.payload.expiresAt
    })}\n`);
  } finally {
    await Promise.all([productionDb.destroy(), restoredCandidateDb.destroy()]);
  }
}

export async function runHistoricalImportCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseHistoricalImportCliArgs(args);
  if (options.mode === "ATTEST_RECOVERY") {
    await attestRecovery(options);
    return;
  }
  if (options.mode === "APPROVE") {
    await approve(options);
    return;
  }
  const manifest = await loadHistoricalOrderImportManifest(options.manifestPath);
  if (options.mode === "APPLY") {
    if (process.env.QINTOPIA_HISTORICAL_IMPORT_APPLY !== "YES") {
      throw new Error("Historical import apply is disabled. Set QINTOPIA_HISTORICAL_IMPORT_APPLY=YES only for the approved cutover.");
    }
    if (!process.env.DATABASE_URL) {
      throw new Error("Historical import apply requires an explicit production DATABASE_URL.");
    }
  }
  const db = createDatabase();
  try {
    const dryRunReport = await dryRunHistoricalOrderImport(db, manifest);
    if (options.mode === "DRY_RUN") {
      const evidence = createHistoricalImportDryRunEvidence({
        report: dryRunReport,
        targetDatabaseFingerprint: await historicalImportDatabaseFingerprint(db)
      });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } else {
      const publicKeyPath = process.env.QINTOPIA_HISTORICAL_IMPORT_APPROVAL_PUBLIC_KEY_FILE;
      const configuredKeyId = process.env.QINTOPIA_HISTORICAL_IMPORT_APPROVAL_KEY_ID;
      const recoveryPublicKeyPath = process.env.QINTOPIA_HISTORICAL_IMPORT_RECOVERY_PUBLIC_KEY_FILE;
      const configuredRecoveryKeyId = process.env.QINTOPIA_HISTORICAL_IMPORT_RECOVERY_KEY_ID;
      if (!publicKeyPath || !configuredKeyId || !/^[0-9a-f]{64}$/.test(configuredKeyId)
        || !recoveryPublicKeyPath || !configuredRecoveryKeyId || !/^[0-9a-f]{64}$/.test(configuredRecoveryKeyId)) {
        throw new Error("Historical import apply requires pinned approval and recovery public key files.");
      }
      const credential = parseHistoricalImportApprovalCredential(await readJson(options.approvalPath, "Approval credential", true));
      const publicKey = await readKeyFile(publicKeyPath, false);
      const recoveryPublicKey = await readKeyFile(recoveryPublicKeyPath, false);
      if (historicalImportApprovalKeyId(publicKey) !== configuredKeyId) {
        throw new Error("Historical import approval public key does not match the pinned key id.");
      }
      if (historicalImportApprovalKeyId(recoveryPublicKey) !== configuredRecoveryKeyId) {
        throw new Error("Historical import recovery public key does not match the pinned key id.");
      }
      const authorization = await authorizeHistoricalImportApply(
        db,
        manifest,
        dryRunReport,
        credential,
        publicKey,
        recoveryPublicKey
      );
      const report = await applyHistoricalOrderImport(db, manifest, authorization);
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }
  } finally {
    await db.destroy();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await runHistoricalImportCli();
