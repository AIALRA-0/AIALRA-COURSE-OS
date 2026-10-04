#!/usr/bin/env python3
"""Conservative framed-slide inspection and raster/text extraction for Course OS."""

from __future__ import annotations

import base64
import binascii
import ctypes
import hashlib
import importlib.metadata
import json
import math
import re
import struct
import sys
import unicodedata
import zlib
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c


PLAN_VERSION = "framed-slides-v1"
PYPDFIUM2_VERSION = "4.30.0"
RENDER_SCALE = 2
REGION_PADDING_PT = 1.0
MAX_INPUT_BYTES = 250_000_000
MAX_REQUEST_BYTES = 262_144
MAX_PAGES = 2_500
MAX_PAGE_DIMENSION_PT = 14_400
MAX_SCAN_CHARS = 120_000
MAX_OUTPUT_TEXT_CHARS = 50_000
MAX_PAGE_PIXELS = 32_000_000
MAX_PREVIEW_EDGE = 512
MAX_PREVIEWS = 6


class HandoutError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class RectPath:
    object_index: int
    raw_bounds: tuple[float, float, float, float]
    visible_frame: bool


@dataclass
class Frame:
    box: tuple[float, float, float, float]  # display points, top-left origin
    object_ids: set[int] = field(default_factory=set)
    has_visible_frame: bool = False


@dataclass
class PageAnalysis:
    physical_page: int
    width: float
    height: float
    rotation: int
    frames: list[Frame]
    pairs: dict[str, list[dict[str, Any]]]
    page_border_ids: set[int]


def _finite_rect(values: tuple[float, float, float, float]) -> bool:
    return (
        all(math.isfinite(value) for value in values)
        and values[2] > values[0]
        and values[3] > values[1]
    )


def _object_bounds(obj: Any) -> tuple[float, float, float, float] | None:
    values = [ctypes.c_float() for _ in range(4)]
    if not pdfium_c.FPDFPageObj_GetBounds(
        obj.raw, *(ctypes.byref(value) for value in values)
    ):
        return None
    bounds = tuple(float(value.value) for value in values)
    return bounds if _finite_rect(bounds) else None


def _path_visible_frame(obj: Any) -> bool:
    fill_mode, stroke = ctypes.c_int(), ctypes.c_int()
    if not pdfium_c.FPDFPath_GetDrawMode(
        obj.raw, ctypes.byref(fill_mode), ctypes.byref(stroke)
    ):
        return False
    if stroke.value:
        width = ctypes.c_float()
        color = [ctypes.c_uint() for _ in range(4)]
        if (
            pdfium_c.FPDFPageObj_GetStrokeWidth(obj.raw, ctypes.byref(width))
            and width.value > 0
            and pdfium_c.FPDFPageObj_GetStrokeColor(
                obj.raw, *(ctypes.byref(channel) for channel in color)
            )
            and color[3].value > 0
        ):
            return True
    if fill_mode.value:
        color = [ctypes.c_uint() for _ in range(4)]
        if (
            pdfium_c.FPDFPageObj_GetFillColor(
                obj.raw, *(ctypes.byref(channel) for channel in color)
            )
            and color[3].value > 0
        ):
            # A white page-fill rectangle is not a visible slide frame by itself.
            return any(channel.value < 248 for channel in color[:3])
    return False


def _closed_rect_path(
    obj: Any, object_index: int, page_size: tuple[float, float]
) -> RectPath | None:
    if obj.type != pdfium_c.FPDF_PAGEOBJ_PATH:
        return None
    count = int(pdfium_c.FPDFPath_CountSegments(obj.raw))
    if count != 5:
        return None
    segments = [pdfium_c.FPDFPath_GetPathSegment(obj.raw, i) for i in range(count)]
    if (
        pdfium_c.FPDFPathSegment_GetType(segments[0])
        != pdfium_c.FPDF_SEGMENT_MOVETO
        or not pdfium_c.FPDFPathSegment_GetClose(segments[-1])
        or any(
            pdfium_c.FPDFPathSegment_GetType(segment)
            != pdfium_c.FPDF_SEGMENT_LINETO
            for segment in segments[1:]
        )
    ):
        return None

    points: list[tuple[float, float]] = []
    for segment in segments:
        x, y = ctypes.c_float(), ctypes.c_float()
        if not pdfium_c.FPDFPathSegment_GetPoint(
            segment, ctypes.byref(x), ctypes.byref(y)
        ):
            return None
        points.append((float(x.value), float(y.value)))

    matrix = obj.get_matrix()
    points = [
        (
            matrix.a * x + matrix.c * y + matrix.e,
            matrix.b * x + matrix.d * y + matrix.f,
        )
        for x, y in points
    ]
    tolerance = max(0.75, max(page_size) * 0.001)
    if math.dist(points[0], points[-1]) > tolerance:
        return None
    horizontal: list[bool] = []
    for index in range(4):
        x0, y0 = points[index]
        x1, y1 = points[index + 1]
        dx, dy = abs(x1 - x0), abs(y1 - y0)
        if (dx <= tolerance and dy <= tolerance) or (
            dx > tolerance and dy > tolerance
        ):
            return None
        horizontal.append(dy <= tolerance)
    if horizontal not in ([True, False, True, False], [False, True, False, True]):
        return None

    geometric = (
        min(point[0] for point in points[:4]),
        min(point[1] for point in points[:4]),
        max(point[0] for point in points[:4]),
        max(point[1] for point in points[:4]),
    )
    bounds = _object_bounds(obj)
    if bounds is None:
        return None
    if max(abs(geometric[i] - bounds[i]) for i in range(4)) > max(
        2.5, max(page_size) * 0.004
    ):
        return None
    return RectPath(object_index, bounds, _path_visible_frame(obj))


