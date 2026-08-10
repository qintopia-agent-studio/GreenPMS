import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableHash, stableJson } from "@qintopia/domain";
import {
  createHistoricalImportDryRunEvidence,
  hashHistoricalImportBackupArtifact,
  historicalImportApprovalKeyId,
  issueHistoricalImportApproval,
  issueHistoricalImportRecoveryAttestation,
  verifyHistoricalImportRecoveryAttestation,
  verifyHistoricalImportApproval
} from "./historical-import-approval.ts";
import type { HistoricalImportDryRunReport } from "./historical-order-import.ts";
import { parseHistoricalImportCliArgs } from "./import-historical-orders.ts";

const productionFingerprint = "1".repeat(64);
const restoreFingerprint = "2".repeat(64);
const manifestHash = "3".repeat(64);
const backupSha256 = "4".repeat(64);
const issuedAt = "2026-08-10T00:20:00.000Z";
const expiresAt = "2026-08-10T00:40:00.000Z";

function report(): HistoricalImportDryRunReport {
  return {
    mode: "DRY_RUN",
    manifestHash,
    propertyId: "prop_qintopia_xa",
    replayedSources: 0,
    newSources: 535,
    expected: {
      candidateCount: 535,
      historicalAccommodationAmountFen: 22_105_406,
      historicalAccommodationArchives: 490,
      nonAccommodationArchives: 1,
      operationalAccommodationAmountFen: 6_035_032,
      operationalOrders: 44,
      operationalSegmentCount: 50,
      totalAccommodationAmountFen: 28_140_438
    },
    reconciliation: {
      candidateCount: 535,
      historicalAccommodationAmountFen: 22_105_406,
      historicalAccommodationArchives: 490,
      nonAccommodationArchives: 1,
      operationalAccommodationAmountFen: 6_035_032,
      operationalOrders: 44,
      operationalSegmentCount: 50,
      totalAccommodationAmountFen: 28_140_438,
      sourceCount: 535,
      targetCount: 535,
      historicalArchiveTargets: 490,
      nonAccommodationArchiveTargets: 1,
      operationalTargets: 44,
      sourceOperationalSegmentEvidence: 50,
      operationalClaimPoints: 820,
      historicalCollectionFacts: 0,
      activeOverdueHolds: 1,
      legacyMemberContracts: 1,
      entitlementLots: 1,
      entitlementCoveragePoints: 19,
      entitlementHoldFacts: 19,
      entitlementConsumeFacts: 19,
      amountMinor: 28_140_438
    }
  };
}

function evidence() {
  return createHistoricalImportDryRunEvidence({
    report: report(),
    targetDatabaseFingerprint: productionFingerprint,
    completedAt: "2026-08-10T00:10:00.000Z"
  });
}

function candidateEvidence(candidateReport = report(), fingerprint = restoreFingerprint) {
  return createHistoricalImportDryRunEvidence({
    report: candidateReport,
    targetDatabaseFingerprint: fingerprint,
    completedAt: "2026-08-09T23:55:00.000Z"
  });
}

function recoveryEvidence() {
  return {
    backup: {
      evidenceVersion: 1 as const,
      targetDatabaseFingerprint: productionFingerprint,
      artifactId: "production-backup-2026-08-10T0000Z",
      artifactSha256: backupSha256,
      completedAt: "2026-08-09T23:00:00.000Z"
    },
    restore: {
      evidenceVersion: 1 as const,
      verificationId: "restore-drill-2026-08-10T0000Z",
      backupArtifactSha256: backupSha256,
      restoredDatabaseFingerprint: restoreFingerprint,
      completedAt: "2026-08-09T23:30:00.000Z",
      result: "PASSED" as const
    }
  };
}

function keys() {
  return generateKeyPairSync("ed25519");
}

const recoverySigner = keys();

function signedRecoveryAttestation(
  recovery = recoveryEvidence(),
  signer = recoverySigner
) {
  return issueHistoricalImportRecoveryAttestation({
    backupEvidence: recovery.backup,
    restoreEvidence: recovery.restore
  }, signer.privateKey);
}

