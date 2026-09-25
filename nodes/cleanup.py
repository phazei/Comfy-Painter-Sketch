"""
nodes/cleanup.py -- Find and delete unreferenced PainterSketch layer files.

Layer files accumulate in ``input/painter-sketch/`` by design: every edit
uploads new content-hashed names, and older workflow versions / graph undo may
still point at old ones (see SPEC "Saved-file contract" -> Cleanup).  The
settings button (``PainterSketch.Cleanup``) calls ``POST /painter-sketch/cleanup``
(``cleanup_route.py``), which uses the helpers here.

A file is deletable only if all of these hold:
  * it sits directly in the folder, is a regular file and not a symlink,
  * its name matches :data:`CANDIDATE_RE` (what the frontend writes),
  * its mtime is older than :data:`MIN_AGE_SECONDS`,
  * its name is not referenced by any saved workflow / subgraph blueprint JSON
    under any user directory, nor by the references the frontend sent (open
    tabs, current graph, local drafts).

References are found by scanning raw text with :data:`REFERENCE_RE` (no JSON
parsing): fast, tolerant of broken files, and it also sees names inside the
double-encoded manifest string.  The frontend uses the same pattern
(``ui/src/cleanup/references.ts``); keep them in sync.

Pure stdlib, no ComfyUI imports, so it is unit-testable (``tests/test_cleanup.py``).
"""

import logging
import os
import re
import stat
import time
from dataclasses import dataclass

log = logging.getLogger("paintersketch.cleanup")

SUBFOLDER = "painter-sketch"
"""Subfolder of the ComfyUI input directory that holds our layer files."""

CANDIDATE_RE = re.compile(r"^ps-[a-z0-9]+-[0-9a-f]+\.(?:png|webp)$")
"""Exact file names the frontend writes (``contentHash.ts`` ``layerFileName``)."""

REFERENCE_RE = re.compile(
    r"painter-sketch(?:[\\/]|%2f){1,8}(ps-[a-z0-9]+-[0-9a-f]+\.(?:png|webp))",
    re.IGNORECASE,
)
"""A layer file reference inside arbitrary text (plain, JSON-escaped or URL-encoded separator)."""

BARE_NAME_RE = re.compile(r"ps-[a-z0-9]+-[0-9a-f]+\.(?:png|webp)", re.IGNORECASE)
"""A bare layer file name, as sent by the frontend in ``referenced``."""

MIN_AGE_SECONDS = 24 * 60 * 60
"""Files modified more recently than this are never deleted."""

MAX_SCAN_BYTES = 50 * 1024 * 1024
"""Workflow files larger than this are skipped (reported in ``errors``)."""

MAX_REFERENCED = 100_000
"""Maximum number of entries accepted in the request``s ``referenced`` list."""

MAX_REFERENCE_LENGTH = 4096
"""Maximum length of one ``referenced`` entry."""

WORKFLOW_SUBDIRS = ("workflows", "subgraphs")
"""Per-user folders holding saved workflow JSON (subgraph blueprints may contain our nodes too)."""


@dataclass(frozen=True)
class Candidate:
    """A file that may be deleted if unreferenced.

    Attributes:
        name: File name (no directory).
        path: Absolute path.
        size: Size in bytes.
    """

    name: str
    path: str
    size: int


# ── Reference extraction ─────────────────────────────────────────────────────


def extract_references(text: str) -> set[str]:
    """Find every layer file name referenced in ``text``.

    Args:
        text: Raw text (workflow JSON, a widget value, ...).

    Returns:
        Lower-cased file names (no directory).
    """
    return {m.group(1).lower() for m in REFERENCE_RE.finditer(text)}


def parse_referenced(value: object) -> set[str] | None:
    """Validate the request''s ``referenced`` list.

    Oversized input is rejected rather than truncated: dropping references
    could delete files that are still in use.

    Args:
        value: The ``referenced`` field of the request body.

    Returns:
        Lower-cased file names, or ``None`` when the value is invalid.
    """
    if not isinstance(value, list) or len(value) > MAX_REFERENCED:
        return None
    names: set[str] = set()
    for item in value:
        if not isinstance(item, str) or len(item) > MAX_REFERENCE_LENGTH:
            return None
        if BARE_NAME_RE.fullmatch(item):
            names.add(item.lower())
        else:
            names |= extract_references(item)
    return names


def scan_workflow_references(user_dir: str) -> tuple[set[str], list[str]]:
    """Collect references from every user''s saved workflow JSON files.

    Layout (``app/user_manager.py``): ``<user_dir>/<user>/workflows/**/*.json``;
    subgraph blueprints live in ``<user>/subgraphs/``.  Directory symlinks are
    not followed.

    Args:
        user_dir: ``folder_paths.get_user_directory()``.

    Returns:
        ``(names, errors)``: lower-cased referenced names, and one message per
        file that was skipped (too large or unreadable).
    """
    names: set[str] = set()
    errors: list[str] = []
    if not os.path.isdir(user_dir):
        return names, errors
    for user in os.scandir(user_dir):
        if not user.is_dir(follow_symlinks=False):
            continue
        for sub in WORKFLOW_SUBDIRS:
            for root, _dirs, files in os.walk(os.path.join(user.path, sub)):
                for file in files:
                    if file.lower().endswith(".json"):
                        _scan_file(os.path.join(root, file), names, errors)
    return names, errors


