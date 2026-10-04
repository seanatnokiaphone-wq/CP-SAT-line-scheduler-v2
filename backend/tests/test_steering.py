"""Planner steering: pins (M11), re-plan from a time (M1, M10), live progress."""
from scheduler.cpsat import Settings
from scheduler.generator import generate_plant
from scheduler.optimise import optimise
from scheduler.plant import default_maintenance
from scheduler.steering import check_pins
from scheduler.validate import validate

DT = default_maintenance()


def test_replan_keeps_started_work_and_moves_the_rest_later():
    plant = generate_plant(42, 30)
    base, _ = optimise(plant, DT, Settings(time_limit=10))
    t = 24.0
    new, info = optimise(plant, DT, Settings(time_limit=10, replan_from=t), base=base)
    assert validate(plant, new, DT).ok
    b0 = {x.id: x for x in base.batches} | {x.id: x for x in base.fills}
    n1 = {x.id: x for x in new.batches} | {x.id: x for x in new.fills}
    for i, x in b0.items():
        if x.start < t:  # M1: started work stays put, tank and line included
            assert n1[i].start == x.start and getattr(n1[i], "tank", None) == getattr(x, "tank", None) \
                and getattr(n1[i], "line", None) == getattr(x, "line", None), i
        else:  # M10: the rest starts no earlier than the re-plan time
            assert n1[i].start >= t - 1e-6, i


def test_pin_a_fill_to_a_line_and_time():
    plant = generate_plant(1, 30)
    base, _ = optimise(plant, DT, Settings(time_limit=8))
    f = next(x for x in base.fills if x.line in ("F1", "F2"))
    other = "F2" if f.line == "F1" else "F1"
    pins = {f.id: {"line": other, "start": f.start + 6}}
    new, info = optimise(plant, DT, Settings(time_limit=10, pins=pins))
    assert validate(plant, new, DT).ok
    assert not check_pins(new, pins), info
    got = next(x for x in new.fills if x.id == f.id)
    assert got.line == other and got.start == f.start + 6


def test_progress_reports_heuristic_and_final_plan():
    seen = []
    optimise(generate_plant(42, 30), DT, Settings(time_limit=6), on_progress=lambda e: seen.append(e["stage"]))
    assert seen[0] == "heuristic" and seen[-1] == "done"
