# Changelog

## 0.5.0 (2026-10-05)
Roadmap items 2-7 approved by Sean (2026-10-04 22:39 UTC); item 1, real plant data, skipped for now.
- Live app: FastAPI backend (`backend/app/main.py`) and a Vite + React + Tailwind front end (`frontend/`). Generate or open a week, press Optimise, and the Gantt updates live as better plans are found; stop at any time and keep the best plan. Plans are checked by the rule checker and saved under `backend/data/`.
- The viewer's Gantt, KPIs, PO data grid and Compare panel are now a component the app mounts (`frontend/src/viewer/viewer.js`); any two plans can be compared.
- Planner steering: pin a PO's time and tank/line or just its tank/line (M11, by Claude), mark fills urgent (P1) or give a target start (P2), and re-plan from a time, keeping work already started (M1, M10). Pins, stars and the re-plan time are drawn on the Gantt.
- Explain: every batch PO outside the week limit (P0) and every fill past its hold limit (P3) gets its reasons, naming the line, tank, PO or stop that held it back; trios that cannot meet the hold limit in any plan at the S14 rates are flagged. Critical path with what set each step.
- What-if scenarios: line speed, no planned maintenance, longer hold limit, quicker CIP, or your own; each is compared with a base plan and the best is marked.
- Faster big weeks: all CPU cores, then 48h window passes after the whole-week solve (more POs in the week limit on 200-PO weeks).
- Exports: Excel (summary, by line, by tank, batch and fill POs) and a black-and-white PDF for the floor (Gantt and run sheets with a Done column). Weeks save and open as JSON.

## 0.4.0 (2026-10-04)
- Rule S14 (Sean, 19:53 UTC): fill route time = volume / filler rate for the pack, ±10%, rounded to the half hour. Rates are Claude's typical figures (`plant.FILL_RATE_LPH`) until the plant's are known. `fill_time="random"` keeps v49's 0.5-3h draw; parity tests use it.
- Viewer: weeks re-optimised with rate-based fill times; PO data shows each fill's rate in L/h.

## 0.3.1 (2026-10-04)
- Viewer: Compare shows "Where the plans differ": the best plan (first priority that differs, P0, P3, P4, P6) and the top 3 differences with where they happen and the POs involved.
- Viewer: PO labels on the bars: off, PO number, or PO number + SKU (from Sean's comment on the artifact).
- Viewer weeks re-optimised with 3-fill trios (H8).

## 0.3.0 (2026-10-04)
- Rule H8 changed (Sean, 19:24 UTC): a System 1 trio is filled by 1 or 3 fill POs, one at a time, together emptying all three tanks in possibly different quantities. Recorded in `RULES.md`.
- Generator: `trio_three_fill_pct` (default 25, by Claude) draws 3-fill trios; 0 reproduces v49 weeks exactly (parity tests use it).
- Rule checker flags a trio with a fill count other than 1 or 3 (H8); overlapping trio fills were already H19.
- v49 heuristic port: the next fill of a trio now starts when the previous one ends (was 2h overlap) and counts its hold limit from the 3rd batch.
- CP-SAT model unchanged: its H8 timing, H19 no-overlap and H4 hold already cover several fills per trio.
- Viewer: weeks re-exported with 3-fill trios; critical path names "Trio fills run one at a time (H8)".

## Base Project (2026-10-04)
- Snapshot of v0.2.2 saved as the Base Project: generator, rule checker, v49 heuristic port, CP-SAT optimiser and the schedule viewer. Branch `base-project` on GitHub points here.

## 0.2.2 (2026-10-04)
- Viewer: v49 Gantt features ported. Batch-to-fill links (all, or on hover) that light up a PO's batch, trio, CIP, wash and fills; click to pin. Toolbar: critical path (with what held each step back), hover info on/off, week-limit or plan-only window, zoom and fit, show/hide and collapse per system and fill lines, S1-S4 highlights with their links, batches with 2+ fills, tank status strip and pinned tank status bar. Minor/standard/deep CIP and washes drawn as separate hatches.
- Viewer: PO data page with sortable, searchable grids of batch POs, fill POs and product SKUs, filtered by category and system; clicking a row opens it on the Gantt.

## 0.2.1 (2026-10-04)
- Viewer: `tools/viewer` exports optimised weeks (`export_weeks.py`) and builds a single-page Gantt (`build.py` + `template.html`) comparing CP-SAT and v49 plans, with P0/P3/P4/P6 scores and H4/H14 markings. Published as an artifact; the page shows precomputed plans and does not run the solver.

## 0.2.0 (2026-10-04)
- v49's dispatch heuristic and strategy search ported to Python (`heuristic.py`); reproduces v49's best schedule
  (same tanks, lines and start times) on all 43 golden weeks.
- `optimise()` runs the whole solve in Python: heuristic warm start, CP-SAT in the time left, validator, best result.
  Node is now only needed to regenerate golden files. Seed 42, 200 POs, 60s: 182 POs in week limit, 1 over hold limit.

## 0.1.0 (2026-10-04)
- Seeded generator ported from v49; matches v49 on 43 golden weeks (10 to 200 POs, order mix, run times, trios, double fills).
- Independent validator for H1-H15 and H19, plus P0/P3/P4/P6 metrics; agrees with v49 on all 43 weeks; one test per rule.
- CP-SAT model of the week (tank chains, skid, line circuits with washes, downtime, F7 cap and exclusion, trios, hold limits).
  Lexicographic solve for up to 60 POs; two weighted stages plus arc pruning around the warm start for bigger weeks.
- Warm start is v49's own heuristic schedule (from the golden files); the Python heuristic port comes next.
