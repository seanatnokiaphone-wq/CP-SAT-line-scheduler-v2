"""Plain-language explanations of a schedule for the plant planner.

explain() answers two questions about a plan:
  * What sets the finish time? The critical path walks back from the last task to finish, following whatever
    held each task back (a port of the viewer's critical() in tools/viewer/template.html).
  * Why is a batch PO outside the week limit (P0), or a fill PO over its hold limit (P3)? Each PO gets a
    list of reasons naming the concrete blocker (line, tank, other PO, from when to when) and any structural
    impossibility, such as fills that need more time back to back than the hold limit allows.

Ready time, due time and the "in week limit" count follow validate.py's ready_and_due() so the numbers here
match the validator's metrics. Times are hours from Monday 07:00.
"""
from __future__ import annotations

import math
from collections import defaultdict

from .plant import (LINE_BY_ID, PACK_LABEL, TRIO_FILL_LEAD, TRIO_STAGGER, WEEK, Downtime, Plant,
                    Schedule, cip_rule, lines_for)

E = 1e-3  # the viewer's tolerance for "touching" times
TOL = 1e-4  # validate.py's tolerance for late / outside the week limit
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
CIP_WORD = {"minor": "minor flush", "standard": "standard CIP", "deep": "deep CIP"}
F7_CAP_MSG = "F7 cap: the 3 fills allowed in the week before are used (H10)"


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def clock(h: float) -> str:
    """Hours from Monday 07:00 as a shop-floor clock, e.g. clock(21.5) == "Tue 04:30" (the viewer's clock())."""
    m = _js_round((7 + h) * 60)  # whole minutes from Monday 00:00; rounding first never shows "24:00"
    d, m = divmod(m, 24 * 60)
    hh, mm = divmod(m, 60)
    return f"{DAYS[d % 7]}{' wk2' if d >= 7 else ''} {hh:02d}:{mm:02d}"


def _h(x: float) -> str:
    """Hours for text: 1.5h, 2h."""
    return f"{round(x, 2):g}h"


class _Plan:
    """The viewer's derive(): links, ready/due times, tank release times, wash rules."""

    def __init__(self, plant: Plant, sch: Schedule, downtime: list[Downtime]):
        self.plant, self.sch, self.downtime = plant, sch, list(downtime)
        self.sb = {t.id: t for t in sch.batches}
        self.sf = {t.id: t for t in sch.fills}
        self.pb = {b.id: b for b in plant.batches}
        self.pf = {f.id: f for f in plant.fills}
        trios: dict[str, list[str]] = defaultdict(list)
        for b in plant.batches:
            if b.trio_id:
                trios[b.trio_id].append(b.id)
        self.trios = dict(trios)
        self.fills_of: dict[str, list[str]] = defaultdict(list)
        for f in plant.fills:
            self.fills_of[self.group(f.batch_id)[0]].append(f.id)
        self.release = {b.id: self.sb[b.id].end for b in plant.batches}
        self.info = {}
        for f in plant.fills:
            ms = self.group(f.batch_id)
            ends = [self.sb[m].end for m in ms]
            last = ends[-1]  # validate.py: hold limit counts from the trio's 3rd batch
            ready = max(ends[0], last - min(TRIO_FILL_LEAD, f.duration)) if len(ms) > 1 else ends[0]
            due = last + f.hold_max
            by = ms[0]
            for m in ms:
                if self.sb[m].end > self.sb[by].end:
                    by = m
            t = self.sf[f.id]
            self.info[f.id] = {"ready": ready, "due": due, "wait": t.start - ready, "by": by,
                               "late": max(0.0, t.end - due)}
            for m in ms:
                self.release[m] = max(self.release[m], t.end)
        self.by_line: dict[str, list] = defaultdict(list)
        for t in sch.fills:
            self.by_line[t.line].append(t)
        for arr in self.by_line.values():
            arr.sort(key=lambda t: t.start)
        self.wash_rule: dict[str, str] = {}
        self.prev_on_line: dict[str, str | None] = {}
        for line_id, arr in self.by_line.items():
            line = LINE_BY_ID.get(line_id)
            for i, t in enumerate(arr):
                p = arr[i - 1] if i else None
                self.prev_on_line[t.id] = p.id if p else None
                if t.wash_start is None:
                    continue
                a = self.pf[t.id]
                r = cip_rule(self.pf[p.id].sku, self.pf[p.id].category, a.sku, a.category) if p else "standard"
                pack = bool(p and line and line.pack_change and self.pf[p.id].pack != a.pack)
                self.wash_rule[t.id] = r + "+pack" if pack else r
        self.by_tank: dict[str, list] = defaultdict(list)
        for t in sch.batches:
            self.by_tank[t.tank].append(t)
        for arr in self.by_tank.values():
            arr.sort(key=lambda t: t.start)
        self.trio_pos = {m: i + 1 for ms in self.trios.values() for i, m in enumerate(ms)}
        f7_week = lambda h: math.floor(h / WEEK)  # noqa: E731
        self.f7_week = f7_week
        self.f7_count: dict[int, int] = defaultdict(int)
        for t in self.by_line.get("F7", []):
            self.f7_count[f7_week(t.start)] += 1

    def group(self, bid: str) -> list[str]:
        b = self.pb[bid]
        return self.trios[b.trio_id] if b.trio_id else [bid]

    def f7_blocked(self, t) -> bool:
        """The viewer's test: an F7 fill in week 2+ when the week before already had its 3 fills (H10)."""
        w = self.f7_week(t.start)
        return t.line == "F7" and w > 0 and self.f7_count.get(w - 1, 0) >= (LINE_BY_ID["F7"].weekly_max or 3)

    def stop_at(self, line: str, h: float):
        return next((z for z in self.downtime if z.line == line and abs(z.end - h) < E), None)

    def wash_text(self, fid: str) -> str:
        r = self.wash_rule.get(fid, "")
        t = self.sf[fid]
        hrs = _h(t.wash_end - t.wash_start) if t.wash_start is not None else ""
        if r.endswith("+pack"):
            return f"a {CIP_WORD[r[:-5]]} plus pack change ({hrs}, H7, H10)"
        return f"a {CIP_WORD.get(r, 'wash')} ({hrs}, H7)"


