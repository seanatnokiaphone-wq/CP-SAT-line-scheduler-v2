"""CP-SAT model of the week (OR-Tools). Every plant rule is a constraint; P0-P6 are solved in order.

Time is in quarter hours (all plant data sits on 15-minute steps). Tanks are not numbered in the model:
each system's batches form at most |tanks| chains (AddMultipleCircuit), so identical tanks never create
duplicate solutions, and a chain arc i->j fixes the CIP between i and j (H5). Fill lines use one circuit
each, with fills that are not on that line skipped (H7).
"""
from __future__ import annotations

import math
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from .plant import (FILL_LINES, LINE_BY_ID, SYSTEMS, TARGET_WINDOW, TRIO_FILL_LEAD, TRIO_STAGGER, WEEK,
                    BatchTask, Downtime, FillTask, Plant, Schedule, cip_rule, lines_for, wash_hours)

U = 4  # model units per hour


def q(h: float) -> int:
    v = h * U
    if abs(v - round(v)) > 1e-6:
        raise ValueError(f"{h}h is not on a 15-minute step")
    return int(round(v))


@dataclass
class Settings:
    week_limit: float = 120.0
    goal: str = "fit"  # "fit" = P0 on (Most POs in week limit), "fast" = Fastest finish
    cip_mult: float = 1.0
    targets: dict = field(default_factory=dict)  # P2: starred fill id -> target start hour
    starred: list = field(default_factory=list)  # P1
    time_limit: float = 60.0
    workers: int = os.cpu_count() or 4
    horizon: float | None = None
    log: bool = False
    # Big weeks: only offer chain arcs between POs that sit within this many hours of each other in the
    # warm start (its own arcs are always kept). None = decide by size.
    prune_hours: float | None = None
    # "lex": one solve per level (small weeks). "staged": P2+P0+P3 in one weighted solve, then P4+P6 in a
    # second, because each solve of a 200-PO model spends ~15s in presolve. None = decide by size.
    mode: str | None = None
    big_week: int = 60
    # Planner steering (M1, M10, M11): pins fix a PO's start (and a fill's line, a batch's tank); POs not
    # pinned may not start before replan_from, so a mid-week re-plan only moves work that has not started.
    pins: dict = field(default_factory=dict)  # id -> {"start": h, "line": "F3", "tank": "T1A", "cip_start", "cip_end", "wash_start", "wash_end"}
    replan_from: float | None = None
    on_solution: object = None  # callback(seconds, level, objective, schedule) for live progress
    refine: bool | None = None  # big weeks: window refinement after the whole-week solve (None = by size)


LEVELS = ["P2 target misses", "P0 POs in week limit", "P1 starred fills", "P3 fills over hold limit",
          "P4 makespan", "P6 fill wait", "P6 CIP hours"]
LEVEL_SHARE = [0.05, 0.35, 0.05, 0.2, 0.15, 0.12, 0.08]


def _chains(tasks, attr) -> set:
    """Consecutive (prev, next) pairs on each tank or line of a schedule."""
    by = defaultdict(list)
    for t in tasks:
        by[getattr(t, attr)].append(t)
    out = set()
    for ts in by.values():
        ts.sort(key=lambda t: t.start)
        out |= {(a.id, b.id) for a, b in zip(ts, ts[1:])}
    return out


