"""The Python heuristic reproduces v49's best schedule on every golden week (same tanks, lines and times)."""
import json
from pathlib import Path

import pytest

from scheduler.heuristic import best_heuristic
from scheduler.plant import Downtime, Plant

G = Path(__file__).parent / "golden"
DT = [Downtime(**d) for d in json.loads((G / "downtime_default.json").read_text())]
GOLDEN = sorted(G.glob("s*.json"))


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_heuristic_matches_v49(path):
    g = json.loads(path.read_text())
    plant = Plant(**g["plant"])
    sch = best_heuristic(plant, DT)
    h = g["heuristic"]
    got_b = sorted((t.id, t.tank, round(t.start, 6)) for t in sch.batches)
    want_b = sorted((b["id"], b["tank"], round(b["start"], 6)) for b in h["batches"])
    assert got_b == want_b
    got_f = sorted((t.id, t.line, round(t.start, 6)) for t in sch.fills)
    want_f = sorted((f["id"], f["line"], round(f["start"], 6)) for f in h["fills"])
    assert got_f == want_f