def _raw_to_display(
    rect: tuple[float, float, float, float], page_height: float
) -> tuple[float, float, float, float]:
    left, bottom, right, top = rect
    return left, page_height - top, right, page_height - bottom


def _page_border(path: RectPath, width: float, height: float) -> bool:
    left, bottom, right, top = path.raw_bounds
    return (
        right - left >= width * 0.78
        and top - bottom >= height * 0.78
        and left <= width * 0.12
        and bottom <= height * 0.12
        and width - right <= width * 0.12
        and height - top <= height * 0.12
    )


def _candidate_frames(
    paths: list[RectPath], width: float, height: float
) -> tuple[list[Frame], set[int]]:
    border_ids = {
        path.object_index for path in paths if _page_border(path, width, height)
    }
    tolerance = max(3.0, min(width, height) * 0.006)
    clusters: list[Frame] = []
    for path in paths:
        box = _raw_to_display(path.raw_bounds, height)
        frame = next(
            (
                item
                for item in clusters
                if max(abs(box[i] - item.box[i]) for i in range(4)) <= tolerance
            ),
            None,
        )
        if frame is None:
            clusters.append(
                Frame(box, {path.object_index}, path.visible_frame)
            )
        else:
            frame.box = (
                min(frame.box[0], box[0]),
                min(frame.box[1], box[1]),
                max(frame.box[2], box[2]),
                max(frame.box[3], box[3]),
            )
            frame.object_ids.add(path.object_index)
            frame.has_visible_frame |= path.visible_frame

    candidates: list[Frame] = []
    for frame in clusters:
        if not frame.has_visible_frame:
            continue
        left, top, right, bottom = frame.box
        frame_width, frame_height = right - left, bottom - top
        if (
            frame_width < width * 0.40
            or frame_width > width * 0.90
            or frame_height < height * 0.22
            or frame_height > height * 0.76
            or not 0.85 <= frame_width / frame_height <= 2.8
            or left < 0
            or top < 0
            or right > width
            or bottom > height
        ):
            continue
        candidates.append(frame)

    # A boxed chart inside a larger slide frame is content, not a second slide.
    frames: list[Frame] = []
    for frame in candidates:
        left, top, right, bottom = frame.box
        nested = any(
            other is not frame
            and other.box[0] <= left - 3
            and other.box[1] <= top - 3
            and other.box[2] >= right + 3
            and other.box[3] >= bottom + 3
            and (other.box[2] - other.box[0]) * (other.box[3] - other.box[1])
            > (right - left) * (bottom - top) * 1.18
            for other in candidates
        )
        if not nested:
            frames.append(frame)
    return frames, border_ids


def _region_from_frame(
    frame: Frame, width: float, height: float
) -> dict[str, float]:
    left, top, right, bottom = frame.box
    scale = RENDER_SCALE
    x0 = max(0.0, math.floor((left - REGION_PADDING_PT) * scale) / scale)
    y0 = max(0.0, math.floor((top - REGION_PADDING_PT) * scale) / scale)
    x1 = min(width, math.ceil((right + REGION_PADDING_PT) * scale) / scale)
    y1 = min(height, math.ceil((bottom + REGION_PADDING_PT) * scale) / scale)
    return {
        "x": round(x0, 4),
        "y": round(y0, 4),
        "width": round(x1 - x0, 4),
        "height": round(y1 - y0, 4),
    }


def _full_region(width: float, height: float) -> dict[str, float]:
    return {"x": 0.0, "y": 0.0, "width": width, "height": height}


def _regions_for_pair(
    pair: tuple[Frame, Frame], mode: str, width: float, height: float
) -> list[dict[str, float]]:
    frames = list(pair)
    frames.sort(key=lambda item: item.box[1] if mode == "top-bottom" else item.box[0])
    regions = [_region_from_frame(frame, width, height) for frame in frames]
    for order, region in enumerate(regions, start=1):
        region["order"] = order
    return regions


