"""Generator parity with v49 (S3-S13): a seed gives exactly the same week as the prototype."""
import json
from pathlib import Path

import pytest

from scheduler.generator import generate_plant

GOLDEN = sorted((Path(__file__).parent / "golden").glob("s*.json"))


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_generator_matches_v49(path):
    g = json.loads(path.read_text())
    c = g["case"]
    o = c.get("opts", {})
    plant = generate_plant(c["seed"], c["n"], capacity=o.get("capacity"), hold_range=o.get("holdRange", (6, 12)),
                           double_fill=o.get("doubleFill"), trio_pct=o.get("trioPct", 60), mix=o.get("mix"),
                           run_times=o.get("runTimes"))
    got = json.loads(plant.model_dump_json(by_alias=True))
    assert got == g["plant"]
