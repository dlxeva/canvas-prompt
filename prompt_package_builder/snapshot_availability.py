"""Conservative availability checks for exported canvas snapshots.

The browser export remains the source of truth.  This module only answers
whether a bounded snapshot reference can support a visual claim; it never
rewrites the raw snapshot or reads image bytes into a model-facing package.
"""

from __future__ import annotations

import base64
import binascii
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


SNAPSHOT_STATES = frozenset({"available", "unknown", "degraded", "unavailable", "conflicting"})

_SNAPSHOT_FIELDS = frozenset({
    "availability",
    "archive_path",
    "archive_relative_path",
    "content_type",
    "format",
    "height",
    "inline_payload_excluded",
    "note",
    "requires_external_materialization",
    "snapshot_path",
    "url",
    "width",
})
_ARCHIVE_FIELDS = ("archive_relative_path", "archive_path", "snapshot_path")


def _nonempty_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _existing_file(path: Path) -> bool:
    try:
        with path.open("rb") as source:
            return _image_header(source.read(32))
    except OSError:
        return False


def _image_header(data: bytes) -> bool:
    # Cheap format checks reject empty/text placeholders. Image decoding and
    # visual interpretation still belong to the actual visual reader.
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return len(data) >= 24 and data[12:16] == b"IHDR" and int.from_bytes(data[16:20], "big") > 0 and int.from_bytes(data[20:24], "big") > 0
    return data.startswith((b"\xff\xd8\xff", b"GIF87a", b"GIF89a")) or (len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP")


def _archive_file(value: Any, archive_root: Path | str | None) -> bool:
    raw = _nonempty_string(value)
    if raw is None:
        return False
    parsed = urlparse(raw)
    if parsed.scheme == "file":
        if parsed.netloc not in {"", "localhost"}:
            return False
        raw = unquote(parsed.path)
    elif parsed.scheme:
        return False

    candidate = Path(raw)
    if archive_root is None:
        return False
    try:
        root = Path(archive_root).resolve()
        resolved = (root / candidate).resolve()
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return False
    return _existing_file(resolved)


def _valid_data_url(value: str) -> bool:
    if not value.casefold().startswith("data:image/"):
        return False
    header, separator, payload = value.partition(",")
    if not separator or not header.casefold().endswith(";base64"):
        return False
    try:
        return _image_header(base64.b64decode(payload, validate=True))
    except (binascii.Error, ValueError):
        return False


def _url_reference_available(value: Any, archive_root: Path | str | None) -> tuple[bool, bool]:
    """Return ``(available, declared_local_reference)`` for one URL value."""
    raw = _nonempty_string(value)
    if raw is None:
        return False, False
    if _valid_data_url(raw):
        return True, False

    parsed = urlparse(raw)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        # A URL is a locator, not evidence that image bytes can be read. The
        # local compiler does not fetch remote data or assume its availability.
        return False, False
    if parsed.scheme == "file" or not parsed.scheme:
        return _archive_file(raw, archive_root), True
    # A malformed data/blob/other scheme is still an explicit reference.  Do
    # not let the stable default archive filename rescue it accidentally.
    return False, True


def _archive_reference_available(value: dict[str, Any], archive_root: Path | str | None) -> tuple[bool, bool]:
    declared = False
    for key in _ARCHIVE_FIELDS:
        raw = _nonempty_string(value.get(key))
        if raw is None:
            continue
        declared = True
        if _archive_file(raw, archive_root):
            return True, True
    return False, declared


def _reference_available(value: dict[str, Any], archive_root: Path | str | None) -> bool:
    url_available, _ = _url_reference_available(value.get("url"), archive_root)
    if url_available:
        return True

    archive_available, _ = _archive_reference_available(value, archive_root)
    if archive_available:
        return True
    return False


def _inline_payload_marker(value: dict[str, Any]) -> bool:
    return value.get("inline_payload_excluded") is True and value.get("requires_external_materialization") is True


def _unverified_reference(value: dict[str, Any]) -> bool:
    raw = _nonempty_string(value.get("url"))
    parsed = urlparse(raw) if raw else None
    return _inline_payload_marker(value) or bool(parsed and parsed.scheme in {"http", "https"} and parsed.netloc)


def _snapshot_state(value: Any, archive_root: Path | str | None) -> str | None:
    if not isinstance(value, dict) or not value:
        return None

    nested_state = _snapshot_state(value.get("final"), archive_root) if isinstance(value.get("final"), dict) else None
    has_direct_fields = any(key in value for key in _SNAPSHOT_FIELDS)
    direct_state: str | None = None

    if "availability" in value:
        availability = value.get("availability")
        if not isinstance(availability, str):
            direct_state = "unavailable"
        else:
            normalized = availability.strip().casefold()
            if normalized not in SNAPSHOT_STATES:
                direct_state = "unavailable"
            elif normalized == "available":
                # An optimistic marker without a live reference is only
                # metadata.  This covers empty URLs and stale archive records.
                direct_state = "available" if _reference_available(value, archive_root) else "unknown" if _unverified_reference(value) else "unavailable"
            else:
                direct_state = normalized

    if direct_state is None:
        note = value.get("note")
        if isinstance(note, str) and note.strip().casefold() == "snapshot not found":
            direct_state = "unavailable"

    if direct_state is None and _reference_available(value, archive_root):
        direct_state = "available"

    if direct_state is None and _unverified_reference(value):
        direct_state = "unknown"

    if direct_state is None and has_direct_fields:
        direct_state = "unavailable"

    if direct_state is None:
        return nested_state
    if nested_state is None or direct_state == nested_state:
        return direct_state
    # Parent and nested records disagree.  Preserve the disagreement without
    # letting a nested available value open the visual-claim gate.
    return "conflicting"


def snapshot_availability(value: Any, archive_root: Path | str | None = None) -> str:
    """Return one stable state, defaulting missing/empty values to unavailable."""
    return _snapshot_state(value, archive_root) or "unavailable"


def snapshot_is_available(value: Any, archive_root: Path | str | None = None) -> bool:
    return snapshot_availability(value, archive_root) == "available"
