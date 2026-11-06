#!/usr/bin/env python3
"""Bounded Green PMS HTTP calls with durable, per-attempt command identities."""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "1.0.0"
MAX_RESPONSE = 16 * 1024 * 1024
SECRET_KEYS = {"authorization", "token", "tokensecret", "apitoken", "apikey", "password",
               "currentpassword", "newpassword", "privatekey", "clientsecret", "accesstoken"}
CREDENTIAL_COMMANDS = {"ISSUE_TOKEN", "ROTATE_TOKEN", "REVOKE_TOKEN"}
TARGET_ID_FIELDS = ("orderId", "memberId", "membershipOrderId", "entitlementLotId", "maintenanceLockId")


class ClientError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def fail(code, message):
    raise ClientError(code, message)


def object_json(value):
    try:
        result = json.loads(value)
    except (ValueError, TypeError):
        fail("INVALID_JSON", "Expected a JSON object; do not include credentials.")
    if not isinstance(result, dict):
        fail("INVALID_JSON", "Expected a JSON object.")
    return result


def secret_key(key):
    return re.sub(r"[^a-z]", "", str(key).lower()) in SECRET_KEYS


def contains_credential(value, token):
    # Inspect keys, URLs and values alike, including percent-encoded echoes.
    # Excessively nested escaping is rejected/redacted rather than decoded forever.
    for _ in range(8):
        if token and token in value:
            return True
        decoded = urllib.parse.unquote(value)
        if decoded == value:
            return False
        value = decoded
    return bool(token and token in value) or urllib.parse.unquote(value) != value


def reject_secrets(value, token):
    if isinstance(value, dict):
        for key, item in value.items():
            if secret_key(key):
                fail("CREDENTIAL_INPUT_REJECTED", "Credential management is outside this daily-business client.")
            reject_secrets(str(key), token)
            reject_secrets(item, token)
    elif isinstance(value, list):
        for item in value:
            reject_secrets(item, token)
    elif isinstance(value, str) and contains_credential(value, token):
        fail("CREDENTIAL_INPUT_REJECTED", "Never place an API credential in business input or state.")


def scrub(value, token):
    if isinstance(value, dict):
        return {scrub(str(key), token): "<redacted>" if secret_key(key) else scrub(item, token)
                for key, item in value.items()}
    if isinstance(value, list):
        return [scrub(item, token) for item in value]
    if isinstance(value, str) and contains_credential(value, token):
        return "<redacted>"
    return value


def safe_path(path):
    if not isinstance(path, str):
        fail("INVALID_PATH", "Use a relative /api/v1/ or /api/v2/ path.")
    parsed = urllib.parse.urlsplit(path)
    decoded = urllib.parse.unquote(parsed.path)
    if (parsed.scheme or parsed.netloc or parsed.fragment or not re.match(r"^/api/v[12]/", parsed.path)
            or "\\" in decoded or any(ord(char) < 32 for char in path)
            or any(part in (".", "..") for part in decoded.split("/"))):
        fail("INVALID_PATH", "Use a relative /api/v1/ or /api/v2/ path without traversal or redirects.")
    return path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@contextlib.contextmanager
def http_deadline(seconds):
    """Bound the complete synchronous HTTP call, including slow-drip bodies.

    The CLI runs on the main thread. Do not silently discard another caller's
    earlier alarm: fail before HTTP and leave that timer untouched instead.
    """
    if threading.current_thread() is not threading.main_thread():
        fail("DEADLINE_REQUIRES_MAIN_THREAD", "Run this synchronous client on the main thread so its HTTP deadline is enforced.")
    if not hasattr(signal, "setitimer"):
        fail("DEADLINE_UNAVAILABLE", "This client requires POSIX interval timers for bounded HTTP calls.")
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_delay, previous_interval = signal.getitimer(signal.ITIMER_REAL)
    if previous_delay and previous_delay <= seconds:
        fail("DEADLINE_CONFLICT", "An earlier process alarm is active; no HTTP request was sent.")
    started = time.monotonic()

    def expired(_signum, _frame):
        raise TimeoutError("HTTP deadline exceeded")

    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_delay:
            remaining = max(0.000001, previous_delay - (time.monotonic() - started))
            signal.setitimer(signal.ITIMER_REAL, remaining, previous_interval)