def _frame_pairs(
    frames: list[Frame], width: float, height: float
) -> dict[str, list[tuple[Frame, Frame]]]:
    found: dict[str, list[tuple[Frame, Frame]]] = {
        "top-bottom": [],
        "left-right": [],
    }
    for i, first in enumerate(frames):
        for second in frames[i + 1 :]:
            fleft, ftop, fright, fbottom = first.box
            sleft, stop, sright, sbottom = second.box
            fw, fh = fright - fleft, fbottom - ftop
            sw, sh = sright - sleft, sbottom - stop
            if min(fw, fh, sw, sh) <= 0:
                continue
            if abs(fw - sw) / max(fw, sw) > 0.06:
                continue
            if abs(fh - sh) / max(fh, sh) > 0.06:
                continue

            top_frame, bottom_frame = sorted(
                (first, second), key=lambda item: item.box[1]
            )
            top_box, bottom_box = top_frame.box, bottom_frame.box
            vgap = bottom_box[1] - top_box[3]
            x_alignment = abs(
                (top_box[0] + top_box[2] - bottom_box[0] - bottom_box[2]) / 2
            )
            if (
                vgap >= max(4.0, min(fh, sh) * 0.015)
                and vgap <= min(fh, sh) * 0.40
                and x_alignment <= width * 0.04
                and min(top_box[0], bottom_box[0]) >= width * 0.01
                and max(top_box[2], bottom_box[2]) <= width * 0.99
            ):
                found["top-bottom"].append((top_frame, bottom_frame))

            left_frame, right_frame = sorted(
                (first, second), key=lambda item: item.box[0]
            )
            left_box, right_box = left_frame.box, right_frame.box
            hgap = right_box[0] - left_box[2]
            y_alignment = abs(
                (left_box[1] + left_box[3] - right_box[1] - right_box[3]) / 2
            )
            if (
                hgap >= max(4.0, min(fw, sw) * 0.015)
                and hgap <= min(fw, sw) * 0.40
                and y_alignment <= height * 0.04
                and min(left_box[1], right_box[1]) >= height * 0.01
                and max(left_box[3], right_box[3]) <= height * 0.99
            ):
                found["left-right"].append((left_frame, right_frame))
    return found


def _contains(
    outer: dict[str, float],
    inner: tuple[float, float, float, float],
    tolerance: float = 0.5,
) -> bool:
    left, top, right, bottom = inner
    return (
        left >= outer["x"] - tolerance
        and top >= outer["y"] - tolerance
        and right <= outer["x"] + outer["width"] + tolerance
        and bottom <= outer["y"] + outer["height"] + tolerance
    )


def _intersects(
    outer: dict[str, float], inner: tuple[float, float, float, float]
) -> bool:
    left, top, right, bottom = inner
    return not (
        right <= outer["x"]
        or left >= outer["x"] + outer["width"]
        or bottom <= outer["y"]
        or top >= outer["y"] + outer["height"]
    )


def _visible_path(obj: Any) -> bool:
    return _path_visible_frame(obj)


def _pager_digit(
    text: str, box: tuple[float, float, float, float], width: float, height: float
) -> bool:
    left, top, right, bottom = box
    return (
        len(text) == 1
        and text.isdigit()
        and left >= width * 0.82
        and top >= height * 0.86
        and right <= width
        and bottom <= height
    )


def _single_char_text(text_page: Any, index: int) -> str | None:
    try:
        value = text_page.get_text_range(index, 1, force_this=True)
    except Exception:
        return None
    return value if len(value) == 1 else None


