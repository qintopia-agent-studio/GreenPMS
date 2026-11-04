import io
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.release.common import ReleaseError, json_bytes, sha256_file, validate_bundle
from scripts.release.package import archive_identity_for_built_image, build_bundle, forbidden_path, indexed_archive_path, inspect_archive


IMAGE_ID = "sha256:" + "0" * 64
VERSION = "v1.2.3"
REVISION = "a" * 40
IMAGE_TAG = f"greenpms:{VERSION}-{REVISION}"
CREATED = "2026-09-09T00:00:00Z"


def manifest():
    return {
        "schemaVersion": 1,
        "application": "greenpms",
        "version": VERSION,
        "gitRevision": REVISION,
        "platform": "linux/amd64",
        "imageId": IMAGE_ID,
        "imageTag": IMAGE_TAG,
        "archiveSha256": "1" * 64,
        "sbomSha256": "2" * 64,
        "createdAt": CREATED,
        "source": "https://github.com/qintopia-agent-studio/GreenPMS",
        "requiredMigrations": [{"name": "001_initial.sql", "sha256": "3" * 64}],
        "rollbackCompatibility": {
            "mode": "same-migrations-only",
            "reason": "No migration change.",
        },
    }


def add_bytes(archive, name, content):
    info = tarfile.TarInfo(name)
    info.size = len(content)
    archive.addfile(info, io.BytesIO(content))


def docker_archive(current, *, tag=IMAGE_TAG, repo_tags=None, labels=None, layer_name="app/runtime.js", modern=False, manifest_last=False):
    labels = labels or {
        "org.opencontainers.image.version": VERSION,
        "org.opencontainers.image.revision": REVISION,
        "org.opencontainers.image.source": "https://github.com/qintopia-agent-studio/GreenPMS",
        "org.opencontainers.image.created": CREATED,
    }
    layer_buffer = io.BytesIO()
    with tarfile.open(fileobj=layer_buffer, mode="w") as layer:
        add_bytes(layer, layer_name, b"runtime")
    layer_bytes = layer_buffer.getvalue()
    config = json.dumps({
        "os": "linux",
        "architecture": "amd64",
        "config": {"Labels": labels},
        "rootfs": {"type": "layers", "diff_ids": [f"sha256:{hashlib.sha256(layer_bytes).hexdigest()}"]},
    }).encode()
    config_digest = hashlib.sha256(config).hexdigest()
    current["imageId"] = f"sha256:{config_digest}"
    layer_path = f"blobs/sha256/{hashlib.sha256(layer_bytes).hexdigest()}" if modern else "layer/layer.tar"
    config_path = f"blobs/sha256/{config_digest}" if modern else f"{config_digest}.json"
    docker_manifest = json.dumps([{
        "Config": config_path,
        "RepoTags": repo_tags if repo_tags is not None else [tag],
        "Layers": [layer_path],
    }]).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        if manifest_last:
            add_bytes(archive, config_path, config)
            add_bytes(archive, layer_path, layer_bytes)
            add_bytes(archive, "manifest.json", docker_manifest)
        else:
            add_bytes(archive, "manifest.json", docker_manifest)
            add_bytes(archive, config_path, config)
            add_bytes(archive, layer_path, layer_bytes)
    return output.getvalue()


def pack_records(records):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, content in records.items():
            add_bytes(archive, name, content)
    return output.getvalue()


