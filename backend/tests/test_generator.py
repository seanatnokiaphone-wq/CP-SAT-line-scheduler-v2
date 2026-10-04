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
                           run_times=o.get("runTimes"), trio_three_fill_pct=0)
    got = json.loads(plant.model_dump_json(by_alias=True))
    assert got == g["plant"]


def test_trio_fills_one_or_three_and_empty_all_three_tanks():
    """H8: a trio has 1 or 3 fill POs on its first batch; together they take all three tanks' volume."""
    seen = set()
    for seed in range(1, 30):
        plant = generate_plant(seed, 60)
        trios = {}
        for b in plant.batches:
            if b.trio_id:
                trios.setdefault(b.trio_id, []).append(b)
        for ms in trios.values():
            if len(ms) < 3:
                continue
            fills = [f for f in plant.fills if f.batch_id == ms[0].id]
            assert len(fills) in (1, 3) and ms[0].fill_ids == [f.id for f in fills]
            assert all(not m.fill_ids for m in ms[1:])
            assert abs(sum(f.volume_l for f in fills) - sum(m.volume_l for m in ms)) <= len(fills)
            seen.add(len(fills))
    assert seen == {1, 3}