# ---------- critical path ----------

def _step(d: _Plan, kind: str, t):
    """One step of the viewer's critical(): what held this task back, and the task that did it."""
    step = {"id": t.id, "kind": "batch" if kind == "b" else "fill", "where": t.tank if kind == "b" else t.line,
            "start": t.start, "end": t.end, "start_clock": clock(t.start), "end_clock": clock(t.end),
            "rule": "", "reason": "", "blocked_by": None}
    nxt = None
    if kind == "f":
        f, i = t, d.info[t.id]
        arr = d.by_line[f.line]
        pos = arr.index(f)
        prev = arr[pos - 1] if pos > 0 else None
        gate = f.wash_start if f.wash_start is not None else f.start
        grp = d.group(d.pf[f.id].batch_id)
        sib = next((d.sf[x] for x in d.fills_of.get(grp[0], []) if x != f.id and abs(d.sf[x].end - f.start) < E),
                   None)
        if sib is not None and len(grp) > 1:
            nxt = ("f", sib)
            step["rule"] = "H8"
            step["reason"] = (f"Trio fills run one at a time (H8): starts when {sib.id} on {sib.line} ends at "
                              f"{clock(sib.end)}")
        elif abs(f.start - i["ready"]) < E:
            nxt = ("b", d.sb[i["by"]])
            by = d.sb[i["by"]]
            if len(grp) > 1:
                step["rule"] = "H8"
                step["reason"] = (f"Waits on trio batches (H8): may start {_h(by.end - f.start)} before the 3rd "
                                  f"batch {by.id} on {by.tank} ends at {clock(by.end)}")
            else:
                step["rule"] = "H3"
                step["reason"] = f"Waits on parent batch (H3): {by.id} on {by.tank} ends at {clock(by.end)}"
        elif prev is not None and abs(prev.end - gate) < E:
            nxt = ("f", prev)
            pack = d.wash_rule.get(f.id, "").endswith("+pack")
            step["rule"] = "H10" if pack else "H7"
            msg = f"Waits on {f.line}: busy with {prev.id} until {clock(prev.end)}"
            step["reason"] = msg + (f", then {d.wash_text(f.id)}" if f.wash_start is not None else " (H7)")
        elif d.stop_at(f.line, gate) or d.stop_at(f.line, f.start):
            z = d.stop_at(f.line, gate) or d.stop_at(f.line, f.start)
            step["rule"] = "H14"
            step["reason"] = (f"Waits on planned stop on {f.line} (H14): {z.reason or 'stop'} {z.id} from "
                              f"{clock(z.start)} to {clock(z.end)}")
            nxt = ("f", prev) if prev is not None else None
        elif d.f7_blocked(f):
            w = d.f7_week(f.start)
            step["rule"] = "H10"
            step["reason"] = f"{F7_CAP_MSG}: F7 already has {d.f7_count.get(w - 1, 0)} fills in week {w}"
        else:
            step["rule"] = "P0-P6"
            step["reason"] = (f"Placed later by the solver (no single blocker): ready at {clock(i['ready'])}, "
                              f"started {clock(f.start)}")
            nxt = ("f", prev) if prev is not None and prev.end > i["ready"] else ("b", d.sb[i["by"]])
    else:
        b = t
        arr = d.by_tank[b.tank]
        pos = arr.index(b)
        prev = arr[pos - 1] if pos > 0 else None
        tp = d.trio_pos.get(b.id, 0)
        pm = d.group(b.id)[tp - 2] if tp > 1 else None
        if pm and abs(d.sb[pm].start + TRIO_STAGGER - b.start) < E:
            nxt = ("b", d.sb[pm])
            step["rule"] = "H8"
            step["reason"] = (f"Trio 1h stagger (H8): starts 1h after {pm} on {d.sb[pm].tank} "
                              f"({clock(d.sb[pm].start)})")
        elif prev is not None and b.cip_start is not None and abs(b.cip_end - b.start) < E:
            word = CIP_WORD.get(b.cip_rule or "", "CIP")
            if abs(d.release[prev.id] - b.cip_start) < E:
                fills = [d.sf[x] for x in d.fills_of.get(d.group(prev.id)[0], [])]
                last = max(fills, key=lambda x: x.end) if fills else None
                nxt = ("f", last) if last is not None and last.end > prev.end + E else ("b", prev)
                what = f"its last fill {last.id} on {last.line}" if nxt[0] == "f" else f"batch {prev.id}"
                step["rule"] = "H4"
                step["reason"] = (f"Waits on {b.tank} CIP after its last fill (H4): tank held by {prev.id} until "
                                  f"{what} ended at {clock(d.release[prev.id])}, then a {word} of "
                                  f"{_h(b.cip_end - b.cip_start)} (H5)")
            else:
                sys = d.pb[b.id].system
                other = next((x for x in d.sch.batches if d.pb[x.id].system == sys and x.cip_end is not None
                              and abs(x.cip_end - b.cip_start) < E), None)
                nxt = ("b", other) if other is not None else ("b", prev)
                step["rule"] = "H6"
                busy = (f": busy washing {other.tank} for {other.id} until {clock(other.cip_end)}"
                        if other is not None else f" (tank free from {clock(d.release[prev.id])})")
                step["reason"] = (f"Waits on System {sys} CIP skid (H6){busy}, then a {word} of "
                                  f"{_h(b.cip_end - b.cip_start)}")
        elif b.start < E:
            step["reason"] = "Plan start (Mon 07:00)"
        elif tp == 1 and _trio_gate(d, b) is not None:
            m, why, text, nxt = _trio_gate(d, b)
            step["rule"] = "H8"
            step["reason"] = (f"Trio {d.pb[b.id].trio_id} starts its three tanks 1h apart (H8): member {m} could not "
                              f"start on {d.sb[m].tank} before {clock(d.sb[m].start)}, as {text}")
        elif any(d.f7_blocked(d.sf[x]) for x in d.fills_of.get(d.group(b.id)[0], [])):
            step["rule"] = "H10"
            step["reason"] = ("Held back so its F7 fill, pushed to next week by the F7 cap (H10), stays inside the "
                              "hold limit (P3)")
        else:
            step["rule"] = "P0-P6"
            step["reason"] = "Placed later by the solver (no single blocker)"
            free = d.release[prev.id] if prev is not None else 0.0
            if b.cip_end is not None:
                free = max(free, b.cip_end)
            step["reason"] += f": {b.tank} was free from {clock(free)}"
            # Often the batch is timed so its first fill starts the moment its line comes free (keeps P3).
            fills = sorted((d.sf[x] for x in d.fills_of.get(d.group(b.id)[0], [])), key=lambda x: x.start)
            first = fills[0] if fills else None
            if first is not None and abs(first.start - d.info[first.id]["ready"]) < E:
                lp = d.prev_on_line.get(first.id)
                if lp is not None:
                    lt = d.sf[lp]
                    gate = first.wash_start if first.wash_start is not None else first.start
                    free_at = first.wash_end if first.wash_start is not None else lt.end
                    if abs(lt.end - gate) < E and abs(free_at - first.start) < E:
                        step["rule"] = "P3"
                        step["reason"] = (f"Timed so its fill {first.id} starts on {first.line} as soon as the line "
                                          f"is free ({lp} ends {clock(lt.end)}"
                                          + (f", then {d.wash_text(first.id)}" if first.wash_start is not None
                                             else "") + "), keeping the fill inside its hold limit (P3)")
                        nxt = ("f", lt)
    if nxt is not None:
        step["blocked_by"] = nxt[1].id
    return step, nxt