class Client:
    def __init__(self, environment=None, opener=None):
        env = os.environ if environment is None else environment
        self.base = env.get("GREENPMS_BASE_URL", "").rstrip("/")
        self.token = env.get("GREENPMS_API_TOKEN", "")
        self.property_id = env.get("GREENPMS_PROPERTY_ID", "")
        parsed = urllib.parse.urlsplit(self.base)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            fail("CONFIGURATION_REQUIRED", "GREENPMS_BASE_URL must be an HTTPS origin without credentials or path.")
        if not self.token or not self.property_id:
            fail("CONFIGURATION_REQUIRED", "GREENPMS_API_TOKEN and GREENPMS_PROPERTY_ID must be supplied by the runtime environment.")
        try:
            self.timeout = float(env.get("GREENPMS_HTTP_TIMEOUT_SECONDS", "30"))
        except ValueError:
            fail("INVALID_TIMEOUT", "HTTP timeout must be between 1 and 120 seconds.")
        if not 1 <= self.timeout <= 120:
            fail("INVALID_TIMEOUT", "HTTP timeout must be between 1 and 120 seconds.")
        # Bind uncertain attempts to their original credential without storing the credential.
        self.credential_fingerprint = hashlib.sha256(self.token.encode()).hexdigest()
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method, path, query=None, payload=None, key=None, correlation=None):
        safe_path(path)
        reject_secrets(path, self.token)
        if query:
            reject_secrets(query, self.token)
            path += ("&" if "?" in path else "?") + urllib.parse.urlencode(query, doseq=True)
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        if payload is not None:
            reject_secrets(payload, self.token)
            headers["Content-Type"] = "application/json"
        if key:
            headers["Idempotency-Key"] = key
        if correlation:
            headers["X-Correlation-ID"] = correlation
        request = urllib.request.Request(self.base + path, data=None if payload is None else json.dumps(payload).encode(),
                                         headers=headers, method=method)
        started = time.monotonic()
        meta = {"method": method, "path": urllib.parse.urlsplit(path).path}
        try:
            with http_deadline(self.timeout):
                try:
                    response = self.opener.open(request, timeout=self.timeout)
                except urllib.error.HTTPError as error:
                    response = error  # Read the API error body, never stringify the exception or headers.
                with response:
                    status = response.code
                    meta["status"] = status
                    if 300 <= status < 400:
                        return {"ok": False, "http": {**meta, "elapsedMs": round((time.monotonic()-started)*1000)},
                                "error": {"code": "REDIRECT_REJECTED", "message": "Redirect was not followed."}}
                    raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    fail("RESPONSE_TOO_LARGE", "Response exceeds the bounded client limit; use a narrower query.")
                try:
                    data = json.loads(raw)
                except (ValueError, UnicodeError):
                    return {"ok": False, "http": {**meta, "elapsedMs": round((time.monotonic()-started)*1000)},
                            "error": {"code": "NON_JSON_RESPONSE", "message": "No parseable API result was received."}}
                return {"ok": 200 <= status < 300, "http": {**meta, "elapsedMs": round((time.monotonic()-started)*1000)},
                        "data": scrub(data, self.token)}
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException):
            return {"ok": False, "http": {**meta, "status": None, "elapsedMs": round((time.monotonic()-started)*1000)},
                    "error": {"code": "TRANSPORT_UNCERTAIN", "message": "No definitive response; preserve this attempt and recover its original identity."}}


