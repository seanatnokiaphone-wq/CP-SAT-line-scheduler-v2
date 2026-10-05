# CP-SAT-line-scheduler-v2

Rebuild of the v49 single-file React scheduler as Python optimiser + FastAPI + Vite. Design:
https://claude.ai/code/artifact/f67d2fec-344c-4b2f-940f-d1c5c2e66ab2

Solver: Google OR-Tools CP-SAT (Sean, 2026-10-04: no Gurobi key yet).

## Run the app

```
python3 -m pip install ortools pydantic fastapi uvicorn openpyxl reportlab
cd frontend && npm install && npm run build && cd ..
cd backend && python3 -m uvicorn app.main:app --port 8000
```

Open http://localhost:8000. For front-end work run the API as above and `cd frontend && npm run dev`
(http://localhost:5173, `/api` is proxied to port 8000). Weeks and plans are kept in `backend/data/`
(or `LS_DATA_DIR`). One solve runs at a time and uses every core.

In the app: **New week** generates a week (v49 generator by seed), **Optimise** solves it live,
**Steer** pins POs, marks urgent fills and re-plans from a time, **Explain** gives the reasons for every
late or missed PO, **What-if** runs scenarios, **Export** gives Excel, PDF and the week file.

## Run

```
cd backend
python3 -m pip install ortools pydantic pytest fastapi httpx openpyxl reportlab
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
- `backend/scheduler/steering.py` pins (M11) and re-plan from a time (M1, M10)
- `backend/scheduler/refine.py` 48h window passes for big weeks
- `backend/scheduler/scenarios.py` what-if scenarios and their comparison
- `backend/scheduler/explain.py` reasons for late and missed POs, critical path
- `backend/scheduler/exports.py` Excel and PDF
- `backend/app/main.py` FastAPI: weeks, plans, optimise and scenario jobs with live progress (SSE)
- `frontend/` Vite + React + Tailwind app; `src/viewer/viewer.js` is the Gantt viewer from `tools/viewer`

Rule changes since v49 are recorded in `RULES.md`.
