"""One test per plant rule: break exactly that rule in a valid schedule and the validator must name it."""
import json
from pathlib import Path

import pytest

from scheduler.plant import Downtime, Plant
from scheduler.v49 import schedule_from_golden
from scheduler.validate import validate

G = Path(__file__).parent / "golden"
DT = [Downtime(**d) for d in json.loads((G / "downtime_default.json").read_text())]


def load(name):
    g = json.loads((G / f"{name}.json").read_text())
    return Plant(**g["plant"]), schedule_from_golden(g["heuristic"])


@pytest.fixture
def week():
    return load("s42_n30")


def rules(plant, sch, dt=DT):
    return set(validate(plant, sch, dt).by_rule())


def first_on_tank(sch, nth=1):
    """A batch with a CIP (not first on its tank)."""
    return [t for t in sch.batches if t.cip_start is not None][nth]


def test_v49_schedules_are_valid():
    for p in sorted(G.glob("s*.json")):
        g = json.loads(p.read_text())
        rep = validate(Plant(**g["plant"]), schedule_from_golden(g["heuristic"]), DT)
        assert rep.ok, (p.stem, rep.violations[:3])


def test_H1_tank_of_other_system(week):
    plant, sch = week
    b = next(t for t in sch.batches if t.tank.startswith("T1"))
    b.tank = "T2A"
    assert "H1" in rules(plant, sch)


def test_H2_batch_without_fill(week):
    plant, sch = week
    b = next(b for b in plant.batches if not b.trio_id)
    b.fill_ids = []
    assert "H2" in rules(plant, sch)


def test_H3_fill_before_batch_ends(week):
    plant, sch = week
    f = next(f for f in plant.fills if not plant.batches[[b.id for b in plant.batches].index(f.batch_id)].trio_id)
    t = next(x for x in sch.fills if x.id == f.id)
    b = next(x for x in sch.batches if x.id == f.batch_id)
    shift = t.start - (b.end - 0.5)
    t.start -= shift; t.end -= shift
    t.wash_start = t.wash_end = None
    assert "H3" in rules(plant, sch)


def test_H4_next_cip_before_tank_emptied(week):
    plant, sch = week
    b = first_on_tank(sch)
    prev = max((x for x in sch.batches if x.tank == b.tank and x.start < b.start), key=lambda x: x.start)
    length = b.cip_end - b.cip_start
    b.cip_start = prev.end - 0.25
    b.cip_end = b.cip_start + length
    assert "H4" in rules(plant, sch)


def test_H5_cip_too_short(week):
    plant, sch = week
    b = first_on_tank(sch)
    b.cip_end = b.cip_start + 0.25
    assert "H5" in rules(plant, sch)


def test_H6_two_cips_on_one_skid(week):
    plant, sch = week
    sysof = {b.id: b.system for b in plant.batches}
    cips = [t for t in sch.batches if t.cip_start is not None]
    a, c = next((a, c) for a in cips for c in cips if a.id != c.id and sysof[a.id] == sysof[c.id])
    c.cip_start, c.cip_end = a.cip_start, a.cip_start + (c.cip_end - c.cip_start)
    assert "H6" in rules(plant, sch)


def test_H7_two_fills_at_once_on_a_line(week):
    plant, sch = week
    a, c = [t for t in sch.fills if t.line == "F1"][:2]
    d = c.end - c.start
    c.start, c.end = a.start, a.start + d
    assert "H7" in rules(plant, sch)


def test_H8_trio_not_staggered(week):
    plant, sch = week
    m = next(b for b in plant.batches if b.trio_id and plant.batches[[x.id for x in plant.batches].index(b.id)].fill_ids == [])
    t = next(x for x in sch.batches if x.id == m.id)
    t.start += 0.5; t.end += 0.5
    assert "H8" in rules(plant, sch)


def test_H9_wrong_pack_line(week):
    plant, sch = week
    f = next(f for f in plant.fills if f.pack == "1000L")
    next(x for x in sch.fills if x.id == f.id).line = "F3"
    assert "H9" in rules(plant, sch)