class State:
    def __init__(self, filename):
        self.path = Path(filename).absolute()
        self.value = None

    def _check(self, path):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            fail("UNSAFE_STATE", "State and lock must be regular, unlinked files owned by this user.")
        if info.st_mode & 0o077:
            fail("UNSAFE_STATE", "State and lock must have private 0600 permissions.")

    @contextlib.contextmanager
    def locked(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = self.path.with_name(self.path.name + ".lock")
        self._check(self.path)
        self._check(lock_path)
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except OSError:
            fail("UNSAFE_STATE", "Cannot open the private state lock.")
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail("STATE_BUSY", "Another invocation is handling this attempt; do not start another attempt.")
            self._check(self.path)
            if self.path.exists():
                try:
                    self.value = json.loads(self.path.read_text())
                except (OSError, ValueError):
                    fail("INVALID_STATE", "State is unreadable; preserve it and investigate instead of recreating keys.")
                if not isinstance(self.value, dict) or self.value.get("format") != 1:
                    fail("INVALID_STATE", "Unsupported state format; do not overwrite it.")
            yield self
        finally:
            os.close(fd)

    def save(self):
        self._check(self.path)
        fd, name = tempfile.mkstemp(prefix="." + self.path.name + ".", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(self.value, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)


def validate_context(state, client):
    if not state.value:
        fail("STATE_REQUIRED", "Run prepare or quote with a new private state path first.")
    if any(state.value.get(key) != expected for key, expected in (
            ("baseUrl", client.base), ("propertyId", client.property_id),
            ("credentialFingerprint", client.credential_fingerprint))):
        fail("STATE_CONTEXT_MISMATCH", "Origin, property or credential changed. Preserve the original attempt; do not recreate its keys.")


def new_state(client, command, input_value, readback, operation):
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,79}", command) or command.startswith("PREVIEW:") or command in CREDENTIAL_COMMANDS:
        fail("UNSUPPORTED_COMMAND", "Use an authorized daily-business command; credential management is excluded.")
    reject_secrets(input_value, client.token)
    input_value = {"propertyId": client.property_id, **input_value}
    if input_value["propertyId"] != client.property_id:
        fail("PROPERTY_MISMATCH", "Input propertyId must match GREENPMS_PROPERTY_ID.")
    if readback:
        safe_path(readback)
        reject_secrets(readback, client.token)
    flow = "pms-" + uuid.uuid4().hex
    return {"format": 1, "clientVersion": VERSION, "baseUrl": client.base, "propertyId": client.property_id,
            "credentialFingerprint": client.credential_fingerprint, "commandType": command, "operation": operation,
            "input": input_value, "readbackPath": readback, "correlationId": flow,
            "previewKey": flow + "-preview", "confirmKey": flow + "-confirm", "resolveKey": flow + "-resolve",
            "phase": "NEW", "createdAt": time.time()}


def result_envelope(state, response=None):
    result = {"phase": state.value["phase"], "stateFile": str(state.path), "commandType": state.value["commandType"],
              "correlationId": state.value["correlationId"], "businessVerified": False}
    for key in ("preview", "previewReceipt", "receipt", "quote"):
        if key in state.value:
            result[key] = state.value[key]
    if response:
        result["response"] = response
    return result


def record_receipt(state, response):
    receipt = response.get("data")
    if not isinstance(receipt, dict):
        state.value["phase"] = "UNKNOWN"
    elif receipt.get("executionStatus") == "UNKNOWN" and receipt.get("businessCommitted") is False:
        state.value["phase"] = "UNKNOWN"
    elif (receipt.get("commandType") != state.value["commandType"] or not receipt.get("receiptId")
          or not receipt.get("commandId") or not isinstance(receipt.get("result"), (dict, type(None)))
          or "preview" in (receipt.get("result") or {})):
        state.value["phase"] = "UNKNOWN"
        response["clientError"] = {"code": "RECEIPT_IDENTITY_MISMATCH", "message": "No matching formal receipt. Recover the original attempt; do not report completion."}
    elif isinstance(receipt.get("result"), dict) and any(
            field in state.value["input"] and field in receipt["result"]
            and state.value["input"][field] != receipt["result"][field] for field in TARGET_ID_FIELDS):
        state.value["phase"] = "UNKNOWN"
        response["clientError"] = {"code": "TARGET_IDENTITY_MISMATCH", "message": "Formal result names a different business target. Preserve this attempt and investigate before reporting completion."}
    elif (receipt.get("executionStatus") == "EXECUTED" and receipt.get("businessCommitted") is True
          and isinstance(receipt.get("result"), dict) and receipt["result"] and response.get("ok")):
        state.value["receipt"] = receipt
        state.value["phase"] = "COMMITTED"
        if state.value["operation"] == "quote":
            state.value["quote"] = receipt.get("result", {}).get("quote")
    elif receipt.get("executionStatus") == "NOT_EXECUTED" and receipt.get("businessCommitted") is False:
        state.value["receipt"] = receipt
        state.value["phase"] = "NOT_EXECUTED"
    else:
        state.value["phase"] = "UNKNOWN"
    state.value["lastResponse"] = response
    state.save()


def render_readback(template, state):
    roots = {"input": state["input"], "result": state.get("receipt", {}).get("result") or {}}
    def replace(match):
        parts = match.group(1).split(".")
        current = roots
        for key in parts:
            if not isinstance(current, dict) or key not in current:
                fail("READBACK_TARGET_MISSING", "Readback target is absent; formal receipt is preserved. Query the exact business target separately.")
            current = current[key]
        if not isinstance(current, (str, int)) or isinstance(current, bool) or current == "":
            fail("READBACK_TARGET_MISSING", "Readback target must be a nonempty identifier.")
        return urllib.parse.quote(str(current), safe="")
    rendered = re.sub(r"\{((?:input|result)(?:\.[A-Za-z][A-Za-z0-9_]*)+)\}", replace, template)
    if "{" in rendered or "}" in rendered:
        fail("INVALID_READBACK", "Use only {input.field} or {result.field} placeholders.")
    return safe_path(rendered)


def finish(state, client, response=None):
    output = result_envelope(state, response)
    if state.value["phase"] == "COMMITTED" and state.value.get("readbackPath"):
        try:
            path = render_readback(state.value["readbackPath"], state.value)
            readback = client.request("GET", path)
        except ClientError as error:
            readback = {"ok": False, "error": {"code": error.code, "message": error.message}}
        output["readback"] = readback
        output["next"] = "Compare the exact target and command-specific business state; HTTP 200 alone is not business verification."
    elif state.value["phase"] == "COMMITTED":
        output["next"] = "Formal receipt received. Read the exact business target before reporting completion."
    elif state.value["phase"] == "UNKNOWN":
        output["next"] = "Use recover with this state; never create a new attempt while the original outcome is unknown."
    elif state.value["phase"] == "NOT_EXECUTED":
        output["next"] = "This attempt did not execute. Resolve its business error and recheck authorization before a new attempt."
    elif state.value["phase"] == "PREPARED":
        output["next"] = "Preview only. Compare the exact effect with authorized intent before commit."
    return output


def prepare(client, args, quote=False):
    command = "CREATE_QUOTE" if quote else args.command
    if not quote and command == "CREATE_QUOTE":
        fail("USE_QUOTE", "CREATE_QUOTE is single-stage; use the quote subcommand.")
    with State(args.state).locked() as state:
        input_value = object_json(args.input)
        expected = {"propertyId": client.property_id, **input_value}
        if state.value:
            validate_context(state, client)
            if (state.value["commandType"] != command or state.value["input"] != expected
                    or state.value["operation"] != ("quote" if quote else "command")):
                fail("STATE_REQUEST_MISMATCH", "Existing state belongs to another request; never overwrite an uncertain attempt.")
            if args.readback is not None and args.readback != state.value.get("readbackPath"):
                fail("STATE_REQUEST_MISMATCH", "Existing readback target differs.")
            if quote or state.value["phase"] not in ("NEW", "PREVIEW_UNKNOWN"):
                return finish(state, client)
        else:
            state.value = new_state(client, command, input_value, args.readback, "quote" if quote else "command")
        state.value["phase"] = "UNKNOWN" if quote else "PREVIEW_UNKNOWN"
        state.save()  # Durable identities exist before sending any request.
        response = client.request("POST", "/api/v1/quotes" if quote else "/api/v1/command-previews",
                                  payload=state.value["input"] if quote else {"commandType": command, "input": state.value["input"]},
                                  key=state.value["confirmKey"] if quote else state.value["previewKey"],
                                  correlation=state.value["correlationId"])
        if quote:
            body = response.get("data")
            state.value["quote"] = body.get("quote") if isinstance(body, dict) else None
            formal_response = {**response, "data": body.get("receipt") if isinstance(body, dict) else None}
            record_receipt(state, formal_response)
            output = finish(state, client, response)
            output["quote"] = state.value["quote"]
            output["next"] = "Quotation is not a booking. Use CREATE_ORDER only within the user's authorized intent."
            return output
        data = response.get("data")
        preview = data.get("preview") if isinstance(data, dict) else None
        receipt = data.get("receipt") if isinstance(data, dict) else None
        if (response.get("ok") and isinstance(preview, dict) and isinstance(receipt, dict)
                and preview.get("commandType") == command and preview.get("previewId")
                and re.fullmatch(r"[a-f0-9]{64}", str(preview.get("effectHash", "")))
                and isinstance(preview.get("effect"), dict)
                and receipt.get("commandType") == "PREVIEW:" + command
                and receipt.get("executionStatus") == "EXECUTED" and receipt.get("businessCommitted") is True
                and isinstance(receipt.get("result"), dict)
                and receipt["result"].get("preview", {}).get("previewId") == preview["previewId"]):
            state.value.update(phase="PREPARED", preview=preview, previewReceipt=receipt)
        state.value["lastResponse"] = response
        state.save()
        output = result_envelope(state, response)
        output["next"] = ("Preview only: compare its effect with the user's authorization and obtain only missing business confirmations before commit."
                          if state.value["phase"] == "PREPARED" else
                          "No validated preview. Read the error; for a lost response retry prepare with this state and identical input.")
        return output


def commit(client, args):
    with State(args.state).locked() as state:
        validate_context(state, client)
        if state.value["operation"] != "command":
            fail("SINGLE_STAGE_QUOTE", "Quotation has no confirmation step.")
        if state.value["phase"] in ("COMMITTED", "NOT_EXECUTED", "UNKNOWN"):
            return finish(state, client)
        if state.value["phase"] != "PREPARED":
            fail("PREVIEW_REQUIRED", "No validated preview exists. Retry prepare with the original state and identical input.")
        if not args.confirmed:
            fail("BUSINESS_CONFIRMATION_REQUIRED", "Review the effect and obtain any missing business confirmation before --confirmed.")
        reason = object_json(args.reason)
        reject_secrets(reason, client.token)
        if set(reason) != {"code", "note"} or not isinstance(reason["code"], str) or not reason["code"].strip() or not isinstance(reason["note"], str):
            fail("INVALID_REASON", "Supply the command's exact {code, note} reason contract.")
        if args.readback:
            safe_path(args.readback)
            reject_secrets(args.readback, client.token)
            if state.value.get("readbackPath") not in (None, args.readback):
                fail("STATE_REQUEST_MISMATCH", "Readback differs from the prepared target.")
            state.value["readbackPath"] = args.readback
        prepared = state.value["preview"]
        payload = {"propertyId": state.value["propertyId"], "commandType": state.value["commandType"],
                   "confirmation": True, "expectedEffectHash": prepared["effectHash"], "reason": reason}
        state.value.update(phase="UNKNOWN", confirmation=payload)
        state.save()
        response = client.request("POST", "/api/v1/command-previews/" + urllib.parse.quote(prepared["previewId"], safe="") + "/confirm",
                                  payload=payload, key=state.value["confirmKey"], correlation=state.value["correlationId"])
        record_receipt(state, response)
        return finish(state, client, response)


def recover(client, args, resolve=False):
    with State(args.state).locked() as state:
        validate_context(state, client)
        if state.value["phase"] in ("COMMITTED", "NOT_EXECUTED"):
            return finish(state, client)
        if state.value["phase"] in ("NEW", "PREVIEW_UNKNOWN", "PREPARED"):
            fail("NO_FORMAL_ATTEMPT", "No formal submission was sent. Preview recovery uses prepare with identical input and state.")
        identity = {"propertyId": state.value["propertyId"], "commandType": state.value["commandType"],
                    "idempotencyKey": state.value["confirmKey"]}
        if resolve:
            response = client.request("POST", "/api/v1/command-results/resolve", payload=identity,
                                      key=state.value["resolveKey"], correlation=state.value["correlationId"])
        else:
            response = client.request("GET", "/api/v1/command-results", query=identity)
        record_receipt(state, response)
        return finish(state, client, response)


def select_fields(value, fields):
    tree = {}
    for field in fields.split(","):
        cursor = tree
        for part in field.strip().split("."):
            cursor = cursor.setdefault(part, {})
        cursor[""] = True
    def project(item, selected):
        if "" in selected:
            return item
        if isinstance(item, list):
            return [project(child, selected) for child in item]
        if isinstance(item, dict):
            return {key: project(item[key], subtree) for key, subtree in selected.items() if key in item}
        return None
    return project(value, tree)


def compact_schema(document, command):
    def expand(value):
        if isinstance(value, dict) and "$ref" in value:
            ref = value["$ref"]
            if not ref.startswith("#/"):
                fail("EXTERNAL_SCHEMA_REF", "External schema references are not fetched automatically.")
            value = document
            for part in ref[2:].split("/"):
                value = value[part.replace("~1", "/").replace("~0", "~")]
        return value
    def matches(schema):
        schema = expand(schema)
        return schema.get("const") == command or command in schema.get("enum", []) or any(matches(item) for item in schema.get("anyOf", []) + schema.get("oneOf", []))
    def choose(schema):
        schema = expand(schema)
        if "commandType" in schema.get("properties", {}) and matches(schema["properties"]["commandType"]):
            return [schema]
        return [found for branch in schema.get("anyOf", []) + schema.get("oneOf", []) for found in choose(branch)]
    paths = document.get("paths", {})
    create_path = "/api/v1/quotes" if command == "CREATE_QUOTE" else "/api/v1/command-previews"
    operation = paths[create_path]["post"]
    body = expand(operation["requestBody"])["content"]["application/json"]["schema"]
    inputs = [expand(body)] if command == "CREATE_QUOTE" else choose(body)
    if not inputs:
        fail("COMMAND_NOT_IN_SCHEMA", "Command is not present in the live public request schema.")
    output = {"commandType": command, "path": create_path, "description": operation.get("description"), "requestSchemas": inputs}
    if command != "CREATE_QUOTE":
        confirm_path = next(path for path in paths if path.startswith("/api/v1/command-previews/") and path.endswith("/confirm"))
        confirm = paths[confirm_path]["post"]
        output["confirmation"] = {"path": confirm_path, "description": confirm.get("description"),
                                  "requestSchemas": choose(expand(confirm["requestBody"])["content"]["application/json"]["schema"])}
    # Include only component definitions referenced by selected input/confirmation schemas.
    definitions = {}
    def collect(value):
        if isinstance(value, dict):
            ref = value.get("$ref")
            if ref and ref not in definitions:
                definitions[ref] = expand(value)
                collect(definitions[ref])
            for key, child in value.items():
                if key != "$ref":
                    collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)
    collect(output)
    if definitions:
        output["referencedSchemas"] = definitions
    return output


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--version", action="version", version=VERSION)
    commands = root.add_subparsers(dest="action", required=True)
    commands.add_parser("me", help="Read current API identity and permissions.")
    query = commands.add_parser("get", help="Read a relative API path; optional fields prune response data.")
    query.add_argument("path")
    query.add_argument("--query", default="{}")
    query.add_argument("--fields")
    schema = commands.add_parser("schema", help="Show one command's current request and confirmation schemas.")
    schema.add_argument("command")
    for name in ("prepare", "quote"):
        item = commands.add_parser(name, help="Create a preview only." if name == "prepare" else "Create a single-stage quotation, never a booking.")
        if name == "prepare":
            item.add_argument("command")
        item.add_argument("--input", required=True, help="JSON object; propertyId defaults to the configured property.")
        item.add_argument("--state", required=True, help="Private per-attempt JSON file; reuse it with identical input to recover.")
        item.add_argument("--readback")
    item = commands.add_parser("commit", help="Submit an authorized preview once, then optionally read its business target.")
    item.add_argument("--state", required=True)
    item.add_argument("--reason", required=True, help="Exact JSON {code,note} required by this command.")
    item.add_argument("--confirmed", action="store_true", help="Assert that user intent covers the exact effect and required business facts.")
    item.add_argument("--readback")
    for name in ("recover", "resolve"):
        item = commands.add_parser(name, help="Read the original outcome." if name == "recover" else "Explicitly resolve/fence the original unknown attempt; never submit its business again.")
        item.add_argument("--state", required=True)
    return root


def run(args, client):
    if args.action == "me":
        return client.request("GET", "/api/v1/me")
    if args.action == "get":
        result = client.request("GET", args.path, query=object_json(args.query))
        if args.fields and "data" in result:
            result["data"] = select_fields(result["data"], args.fields)
        return result
    if args.action == "schema":
        result = client.request("GET", "/api/v1/openapi.json")
        if result.get("ok"):
            result["data"] = compact_schema(result["data"], args.command)
        return result
    if args.action in ("prepare", "quote"):
        return prepare(client, args, quote=args.action == "quote")
    if args.action == "commit":
        return commit(client, args)
    return recover(client, args, resolve=args.action == "resolve")


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        client = Client()
        output = run(args, client)
        print(json.dumps(scrub(output, client.token), ensure_ascii=False, indent=2))
        return 0 if output.get("ok", output.get("phase") in ("PREPARED", "COMMITTED")) else 2
    except ClientError as error:
        print(json.dumps({"ok": False, "error": {"code": error.code, "message": error.message}}, ensure_ascii=False))
        return 2
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"ok": False, "error": {"code": "CLIENT_FAILURE", "message": "Client could not complete. Preserve state; inspect configuration or the live contract without printing credentials."}}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
