"""Audit recoverable geometry in legacy SVG-only Canvas Prompt exports.

Early exports retained a single anchor point per stroke, yet their final canvas
SVG sometimes retains one transformed outline for each stroke.  An outline can
help a reviewer locate a mark, but it is not the original pen trajectory: it
does not preserve sampling order, duration, pressure, or a reliable direction.
This module therefore exposes only a narrow quality signal and never returns a
relation, arrow, or semantic interpretation.
"""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any


SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,"
MATRIX_RE = re.compile(
    r'transform="matrix\(1,\s*0,\s*0,\s*1,\s*([^,]+),\s*([^\)]+)\)"'
)
PATH_RE = re.compile(r"<path\b")


def _number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _svg_text(package: dict[str, Any]) -> str | None:
    final = (package.get("canvas_snapshot") or {}).get("final")
    url = final.get("url") if isinstance(final, dict) else None
    if not isinstance(url, str) or not url.startswith(SVG_DATA_URL_PREFIX):
        return None
    try:
        return base64.b64decode(url[len(SVG_DATA_URL_PREFIX):], validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return None


def _anchors(strokes: list[Any]) -> list[tuple[float, float]]:
    anchors = []
    for stroke in strokes:
        if not isinstance(stroke, dict):
            continue
        points = stroke.get("points") or []
        # Only legacy one-point records can be associated safely with SVG
        # outline groups.  A multi-point record is already the authoritative
        # ordered trajectory and must not be replaced by rendered geometry.
        if len(points) != 1 or not isinstance(points[0], dict):
            return []
        x, y = _number(points[0].get("x")), _number(points[0].get("y"))
        if x is None or y is None:
            return []
        anchors.append((x, y))
    return anchors


def inspect_legacy_svg_outline(package: dict[str, Any]) -> dict[str, Any]:
    """Return an explicit legacy-outline quality report.

    ``recoverable`` is intentionally stricter than "an SVG exists": every
    legacy stroke anchor must map one-to-one to an SVG transform group.  The
    result never upgrades ``supports_ordered_trajectory``.
    """
    strokes = package.get("strokes") or []
    svg = _svg_text(package)
    if not svg:
        return {
            "status": "unavailable",
            "source": "final_canvas_svg",
            "supports_outline_observations": False,
            "supports_ordered_trajectory": False,
        }

    groups = []
    for match in MATRIX_RE.finditer(svg):
        x, y = _number(match.group(1)), _number(match.group(2))
        if x is not None and y is not None:
            groups.append((x, y))
    anchors = _anchors(strokes)
    # Browser SVG formatting rounds transforms differently from JSON points.
    # Use a tiny, consumed matching tolerance rather than decimal-string
    # equality; consuming groups keeps duplicate anchors one-to-one.
    unmatched_groups = list(groups)
    matched_count = 0
    for anchor_x, anchor_y in anchors:
        match_index = next(
            (
                index
                for index, (group_x, group_y) in enumerate(unmatched_groups)
                if (group_x - anchor_x) ** 2 + (group_y - anchor_y) ** 2 <= 0.02 ** 2
            ),
            None,
        )
        if match_index is not None:
            unmatched_groups.pop(match_index)
            matched_count += 1
    recoverable = bool(anchors) and len(anchors) == len(groups) and matched_count == len(anchors)
    return {
        "status": "recoverable" if recoverable else "ambiguous",
        "source": "final_canvas_svg",
        "stroke_anchor_count": len(anchors),
        "outline_group_count": len(groups),
        "outline_path_count": len(PATH_RE.findall(svg)),
        "matched_anchor_count": matched_count,
        "strict_one_to_one_anchor_mapping": recoverable,
        "supports_outline_observations": recoverable,
        "supports_ordered_trajectory": False,
    }

