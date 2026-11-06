"""Offline deployment and recovery tests; no Hermes service or PMS API is called."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
INSTALLER_PATH = ROOT / "scripts/skills/install-hermes-skill.py"
SPEC = importlib.util.spec_from_file_location("install_hermes_skill", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallHermesSkillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="greenpms-installer-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.profile = self.root / "anan"
        self.profile.mkdir()
        self.source = self.root / "source"
        self.release = "a" * 40
        self.live = self.profile / "skills/greenpms-api"
        self.operator = self.profile / "skills/greenpms-operator/SKILL.md"
        self.deployment = self.profile / ".skill-deployments/greenpms-api" / self.release
        self.old_skill = {"SKILL.md": b"previous installed skill\n", "local/rules.md": b"preserve old rules\n"}
        for name, data in self.old_skill.items():
            self.write(self.live / name, data)
        self.local_rules = "\n保留运营提醒、职责任务、退款审批与展示口径。\nTrailing bytes:  \n".encode()
        self.operator_before = (
            b"---\nname: greenpms-operator\ndescription: local operator\n---\n"
            b"Sequentially GET /api/v1/version, /api/v1/openapi.json, /api/v1/me, /api/v1/meta for onboarding.\n"
            b"Use preview's propertyId, commandType, effectHash.\n" + self.local_rules
        )
        self.write(self.operator, self.operator_before)
        self.write(self.profile / ".env", b"UNRELATED_ENVIRONMENT=leave-this-file-alone\n")
        self.source_files = {
            "SKILL.md": b"---\nname: greenpms-api\ndescription: Green PMS API\n---\nUse the executor.\n",
            "scripts/greenpms.py": b"#!/usr/bin/env python3\nprint('fixture executor')\n",
            "references/business.md": b"business rules\n",
            "references/recovery.md": b"recover known confirmation\n",
        }
        for name, data in self.source_files.items():
            self.write(self.source / name, data)
        self.artifact = self.root / "artifact.tar.gz"
        self.make_artifact()

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def make_artifact(self, comment=None, overrides=None, extra=None, omitted=None):
        files = {f"skills/greenpms-api/{name}": data for name, data in self.source_files.items()}
        files[installer.INSTALLER] = INSTALLER_PATH.read_bytes()
        files.update(overrides or {})
        for name in omitted or ():
            files.pop(name)
        with tarfile.open(self.artifact, "w:gz", format=tarfile.PAX_FORMAT,
                          pax_headers={"comment": self.release if comment is None else comment}) as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra is not None:
                archive.addfile(extra)
        self.artifact_sha = installer.digest(self.artifact.read_bytes())

    def install(self, **overrides):
        arguments = dict(profile=self.profile, source=self.source, release=self.release,
                         artifact_sha=self.artifact_sha, artifact=self.artifact,
                         expected_operator_sha=installer.digest(self.operator_before), apply=True)
        arguments.update(overrides)
        return installer.install(**arguments)

    def receipt(self):
        return json.loads((self.deployment / "manifest.json").read_bytes())

    def set_prepared(self):
        receipt = self.receipt()
        receipt["status"] = "PREPARED"
        (self.deployment / "manifest.json").write_text(json.dumps(receipt))

    def snapshot(self):
        return {str(path.relative_to(self.profile)): (path.is_dir(), path.stat().st_mtime_ns,
                path.read_bytes() if path.is_file() else None) for path in self.profile.rglob("*")}

    def assert_old_live(self):
        self.assertEqual(installer.file_hashes(self.live),
                         {name: installer.digest(data) for name, data in self.old_skill.items()})
        self.assertEqual(self.operator.read_bytes(), self.operator_before)

    def test_default_and_explicit_dry_run_write_nothing(self):
        before = self.snapshot()
        self.assertEqual(self.install(apply=False)["status"], "DRY_RUN")
        for flags in ([], ["--dry-run"]):
            result = subprocess.run([sys.executable, str(INSTALLER_PATH), "--profile", str(self.profile),
                "--source", str(self.source), "--artifact", str(self.artifact), "--release", self.release,
                "--artifact-sha256", self.artifact_sha, "--expected-operator-sha256",
                installer.digest(self.operator_before), *flags], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["status"], "DRY_RUN")
        self.assertEqual(before, self.snapshot())

    def test_apply_preserves_business_guidance_and_rollback_restores_exact_bytes(self):
        receipt = self.install()
        self.assertEqual(receipt["status"], "APPLIED")
        self.assertEqual(set(installer.file_hashes(self.live)), set(installer.FILES))
        skill = (self.live / "SKILL.md").read_text()
        self.assertIn("\nrequired_environment_variables:\n", skill)
        for name in installer.ENVIRONMENT:
            self.assertIn(f"  - name: {name}\n", skill)
        routed = self.operator.read_bytes()
        front, _, _ = self.operator_before.partition(b"\n---\n")
        self.assertTrue(routed.startswith(front + b"\n---\n"))
        self.assertTrue(routed.endswith(self.local_rules))
        self.assertIn(b"Use the scoped input propertyId and preview's commandType, effectHash.", routed)
        self.assertNotIn(b"Sequentially GET", routed)
        self.assertEqual(routed.decode().count(installer.MARKER), 1)
        self.assertFalse(receipt["serviceRestarted"])
        self.assertFalse(receipt["credentialChanges"])
        self.assertEqual((self.profile / ".env").read_bytes(), b"UNRELATED_ENVIRONMENT=leave-this-file-alone\n")
        before = self.snapshot()
        self.assertEqual(self.install()["status"], "ALREADY_APPLIED")
        self.assertEqual(before, self.snapshot())
        self.assertEqual(installer.rollback(self.profile, self.release)["status"], "ROLLED_BACK")
        self.assert_old_live()
        self.assertEqual(installer.rollback(self.profile, self.release)["status"], "ALREADY_ROLLED_BACK")

    def test_new_install_without_operator_touch_can_be_removed(self):
        shutil.rmtree(self.live)
        before = self.operator.read_bytes()
        self.install(expected_operator_sha=None)
        self.assertEqual(self.operator.read_bytes(), before)
        installer.rollback(self.profile, self.release)
        self.assertFalse(self.live.exists())
        self.assertEqual(self.operator.read_bytes(), before)

    def test_operator_expected_hash_mismatch_refuses_before_writes(self):
        self.operator.write_bytes(self.operator_before + b"new local rule\n")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "changed since inventory"):
            self.install()
        self.assertEqual(before, self.snapshot())

    def test_archive_digest_commit_source_and_installer_are_pinned(self):
        variants = ("digest", "commit", "source", "installer", "missing", "extra", "link")
        for variant in variants:
            with self.subTest(variant=variant):
                self.make_artifact()
                overrides = {}
                if variant == "digest":
                    overrides["artifact_sha"] = "0" * 64
                elif variant == "commit":
                    self.make_artifact(comment="b" * 40)
                elif variant == "source":
                    self.make_artifact(overrides={"skills/greenpms-api/references/business.md": b"wrong source"})
                elif variant == "installer":
                    self.make_artifact(overrides={installer.INSTALLER: b"wrong installer"})
                elif variant == "missing":
                    self.make_artifact(omitted={"skills/greenpms-api/references/business.md"})
                elif variant == "extra":
                    self.make_artifact(overrides={".env": b"must not package credentials"})
                else:
                    member = tarfile.TarInfo("outside-link")
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/outside"
                    self.make_artifact(extra=member)
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    self.install(**overrides)
                self.assertEqual(before, self.snapshot())

    def test_all_profile_parent_paths_refuse_symlinks(self):
        for target in ("skills", ".skill-deployments", "skills/greenpms-operator"):
            with self.subTest(target=target):
                path = self.profile / target
                outside = self.root / (target.replace("/", "-") + "-outside")
                if path.exists():
                    path.rename(outside)
                else:
                    outside.mkdir()
                path.symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(ValueError, "Symlink"):
                    self.install()
                self.assertFalse((outside / "greenpms-api" / self.release).exists())
                path.unlink()
                outside.rename(path)
        alias = self.root / "profile-parent-link"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.install(profile=alias / "anan")
        profile_alias = self.root / "profile-link"
        profile_alias.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            installer.rollback(profile_alias, self.release)

    def test_dangling_live_symlink_and_special_file_are_refused(self):
        shutil.rmtree(self.live)
        self.live.symlink_to(self.root / "does-not-exist", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.install()
        self.live.unlink()
        self.live.mkdir()
        os.mkfifo(self.live / "pipe")
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.install()

    def test_shared_profile_lock_covers_different_releases_and_rollback(self):
        before = self.snapshot()
        with installer.profile_lock(self.profile):
            for operation in (lambda: self.install(), lambda: self.install(release="b" * 40),
                              lambda: installer.rollback(self.profile, self.release)):
                with self.assertRaisesRegex(ValueError, "Another install or rollback"):
                    operation()
        self.assertEqual(before, self.snapshot())

    def test_install_failure_after_switch_restores_previous_files(self):
        original_write = installer.atomic_write
        failed = False

        def fail_applied(path, data):
            nonlocal failed
            if path.name == "manifest.json" and b'"status": "APPLIED"' in data and not failed:
                failed = True
                raise OSError("simulated manifest write failure")
            return original_write(path, data)

        with patch.object(installer, "atomic_write", side_effect=fail_applied):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.install()
        self.assert_old_live()
        self.assertEqual(self.receipt()["status"], "ROLLED_BACK")

    def test_rollback_failure_after_switch_restores_applied_entry_state(self):
        self.install()
        applied_hashes = installer.file_hashes(self.live)
        applied_operator = self.operator.read_bytes()
        manifest_before = (self.deployment / "manifest.json").read_bytes()
        original_write = installer.atomic_write
        failed = False

        def fail_once(path, data):
            nonlocal failed
            if path == self.operator and data == self.operator_before and not failed:
                failed = True
                raise OSError("simulated operator write failure")
            return original_write(path, data)

        with patch.object(installer, "atomic_write", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "simulated"):
                installer.rollback(self.profile, self.release)
        self.assertEqual(installer.file_hashes(self.live), applied_hashes)
        self.assertEqual(self.operator.read_bytes(), applied_operator)
        self.assertEqual((self.deployment / "manifest.json").read_bytes(), manifest_before)
        installer.rollback(self.profile, self.release)
        self.assert_old_live()

    def test_rollback_receipt_failure_restores_entry_even_after_operator_restore(self):
        self.install()
        applied_hashes = installer.file_hashes(self.live)
        applied_operator = self.operator.read_bytes()
        original_write = installer.atomic_write
        failed = False

        def fail_after_write(path, data):
            nonlocal failed
            result = original_write(path, data)
            if path.name == "manifest.json" and b'"status": "ROLLED_BACK"' in data and not failed:
                failed = True
                raise OSError("simulated failure after atomic receipt write")
            return result

        with patch.object(installer, "atomic_write", side_effect=fail_after_write):
            with self.assertRaisesRegex(OSError, "simulated"):
                installer.rollback(self.profile, self.release)
        self.assertEqual(installer.file_hashes(self.live), applied_hashes)
        self.assertEqual(self.operator.read_bytes(), applied_operator)
        self.assertEqual(self.receipt()["status"], "APPLIED")

    def test_corrupt_backups_are_rejected_before_live_moves(self):
        self.install()
        targets = ("backup-skill/SKILL.md", "backup-operator.md", "rendered-operator.md", "package/SKILL.md")
        for relative in targets:
            with self.subTest(backup=relative):
                path = self.deployment / relative
                original = path.read_bytes()
                path.write_bytes(b"corrupt backup")
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, "corrupt"):
                    installer.rollback(self.profile, self.release)
                self.assertEqual(before, self.snapshot())
                path.write_bytes(original)

    def test_prepared_after_live_switch_can_recover_original_state(self):
        self.install()
        self.set_prepared()
        with self.assertRaisesRegex(ValueError, "--rollback"):
            self.install()
        installer.rollback(self.profile, self.release)
        self.assert_old_live()

    def test_prepared_between_directory_renames_can_recover(self):
        self.install()
        self.set_prepared()
        shutil.rmtree(self.live)
        self.operator.write_bytes(self.operator_before)
        installer.rollback(self.profile, self.release)
        self.assert_old_live()

    def test_prepared_before_live_switch_can_recover_without_changing_existing_rules(self):
        self.install()
        self.set_prepared()
        shutil.rmtree(self.live)
        (self.deployment / "previous-live").rename(self.live)
        self.operator.write_bytes(self.operator_before)
        installer.rollback(self.profile, self.release)
        self.assert_old_live()

    def test_interrupted_rollback_can_resume_before_or_after_previous_stage_is_placed(self):
        self.install()
        self.live.rename(self.deployment / "rollback-held")
        # This is the state after holding the installed tree and before restoring the backup.
        installer.rollback(self.profile, self.release)
        self.assert_old_live()
        receipt = self.receipt()
        receipt["status"] = "APPLIED"
        (self.deployment / "manifest.json").write_text(json.dumps(receipt))
        # The known held tree also permits resuming after old files/operator were restored.
        installer.rollback(self.profile, self.release)
        self.assert_old_live()

    def test_unknown_live_operator_or_recovery_files_are_preserved(self):
        self.install()
        self.set_prepared()
        targets = (self.live / "SKILL.md", self.operator, self.deployment / "previous-live/SKILL.md")
        for target in targets:
            with self.subTest(path=target.name):
                original = target.read_bytes()
                target.write_bytes(original + b"unrelated new work\n")
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    installer.rollback(self.profile, self.release)
                self.assertEqual(before, self.snapshot())
                target.write_bytes(original)

    def test_missing_live_without_rename_evidence_is_not_guessed(self):
        self.install()
        self.set_prepared()
        shutil.rmtree(self.live)
        shutil.rmtree(self.deployment / "previous-live")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "unknown changes"):
            installer.rollback(self.profile, self.release)
        self.assertEqual(before, self.snapshot())

    def test_rollback_rejects_replaced_ancestor_and_release_traversal(self):
        self.install()
        outside = self.root / "deployment-outside"
        self.deployment.parent.rename(outside)
        self.deployment.parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            installer.rollback(self.profile, self.release)
        with self.assertRaisesRegex(ValueError, "exact source Git commit"):
            installer.rollback(self.profile, "../another-profile")


if __name__ == "__main__":
    unittest.main()
