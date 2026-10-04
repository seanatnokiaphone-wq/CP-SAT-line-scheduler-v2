"""What-if scenarios: explicit, labelled overrides of the plan's INPUTS, re-solved and compared with the base plan.

A scenario never touches the rules code. It changes only the data the rules are applied to: fill route times
(a faster filler), the downtime list (an extra shift instead of planned maintenance S8, or a new stop), the
hold limits on fills (P3), the CIP multiplier (H5/H7 wash lengths) and the week limit (P0). Every scenario's
schedule is checked by validate() against that scenario's own inputs, so all hard rules H1-H19 still hold.

Line rates and shared packs: a fill can only be sped up when every line that may take it is sped up, since the
model picks the line. 220 L / 110 L drums go to F3 or F4 (H9), so a multiplier on F3 alone changes nothing for
them; with both set, the fill's time is divided by the MEAN of the two multipliers (equal multipliers, as in the
preset, are exact). Times are rounded to the quarter hour (the model's time step), never below 0.25h.
"""
from __future__ import annotations

import concurrent.futures as cf
import multiprocessing as mp
import os
import time
from dataclasses import replace
from typing import Optional, Union

from pydantic import BaseModel, field_validator

from .cpsat import Settings
from .optimise import optimise
from .plant import LINE_BY_ID, Downtime, Plant, Schedule, lines_for
from .rng import js_round
from .validate import score, validate

BASE_NAME = "Base plan"


def _quarter(h: float) -> float:
    v = js_round(h * 4) / 4
    return int(v) if float(v).is_integer() else v


def _on_quarter(h: float) -> bool:
    return abs(h * 4 - round(h * 4)) < 1e-9


class Scenario(BaseModel):
    """One what-if. Every field left as None keeps the base input unchanged."""
    name: str
    line_rate: Optional[dict[str, float]] = None  # {line id: speed multiplier}, 1.25 = 25% faster
    remove_downtime: Optional[list[str]] = None  # downtime ids, or line ids = drop that line's planned maintenance
    add_downtime: Optional[list[Downtime]] = None
    hold_extra_h: Optional[Union[float, dict[int, float]]] = None  # all fills, or {system: hours}
    cip_mult: Optional[float] = None
    week_limit: Optional[float] = None
    time_limit: Optional[float] = None

    @field_validator("line_rate")
    @classmethod
    def _rates(cls, v):
        for line, m in (v or {}).items():
            if line not in LINE_BY_ID:
                raise ValueError(f"unknown fill line {line}")
            if m <= 0:
                raise ValueError(f"{line} rate multiplier must be > 0")
        return v

    @field_validator("hold_extra_h")
    @classmethod
    def _hold(cls, v):
        for h in ([v] if not isinstance(v, dict) else v.values()) if v is not None else []:
            if not _on_quarter(h):
                raise ValueError(f"hold extension {h}h is not on a 15-minute step")
        return v

    @field_validator("add_downtime")
    @classmethod
    def _down(cls, v):
        for d in v or []:
            if d.line not in LINE_BY_ID:
                raise ValueError(f"downtime {d.id} is on unknown line {d.line}")
            if not (_on_quarter(d.start) and _on_quarter(d.end)) or d.end <= d.start:
                raise ValueError(f"downtime {d.id} must run forwards on 15-minute steps")
        return v

    def describe(self) -> list[str]:
        """Plain-language list of what this scenario overrides (inputs only, never rules)."""
        out = []
        if self.line_rate:
            out.append("Filler speed: " + ", ".join(
                f"{l} x{m:g} ({'+' if m >= 1 else ''}{round((m - 1) * 100):g}%)" for l, m in self.line_rate.items())
                + " - fill route times (S14) scaled for packs only those lines can take")
        if self.remove_downtime:
            out.append("Downtime removed (S8 planned maintenance worked as an extra shift): "
                       + ", ".join(f"all planned stops on {x}" if x in LINE_BY_ID else x for x in self.remove_downtime))
        if self.add_downtime:
            out.append("Downtime added (H14): " + ", ".join(
                f"{d.id} on {d.line} {d.start:g}-{d.end:g}h" for d in self.add_downtime))
        if self.hold_extra_h is not None:
            if isinstance(self.hold_extra_h, dict):
                out.append("Hold limit (P3): " + ", ".join(
                    f"System {s} {h:+g}h" for s, h in sorted(self.hold_extra_h.items())))
            else:
                out.append(f"Hold limit (P3): {self.hold_extra_h:+g}h on every fill")
        if self.cip_mult is not None:
            out.append(f"CIP / wash length (H5, H7): x{self.cip_mult:g}")
        if self.week_limit is not None:
            out.append(f"Week limit (P0): {self.week_limit:g}h")
        if self.time_limit is not None:
            out.append(f"Solver time: {self.time_limit:g}s")
        return out or ["No changes"]


