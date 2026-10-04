"""Benchmark: plain CP-SAT for TL seconds vs CP-SAT for TL/2 then window refinement for TL/2."""
import json, sys, time
from scheduler.cpsat import Settings
from scheduler.generator import generate_plant
from scheduler.optimise import optimise
from scheduler.plant import default_maintenance
from scheduler.refine import refine_windows
from scheduler.validate import validate

TL = float(sys.argv[1]); dt = default_maintenance()
for spec in sys.argv[2:]:
    seed, n = map(int, spec.split(":"))
    p = generate_plant(seed, n)
    a, _ = optimise(p, dt, Settings(time_limit=TL))
    ma = validate(p, a, dt).metrics
    b, _ = optimise(p, dt, Settings(time_limit=TL / 2))
    b2, info = refine_windows(p, dt, Settings(), b, TL / 2)
    mb = validate(p, b2, dt)
    print(json.dumps({"week": spec, "plain": [ma[k] for k in ("pos_in_week_limit", "fills_over_hold_limit", "makespan", "fill_wait_h")],
                      "windows": [mb.metrics[k] for k in ("pos_in_week_limit", "fills_over_hold_limit", "makespan", "fill_wait_h")],
                      "valid": mb.ok, **info}), flush=True)