class WeekModel:
    def __init__(self, plant: Plant, downtime: list[Downtime], s: Settings, hint: Schedule | None = None):
        self.plant, self.downtime, self.s = plant, downtime, s
        m = self.m = cp_model.CpModel()
        B = {b.id: b for b in plant.batches}
        self.B = B
        hz = s.horizon or (max(s.week_limit, 72.0) + 0.5 * sum(b.duration for b in plant.batches) / 4)
        if hint:
            hz = max(hz, max([t.end for t in hint.batches] + [t.end for t in hint.fills]) + 24)
        H = self.H = math.ceil(hz) * U
        prune = s.prune_hours if s.prune_hours is not None else (36.0 if len(plant.batches) > s.big_week else None)
        self.near = lambda a, b: True
        keep = set()
        if hint and prune:
            pos = {t.id: t.start for t in hint.batches} | {t.id: t.start for t in hint.fills}
            self.near = lambda a, b: abs(pos[a] - pos[b]) <= prune
            for seq in (_chains(hint.batches, "tank"), _chains(hint.fills, "line")):
                keep |= seq
        self.keep = keep

        trios = defaultdict(list)
        for b in plant.batches:
            if b.trio_id:
                trios[b.trio_id].append(b)
        self.group = {b.id: [x.id for x in trios[b.trio_id]] if b.trio_id else [b.id] for b in plant.batches}
        fills_of = defaultdict(list)
        for f in plant.fills:
            fills_of[f.batch_id].append(f)
        self.fills_of = fills_of

        # ---- batches ----
        S, E, R, W, C, CI = {}, {}, {}, {}, {}, {}
        for b in plant.batches:
            p = q(b.duration)
            S[b.id] = m.NewIntVar(0, H, f"S_{b.id}")
            E[b.id] = m.NewIntVar(p, H + p, f"E_{b.id}")
            m.Add(E[b.id] == S[b.id] + p)
            R[b.id] = m.NewIntVar(0, 2 * H, f"R_{b.id}")
            W[b.id] = m.NewIntVar(0, H, f"W_{b.id}")  # CIP start
            C[b.id] = m.NewIntVar(0, q(wash_hours("deep", s.cip_mult)), f"C_{b.id}")  # CIP length
            m.Add(S[b.id] >= W[b.id] + C[b.id])
        for tid, ms in trios.items():  # H8: 1h stagger
            for j in range(1, len(ms)):
                m.Add(S[ms[j].id] == S[ms[0].id] + j * q(TRIO_STAGGER))

        # ---- fills ----
        Fs, Fe, V, WD, A = {}, {}, {}, {}, {}
        self.ready, self.due = {}, {}
        for f in plant.fills:
            d = q(f.duration)
            Fs[f.id] = m.NewIntVar(0, H, f"F_{f.id}")
            Fe[f.id] = m.NewIntVar(d, H + d, f"Fe_{f.id}")
            m.Add(Fe[f.id] == Fs[f.id] + d)
            V[f.id] = m.NewIntVar(0, H, f"V_{f.id}")  # line wash start
            WD[f.id] = m.NewIntVar(0, q(wash_hours("deep", s.cip_mult) + 3), f"WD_{f.id}")
            m.Add(Fs[f.id] >= V[f.id] + WD[f.id])
            members = self.group[f.batch_id]
            if len(members) > 1:  # H8: from 2h (or the fill's length) before the 3rd batch ends
                first, last = members[0], members[-1]
                ready = E[last] - q(min(TRIO_FILL_LEAD, f.duration))
                m.Add(Fs[f.id] >= E[first])
                m.Add(Fe[f.id] >= E[last])
                self.due[f.id] = E[last] + q(f.hold_max)
            else:  # H3
                ready = E[f.batch_id]
                self.due[f.id] = E[f.batch_id] + q(f.hold_max)
            m.Add(Fs[f.id] >= ready)
            self.ready[f.id] = ready
            A[f.id] = {}
            for l in lines_for(f.pack, f.system):  # H9, H10
                A[f.id][l] = m.NewBoolVar(f"A_{f.id}_{l}")
            m.AddExactlyOne(A[f.id].values())

        # H4: tank released when the batch (or whole trio) and all its fills are done
        for b in plant.batches:
            members = self.group[b.id]
            carrier = members[0]
            m.AddMaxEquality(R[b.id], [E[x] for x in members] + [Fe[f.id] for f in fills_of[carrier]])

        # H19: fills of one batch never overlap
        fiv = {f.id: m.NewIntervalVar(Fs[f.id], q(f.duration), Fe[f.id], f"iv_{f.id}") for f in plant.fills}
        for bid, fs in fills_of.items():
            if len(fs) > 1:
                m.AddNoOverlap([fiv[f.id] for f in fs])

        # ---- tanks: chains per system (H1, H4, H5) and one CIP skid (H6) ----
        self.tank_arcs = {}
        for sys, tanks in SYSTEMS.items():
            bs = [b for b in plant.batches if b.system == sys]
            if not bs:
                continue
            arcs, depot_out = [], []
            idx = {b.id: i + 1 for i, b in enumerate(bs)}
            for b in bs:
                lo = m.NewBoolVar(f"t0_{b.id}")
                arcs.append((0, idx[b.id], lo))
                depot_out.append(lo)
                m.Add(C[b.id] == 0).OnlyEnforceIf(lo)  # a clean tank needs no CIP
                m.Add(W[b.id] == S[b.id]).OnlyEnforceIf(lo)
                arcs.append((idx[b.id], 0, m.NewBoolVar(f"tE_{b.id}")))
                self.tank_arcs[(None, b.id)] = lo
            for i in bs:
                for j in bs:
                    if i.id == j.id or (i.trio_id and i.trio_id == j.trio_id):
                        continue
                    if (i.id, j.id) not in self.keep and not self.near(i.id, j.id):
                        continue
                    lit = m.NewBoolVar(f"t_{i.id}_{j.id}")
                    arcs.append((idx[i.id], idx[j.id], lit))
                    self.tank_arcs[(i.id, j.id)] = lit
                    c = q(wash_hours(cip_rule(i.sku, i.category, j.sku, j.category), s.cip_mult))
                    m.Add(C[j.id] == c).OnlyEnforceIf(lit)
                    m.Add(W[j.id] >= R[i.id]).OnlyEnforceIf(lit)
            m.AddMultipleCircuit(arcs)
            m.Add(sum(depot_out) <= len(tanks))
            civ = []
            for b in bs:
                has = m.NewBoolVar(f"hasC_{b.id}")
                m.Add(self.tank_arcs[(None, b.id)] + has == 1)
                Wend = m.NewIntVar(0, H + 12, f"We_{b.id}")
                civ.append(m.NewOptionalIntervalVar(W[b.id], C[b.id], Wend, has, f"cip_{b.id}"))
            m.AddNoOverlap(civ)  # H6

        # ---- fill lines: one circuit per line (H7, H10 pack change), stops (H14) ----
        down = defaultdict(list)
        for d in downtime:
            down[d.line].append(d)
        self.line_arcs = {}
        for line in FILL_LINES:
            fs = [f for f in plant.fills if line.id in A[f.id]]
            if not fs:
                continue
            idx = {f.id: i + 1 for i, f in enumerate(fs)}
            arcs = [(0, 0, m.NewBoolVar(f"empty_{line.id}"))]
            ivs = []
            for f in fs:
                a = A[f.id][line.id]
                arcs.append((idx[f.id], idx[f.id], a.Not()))
                lo = m.NewBoolVar(f"l0_{line.id}_{f.id}")
                arcs.append((0, idx[f.id], lo))
                arcs.append((idx[f.id], 0, m.NewBoolVar(f"lE_{line.id}_{f.id}")))
                m.Add(WD[f.id] == 0).OnlyEnforceIf(lo)
                m.Add(V[f.id] == Fs[f.id]).OnlyEnforceIf(lo)
                self.line_arcs[(line.id, None, f.id)] = lo
                ivs.append(m.NewOptionalIntervalVar(Fs[f.id], q(f.duration), Fe[f.id], a, f"ivl_{f.id}_{line.id}"))
                Vend = m.NewIntVar(0, H + 30, f"Ve_{f.id}_{line.id}")
                m.Add(Vend == V[f.id] + WD[f.id])
                ivs.append(m.NewOptionalIntervalVar(V[f.id], WD[f.id], Vend, a, f"wash_{f.id}_{line.id}"))
            for g in fs:
                for f in fs:
                    if g.id == f.id:
                        continue
                    if (g.id, f.id) not in self.keep and not self.near(g.id, f.id):
                        continue
                    lit = m.NewBoolVar(f"l_{line.id}_{g.id}_{f.id}")
                    arcs.append((idx[g.id], idx[f.id], lit))
                    self.line_arcs[(line.id, g.id, f.id)] = lit
                    e = wash_hours(cip_rule(g.sku, g.category, f.sku, f.category), s.cip_mult)
                    if line.pack_change and g.pack != f.pack:
                        e += line.pack_change
                    m.Add(WD[f.id] == q(e)).OnlyEnforceIf(lit)
                    m.Add(V[f.id] >= Fe[g.id]).OnlyEnforceIf(lit)
            m.AddCircuit(arcs)
            for d in down[line.id]:  # H14
                ivs.append(m.NewIntervalVar(q(d.start), q(d.end) - q(d.start), q(d.end), f"down_{d.id}"))
            m.AddNoOverlap(ivs)
            if line.weekly_max:  # H10: at most 3 fills a week
                wk_len = q(WEEK)
                weeks = range(H // wk_len + 2)
                inwk = defaultdict(list)
                for f in fs:
                    wv = m.NewIntVar(0, len(weeks), f"wk_{f.id}")
                    m.AddDivisionEquality(wv, Fs[f.id], wk_len)
                    for k in weeks:
                        bk = m.NewBoolVar(f"wk_{f.id}_{k}")
                        m.Add(wv == k).OnlyEnforceIf(bk)
                        m.Add(wv != k).OnlyEnforceIf(bk.Not())
                        both = m.NewBoolVar(f"wkA_{f.id}_{k}")
                        m.AddBoolAnd([bk, A[f.id][line.id]]).OnlyEnforceIf(both)
                        m.AddBoolOr([bk.Not(), A[f.id][line.id].Not()]).OnlyEnforceIf(both.Not())
                        inwk[k].append(both)
                for k, lits in inwk.items():
                    m.Add(sum(lits) <= line.weekly_max)
        # H11: F7 never fills alongside F5/F6. Cumulative: F7 takes 2, each 20 L fill takes 1, capacity 2.
        for line in FILL_LINES:
            if not line.excludes:
                continue
            mine = [f for f in plant.fills if line.id in A[f.id]]
            other = [f for f in plant.fills if any(x in A[f.id] for x in line.excludes)]
            if mine and other:
                ivs, dem = [], []
                for f in mine:
                    ivs.append(m.NewOptionalIntervalVar(Fs[f.id], q(f.duration), Fe[f.id], A[f.id][line.id], f"x_{f.id}"))
                    dem.append(2)
                for f in other:
                    ivs.append(fiv[f.id])
                    dem.append(1)
                m.AddCumulative(ivs, dem, 2)

        self.S, self.E, self.R, self.W, self.C, self.Fs, self.Fe, self.V, self.WD, self.A = S, E, R, W, C, Fs, Fe, V, WD, A
        self._steer(s)

        # ---- objective terms ----
        L = q(s.week_limit)
        self.late = {f.id: m.NewBoolVar(f"late_{f.id}") for f in plant.fills}
        for f in plant.fills:  # P3
            m.Add(Fe[f.id] <= self.due[f.id]).OnlyEnforceIf(self.late[f.id].Not())
        self.ok = {}
        for b in plant.batches:  # P0: an order counts when it all ends in the week limit and no fill is late
            ms = self.group[b.id]
            if ms[0] != b.id:
                continue
            ok = m.NewBoolVar(f"ok_{b.id}")
            self.ok[b.id] = (ok, len(ms))
            for x in ms:
                m.Add(E[x] <= L).OnlyEnforceIf(ok)
            for f in fills_of[ms[0]]:
                m.Add(Fe[f.id] <= L).OnlyEnforceIf(ok)
                m.AddImplication(ok, self.late[f.id].Not())
        self.mk = m.NewIntVar(0, 2 * H, "makespan")
        m.AddMaxEquality(self.mk, list(E.values()) + list(Fe.values()))
        self.miss = []
        for fid, tgt in s.targets.items():  # P2
            mv = m.NewIntVar(0, H, f"miss_{fid}")
            m.Add(mv >= Fs[fid] - q(tgt) - q(TARGET_WINDOW))
            m.Add(mv >= q(tgt) - q(TARGET_WINDOW) - Fs[fid])
            self.miss.append(mv)
        self.levels = [
            sum(self.miss) if self.miss else None,
            -sum(n * ok for ok, n in self.ok.values()) if s.goal == "fit" else None,
            sum(Fe[f] for f in s.starred) if s.starred else None,
            sum(self.late.values()),
            self.mk,
            sum(Fs[f.id] for f in plant.fills) - sum(self.ready[f.id] for f in plant.fills),
            sum(C.values()) + sum(WD.values()),
        ]
        if hint:
            self.add_hint(hint)

    # ---- planner steering: pinned POs (M11) and re-plan from a time (M1, M10) ----
    def _steer(self, s: Settings):
        m, pins = self.m, s.pins or {}
        rq = lambda h: int(round(h * U))  # pins from people may be off the quarter hour; round them
        for b in self.plant.batches:
            pin = pins.get(b.id)
            if pin and pin.get("start") is not None:
                m.Add(self.S[b.id] == rq(pin["start"]))
                if pin.get("cip_start") is not None and pin.get("cip_end") is not None:
                    m.Add(self.W[b.id] == rq(pin["cip_start"]))
                    m.Add(self.C[b.id] == rq(pin["cip_end"]) - rq(pin["cip_start"]))
            elif s.replan_from is not None:
                m.Add(self.S[b.id] >= rq(s.replan_from))
                m.Add(self.W[b.id] >= rq(s.replan_from))
        for f in self.plant.fills:
            pin = pins.get(f.id)
            if pin and pin.get("line"):
                if pin["line"] not in self.A[f.id]:
                    raise ValueError(f"{f.id} ({f.pack}) cannot run on {pin['line']} (H9/H10)")
                m.Add(self.A[f.id][pin["line"]] == 1)
            if pin and pin.get("start") is not None:
                m.Add(self.Fs[f.id] == rq(pin["start"]))
                if pin.get("wash_start") is not None and pin.get("wash_end") is not None:
                    m.Add(self.V[f.id] == rq(pin["wash_start"]))
                    m.Add(self.WD[f.id] == rq(pin["wash_end"]) - rq(pin["wash_start"]))
            elif s.replan_from is not None:
                m.Add(self.Fs[f.id] >= rq(s.replan_from))
                m.Add(self.V[f.id] >= rq(s.replan_from))
        self.tank_pin = {k: v["tank"] for k, v in pins.items() if v.get("tank")}

    # ---- warm start from another engine's schedule ----
    def add_hint(self, sch: Schedule):
        m = self.m
        sb = {t.id: t for t in sch.batches}
        sf = {t.id: t for t in sch.fills}
        for b in self.plant.batches:
            t = sb[b.id]
            m.AddHint(self.S[b.id], q(t.start))
            if t.cip_start is not None:
                m.AddHint(self.W[b.id], q(t.cip_start))
                m.AddHint(self.C[b.id], q(t.cip_end - t.cip_start))
        prev = {}
        by_tank = defaultdict(list)
        for t in sch.batches:
            by_tank[t.tank].append(t)
        for ts in by_tank.values():
            ts.sort(key=lambda t: t.start)
            for k, t in enumerate(ts):
                prev[t.id] = ts[k - 1].id if k else None
        for (i, j), lit in self.tank_arcs.items():
            m.AddHint(lit, prev.get(j, "x") == i)
        for f in self.plant.fills:
            t = sf[f.id]
            m.AddHint(self.Fs[f.id], q(t.start))
            for l, a in self.A[f.id].items():
                m.AddHint(a, l == t.line)
            if t.wash_start is not None:
                m.AddHint(self.V[f.id], q(t.wash_start))
                m.AddHint(self.WD[f.id], q(t.wash_end - t.wash_start))
        lprev = {}
        by_line = defaultdict(list)
        for t in sch.fills:
            by_line[t.line].append(t)
        for ts in by_line.values():
            ts.sort(key=lambda t: t.start)
            for k, t in enumerate(ts):
                lprev[t.id] = ts[k - 1].id if k else None
        for (l, g, f), lit in self.line_arcs.items():
            m.AddHint(lit, sf[f].line == l and lprev.get(f, "x") == g)

    def extract(self, solver) -> Schedule:
        v = solver.Value
        batches = []
        for sys, tanks in SYSTEMS.items():  # walk each chain from the depot; chain k runs on tank k
            succ = {i: j for (i, j), lit in self.tank_arcs.items() if i is not None and v(lit)}
            heads = sorted([j for (i, j), lit in self.tank_arcs.items()
                            if i is None and v(lit) and self.B[j].system == sys], key=lambda j: v(self.S[j]))
            # chain -> tank: a chain holding a tank-pinned batch keeps that tank (re-plans keep running POs
            # where they are); the other chains take the free tanks in start order
            chains = []
            for h in heads:
                c, j = [], h
                while j is not None:
                    c.append(j)
                    j = succ.get(j)
                chains.append(c)
            tank_of, free = {}, list(tanks)
            for k, c in enumerate(chains):
                pinned = next((self.tank_pin[x] for x in c if self.tank_pin.get(x) in free), None)
                if pinned:
                    tank_of[k] = pinned
                    free.remove(pinned)
            for k in range(len(chains)):
                if k not in tank_of:
                    tank_of[k] = free.pop(0)
            for k, c in enumerate(chains):
                for j in c:
                    has_cip = v(self.C[j]) > 0 or (self.tank_arcs.get((None, j)) is not None and not v(self.tank_arcs[(None, j)]))
                    batches.append(BatchTask(
                        id=j, tank=tank_of[k], start=v(self.S[j]) / U, end=v(self.E[j]) / U,
                        cip_start=v(self.W[j]) / U if has_cip else None,
                        cip_end=(v(self.W[j]) + v(self.C[j])) / U if has_cip else None))
        fills = []
        for f in self.plant.fills:
            line = next(l for l, a in self.A[f.id].items() if v(a))
            first = v(self.line_arcs[(line, None, f.id)])
            fills.append(FillTask(id=f.id, line=line, start=v(self.Fs[f.id]) / U, end=v(self.Fe[f.id]) / U,
                                  wash_start=None if first else v(self.V[f.id]) / U,
                                  wash_end=None if first else (v(self.V[f.id]) + v(self.WD[f.id])) / U))
        return Schedule(engine="cp-sat", batches=batches, fills=fills)


def _staged(wm: "WeekModel", plant: Plant):
    """Two weighted solves that keep the lexicographic order through weights larger than any lower level."""
    H, n_f, n_b = wm.H, len(plant.fills), len(plant.batches)
    lv = dict(zip(LEVELS, wm.levels))
    cip_ub = n_b * q(wash_hours("deep", wm.s.cip_mult)) + n_f * q(wash_hours("deep", wm.s.cip_mult) + 3) + 1
    wait_ub = n_f * 2 * H + 1
    k_mk = cip_ub * wait_ub
    top_terms, k = [], 1
    for name in ["P3 fills over hold limit", "P1 starred fills", "P0 POs in week limit", "P2 target misses"]:
        e = lv[name]
        if e is None:
            continue
        top_terms.append(k * e)
        k *= (n_f * 2 * H + 1) if name == "P1 starred fills" else (n_b + n_f + 1)
    first = ("P2/P0/P1/P3 (weighted)", sum(top_terms), 0.55)
    second = ("P4/P6 (weighted)", k_mk * lv["P4 makespan"] + cip_ub * lv["P6 fill wait"] + lv["P6 CIP hours"], 0.45)
    return [first, second]


class _Progress(cp_model.CpSolverSolutionCallback):
    """Reports each improved solution (at most every `every` seconds) with the schedule it describes."""

    def __init__(self, wm, level, t0, every=2.0):
        super().__init__()
        self.wm, self.level, self.t0, self.every, self.last = wm, level, t0, every, -1e9

    def on_solution_callback(self):
        now = time.time()
        if now - self.last < self.every:
            return
        self.last = now
        try:
            sch = self.wm.extract(self)
        except Exception:  # noqa: BLE001 - a half-built chain mid-search is not worth failing the solve for
            return
        self.wm.s.on_solution(round(now - self.t0, 1), self.level, self.ObjectiveValue(), sch)


def solve(plant: Plant, downtime: list[Downtime], s: Settings, hint: Schedule | None = None,
          on_level=None) -> Schedule:
    """Lexicographic solve: each level is optimised within its share of the time limit, then held."""
    t0 = time.time()
    wm = WeekModel(plant, downtime, s, hint)
    m = wm.m
    best = None
    statuses = {}
    levels = [(n, e, sh) for n, e, sh in zip(LEVELS, wm.levels, LEVEL_SHARE) if e is not None]
    mode = s.mode or ("staged" if len(plant.batches) > s.big_week else "lex")
    if mode == "staged":
        levels = _staged(wm, plant)
    total = sum(sh for *_, sh in levels)
    for k, (name, expr, share) in enumerate(levels):
        left = s.time_limit - (time.time() - t0)
        if left <= 0.5:
            break
        later = sum(sh for *_, sh in levels[k + 1:])
        budget = max(0.5, left * share / (share + later)) if k < len(levels) - 1 else left
        m.Minimize(expr)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = budget
        solver.parameters.num_workers = s.workers
        solver.parameters.log_search_progress = s.log
        st = solver.Solve(m, _Progress(wm, name, t0) if s.on_solution else None)
        statuses[name] = {"status": solver.StatusName(st), "value": solver.ObjectiveValue() if st in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
                          "bound": solver.BestObjectiveBound(), "seconds": round(solver.WallTime(), 1)}
        if on_level:
            on_level(name, statuses[name])
        if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            continue  # keep the last good schedule and its hint; try the next level with the time left
        best = wm.extract(solver)
        val = int(round(solver.ObjectiveValue()))
        m.Add(expr <= val)  # hold this level for the ones below
        # the whole solution becomes the next level's hint, so it starts from a feasible schedule
        m.ClearHints()
        sol = solver.ResponseProto().solution
        m.Proto().solution_hint.vars.extend(range(len(sol)))
        m.Proto().solution_hint.values.extend(sol)
    if best is None:
        return Schedule(engine="cp-sat", batches=[], fills=[], status="no solution", solve_seconds=time.time() - t0,
                        objective=statuses)
    best.status = "optimal" if all(x["status"] == "OPTIMAL" for x in statuses.values()) and len(statuses) == len(levels) else "feasible"
    best.solve_seconds = round(time.time() - t0, 1)
    best.objective = statuses
    return best