def oci_archive(current, *, indexed=False, attestation=None, change_index=None, change_proof=None, docker_media=False):
    with tarfile.open(fileobj=io.BytesIO(docker_archive(current, modern=True))) as archive:
        records = {member.name: archive.extractfile(member).read() for member in archive.getmembers()}
    entry = json.loads(records["manifest.json"])[0]
    config = json.loads(records[entry["Config"]])

    def descriptor(name, media_type):
        return {"mediaType": media_type, "digest": "sha256:" + hashlib.sha256(records[name]).hexdigest(), "size": len(records[name])}

    def add_object(value, media_type):
        content = json_bytes(value)
        name = "blobs/sha256/" + hashlib.sha256(content).hexdigest()
        records[name] = content
        return descriptor(name, media_type)

    manifest_type = "application/vnd.docker.distribution.manifest.v2+json" if docker_media else "application/vnd.oci.image.manifest.v1+json"
    index_type = "application/vnd.docker.distribution.manifest.list.v2+json" if docker_media else "application/vnd.oci.image.index.v1+json"
    config_type = "application/vnd.oci.image.config.v1+json"
    application = add_object({"schemaVersion": 2, "mediaType": manifest_type,
                              "config": descriptor(entry["Config"], config_type),
                              "layers": [descriptor(name, "application/vnd.oci.image.layer.v1.tar") for name in entry["Layers"]]}, manifest_type)
    root = application
    if indexed:
        children = [{**application, "platform": {"os": "linux", "architecture": "amd64"}}]
        if attestation:
            proof = {"schemaVersion": 2, "mediaType": manifest_type,
                     "config": add_object({} if attestation == "artifact" else {"os": "unknown", "architecture": "unknown"},
                                          "application/vnd.oci.empty.v1+json" if attestation == "artifact" else config_type),
                     "layers": [add_object({"predicateType": "synthetic"}, "application/vnd.in-toto+json")]}
            if attestation == "artifact":
                proof.update({"artifactType": "application/vnd.docker.attestation.manifest.v1+json", "subject": dict(application)})
            if change_proof:
                change_proof(proof)
            children.append({**add_object(proof, manifest_type), "platform": {"os": "unknown", "architecture": "unknown"},
                             "annotations": {"vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": application["digest"]}})
        index = {"schemaVersion": 2, "mediaType": index_type, "manifests": children}
        if change_index:
            change_index(index)
        root = add_object(index, index_type)
    records["oci-layout"] = json_bytes({"imageLayoutVersion": "1.0.0"})
    records["index.json"] = json_bytes({"schemaVersion": 2, "manifests": [root]})
    image = {"Id": root["digest"], "Descriptor": root, "Os": "linux", "Architecture": "amd64",
             "Config": config["config"], "RepoTags": [IMAGE_TAG]}
    return records, json.loads(json.dumps(image))


class PackageScannerTests(unittest.TestCase):
    def write_archive(self, content):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "image.tar"
        path.write_bytes(content)
        self.addCleanup(directory.cleanup)
        return path

    def test_accepts_valid_archive_and_tag(self):
        current = manifest()
        details = inspect_archive(self.write_archive(docker_archive(current)), current)
        self.assertEqual(details["imageTag"], IMAGE_TAG)
        self.assertEqual(len(details["rootfsDiffIds"]), 1)

    def test_rejects_tag_mismatch(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, tag="greenpms:wrong")), current)

    def test_rejects_extra_repo_tags(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(
                self.write_archive(docker_archive(current, repo_tags=[IMAGE_TAG, "other-project:latest"])),
                current,
            )

    def test_rejects_label_mismatch(self):
        current = manifest()
        labels = {
            "org.opencontainers.image.version": VERSION,
            "org.opencontainers.image.revision": "b" * 40,
            "org.opencontainers.image.source": "https://github.com/qintopia-agent-studio/GreenPMS",
            "org.opencontainers.image.created": CREATED,
        }
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, labels=labels)), current)

    def test_rejects_forbidden_file_without_reading_content(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, layer_name="app/.env")), current)

    def test_accepts_modern_blob_archive(self):
        current = manifest()
        details = inspect_archive(self.write_archive(docker_archive(current, modern=True)), current)
        self.assertEqual(details["layerCount"], 1)

    def test_accepts_manifest_last_archive(self):
        current = manifest()
        details = inspect_archive(self.write_archive(docker_archive(current, manifest_last=True)), current)
        self.assertEqual(details["layerCount"], 1)

    def test_preserves_dot_prefixes_when_scanning_paths(self):
        self.assertTrue(forbidden_path("./.env"))
        self.assertTrue(forbidden_path("./.production-operator-password-fixture"))
        self.assertTrue(forbidden_path("app/.env.example"))
        self.assertTrue(forbidden_path("app/apps/api/src/main.ts"))
        self.assertFalse(forbidden_path(".env.example", allow_env_example=True))

    def test_allows_dependency_declaration_files(self):
        current = manifest()
        details = inspect_archive(
            self.write_archive(docker_archive(current, layer_name="app/node_modules/example/index.d.ts")),
            current,
        )
        self.assertEqual(details["layerCount"], 1)

    def test_rejects_env_example_in_final_image(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, layer_name="app/.env.example")), current)