describe("historical import production approval", () => {
  it("parses the signed recovery-attestation and approval CLI boundaries", () => {
    expect(parseHistoricalImportCliArgs([
      "--attest-recovery",
      "--backup-artifact", "/secure/backup.dump",
      "--artifact-id", "backup-2026-08-10",
      "--verification-id", "restore-2026-08-10",
      "--output", "/secure/recovery-attestation.json"
    ])).toMatchObject({
      mode: "ATTEST_RECOVERY",
      artifactId: "backup-2026-08-10",
      verificationId: "restore-2026-08-10"
    });
    expect(parseHistoricalImportCliArgs([
      "--manifest", "/secure/manifest.json",
      "--approve",
      "--backup-artifact", "/secure/backup.dump",
      "--recovery-attestation", "/secure/recovery-attestation.json",
      "--approved-by", "migration-owner@example.invalid",
      "--expires-at", "2026-08-10T00:30:00Z",
      "--output", "/secure/approval.json"
    ])).toMatchObject({ mode: "APPROVE", recoveryAttestationPath: "/secure/recovery-attestation.json" });
    expect(() => parseHistoricalImportCliArgs([
      "--manifest", "/secure/manifest.json",
      "--approve",
      "--dry-run-evidence", "/tmp/forged.json"
    ])).toThrow(/Usage/i);
  });

  it("rejects timestamps that JavaScript would otherwise normalize", () => {
    for (const completedAt of [
      "2026-08-10T24:00:00+08:00",
      "2026-08-10T23:60:00+08:00",
      "2026-08-10T23:59:60+08:00",
      "2026-02-30T00:00:00+08:00"
    ]) {
      expect(() => createHistoricalImportDryRunEvidence({
        report: report(),
        targetDatabaseFingerprint: productionFingerprint,
        completedAt
      })).toThrow(/ISO timestamp/i);
    }
  });

  it("requires a real public key for verification while deriving the key id during issuance", () => {
    const signer = keys();
    const recovery = recoveryEvidence();
    const credential = issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: signedRecoveryAttestation(recovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, signer.privateKey);
    const context = {
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      dryRunReport: report(),
      now: new Date("2026-08-10T00:25:00.000Z")
    };

    expect(credential.keyId).toBe(historicalImportApprovalKeyId(signer.publicKey));
    expect(() => historicalImportApprovalKeyId(signer.privateKey)).toThrow(/public key.*private/i);
    expect(() => verifyHistoricalImportApproval(
      credential,
      signer.privateKey,
      context,
      recoverySigner.publicKey
    )).toThrow(/public key.*private/i);
    expect(() => verifyHistoricalImportApproval(
      credential,
      signer.privateKey.export({ type: "pkcs8", format: "pem" }),
      context,
      recoverySigner.publicKey
    )).toThrow(/public key.*private/i);
  });

  it("hashes only an owner-private regular backup artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qintopia-historical-approval-"));
    const artifactPath = join(directory, "backup.dump");
    const symlinkPath = join(directory, "backup-link.dump");
    const content = Buffer.from("verified backup artifact\n", "utf8");
    try {
      await writeFile(artifactPath, content, { mode: 0o600 });
      expect(await hashHistoricalImportBackupArtifact(artifactPath)).toBe(
        createHash("sha256").update(content).digest("hex")
      );

      await chmod(artifactPath, 0o644);
      await expect(hashHistoricalImportBackupArtifact(artifactPath)).rejects.toThrow(/owner-private/i);
      await chmod(artifactPath, 0o600);
      await symlink(artifactPath, symlinkPath);
      await expect(hashHistoricalImportBackupArtifact(symlinkPath)).rejects.toThrow(/regular file|symbolic link/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("signs and verifies a short-lived approval bound to the manifest, database, dry-run, and recovery evidence", () => {
    const { privateKey, publicKey } = keys();
    const recovery = recoveryEvidence();
    const credential = issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: signedRecoveryAttestation(recovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt,
      nonce: "n".repeat(43)
    }, privateKey);

    expect(credential.keyId).toBe(historicalImportApprovalKeyId(publicKey));
    expect(credential.payload).toMatchObject({
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      candidateDryRun: {
        targetDatabaseFingerprint: restoreFingerprint,
        reportHash: evidence().reportHash,
        evidenceHash: candidateEvidence().evidenceHash
      },
      approvedBy: "migration-owner@example.invalid",
      nonce: "n".repeat(43)
    });
    expect(verifyHistoricalImportApproval(credential, publicKey, {
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      dryRunReport: report(),
      now: new Date("2026-08-10T00:25:00.000Z")
    }, recoverySigner.publicKey).payload).toEqual(credential.payload);
  });

  it("rejects payload tampering, a different signing key, and a different target database", () => {
    const signer = keys();
    const other = keys();
    const recovery = recoveryEvidence();
    const credential = issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: signedRecoveryAttestation(recovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, signer.privateKey);
    const context = {
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      dryRunReport: report(),
      now: new Date("2026-08-10T00:25:00.000Z")
    };

    const tampered = structuredClone(credential);
    tampered.payload.manifestHash = "5".repeat(64);
    expect(() => verifyHistoricalImportApproval(tampered, signer.publicKey, context, recoverySigner.publicKey)).toThrow(/signature/i);
    expect(() => verifyHistoricalImportApproval(credential, other.publicKey, context, recoverySigner.publicKey)).toThrow(/key/i);
    expect(() => verifyHistoricalImportApproval(credential, signer.publicKey, {
      ...context,
      targetDatabaseFingerprint: "6".repeat(64)
    }, recoverySigner.publicKey)).toThrow(/target database/i);
  });

  it("rejects an expired credential and a dry-run report that no longer matches the signed report hash", () => {
    const signer = keys();
    const recovery = recoveryEvidence();
    const credential = issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: signedRecoveryAttestation(recovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, signer.privateKey);
    const context = {
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      dryRunReport: report(),
      now: new Date("2026-08-10T00:25:00.000Z")
    };

    expect(() => verifyHistoricalImportApproval(credential, signer.publicKey, {
      ...context,
      now: new Date(expiresAt)
    }, recoverySigner.publicKey)).toThrow(/expired/i);
    const changedReport = report();
    changedReport.reconciliation.operationalClaimPoints += 1;
    expect(() => verifyHistoricalImportApproval(credential, signer.publicKey, {
      ...context,
      dryRunReport: changedReport
    }, recoverySigner.publicKey)).toThrow(/dry-run report/i);

    const staleCredential = issueHistoricalImportApproval({
      dryRunEvidence: createHistoricalImportDryRunEvidence({
        report: report(),
        targetDatabaseFingerprint: productionFingerprint,
        completedAt: "2026-08-09T23:51:00.000Z"
      }),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: signedRecoveryAttestation(recovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, signer.privateKey);
    expect(() => verifyHistoricalImportApproval(staleCredential, signer.publicKey, {
      ...context,
      now: new Date("2026-08-10T00:22:00.000Z")
    }, recoverySigner.publicKey)).toThrow(/no longer recent/i);
  });

  it("refuses stale or internally inconsistent backup and restore attestations before signing", () => {
    const signer = keys();
    const recovery = recoveryEvidence();
    expect(() => issueHistoricalImportRecoveryAttestation({
      backupEvidence: recovery.backup,
      restoreEvidence: { ...recovery.restore, backupArtifactSha256: "7".repeat(64) }
    }, recoverySigner.privateKey)).toThrow(/backup artifact/i);

    expect(() => issueHistoricalImportRecoveryAttestation({
      backupEvidence: recovery.backup,
      restoreEvidence: { ...recovery.restore, restoredDatabaseFingerprint: productionFingerprint }
    }, recoverySigner.privateKey)).toThrow(/separate database/i);

    const staleRecovery = {
      backup: { ...recovery.backup, completedAt: "2026-08-08T00:00:00.000Z" },
      restore: recovery.restore
    };
    expect(() => issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: signedRecoveryAttestation(staleRecovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, signer.privateKey)).toThrow(/recovery evidence/i);
  });

  it("requires an independently signed recovery attestation", () => {
    const approvalSigner = keys();
    const attestation = signedRecoveryAttestation();
    expect(verifyHistoricalImportRecoveryAttestation(attestation, recoverySigner.publicKey)).toEqual(attestation);

    const forged = structuredClone(attestation);
    forged.payload.backup.artifactId = "forged-backup";
    expect(() => verifyHistoricalImportRecoveryAttestation(forged, recoverySigner.publicKey)).toThrow(/signature/i);
    expect(() => verifyHistoricalImportRecoveryAttestation(attestation, keys().publicKey)).toThrow(/key id/i);

    expect(() => issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: attestation,
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, recoverySigner.privateKey)).toThrow(/independent keys/i);

    const credential = issueHistoricalImportApproval({
      dryRunEvidence: evidence(),
      candidateDryRunEvidence: candidateEvidence(),
      recoveryAttestation: attestation,
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    }, approvalSigner.privateKey);
    expect(credential.payload.recoveryAttestation).toMatchObject({
      keyId: attestation.keyId,
      attestationHash: stableHash(attestation)
    });

    const forgedCredential = structuredClone(credential);
    forgedCredential.payload.backup.artifactId = "forged-backup";
    const { evidenceHash: _evidenceHash, ...forgedBackup } = forgedCredential.payload.backup;
    forgedCredential.payload.backup.evidenceHash = stableHash(forgedBackup);
    const forgedAttestation = structuredClone(attestation);
    forgedAttestation.payload.backup.artifactId = "forged-backup";
    forgedCredential.payload.recoveryAttestation.attestationHash = stableHash(forgedAttestation);
    forgedCredential.signature = sign(
      null,
      Buffer.from(stableJson(forgedCredential.payload), "utf8"),
      approvalSigner.privateKey
    ).toString("base64url");
    expect(() => verifyHistoricalImportApproval(forgedCredential, approvalSigner.publicKey, {
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      dryRunReport: report(),
      now: new Date("2026-08-10T00:25:00.000Z")
    }, recoverySigner.publicKey)).toThrow(/recovery attestation signature/i);
  });

  it("requires a matching dry-run from the restored candidate database before signing", () => {
    const signer = keys();
    const recovery = recoveryEvidence();
    const base = {
      dryRunEvidence: evidence(),
      recoveryAttestation: signedRecoveryAttestation(recovery),
      recoveryPublicKey: recoverySigner.publicKey,
      approvedBy: "migration-owner@example.invalid",
      issuedAt,
      expiresAt
    };

    expect(() => issueHistoricalImportApproval(base as never, signer.privateKey)).toThrow(/candidate dry-run/i);
    expect(() => issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: candidateEvidence(report(), "7".repeat(64))
    }, signer.privateKey)).toThrow(/restored database/i);

    const wrongManifestReport = report();
    wrongManifestReport.manifestHash = "7".repeat(64);
    expect(() => issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: candidateEvidence(wrongManifestReport)
    }, signer.privateKey)).toThrow(/manifest/i);

    const wrongResultReport = report();
    wrongResultReport.reconciliation.operationalClaimPoints += 1;
    expect(() => issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: candidateEvidence(wrongResultReport)
    }, signer.privateKey)).toThrow(/report/i);

    const wrongExpectedReport = report();
    wrongExpectedReport.expected.totalAccommodationAmountFen += 1;
    expect(() => issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: candidateEvidence(wrongExpectedReport)
    }, signer.privateKey)).toThrow(/report/i);

    const wrongPropertyReport = report();
    wrongPropertyReport.propertyId = "prop_other";
    expect(() => issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: candidateEvidence(wrongPropertyReport)
    }, signer.privateKey)).toThrow(/property/i);

    const forgedEvidence = structuredClone(candidateEvidence());
    forgedEvidence.evidenceHash = "7".repeat(64);
    expect(() => issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: forgedEvidence
    }, signer.privateKey)).toThrow(/evidence hash/i);

    const validCredential = issueHistoricalImportApproval({
      ...base,
      candidateDryRunEvidence: candidateEvidence()
    }, signer.privateKey);
    const validlySignedForgery = structuredClone(validCredential);
    validlySignedForgery.payload.candidateDryRun.evidenceHash = "7".repeat(64);
    validlySignedForgery.signature = sign(
      null,
      Buffer.from(stableJson(validlySignedForgery.payload), "utf8"),
      signer.privateKey
    ).toString("base64url");
    expect(() => verifyHistoricalImportApproval(validlySignedForgery, signer.publicKey, {
      manifestHash,
      propertyId: "prop_qintopia_xa",
      targetDatabaseFingerprint: productionFingerprint,
      dryRunReport: report(),
      now: new Date("2026-08-10T00:20:00.000Z")
    }, recoverySigner.publicKey)).toThrow(/candidate dry-run evidence hash/i);
  });
});