def test_H10_f7_only_system_4():
    plant, sch = load("s42_n30")
    f = next(f for f in plant.fills if f.system != 4)
    next(x for x in sch.fills if x.id == f.id).line = "F7"
    assert "H10" in rules(plant, sch)


def test_H10_f7_weekly_cap():
    plant, sch = load("s42_n200")
    f7 = sorted([t for t in sch.fills if t.line == "F7"], key=lambda t: t.start)
    assert len(f7) >= 4
    late = f7[3]
    d = late.end - late.start
    late.start, late.end = 150.0, 150.0 + d
    assert "H10" in rules(plant, sch)


def test_H11_f7_alongside_f5():
    plant, sch = load("s42_n200")
    f7 = next(t for t in sch.fills if t.line == "F7")
    f5 = next(t for t in sch.fills if t.line == "F5")
    d = f7.end - f7.start
    f7.start, f7.end = f5.start, f5.start + d
    assert "H11" in rules(plant, sch)


def test_H12_volumes_do_not_add_up(week):
    plant, sch = week
    plant.fills[0].volume_l += 500
    assert "H12" in rules(plant, sch)


def test_H13_missing_po(week):
    plant, sch = week
    sch.fills.pop()
    assert "H13" in rules(plant, sch)


def test_H14_fill_during_stop(week):
    plant, sch = week
    t = next(x for x in sch.fills if x.line == "F1")
    stop = next(d for d in DT if d.line == "F1")
    d = t.end - t.start
    t.start, t.end = stop.start, stop.start + d
    assert "H14" in rules(plant, sch)


def test_H15_twins_down_together(week):
    plant, sch = week
    dt = [d.model_copy() for d in DT]
    f2 = next(d for d in dt if d.line == "F2")
    f1 = next(d for d in dt if d.line == "F1")
    f2.start, f2.end = f1.start, f1.end
    assert "H15" in rules(plant, sch, dt)


def test_H19_two_fills_of_one_batch_at_once():
    for name in ["s42_n30", "s42_n100"]:
        plant, sch = load(name)
        b = next((b for b in plant.batches if len(b.fill_ids) == 2), None)
        if b:
            break
    a, c = [next(x for x in sch.fills if x.id == i) for i in b.fill_ids]
    d = c.end - c.start
    c.start, c.end = a.start, a.start + d
    assert "H19" in rules(plant, sch)


def test_H8_trio_fill_count_and_one_at_a_time():
    """H8 (Sean, 2026-10-04 19:24 UTC): a trio takes 1 or 3 fill POs, filled one at a time (H19)."""
    from scheduler.generator import generate_plant
    from scheduler.heuristic import best_heuristic
    from scheduler.plant import default_maintenance
    dt = default_maintenance()
    plant = next(p for p in (generate_plant(s, 40) for s in range(1, 40))
                 if any(len(b.fill_ids) == 3 and b.trio_id for b in plant_batches(p)))
    sch = best_heuristic(plant, dt)
    assert validate(plant, sch, dt).ok
    carrier = next(b for b in plant.batches if b.trio_id and len(b.fill_ids) == 3)
    sf = {t.id: t for t in sch.fills}
    a, c = sf[carrier.fill_ids[0]], sf[carrier.fill_ids[1]]
    assert a.end <= c.start + 1e-6 or c.end <= a.start + 1e-6
    bad = sch.model_copy(deep=True)
    t = next(x for x in bad.fills if x.id == c.id)
    t.start, t.end = a.start, a.start + (c.end - c.start)  # two trio fills at once
    assert "H19" in rules(plant, bad, dt)
    two = plant.model_copy(deep=True)
    cb = next(b for b in two.batches if b.id == carrier.id)
    drop = cb.fill_ids.pop()
    two.fills = [f for f in two.fills if f.id != drop]
    sch2 = sch.model_copy(deep=True)
    sch2.fills = [f for f in sch2.fills if f.id != drop]
    assert "H8" in rules(two, sch2, dt)


def plant_batches(p):
    return p.batches