def _after_release(d: _Plan, prev):
    """The task that emptied a tank: the batch's last fill if it ends after the batch, else the batch (H4)."""
    fills = [d.sf[x] for x in d.fills_of.get(d.group(prev.id)[0], [])]
    last = max(fills, key=lambda x: x.end) if fills else None
    return ("f", last) if last is not None and last.end > prev.end + E else ("b", prev)


def _trio_gate(d: _Plan, b):
    """For a trio's first batch: a later member whose own tank CIP ends just as it starts, which set the trio's
    start (H8). Returns (member, rule, text, next task) or None."""
    for m in d.group(b.id)[1:]:
        t = d.sb[m]
        arr = d.by_tank[t.tank]
        k = arr.index(t)
        prev = arr[k - 1] if k else None
        if prev is None or t.cip_start is None or abs(t.cip_end - t.start) >= E:
            continue
        cip = f"{_h(t.cip_end - t.cip_start)} of CIP (H5)"
        if abs(d.release[prev.id] - t.cip_start) < E:
            nxt = _after_release(d, prev)
            what = f"its last fill {nxt[1].id} on {nxt[1].line}" if nxt[0] == "f" else f"batch {prev.id}"
            return m, "H4", (f"the tank was held by {prev.id} until {what} ended at {clock(d.release[prev.id])} "
                             f"(H4), then {cip}"), nxt
        sys = d.pb[m].system
        other = next((x for x in d.sch.batches if x.id != m and d.pb[x.id].system == sys and x.cip_end is not None
                      and abs(x.cip_end - t.cip_start) < E), None)
        if other is not None:
            return m, "H6", (f"the System {sys} CIP skid was busy washing {other.tank} for {other.id} until "
                             f"{clock(other.cip_end)} (H6), then {cip}"), ("b", other)
    return None


