"""Optimise a set of weeks and write viewer data (plant, downtime, heuristic and CP-SAT schedules, metrics).

python3 tools/viewer/export_weeks.py OUT.json 60 42:30 42:100 42:200 ...
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from scheduler.cpsat import Settings  # noqa: E402
from scheduler.generator import generate_plant  # noqa: E402
from scheduler.heuristic import best_heuristic  # noqa: E402
from scheduler.optimise import optimise  # noqa: E402
from scheduler.plant import default_maintenance  # noqa: E402
from scheduler.validate import validate  # noqa: E402

out, tl, specs = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
dt = default_maintenance()
weeks = json.loads(Path(out).read_text()) if Path(out).exists() else []
done = {(w["seed"], w["pos"]) for w in weeks}
for spec in specs:
    seed, n = map(int, spec.split(":"))
    if (seed, n) in done:
        continue
    plant = generate_plant(seed, n)
    heur = best_heuristic(plant, dt)
    best, info = optimise(plant, dt, Settings(time_limit=tl))
    w = {"seed": seed, "pos": n, "timeLimit": tl, "seconds": info["seconds"],
         "plant": json.loads(plant.model_dump_json(by_alias=True)),
         "downtime": [json.loads(d.model_dump_json(by_alias=True)) for d in dt],
         "engines": {}}
    for name, sch in (("v49", heur), ("cpsat", best)):
        rep = validate(plant, sch, dt)
        w["engines"][name] = {"engine": sch.engine, "valid": rep.ok, "metrics": rep.metrics,
                              "schedule": json.loads(sch.model_dump_json(by_alias=True, include={"batches", "fills"}))}
    weeks.append(w)
    Path(out).write_text(json.dumps(weeks))
    print(spec, w["engines"]["v49"]["metrics"]["pos_in_week_limit"], "->", w["engines"]["cpsat"]["metrics"]["pos_in_week_limit"], flush=True)