def _check_regions(
    page: Any,
    text_page: Any,
    objects: list[Any],
    regions: list[dict[str, float]],
    excluded_frame_ids: set[int],
    border_ids: set[int],
    closed_paths: dict[int, RectPath],
    width: float,
    height: float,
) -> tuple[bool, str | None]:
    if page.get_rotation() != 0:
        return False, "rotated page is preserved because crop rotation is not normalized"

    for index, obj in enumerate(objects):
        if index in excluded_frame_ids or index in border_ids:
            continue
        bounds = _object_bounds(obj)
        if bounds is None:
            continue
        display = _raw_to_display(bounds, height)
        if index in closed_paths and _page_border(closed_paths[index], width, height):
            continue
        if obj.type == pdfium_c.FPDF_PAGEOBJ_TEXT:
            continue
        if obj.type == pdfium_c.FPDF_PAGEOBJ_PATH and not _visible_path(obj):
            continue
        if sum(_contains(region, display) for region in regions) == 1:
            continue
        if any(_intersects(region, display) for region in regions):
            return False, "a graphic or image crosses a proposed crop boundary"
        return False, "visible page content lies outside the proposed slide frames"

    char_count = int(text_page.count_chars())
    if char_count > MAX_SCAN_CHARS:
        return False, "text exceeds the bounded layout scan limit"

    outside_digits = 0
    char_boxes: list[tuple[float, float, float, float]] = []
    for index in range(char_count):
        raw_box = text_page.get_charbox(index)
        if not raw_box:
            return False, "a text character has no reliable bounding box"
        display = _raw_to_display(tuple(float(value) for value in raw_box), height)
        char_boxes.append(display)
        contained_by = [region for region in regions if _contains(region, display, 0.25)]
        if len(contained_by) == 1:
            continue
        if any(_intersects(region, display) for region in regions):
            return False, "text crosses a proposed crop boundary"
        value = _single_char_text(text_page, index)
        if value is None:
            return False, "PDFium could not classify text outside the proposed frames"
        if not value.strip():
            continue
        if _pager_digit(value, display, width, height):
            outside_digits += 1
            if outside_digits <= 4:
                continue
        return False, "visible text lies outside the proposed slide frames"

    for region in regions:
        has_text = any(_contains(region, box, 0.25) for box in char_boxes)
        has_graphic = False
        for index, obj in enumerate(objects):
            if index in excluded_frame_ids or index in border_ids:
                continue
            if obj.type == pdfium_c.FPDF_PAGEOBJ_TEXT:
                continue
            if obj.type == pdfium_c.FPDF_PAGEOBJ_PATH and not _visible_path(obj):
                continue
            bounds = _object_bounds(obj)
            if bounds and _contains(region, _raw_to_display(bounds, height)):
                has_graphic = True
                break
        if not has_text and not has_graphic:
            return False, "a proposed slide frame has no detectable text or graphics"
    return True, None


def _signature(
    pair: tuple[Frame, Frame], mode: str, width: float, height: float
) -> tuple[Any, ...]:
    frames = sorted(
        pair, key=lambda item: item.box[1] if mode == "top-bottom" else item.box[0]
    )
    values: list[float] = []
    for frame in frames:
        left, top, right, bottom = frame.box
        values.extend(
            (
                round(left / width, 2),
                round(top / height, 2),
                round((right - left) / width, 2),
                round((bottom - top) / height, 2),
            )
        )
    return (mode, *values)


def _frame_matches_signature(
    frame: Frame, signature: tuple[Any, ...], width: float, height: float
) -> bool:
    left, top, right, bottom = frame.box
    values = (
        left / width,
        top / height,
        (right - left) / width,
        (bottom - top) / height,
    )
    return all(
        abs(values[i] - float(signature[i + 1]))
        <= (0.025 if i < 2 else 0.06)
        for i in range(4)
    )


def _analyze_page(page: Any, physical_page: int) -> PageAnalysis:
    width, height = (float(value) for value in page.get_size())
    rotation = int(page.get_rotation())
    if rotation != 0:
        return PageAnalysis(
            physical_page, width, height, rotation, [], {
                "top-bottom": [], "left-right": []
            }, set()
        )

    objects = list(page.get_objects())
    paths = [
        path
        for index, obj in enumerate(objects)
        if (path := _closed_rect_path(obj, index, (width, height))) is not None
    ]
    frames, border_ids = _candidate_frames(paths, width, height)
    candidates = _frame_pairs(frames, width, height)
    text_page = page.get_textpage()
    pairs: dict[str, list[dict[str, Any]]] = {"top-bottom": [], "left-right": []}
    try:
        for mode, combinations in candidates.items():
            for pair in combinations:
                regions = _regions_for_pair(pair, mode, width, height)
                frame_ids = set(pair[0].object_ids) | set(pair[1].object_ids)
                safe, reason = _check_regions(
                    page,
                    text_page,
                    objects,
                    regions,
                    frame_ids,
                    border_ids,
                    {path.object_index: path for path in paths},
                    width,
                    height,
                )
                pairs[mode].append(
                    {
                        "frames": pair,
                        "regions": regions,
                        "frameIds": frame_ids,
                        "safe": safe,
                        "reason": reason,
                        "signature": _signature(pair, mode, width, height),
                    }
                )
    finally:
        text_page.close()
    return PageAnalysis(
        physical_page, width, height, rotation, frames, pairs, border_ids
    )


