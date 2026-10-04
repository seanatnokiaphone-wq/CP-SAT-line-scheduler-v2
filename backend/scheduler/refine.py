"""Big weeks: improve a plan one time window at a time (rolling horizon, item 6 of the improvement list).

Everything outside the window is pinned where it is; CP-SAT re-solves the POs inside it. With most of the
week fixed the model presolves in a second or two instead of ~15s, so many windows fit in the time left.
A window's result is kept only when the validator passes it and it scores better (P2, P0, P3, P4, P6).
"""
from __future__ import annotations

import time

from .cpsat import Settings, solve
from .plant import Downtime, Plant, Schedule
from .steering import pins_from_base
from .validate import score, validate


def window_pins(sch: Schedule, a: float, b: float) -> dict:
    pins = {}
    for t in sch.batches:
        if not (a <= t.start < b):
            pins[t.id] = {"start": t.start, "tank": t.tank, "cip_start": t.cip_start, "cip_end": t.cip_end}
    for t in sch.fills:
        if not (a <= t.start < b):
            pins[t.id] = {"start": t.start, "line": t.line, "wash_start": t.wash_start, "wash_end": t.wash_end}
    return pins


def refine_windows(plant: Plant, downtime: list[Downtime], s: Settings, best: Schedule, seconds: float,
                   width: float = 48.0, step: float = 24.0, per_window: float = 8.0, on_better=None):
    t0 = time.time()
    rep = validate(plant, best, downtime, cip_mult=s.cip_mult, week_limit=s.week_limit, targets=s.targets)
    end = max([t.end for t in best.batches] + [t.end for t in best.fills])
    starts = [a for a in frange(0.0, end, step)]
    tried = kept = 0
    while time.time() - t0 < seconds - 2 and starts:
        improved = False
        for a in starts:
            left = seconds - (time.time() - t0)
            if left < 2:
                break
            base_pins = window_pins(best, a, a + width)
            pins = {**base_pins, **{k: {**base_pins.get(k, {}), **v} for k, v in (s.pins or {}).items()}}
            ws = Settings(**{**s.__dict__, "pins": pins, "time_limit": min(per_window, left), "mode": "staged",
                             "on_solution": None})
            cand = solve(plant, downtime, ws, hint=best)
            tried += 1
            if not cand.batches:
                continue
            crep = validate(plant, cand, downtime, cip_mult=s.cip_mult, week_limit=s.week_limit, targets=s.targets)
            if crep.ok and score(crep.metrics, s.goal) < score(rep.metrics, s.goal):
                best, rep, improved = cand, crep, True
                kept += 1
                if on_better:
                    on_better(best, rep)
        if not improved:
            break
    return best, {"windows_tried": tried, "windows_kept": kept, "seconds": round(time.time() - t0, 1)}


def frange(a, b, step):
    x = a
    while x < b:
        yield x
        x += step
