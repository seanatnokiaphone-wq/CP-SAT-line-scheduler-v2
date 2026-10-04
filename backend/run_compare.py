"""Compare CP-SAT with v49's heuristic on golden weeks: python3 run_compare.py s42_n30 [time_limit]"""
import json
import sys
import time

from scheduler.cpsat import Settings, solve
from scheduler.plant import Downtime, Plant
from scheduler.v49 import schedule_from_golden
from scheduler.validate import score, validate

name = sys.argv[1]
tl = float(sys.argv[2]) if len(sys.argv) > 2 else 60
hint_on = "--nohint" not in sys.argv
g = json.load(open(f"tests/golden/{name}.json"))
plant = Plant(**g["plant"])
dt = [Downtime(**d) for d in json.load(open("tests/golden/downtime_default.json"))]
heur = schedule_from_golden(g["heuristic"])
rh = validate(plant, heur, dt)
t0 = time.time()
sch = solve(plant, dt, Settings(time_limit=tl), hint=heur if hint_on else None,
            on_level=lambda n, st: print(f"  {n}: {st}", flush=True))
rc = validate(plant, sch, dt) if sch.batches else None
print(json.dumps({"case": name, "hint": hint_on, "time_limit": tl,
                  "v49": rh.metrics, "cpsat": rc.metrics if rc else None,
                  "cpsat_valid": rc.ok if rc else None, "violations": rc.by_rule() if rc else None,
                  "better": score(rc.metrics) < score(rh.metrics) if rc else None,
                  "seconds": round(time.time() - t0, 1)}))
if rc and not rc.ok:
    for v in rc.violations[:10]:
        print("  ", v)
