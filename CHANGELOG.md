# Changelog

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
