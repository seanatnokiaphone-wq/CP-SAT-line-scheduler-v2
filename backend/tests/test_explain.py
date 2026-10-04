"""explain(): every PO gets a status, reasons match the validator, critical path, structural impossibility."""
import re

import pytest

from scheduler.explain import clock, explain
from scheduler.generator import generate_plant
from scheduler.heuristic import best_heuristic
from scheduler.plant import TRIO_FILL_LEAD, default_maintenance
from scheduler.validate import validate

DT = default_maintenance()
RULE = re.compile(r"^(H\d+|P\d(-P\d)?|S\d+|M\d+)$")


@pytest.fixture(scope="module", params=[(1, 30), (4, 45), (5, 60)], ids=lambda x: f"seed{x[0]}-n{x[1]}")
def case(request):
    seed, n = request.param
    plant = generate_plant(seed, n)
    sch = best_heuristic(plant, DT)
    return plant, sch, explain(plant, sch, DT), validate(plant, sch, DT)


def test_clock():
    assert clock(0) == "Mon 07:00"
    assert clock(21.5) == "Tue 04:30"
    assert clock(168) == "Mon wk2 07:00"
    assert clock(16.99999) == "Tue 00:00"  # rounds to the minute, never "24:00"


def test_covers_every_po(case):
    plant, _, e, _ = case
    ids = {b.id for b in plant.batches} | {f.id for f in plant.fills}
    assert set(e["pos"]) == ids
    for v in e["pos"].values():
        assert v["status"] in ("in_week", "outside_week", "late_fill", "ok")
        for r in v["reasons"]:
            assert set(r) >= {"rule", "text"} and r["text"]


def test_counts_match_validator(case):
    plant, _, e, rep = case
    s = e["summary"]
    assert s["in_week"] == rep.metrics["pos_in_week_limit"]
    assert s["late_fills"] == rep.metrics["fills_over_hold_limit"]
    assert s["outside_week"] == len(plant.batches) - s["in_week"]
    assert s["fill_wait_h"] == pytest.approx(rep.metrics["fill_wait_h"], abs=0.05)
    assert "(P0)" in s["text"] and "(P3)" in s["text"]


def test_every_problem_po_has_a_reason_with_a_rule(case):
    _, _, e, _ = case
    bad = {k: v for k, v in e["pos"].items() if v["status"] in ("outside_week", "late_fill")}
    assert bad, "fixture should have at least one PO outside the week limit"
    for k, v in bad.items():
        assert v["reasons"], k
        assert any(r["rule"] in ("P0", "P3") for r in v["reasons"]), k
        for r in v["reasons"]:
            assert r["rule"] == "" or RULE.match(r["rule"]), r


def test_fill_wait_reported(case):
    plant, sch, e, _ = case
    for f in plant.fills:
        v = e["pos"][f.id]
        assert v["wait_h"] >= -1e-6
        if v["wait_h"] > 0.01:
            assert any(r["rule"] == "P6" and "Waited" in r["text"] for r in v["reasons"]), f.id


def test_critical_path_starts_at_latest_task(case):
    _, sch, e, _ = case
    cp = e["critical_path"]
    assert cp
    latest = max([t.end for t in sch.batches] + [t.end for t in sch.fills])
    assert cp[0]["end"] == pytest.approx(latest)
    assert cp[0]["kind"] in ("batch", "fill")
    for s in cp:
        assert set(s) >= {"id", "kind", "where", "start", "end", "rule", "reason"}
        assert s["reason"]
    ids = [s["id"] for s in cp]
    assert len(ids) == len(set(ids))
    # steps go back in time: each blocker ends no later than the step it held up starts (+ its own run)
    for a, b in zip(cp, cp[1:]):
        assert b["end"] <= a["end"] + 1e-6


def _impossible_trio(plant):
    """A trio whose fills, back to back, need more than the hold limit (computed from the order book only)."""
    by_trio = {}
    for b in plant.batches:
        if b.trio_id:
            by_trio.setdefault(b.trio_id, []).append(b)
    for tid, ms in by_trio.items():
        fills = [f for f in plant.fills if f.batch_id == ms[0].id]
        if not fills:
            continue
        need = sum(f.duration for f in fills) - min(TRIO_FILL_LEAD, max(f.duration for f in fills))
        if need > max(f.hold_max for f in fills) + 0.01:
            return ms, fills, need
    return None


def test_structural_reason():
    for seed in range(1, 30):
        plant = generate_plant(seed, 30)
        hit = _impossible_trio(plant)
        if hit:
            break
    else:
        pytest.skip("no structurally impossible trio in seeds 1-29")
    ms, fills, need = hit
    sch = best_heuristic(plant, DT)
    e = explain(plant, sch, DT)
    v = e["pos"][ms[0].id]
    assert v["status"] == "outside_week" and v["structural"]
    txt = " ".join(r["text"] for r in v["reasons"])
    assert "Cannot fit" in txt and "hold limit" in txt and "S14" in txt
    assert f"{round(need, 2):g}h" in txt
    assert e["summary"]["structural_impossible"] >= 1
    assert ms[0].id in e["summary"]["structural_groups"]
    late = [f.id for f in fills if e["pos"][f.id]["status"] == "late_fill"]
    assert late and all(e["pos"][x]["structural"] for x in late)