def _walk(d: _Plan, kind: str, t, limit: int = 400) -> list[dict]:
    chain, seen = [], set()
    cur = (kind, t)
    while cur is not None and cur[1].id not in seen and len(chain) < limit:
        seen.add(cur[1].id)
        step, cur = _step(d, *cur)
        chain.append(step)
    return chain


def _latest(d: _Plan, ids: list[tuple[str, str]] | None = None):
    """The task that finishes last (first one wins on ties, as the viewer's reduce)."""
    cands = ids or [("b", t.id) for t in d.sch.batches] + [("f", t.id) for t in d.sch.fills]
    best = None
    for k, i in cands:
        t = d.sb[i] if k == "b" else d.sf[i]
        if best is None or t.end > best[1].end:
            best = (k, t)
    return best


def critical_path(plant: Plant, sch: Schedule, downtime: list[Downtime]) -> list[dict]:
    d = _Plan(plant, sch, downtime)
    return _walk(d, *_latest(d))


# ---------- per-PO reasons ----------

def _need(d: _Plan, fids: list[str], trio: bool) -> float:
    """Shortest time from the hold-limit clock start to the end of the last fill, filling back to back (H19)."""
    durs = [d.pf[x].duration for x in fids]
    lead = min(TRIO_FILL_LEAD, max(durs)) if trio else 0.0
    return sum(durs) - lead


def _structural(d: _Plan, carrier: str) -> dict | None:
    fids = d.fills_of.get(carrier, [])
    if not fids:
        return None
    grp = d.group(carrier)
    trio = len(grp) > 1
    need = _need(d, fids, trio)
    hold = max(d.pf[x].hold_max for x in fids)
    if need <= hold + TOL:
        return None
    total = sum(d.pf[x].duration for x in fids)
    n = len(fids)
    who = f"trio {d.pb[carrier].trio_id}" if trio else f"batch {carrier}"
    fills = f"its {n} fills" if n > 1 else "its fill"
    verb, they = ("need", "they") if n > 1 else ("needs", "it")
    lead = (f" ({_h(total)} of filling less the {_h(total - need)} {they} may start before the 3rd batch ends)"
            if trio and total - need > E else "")
    text = (f"Cannot fit: {fills} for {who} {verb} {_h(need)}{' back to back' if n > 1 else ''}{lead} but the "
            f"hold limit is {_h(hold)}, "
            f"so a fill runs late whatever the plan (P3, S14 rates)")
    return {"rule": "P3", "text": text, "need_h": round(need, 2), "hold_h": hold}


