"""Offline protocol tests: no real PMS, credentials, model calls or business writes."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "greenpms.py"
spec = importlib.util.spec_from_file_location("greenpms", SCRIPT)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
ENV = {"GREENPMS_BASE_URL": "https://pms.invalid", "GREENPMS_API_TOKEN": "test-secret-never-output",
       "GREENPMS_PROPERTY_ID": "property_test"}


def receipt(command="CHECK_OUT", status="EXECUTED"):
    return {"receiptId": "receipt_formal", "commandId": "command_formal", "commandType": command,
            "executionStatus": status, "businessCommitted": status == "EXECUTED",
            "result": {"orderId": "order_test", "status": "CHECKED_OUT"} if status == "EXECUTED" else None,
            "resourceRefs": ["order_test"], "factRefs": []}


def preview():
    return {"preview": {"previewId": "preview_test", "commandType": "CHECK_OUT", "effectHash": "a" * 64,
                        "effect": {"orderId": "order_test", "toStatus": "CHECKED_OUT"}},
            "receipt": {**receipt("PREVIEW:CHECK_OUT"), "receiptId": "receipt_preview", "commandId": "command_preview",
                        "result": {"preview": {"previewId": "preview_test"}}}}


class Response:
    def __init__(self, data, code=200):
        self.code = code
        self.raw = json.dumps(data).encode() if not isinstance(data, bytes) else data

    def read(self, limit):
        return self.raw[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None


class Opener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.responses:
            raise AssertionError("Unexpected HTTP call")
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = str(Path(self.temp.name) / "attempt.json")

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, opener, *args, environment=None):
        return cli.run(cli.parser().parse_args(args), cli.Client(environment or ENV, opener))

    def prepare(self, opener=None, readback=True):
        args = ["prepare", "CHECK_OUT", "--input", '{"orderId":"order_test"}', "--state", self.state]
        if readback:
            args += ["--readback", "/api/v1/orders/{result.orderId}"]
        return self.invoke(opener or Opener(Response(preview())), *args)

    def commit(self, opener, confirmed=True):
        args = ["commit", "--state", self.state, "--reason", '{"code":"CHECK_OUT","note":"Guest checkout authorized"}']
        if confirmed:
            args.append("--confirmed")
        return self.invoke(opener, *args)

    def load(self):
        return json.loads(Path(self.state).read_text())

    def test_preview_is_not_business_success_and_repeated_prepare_does_not_start_another_flow(self):
        result = self.prepare()
        self.assertEqual(result["phase"], "PREPARED")
        self.assertFalse(result["businessVerified"])
        self.assertEqual(result["previewReceipt"]["commandType"], "PREVIEW:CHECK_OUT")
        before = self.load()
        self.prepare(Opener())
        self.assertEqual(self.load(), before)
        self.assertEqual(stat.S_IMODE(Path(self.state).stat().st_mode), 0o600)
        self.assertNotIn(ENV["GREENPMS_API_TOKEN"], Path(self.state).read_text())

    def test_commit_uses_exact_hash_and_scoped_property_then_reads_business_once(self):
        self.prepare()
        opener = Opener(Response(receipt()), Response({"order": {"id": "order_test", "status": "CHECKED_OUT"},
                                                     "stay": {"status": "COMPLETED"}}))
        result = self.commit(opener)
        self.assertEqual(result["phase"], "COMMITTED")
        self.assertFalse(result["businessVerified"])
        self.assertTrue(result["readback"]["ok"])
        request = opener.requests[0][0]
        payload = json.loads(request.data)
        self.assertEqual(payload["propertyId"], "property_test")  # PreviewDto has no propertyId.
        self.assertEqual(payload["expectedEffectHash"], "a" * 64)
        self.assertEqual(request.get_header("Idempotency-key"), self.load()["confirmKey"])
        self.assertTrue(opener.requests[1][0].full_url.endswith("/api/v1/orders/order_test"))
        replay = Opener(Response({"order": {"id": "order_test", "status": "CHECKED_OUT"}}))
        self.commit(replay)
        self.assertEqual([req.get_method() for req, _ in replay.requests], ["GET"])

    def test_commit_requires_effect_confirmation_without_a_post(self):
        self.prepare()
        with self.assertRaises(cli.ClientError) as error:
            self.commit(Opener(), confirmed=False)
        self.assertEqual(error.exception.code, "BUSINESS_CONFIRMATION_REQUIRED")
        self.assertEqual(self.load()["phase"], "PREPARED")

    def test_lost_confirm_response_preserves_original_identity_and_never_reposts(self):
        self.prepare()
        original = self.load()
        output = self.commit(Opener(TimeoutError("secret " + ENV["GREENPMS_API_TOKEN"])))
        self.assertEqual(output["phase"], "UNKNOWN")
        self.assertNotIn(ENV["GREENPMS_API_TOKEN"], json.dumps(output))
        self.commit(Opener())
        recovery = Opener(Response(receipt()), Response({"order": {"status": "CHECKED_OUT"}}))
        recovered = self.invoke(recovery, "recover", "--state", self.state)
        self.assertEqual(recovered["phase"], "COMMITTED")
        self.assertEqual(recovery.requests[0][0].get_method(), "GET")
        self.assertIn(original["confirmKey"], recovery.requests[0][0].full_url)
        self.assertNotIn(original["previewKey"], recovery.requests[0][0].full_url)

    def test_explicit_resolve_uses_own_key_and_original_identity_then_closes_attempt(self):
        self.prepare(readback=False)
        self.commit(Opener(TimeoutError()))
        saved = self.load()
        unknown = self.invoke(Opener(Response({"executionStatus": "UNKNOWN", "businessCommitted": False})),
                              "recover", "--state", self.state)
        self.assertEqual(unknown["phase"], "UNKNOWN")
        resolver = Opener(Response(receipt(status="NOT_EXECUTED")))
        output = self.invoke(resolver, "resolve", "--state", self.state)
        self.assertEqual(output["phase"], "NOT_EXECUTED")
        request = resolver.requests[0][0]
        self.assertEqual(request.get_header("Idempotency-key"), saved["resolveKey"])
        self.assertEqual(json.loads(request.data)["idempotencyKey"], saved["confirmKey"])
        self.commit(Opener())

    def test_misidentified_receipt_never_reports_formal_success(self):
        self.prepare()
        output = self.commit(Opener(Response(receipt("PREVIEW:CHECK_OUT"))))
        self.assertEqual(output["phase"], "UNKNOWN")
        self.assertEqual(output["response"]["clientError"]["code"], "RECEIPT_IDENTITY_MISMATCH")
        self.assertNotIn("receipt", self.load())

    def test_wrong_order_receipt_stays_unknown_without_reading_the_other_order(self):
        self.prepare()
        original = self.load()
        wrong = receipt()
        wrong["result"]["orderId"] = "another_guests_order"
        opener = Opener(Response(wrong))
        output = self.commit(opener)
        self.assertEqual(output["phase"], "UNKNOWN")
        self.assertEqual(output["response"]["clientError"]["code"], "TARGET_IDENTITY_MISMATCH")
        self.assertNotIn("receipt", self.load())
        self.assertNotIn("readback", output)
        self.assertEqual(len(opener.requests), 1)
        self.commit(Opener())  # Uncertain identity never permits another POST.
        recovery = Opener(Response(wrong))
        recovered = self.invoke(recovery, "recover", "--state", self.state)
        self.assertEqual(recovered["phase"], "UNKNOWN")
        self.assertNotIn("readback", recovered)
        self.assertIn(original["confirmKey"], recovery.requests[0][0].full_url)

    def test_conversion_can_return_new_membership_ids_for_the_same_existing_targets(self):
        command = "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
        prepared = preview()
        prepared["preview"]["commandType"] = command
        prepared["receipt"]["commandType"] = "PREVIEW:" + command
        self.invoke(Opener(Response(prepared)), "prepare", command,
                    "--input", '{"orderId":"order_test","memberId":"member_test"}', "--state", self.state)
        converted = receipt(command)
        converted["result"].update({"memberId": "member_test", "membershipOrderId": "new_membership",
                                    "entitlementLotId": "new_lot", "factId": "new_fact"})
        result = self.invoke(Opener(Response(converted)), "commit", "--state", self.state, "--confirmed",
                             "--reason", '{"code":"STAFF_CORRECTION","note":"Conversion authorized"}')
        self.assertEqual(result["phase"], "COMMITTED")
        self.assertEqual(result["receipt"]["result"]["membershipOrderId"], "new_membership")

    def test_missing_or_empty_formal_result_remains_unknown(self):
        for index, invalid in enumerate((None, [], {}, "missing")):
            with self.subTest(result=invalid):
                self.state = str(Path(self.temp.name) / f"invalid-result-{index}.json")
                self.prepare()
                broken = receipt()
                if invalid == "missing":
                    broken.pop("result")
                else:
                    broken["result"] = invalid
                result = self.commit(Opener(Response(broken)))
                self.assertEqual(result["phase"], "UNKNOWN")
                self.assertNotIn("receipt", self.load())
                self.assertNotIn("readback", result)

    def test_incomplete_http_response_keeps_attempt_unknown_without_partial_body_leak(self):
        self.prepare()
        original = self.load()
        for error in (http.client.IncompleteRead(ENV["GREENPMS_API_TOKEN"].encode(), 200),
                      http.client.BadStatusLine(ENV["GREENPMS_API_TOKEN"])):
            with self.subTest(exception=type(error).__name__):
                if self.load()["phase"] == "PREPARED":
                    result = self.commit(Opener(error))
                else:
                    result = self.invoke(Opener(error), "recover", "--state", self.state)
                self.assertEqual(result["phase"], "UNKNOWN")
                self.assertEqual(result["response"]["error"]["code"], "TRANSPORT_UNCERTAIN")
                self.assertEqual(self.load()["confirmKey"], original["confirmKey"])
                self.assertNotIn(ENV["GREENPMS_API_TOKEN"], json.dumps(result))
                self.assertNotIn(ENV["GREENPMS_API_TOKEN"], Path(self.state).read_text())
        self.commit(Opener())

    def test_total_deadline_interrupts_continuously_progressing_body_and_restores_timer(self):
        self.prepare()
        class SlowBody(Response):
            chunks = 0
            def read(self, limit):
                # Progress occurs much more often than the socket timeout, but
                # the total response time still exceeds the one-second deadline.
                for _ in range(30):
                    time.sleep(0.1)
                    self.chunks += 1
                return super().read(limit)
        slow = SlowBody(receipt())
        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)
        observed = []
        handler = lambda _signum, _frame: observed.append(True)
        try:
            signal.signal(signal.SIGALRM, handler)
            signal.setitimer(signal.ITIMER_REAL, 10, 4)
            result = self.invoke(Opener(slow), "commit", "--state", self.state, "--confirmed",
                                 "--reason", '{"code":"CHECK_OUT","note":"Confirmed checkout"}',
                                 environment={**ENV, "GREENPMS_HTTP_TIMEOUT_SECONDS": "1"})
            self.assertEqual(result["phase"], "UNKNOWN")
            self.assertEqual(result["response"]["error"]["code"], "TRANSPORT_UNCERTAIN")
            self.assertLess(slow.chunks, 30)
            self.assertIs(signal.getsignal(signal.SIGALRM), handler)
            remaining, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertGreater(remaining, 7)
            self.assertLess(remaining, 10)
            self.assertEqual(interval, 4)
            self.assertEqual(observed, [])
            self.assertNotIn(ENV["GREENPMS_API_TOKEN"], json.dumps(result))
            self.assertEqual(self.load()["phase"], "UNKNOWN")
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)

    def test_nonmain_thread_fails_before_http_instead_of_losing_deadline(self):
        opener = Opener(Response({"subjectId": "subject_test"}))
        errors = []
        def worker():
            try:
                cli.Client(ENV, opener).request("GET", "/api/v1/me")
            except cli.ClientError as error:
                errors.append(error.code)
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ["DEADLINE_REQUIRES_MAIN_THREAD"])
        self.assertEqual(opener.requests, [])

    def test_earlier_process_alarm_is_preserved_without_sending_http(self):
        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)
        handler = lambda _signum, _frame: None
        opener = Opener(Response({"subjectId": "subject_test"}))
        try:
            signal.signal(signal.SIGALRM, handler)
            signal.setitimer(signal.ITIMER_REAL, 5, 2)
            with self.assertRaises(cli.ClientError) as error:
                cli.Client(ENV, opener).request("GET", "/api/v1/me")
            self.assertEqual(error.exception.code, "DEADLINE_CONFLICT")
            self.assertEqual(opener.requests, [])
            self.assertIs(signal.getsignal(signal.SIGALRM), handler)
            remaining, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertGreater(remaining, 4)
            self.assertEqual(interval, 2)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)

    def test_preview_timeout_reuses_preview_key_and_original_input(self):
        first = Opener(urllib.error.URLError("credential " + ENV["GREENPMS_API_TOKEN"]))
        output = self.prepare(first)
        self.assertEqual(output["phase"], "PREVIEW_UNKNOWN")
        second = Opener(Response(preview()))
        self.prepare(second)
        self.assertEqual(first.requests[0][0].get_header("Idempotency-key"), second.requests[0][0].get_header("Idempotency-key"))
        self.assertEqual(first.requests[0][0].data, second.requests[0][0].data)
        with self.assertRaises(cli.ClientError) as error:
            self.invoke(Opener(), "prepare", "CHECK_OUT", "--input", '{"orderId":"other_order"}', "--state", self.state)
        self.assertEqual(error.exception.code, "STATE_REQUEST_MISMATCH")

    def test_context_change_rejected_before_http(self):
        self.prepare()
        for changed in ({"GREENPMS_PROPERTY_ID": "other"}, {"GREENPMS_BASE_URL": "https://other.invalid"},
                        {"GREENPMS_API_TOKEN": "another-credential"}):
            with self.assertRaises(cli.ClientError) as error:
                self.invoke(Opener(), "recover", "--state", self.state, environment={**ENV, **changed})
            self.assertEqual(error.exception.code, "STATE_CONTEXT_MISMATCH")

    def test_symlink_public_state_and_concurrent_state_are_rejected(self):
        target = Path(self.temp.name) / "target"
        target.write_text("preserve")
        Path(self.state).symlink_to(target)
        with self.assertRaises(cli.ClientError):
            self.prepare()
        self.assertEqual(target.read_text(), "preserve")
        Path(self.state).unlink()
        self.prepare()
        os.chmod(self.state, 0o644)
        with self.assertRaises(cli.ClientError):
            self.commit(Opener())
        os.chmod(self.state, 0o600)
        with cli.State(self.state).locked():
            with self.assertRaises(cli.ClientError) as error:
                self.commit(Opener())
            self.assertEqual(error.exception.code, "STATE_BUSY")

    def test_redirect_and_error_payload_never_expose_credentials(self):
        client = cli.Client(ENV, Opener(Response(b"ignored", 302)))
        output = client.request("GET", "/api/v1/me")
        self.assertEqual(output["error"]["code"], "REDIRECT_REJECTED")
        self.assertIsNone(cli.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid"))
        error = urllib.error.HTTPError("https://pms.invalid", 403, ENV["GREENPMS_API_TOKEN"], {},
                                       io.BytesIO(json.dumps({"message": ENV["GREENPMS_API_TOKEN"], "authorization": "hidden"}).encode()))
        output = cli.Client(ENV, Opener(error)).request("GET", "/api/v1/me")
        self.assertNotIn(ENV["GREENPMS_API_TOKEN"], json.dumps(output))
        self.assertEqual(output["data"]["authorization"], "<redacted>")

    def test_unsafe_urls_and_credential_inputs_rejected(self):
        for path in ("https://evil.invalid/api/v1/me", "//evil.invalid/api/v1/me", "/api/v1/../auth", "/api/v1/%2e%2e/auth"):
            with self.assertRaises(cli.ClientError):
                cli.Client(ENV, Opener()).request("GET", path)
        for value in ({"tokenSecret": "new-secret"}, {"nested": {"note": ENV["GREENPMS_API_TOKEN"]}}):
            with self.assertRaises(cli.ClientError):
                self.invoke(Opener(), "prepare", "CHECK_OUT", "--input", json.dumps(value), "--state", self.state)
        self.assertFalse(Path(self.state).exists())
        with self.assertRaises(cli.ClientError):
            self.invoke(Opener(), "prepare", "CHECK_OUT", "--input", '{"orderId":"order_test"}', "--state", self.state,
                        "--readback", "/api/v1/orders/" + ENV["GREENPMS_API_TOKEN"])
        self.assertFalse(Path(self.state).exists())

    def test_credential_keys_and_encoded_paths_or_queries_are_rejected_before_http(self):
        token = ENV["GREENPMS_API_TOKEN"]
        encoded = "".join("%{:02X}".format(ord(char)) for char in token)
        for value in ({token: "value"}, {"nested": {encoded: "value"}}, {"note": encoded}):
            with self.subTest(input=value), self.assertRaises(cli.ClientError) as error:
                self.invoke(Opener(), "prepare", "CHECK_OUT", "--input", json.dumps(value), "--state", self.state)
            self.assertEqual(error.exception.code, "CREDENTIAL_INPUT_REJECTED")
            self.assertFalse(Path(self.state).exists())
        for path, query in (("/api/v1/orders/" + encoded, {}), ("/api/v1/orders", {encoded: "value"}),
                            ("/api/v1/orders", {"search": encoded})):
            with self.subTest(path=path, query=query), self.assertRaises(cli.ClientError) as error:
                cli.Client(ENV, Opener()).request("GET", path, query=query)
            self.assertEqual(error.exception.code, "CREDENTIAL_INPUT_REJECTED")

    def test_raw_and_encoded_credential_response_keys_and_values_never_reach_output_or_state(self):
        token = ENV["GREENPMS_API_TOKEN"]
        encoded = "".join("%{:02X}".format(ord(char)) for char in token)
        echoed = preview()
        echoed["preview"]["effect"].update({token: "raw key", "nested": {encoded: "encoded key"},
                                           "note": "echo=" + encoded})
        output = self.prepare(Opener(Response(echoed)))
        self.assertEqual(output["phase"], "PREPARED")
        for serialized in (json.dumps(output), Path(self.state).read_text()):
            self.assertNotIn(token, serialized)
            self.assertNotIn(encoded, serialized)
            self.assertIn("<redacted>", serialized)

    def test_invalid_preview_receipt_never_enables_confirmation(self):
        wrong = preview()
        wrong["receipt"]["result"]["preview"]["previewId"] = "another_preview"
        output = self.prepare(Opener(Response(wrong)))
        self.assertEqual(output["phase"], "PREVIEW_UNKNOWN")
        with self.assertRaises(cli.ClientError) as error:
            self.commit(Opener())
        self.assertEqual(error.exception.code, "PREVIEW_REQUIRED")

    def test_quote_is_single_stage_and_recovery_is_not_booking(self):
        quote = {"quoteId": "quote_test", "propertyId": "property_test"}
        quoted_receipt = {**receipt("CREATE_QUOTE"), "result": {"quote": quote}}
        opener = Opener(Response({"quote": quote, "receipt": quoted_receipt}))
        output = self.invoke(opener, "quote", "--input", '{"inventoryUnitId":"room_test"}', "--state", self.state)
        self.assertEqual(output["quote"], quote)
        self.assertEqual(output["commandType"], "CREATE_QUOTE")
        self.assertFalse(output["businessVerified"])
        self.assertTrue(opener.requests[0][0].full_url.endswith("/api/v1/quotes"))
        repeated = self.invoke(Opener(), "quote", "--input", '{"inventoryUnitId":"room_test"}', "--state", self.state)
        self.assertEqual(repeated["quote"], quote)
        with self.assertRaises(cli.ClientError):
            self.commit(Opener())

    def test_readback_failure_keeps_committed_receipt_without_resubmission(self):
        self.prepare()
        result = self.commit(Opener(Response(receipt()), Response({"code": "INTERNAL_ERROR"}, 500)))
        self.assertEqual(result["phase"], "COMMITTED")
        self.assertFalse(result["readback"]["ok"])
        self.assertEqual(self.load()["receipt"]["receiptId"], "receipt_formal")
        self.assertFalse(result["businessVerified"])

    def test_fields_projection_prunes_nested_guest_details(self):
        data = {"orders": [{"id": "order_test", "guest": {"nickname": "guest", "phone": "private"}}], "nextCursor": None}
        self.assertEqual(cli.select_fields(data, "orders.id,orders.guest.nickname,nextCursor"),
                         {"orders": [{"id": "order_test", "guest": {"nickname": "guest"}}], "nextCursor": None})

    def test_schema_output_contains_only_requested_command_and_no_response_union(self):
        selected = {"type": "object", "properties": {"commandType": {"const": "CHECK_OUT"}, "input": {"$ref": "#/components/schemas/Input"}}}
        unrelated = {"type": "object", "properties": {"commandType": {"const": "ISSUE_TOKEN"}, "input": {"type": "object"}}}
        document = {"components": {"schemas": {"Input": {"type": "object", "properties": {"orderId": {"type": "string"}}}}}, "paths": {}}
        for path in ("/api/v1/command-previews", "/api/v1/command-previews/{previewId}/confirm"):
            document["paths"][path] = {"post": {"requestBody": {"content": {"application/json": {"schema": {"anyOf": [selected, unrelated]}}}},
                                                "responses": {"200": {"large": "response union"}}}}
        output = cli.compact_schema(document, "CHECK_OUT")
        self.assertNotIn("ISSUE_TOKEN", json.dumps(output))
        self.assertNotIn("response union", json.dumps(output))
        self.assertIn("#/components/schemas/Input", output["referencedSchemas"])

    def test_main_does_not_print_credential_bearing_exceptions(self):
        with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(cli, "run", side_effect=ValueError(ENV["GREENPMS_API_TOKEN"])):
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                self.assertEqual(cli.main(["me"]), 2)
            self.assertNotIn(ENV["GREENPMS_API_TOKEN"], stream.getvalue())


if __name__ == "__main__":
    unittest.main()