def _auto_plan(
    analyses: list[PageAnalysis], doc: Any
) -> list[dict[str, Any]]:
    signatures = Counter(
        pair["signature"]
        for analysis in analyses
        for pair_list in analysis.pairs.values()
        for pair in pair_list
    )
    repeated = {signature: count for signature, count in signatures.items() if count >= 2}
    plans: list[dict[str, Any]] = []

    for analysis in analyses:
        mode = "original"
        regions = [_full_region(analysis.width, analysis.height)]
        reason: str | None = None
        options = ["original"]
        if analysis.rotation != 0:
            reason = "rotated page is preserved because crop rotation is not normalized"
        else:
            safe_by_mode = {
                name: [pair for pair in analysis.pairs[name] if pair["safe"]]
                for name in ("top-bottom", "left-right")
            }
            safe_pairs = [pair for values in safe_by_mode.values() for pair in values]
            recurrent = [pair for pair in safe_pairs if pair["signature"] in repeated]
            if len(recurrent) == 1:
                chosen = recurrent[0]
                mode = chosen["signature"][0]
                regions = chosen["regions"]
                reason = "two repeated closed slide frames pass text and graphic boundary checks"
                options.append(mode)
            elif len(recurrent) > 1:
                reason = "multiple repeated frame layouts are possible; preserved original"
                for name in ("top-bottom", "left-right"):
                    if len(safe_by_mode[name]) == 1:
                        options.append(name)
            elif safe_pairs:
                reason = "closed frames are not repeated on another physical page"
                for name in ("top-bottom", "left-right"):
                    if len(safe_by_mode[name]) == 1:
                        options.append(name)
            else:
                reasons = [
                    pair["reason"]
                    for values in analysis.pairs.values()
                    for pair in values
                    if pair["reason"]
                ]
                reason = (
                    reasons[0]
                    if reasons
                    else (
                        "closed frames do not form a safe repeated slide pair"
                        if analysis.frames
                        else "no repeated closed slide frames were found"
                    )
                )

            # Keep a final single slide only when its frame matches a repeated
            # paired-slide template elsewhere in this same source.
            if mode == "original" and not safe_pairs and len(analysis.frames) == 1 and repeated:
                matches = [
                    signature
                    for signature in repeated
                    if _frame_matches_signature(
                        analysis.frames[0], signature,
                        analysis.width, analysis.height
                    )
                ]
                if len(matches) == 1:
                    signature = matches[0]
                    frame = analysis.frames[0]
                    region = _region_from_frame(
                        frame, analysis.width, analysis.height
                    )
                    region["order"] = 1
                    page = doc[analysis.physical_page - 1]
                    text_page = page.get_textpage()
                    objects = list(page.get_objects())
                    paths = {
                        path.object_index: path
                        for index, obj in enumerate(objects)
                        if (path := _closed_rect_path(
                            obj, index, (analysis.width, analysis.height)
                        )) is not None
                    }
                    safe, single_reason = _check_regions(
                        page, text_page, objects, [region],
                        set(frame.object_ids), analysis.page_border_ids,
                        paths, analysis.width, analysis.height
                    )
                    text_page.close()
                    page.close()
                    if safe:
                        mode = str(signature[0])
                        regions = [region]
                        options.append(mode)
                        reason = "one slide frame matches the repeated slide template"
                    else:
                        reason = single_reason

        plans.append(
            {
                "physicalPage": analysis.physical_page,
                "width": analysis.width,
                "height": analysis.height,
                "rotation": analysis.rotation,
                "mode": mode,
                "regions": regions,
                "reason": reason,
                "options": list(dict.fromkeys(options)),
                "analysis": analysis,
            }
        )
    return plans


def _public_page(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "physicalPage": plan["physicalPage"],
        "width": round(plan["width"], 4),
        "height": round(plan["height"], 4),
        "rotation": plan["rotation"],
        "mode": plan["mode"],
        "regions": [
            {
                "x": region["x"],
                "y": region["y"],
                "width": region["width"],
                "height": region["height"],
            }
            for region in plan["regions"]
        ],
        **({"reason": plan["reason"]} if plan.get("reason") else {}),
        "options": plan["options"],
    }