def _busy_at(d: _Plan, line: str, h: float, skip: str) -> str | None:
    """What occupies a line at hour h: a fill or its wash, or a planned stop."""
    for t in d.by_line.get(line, []):
        if t.id == skip:
            continue
        s = t.wash_start if t.wash_start is not None else t.start
        if s - E <= h < t.end - E:
            return f"{t.id} until {clock(t.end)}"
    for z in d.downtime:
        if z.line == line and z.start - E <= h < z.end - E:
            return f"planned maintenance {z.id} until {clock(z.end)} (H14)"
    return None


def _fill_reasons(d: _Plan, fid: str, structural: dict | None) -> list[dict]:
    f, t, i = d.pf[fid], d.sf[fid], d.info[fid]
    out = []
    if i["late"] > TOL:
        out.append({"rule": "P3", "text": f"{fid} ends {clock(t.end)}, {_h(i['late'])} past its hold limit of "
                                          f"{clock(i['due'])} ({_h(f.hold_max)} after batch {i['by']} ends)"})
        if structural:
            out.append({"rule": structural["rule"], "text": structural["text"]})
    if i["wait"] > E:
        out.append({"rule": "P6", "text": f"Waited {_h(i['wait'])}: ready at {clock(i['ready'])}, started filling "
                                          f"on {t.line} at {clock(t.start)}"})
        rd = math.floor((i["ready"]) / WEEK)
        if (t.line == "F7" and d.f7_week(t.start) > rd
                and d.f7_count.get(rd, 0) >= (LINE_BY_ID["F7"].weekly_max or 3)):
            out.append({"rule": "H10", "text": f"F7 already has {d.f7_count[rd]} fills in week {rd + 1} (H10), so "
                                               f"this fill moved to week {d.f7_week(t.start) + 1}"})
        step, _ = _step(d, "f", t)
        out.append({"rule": step["rule"], "text": step["reason"]})
        if step["rule"] != "H14":
            gate = t.wash_start if t.wash_start is not None else t.start
            z = d.stop_at(t.line, t.start) or (d.stop_at(t.line, gate) if gate > i["ready"] + E else None)
            if z is not None:
                out.append({"rule": "H14", "text": f"Planned maintenance on {t.line} ({z.id}) from {clock(z.start)} "
                                                   f"until {clock(z.end)} (H14)"})
        excl = set(LINE_BY_ID[t.line].excludes) | {x.id for x in LINE_BY_ID.values() if t.line in x.excludes}
        for x in sorted(excl):
            hit = [g for g in d.by_line.get(x, []) if g.start < t.start - E and g.end > i["ready"] + E]
            if hit:
                g = max(hit, key=lambda g: g.end)
                out.append({"rule": "H11", "text": f"{t.line} cannot fill while {x} fills (F7 excludes F5 and "
                                                   f"F6, H11): {x} was filling {g.id} from {clock(g.start)} to "
                                                   f"{clock(g.end)}"})
        others = [x for x in lines_for(f.pack, f.system) if x != t.line]
        if others:
            busy = [(x, _busy_at(d, x, i["ready"], fid)) for x in others]
            if all(b for _, b in busy):
                txt = "; ".join(f"{x} busy with {b}" for x, b in busy)
                out.append({"rule": "H9", "text": f"Other lines for {PACK_LABEL.get(f.pack, f.pack)} were busy when "
                                                  f"it was ready: {txt}"})
    return out