class BuiltImageIdentityTests(unittest.TestCase):
    write_archive = PackageScannerTests.write_archive

    def test_preserves_legacy_config_identity_without_a_descriptor(self):
        for modern in (False, True):
            with self.subTest(modern=modern):
                current = manifest()
                archive = self.write_archive(docker_archive(current, modern=modern))
                self.assertEqual(archive_identity_for_built_image(archive, {"Id": current["imageId"]}, IMAGE_TAG), current["imageId"])

    def test_binds_direct_and_indexed_manifests_with_both_buildkit_attestation_formats(self):
        for indexed, attestation in ((False, None), (True, None), (True, "legacy"), (True, "artifact")):
            with self.subTest(indexed=indexed, attestation=attestation):
                current = manifest()
                records, image = oci_archive(current, indexed=indexed, attestation=attestation)
                archive = self.write_archive(pack_records(records))
                self.assertNotEqual(image["Id"], current["imageId"])
                self.assertEqual(archive_identity_for_built_image(archive, image, IMAGE_TAG), current["imageId"])
                self.assertEqual(inspect_archive(archive, current)["imageId"], current["imageId"])

    def test_accepts_docker_manifest_and_manifest_list_media_types(self):
        for indexed in (False, True):
            with self.subTest(indexed=indexed):
                current = manifest()
                records, image = oci_archive(current, indexed=indexed, docker_media=True)
                self.assertEqual(archive_identity_for_built_image(self.write_archive(pack_records(records)), image, IMAGE_TAG), current["imageId"])

    def test_rejects_missing_or_mismatched_daemon_descriptor(self):
        current = manifest()
        records, image = oci_archive(current, indexed=True)
        archive = self.write_archive(pack_records(records))
        for changed in ({"Id": image["Id"]}, {**image, "Id": IMAGE_ID}, {**image, "Descriptor": {**image["Descriptor"], "size": 1}},
                        {**image, "Descriptor": {**image["Descriptor"], "mediaType": "unknown"}}):
            with self.subTest(image=changed), self.assertRaises(ReleaseError):
                archive_identity_for_built_image(archive, changed, IMAGE_TAG)

    def test_rejects_tampered_or_missing_config_layer_and_index_blobs(self):
        for target in ("config", "layer", "root"):
            for operation in ("tamper", "missing"):
                with self.subTest(target=target, operation=operation):
                    current = manifest()
                    records, image = oci_archive(current, indexed=True, attestation="artifact")
                    entry = json.loads(records["manifest.json"])[0]
                    name = {"config": entry["Config"], "layer": entry["Layers"][0], "root": "blobs/sha256/" + image["Id"][7:]}[target]
                    if operation == "tamper":
                        records[name] = b"!" + records[name][1:]
                    else:
                        del records[name]
                    with self.assertRaises(ReleaseError):
                        archive_identity_for_built_image(self.write_archive(pack_records(records)), image, IMAGE_TAG)

    def test_rejects_a_different_self_consistent_config_and_ambiguous_docker_manifest(self):
        for mutation in ("different-config", "extra-manifest", "extra-tag", "extra-root"):
            with self.subTest(mutation=mutation):
                current = manifest()
                records, image = oci_archive(current, indexed=True)
                entries = json.loads(records["manifest.json"])
                if mutation == "different-config":
                    changed = json.loads(records[entries[0]["Config"]]); changed["config"]["Cmd"] = ["changed"]
                    content = json_bytes(changed)
                    name = "blobs/sha256/" + hashlib.sha256(content).hexdigest()
                    records[name] = content
                    entries[0]["Config"] = name
                elif mutation == "extra-manifest":
                    entries.append(entries[0])
                elif mutation == "extra-tag":
                    entries[0]["RepoTags"].append("other:tag")
                else:
                    index = json.loads(records["index.json"]); index["manifests"].append(index["manifests"][0])
                    records["index.json"] = json_bytes(index)
                records["manifest.json"] = json_bytes(entries)
                with self.assertRaises(ReleaseError):
                    archive_identity_for_built_image(self.write_archive(pack_records(records)), image, IMAGE_TAG)

    def test_rejects_multiple_runnable_images_unknown_platforms_and_unbound_attestations(self):
        for change in (lambda index: index["manifests"].append(index["manifests"][0]),
                       lambda index: index["manifests"][0]["platform"].update(architecture="arm64"),
                       lambda index: index["manifests"][1]["annotations"].update({"vnd.docker.reference.digest": IMAGE_ID}),
                       lambda index: index["manifests"][1]["annotations"].update({"vnd.docker.reference.type": "unknown"})):
            current = manifest()
            records, image = oci_archive(current, indexed=True, attestation="artifact", change_index=change)
            with self.assertRaises(ReleaseError):
                archive_identity_for_built_image(self.write_archive(pack_records(records)), image, IMAGE_TAG)

    def test_rejects_duplicate_members_and_symlink_config(self):
        for mutation in ("duplicate", "symlink"):
            with self.subTest(mutation=mutation):
                current = manifest()
                records, image = oci_archive(current, indexed=True)
                config_name = json.loads(records["manifest.json"])[0]["Config"]
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w") as archive:
                    for name, content in records.items():
                        if mutation == "symlink" and name == config_name:
                            info = tarfile.TarInfo(name); info.type = tarfile.SYMTYPE; info.linkname = "manifest.json"
                            archive.addfile(info)
                        else:
                            add_bytes(archive, name, content)
                    if mutation == "duplicate":
                        add_bytes(archive, config_name, records[config_name])
                with self.assertRaises(ReleaseError):
                    archive_identity_for_built_image(self.write_archive(output.getvalue()), image, IMAGE_TAG)
        for change in (lambda proof: proof["subject"].update(digest=IMAGE_ID),
                       lambda proof: proof["layers"][0].update(mediaType="unknown")):
            current = manifest()
            records, image = oci_archive(current, indexed=True, attestation="artifact", change_proof=change)
            with self.assertRaises(ReleaseError):
                archive_identity_for_built_image(self.write_archive(pack_records(records)), image, IMAGE_TAG)

    def test_build_bundle_keeps_validation_and_packaging_order_with_config_identity(self):
        current = manifest()
        records, image = oci_archive(current, indexed=True, attestation="artifact")
        commands = []
        def fake_command(args, *unused, **kwargs):
            commands.append(args[:2])
            if args[:2] == ["docker", "save"]:
                Path(args[3]).write_bytes(pack_records(records))
            elif args[0] == "zstd":
                Path(args[-1]).write_bytes(Path(args[-3]).read_bytes())
            elif args[0] == "syft":
                Path(args[-1].split("=", 1)[1]).write_text('{"spdxVersion":"SPDX-2.3"}')
            return ""
        with tempfile.TemporaryDirectory() as directory, \
             patch("scripts.release.package.validate_release_identity"), patch("scripts.release.package.validate_build_context"), \
             patch("scripts.release.package.validate_policy", return_value=current["rollbackCompatibility"]), \
             patch("scripts.release.package.migration_manifest", return_value=current["requiredMigrations"]), \
             patch("scripts.release.package.utcnow", return_value=CREATED), \
             patch("scripts.release.package.docker_image_metadata", return_value=image), \
             patch("scripts.release.package.command", side_effect=fake_command), \
             patch("scripts.release.package.inspect_archive", wraps=inspect_archive) as scanner:
            bundled = build_bundle(Path(directory), VERSION, REVISION, Path(directory) / "bundle")
            self.assertEqual(bundled["imageId"], current["imageId"])
            scanner.assert_called_once()
            self.assertEqual([row[0] for row in commands], ["docker", "docker", "zstd", "syft"])
            commands.clear()
            image["Id"] = IMAGE_ID
            with self.assertRaises(ReleaseError):
                build_bundle(Path(directory), VERSION, REVISION, Path(directory) / "rejected")
            self.assertEqual(commands, [["docker", "build"], ["docker", "save"]])