def _request_plan(
    plans: list[dict[str, Any]], request: dict[str, Any]
) -> list[dict[str, Any]]:
    mode = request.get("mode", "auto")
    choices = request.get("choices", {})
    if mode not in ("auto", "original"):
        raise HandoutError("PDF_REQUEST_INVALID", "mode must be 'auto' or 'original'")
    if not isinstance(choices, dict):
        raise HandoutError("PDF_REQUEST_INVALID", "choices must be an object")

    available = {plan["physicalPage"]: plan for plan in plans}
    parsed: dict[int, str] = {}
    for key, value in choices.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            raise HandoutError("PDF_REQUEST_INVALID", "choice keys must be physical page numbers")
        if str(number) != str(key) or number not in available:
            raise HandoutError("PDF_REQUEST_INVALID", f"choice page {key!r} is outside the source")
        if value not in ("original", "top-bottom", "left-right"):
            raise HandoutError("PDF_REQUEST_INVALID", f"unsupported choice for physical page {number}")
        parsed[number] = value

    selected: list[dict[str, Any]] = []
    for auto in plans:
        number = auto["physicalPage"]
        choice = parsed.get(number)
        if choice == "original" or (choice is None and mode == "original"):
            plan = dict(auto)
            plan.update(
                mode="original",
                regions=[_full_region(auto["width"], auto["height"])],
                reason="original physical page retained by the selected mode",
            )
            selected.append(plan)
            continue
        if choice in ("top-bottom", "left-right"):
            analysis: PageAnalysis = auto["analysis"]
            if analysis.rotation != 0:
                raise HandoutError(
                    "PDF_LAYOUT_UNSAFE",
                    f"physical page {number}: rotated page has no normalized crop transform",
                )
            candidates = [
                pair for pair in analysis.pairs[choice] if pair["safe"]
            ]
            if len(candidates) != 1:
                reason = next(
                    (
                        pair["reason"]
                        for pair in analysis.pairs[choice]
                        if pair["reason"]
                    ),
                    "no unique frame pair passed the content boundary checks",
                )
                raise HandoutError(
                    "PDF_LAYOUT_UNSAFE", f"physical page {number}: {reason}"
                )
            plan = dict(auto)
            plan.update(
                mode=choice,
                regions=candidates[0]["regions"],
                reason="safe frame pair selected explicitly",
                options=["original", choice],
            )
            selected.append(plan)
        else:
            selected.append(dict(auto))
    return selected


def _fingerprint(source_hash: str, plans: list[dict[str, Any]]) -> str:
    canonical = {
        "version": PLAN_VERSION,
        "sourceSha256": source_hash,
        "pages": [
            {
                "physicalPage": plan["physicalPage"],
                "mode": plan["mode"],
                "regions": [
                    {
                        "x": round(region["x"], 4),
                        "y": round(region["y"], 4),
                        "width": round(region["width"], 4),
                        "height": round(region["height"], 4),
                        "order": int(region.get("order", 1)),
                    }
                    for region in plan["regions"]
                ],
            }
            for plan in plans
        ],
    }
    payload = json.dumps(
        canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    crc = binascii.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)


def _bitmap_rgb(bitmap: Any) -> bytearray:
    if bitmap.n_channels not in (3, 4) or not bitmap.rev_byteorder:
        raise HandoutError("PDF_RENDER_FAILED", "PDFium returned an unsupported bitmap format")
    source = bytes(bitmap.buffer)
    rgb = bytearray(bitmap.width * bitmap.height * 3)
    target = 0
    for y in range(bitmap.height):
        row_start = y * bitmap.stride
        for x in range(bitmap.width):
            offset = row_start + x * bitmap.n_channels
            rgb[target : target + 3] = source[offset : offset + 3]
            target += 3
    return rgb


def _set_pixel(
    rgb: bytearray, width: int, x: int, y: int, color: tuple[int, int, int]
) -> None:
    offset = (y * width + x) * 3
    rgb[offset : offset + 3] = bytes(color)


def _png_bytes(width: int, height: int, rgb: bytearray) -> bytes:
    if width <= 0 or height <= 0 or len(rgb) != width * height * 3:
        raise HandoutError("PDF_RENDER_FAILED", "invalid raster dimensions")
    scanlines = bytearray((width * 3 + 1) * height)
    src = dst = 0
    for _ in range(height):
        scanlines[dst] = 0
        scanlines[dst + 1 : dst + 1 + width * 3] = rgb[src : src + width * 3]
        src += width * 3
        dst += width * 3 + 1
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(bytes(scanlines), level=6))
        + _png_chunk(b"IEND", b"")
    )


