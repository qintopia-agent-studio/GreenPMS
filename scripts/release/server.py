"""Root-owned deployment entry. Docker/HTTP/COS adapters are injectable in tests.

The SSH connection owns flock through marker/retention acknowledgement. A killed
process leaves a small journal, never an ambiguous silent promotion.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from common import (ARCHIVE, FILES, HEX, ReleaseError, image_tag, json_bytes,
                    release_prefix, require, sha256_file, utcnow,
                    validate_bundle, validate_identity, validate_migrations)

# Executed with the verified target image and its existing runtime configuration.
# No migration/owner credentials, application startup, or raw database errors.
DATABASE_PREFLIGHT_SCRIPT = r"""
import { createDatabase, databaseReady, currentMigrationNames } from './packages/db/src/database.js';
import { sql } from 'kysely';
const db = createDatabase(undefined, { max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
try {
  const result = await db.transaction().execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const mode = await sql`SHOW transaction_read_only`.execute(trx);
    const applied = (await trx.selectFrom('schema_migrations').select('name').orderBy('name').execute()).map(row => row.name);
    const expected = [...currentMigrationNames].sort();
    const same = applied.length === expected.length && applied.every((name, index) => name === expected[index]);
    return { required: expected, applied, readOnly: mode.rows[0].transaction_read_only === 'on',
      ready: same && await databaseReady(trx) };
  });
  console.log(JSON.stringify(result));
} catch {
  process.exitCode = 1;
} finally {
  await db.destroy();
}
"""

ROOT_CONFIG = Path("/etc/greenpms/deploy.json")
MANAGED_REPOSITORIES = {"greenpms", "green-pms-app", "qintopia-pms"}


def atomic_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(json_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def deployment_lock(directory):
    directory = Path(directory)
    with (directory / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError("another GreenPMS deployment owns the lock") from None
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


class DeploymentDiagnosticError(ReleaseError):
    def __init__(self, code, message, *, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def command(args, *, env=None, timeout=180, failure_code=None):
    """Never put untrusted command output, database URLs or environment in logs."""
    try:
        result = subprocess.run(args, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        if failure_code:
            raise DeploymentDiagnosticError(failure_code + "_UNAVAILABLE", "external command unavailable or timed out",
                                            details={"timedOut": isinstance(error, subprocess.TimeoutExpired)}) from None
        raise ReleaseError("external command unavailable or timed out") from None
    if result.returncode != 0:
        if failure_code:
            raise DeploymentDiagnosticError(failure_code, "external command failed; consult restricted local diagnostics", details={"exitCode": result.returncode, "timedOut": False})
        raise ReleaseError("external command failed; consult restricted local diagnostics")
    return result.stdout.decode()


class Docker:
    def __init__(self, config):
        self.config = config

    def containers(self):
        ids = command(["docker", "ps", "-aq", "--no-trunc"]).split()
        if not ids:
            return []
        # Do not inspect Env or healthcheck output (either can contain secrets).
        template = '{"id":{{json .Id}},"imageId":{{json .Image}},"name":{{json .Name}},"running":{{json .State.Running}},"health":{{if index .State "Health"}}{{json (index .State "Health").Status}}{{else}}"none"{{end}},"labels":{{json .Config.Labels}}}'
        return [json.loads(line) for line in command(["docker", "inspect", "--format", template, *ids]).splitlines()]

    def service(self, service, container_name):
        items = [c for c in self.containers() if c["name"] == "/" + container_name]
        if len(items) != 1:
            raise DeploymentDiagnosticError("APP_CONTAINER_MISSING" if service == "app" else "WORKER_CONTAINER_MISSING",
                                            "expected production container missing")
        container = items[0]
        labels = container.get("labels") or {}
        if labels.get("com.docker.compose.project") != "green-pms" or labels.get("com.docker.compose.service") != service:
            raise DeploymentDiagnosticError("APP_OWNERSHIP_MISMATCH" if service == "app" else "WORKER_OWNERSHIP_MISMATCH",
                                            "container ownership mismatch")
        return container

    def current(self):
        return self.service("app", "qintopia-pms-app")

    def worker(self):
        return self.service("wecom-worker", "qintopia-pms-wecom-worker")

    def inspect_image(self, identity):
        template = '{"Id":{{json .Id}},"RepoTags":{{json .RepoTags}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Labels":{{if index .Config "Labels"}}{{json (index .Config "Labels")}}{{else}}null{{end}},"RootfsDiffIds":{{json .RootFS.Layers}}}'
        return json.loads(command(["docker", "image", "inspect", "--format", template, identity]))

    def load(self, archive):
        command(["docker", "load", "--input", str(archive)], timeout=600)

    def switch(self, release, *, maintenance=False):
        manifest = release["manifest"]
        # Legacy adoption restores by exact ID; latest is never a recovery input.
        identity = manifest["imageId"] if release.get("legacy") else manifest["imageTag"]
        image = self.inspect_image(identity)
        require(image["Id"] == runtime_image_id(release), "image identity changed before switch")
        if not release.get("legacy"):
            verify_image(image, manifest)
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GREENPMS_IMAGE": identity}
        files = ["--file", self.config["composeFile"]]
        if maintenance:
            override = Path(self.config["stateDir"]) / "maintenance-compose.json"
            atomic_json(override, {"services": {name: {"restart": "no"} for name in ("app", "wecom-worker")}})
            files += ["--file", str(override)]
        command(["docker", "compose", "--project-name", "green-pms", *files,
                 "--env-file", self.config["envFile"], "up", "--detach", "--no-build", "--pull", "never", "--force-recreate",
                 "app", "wecom-worker"],
                env=environment, timeout=180, failure_code="COMPOSE_START_FAILED")

    def restore_restart_policy(self, release):
        identity = release["manifest"]["imageId"] if release.get("legacy") else release["manifest"]["imageTag"]
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GREENPMS_IMAGE": identity}
        # Resolve the approved original Compose declarations without recreating
        # already checked containers or printing its secret-bearing configuration.
        resolved = json.loads(command(["docker", "compose", "--project-name", "green-pms", "--file", self.config["composeFile"],
            "--env-file", self.config["envFile"], "config", "--format", "json"], env=environment))
        for service, lookup in (("app", self.current), ("wecom-worker", self.worker)):
            policy = resolved["services"][service].get("restart", "no")
            require(isinstance(policy, str) and re.fullmatch(r"no|always|unless-stopped|on-failure(?::[1-9][0-9]*)?", policy),
                    "DATABASE_RESTART_POLICY_INVALID")
            item = lookup()
            require(item["imageId"] == runtime_image_id(release) and item["running"], "DATABASE_RESTART_TARGET_MISMATCH")
            command(["docker", "update", "--restart=" + policy, item["id"]], failure_code="DATABASE_RESTART_RESTORE_FAILED")

    def stop_container(self, identity):
        # Persist maintenance across daemon/host restart. Compose recreates the
        # approved services with their configured restart policy on safe resume.
        try:
            command(["docker", "update", "--restart=no", identity], timeout=30, failure_code="DATABASE_RESTART_FENCE_FAILED")
        finally:
            command(["docker", "stop", "--time", "30", identity], timeout=45, failure_code="DATABASE_STOP_FAILED")

    def database_preflight(self, release):
        try:
            output = command(["docker", "run", "--rm", "--read-only", "--cap-drop=ALL",
                              "--security-opt=no-new-privileges", "--network", "host",
                              "--env-file", self.config["envFile"], "--workdir", "/app",
                              "--entrypoint", "node", runtime_image_id(release),
                              "--input-type=module", "-e", DATABASE_PREFLIGHT_SCRIPT], timeout=90)
        except ReleaseError:
            raise DeploymentDiagnosticError("DATABASE_PREFLIGHT_UNAVAILABLE",
                "database preflight unavailable; existing service was not switched") from None
        try:
            result = json.loads(output)
            require(isinstance(result, dict) and set(result) == {"required", "applied", "readOnly", "ready"}, "invalid result")
            for field in ("required", "applied"):
                names = result[field]
                require(isinstance(names, list) and all(isinstance(name, str) and re.fullmatch(r"[0-9]{3}_[a-z0-9_]+\.sql", name) for name in names)
                        and len(set(names)) == len(names), "invalid migration list")
            require(result["readOnly"] is True and type(result["ready"]) is bool, "invalid read-only result")
        except (ValueError, TypeError, ReleaseError):
            raise DeploymentDiagnosticError("DATABASE_PREFLIGHT_INVALID_RESPONSE",
                "database preflight response could not be verified; existing service was not switched") from None
        expected = sorted(item["name"] for item in release["manifest"]["requiredMigrations"])
        if sorted(result["required"]) != expected:
            raise DeploymentDiagnosticError("DATABASE_PREFLIGHT_IMAGE_MISMATCH",
                "target image and manifest require different migrations; existing service was not switched")
        missing = sorted(set(expected) - set(result["applied"]))
        unexpected = sorted(set(result["applied"]) - set(expected))
        if missing or unexpected:
            raise DeploymentDiagnosticError("DATABASE_MIGRATIONS_NOT_READY",
                "database migrations not ready; missing: " + (", ".join(missing) or "none")
                + "; unexpected: " + (", ".join(unexpected) or "none") + "; existing service was not switched",
                details={"missingMigrations": missing, "unexpectedMigrations": unexpected})
        if not result["ready"]:
            raise DeploymentDiagnosticError("DATABASE_PREFLIGHT_NOT_READY",
                "target database integrity check failed; existing service was not switched")

    def images(self):
        ids = sorted(set(command(["docker", "image", "ls", "-aq", "--no-trunc"]).split()))
        return [self.inspect_image(identity) for identity in ids]

    def remove_tag(self, tag):
        # No force, prune, volume, system or container deletion command exists here.
        command(["docker", "image", "rm", tag])


def verify_image(image, manifest):
    image_id = image.get("Id")
    require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id),
            "invalid local image ID")
    require(image["Os"] == "linux" and image["Architecture"] == "amd64", "loaded platform mismatch")
    require(manifest["imageTag"] in (image.get("RepoTags") or []), "immutable image tag missing")
    labels = image.get("Labels") or {}
    for field, expected in (("version", manifest["version"]), ("revision", manifest["gitRevision"]),
                            ("source", manifest["source"]), ("created", manifest["createdAt"])):
        require(labels.get("org.opencontainers.image." + field) == expected, "loaded OCI labels mismatch")


def verify_loaded_image(image, manifest, archive_details):
    verify_image(image, manifest)
    require(isinstance(archive_details, dict), "Docker archive inspection result is invalid")
    expected_layers = archive_details.get("rootfsDiffIds")
    require(isinstance(expected_layers, list) and expected_layers, "Docker archive rootfs identity is missing")
    require(image.get("RootfsDiffIds") == expected_layers, "loaded image rootfs differs from archive")


def runtime_image_id(release):
    identity = release.get("runtimeImageId", release.get("manifest", {}).get("imageId"))
    require(isinstance(identity, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", identity),
            "invalid runtime image ID")
    return identity


def compatible(source, target, *, rollback):
    a, b = source["manifest"], target["manifest"]
    if rollback:
        require(a["requiredMigrations"] == b["requiredMigrations"],
                "migration baseline changed: direct image switch refused; use an approved forward fix or database recovery plan")
        require(a["rollbackCompatibility"]["mode"] == "same-migrations-only"
                and b["rollbackCompatibility"]["mode"] == "same-migrations-only",
                "forward-only release: direct rollback refused; forward fix or database recovery required")
        return

    source_migrations = a["requiredMigrations"]
    target_migrations = b["requiredMigrations"]
    if source_migrations != target_migrations:
        require(b["rollbackCompatibility"]["mode"] == "forward-only"
                and len(target_migrations) > len(source_migrations)
                and target_migrations[:len(source_migrations)] == source_migrations,
                "migration baseline changed: direct image switch refused; use an approved forward fix or database recovery plan")


def cleanup_images(docker, state, dry_run=False):
    protected = {runtime_image_id(state[k]) for k in ("current", "previous") if state.get(k)}
    decisions = []
    for image in docker.images():
        tags = image.get("RepoTags") or []
        owned = [tag for tag in tags if tag.rsplit(":", 1)[0] in MANAGED_REPOSITORIES]
        if not owned:
            continue
        identity = image["Id"]
        references = {c["imageId"] for c in docker.containers()}
        reason = "current/previous" if identity in protected else "container reference" if identity in references else None
        deletion_reason = "old GreenPMS tags; other repository tags retained" if len(owned) != len(tags) else "old GreenPMS image"
        decisions.append({"imageId": identity, "action": "keep" if reason else "delete", "reason": reason or deletion_reason})
        if reason or dry_run:
            continue
        for tag in owned:
            # Re-read immediately before EACH tag removal, including stopped containers.
            if identity in {c["imageId"] for c in docker.containers()}:
                raise ReleaseError("image became container-referenced during cleanup")
            require(docker.inspect_image(tag)["Id"] == identity, "image tag changed during cleanup")
            docker.remove_tag(tag)
    return decisions


class Health:
    def __init__(self, docker, config):
        self.docker, self.config = docker, config

    def __call__(self, release):
        deadline = time.monotonic() + self.config.get("healthTimeoutSeconds", 150)
        last = {"codes": ["HEALTH_NOT_OBSERVED"]}
        while time.monotonic() < deadline:
            last = self.check_once(release, deadline=deadline)
            if not last["codes"]:
                return
            time.sleep(2)
        raise DeploymentDiagnosticError("HEALTH_GATE_FAILED", "Docker/local/public readiness or version gate failed", details=last)

    def check_once(self, release, *, deadline=None):
        codes, states = [], {}
        identity = runtime_image_id(release)
        for name, lookup in (("app", self.docker.current), ("worker", self.docker.worker)):
            try:
                container = lookup()
                running = container.get("running") is True
                image_matches = container.get("imageId") == identity
                state = {"running": running, "imageMatches": image_matches}
                if name == "app":
                    health = container.get("health")
                    state["health"] = health if health in ("healthy", "unhealthy", "starting", "none") else "unknown"
                states[name] = state
                if not running:
                    codes.append(name.upper() + "_NOT_RUNNING")
                if not image_matches:
                    codes.append(name.upper() + "_IMAGE_MISMATCH")
                if name == "app" and state["health"] != "healthy":
                    codes.append("APP_NOT_HEALTHY")
            except ReleaseError as error:
                codes.append(error.code if isinstance(error, DeploymentDiagnosticError)
                             else name.upper() + "_INSPECT_FAILED")
            except Exception:
                codes.append(name.upper() + "_INSPECT_FAILED")
        if codes:
            return {"codes": sorted(set(codes)), "containers": states}

        version = release["manifest"]["version"].removeprefix("v")
        base = self.config["localBaseUrl"].rstrip("/")
        probes = (("LOCAL_READY", base + "/health/ready", None),
                  ("LOCAL_VERSION", base + "/api/v1/version", version),
                  ("PUBLIC_READY", self.config["publicReadyUrl"], None),
                  ("PUBLIC_VERSION", self.config["publicVersionUrl"], version))
        for name, url, expected_version in probes:
            remaining = deadline - time.monotonic() if deadline is not None else 10
            if remaining <= 0:
                codes.append(name + "_NOT_CHECKED")
                continue
            try:
                with urllib.request.urlopen(url, timeout=min(10, remaining)) as response:
                    if response.status != 200:
                        codes.append(name + "_HTTP_STATUS")
                    elif expected_version:
                        try:
                            actual = json.loads(response.read(65536))
                            codes.append(name + "_MISMATCH" if actual.get("version") != expected_version else "")
                        except (ValueError, AttributeError, TypeError):
                            codes.append(name + "_INVALID_RESPONSE")
            except urllib.error.HTTPError:
                codes.append(name + "_HTTP_STATUS")
            except Exception:
                codes.append(name + "_UNREACHABLE")
        return {"codes": sorted(code for code in codes if code), "containers": states}


class Deployer:
    def __init__(self, config, docker, store, health, scanner=None, decompress=None):
        self.config, self.docker, self.store, self.health = config, docker, store, health
        self.directory = Path(config["stateDir"])
        self.state_file = self.directory / "state.json"
        self.journal = self.directory / "transaction.json"
        self.scanner = scanner or self.scan
        self.decompress = decompress or self.uncompress

    @staticmethod
    def scan(path, manifest):
        from package import inspect_archive
        return inspect_archive(path, manifest)

    @staticmethod
    def uncompress(source, target):
        command(["zstd", "--decompress", "--force", "-o", str(target), str(source)], timeout=600)

    def audit(self, event, **fields):
        with (self.directory / "audit.jsonl").open("a") as stream:
            stream.write(json.dumps({"at": utcnow(), "event": event, **fields}, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def failure_evidence(self, event, **fields):
        # A full disk/broken audit sink must not prevent restoring a failed switch.
        # Normal success auditing still fails closed; this is only failure handling.
        try:
            self.audit(event, **fields)
        except Exception:
            print("GreenPMS: failure audit unavailable; inspect deployment journal", file=sys.stderr)

    def config_hash(self):
        return hashlib.sha256((sha256_file(self.config["composeFile"]) + sha256_file(self.config["envFile"])).encode()).hexdigest()

    def state(self):
        require(self.state_file.is_file(), "initial adoption required by administrator before deployment")
        state = json.loads(self.state_file.read_bytes())
        require(state["configurationSha256"] == self.config_hash(), "external configuration changed; approved reconciliation required")
        return state

    def observe(self, state):
        require(self.docker.current()["imageId"] == runtime_image_id(state["current"]), "running container differs from recorded current; recover first")

    def receipt(self, state):
        return {"application": "greenpms", "status": "healthy", "deployedAt": state["deployedAt"],
                **{key: state.get(key) for key in ("current", "previous", "rollbackFrom")}}

    def recover(self):
        preparation = self.directory / "database-preparing.json"
        if preparation.exists():
            from database_upgrade import adapter_from_transaction
            record = json.loads(preparation.read_bytes())
            adapter = adapter_from_transaction(self, {"database": record}, cleanup=True)
            adapter.remove_owned(adapter.job)
            adapter.remove_owned(adapter.clone)
            adapter.remove_owned(adapter.cancel_job)
            preparation.unlink()
        if not self.journal.exists():
            return
        transaction = json.loads(self.journal.read_bytes())
        if transaction.get("kind") == "ai-configuration":
            from ai_config import recover
            recover(self, transaction)
            return
        if transaction.get("kind") == "database-upgrade":
            from database_upgrade import recover
            return recover(self, transaction)
        old = transaction["before"]
        require(old["configurationSha256"] == self.config_hash(), "recovery configuration changed; administrator intervention required")
        # If state commit completed, restore that committed current instead of undoing success.
        target = json.loads(self.state_file.read_bytes())
        self.docker.switch(target["current"])
        self.health(target["current"])
        self.journal.unlink()
        self.audit("recovered", imageId=runtime_image_id(target["current"]))

    def clear_stale_downloads(self):
        # Only our root-owned dedicated temp subtree, always under the deployment lock.
        directory = self.directory / "tmp"
        require(not directory.is_symlink(), "download directory must not be a symlink")
        directory.mkdir(mode=0o700, exist_ok=True)
        for entry in directory.iterdir():
            if entry.name.startswith("download-") and entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)

    def adopt(self, version, revision, image_id, migrations):
        validate_identity(version, revision)
        validate_migrations(migrations)
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "invalid initial image ID")
        require(not self.state_file.exists() and not self.journal.exists(), "adoption already exists")
        require(self.docker.current()["imageId"] == image_id, "initial image ID mismatch")
        m = {"version": version, "gitRevision": revision, "imageId": image_id, "imageTag": image_id,
             "requiredMigrations": migrations, "rollbackCompatibility": {"mode": "same-migrations-only", "reason": "administrator-verified initial migration baseline"}}
        current = {"legacy": True, "prefix": None, "manifestSha256": None, "manifest": m}
        self.health(current)
        state = {"schemaVersion": 1, "current": current, "previous": None, "rollbackFrom": None,
                 "deployedAt": utcnow(), "configurationSha256": self.config_hash()}
        atomic_json(self.state_file, state)
        self.audit("adopted", version=version, imageId=image_id)
        return self.receipt(state)

    def deploy(self, version, revision, key, manifest_sha, *, rollback=False, dry_run=False, prepare_database=False):
        validate_identity(version, revision)
        require(key == release_prefix("greenpms/releases/", version, revision), "invalid COS release key")
        require(HEX.fullmatch(manifest_sha), "invalid manifest checksum")
        if self.journal.exists():
            transaction = json.loads(self.journal.read_bytes())
            if transaction.get("kind") == "database-upgrade":
                from database_upgrade import recover, identity
                requested = {"prefix": key, "manifestSha256": manifest_sha}
                require(not rollback and identity(transaction["target"]) == requested,
                        "DATABASE_RELEASE_CONFLICT: unfinished upgrade belongs to another release")
                # A repeated Actions run prepares first. It must not repeat backup/SQL
                # against a possibly changed database; explicit deploy does readiness recovery.
                if prepare_database:
                    return {"application": "greenpms", "status": "database-resume-required", **requested}
                recovered = recover(self, transaction, retry_target=transaction["target"])
                if recovered is not None:
                    return recovered
            else:
                raise ReleaseError("unfinished deployment requires recovery")
        require(not (self.directory / "database-preparing.json").exists(), "unfinished database preparation requires recovery")
        before = self.state()
        self.observe(before)
        require(rollback or tuple(map(int, version[1:].split("."))) >= tuple(map(int, before["current"]["manifest"]["version"][1:].split("."))), "older version requires explicit rollback")
        if dry_run:
            return {"application": "greenpms", "status": "dry-run", "version": version, "key": key}
        self.clear_stale_downloads()
        self.audit("started", version=version, revision=revision, rollback=rollback)
        previous = before.get("previous")
        if rollback and previous and previous.get("manifestSha256") == manifest_sha and previous.get("prefix") == key:
            compatible(before["current"], previous, rollback=True)
            image = self.docker.inspect_image(previous["manifest"]["imageTag"])
            verify_image(image, previous["manifest"])
            require(image["Id"] == runtime_image_id(previous), "rollback image identity changed")
            return self.promote(before, previous, rollback=True)
        with tempfile.TemporaryDirectory(prefix="download-", dir=self.directory / "tmp") as temporary:
            path = Path(temporary)
            for name in FILES:
                self.store.download(key + name, path / name)
            m = validate_bundle(path, manifest_sha, version, revision)
            target = {"prefix": key, "manifestSha256": manifest_sha, "manifest": m}
            compatible(before["current"], target, rollback=rollback)
            if before["current"]["manifest"]["imageId"] == m["imageId"]:
                require(before["current"].get("manifestSha256") == manifest_sha, "same image has conflicting release identity")
                image = self.docker.inspect_image(m["imageTag"])
                verify_image(image, m)
                require(image["Id"] == runtime_image_id(before["current"]), "image identity changed before retry")
                self.health(before["current"])
                self.audit("idempotent", version=version)
                if prepare_database:
                    return {"application": "greenpms", "status": "database-not-required", "prefix": key, "manifestSha256": manifest_sha}
                return self.receipt(before)
            self.decompress(path / ARCHIVE, path / "image.tar")
            archive_details = self.scanner(path / "image.tar", m)
            self.docker.load(path / "image.tar")
            loaded = self.docker.inspect_image(m["imageTag"])
            verify_loaded_image(loaded, m, archive_details)
            target["runtimeImageId"] = loaded["Id"]
            if prepare_database:
                if before["current"]["manifest"]["requiredMigrations"] == m["requiredMigrations"]:
                    self.docker.database_preflight(target)
                    return {"application": "greenpms", "status": "database-not-required", "prefix": key, "manifestSha256": manifest_sha}
                from database_upgrade import prepare
                return prepare(self, before, target)
            if not rollback and before["current"]["manifest"]["requiredMigrations"] != m["requiredMigrations"]:
                from database_upgrade import upgrade
                return upgrade(self, before, target)
            return self.promote(before, target, rollback=rollback)

    def promote(self, before, target, *, rollback=False, database_transaction=None):
        if database_transaction is None:
            self.observe(before)
        if not rollback:
            try:
                self.docker.database_preflight(target)
            except DeploymentDiagnosticError as error:
                self.failure_evidence("preflight-blocked", version=target["manifest"]["version"],
                                      stage="database-preflight", diagnosticCode=error.code, **error.details)
                raise
        if database_transaction is None:
            atomic_json(self.journal, {"before": before, "target": target, "startedAt": utcnow()})
        else:
            database_transaction["phase"] = "opening"
            atomic_json(self.journal, database_transaction)
        stage = "compose-start"
        try:
            if database_transaction is None:
                self.docker.switch(target)
            else:
                self.docker.switch(target, maintenance=True)
            stage = "health-gate"
            self.health(target)
            after = {**before, "current": target, "previous": before["current"],
                     "rollbackFrom": before["current"] if rollback else None, "deployedAt": utcnow()}
            stage = "state-commit"
            atomic_json(self.state_file, after)
            if database_transaction is not None:
                database_transaction["phase"] = "committed"
                atomic_json(self.journal, database_transaction)
                stage = "restart-policy"
                self.docker.restore_restart_policy(target)
        except BaseException as error:
            code = error.code if isinstance(error, DeploymentDiagnosticError) else "UNEXPECTED_" + stage.upper().replace("-", "_")
            details = error.details if isinstance(error, DeploymentDiagnosticError) else {}
            self.failure_evidence("failed", version=target["manifest"]["version"], stage=stage,
                                  diagnosticCode=code, **details)
            if database_transaction is not None:
                from database_upgrade import stop, adapter_from_transaction, best_effort_record
                if database_transaction["phase"] == "committed":
                    best_effort_record(self.journal, database_transaction)
                    raise ReleaseError("DATABASE_COMMITTED_FINALIZATION_FAILED: healthy target retained; retry same release to restore restart policy") from None
                database_transaction["phase"] = "blocked"
                best_effort_record(self.journal, database_transaction)
                try:
                    stop(self)
                finally:
                    adapter_from_transaction(self, database_transaction, cleanup=True).cancel(target)
                raise ReleaseError("DATABASE_TARGET_HEALTH_FAILED: writes stopped; same-release recovery required; old image rollback prohibited") from None
            try:
                self.docker.switch(before["current"])
                self.health(before["current"])
                atomic_json(self.state_file, before)
                self.journal.unlink()
            except BaseException:
                self.failure_evidence("recovery-required", imageId=runtime_image_id(before["current"]))
                raise ReleaseError("deployment failed and recovery is incomplete; journal retained; no retention allowed") from None
            self.failure_evidence("restored", imageId=runtime_image_id(before["current"]))
            raise ReleaseError("deployment failed; previous container restored; no success marker or retention") from None
        if database_transaction is not None:
            (self.directory / "database-prepared.json").unlink(missing_ok=True)
        self.audit("healthy", version=target["manifest"]["version"], imageId=target["manifest"]["imageId"],
                   runtimeImageId=runtime_image_id(target))
        self.journal.unlink()
        return self.receipt(after)


def root_owned(path, *, secret=False):
    path = Path(path)
    require(path.is_absolute() and not path.is_symlink(), "configuration paths must be absolute non-symlinks")
    for part in (path, *path.parents):
        info = part.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "deployment configuration must be root owned and not group/world writable")
    if secret:
        require(path.stat().st_mode & 0o077 == 0, "configuration credentials require mode 0600")


def load_config():
    require(os.geteuid() == 0, "root-owned restricted entry required")
    root_owned(ROOT_CONFIG, secret=True)
    config = json.loads(ROOT_CONFIG.read_bytes())
    for key in ("stateDir", "composeFile", "envFile"):
        root_owned(config[key], secret=key == "envFile")
    require(config["localBaseUrl"] == "http://127.0.0.1:4100", "unexpected local health URL")
    for key in ("publicReadyUrl", "publicVersionUrl"):
        require(config[key].startswith("https://") and "@" not in config[key], "public health URL requires HTTPS without credentials")
    require(config["publicReadyUrl"].endswith("/health/ready") and config["publicVersionUrl"].endswith("/api/v1/version"), "invalid public health endpoint")
    return config


def signal_failure(_signum, _frame):
    # Disable repeated signals while recovery is in progress.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    raise ReleaseError("deployment interrupted")


def serve(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["deploy", "prepare-database", "rollback", "maintenance", "recover", "adopt", "rollback-local", "configure-ai"])
    parser.add_argument("args", nargs="*")
    arguments = parser.parse_args(argv)
    operation, args = arguments.operation, arguments.args
    if operation in ("deploy", "prepare-database", "rollback"):
        require(len(args) == 4, "expected version revision COS key manifest SHA")
        validate_identity(args[0], args[1])
        require(args[2] == release_prefix("greenpms/releases/", args[0], args[1]) and HEX.fullmatch(args[3]), "invalid deploy request")
    elif operation == "adopt":
        require(len(args) == 4, "adoption needs version revision image ID migration baseline JSON")
    else:
        require(not args, "unexpected command parameters")
    config = load_config()
    from cos import CosStore
    cos_config = config["cos"]
    # The only server identity is read-only. Do not inherit a user's cloud env.
    for name in ("COS_SECRET_ID", "COS_SECRET_KEY", "COS_TOKEN"):
        os.environ.pop(name, None)
    if config.get("cosCredentialsFile"):
        root_owned(config["cosCredentialsFile"], secret=True)
        credentials = json.loads(Path(config["cosCredentialsFile"]).read_bytes())
        for name in ("COS_SECRET_ID", "COS_SECRET_KEY", "COS_TOKEN"):
            if name in credentials:
                os.environ[name] = credentials[name]
    docker = Docker(config)
    deployer = Deployer(config, docker, CosStore(cos_config["bucket"], cos_config["region"]), Health(docker, config))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal_failure)
    with deployment_lock(config["stateDir"]):
        if operation == "configure-ai":
            from ai_config import configure
            result = configure(deployer)
        elif operation == "adopt":
            root_owned(args[3])
            result = deployer.adopt(args[0], args[1], args[2], json.loads(Path(args[3]).read_bytes()))
        elif operation == "recover":
            deployer.recover()
            deployer.clear_stale_downloads()
            state = deployer.state()
            deployer.observe(state)
            deployer.health(state["current"])
            result = deployer.receipt(state)
        elif operation == "rollback-local":
            require(not deployer.journal.exists(), "recover unfinished deployment first")
            state = deployer.state()
            previous = state.get("previous")
            require(previous is not None, "no local rollback image")
            compatible(state["current"], previous, rollback=True)
            result = deployer.promote(state, previous, rollback=True)
        elif operation == "maintenance":
            require(not deployer.journal.exists(), "recovery required before maintenance")
            state = deployer.state()
            deployer.observe(state)
            deployer.health(state["current"])
            result = deployer.receipt(state)
            result["localImagePlan"] = cleanup_images(docker, state, dry_run=True)
        else:
            result = deployer.deploy(*args, rollback=operation == "rollback", prepare_database=operation == "prepare-database")
        print(json.dumps(result, separators=(",", ":")), flush=True)
        if operation in ("adopt", "recover", "rollback-local", "configure-ai"):
            return
        # Hold flock until COS marker + all deletes finish. Lost SSH never means success.
        # No lease expiry while a live client may still be deleting COS objects.
        # SSH EOF/cancellation releases the lock; client/job timeouts bound the
        # overall operation. Releasing on a timer here creates a cleanup race.
        line = sys.stdin.readline(4097)
        require(len(line) <= 4096 and line.endswith("\n"), "invalid orchestration acknowledgement")
        acknowledgement = json.loads(line)
        require(acknowledgement in ({"result": "complete"}, {"result": "failed"}, {"result": "dry-run"}), "invalid orchestration result")
        if acknowledgement["result"] != "dry-run":
            deployer.audit("orchestration", result=acknowledgement["result"])
        require(acknowledgement["result"] != "failed", "COS finalization failed; running version retained; retry required")
        if acknowledgement["result"] == "complete" and operation != "prepare-database":
            try:
                decisions = cleanup_images(docker, deployer.state())
                deployer.audit("local-cleanup", decisions=decisions)
                require(not any(d["action"] == "keep" and d["reason"] != "current/previous" for d in decisions),
                        "extra GreenPMS images remain protected by external references")
            except Exception:
                deployer.audit("local-cleanup-failed")
                raise ReleaseError("local image cleanup failed; healthy version retained; maintenance retry required") from None


if __name__ == "__main__":
    try:
        serve()
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print("GreenPMS: " + (str(error) if isinstance(error, ReleaseError) else "deployment failed; restricted operator investigation required"), file=sys.stderr)
        sys.exit(1)
