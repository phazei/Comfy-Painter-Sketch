"""
tests/test_cleanup.py -- Unit tests for nodes/cleanup.py (file cleanup helpers).

Uses a temporary directory for the input subfolder and the user directory.
Run with:  python -m unittest tests.test_cleanup   (from repo root)
"""

import json
import os
import sys
import tempfile
import time
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from nodes.cleanup import (
    MIN_AGE_SECONDS,
    extract_references,
    file_stats,
    find_candidates,
    parse_referenced,
    run_cleanup,
    scan_workflow_references,
)

OLD = time.time() - MIN_AGE_SECONDS - 3600
A = "ps-abcd1234-0123456789abcd.webp"
B = "ps-abcd1234-00000000000001.png"
C = "ps-zz99-ff.webp"


class ExtractReferencesTest(unittest.TestCase):
    """The raw-text reference pattern (shared with ui/src/cleanup/references.ts)."""

    def test_plain_and_double_encoded(self) -> None:
        manifest = json.dumps({"layers": [{"file": f"painter-sketch/{A} [input]"}]})
        workflow = json.dumps({"nodes": [{"widgets_values": [manifest]}]})
        self.assertEqual(extract_references(workflow), {A})

    def test_separators_and_case(self) -> None:
        text = f'painter-sketch\\/{A} painter-sketch\\\\{B} PAINTER-SKETCH%2F{C.upper()}'
        self.assertEqual(extract_references(text), {A, B, C})

    def test_ignores_other_names(self) -> None:
        text = f"{A} other/{B} painter-sketch/ps-x-y.webp painter-sketch/ps-a-1.jpg"
        self.assertEqual(extract_references(text), set())


class ParseReferencedTest(unittest.TestCase):
    """Validation of the request''s ``referenced`` field."""

    def test_accepts_names_and_text(self) -> None:
        self.assertEqual(parse_referenced([A.upper(), f"painter-sketch/{B} [input]", "junk"]), {A, B})

    def test_rejects_bad_input(self) -> None:
        self.assertIsNone(parse_referenced("x"))
        self.assertIsNone(parse_referenced([1]))
        self.assertIsNone(parse_referenced(["x" * 5000]))
        self.assertIsNone(parse_referenced(["a"] * 100_001))