PRESETS: list[Scenario] = [
    Scenario(name="F3+F4 25% faster", line_rate={"F3": 1.25, "F4": 1.25}),
    Scenario(name="No planned maintenance on F1/F2", remove_downtime=["F1", "F2"]),
    Scenario(name="Hold limit +4h", hold_extra_h=4),
    Scenario(name="CIP 20% quicker", cip_mult=0.8),
]


def preset(name: str) -> Scenario:
    return next(s for s in PRESETS if s.name == name).model_copy(deep=True)


# ---------------- apply ----------------

def apply_with_notes(plant: Plant, downtime: list[Downtime], sc: Scenario, base: Settings
                     ) -> tuple[Plant, list[Downtime], Settings, list[str]]:
    """apply() plus a list of concrete effects (how many fills changed, which stops went)."""
    plant2 = plant.model_copy(deep=True)
    notes: list[str] = []

    if sc.line_rate or sc.hold_extra_h is not None:
        changed, fills = 0, []
        for f in plant2.fills:
            upd = {}
            if sc.line_rate:
                cands = lines_for(f.pack, f.system)
                if cands and all(l in sc.line_rate for l in cands):
                    m = sum(sc.line_rate[l] for l in cands) / len(cands)
                    d = max(0.25, _quarter(f.duration / m))
                    if d != f.duration:
                        upd["duration"] = d
                        changed += 1
            if sc.hold_extra_h is not None and f.hold_max is not None:
                extra = (sc.hold_extra_h.get(f.system, 0) if isinstance(sc.hold_extra_h, dict)
                         else sc.hold_extra_h)
                if extra:
                    # hold_max is typed int; a quarter-hour extension may make it a float (validate/CP-SAT accept it)
                    upd["hold_max"] = _quarter(max(0.0, f.hold_max + extra))
            fills.append(f.model_copy(update=upd) if upd else f)
        plant2.fills = fills
        if sc.line_rate:
            notes.append(f"{changed} fill route times changed")

    down2 = [d.model_copy(deep=True) for d in downtime]
    if sc.remove_downtime:
        ids = {d.id for d in down2}
        for x in sc.remove_downtime:
            if x not in LINE_BY_ID and x not in ids:
                raise ValueError(f"{sc.name}: no downtime or line called {x}")
        drop = {d.id for d in down2 if d.id in sc.remove_downtime
                or (d.line in sc.remove_downtime and d.kind == "scheduled")}
        down2 = [d for d in down2 if d.id not in drop]
        notes.append(f"{len(drop)} stops removed ({sum(d.end - d.start for d in downtime if d.id in drop):g}h)")
    if sc.add_downtime:
        clash = {d.id for d in down2} & {d.id for d in sc.add_downtime}
        if clash:
            raise ValueError(f"{sc.name}: downtime ids already exist: {sorted(clash)}")
        down2 += [d.model_copy(deep=True) for d in sc.add_downtime]

    s2 = replace(base, targets=dict(base.targets), starred=list(base.starred))
    for k in ("cip_mult", "week_limit", "time_limit"):
        if getattr(sc, k) is not None:
            s2 = replace(s2, **{k: getattr(sc, k)})
    return plant2, down2, s2, notes


def apply(plant: Plant, downtime: list[Downtime], scenario: Scenario, base_settings: Settings
          ) -> tuple[Plant, list[Downtime], Settings]:
    """Pure: returns deep copies with the scenario's overrides; the inputs are never modified."""
    p, d, s, _ = apply_with_notes(plant, downtime, scenario, base_settings)
    return p, d, s


# ---------------- run ----------------

def _run_one(plant: Plant, downtime: list[Downtime], sc: Scenario, base: Settings, workers: int) -> dict:
    t0 = time.time()
    p2, d2, s2, notes = apply_with_notes(plant, downtime, sc, base)
    s2 = replace(s2, workers=workers)
    sch, info = optimise(p2, d2, s2)
    rep = validate(p2, sch, d2, cip_mult=s2.cip_mult, week_limit=s2.week_limit, targets=s2.targets)
    over = sc.describe()
    if notes:
        over = over + ["Effect: " + "; ".join(notes)]
    return {"name": sc.name, "overrides": over, "metrics": rep.metrics, "valid": rep.ok,
            "violations": rep.by_rule(), "engine": sch.engine, "goal": s2.goal, "schedule": sch,
            "seconds": round(time.time() - t0, 1)}


