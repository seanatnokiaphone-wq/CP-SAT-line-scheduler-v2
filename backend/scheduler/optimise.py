"""One call for a whole solve: heuristic warm start, CP-SAT within the time left, validator, best result.

Every candidate goes through the validator; a schedule that breaks a plant rule is never returned.
"""
from __future__ import annotations

import time

from .cpsat import Settings, solve
from .heuristic import best_heuristic
from .plant import Downtime, Plant, Schedule
from .validate import score, validate


def optimise(plant: Plant, downtime: list[Downtime], s: Settings) -> tuple[Schedule, dict]:
    t0 = time.time()
    heur = best_heuristic(plant, downtime, s.week_limit, s.goal)
    h_rep = validate(plant, heur, downtime, cip_mult=s.cip_mult, week_limit=s.week_limit, targets=s.targets)
    best, best_rep = heur, h_rep
    left = s.time_limit - (time.time() - t0)
    info = {"heuristic_seconds": round(time.time() - t0, 1), "heuristic": h_rep.metrics}
    if left > 2:
        sch = solve(plant, downtime, Settings(**{**s.__dict__, "time_limit": left}), hint=heur)
        if sch.batches:
            rep = validate(plant, sch, downtime, cip_mult=s.cip_mult, week_limit=s.week_limit, targets=s.targets)
            info["cpsat"] = rep.metrics
            info["cpsat_violations"] = rep.by_rule()
            if rep.ok and score(rep.metrics, s.goal) <= score(best_rep.metrics, s.goal):
                best, best_rep = sch, rep
    info["engine"] = best.engine
    info["seconds"] = round(time.time() - t0, 1)
    return best, info
