"""Offline subprocess retry contracts, invoked by pipeline-health-github.test.mjs."""
import errno
import importlib.util
from pathlib import Path
import subprocess
import unittest


spec = importlib.util.spec_from_file_location(
    "github_read", Path(__file__).resolve().parents[1] / "src/adapters/health/github-read.py"
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class GithubReadRetryTest(unittest.TestCase):
    def invoke(self, kind, outcomes):
        self.calls = []
        self.delays = []
        remaining = iter(outcomes)

        def run(command, **options):
            self.calls.append((command, options))
            self.assertEqual(options["timeout"], 5)
            self.assertEqual(options["env"], {"GH_TOKEN": "fixture-token"})
            result = next(remaining)
            if isinstance(result, BaseException):
                raise result
            return result

        return bridge.run_gh(["gh", "pr", kind], {"GH_TOKEN": "fixture-token"},
                             kind, run=run, sleep=self.delays.append)

    def test_transient_errors_recover_for_every_read_kind(self):
        for kind in ("list", "state", "checks"):
            for diagnostic in ("net/http: TLS handshake timeout", "HTTP 503",
                               "connection reset", "early EOF", "EAI_AGAIN"):
                with self.subTest(kind=kind, diagnostic=diagnostic):
                    failure = subprocess.CompletedProcess([], 1, "", diagnostic)
                    success = subprocess.CompletedProcess([], 0, "[]", "")
                    self.assertIs(self.invoke(kind, [failure, failure, success]), success)
                    self.assertEqual(len(self.calls), 3)
                    self.assertEqual(self.delays, [0.1, 0.25])

    def test_timeouts_and_temporary_spawn_failures_recover(self):
        for error in (subprocess.TimeoutExpired("gh", 5), OSError(errno.EAGAIN, "busy")):
            success = subprocess.CompletedProcess([], 0, "[]", "")
            self.assertIs(self.invoke("list", [error, success]), success)
            self.assertEqual(len(self.calls), 2)
            self.assertEqual(self.delays, [0.1])

    def test_exhausted_transient_failures_are_sanitized_and_bounded(self):
        for error in (subprocess.CompletedProcess([], 1, "", "TLS handshake timeout secret-marker"),
                      subprocess.TimeoutExpired("gh", 5), OSError(errno.EMFILE, "secret-marker")):
            with self.assertRaisesRegex(ValueError, "^github read failed$"):
                self.invoke("list", [error] * 3)
            self.assertEqual(len(self.calls), 3)
            self.assertEqual(self.delays, [0.1, 0.25])

    def test_permanent_errors_do_not_retry(self):
        for error in (subprocess.CompletedProcess([], 1, "", "HTTP 401 Bad credentials"),
                      subprocess.CompletedProcess([], 1, "", "HTTP 403 forbidden"),
                      subprocess.CompletedProcess([], 1, "", "unknown flag"),
                      OSError(errno.ENOENT, "missing gh")):
            with self.assertRaisesRegex(ValueError, "^github read failed$"):
                self.invoke("state", [error])
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(self.delays, [])

    def test_failed_and_pending_checks_data_are_successful_reads(self):
        for status in (1, 8):
            for data in ('[]', '[{"name":"CI","state":"FAILURE","bucket":"fail"}]'):
                result = subprocess.CompletedProcess([], status, data, "")
                self.assertIs(self.invoke("checks", [result]), result)
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(self.delays, [])

    def test_malformed_checks_without_transient_error_do_not_retry(self):
        for data in ("", "{}", "invalid JSON"):
            with self.assertRaisesRegex(ValueError, "^github read failed$"):
                self.invoke("checks", [subprocess.CompletedProcess([], 1, data, "")])
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(self.delays, [])

    def test_outer_deadline_cancellation_never_retries(self):
        with self.assertRaisesRegex(TimeoutError, "collector deadline"):
            self.invoke("list", [TimeoutError("collector deadline")])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.delays, [])


if __name__ == "__main__":
    unittest.main()