def _scan_file(path: str, names: set[str], errors: list[str]) -> None:
    """Add the references in one file to ``names``; record a skip in ``errors``."""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            if os.fstat(f.fileno()).st_size > MAX_SCAN_BYTES:
                errors.append(f"skipped workflow (over 50 MB): {path}")
                log.warning("Cleanup: skipped workflow over 50 MB: %s", path)
                return
            names |= extract_references(f.read())
    except OSError as e:
        errors.append(f"unreadable workflow: {path} ({e.strerror or e})")
        log.warning("Cleanup: could not read workflow %s: %s", path, e)


# ── Candidates ───────────────────────────────────────────────────────────────


def find_candidates(folder: str, now: float, min_age: float = MIN_AGE_SECONDS) -> list[Candidate]:
    """List deletable-by-name-and-age files directly inside ``folder``.

    Args:
        folder: ``<input>/painter-sketch``.
        now: Current time (``time.time()``).
        min_age: Minimum age in seconds (mtime).

    Returns:
        Candidates, sorted by name.  Empty if the folder is missing.
    """
    if not os.path.isdir(folder):
        return []
    found: list[Candidate] = []
    for entry in os.scandir(folder):
        if not CANDIDATE_RE.match(entry.name) or entry.is_symlink() or not entry.is_file(follow_symlinks=False):
            continue
        st = entry.stat(follow_symlinks=False)
        if now - st.st_mtime > min_age:
            found.append(Candidate(entry.name, entry.path, st.st_size))
    return sorted(found, key=lambda c: c.name)


def file_stats(folder: str, now: float, min_age: float = MIN_AGE_SECONDS) -> dict:
    """Count and size all candidate files in ``folder``, split by age.

    Does not scan workflows or check references -- just reports what is there.
    Regular files only, no symlinks.

    Args:
        folder: ``<input>/painter-sketch``.
        now: Current time (``time.time()``).
        min_age: Age threshold in seconds; files older than this are ``old``.

    Returns:
        ``{"all": {"count": int, "bytes": int}, "old": {"count": int, "bytes": int}}``.
        Both counters are 0 when the folder is missing.
    """
    all_count = 0
    all_bytes = 0
    old_count = 0
    old_bytes = 0
    if os.path.isdir(folder):
        for entry in os.scandir(folder):
            if not CANDIDATE_RE.match(entry.name) or entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                continue
            st = entry.stat(follow_symlinks=False)
            all_count += 1
            all_bytes += st.st_size
            if now - st.st_mtime > min_age:
                old_count += 1
                old_bytes += st.st_size
    return {
        "all": {"count": all_count, "bytes": all_bytes},
        "old": {"count": old_count, "bytes": old_bytes},
    }


def is_linked_folder(folder: str) -> bool:
    """Whether ``folder`` itself is a symlink or junction.

    The input directory may legitimately be a link (shared model folders);
    only our own subfolder is checked.

    Args:
        folder: ``<input>/painter-sketch``.

    Returns:
        ``True`` if the folder resolves somewhere other than inside its parent.
    """
    parent = os.path.dirname(os.path.abspath(folder))
    expected = os.path.join(os.path.realpath(parent), os.path.basename(folder))
    return os.path.normcase(os.path.realpath(folder)) != os.path.normcase(expected)


def _still_deletable(candidate: Candidate, now: float, min_age: float) -> bool:
    """Re-check a candidate right before unlinking (it may have been re-uploaded)."""
    try:
        st = os.lstat(candidate.path)
    except FileNotFoundError:
        return False
    return stat.S_ISREG(st.st_mode) and now - st.st_mtime > min_age


# ── Cleanup ──────────────────────────────────────────────────────────────────


def run_cleanup(
    folder: str,
    user_dir: str,
    referenced: set[str],
    dry_run: bool,
    now: float | None = None,
    min_age: float = MIN_AGE_SECONDS,
) -> dict:
    """Count (dry run) or delete unreferenced layer files.

    Args:
        folder: ``<input>/painter-sketch``.
        user_dir: ComfyUI user directory (saved workflows are scanned here).
        referenced: Lower-cased names the client reported as in use.
        dry_run: Only count; delete nothing.
        now: Current time; defaults to ``time.time()``.
        min_age: Minimum file age in seconds.

    Returns:
        ``{"count", "bytes", "all", "old", "errors"?}`` plus ``"deleted"``
        (names) on a real run.  ``all`` and ``old`` are always included (same
        shape as the stats-mode response) so the UI can refresh after cleanup.
        Dry run: what would be deleted.  Real run: what was deleted.
    """
    now = time.time() if now is None else now
    stats = file_stats(folder, now, min_age)
    if is_linked_folder(folder):
        result: dict = {"count": 0, "bytes": 0, "errors": [f"{SUBFOLDER}/ is a symlink or junction; cleanup refuses to run"]}
        result.update(stats)
        return result
    saved, errors = scan_workflow_references(user_dir)
    keep = saved | referenced
    unused = [c for c in find_candidates(folder, now, min_age) if c.name.lower() not in keep]

    if dry_run:
        result = {"count": len(unused), "bytes": sum(c.size for c in unused)}
    else:
        deleted: list[Candidate] = []
        for c in unused:
            if not _still_deletable(c, time.time(), min_age):
                continue
            try:
                os.unlink(c.path)
                deleted.append(c)
            except OSError as e:
                errors.append(f"could not delete {c.name} ({e.strerror or e})")
                log.warning("Cleanup: could not delete %s: %s", c.path, e)
        result = {"count": len(deleted), "bytes": sum(c.size for c in deleted), "deleted": [c.name for c in deleted]}
        log.info(
            "Cleanup: deleted %d unused files (%.1f MB) from input/%s/, %d errors",
            len(deleted), result["bytes"] / 1e6, SUBFOLDER, len(errors),
        )
    result.update(stats)
    if errors:
        result["errors"] = errors
    return result