def _render_png(
    page: Any,
    crop: tuple[float, float, float, float] | None,
    scale: float,
    outlines: list[dict[str, float]] | None = None,
) -> bytes:
    kwargs: dict[str, Any] = {
        "scale": scale,
        "rev_byteorder": True,
        "fill_color": (255, 255, 255, 255),
        "optimize_mode": "print",
    }
    if crop is not None:
        kwargs["crop"] = crop
    width, height = page.get_size()
    if crop is None:
        expected_width = math.ceil(width * scale)
        expected_height = math.ceil(height * scale)
    else:
        left, bottom, right, top = crop
        expected_width = (
            math.ceil(width * scale)
            - math.ceil(left * scale)
            - math.ceil(right * scale)
        )
        expected_height = (
            math.ceil(height * scale)
            - math.ceil(bottom * scale)
            - math.ceil(top * scale)
        )
    if (
        expected_width <= 0
        or expected_height <= 0
        or expected_width * expected_height > MAX_PAGE_PIXELS
    ):
        raise HandoutError("PDF_RENDER_LIMIT", "requested raster exceeds the page pixel limit")

    bitmap = page.render(**kwargs)
    try:
        rgb = _bitmap_rgb(bitmap)
        if bitmap.width != expected_width or bitmap.height != expected_height:
            raise HandoutError(
                "PDF_RENDER_FAILED",
                "PDFium crop dimensions did not align with the planned source bounds",
            )
        if outlines:
            for region in outlines:
                x0 = max(0, round(region["x"] / width * bitmap.width))
                y0 = max(0, round(region["y"] / height * bitmap.height))
                x1 = min(
                    bitmap.width - 1,
                    round((region["x"] + region["width"]) / width * bitmap.width),
                )
                y1 = min(
                    bitmap.height - 1,
                    round((region["y"] + region["height"]) / height * bitmap.height),
                )
                for thickness in range(2):
                    yy0, yy1 = min(y0 + thickness, y1), max(y1 - thickness, y0)
                    xx0, xx1 = min(x0 + thickness, x1), max(x1 - thickness, x0)
                    for x in range(xx0, xx1 + 1):
                        _set_pixel(rgb, bitmap.width, x, yy0, (32, 128, 255))
                        _set_pixel(rgb, bitmap.width, x, yy1, (32, 128, 255))
                    for y in range(yy0, yy1 + 1):
                        _set_pixel(rgb, bitmap.width, xx0, y, (32, 128, 255))
                        _set_pixel(rgb, bitmap.width, xx1, y, (32, 128, 255))
        return _png_bytes(bitmap.width, bitmap.height, rgb)
    finally:
        bitmap.close()


def _normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in text.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)[:MAX_OUTPUT_TEXT_CHARS]


def _extract_text(page: Any, region: dict[str, float], rotation: int) -> str:
    text_page = page.get_textpage()
    try:
        count = int(text_page.count_chars())
        if rotation != 0 or count > MAX_SCAN_CHARS:
            text = text_page.get_text_range(
                0, min(count, MAX_OUTPUT_TEXT_CHARS), force_this=True
            )
        else:
            text = text_page.get_text_bounded(
                left=region["x"],
                bottom=page.get_height() - region["y"] - region["height"],
                right=region["x"] + region["width"],
                top=page.get_height() - region["y"],
            )
    finally:
        text_page.close()
    return _normalize_text(text)


def _title(text: str) -> str:
    return next((line.strip()[:240] for line in text.splitlines() if line.strip()), "")


