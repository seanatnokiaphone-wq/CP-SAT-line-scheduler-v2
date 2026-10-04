"""Load v49's heuristic schedule from a golden file (made by tools/v49-golden) as a Schedule."""
from __future__ import annotations

from .plant import BatchTask, FillTask, Schedule


def schedule_from_golden(h: dict) -> Schedule:
    cips = {c["toBatch"]: c for c in h["cips"]}
    washes = {c["toFill"]: c for c in h["fillerCips"]}
    bs = []
    for b in h["batches"]:
        c = cips.get(b["id"])
        bs.append(BatchTask(id=b["id"], tank=b["tank"], start=b["start"], end=b["end"],
                            cip_start=c and c["start"], cip_end=c and c["end"], cip_rule=c and c["rule"]))
    fs = []
    for f in h["fills"]:
        w = washes.get(f["id"])
        fs.append(FillTask(id=f["id"], line=f["line"], start=f["start"], end=f["end"],
                           wash_start=w and w["start"], wash_end=w and w["end"]))
    return Schedule(engine="v49-heuristic", batches=bs, fills=fs)
