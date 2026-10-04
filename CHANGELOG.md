# Changelog

## 0.1.0 (2026-10-04)
- Seeded generator ported from v49; matches v49 on 43 golden weeks (10 to 200 POs, order mix, run times, trios, double fills).
- Independent validator for H1-H15 and H19, plus P0/P3/P4/P6 metrics; agrees with v49 on all 43 weeks; one test per rule.
- CP-SAT model of the week (tank chains, skid, line circuits with washes, downtime, F7 cap and exclusion, trios, hold limits).
  Lexicographic solve for up to 60 POs; two weighted stages plus arc pruning around the warm start for bigger weeks.
- Warm start is v49's own heuristic schedule (from the golden files); the Python heuristic port comes next.