def _source_hash(source: Path) -> str:
    if not source.is_file():
        raise HandoutError("PDF_SOURCE_INVALID", "source PDF does not exist")
    size = source.stat().st_size
    if size <= 0 or size > MAX_INPUT_BYTES:
        raise HandoutError("PDF_INPUT_LIMIT", "source PDF is empty or exceeds the input byte limit")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _preview_pages(plans: list[dict[str, Any]]) -> list[int]:
    if not plans:
        return []
    selected: list[int] = []
    for index in (0, len(plans) // 2, len(plans) - 1):
        number = plans[index]["physicalPage"]
        if number not in selected:
            selected.append(number)
    for plan in plans:
        if plan.get("reason") and plan["options"] != ["original"]:
            if plan["physicalPage"] not in selected:
                selected.append(plan["physicalPage"])
            if len(selected) >= MAX_PREVIEWS:
                break
    return selected[:MAX_PREVIEWS]


def _inspection(
    source_hash: str, plans: list[dict[str, Any]], physical_count: int, doc: Any
) -> dict[str, Any]:
    previews: list[dict[str, Any]] = []
    lookup = {plan["physicalPage"]: plan for plan in plans}
    for number in _preview_pages(plans):
        plan = lookup[number]
        page = doc[number - 1]
        width, height = page.get_size()
        scale = min(0.5, MAX_PREVIEW_EDGE / max(width, height))
        outlines = None
        if plan["rotation"] == 0 and plan["mode"] != "original":
            outlines = plan["regions"]
        elif plan["rotation"] == 0 and plan["options"] != ["original"]:
            analysis: PageAnalysis = plan["analysis"]
            safe_pairs = [
                pair
                for values in analysis.pairs.values()
                for pair in values
                if pair["safe"]
            ]
            if len(safe_pairs) == 1:
                outlines = safe_pairs[0]["regions"]
        image = _render_png(page, None, scale, outlines)
        page.close()
        previews.append(
            {
                "physicalPage": number,
                "imageDataUrl": "data:image/png;base64,"
                + base64.b64encode(image).decode("ascii"),
            }
        )
    return {
        "version": PLAN_VERSION,
        "sourceSha256": source_hash,
        "physicalPageCount": physical_count,
        "logicalPageCount": sum(len(plan["regions"]) for plan in plans),
        "fingerprint": _fingerprint(source_hash, plans),
        "pages": [_public_page(plan) for plan in plans],
        "previews": previews,
    }


def _validate_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise HandoutError("PDF_REQUEST_INVALID", "request must be a JSON object")
    unknown = set(request) - {"purpose", "choices", "mode"}
    if unknown:
        raise HandoutError("PDF_REQUEST_INVALID", "request contains unsupported fields")
    if request.get("purpose") not in ("inspect", "convert"):
        raise HandoutError("PDF_REQUEST_INVALID", "purpose must be 'inspect' or 'convert'")
    return request


def run(source_path: str, request: dict[str, Any], output_dir: str) -> dict[str, Any]:
    request = _validate_request(request)
    try:
        installed = importlib.metadata.version("pypdfium2")
    except importlib.metadata.PackageNotFoundError:
        raise HandoutError("PDF_DEPENDENCY_MISSING", "pypdfium2 is not installed")
    if installed != PYPDFIUM2_VERSION:
        raise HandoutError(
            "PDF_DEPENDENCY_MISMATCH",
            f"expected pypdfium2 {PYPDFIUM2_VERSION}, found {installed}",
        )

    source = Path(source_path)
    source_hash = _source_hash(source)
    try:
        doc = pdfium.PdfDocument(str(source))
    except Exception as error:
        raise HandoutError(
            "PDF_OPEN_FAILED", f"PDFium could not open the source ({type(error).__name__})"
        )
    try:
        count = len(doc)
        if count <= 0 or count > MAX_PAGES:
            raise HandoutError("PDF_PAGE_LIMIT", "source page count is empty or exceeds the page limit")
        analyses: list[PageAnalysis] = []
        for index in range(count):
            page = doc[index]
            width, height = page.get_size()
            if (
                not math.isfinite(width)
                or not math.isfinite(height)
                or width <= 0
                or height <= 0
                or max(width, height) > MAX_PAGE_DIMENSION_PT
            ):
                page.close()
                raise HandoutError(
                    "PDF_PAGE_LIMIT", f"physical page {index + 1} has unsupported dimensions"
                )
            analyses.append(_analyze_page(page, index + 1))
            page.close()

        auto = _auto_plan(analyses, doc)
        selected = _request_plan(auto, request)
        inspection = _inspection(source_hash, selected, count, doc)
        if request["purpose"] == "inspect":
            return {"inspection": inspection, "pages": []}

        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        pages: list[dict[str, Any]] = []
        logical = 0
        for plan in selected:
            page = doc[plan["physicalPage"] - 1]
            try:
                for region in plan["regions"]:
                    logical += 1
                    rotation = plan["rotation"]
                    if rotation != 0:
                        crop = None
                    else:
                        left, top = region["x"], region["y"]
                        right = page.get_width() - left - region["width"]
                        bottom = page.get_height() - top - region["height"]
                        crop = (left, bottom, right, top)
                    image_path = destination / f"page-{logical:04d}.png"
                    image_path.write_bytes(_render_png(page, crop, RENDER_SCALE))
                    text = _extract_text(page, region, rotation)
                    pages.append(
                        {
                            "pageNumber": logical,
                            "title": _title(text),
                            "text": text,
                            "imagePath": str(image_path.resolve()),
                            "imageMediaType": "image/png",
                            "sourceRegion": {
                                "sourceSha256": source_hash,
                                "physicalPage": plan["physicalPage"],
                                "bounds": {
                                    "x": region["x"],
                                    "y": region["y"],
                                    "width": region["width"],
                                    "height": region["height"],
                                },
                                "rotation": rotation,
                                "scale": RENDER_SCALE,
                                "order": int(region.get("order", 1)),
                                "planVersion": PLAN_VERSION,
                            },
                        }
                    )
            finally:
                page.close()
        return {"inspection": inspection, "pages": pages}
    finally:
        doc.close()


def _cli(argv: list[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(argv) != 4:
        print(
            json.dumps(
                {
                    "error": {
                        "code": "PDF_REQUEST_INVALID",
                        "message": "usage: pdf-handout.py <source.pdf> <request.json> <outputDir>",
                    }
                },
                separators=(",", ":"),
            )
        )
        return 2
    request_path = Path(argv[2])
    try:
        if (
            not request_path.is_file()
            or request_path.stat().st_size > MAX_REQUEST_BYTES
        ):
            raise HandoutError(
                "PDF_REQUEST_INVALID", "request file is missing or exceeds the byte limit"
            )
        request = json.loads(request_path.read_text(encoding="utf-8"))
        print(json.dumps(run(argv[1], request, argv[3]), ensure_ascii=False, separators=(",", ":")))
        return 0
    except HandoutError as error:
        print(
            json.dumps(
                {"error": {"code": error.code, "message": str(error)}},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception as error:
        print(
            json.dumps(
                {
                    "error": {
                        "code": "PDF_PROCESSING_FAILED",
                        "message": f"PDF processing failed ({type(error).__name__})",
                    }
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv))
