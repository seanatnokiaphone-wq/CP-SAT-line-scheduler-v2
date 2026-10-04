"""Planner steering: pinned POs (M11, by Claude), and re-planning mid-week from a time (M1, M10).

A re-plan keeps every PO that has started by `replan_from` exactly where it is (start, tank, line, its CIP or
wash), and lets the optimiser move only work that has not started, never to before `replan_from`.
"""
from __future__ import annotations

from .plant import Schedule

TOL = 1e-6


def pins_from_base(base: Schedule, replan_from: float, extra: dict | None = None) -> dict:
    """Pins for every task in `base` that starts before `replan_from` (M1), plus the planner's own pins."""
    pins: dict = {}
    for t in base.batches:
        if t.start < replan_from - TOL:
            pins[t.id] = {"start": t.start, "tank": t.tank, "cip_start": t.cip_start, "cip_end": t.cip_end}
    for t in base.fills:
        if t.start < replan_from - TOL:
            pins[t.id] = {"start": t.start, "line": t.line, "wash_start": t.wash_start, "wash_end": t.wash_end}
    for k, v in (extra or {}).items():
        pins.setdefault(k, {}).update({a: b for a, b in v.items() if b is not None})
    return pins


def check_pins(sch: Schedule, pins: dict, replan_from: float | None = None) -> list[dict]:
    """Ways `sch` breaks the pins (M11) or starts unpinned work before the re-plan time (M10)."""
    out = []
    by = {t.id: t for t in sch.batches} | {t.id: t for t in sch.fills}
    for pid, pin in pins.items():
        t = by.get(pid)
        if t is None:
            continue
        if pin.get("start") is not None and abs(t.start - round(pin["start"] * 4) / 4) > TOL:
            out.append({"rule": "M11", "ids": [pid], "text": f"{pid} pinned to start at {pin['start']}h but starts at {t.start}h"})
        if pin.get("line") and getattr(t, "line", None) != pin["line"]:
            out.append({"rule": "M11", "ids": [pid], "text": f"{pid} pinned to {pin['line']} but runs on {t.line}"})
        if pin.get("tank") and getattr(t, "tank", None) != pin["tank"]:
            out.append({"rule": "M11", "ids": [pid], "text": f"{pid} pinned to {pin['tank']} but runs in {t.tank}"})
    if replan_from is not None:
        for t in list(sch.batches) + list(sch.fills):
            if t.id not in pins and t.start < replan_from - TOL:
                out.append({"rule": "M10", "ids": [t.id], "text": f"{t.id} starts at {t.start}h, before the re-plan time {replan_from}h"})
    return out