def explain(plant: Plant, sch: Schedule, downtime: list[Downtime], week_limit: float = 120.0) -> dict:
    """Critical path, a status and reasons for every batch and fill PO, and summary counts."""
    d = _Plan(plant, sch, downtime)
    crit = _walk(d, *_latest(d)) if (sch.batches or sch.fills) else []
    pos: dict[str, dict] = {}

    struct = {}
    for carrier in {d.group(b.id)[0] for b in plant.batches}:
        s = _structural(d, carrier)
        if s:
            struct[carrier] = s

    total_wait = 0.0
    late_ids = []
    for f in plant.fills:
        i, t = d.info[f.id], d.sf[f.id]
        carrier = d.group(f.batch_id)[0]
        late = i["late"] > TOL
        if late:
            late_ids.append(f.id)
        total_wait += i["wait"]
        pos[f.id] = {"kind": "fill", "status": "late_fill" if late else "ok", "line": t.line,
                     "start": t.start, "end": t.end, "ready": round(i["ready"], 3), "due": round(i["due"], 3),
                     "wait_h": round(i["wait"], 2), "late_h": round(i["late"], 2),
                     "structural": bool(late and carrier in struct),
                     "reasons": _fill_reasons(d, f.id, struct.get(carrier))}

    done = set()
    for b in plant.batches:
        if b.id in done:
            continue
        grp = d.group(b.id)
        done.update(grp)
        fids = d.fills_of.get(grp[0], [])
        tasks = [("b", m) for m in grp] + [("f", x) for x in fids]
        kind, last = _latest(d, tasks)
        end = last.end
        late = [x for x in fids if d.info[x]["late"] > TOL]
        outside = end > week_limit + TOL or bool(late)
        reasons = []
        core: set[str] = set()  # raw reason texts already given, so the walk does not repeat them
        if late:
            for x in late:
                reasons.append({"rule": "P3", "text": f"Fill {x} on {d.sf[x].line} ends {_h(d.info[x]['late'])} past "
                                                      f"its hold limit ({clock(d.info[x]['due'])}), so the PO does "
                                                      f"not count (P0)"})
            seen_txt = {r["text"] for r in reasons}
            for x in late:  # why each late fill ran late: its own blockers
                for r in pos[x]["reasons"][1:]:
                    if r["text"] not in seen_txt:
                        seen_txt.add(r["text"])
                        core.add(r["text"])
                        reasons.append({"rule": r["rule"], "text": f"{x}: {r['text']}"
                                        if not r["text"].startswith((x, "Cannot fit")) else r["text"]})
        if end > week_limit + TOL:
            where = last.tank if kind == "b" else last.line
            reasons.append({"rule": "P0", "text": f"Its last step, {last.id} on {where}, ends {clock(end)} "
                                                  f"({_h(end)}), after the week limit of {clock(week_limit)} "
                                                  f"({_h(week_limit)})"})
            for st in _walk(d, kind, last, limit=4):
                if st["reason"] in core:
                    continue
                reasons.append({"rule": st["rule"], "text": f"{st['id']} on {st['where']} "
                                                            f"({st['start_clock']} to {st['end_clock']}): "
                                                            f"{st['reason']}"})
        wait = round(sum(d.info[x]["wait"] for x in fids), 2)
        for m in grp:
            t = d.sb[m]
            pos[m] = {"kind": "batch", "status": "outside_week" if outside else "in_week", "tank": t.tank,
                      "start": t.start, "end": t.end, "done_at": round(end, 3), "fill_ids": list(fids),
                      "fill_wait_h": wait, "structural": grp[0] in struct,
                      "reasons": [dict(r) for r in reasons]}

    outside = [k for k, v in pos.items() if v["kind"] == "batch" and v["status"] == "outside_week"]
    in_week = len(plant.batches) - len(outside)
    makespan = max([t.end for t in sch.batches] + [t.end for t in sch.fills], default=0.0)
    n_struct = len(struct)
    text = (f"{in_week} of {len(plant.batches)} batch POs finish inside the week limit of {clock(week_limit)} (P0); "
            f"{len(late_ids)} fill POs run past their hold limit (P3)"
            + (f", {n_struct} batch/trio groups cannot meet the hold limit in any plan (S14 fill times)"
               if n_struct else "")
            + f". Fills waited {_h(total_wait)} in all (P6). The plan ends {clock(makespan)} ({_h(makespan)}).")
    summary = {"batch_pos": len(plant.batches), "in_week": in_week, "outside_week": len(outside),
               "fill_pos": len(plant.fills), "late_fills": len(late_ids), "structural_impossible": n_struct,
               "structural_groups": sorted(struct), "fill_wait_h": round(total_wait, 2),
               "plan_end": makespan, "plan_end_clock": clock(makespan), "week_limit": week_limit, "text": text}
    return {"critical_path": crit, "pos": pos, "summary": summary}


__all__ = ["clock", "explain", "critical_path"]