class CleanupTest(unittest.TestCase):
    """Candidate filtering, workflow scan and deletion against a temp tree."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        self.folder = os.path.join(root, "input", "painter-sketch")
        self.user_dir = os.path.join(root, "user")
        os.makedirs(self.folder)
        os.makedirs(os.path.join(self.user_dir, "default", "workflows", "sub"))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _file(self, name: str, size: int = 10, mtime: float = OLD) -> str:
        path = os.path.join(self.folder, name)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        os.utime(path, (mtime, mtime))
        return path

    def _workflow(self, rel: str, text: str) -> None:
        with open(os.path.join(self.user_dir, "default", rel), "w", encoding="utf-8") as f:
            f.write(text)

    def test_candidates_filter_name_age_and_type(self) -> None:
        self._file(A)
        self._file(B, mtime=time.time())  # too new
        self._file("ps-abcd-12 (1).png")  # upload rename
        self._file("ps-ABCD-12.png")  # upper case
        self._file("other.png")
        os.makedirs(os.path.join(self.folder, "ps-dir-12.png"))
        self.assertEqual([c.name for c in find_candidates(self.folder, time.time())], [A])

    def test_missing_folder(self) -> None:
        self.assertEqual(find_candidates(os.path.join(self.folder, "nope"), time.time()), [])

    def test_symlink_is_not_a_candidate(self) -> None:
        target = self._file(A)
        link = os.path.join(self.folder, B)
        try:
            os.symlink(target, link)
        except OSError:
            self.skipTest("symlinks not permitted")
        self.assertEqual([c.name for c in find_candidates(self.folder, time.time())], [A])

    def test_scan_workflows_recursive_and_broken(self) -> None:
        self._workflow("workflows/a.json", f'{{"x": "painter-sketch/{A} [input]"')  # broken JSON
        self._workflow("workflows/sub/b.json", f"painter-sketch/{B}")
        self._workflow("workflows/c.txt", f"painter-sketch/{C}")  # not JSON: ignored
        names, errors = scan_workflow_references(self.user_dir)
        self.assertEqual(names, {A, B})
        self.assertEqual(errors, [])

    def test_dry_run_then_delete(self) -> None:
        self._file(A, size=100)
        self._file(B, size=20)
        self._file(C, size=5)
        self._workflow("workflows/w.json", f"painter-sketch/{A} [input]")

        dry = run_cleanup(self.folder, self.user_dir, {C}, dry_run=True)
        self.assertEqual(dry["count"], 1)
        self.assertEqual(dry["bytes"], 20)
        # all/old stats must be present in dry-run response
        self.assertIn("all", dry)
        self.assertIn("old", dry)
        self.assertTrue(os.path.exists(os.path.join(self.folder, B)))

        real = run_cleanup(self.folder, self.user_dir, {C}, dry_run=False)
        self.assertEqual(real["count"], 1)
        self.assertEqual(real["bytes"], 20)
        self.assertEqual(real["deleted"], [B])
        self.assertIn("all", real)
        self.assertIn("old", real)
        self.assertEqual(sorted(os.listdir(self.folder)), sorted([A, C]))

    def test_recently_touched_file_is_kept_on_real_run(self) -> None:
        self._file(B, mtime=time.time())
        self.assertEqual(run_cleanup(self.folder, self.user_dir, set(), dry_run=False)["count"], 0)
        self.assertTrue(os.path.exists(os.path.join(self.folder, B)))


class FileStatsTest(unittest.TestCase):
    """Stats helper: count and size split by age."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = os.path.join(self._tmp.name, "painter-sketch")
        os.makedirs(self.folder)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _file(self, name: str, size: int = 10, mtime: float = OLD) -> str:
        path = os.path.join(self.folder, name)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        os.utime(path, (mtime, mtime))
        return path

    def test_empty_folder(self) -> None:
        result = file_stats(self.folder, time.time())
        self.assertEqual(result, {"all": {"count": 0, "bytes": 0}, "old": {"count": 0, "bytes": 0}})

    def test_missing_folder(self) -> None:
        result = file_stats(os.path.join(self.folder, "nope"), time.time())
        self.assertEqual(result, {"all": {"count": 0, "bytes": 0}, "old": {"count": 0, "bytes": 0}})

    def test_all_and_old_counts(self) -> None:
        self._file(A, size=100)         # old
        self._file(B, size=20, mtime=time.time())  # recent (all, not old)
        result = file_stats(self.folder, time.time())
        self.assertEqual(result["all"]["count"], 2)
        self.assertEqual(result["all"]["bytes"], 120)
        self.assertEqual(result["old"]["count"], 1)
        self.assertEqual(result["old"]["bytes"], 100)

    def test_ignores_non_candidates(self) -> None:
        """Files that do not match CANDIDATE_RE are excluded."""
        self._file("other.png", size=50)
        self._file("ps-abcd-12 (1).png", size=50)  # space in name: no match
        result = file_stats(self.folder, time.time())
        self.assertEqual(result["all"]["count"], 0)

    def test_ignores_directories(self) -> None:
        """Directories with candidate-looking names are excluded."""
        os.makedirs(os.path.join(self.folder, A))
        result = file_stats(self.folder, time.time())
        self.assertEqual(result["all"]["count"], 0)

    def test_symlinks_excluded(self) -> None:
        """Symlinks are not counted even if the name matches."""
        target = self._file(A, size=10)
        link = os.path.join(self.folder, B)
        try:
            os.symlink(target, link)
        except OSError:
            self.skipTest("symlinks not permitted")
        result = file_stats(self.folder, time.time())
        # Only the real file (A) should be counted.
        self.assertEqual(result["all"]["count"], 1)


if __name__ == "__main__":
    unittest.main()
