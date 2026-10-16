"""A missing production migration must fail before a service switch, not after it."""
import json
import unittest
from unittest.mock import patch

from test_server import DeployerFixture, digest, migration, server
from common import ReleaseError


class DatabasePreflightTests(unittest.TestCase):
    def target(self):
        return {"runtimeImageId": "sha256:" + "a" * 64, "manifest": {
            "imageId": "sha256:" + "b" * 64,
            "requiredMigrations": [migration(), migration("075_room_operating_statistics.sql")]}}

    def response(self, **changes):
        value = {"required": ["001_initial.sql", "075_room_operating_statistics.sql"],
                 "applied": ["001_initial.sql", "075_room_operating_statistics.sql"], "readOnly": True, "ready": True}
        return json.dumps({**value, **changes})

    def probe(self, text):
        with patch("server.command", return_value=text):
            server.Docker({"envFile": "/etc/greenpms/app.env"}).database_preflight(self.target())

    def test_probe_uses_verified_image_runtime_configuration_and_read_only_transaction(self):
        with patch("server.command", return_value=self.response()) as run:
            server.Docker({"envFile": "/etc/greenpms/app.env"}).database_preflight(self.target())
        args = run.call_args.args[0]
        self.assertEqual(args[0:3], ["docker", "run", "--rm"])
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop=ALL", args)
        self.assertEqual(args[args.index("--env-file") + 1], "/etc/greenpms/app.env")
        self.assertEqual(args[args.index("--entrypoint") + 1], "node")
        self.assertIn(self.target()["runtimeImageId"], args)
        self.assertNotIn("migration.env", " ".join(args))
        self.assertIn("SET TRANSACTION READ ONLY", args[-1])
        self.assertIn("await databaseReady(trx)", args[-1])
        self.assertNotIn("error.message", args[-1])

    def test_missing_and_extra_migrations_fail_even_if_ready_claims_success(self):
        cases = [(["001_initial.sql"], ["075_room_operating_statistics.sql"], []),
                 (["001_initial.sql", "075_room_operating_statistics.sql", "076_future.sql"], [], ["076_future.sql"])]
        for applied, missing, unexpected in cases:
            with self.subTest(applied=applied), self.assertRaises(server.DeploymentDiagnosticError) as raised:
                self.probe(self.response(applied=applied))
            self.assertEqual(raised.exception.code, "DATABASE_MIGRATIONS_NOT_READY")
            self.assertEqual(raised.exception.details, {"missingMigrations": missing, "unexpectedMigrations": unexpected})

    def test_target_code_must_agree_with_immutable_manifest(self):
        with self.assertRaises(server.DeploymentDiagnosticError) as raised:
            self.probe(self.response(required=["001_initial.sql"]))
        self.assertEqual(raised.exception.code, "DATABASE_PREFLIGHT_IMAGE_MISMATCH")

    def test_matching_names_do_not_bypass_full_readiness(self):
        with self.assertRaises(server.DeploymentDiagnosticError) as raised:
            self.probe(self.response(ready=False))
        self.assertEqual(raised.exception.code, "DATABASE_PREFLIGHT_NOT_READY")

    def test_unverifiable_output_does_not_leak_or_allow_a_switch(self):
        for text in ("postgres://secret@host/private", self.response(readOnly=False), self.response(ready="true"),
                     self.response(applied=["001_initial.sql", "001_initial.sql"]), self.response(applied=["SECRET\\nvalue"])):
            with self.subTest(text=text), self.assertRaises(server.DeploymentDiagnosticError) as raised:
                self.probe(text)
            self.assertEqual(raised.exception.code, "DATABASE_PREFLIGHT_INVALID_RESPONSE")
            self.assertNotIn("secret", str(raised.exception))
            self.assertNotIn("SECRET", str(raised.exception))

    def test_connection_or_process_failure_is_redacted_and_closed(self):
        with patch("server.command", side_effect=ReleaseError("postgres://secret@host")):
            with self.assertRaises(server.DeploymentDiagnosticError) as raised:
                server.Docker({"envFile": "/etc/greenpms/app.env"}).database_preflight(self.target())
        self.assertEqual(raised.exception.code, "DATABASE_PREFLIGHT_UNAVAILABLE")
        self.assertNotIn("secret", str(raised.exception))

    def test_preflight_failure_leaves_old_service_state_and_journal_untouched(self):
        for code in ("DATABASE_MIGRATIONS_NOT_READY", "DATABASE_PREFLIGHT_UNAVAILABLE", "DATABASE_PREFLIGHT_NOT_READY"):
            with self.subTest(code=code), DeployerFixture() as fixture:
                _, key = fixture.add_new_release()
                before = fixture.deployer.state_file.read_bytes()
                fixture.docker.preflight_error = server.DeploymentDiagnosticError(code, "preflight refused")
                with self.assertRaisesRegex(ReleaseError, "preflight refused"):
                    fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key,
                                            digest(fixture.store.objects[key + "manifest.json"]))
                self.assertEqual(fixture.docker.switches, [])
                self.assertEqual(fixture.docker.current_image_id, fixture.old_image_id)
                self.assertEqual(fixture.deployer.state_file.read_bytes(), before)
                self.assertFalse(fixture.deployer.journal.exists())
                self.assertEqual(fixture.store.markers, {})
                audit = [json.loads(line) for line in (fixture.state_dir / "audit.jsonl").read_text().splitlines()]
                self.assertEqual(audit[-1]["event"], "preflight-blocked")
                self.assertEqual(audit[-1]["diagnosticCode"], code)

    def test_ready_database_allows_existing_verified_promotion(self):
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release()
            fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key,
                                    digest(fixture.store.objects[key + "manifest.json"]))
            self.assertEqual(len(fixture.docker.preflight_calls), 1)
            self.assertEqual(fixture.docker.switches, [fixture.new_image_id])
            self.assertFalse(fixture.deployer.journal.exists())