@unittest.skipUnless(shutil.which("zstd"), "zstd is required for archive compression")
class CompressionTests(unittest.TestCase):
    def test_indexed_archive_path_decompresses_with_zstd(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "image.tar"
            compressed = root / "image.tar.zst"
            raw.write_bytes(b"archive bytes")
            subprocess.run(
                ["zstd", "--quiet", "--force", "-o", str(compressed), str(raw)],
                check=True,
            )

            temporary_directory, indexed = indexed_archive_path(compressed)
            try:
                self.assertEqual(indexed.read_bytes(), raw.read_bytes())
            finally:
                if temporary_directory is not None:
                    temporary_directory.cleanup()


class BundleValidationTests(unittest.TestCase):
    def test_rejects_sbom_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "greenpms-linux-amd64.docker.tar.zst"
            sbom = directory / "sbom.spdx.json"
            archive.write_bytes(b"archive")
            sbom.write_text(json.dumps({"spdxVersion": "SPDX-2.3"}))
            current = manifest()
            current["archiveSha256"] = sha256_file(archive)
            current["sbomSha256"] = sha256_file(sbom)
            (directory / "manifest.json").write_bytes(json_bytes(current))
            (directory / "SHA256SUMS").write_text(
                f"{sha256_file(archive)}  {archive.name}\n"
                f"{sha256_file(directory / 'manifest.json')}  manifest.json\n"
                f"{sha256_file(sbom)}  {sbom.name}\n"
            )
            validate_bundle(directory, sha256_file(directory / "manifest.json"), VERSION, REVISION)
            sbom.write_text(json.dumps({"spdxVersion": "SPDX-2.3", "changed": True}))
            with self.assertRaises(ReleaseError):
                validate_bundle(directory, sha256_file(directory / "manifest.json"), VERSION, REVISION)


if __name__ == "__main__":
    unittest.main()
