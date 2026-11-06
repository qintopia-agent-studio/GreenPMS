#!/usr/bin/env python3
"""Install a pinned greenpms-api package into one Hermes Profile, with rollback."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile
import tempfile

NAME = "greenpms-api"
FILES = ("SKILL.md", "scripts/greenpms.py", "references/business.md", "references/recovery.md")
ENVIRONMENT = ("GREENPMS_BASE_URL", "GREENPMS_API_TOKEN", "GREENPMS_PROPERTY_ID")
MARKER = "## Green PMS API 执行入口（版本化安装）"
INSTALLER = "scripts/skills/install-hermes-skill.py"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_path(path, kind=None):
    """Reject symlinks in every existing ancestor, including dangling symlinks."""
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValueError("Parent traversal is not allowed")
    current = Path(path.anchor)
    for index, part in enumerate(path.parts[1:]):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("Symlink paths are not allowed")
        final = index == len(path.parts) - 2
        if not final and not stat.S_ISDIR(info.st_mode):
            raise ValueError("Path ancestor must be a directory")
        if final:
            if kind == "directory" and not stat.S_ISDIR(info.st_mode):
                raise ValueError("Expected a regular directory")
            if kind == "file" and not stat.S_ISREG(info.st_mode):
                raise ValueError("Expected a regular file")
            return info
    return current.lstat()


@contextmanager
def profile_lock(profile):
    """One advisory lock for all releases and rollback; even dry-run writes no file."""
    info = checked_path(profile, "directory")
    if info is None or info.st_uid != os.getuid():
        raise ValueError("Profile must exist and belong to the installing user")
    fd = os.open(profile, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("Profile changed while opening it")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Another install or rollback is using this Profile; retry later") from error
        yield
    finally:
        os.close(fd)


def atomic_write(path, data):
    checked_path(path, "file")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    checked_path(path.parent, "directory")
    fd, temporary = tempfile.mkstemp(prefix=".skill-install-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        checked_path(path, "file")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def regular(path):
    if checked_path(path, "file") is None:
        raise ValueError("Expected an existing regular file")
    return path.read_bytes()


def file_hashes(directory):
    if checked_path(directory, "directory") is None:
        raise ValueError("Expected an existing regular Skill directory")
    result = {}
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories:
            checked_path(Path(parent) / name, "directory")
        for name in files:
            path = Path(parent) / name
            result[str(path.relative_to(directory))] = digest(regular(path))
    return dict(sorted(result.items()))


def optional_hashes(path):
    return file_hashes(path) if checked_path(path, "directory") is not None else None


def remove_known_tree(path, expected):
    if file_hashes(path) != expected:
        raise ValueError("Directory changed; preserve it for inspection")
    shutil.rmtree(path)


def render_skill(data):
    text = data.decode("utf-8")
    front, separator, body = text.partition("\n---\n")
    if not separator or not re.search(r"^name: greenpms-api$", front, re.M):
        raise ValueError("Unexpected Skill identity")
    if re.search(r"^required_environment_variables:", front, re.M):
        raise ValueError("Use canonical generic frontmatter; the installer owns the Hermes extension")
    extension = "\nrequired_environment_variables:\n" + "".join(f"  - name: {key}\n" for key in ENVIRONMENT)
    return (front + extension.rstrip("\n") + separator + body).encode("utf-8")


def route_operator(data):
    text = data.decode("utf-8")
    if MARKER in text:
        return data
    front, separator, body = text.partition("\n---\n")
    if not separator or not re.search(r"^name: greenpms-operator$", front, re.M):
        raise ValueError("Existing operator Skill has an unexpected identity; preserve it")
    route = ("\n" + MARKER + "\n\n"
             "日常业务办理先加载 `greenpms-api` Skill，使用其固定执行器处理预览、正式提交、超时恢复和结果回读。"
             "API 执行步骤与参数以该通用 Skill 及当前服务端契约为准；下文的运营提醒、展示口径、职责和业务授权要求继续适用。"
             "已明确授权且预览无新增影响时连续执行，无需为技术 Confirm 重复询问。\n\n")
    # Correct only the obsolete API mechanics; retain all local operational guidance.
    body = body.replace("Sequentially GET /api/v1/version, /api/v1/openapi.json, /api/v1/me, /api/v1/meta for onboarding.",
                        "Use the greenpms-api executor for onboarding; inspect identity/schema/meta only when needed, not before every operation.")
    body = body.replace("Use preview's propertyId, commandType, effectHash", "Use the scoped input propertyId and preview's commandType, effectHash")
    return (front + separator + route + body).encode("utf-8")


def pinned_package(source, artifact, release, artifact_sha):
    if not re.fullmatch(r"[a-f0-9]{64}", artifact_sha):
        raise ValueError("Invalid archive SHA256")
    archive_bytes = regular(artifact)
    if digest(archive_bytes) != artifact_sha:
        raise ValueError("Archive SHA256 does not match the verified artifact")
    expected = {f"skills/{NAME}/{relative}" for relative in FILES} | {INSTALLER}
    directories = {str(parent) for name in expected for parent in Path(name).parents if str(parent) != "."}
    archived = {}
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        if archive.pax_headers.get("comment") != release:
            raise ValueError("Archive PAX comment must identify the exact release Git commit")
        seen = set()
        for member in archive.getmembers():
            name = member.name.rstrip("/")
            if name in seen:
                raise ValueError("Archive contains duplicate paths")
            seen.add(name)
            if member.isdir() and name in directories:
                continue
            if not member.isfile() or name not in expected:
                raise ValueError("Archive must contain only the four Skill files and this installer")
            archived[name] = archive.extractfile(member).read()
    if set(archived) != expected:
        raise ValueError("Archive is missing a pinned source file")
    if archived[INSTALLER] != regular(Path(__file__).absolute()):
        raise ValueError("Running installer differs from the pinned archive installer")
    package = {relative: regular(source / relative) for relative in FILES}
    if any(data != archived[f"skills/{NAME}/{relative}"] for relative, data in package.items()):
        raise ValueError("Source files differ from the pinned archive")
    package["SKILL.md"] = render_skill(package["SKILL.md"])
    return package


def deployment_paths(profile, release):
    if not re.fullmatch(r"[a-f0-9]{40}", release):
        raise ValueError("Release must identify the exact source Git commit")
    deployment = profile / ".skill-deployments" / NAME / release
    live = profile / "skills" / NAME
    operator = profile / "skills" / "greenpms-operator" / "SKILL.md"
    checked_path(deployment, "directory")
    checked_path(live, "directory")
    checked_path(operator, "file")
    return deployment, live, operator


def write_receipt(path, receipt):
    atomic_write(path, json.dumps(receipt, indent=2).encode())


def install(profile, source, release, artifact_sha, artifact, expected_operator_sha=None, apply=False):
    profile, source, artifact = Path(profile).absolute(), Path(source).absolute(), Path(artifact).absolute()
    with profile_lock(profile):
        deployment, live, operator = deployment_paths(profile, release)
        package = pinned_package(source, artifact, release, artifact_sha)
        manifest_path = deployment / "manifest.json"
        if checked_path(manifest_path, "file") is not None:
            prior = json.loads(regular(manifest_path))
            if (prior.get("status") == "APPLIED" and prior["artifactSha256"] == artifact_sha
                    and optional_hashes(live) == prior["installedFiles"]
                    and (not prior["operatorChanged"] or digest(regular(operator)) == prior["operatorAfterSha256"])):
                return {"status": "ALREADY_APPLIED", "release": release, "serviceRestarted": False}
            raise ValueError("Existing deployment receipt does not match live state; use --rollback to recover known PREPARED state")
        if checked_path(deployment, "directory") is not None:
            raise ValueError("Deployment directory has no receipt; preserve it for inspection")
        previous = optional_hashes(live)
        operator_before = regular(operator) if expected_operator_sha else None
        if operator_before is not None and digest(operator_before) != expected_operator_sha:
            raise ValueError("Operator Skill changed since inventory; do not overwrite concurrent work")
        operator_after = route_operator(operator_before) if operator_before is not None else None
        changed = operator_before is not None and operator_after != operator_before
        receipt = {"status": "PREPARED", "release": release, "artifactSha256": artifact_sha,
                   "installedFiles": {path: digest(data) for path, data in package.items()}, "previousFiles": previous,
                   "operatorChanged": changed,
                   "operatorBeforeSha256": digest(operator_before) if operator_before is not None else None,
                   "operatorAfterSha256": digest(operator_after) if operator_after is not None else None,
                   "serviceRestarted": False, "credentialChanges": False}
        if not apply:
            return {**receipt, "status": "DRY_RUN"}
        deployment.mkdir(parents=True, mode=0o700)
        if previous is not None:
            shutil.copytree(live, deployment / "backup-skill")
            if file_hashes(deployment / "backup-skill") != previous:
                raise ValueError("Skill changed while backing up; live files were not touched")
        if changed:
            atomic_write(deployment / "backup-operator.md", operator_before)
            atomic_write(deployment / "rendered-operator.md", operator_after)
        for relative, data in package.items():
            atomic_write(deployment / "package" / relative, data)
        write_receipt(manifest_path, receipt)
        stage = Path(tempfile.mkdtemp(prefix=".greenpms-skill-stage-", dir=profile))
        try:
            shutil.copytree(deployment / "package", stage, dirs_exist_ok=True)
            if file_hashes(stage) != receipt["installedFiles"]:
                raise ValueError("Staged Skill does not match the pinned package")
            if optional_hashes(live) != previous:
                raise ValueError("Live Skill changed during staging")
            if operator_before is not None and digest(regular(operator)) != receipt["operatorBeforeSha256"]:
                raise ValueError("Operator Skill changed during staging")
            live.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            checked_path(live, "directory")
            if previous is not None:
                os.replace(live, deployment / "previous-live")
            os.replace(stage, live)
            if changed:
                atomic_write(operator, operator_after)
            receipt = {**receipt, "status": "APPLIED"}
            write_receipt(manifest_path, receipt)
        except Exception as error:
            try:
                rollback_locked(profile, release)
            except Exception as recovery_error:
                raise RuntimeError("Install failed and automatic restoration could not finish; preserve the receipt and inspect before --rollback") from recovery_error
            raise error
        finally:
            if checked_path(stage, "directory") is not None:
                remove_known_tree(stage, receipt["installedFiles"])
        return receipt


def rollback_locked(profile, release):
    deployment, live, operator = deployment_paths(profile, release)
    manifest_path = deployment / "manifest.json"
    manifest_before = regular(manifest_path)
    receipt = json.loads(manifest_before)
    if receipt["release"] != release:
        raise ValueError("Receipt release does not match the requested release")
    installed, previous = receipt["installedFiles"], receipt["previousFiles"]
    current = optional_hashes(live)
    operator_current = regular(operator) if receipt["operatorChanged"] else None
    operator_sha = digest(operator_current) if operator_current is not None else None
    if receipt["status"] == "ROLLED_BACK":
        if current != previous or (receipt["operatorChanged"] and operator_sha != receipt["operatorBeforeSha256"]):
            raise ValueError("Rolled-back files changed; preserve subsequent work")
        return {"status": "ALREADY_ROLLED_BACK", "release": release, "serviceRestarted": False}
    if receipt["status"] not in ("APPLIED", "PREPARED"):
        raise ValueError("Receipt cannot be recovered automatically")
    # Validate every recovery source before moving the live Skill.
    if file_hashes(deployment / "package") != installed:
        raise ValueError("Pinned package backup is corrupt; live files were not touched")
    if previous is not None and file_hashes(deployment / "backup-skill") != previous:
        raise ValueError("Previous Skill backup is corrupt; live files were not touched")
    old = optional_hashes(deployment / "previous-live")
    if old is not None and (previous is None or old != previous):
        raise ValueError("Previous live directory changed; preserve it for inspection")
    operator_before = regular(deployment / "backup-operator.md") if receipt["operatorChanged"] else None
    if receipt["operatorChanged"]:
        if (digest(operator_before) != receipt["operatorBeforeSha256"]
                or digest(regular(deployment / "rendered-operator.md")) != receipt["operatorAfterSha256"]):
            raise ValueError("Operator backup is corrupt; live files were not touched")
    held = deployment / "rollback-held"
    held_hashes = optional_hashes(held)
    if held_hashes is not None and held_hashes != installed:
        raise ValueError("Rollback recovery directory changed; preserve it for inspection")
    if receipt["status"] == "APPLIED" and held_hashes is None:
        valid_live = current == installed
        valid_operator = not receipt["operatorChanged"] or operator_sha == receipt["operatorAfterSha256"]
    else:
        valid_live = current == installed or current == previous
        if current is None and previous is not None:
            valid_live = old == previous or held_hashes == installed
        if held_hashes is not None and current is not None and current != previous:
            valid_live = False
        valid_operator = not receipt["operatorChanged"] or operator_sha in (
            receipt["operatorBeforeSha256"], receipt["operatorAfterSha256"])
    if not valid_live or not valid_operator:
        raise ValueError("Live Skill or operator has unknown changes; refusing destructive rollback")
    stage = None
    moved_current = False
    placed_previous = False
    try:
        if current != previous:
            if previous is not None:
                stage = Path(tempfile.mkdtemp(prefix=".greenpms-rollback-stage-", dir=profile))
                shutil.copytree(deployment / "backup-skill", stage, dirs_exist_ok=True)
                if file_hashes(stage) != previous:
                    raise ValueError("Rollback stage does not match the verified backup")
            if optional_hashes(live) != current:
                raise ValueError("Live Skill changed during rollback staging")
            if current is not None:
                if held_hashes is not None:
                    raise ValueError("Ambiguous rollback state; preserve both directories")
                os.replace(live, held)
                moved_current = True
            if stage is not None:
                live.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                checked_path(live, "directory")
                os.replace(stage, live)
                placed_previous = True
        if receipt["operatorChanged"]:
            if digest(regular(operator)) != operator_sha:
                raise ValueError("Operator changed during rollback staging")
            atomic_write(operator, operator_before)
        write_receipt(manifest_path, {**receipt, "status": "ROLLED_BACK"})
    except Exception as error:
        # Restore the entry state after an ordinary failure; keep all sources for an interrupted process.
        try:
            if placed_previous:
                remove_known_tree(live, previous)
            if moved_current:
                if optional_hashes(live) is not None or file_hashes(held) != current:
                    raise ValueError("Live or held files changed during rollback recovery")
                os.replace(held, live)
            if receipt["operatorChanged"]:
                if digest(regular(operator)) not in (operator_sha, receipt["operatorBeforeSha256"]):
                    raise ValueError("Operator changed during rollback recovery")
                atomic_write(operator, operator_current)
            atomic_write(manifest_path, manifest_before)
        except Exception as recovery_error:
            raise RuntimeError("Rollback could not restore its entry state; preserve all files and inspect the receipt before retrying") from recovery_error
        raise error
    finally:
        if stage is not None and checked_path(stage, "directory") is not None:
            remove_known_tree(stage, previous)
    return {"status": "ROLLED_BACK", "release": release, "serviceRestarted": False}


def rollback(profile, release):
    profile = Path(profile).absolute()
    with profile_lock(profile):
        return rollback_locked(profile, release)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--release", required=True)
    parser.add_argument("--artifact-sha256")
    parser.add_argument("--expected-operator-sha256")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--rollback", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.release):
        parser.error("--release must identify the exact source Git commit")
    if args.rollback:
        result = rollback(args.profile, args.release)
    else:
        if args.source is None or args.artifact is None or not re.fullmatch(r"[a-f0-9]{64}", args.artifact_sha256 or ""):
            parser.error("Provide --source, --artifact and the verified archive --artifact-sha256")
        if args.expected_operator_sha256 and not re.fullmatch(r"[a-f0-9]{64}", args.expected_operator_sha256):
            parser.error("Invalid operator digest")
        result = install(args.profile, args.source, args.release, args.artifact_sha256, args.artifact,
                         args.expected_operator_sha256, args.apply)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
