"""What-if scenarios change only the inputs they name, solve to valid schedules and compare against the base."""
import pytest

from scheduler.cpsat import Settings
from scheduler.generator import generate_plant
from scheduler.plant import Downtime, default_maintenance, lines_for
from scheduler.scenarios import BASE_NAME, PRESETS, Scenario, apply, compare, preset, run_scenarios
from scheduler.validate import score

PLANT = generate_plant(42, 30)
DT = default_maintenance()
BASE = Settings(time_limit=8)


def test_presets():
    assert [p.name for p in PRESETS] == ["F3+F4 25% faster", "No planned maintenance on F1/F2", "Hold limit +4h",
                                         "CIP 20% quicker"]
    assert preset("CIP 20% quicker").cip_mult == 0.8


def test_apply_line_rate_only_scales_packs_fully_covered():
    before = PLANT.model_dump()
    p2, d2, s2 = apply(PLANT, DT, preset("F3+F4 25% faster"), BASE)
    assert PLANT.model_dump() == before  # pure
    assert d2 == DT and s2 == BASE
    changed = 0
    for a, b in zip(PLANT.fills, p2.fills):
        assert (a.id, a.pack, a.volume_l, a.hold_max) == (b.id, b.pack, b.volume_l, b.hold_max)
        if set(lines_for(a.pack, a.system)) <= {"F3", "F4"}:
            assert b.duration == max(0.25, round(a.duration / 1.25 * 4) / 4)
            assert (b.duration * 4) % 1 == 0
            changed += b.duration != a.duration
        else:
            assert b.duration == a.duration
    assert changed > 0
    assert [x.model_dump() for x in p2.batches] == [x.model_dump() for x in PLANT.batches]

    # one of a twin pair alone does not speed up a shared pack
    p3, _, _ = apply(PLANT, DT, Scenario(name="F3 only", line_rate={"F3": 2.0}), BASE)
    assert [f.duration for f in p3.fills] == [f.duration for f in PLANT.fills]
    # mean of the two multipliers
    p4, _, _ = apply(PLANT, DT, Scenario(name="mix", line_rate={"F3": 1.0, "F4": 3.0}), BASE)
    for a, b in zip(PLANT.fills, p4.fills):
        if a.pack in ("220L", "110L"):
            assert b.duration == max(0.25, round(a.duration / 2.0 * 4) / 4)


def test_apply_downtime_and_hold_and_settings():
    _, d2, _ = apply(PLANT, DT, preset("No planned maintenance on F1/F2"), BASE)
    assert {d.line for d in d2} == {d.line for d in DT} - {"F1", "F2"}
    assert len(d2) == len(DT) - 6
    extra = Downtime(id="UD-1", line="F5", start=40, end=44, kind="unscheduled", reason="Breakdown")
    p2, d3, s3 = apply(PLANT, DT, Scenario(name="x", remove_downtime=["PM-F3-1"], add_downtime=[extra],
                                           hold_extra_h={4: 2}, week_limit=110, time_limit=5), BASE)
    assert "PM-F3-1" not in {d.id for d in d3} and "UD-1" in {d.id for d in d3} and len(d3) == len(DT)
    for a, b in zip(PLANT.fills, p2.fills):
        assert b.hold_max == a.hold_max + (2 if a.system == 4 else 0)
        assert b.duration == a.duration
    assert (s3.week_limit, s3.time_limit, s3.cip_mult) == (110, 5, 1.0)
    assert BASE.week_limit == 120
    p5, _, _ = apply(PLANT, DT, preset("Hold limit +4h"), BASE)
    assert all(b.hold_max == a.hold_max + 4 for a, b in zip(PLANT.fills, p5.fills))
    with pytest.raises(ValueError):
        apply(PLANT, DT, Scenario(name="bad", remove_downtime=["PM-NOPE"]), BASE)
    with pytest.raises(ValueError):
        Scenario(name="bad", line_rate={"F9": 1.2})


def test_run_and_compare():
    res = run_scenarios(PLANT, DT, [preset("F3+F4 25% faster"), preset("No planned maintenance on F1/F2")], BASE)
    assert [r["name"] for r in res] == [BASE_NAME, "F3+F4 25% faster", "No planned maintenance on F1/F2"]
    for r in res:
        assert r["valid"], (r["name"], r["violations"])
        assert r["schedule"].fills and r["overrides"] and r["seconds"] > 0
    assert res[0]["overrides"] == ["No changes"]
    rows = compare(res)
    best = rows[0]["best"]
    assert best in {r["name"] for r in res} and all(r["best"] == best for r in rows)
    assert score(next(r for r in rows if r["name"] == best)["metrics"]) == min(r["score"] for r in rows)
    mb = res[0]["metrics"]
    assert all(v == 0 for v in rows[0]["delta"].values())
    for row, r in zip(rows, res):
        for k, v in row["delta"].items():
            assert v == pytest.approx(r["metrics"][k] - mb[k], abs=0.01)
        if row["name"] != BASE_NAME:
            assert row["better_than_base"] == (row["score"] < rows[0]["score"])
            assert (row["deciding"] is None) == (row["score"] == rows[0]["score"])
        assert row["verdict"]
