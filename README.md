# CP-SAT-line-scheduler-v2

Rebuild of the v49 single-file React scheduler as Python optimiser + FastAPI + Vite. Design:
https://claude.ai/code/artifact/f67d2fec-344c-4b2f-940f-d1c5c2e66ab2

This first version is the optimiser core only (no API or screens yet). Solver: Google OR-Tools CP-SAT
(Sean, 2026-10-04: no Gurobi key yet).

## Run

```
cd backend
python3 -m pip install ortools pydantic pytest
python3 -m pytest -q                         # generator parity, one test per H rule, CP-SAT checks
python3 run_optimise.py 42 200 60            # generate a week and optimise it (heuristic + CP-SAT), 60s
python3 run_compare.py s42_n200 60           # CP-SAT vs v49 heuristic on a golden week, 60s
python3 bench.py s1_n30,s42_n100 60 out.jsonl
```

Golden weeks (`backend/tests/golden`) come from v49's own engine: `cd tools/v49-golden && node golden.mjs`.

## Layout

- `backend/scheduler/plant.py` plant constants, rule-tagged models
- `backend/scheduler/rng.py`, `generator.py` seeded generator, bit-exact with v49
- `backend/scheduler/validate.py` independent H-rule checker and P metrics, `score()` = P2, P0, P3, P4, P6
- `backend/scheduler/cpsat.py` CP-SAT week model and lexicographic / staged solve
- `backend/scheduler/heuristic.py` v49 dispatch heuristic and strategy search, ported
- `backend/scheduler/optimise.py` heuristic + CP-SAT + validator in one call
- `backend/scheduler/v49.py` loads v49 heuristic schedules (warm start and baseline)
