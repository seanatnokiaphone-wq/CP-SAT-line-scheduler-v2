"""CP-SAT results pass every plant rule and never score worse than their v49 warm start."""
import json
from pathlib import Path

import pytest

from scheduler.cpsat import Settings, solve
from scheduler.plant import Downtime, Plant
from scheduler.v49 import schedule_from_golden
from scheduler.validate import score, validate

G = Path(__file__).parent / "golden"
DT = [Downtime(**d) for d in json.loads((G / "downtime_default.json").read_text())]


@pytest.mark.parametrize("name", ["s1_n10", "s42_n10", "s7_n10", "s99_n10"])
def test_cpsat_valid_and_not_worse(name):
    g = json.loads((G / f"{name}.json").read_text())
    plant = Plant(**g["plant"])
    heur = schedule_from_golden(g["heuristic"])
    sch = solve(plant, DT, Settings(time_limit=10), hint=heur)
    rep = validate(plant, sch, DT)
    assert rep.ok, rep.violations[:3]
    assert score(rep.metrics) <= score(validate(plant, heur, DT).metrics)


def test_cpsat_without_warm_start():
    g = json.loads((G / "s42_n10.json").read_text())
    plant = Plant(**g["plant"])
    sch = solve(plant, DT, Settings(time_limit=10))
    assert validate(plant, sch, DT).ok


def test_cpsat_priority_target_window():
    """P2: a starred fill with a target time starts within 6h of it."""
    g = json.loads((G / "s42_n10.json").read_text())
    plant = Plant(**g["plant"])
    f = plant.fills[-1]
    sch = solve(plant, DT, Settings(time_limit=10, targets={f.id: 30.0}, starred=[f.id]),
                hint=schedule_from_golden(g["heuristic"]))
    start = next(t.start for t in sch.fills if t.id == f.id)
    assert abs(start - 30.0) <= 6.0
    assert validate(plant, sch, DT).ok
