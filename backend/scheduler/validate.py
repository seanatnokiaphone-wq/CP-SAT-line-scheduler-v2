"""Independent schedule checker. Written from the rule text; shares no code with the heuristic or solvers.

validate() returns every broken plant rule (H) with the POs involved, plus the priority metrics (P).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .plant import (EPS, LINE_BY_ID, TANK_SYSTEM, TARGET_WINDOW, TRIO_FILL_LEAD, TRIO_STAGGER, WEEK, Downtime,
                    Plant, Schedule, cip_rule, wash_hours)

TOL = 1e-4


@dataclass
class Violation:
    rule: str
    ids: list[str]
    text: str


@dataclass
class Report:
    violations: list[Violation] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.violations

    def by_rule(self) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for v in self.violations:
            out[v.rule] += 1
        return dict(out)


def _overlap(a0, a1, b0, b1) -> bool:
    return a0 < b1 - TOL and b0 < a1 - TOL


def validate(plant: Plant, sch: Schedule, downtime: list[Downtime], *, cip_mult: float = 1.0,
             week_limit: float = 120.0, targets: dict[str, float] | None = None) -> Report:
    rep = Report()
    bad = lambda rule, ids, text: rep.violations.append(Violation(rule, list(ids), text))  # noqa: E731
    targets = targets or {}
    B = {b.id: b for b in plant.batches}
    F = {f.id: f for f in plant.fills}
    sb = {t.id: t for t in sch.batches}
    sf = {t.id: t for t in sch.fills}

    # H13 / H2: every PO scheduled exactly once, every batch PO linked to a fill PO
    for ids, got, kind in ((B, sch.batches, "batch"), (F, sch.fills, "fill")):
        seen = [t.id for t in got]
        for i in set(ids) - set(seen):
            bad("H13", [i], f"{kind} PO {i} is missing from the schedule")
        for i in {x for x in seen if seen.count(x) > 1}:
            bad("H13", [i], f"{kind} PO {i} is scheduled more than once")
        for i in set(seen) - set(ids):
            bad("H13", [i], f"{i} is not in the order book")
    trios: dict[str, list] = defaultdict(list)
    for b in plant.batches:
        if b.trio_id:
            trios[b.trio_id].append(b)
    for b in plant.batches:
        first_of_trio = b.trio_id and trios[b.trio_id][0].id == b.id
        if (not b.trio_id or first_of_trio) and not b.fill_ids:
            bad("H2", [b.id], f"{b.id} has no fill PO")
    if any(v.rule == "H13" for v in rep.violations):
        return rep

    for b in plant.batches:
        t = sb[b.id]
        if abs(t.end - t.start - b.duration) > TOL:
            bad("H1", [b.id], f"{b.id} runs {t.end - t.start:.2f}h, not its {b.duration}h")
        if TANK_SYSTEM.get(t.tank) != b.system:  # H1
            bad("H1", [b.id], f"{b.id} (System {b.system}) is on tank {t.tank}")
    for f in plant.fills:
        t = sf[f.id]
        if abs(t.end - t.start - f.duration) > TOL:
            bad("H14", [f.id], f"{f.id} runs {t.end - t.start:.2f}h, not its {f.duration}h")
        line = LINE_BY_ID.get(t.line)
        if not line or f.pack not in line.packs or (line.systems and f.system not in line.systems):  # H9, H10
            bad("H10" if t.line == "F7" else "H9", [f.id], f"{f.id} ({f.pack}, System {f.system}) is on {t.line}")

    # Which batch's fills empty each tank: its own, or for a trio the first member's (H8)
    group_of = {}  # batch id -> list of member batch ids sharing a release
    for b in plant.batches:
        group_of[b.id] = [m.id for m in trios[b.trio_id]] if b.trio_id else [b.id]
    carrier = {b.id: group_of[b.id][0] for b in plant.batches}
    fills_of = defaultdict(list)
    for f in plant.fills:
        fills_of[f.batch_id].append(f)

    def ready_and_due(f):
        """Earliest start (H3/H8) and hold-limit due time (P3)."""
        members = group_of[f.batch_id]
        ends = [sb[m].end for m in members]
        if len(members) > 1:
            first, last = ends[0], ends[-1]
            return max(first, last - min(TRIO_FILL_LEAD, f.duration)), last + f.hold_max, last
        return ends[0], ends[0] + f.hold_max, ends[0]

    # H3, H8 fill timing; H19
    for f in plant.fills:
        t = sf[f.id]
        ready, _, last_end = ready_and_due(f)
        rule = "H8" if len(group_of[f.batch_id]) > 1 else "H3"
        if t.start < ready - TOL:
            bad(rule, [f.id, f.batch_id], f"{f.id} starts at {t.start:.2f}, before {ready:.2f}")
        if t.end < last_end - TOL:
            bad("H8", [f.id], f"{f.id} ends before the trio's last batch ends")
    for bid, fs in fills_of.items():
        for i, a in enumerate(fs):
            for c in fs[i + 1:]:
                if _overlap(sf[a.id].start, sf[a.id].end, sf[c.id].start, sf[c.id].end):
                    bad("H19", [a.id, c.id], f"{a.id} and {c.id} of {bid} fill at the same time")
    for tid, ms in trios.items():
        n = len(fills_of.get(ms[0].id, []))
        if len(ms) == 3 and n not in (1, 3):  # H8: a trio is filled by 1 or 3 fill POs, one at a time (H19)
            bad("H8", [m.id for m in ms], f"{tid} has {n} fill POs; a trio takes 1 or 3")
        s = [sb[m.id].start for m in ms]
        for j in range(1, len(s)):
            if abs(s[j] - s[0] - j * TRIO_STAGGER) > TOL:
                bad("H8", [m.id for m in ms], f"{tid} batches do not start 1h apart")
                break

    # Tanks: occupancy from CIP (or batch) start to release; H4, H5, H6
    release = {}
    for b in plant.batches:
        c = carrier[b.id]
        release[b.id] = max([sb[m].end for m in group_of[b.id]] + [sf[f.id].end for f in fills_of[c]])
    by_tank = defaultdict(list)
    for b in plant.batches:
        by_tank[sb[b.id].tank].append(b)
    for tank, bs in by_tank.items():
        bs.sort(key=lambda b: sb[b.id].start)
        for k, b in enumerate(bs):
            t = sb[b.id]
            if k == 0:
                if t.cip_start is not None and t.cip_end > t.start + TOL:
                    bad("H5", [b.id], f"{b.id} CIP ends after the batch starts")
                continue
            p = bs[k - 1]
            if t.cip_start is None:
                bad("H5", [b.id], f"{b.id} on {tank} has no CIP after {p.id}")
                continue
            need = wash_hours(cip_rule(p.sku, p.category, b.sku, b.category), cip_mult)
            if t.cip_end - t.cip_start < need - TOL:
                bad("H5", [b.id], f"{b.id} CIP is {t.cip_end - t.cip_start:.2f}h, needs {need}h after {p.id}")
            if t.cip_start < release[p.id] - TOL:
                bad("H4", [p.id, b.id], f"{tank}: CIP for {b.id} starts at {t.cip_start:.2f} before {p.id}'s "
                                        f"tank is emptied at {release[p.id]:.2f}")
            if t.start < t.cip_end - TOL:
                bad("H5", [b.id], f"{b.id} starts before its CIP ends")
    for sys in (1, 2, 3, 4):
        cips = sorted([(sb[b.id].cip_start, sb[b.id].cip_end, b.id) for b in plant.batches
                       if b.system == sys and sb[b.id].cip_start is not None])
        for i in range(1, len(cips)):
            if cips[i][0] < cips[i - 1][1] - TOL:
                bad("H6", [cips[i - 1][2], cips[i][2]], f"System {sys} skid washes two tanks at once")

    # Lines: H7 washes, H10 pack change and weekly cap, H11, H14
    by_line = defaultdict(list)
    for f in plant.fills:
        by_line[sf[f.id].line].append(f)
    down = defaultdict(list)
    for d in downtime:
        down[d.line].append(d)
    for line_id, fs in by_line.items():
        line = LINE_BY_ID[line_id]
        fs.sort(key=lambda f: sf[f.id].start)
        for k, f in enumerate(fs):
            t = sf[f.id]
            if k:
                p = fs[k - 1]
                pt = sf[p.id]
                if t.start < pt.end - TOL:
                    bad("H7", [p.id, f.id], f"{line_id} runs {p.id} and {f.id} at once")
                need = wash_hours(cip_rule(p.sku, p.category, f.sku, f.category), cip_mult)
                if line.pack_change and p.pack != f.pack:
                    need += line.pack_change
                ws, we = (t.wash_start, t.wash_end) if t.wash_start is not None else (t.start, t.start)
                if we - ws < need - TOL or ws < pt.end - TOL or t.start < we - TOL:
                    bad("H10" if line.pack_change and p.pack != f.pack else "H7", [p.id, f.id],
                        f"{line_id}: wash before {f.id} needs {need}h after {p.id} ends")
                for d in down[line_id]:
                    if t.wash_start is not None and _overlap(t.wash_start, t.wash_end, d.start, d.end):
                        bad("H14", [f.id, d.id], f"{line_id} washes during stop {d.id}")
            for d in down[line_id]:
                if _overlap(t.start, t.end, d.start, d.end):
                    bad("H14", [f.id, d.id], f"{f.id} fills on {line_id} during stop {d.id}")
        if line.weekly_max:
            weeks = defaultdict(list)
            for f in fs:
                weeks[int((sf[f.id].start + EPS) // WEEK)].append(f.id)
            for wk, ids in weeks.items():
                if len(ids) > line.weekly_max:
                    bad("H10", ids, f"{line_id} has {len(ids)} fills in week {wk + 1} (max {line.weekly_max})")
        for other in line.excludes:
            for f in fs:
                for g in by_line.get(other, []):
                    if _overlap(sf[f.id].start, sf[f.id].end, sf[g.id].start, sf[g.id].end):
                        bad("H11", [f.id, g.id], f"{line_id} fills while {other} fills")

    # H12 volumes; H15 maintenance on twins
    for b in plant.batches:
        if fills_of[b.id]:
            src = len(group_of[b.id]) * b.volume_l
            tot = sum(f.volume_l for f in fills_of[b.id])
            if abs(tot - src) > len(fills_of[b.id]):
                bad("H12", [b.id], f"{b.id} fills split {tot} L of {src} L")
    pm = [d for d in downtime if d.kind == "scheduled"]
    for i, a in enumerate(pm):
        for c in pm[i + 1:]:
            if LINE_BY_ID[a.line].twin == c.line and _overlap(a.start, a.end, c.start, c.end):
                bad("H15", [a.id, c.id], f"{a.line} and {c.line} are both in maintenance")

    # ---- Priority metrics ----
    over = []
    wait = 0.0
    for f in plant.fills:
        ready, due, _ = ready_and_due(f)
        if sf[f.id].end > due + TOL:
            over.append(f.id)
        wait += sf[f.id].start - ready
    fit = 0
    seen = set()
    for b in plant.batches:
        if b.id in seen:
            continue
        ms = group_of[b.id]
        seen.update(ms)
        fs = fills_of[ms[0]]
        end = max([sb[m].end for m in ms] + [sf[f.id].end for f in fs])
        if end <= week_limit + TOL and not any(f.id in over for f in fs):
            fit += len(ms)
    miss = sum(max(0.0, abs(sf[fid].start - tgt) - TARGET_WINDOW) for fid, tgt in targets.items())
    tank_cip = sum(t.cip_end - t.cip_start for t in sch.batches if t.cip_start is not None)
    line_cip = sum(t.wash_end - t.wash_start for t in sch.fills if t.wash_start is not None)
    rep.metrics = {
        "pos_in_week_limit": fit, "batch_pos": len(plant.batches),
        "fills_over_hold_limit": len(over),
        "makespan": max([t.end for t in sch.batches] + [t.end for t in sch.fills]),
        "fill_wait_h": round(wait, 2), "tank_cip_h": round(tank_cip, 2), "line_cip_h": round(line_cip, 2),
        "cip_h": round(tank_cip + line_cip, 2), "target_miss_h": round(miss, 2),
    }
    return rep


def score(metrics: dict, goal: str = "fit") -> tuple:
    """Lexicographic score, lower is better: P2, P0, P3, P4, P6 wait, P6 CIP hours (v49's order)."""
    return (round(metrics["target_miss_h"], 3), -metrics["pos_in_week_limit"] if goal == "fit" else 0,
            metrics["fills_over_hold_limit"], round(metrics["makespan"], 3), round(metrics["fill_wait_h"], 2),
            round(metrics["cip_h"], 2))
