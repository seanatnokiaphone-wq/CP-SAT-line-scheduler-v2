"""One call for a whole solve: heuristic warm start, CP-SAT within the time left, validator, best result.

Every candidate goes through the validator; a schedule that breaks a plant rule is never returned. With
planner steering (pins, re-plan from a time) a candidate must also keep every pin (M1, M10, M11).
"""
from __future__ import annotations

import time

from .cpsat import Settings, solve
from .heuristic import best_heuristic
from .plant import Downtime, Plant, Schedule
from .refine import refine_windows
from .steering import check_pins, pins_from_base
from .validate import score, validate


def optimise(plant: Plant, downtime: list[Downtime], s: Settings, base: Schedule | None = None,
             on_progress=None) -> tuple[Schedule, dict]:
    """`base` + `s.replan_from`: re-plan mid-week, keeping what has started. `on_progress(event)` gets
    {"stage", "seconds", "engine", "metrics", "schedule"} for the heuristic and each improved CP-SAT plan."""
    t0 = time.time()
    if base is not None and s.replan_from is not None:
        s = Settings(**{**s.__dict__, "pins": pins_from_base(base, s.replan_from, s.pins)})
    steering = bool(s.pins) or s.replan_from is not None

    def check(sch):
        rep = validate(plant, sch, downtime, cip_mult=s.cip_mult, week_limit=s.week_limit, targets=s.targets)
        bad = check_pins(sch, s.pins, s.replan_from) if steering else []
        return rep, bad

    def emit(stage, sch, rep):
        if on_progress:
            on_progress({"stage": stage, "seconds": round(time.time() - t0, 1), "engine": sch.engine,
                         "metrics": rep.metrics, "valid": rep.ok, "schedule": sch})

    heur = best_heuristic(plant, downtime, s.week_limit, s.goal)
    h_rep, h_bad = check(heur)
    info = {"heuristic_seconds": round(time.time() - t0, 1), "heuristic": h_rep.metrics}
    best, best_rep, hint = None, None, heur
    if h_rep.ok and not h_bad:
        best, best_rep = heur, h_rep
        emit("heuristic", heur, h_rep)
    elif base is not None:  # the heuristic does not know the pins; start CP-SAT from the plan being re-planned
        hint = base
        info["heuristic_ignored"] = [b["text"] for b in h_bad[:5]]
    left = s.time_limit - (time.time() - t0)
    # Big weeks (item 6): half the time on a whole-week CP-SAT solve, half on re-solving 48h windows with the
    # rest of the week pinned. On the 200-PO bench weeks this fit 2-3 more POs in the week limit at equal time.
    big = len(plant.batches) > s.big_week and s.refine is not False and left > 20
    cp_time = left / 2 if big else left
    if left > 2:
        def on_solution(sec, level, obj, sch):
            if on_progress:
                rep = validate(plant, sch, downtime, cip_mult=s.cip_mult, week_limit=s.week_limit, targets=s.targets)
                emit(f"cp-sat {level}", sch, rep)

        sch = solve(plant, downtime, Settings(**{**s.__dict__, "time_limit": cp_time, "on_solution": on_solution}), hint=hint)
        if sch.batches:
            rep, bad = check(sch)
            info["cpsat"] = rep.metrics
            info["cpsat_violations"] = rep.by_rule() | ({"M": len(bad)} if bad else {})
            info["cpsat_status"] = sch.status
            if rep.ok and not bad and (best is None or score(rep.metrics, s.goal) <= score(best_rep.metrics, s.goal)):
                best, best_rep = sch, rep
    if big and best is not None:
        rest = s.time_limit - (time.time() - t0)
        if rest > 5:
            def on_better(sch, rep):
                emit("windows", sch, rep)
            cand, winfo = refine_windows(plant, downtime, s, best, rest, on_better=on_better)
            info["windows"] = winfo
            rep, bad = check(cand)
            if rep.ok and not bad and score(rep.metrics, s.goal) <= score(best_rep.metrics, s.goal):
                best, best_rep = cand, rep
    if best is None:  # nothing kept every rule and pin: fall back to the plan being re-planned, else the heuristic
        best = base if base is not None else heur
        best_rep, _ = check(best)
        info["fallback"] = True
    emit("done", best, best_rep)
    info["engine"] = best.engine
    info["seconds"] = round(time.time() - t0, 1)
    info["metrics"] = best_rep.metrics
    return best, info
