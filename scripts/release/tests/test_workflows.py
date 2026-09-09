from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class ReleaseCheckTests(unittest.TestCase):
    def run_check(self, *arguments: str, **environment: str) -> subprocess.CompletedProcess[str]:
        child_environment = os.environ.copy()
        child_environment.pop("GITHUB_REF", None)
        child_environment.update(environment)
        return subprocess.run(
            ["node", str(ROOT / "scripts/check-release.mjs"), *arguments],
            cwd=ROOT,
            env=child_environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_current_release_accepts_matching_explicit_tag(self) -> None:
        result = self.run_check("--tag", "v1.2.3")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Release v1.2.3", result.stdout)

    def test_tag_event_is_checked_and_mismatch_fails(self) -> None:
        matching = self.run_check(GITHUB_REF="refs/tags/v1.2.3")
        self.assertEqual(matching.returncode, 0, matching.stderr)

        mismatch = self.run_check("--tag", "v1.2.4")
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("must match package.json version", mismatch.stderr)

        conflicting_ref = self.run_check("--tag", "v1.2.3", GITHUB_REF="refs/tags/v1.2.4")
        self.assertNotEqual(conflicting_ref.returncode, 0)
        self.assertIn("does not match GITHUB_REF", conflicting_ref.stderr)

    def test_tag_format_is_strict(self) -> None:
        for tag in ("1.2.3", "v1.2", "v1.2.3-rc.1", "v01.2.3"):
            result = self.run_check("--tag", tag)
            self.assertNotEqual(result.returncode, 0, tag)
            self.assertIn("vX.Y.Z", result.stderr)


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ci = read(".github/workflows/ci.yml")
        cls.release = read(".github/workflows/release.yml")
        cls.retention = read(".github/workflows/retention.yml")
        cls.workflows = cls.ci + cls.release + cls.retention

    def test_ci_runs_required_checks_without_production_inputs(self) -> None:
        for fragment in (
            "pull_request:",
            "branches:\n      - main",
            "node-version: 22.x",
            "run: npm ci",
            "run: npm run release:check",
            "run: npm run typecheck",
            "run: npm run test",
            "run: npm run build",
            "python3 -m unittest discover -s scripts/release/tests -v",
        ):
            self.assertIn(fragment, self.ci)
        self.assertNotIn("environment: production", self.ci)
        self.assertNotIn("COS_", self.ci)
        self.assertNotIn("DEPLOY_", self.ci)

    def test_release_is_tagged_immutable_and_main_reachable(self) -> None:
        for fragment in (
            "tags:\n      - 'v*.*.*'",
            "greenpms-production",
            "cancel-in-progress: false",
            "git merge-base --is-ancestor \"$RELEASE_SHA\" origin/main",
            "node scripts/check-release.mjs --tag \"$GITHUB_REF_NAME\"",
            "DOCKER_DEFAULT_PLATFORM: linux/amd64",
            "python3 scripts/release/package.py",
            "python3 scripts/release/cos.py upload",
            "greenpms/releases/",
            "UPLOAD_COS_SECRET_KEY",
            "environment: production",
            "persist-credentials: false",
            "DEPLOY_SSH_KEY_FILE",
            "DEPLOY_KNOWN_HOSTS_FILE",
            "python3 scripts/release/orchestrate.py deploy",
            "--manifest-sha",
        ):
            self.assertIn(fragment, self.release)
        self.assertGreaterEqual(self.release.count("environment: production"), 2)
        self.assertIn("if: always()", self.release)
        self.assertNotIn("steps.metadata", self.release)
        self.assertNotIn("python3 scripts/release/orchestrate.py maintenance", self.release)

    def test_release_keeps_v_in_package_identity_and_cos_key(self) -> None:
        self.assertIn('version="$RELEASE_VERSION"', self.release)
        self.assertNotIn('version="${RELEASE_VERSION#v}"', self.release)

        with tempfile.TemporaryDirectory() as temporary:
            environment = os.environ.copy()
            environment.update({"RELEASE_VERSION": "v1.2.3", "RELEASE_REVISION": "a" * 40})
            result = subprocess.run(
                [
                    "bash",
                    "-eu",
                    "-c",
                    'version="$RELEASE_VERSION"; key="greenpms/releases/${version}/${RELEASE_REVISION}/"; test "$version" = v1.2.3; test "$key" = greenpms/releases/v1.2.3/'
                    + "a" * 40
                    + "/",
                ],
                cwd=temporary,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_ancestry_command_accepts_tag_before_later_main_commit(self) -> None:
        command = 'git merge-base --is-ancestor "$RELEASE_SHA" origin/main'
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Workflow Test"], cwd=repository, check=True)
            (repository / "release.txt").write_text("release\n", encoding="utf-8")
            subprocess.run(["git", "add", "release.txt"], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "release"], cwd=repository, check=True)
            release_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
            (repository / "docs.txt").write_text("post-release docs\n", encoding="utf-8")
            subprocess.run(["git", "add", "docs.txt"], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "docs"], cwd=repository, check=True)
            main_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
            subprocess.run(["git", "update-ref", "refs/remotes/origin/main", main_sha], cwd=repository, check=True)

            environment = os.environ.copy()
            environment["RELEASE_SHA"] = release_sha
            result = subprocess.run(
                ["bash", "-eu", "-c", command],
                cwd=repository,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_retention_shares_lock_and_has_dry_run(self) -> None:
        for fragment in (
            "schedule:",
            "workflow_dispatch:",
            "dry_run:",
            "greenpms-production",
            "RETENTION_COS_SECRET_ID",
            "RETENTION_COS_SECRET_KEY",
            "python3 scripts/release/orchestrate.py maintenance --dry-run",
            "python3 scripts/release/orchestrate.py maintenance",
            "if: always()",
        ):
            self.assertIn(fragment, self.retention)

    def test_workflows_do_not_publish_github_or_registry_binaries(self) -> None:
        forbidden = (
            "actions/upload-artifact",
            "docker/build-push-action",
            "docker push",
            "gh release upload",
            "softprops/action-gh-release",
        )
        for fragment in forbidden:
            self.assertNotIn(fragment, self.workflows)
        self.assertNotIn("set -x", self.workflows)


if __name__ == "__main__":
    unittest.main()