def run_scenarios(plant: Plant, downtime: list[Downtime], scenarios: list[Scenario], base_settings: Settings,
                  parallel: bool = False) -> list[dict]:
    """Solve the base plan and each scenario. Result order: "Base plan" first, then scenarios as given.

    Runs one after another by default, each with all workers: on a 4-core box parallel runs starve each
    solver and the noise swamps the scenario effects. parallel=True is for machines with many cores.

    In parallel, each run is its own process (spawned, so no OR-Tools threads are forked) and its CP-SAT
    workers are cut so that all runs together use at most os.cpu_count() workers."""
    runs = [Scenario(name=BASE_NAME)] + [s for s in scenarios if s.name != BASE_NAME]
    names = [s.name for s in runs]
    if len(set(names)) != len(names):
        raise ValueError("scenario names must be unique")
    cpus = os.cpu_count() or 1
    if not parallel or len(runs) == 1:
        return [_run_one(plant, downtime, s, base_settings, base_settings.workers) for s in runs]
    procs = min(len(runs), cpus)
    workers = max(1, min(base_settings.workers, cpus // procs))
    with cf.ProcessPoolExecutor(max_workers=procs, mp_context=mp.get_context("spawn")) as ex:
        futs = [ex.submit(_run_one, plant, downtime, s, base_settings, workers) for s in runs]
        return [f.result() for f in futs]


# ---------------- compare ----------------

# (metric, rule id, label, direction: +1 = higher is better, -1 = lower is better), in score() order
LEVELS = [("target_miss_h", "P2", "target misses", -1), ("pos_in_week_limit", "P0", "POs in the week limit", 1),
          ("fills_over_hold_limit", "P3", "fills over the hold limit", -1), ("makespan", "P4", "plan end", -1),
          ("fill_wait_h", "P6", "fill wait", -1), ("cip_h", "P6", "CIP hours", -1)]
DELTA_KEYS = ["pos_in_week_limit", "fills_over_hold_limit", "makespan", "fill_wait_h", "cip_h"]


def _fmt(k: str, v: float) -> str:
    return f"{v:+g}" if k in ("pos_in_week_limit", "fills_over_hold_limit") else f"{v:+.2f}h"


def _decide(ma: dict, mb: dict, goal: str):
    for k, rule, label, sign in LEVELS:
        if k == "pos_in_week_limit" and goal != "fit":
            continue
        d = (ma.get(k) or 0) - (mb.get(k) or 0)
        if abs(d) > 1e-3:
            return k, rule, label, d * sign > 0
    return None


def compare(results: list[dict]) -> list[dict]:
    """One row per result: deltas vs the base plan (scenario minus base), the deciding priority, a verdict,
    and `best` = the valid result with the lowest lexicographic score() (ties keep the earlier one, so the
    base plan wins a tie)."""
    if not results:
        return []
    base = next((r for r in results if r["name"] == BASE_NAME), results[0])
    goal = base.get("goal", "fit")
    mb = base["metrics"]
    ranked = [r for r in results if r["valid"]] or results
    best = min(ranked, key=lambda r: score(r["metrics"], goal))["name"]
    rows = []
    for r in results:
        ma = r["metrics"]
        delta = {k: round(ma[k] - mb[k], 2) for k in DELTA_KEYS}
        dec = _decide(ma, mb, goal) if r is not base else None
        if r is base:
            verdict = "Base plan: today's inputs, for reference."
        elif not dec:
            verdict = f"{r['name']}: scores the same as the base plan on every priority; no gain."
        else:
            k, rule, label, better = dec
            verdict = (f"{r['name']}: {'better' if better else 'worse'} than the base plan, decided by {label} "
                       f"({rule}, {_fmt(k, ma[k] - mb[k])}).")
        if not r["valid"]:
            verdict += f" Breaks hard rules {r.get('violations')}; not eligible as best."
        if r["name"] == best:
            verdict += " Best of all runs."
        rows.append({"name": r["name"], "valid": r["valid"], "metrics": ma, "delta": delta,
                     "score": score(ma, goal), "deciding": dec[1] if dec else None,
                     "better_than_base": (dec[3] if dec else False) if r is not base else None,
                     "verdict": verdict, "best": best})
    return rows
