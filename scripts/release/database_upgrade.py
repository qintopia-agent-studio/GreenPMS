"""Database upgrade state machine. All entry points run under the deployment flock.

A durable sql-started record precedes every possible production SQL write. Neither
recovery nor retry replays a migration whose acknowledgement may have been lost.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

from common import ReleaseError, require, sha256_file, utcnow

UNSAFE_PHASES = {"sql-started", "sql-complete", "opening", "committed", "blocked"}


def best_effort_record(path, value):
    from server import atomic_json
    try:
        atomic_json(path, value)
    except Exception:
        # A previous fsynced journal remains authoritative on ENOSPC.
        pass


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700)
    fsync_directory(path)
    fsync_directory(path.parent)



def identity(target):
    return {"prefix": target["prefix"], "manifestSha256": target["manifestSha256"]}


def config(deployer):
    from server import root_owned
    value = deployer.config.get("databaseUpgrade")
    require(isinstance(value, dict), "DATABASE_UPGRADE_NOT_CONFIGURED: administrator must install database upgrade configuration")
    require(set(value) == {"ownerEnvFile", "backupDir", "postgresImage", "postgresMajor", "timeoutSeconds"},
            "DATABASE_UPGRADE_CONFIG_INVALID")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", value["postgresImage"] or ""), "DATABASE_POSTGRES_IMAGE_MUST_BE_PINNED")
    require(type(value["postgresMajor"]) is int and value["postgresMajor"] >= 16, "DATABASE_POSTGRES_MAJOR_INVALID")
    require(type(value["timeoutSeconds"]) is int and 30 <= value["timeoutSeconds"] <= 3600, "DATABASE_TIMEOUT_INVALID")
    root_owned(value["ownerEnvFile"], secret=True)
    root_owned(value["backupDir"], secret=True)
    backup = Path(value["backupDir"])
    state = deployer.directory.resolve()
    require(backup.is_dir() and backup.resolve() != state and state not in backup.resolve().parents
            and backup.resolve() not in state.parents, "DATABASE_BACKUP_DIRECTORY_MUST_BE_INDEPENDENT")
    # Only migration connection fields are permitted; runtime/password rotation is not.
    fields = {}
    for line in Path(value["ownerEnvFile"]).read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, sep, val = line.partition("=")
        require(sep and key in {"MIGRATION_DATABASE_URL", "MIGRATION_PGHOST", "MIGRATION_PGPORT",
                "MIGRATION_PGDATABASE", "MIGRATION_PGUSER", "MIGRATION_PGPASSWORD"} and key not in fields,
                "DATABASE_OWNER_ENV_INVALID")
        fields[key] = val
    require(bool(fields), "DATABASE_OWNER_ENV_EMPTY")
    return value


def fingerprint(deployer, settings):
    return hashlib.sha256((deployer.config_hash() + json.dumps(settings, sort_keys=True)
                           + sha256_file(settings["ownerEnvFile"])).encode()).hexdigest()


class Adapter:
    """Fixed commands; no SQL, paths, or environment are accepted over SSH."""
    def __init__(self, deployer, settings, directory, token):
        self.deployer, self.settings = deployer, settings
        self.directory, self.token = Path(directory), token
        require(re.fullmatch(r"[0-9a-f]{32}", token), "DATABASE_JOB_ID_INVALID")
        self.clone = "greenpms-db-" + token
        self.job = "greenpms-db-job-" + token
        self.cancel_job = "greenpms-db-cancel-" + token
        self.label = "org.greenpms.database-upgrade=" + token
        self.timeout = settings["timeoutSeconds"]
        self.stage = "ADAPTER"

    def command(self, args, *, timeout=None):
        from server import command
        try:
            return command(args, timeout=timeout or self.timeout, failure_code="DATABASE_" + self.stage + "_FAILED")
        except ReleaseError as error:
            from server import DeploymentDiagnosticError
            details = getattr(error, "details", {})
            best_effort_record(self.directory / "adapter-failure.json", {"stage": self.stage, "code": "DATABASE_" + self.stage + "_FAILED", "at": utcnow(), **details})
            raise DeploymentDiagnosticError("DATABASE_" + self.stage + "_FAILED",
                "DATABASE_" + self.stage + "_FAILED: inspect retained safe diagnostics", details=details) from None

    def stage_record(self, stage):
        from server import atomic_json
        self.stage = stage
        atomic_json(self.directory / "adapter-status.json", {"stage": stage, "at": utcnow()})

    def remove_owned(self, name):
        # Inspect only exact deterministic names, never prune arbitrary resources.
        result = subprocess.run(["docker", "container", "inspect", "--format",
                                 '{{index .Config.Labels "org.greenpms.database-upgrade"}}', name],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        if result.returncode != 0:
            # Distinguish absent from daemon unavailable before declaring cancellation.
            names = self.command(["docker", "ps", "-a", "--format", "{{.Names}}"], timeout=30).splitlines()
            require(name not in names, "DATABASE_JOB_CANCELLATION_UNCONFIRMED")
            return
        require(result.stdout.decode().strip() == self.token, "DATABASE_JOB_OWNERSHIP_MISMATCH")
        self.command(["docker", "rm", "--force", "--volumes", name], timeout=45)
        names = self.command(["docker", "ps", "-a", "--format", "{{.Names}}"], timeout=30).splitlines()
        require(name not in names, "DATABASE_JOB_CANCELLATION_UNCONFIRMED")

    def run(self, image, arguments, *, network="none", env_files=(), mounts=(), env=(), user=None, cancellation=False):
        job = self.cancel_job if cancellation else self.job
        self.remove_owned(job)
        args = ["docker", "create", "--name", job, "--label", self.label, "--network", network,
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev"]
        if user:
            args += ["--user", user]
        for path in env_files:
            args += ["--env-file", str(path)]
        for mount in mounts:
            args += ["--mount", mount]
        for item in env:
            args += ["--env", item]
        args += ["--entrypoint", arguments[0], image, *arguments[1:]]
        failure = None
        try:
            self.command(args)
            return self.command(["docker", "start", "--attach", job])
        except BaseException as error:
            failure = error
            raise
        finally:
            # Keep the original exit/timeout evidence when daemon cleanup also
            # fails. The caller's fail-closed cancellation retries all boundaries.
            try:
                self.remove_owned(job)
            except BaseException:
                if failure is None:
                    raise
                best_effort_record(self.directory / "cleanup-failure.json", {"job": job, "code": "DATABASE_JOB_CANCELLATION_UNCONFIRMED"})

    def work_mount(self, read_only=False):
        return f"type=bind,src={self.directory},dst=/work" + (",readonly" if read_only else "")

    def helper(self, target, action, *, clone=False):
        from server import runtime_image_id
        helper = Path(__file__).with_name("database-upgrade.mjs").resolve()
        env_files = ([self.directory / "clone.env"] if clone else
                     [self.directory / "migration.env"] if action in {"cancel", "migrate", "migration-status"} else
                     [self.deployer.config["envFile"], self.settings["ownerEnvFile"]])
        return self.run(runtime_image_id(target), ["node", "/app/database-upgrade.mjs", action],
                        network="container:" + self.clone if clone else "host",
                        env_files=env_files,
                        mounts=[self.work_mount(), f"type=bind,src={helper},dst=/app/database-upgrade.mjs,readonly"], user="0",
                        cancellation=action in {"cancel", "migration-status"})

    def inspect(self, before, target):
        from server import atomic_json
        self.stage_record("INSPECT")
        atomic_json(self.directory / "request.json", {"before": before["current"]["manifest"]["requiredMigrations"],
                    "target": target["manifest"]["requiredMigrations"], "major": self.settings["postgresMajor"],
                    "applicationName": self.job})
        self.helper(target, "inspect")

    def snapshot_metadata(self, name, dump_sha):
        from server import atomic_json
        snapshot = self.directory / (name + "-metadata")
        durable_directory(snapshot)
        files = {}
        for filename in ("request.json", "metadata.json", "cluster.sql", "pg.env", "clone.env", "migration.env"):
            content = (self.directory / filename).read_bytes()
            descriptor = os.open(snapshot / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            files[filename] = hashlib.sha256(content).hexdigest()
        atomic_json(snapshot / "manifest.json", {"dumpSha256": dump_sha, "files": files})
        fsync_directory(snapshot)
        fsync_directory(self.directory)
        return {"metadataDirectory": snapshot.name, "metadataSha256": sha256_file(snapshot / "manifest.json")}

    def verify_metadata_snapshot(self, record, dump_sha):
        snapshot = self.directory / record["metadataDirectory"]
        require(sha256_file(snapshot / "manifest.json") == record["metadataSha256"], "DATABASE_BACKUP_METADATA_CHANGED")
        manifest = json.loads((snapshot / "manifest.json").read_bytes())
        require(manifest["dumpSha256"] == dump_sha, "DATABASE_BACKUP_METADATA_MISMATCH")
        for filename, checksum in manifest["files"].items():
            require(sha256_file(snapshot / filename) == checksum and sha256_file(self.directory / filename) == checksum,
                    "DATABASE_BACKUP_METADATA_CHANGED")

    def backup_rehearse(self, before, target, name):
        from server import atomic_json, DATABASE_PREFLIGHT_SCRIPT, runtime_image_id
        # Metadata and source baseline are rechecked for each independently restored backup.
        self.inspect(before, target)
        dump = self.directory / (name + ".dump")
        require(not dump.exists(), "DATABASE_BACKUP_ALREADY_EXISTS")
        self.stage_record("BACKUP")
        self.run(self.settings["postgresImage"], ["pg_dump", "--format=custom", "--file=/work/" + dump.name],
                 network="host", env_files=[self.directory / "pg.env"], mounts=[self.work_mount()], user="0")
        os.chmod(dump, 0o600)
        with dump.open("rb") as stream:
            os.fsync(stream.fileno())
        digest = sha256_file(dump)
        atomic_json(self.directory / (name + ".sha256.json"), {"sha256": digest})
        metadata_record = self.snapshot_metadata(name, digest)
        self.run(self.settings["postgresImage"], ["pg_restore", "--list", "/work/" + dump.name], mounts=[self.work_mount(True)])
        self.remove_owned(self.clone)
        self.stage_record("RESTORE")
        try:
            self.command(["docker", "create", "--name", self.clone, "--label", self.label,
                          "--network", "none", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
                          "--env", "POSTGRES_USER=greenpms_restore",
                          "--mount", self.work_mount(True), self.settings["postgresImage"]])
            self.command(["docker", "start", self.clone])
            # Bounded readiness loop is inside a single owned container operation.
            self.command(["docker", "exec", self.clone, "sh", "-c",
                          "i=0; until pg_isready -h 127.0.0.1 -U greenpms_restore >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 60 ] || exit 1; sleep 1; done"], timeout=70)
            network = self.command(["docker", "inspect", "--format", "{{.HostConfig.NetworkMode}}", self.clone]).strip()
            require(network == "none", "DATABASE_REHEARSAL_NETWORK_INVALID")
            self.command(["docker", "exec", self.clone, "psql", "-U", "greenpms_restore", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "/work/cluster.sql"])
            metadata = json.loads((self.directory / "metadata.json").read_text())
            self.command(["docker", "exec", self.clone, "pg_restore", "--username=greenpms_restore", "--exit-on-error",
                          "--dbname=" + metadata["database"], "/work/" + dump.name])
            self.stage_record("RESTORE_METADATA")
            self.helper(target, "normalize", clone=True)
            self.helper(target, "verify-sessions", clone=True)
            self.ready(before["current"], clone=True)
            self.migrate(target, clone=True)
            self.ready(target, clone=True)
            require(sha256_file(dump) == digest, "DATABASE_BACKUP_CHANGED")
            self.verify_metadata_snapshot(metadata_record, digest)
            atomic_json(self.directory / (name + "-verified.json"), {"sha256": digest, **metadata_record, "verifiedAt": utcnow()})
            fsync_directory(self.directory)
            fsync_directory(self.directory.parent)
        finally:
            self.remove_owned(self.clone)

    def ready(self, target, *, clone=False):
        self.stage_record("REHEARSAL_READY" if clone else "TARGET_READY")
        from server import DATABASE_PREFLIGHT_SCRIPT, runtime_image_id
        output = self.run(runtime_image_id(target), ["node", "--input-type=module", "-e", DATABASE_PREFLIGHT_SCRIPT],
                          network="container:" + self.clone if clone else "host",
                          env_files=[self.directory / "clone.env"] if clone else [self.deployer.config["envFile"]])
        result = json.loads(output)
        names = [m["name"] for m in target["manifest"]["requiredMigrations"]]
        require(result == {"required": names, "applied": names, "ready": True, "readOnly": True}, "DATABASE_TARGET_NOT_READY")

    def migrate(self, target, *, clone=False):
        from server import atomic_json
        self.stage_record("REHEARSAL_MIGRATION" if clone else "PRODUCTION_MIGRATION")
        request = json.loads((self.directory / "request.json").read_text())
        names = [row["name"] for row in request["target"]]
        pending = names[len(request["before"]):]
        result_file = self.directory / "migration-result.json"
        atomic_json(result_file, {"outcome": "unknown", "completedMigrations": [],
                                  "firstPendingMigration": pending[0] if pending else None,
                                  "process": {"status": "starting"}})
        try:
            self.helper(target, "migrate", clone=clone)
        except BaseException as error:
            details = getattr(error, "details", {})
            # Refresh actual ledger only; never replay SQL to discover an outcome.
            try:
                self.helper(target, "migration-status", clone=clone)
            except BaseException:
                pass
            try:
                receipt = json.loads(result_file.read_text())
            except Exception:
                receipt = {"completedMigrations": [], "firstPendingMigration": pending[0] if pending else None}
            receipt["outcome"] = "unknown"
            receipt["process"] = {"status": "timeout" if details.get("timedOut") else "nonzero" if "exitCode" in details else "unavailable",
                                  "exitCode": details.get("exitCode"), "timedOut": details.get("timedOut", False)}
            best_effort_record(result_file, receipt)
            best_effort_record(self.directory / ("rehearsal-migration.json" if clone else "production-migration.json"), receipt)
            raise
        receipt = json.loads(result_file.read_text())
        require(receipt.get("outcome") == "complete", "DATABASE_MIGRATION_RECEIPT_INVALID")
        atomic_json(self.directory / ("rehearsal-migration.json" if clone else "production-migration.json"), receipt)

    def cancel(self, target):
        self.stage = "CANCEL"
        try:
            self.stage_record("CANCEL")
        except Exception:
            pass
        # Try every cancellation boundary even if Docker or one clone is broken.
        # The backend check must not be skipped because container cleanup failed.
        errors = []
        for operation in (lambda: self.remove_owned(self.job),
                          lambda: self.helper(target, "cancel"),
                          lambda: self.remove_owned(self.clone),
                          lambda: self.remove_owned(self.cancel_job)):
            try:
                operation()
            except BaseException as error:
                errors.append(error)
        if errors:
            raise ReleaseError("DATABASE_CANCELLATION_UNCONFIRMED: keep writes stopped and journal retained") from None


def make_adapter(deployer, settings, directory, token):
    return Adapter(deployer, settings, directory, token)


def prepare(deployer, before, target):
    from server import atomic_json
    settings = config(deployer)
    token = uuid.uuid4().hex
    directory = Path(settings["backupDir"]) / token
    durable_directory(directory)
    adapter = make_adapter(deployer, settings, directory, token)
    record = {**identity(target), "configurationSha256": fingerprint(deployer, settings),
              "before": before, "directory": str(directory), "token": token, "settings": settings}
    # Separate preparation journal owns temporary Docker resources across SIGKILL.
    atomic_json(deployer.directory / "database-preparing.json", {**record, "target": target})
    try:
        adapter.backup_rehearse(before, target, "preparation")
        atomic_json(deployer.directory / "database-prepared.json", record)
        deployer.audit("database-prepared", version=target["manifest"]["version"])
    finally:
        adapter.remove_owned(adapter.job)
        adapter.remove_owned(adapter.clone)
        adapter.remove_owned(adapter.cancel_job)
        (deployer.directory / "database-preparing.json").unlink(missing_ok=True)
    return {"application": "greenpms", "status": "database-prepared", **identity(target)}


def stop(deployer):
    # Compose may remove one service before failing. Verified absence is already
    # stopped; a same-named foreign container or ambiguous ownership is not.
    from server import DeploymentDiagnosticError
    def optional(lookup, name):
        try:
            return lookup()
        except DeploymentDiagnosticError as error:
            if error.code in {"APP_CONTAINER_MISSING", "WORKER_CONTAINER_MISSING"}:
                require(not any(c["name"] == "/" + name for c in deployer.docker.containers()),
                        "DATABASE_CONTAINER_OWNERSHIP_UNCONFIRMED")
                return None
            raise
    services = ((deployer.docker.worker, "qintopia-pms-wecom-worker"),
                (deployer.docker.current, "qintopia-pms-app"))
    errors = []
    for lookup, name in services:
        try:
            item = optional(lookup, name)
            if item is not None:
                deployer.docker.stop_container(item["id"])
        except BaseException as error:
            errors.append(error)
    if errors:
        raise ReleaseError("DATABASE_STOP_INCOMPLETE: journal retained; inspect both write services") from None
    for lookup, name in services:
        item = optional(lookup, name)
        require(item is None or not item["running"], "DATABASE_WRITERS_STILL_RUNNING")


def adapter_from_transaction(deployer, transaction, *, cleanup=False):
    record = transaction["database"]
    settings = record["settings"] if cleanup else config(deployer)
    if not cleanup:
        require(record["configurationSha256"] == fingerprint(deployer, settings), "DATABASE_CONFIGURATION_CHANGED: keep writes stopped")
    require(Path(record["directory"]) == Path(settings["backupDir"]) / record["token"], "DATABASE_BACKUP_PATH_INVALID")
    return make_adapter(deployer, settings, record["directory"], record["token"])


def recover(deployer, transaction, *, retry_target=None):
    from server import atomic_json
    unsafe = transaction["phase"] in UNSAFE_PHASES
    if unsafe:
        # State was durably committed before the process lost its receipt. A
        # healthy committed target can be retained; never resurrect the old image.
        state = json.loads(deployer.state_file.read_bytes())
        if (identity(state["current"]) == identity(transaction["target"])
                and state["configurationSha256"] == deployer.config_hash()):
            try:
                deployer.docker.database_preflight(transaction["target"])
                deployer.health(transaction["target"])
            except BaseException:
                pass
            else:
                # Durable state already commits a healthy target. Finalization
                # failure retains it and the journal for another recovery pass.
                adapter_from_transaction(deployer, transaction).cancel(transaction["target"])
                deployer.docker.restore_restart_policy(transaction["target"])
                deployer.journal.unlink()
                (deployer.directory / "database-prepared.json").unlink(missing_ok=True)
                deployer.audit("database-committed-recovered")
                return deployer.receipt(state)
        try:
            stop(deployer)
        finally:
            adapter_from_transaction(deployer, transaction, cleanup=True).cancel(transaction["target"])
        adapter = adapter_from_transaction(deployer, transaction)
        require(retry_target is not None and identity(retry_target) == identity(transaction["target"]),
                "DATABASE_OUTCOME_UNKNOWN: writes stopped; retry the same release after investigating retained backup and journal")
        # No SQL replay: only a fully applied ledger AND full target readiness can resume.
        adapter.ready(transaction["target"])
        return deployer.promote(transaction["before"], transaction["target"], database_transaction=transaction)
    adapter = adapter_from_transaction(deployer, transaction, cleanup=True)
    adapter.remove_owned(adapter.job)
    adapter.remove_owned(adapter.clone)
    adapter.remove_owned(adapter.cancel_job)
    adapter_from_transaction(deployer, transaction)
    deployer.docker.switch(transaction["before"]["current"])
    deployer.health(transaction["before"]["current"])
    atomic_json(deployer.state_file, transaction["before"])
    deployer.journal.unlink()
    deployer.audit("database-pre-migration-restored")
    return None


def upgrade(deployer, before, target):
    from server import atomic_json
    settings = config(deployer)
    path = deployer.directory / "database-prepared.json"
    require(path.is_file(), "DATABASE_PREPARATION_REQUIRED: run prepare-database first")
    record = json.loads(path.read_text())
    require(identity(record) == identity(target) and record["before"] == before,
            "DATABASE_PREPARATION_STALE: prepare this release against the current state")
    require(record["configurationSha256"] == fingerprint(deployer, settings), "DATABASE_CONFIGURATION_CHANGED")
    transaction = {"kind": "database-upgrade", "phase": "inspecting", "before": before, "target": target,
                   "database": record, "startedAt": utcnow()}
    adapter = adapter_from_transaction(deployer, transaction)
    # Validate production/target migration history and image file hashes before stopping.
    atomic_json(deployer.journal, transaction)
    try:
        adapter.inspect(before, target)
        transaction["phase"] = "stopping"
        atomic_json(deployer.journal, transaction)
        stop(deployer)
        transaction["phase"] = "final-backup"
        atomic_json(deployer.journal, transaction)
        adapter.backup_rehearse(before, target, "final-" + uuid.uuid4().hex)
        transaction["phase"] = "sql-started"
        atomic_json(deployer.journal, transaction)
        adapter.migrate(target)
        transaction["phase"] = "sql-complete"
        atomic_json(deployer.journal, transaction)
        adapter.ready(target)
        return deployer.promote(before, target, database_transaction=transaction)
    except BaseException as error:
        code = str(error).split(":", 1)[0] if isinstance(error, ReleaseError) else "DATABASE_UPGRADE_INTERRUPTED"
        if not re.fullmatch(r"DATABASE_[A-Z_]+", code):
            code = "DATABASE_UPGRADE_FAILED"
        deployer.failure_evidence("database-failed", stage=transaction["phase"], diagnosticCode=code,
                                  version=target["manifest"]["version"])
        if transaction["phase"] in UNSAFE_PHASES:
            best_effort_record(deployer.journal, transaction)
            if transaction["phase"] == "committed":
                raise ReleaseError("DATABASE_COMMITTED_FINALIZATION_FAILED: healthy target retained; retry same release to finalize") from None
            # Do not call generic rollback, even if migrate exited nonzero.
            try:
                stop(deployer)
            finally:
                adapter.cancel(target)
            raise ReleaseError("DATABASE_OUTCOME_UNKNOWN: writes stopped; backup and journal retained; retry same release only after investigation") from None
        recover(deployer, transaction)
        raise ReleaseError("DATABASE_PRE_MIGRATION_FAILED: old services restored; backup retained") from None
