"""Greedy dispatch heuristic, a port of v49's schedulePlant / searchSchedules (no re-plan yet).

Kept faithful to v49 (same decisions, same tie-breaks) so a seed gives the same schedule as the prototype;
tests/test_heuristic.py checks that against the golden weeks. Rule IDs are noted where a step enforces one.
"""
from __future__ import annotations

import math
from functools import cmp_to_key

from .plant import (FILL_LINES, SYSTEMS, TARGET_WINDOW, TRIO_FILL_LEAD, TRIO_STAGGER, WEEK, BatchTask, Downtime,
                    FillTask, Plant, Schedule, cip_rule, wash_hours)
from .rng import mulberry32

EPS = 1e-6
INF = math.inf
GATE_LOOKAHEAD = 1.0
URGENT_SLACK = 2.0
TARGET_LEAD = 2.0
GROUP_WINDOW = 3.0
OPTIONS_KEPT = 10


def _cmp(a, b):
    return (a > b) - (a < b)


def find_slot(lanes, ready, dur):
    """Earliest start >= ready on any lane where [start, start + dur) is free."""
    best = None
    for li, lane in enumerate(lanes):
        t = ready
        for iv in lane:
            if iv["end"] <= t + EPS:
                continue
            if iv["start"] >= t + dur - EPS:
                break
            t = iv["end"]
        if best is None or t < best["start"] - EPS:
            best = {"lane": li, "start": t}
    return best


def insert_sorted(lane, iv):
    lane.append(iv)
    lane.sort(key=lambda x: x["start"])


def schedule_plant(plant: Plant, params: dict) -> dict:
    p = params
    lines = FILL_LINES
    cip_mult = p.get("cipMult", 1.0)
    rule = p.get("rule", "est")
    fill_rule = p.get("fillRule", "fifo")
    batch_priority = p.get("batchPriority")
    fill_priority = p.get("fillPriority")
    hold_tank = p.get("holdTank", True)
    group = p.get("group", True)
    priority_fills = p.get("priorityFills", [])
    priority_targets = p.get("priorityTargets", {})
    trio_on = p.get("trio", True)
    fill_window = p.get("fillWindow", True)
    downtime = p.get("downtime", [])
    floor = 0.0
    floors: dict = {}

    B = [b.model_dump() for b in plant.batches]
    Fl = [f.model_dump() for f in plant.fills]
    by_id = {b["id"]: b for b in B}
    prio_fill = set(priority_fills) | set(p.get("boostFills") or [])
    prio_batch = {f["batch_id"] for f in Fl if f["id"] in prio_fill}
    window_open, batch_earliest = {}, {}
    for f in Fl:  # P2
        t = priority_targets.get(f["id"])
        if f["id"] not in prio_fill or t is None:
            continue
        window_open[f["id"]] = max(0.0, t - TARGET_WINDOW)
        b = by_id[f["batch_id"]]
        batch_earliest[b["id"]] = max(batch_earliest.get(b["id"], 0.0), window_open[f["id"]] - b["duration"])

    def open_at(f, ready):
        return max(ready, window_open[f["id"]]) if f["id"] in window_open else ready

    tanks = [{"id": tid, "system": s, "last": None, "releaseAt": 0.0, "released": True}
             for s, ids in SYSTEMS.items() for tid in ids]
    skid_lanes = {s: [[]] for s in SYSTEMS}  # H6: one skid per system

    def wash(prev, nxt):  # H5 / H7
        return wash_hours(cip_rule(prev["sku"], prev["category"], nxt["sku"], nxt["category"]), cip_mult) if prev else 0.0

    fills_of = {b["id"]: [] for b in B}
    for f in Fl:
        fills_of[f["batch_id"]].append(f)
    fill_hours = {bid: sum(f["duration"] for f in fs) for bid, fs in fills_of.items()}

    if rule == "campaign":
        cmp = lambda a, b: _cmp(a["category"], b["category"]) or _cmp(a["sku"], b["sku"]) or _cmp(b["duration"], a["duration"])  # noqa: E731
    elif rule == "random":
        cmp = lambda a, b: _cmp(batch_priority[a["id"]], batch_priority[b["id"]])  # noqa: E731
    elif rule == "lpt":
        cmp = lambda a, b: _cmp(b["duration"], a["duration"]) or _cmp(fill_hours[b["id"]], fill_hours[a["id"]])  # noqa: E731
    elif rule == "spt":
        cmp = lambda a, b: _cmp(a["duration"] + fill_hours[a["id"]], b["duration"] + fill_hours[b["id"]])  # noqa: E731
    else:
        cmp = lambda a, b: _cmp(fill_hours[b["id"]], fill_hours[a["id"]])  # noqa: E731
    ranked = sorted(B, key=cmp_to_key(cmp))
    order_idx = {b["id"]: i for i, b in enumerate(ranked)}

    group_of = {}  # H8: System 1 trios placed together
    if trio_on:
        by_trio = {}
        for b in B:
            if b["system"] != 1 or not b["trio_id"]:
                continue
            g = by_trio.setdefault(b["trio_id"], {"id": b["trio_id"], "members": []})
            g["members"].append(b)
            group_of[b["id"]] = g
    trio_of = dict(group_of)
    placed_start = {}

    def fill_source(b):
        return trio_of[b["id"]]["members"][0]["id"] if b["id"] in trio_of else b["id"]

    holders = {}
    fills_left = {b["id"]: len(fills_of[b["id"]]) for b in B}

    def is_leader(b):
        return b["id"] not in group_of or group_of[b["id"]]["members"][0] is b

    def evaluate(b, t):
        if not t["released"]:
            return None
        rel = max(t["releaseAt"], floor)
        if not t["last"]:
            return {"tank": t, "start": rel, "at": rel, "cip": None}
        hours = wash(t["last"], b)
        slot = find_slot(skid_lanes[b["system"]], rel, hours)
        return {"tank": t, "start": slot["start"] + hours, "at": slot["start"],
                "cip": {"rule": cip_rule(t["last"]["sku"], t["last"]["category"], b["sku"], b["category"]),
                        "hours": hours, "start": slot["start"], "end": slot["start"] + hours, "lane": slot["lane"],
                        "wait": slot["start"] - t["releaseAt"]}}

    def cip_h(c):
        return c["cip"]["hours"] if c["cip"] else 0.0

    def better(a, b):
        return (b is None or a["start"] < b["start"] - EPS
                or (abs(a["start"] - b["start"]) < EPS and cip_h(a) < cip_h(b) - EPS))

    def evaluate_group(g):
        k = len(g["members"])
        lead = g["members"][0]
        ready = [evaluate(lead, t) for t in tanks if t["system"] == lead["system"] and t["released"]]
        ready.sort(key=cmp_to_key(lambda a, b: _cmp(a["start"], b["start"]) or _cmp(cip_h(a), cip_h(b))))
        if len(ready) < k:
            return None
        lanes = [list(l) for l in skid_lanes[lead["system"]]]
        placements = []
        s0 = 0.0
        for j in range(k):
            t = ready[j]["tank"]
            m = g["members"][j]
            cip = None
            earliest = max(t["releaseAt"], floor)
            if t["last"]:
                hours = wash(t["last"], m)
                slot = find_slot(lanes, earliest, hours)
                insert_sorted(lanes[slot["lane"]], {"start": slot["start"], "end": slot["start"] + hours})
                cip = {"rule": cip_rule(t["last"]["sku"], t["last"]["category"], m["sku"], m["category"]),
                       "hours": hours, "start": slot["start"], "end": slot["start"] + hours, "lane": slot["lane"],
                       "wait": slot["start"] - t["releaseAt"]}
                earliest = cip["end"]
            s0 = max(s0, earliest - j * TRIO_STAGGER)
            placements.append({"tank": t, "cip": cip})
        for j, pl in enumerate(placements):
            pl["start"] = s0 + j * TRIO_STAGGER
        at = min([s0] + [pl["cip"]["start"] for pl in placements if pl["cip"]])
        w = sum(pl["cip"]["hours"] for pl in placements if pl["cip"])
        return {"group": g, "placements": placements, "start": s0, "at": at, "cip": {"hours": w} if w else None}

    def best_tank(b):
        if b["id"] in group_of:
            return evaluate_group(group_of[b["id"]])
        best = None
        for t in tanks:
            if t["system"] != b["system"]:
                continue
            c = evaluate(b, t)
            if c and better(c, best):
                best = c
        return best

    batches, cips, fills, filler_cips = [], [], [], []
    released = []
    n_lines = len(lines)
    filler_free = [0.0] * n_lines
    filler_last = [None] * n_lines

    def can_run(lane, f):  # H9, H10
        l = lines[lane]
        return f["pack"] in l.packs and (not l.systems or f["system"] in l.systems)

    def line_change(lane, f):
        prev = filler_last[lane]
        if not prev:
            return 0.0
        return wash(prev, f) + (lines[lane].pack_change if lines[lane].pack_change and prev["pack"] != f["pack"] else 0.0)

    week_count = {}
    fill_iv = [[] for _ in lines]
    down_iv = [sorted([{"start": d.start, "end": d.end} for d in downtime if d.line == l.id], key=lambda x: x["start"])
               for l in lines]
    conflict_lanes = [[j for j, m in enumerate(lines) if j != i and (m.id in l.excludes or l.id in m.excludes)]
                      for i, l in enumerate(lines)]  # H11
    pending = {1: [], 2: [], 3: [], 4: []}
    for b in ranked:
        pending[b["system"]].append(b)
    cache = {}
    dirty = {1: None, 2: None, 3: None, 4: None}  # ordered set

    def release_tank(t, at):  # H4
        t["released"] = True
        t["releaseAt"] = at
        t["last"]["holdEnd"] = at
        dirty[t["system"]] = None

    chain_next = {}
    trio_last_end = {}  # trio's first batch id -> end of its 3rd batch

    def commit_group(choice):
        g, pls = choice["group"], choice["placements"]
        for j, pl in enumerate(pls):
            commit_batch(g["members"][j], {"tank": pl["tank"], "start": pl["start"], "cip": pl["cip"],
                                           "gateWait": pl.get("gateWait")})
        last_end = next(x for x in batches if x["id"] == g["members"][-1]["id"])["end"]
        chain = [f for m in g["members"] for f in fills_of[m["id"]]]
        if not chain:
            return
        for i in range(1, len(chain)):
            chain_next[chain[i - 1]["id"]] = chain[i]
        head = chain[0]
        trio_last_end[head["batch_id"]] = last_end
        first_end = next(x for x in batches if x["id"] == g["members"][0]["id"])["end"]
        released.append({**head, "ready": open_at(head, max(first_end, last_end - min(TRIO_FILL_LEAD, head["duration"]))),
                         "due": last_end + head["hold_max"], "chain": g["id"], "chainPos": 1})

    def commit_batch(b, choice):
        t = choice["tank"]
        cip = None
        if choice.get("cip"):
            cip = {**choice["cip"], "id": f"CIP-{len(cips) + 1}", "system": b["system"], "tank": t["id"],
                   "duration": choice["cip"]["hours"], "toBatch": b["id"], "tankFreeAt": t["releaseAt"]}
            insert_sorted(skid_lanes[b["system"]][cip["lane"]], cip)
            cips.append(cip)
        sb = {**b, "tank": t["id"], "start": choice["start"], "end": choice["start"] + b["duration"],
              "holdEnd": choice["start"] + b["duration"], "cipId": cip["id"] if cip else None,
              "gateWait": choice.get("gateWait") or 0.0}
        t["last"] = sb
        cache.pop(b["id"], None)
        batches.append(sb)
        placed_start[sb["id"]] = sb["start"]
        pending[b["system"]].remove(b)
        if b["id"] not in group_of:
            for f in fills_of[b["id"]]:  # H3
                released.append({**f, "ready": open_at(f, sb["end"]), "due": sb["end"] + f["hold_max"]})
        src = fill_source(b)
        holders.setdefault(src, []).append(t)
        if hold_tank and fills_of[src]:
            t["released"] = False
        else:
            t["releaseAt"] = sb["end"]
        dirty[b["system"]] = None

    wide = rule == "est" or group

    def choice_for(b):
        if b["id"] not in cache:
            cache[b["id"]] = best_tank(b)
        return cache[b["id"]]

    def list_for(sys):
        leaders = [b for b in pending[sys] if is_leader(b)]
        urgent = [b for b in leaders if is_urgent(b)]
        lst = urgent if any(choice_for(b) for b in urgent) else (leaders if wide else leaders[:1])
        for b in lst:
            choice_for(b)
        return lst

    def capped_only(f):
        return all((not can_run(i, f)) or l.weekly_max for i, l in enumerate(lines))

    has_capped = any(l.weekly_max for l in lines)

    def fill_gate():
        share = [0.0] * n_lines
        for f in released:
            ok = [can_run(l, f) for l in range(n_lines)]
            n = sum(ok)
            for l, y in enumerate(ok):
                if y:
                    share[l] += f["duration"] / n
        queued = [0] * n_lines
        for f in released:
            for l in range(n_lines):
                if lines[l].weekly_max and can_run(l, f):
                    queued[l] += 1

        def avail(f):
            t = INF
            for l in range(n_lines):
                if not can_run(l, f):
                    continue
                lt = filler_free[l] + share[l]
                cap = lines[l].weekly_max
                if cap:  # H10: a full week means F7 is not free until the next one
                    wk = math.floor((lt + EPS) / WEEK)
                    need = queued[l] + 1
                    while week_count.get((l, wk), 0) + need > cap:
                        need -= max(0, cap - week_count.get((l, wk), 0))
                        wk += 1
                    lt = max(lt, wk * WEEK)
                t = min(t, lt)
            return t

        def delay_of(b, start):
            d = 0.0
            for f in fills_of[b["id"]]:
                if f["id"] in window_open:
                    d = max(d, window_open[f["id"]] - (start + b["duration"]))
                if not fill_window and not capped_only(f):
                    continue
                d = max(d, avail(f) + f["duration"] - f["hold_max"] - (start + b["duration"]))
            return d

        def gate(b, c):
            if not c:
                return c
            if c.get("group"):
                d = max([0.0] + [max(delay_of(m, c["placements"][j]["start"]),
                                     floors.get(m["id"], -INF) - c["placements"][j]["start"])
                                 for j, m in enumerate(c["group"]["members"])])
                if d < EPS:
                    return c
                return {**c, "start": c["start"] + d, "at": max(c["at"], c["at"] + d - GATE_LOOKAHEAD), "gateWait": d,
                        "placements": [{**pl, "start": pl["start"] + d, "gateWait": d} for pl in c["placements"]]}
            d = max(delay_of(b, c["start"]), floors.get(b["id"], -INF) - c["start"])
            return c if d < EPS else {**c, "start": c["start"] + d, "at": max(c["at"], c["at"] + d - GATE_LOOKAHEAD),
                                      "gateWait": d}
        return gate

    def sys_clock(sys):
        return min([INF] + [t["releaseAt"] for t in tanks if t["system"] == sys and t["released"]])

    def urgent_now(m):
        return m["id"] in prio_batch and (batch_earliest.get(m["id"]) is None
                                          or batch_earliest[m["id"]] <= sys_clock(m["system"]) + TARGET_LEAD)

    def is_urgent(b):
        ms = group_of[b["id"]]["members"] if b["id"] in group_of else [b]
        return any(urgent_now(m) for m in ms)

    def next_batch():
        for sys in list(dirty):
            for b in pending[sys]:
                cache.pop(b["id"], None)
            list_for(sys)
        dirty.clear()
        gate = fill_gate() if (fill_window or has_capped or window_open or floors) else None
        lists = {s: list_for(s) for s in (1, 2, 3, 4)}
        choice_of = {}
        for s in (1, 2, 3, 4):
            for b in lists[s]:
                choice_of[b["id"]] = gate(b, cache.get(b["id"])) if gate else cache.get(b["id"])
        horizon = INF
        if group:
            for s in (1, 2, 3, 4):
                for b in lists[s]:
                    c = choice_of[b["id"]]
                    if c and c["at"] < horizon:
                        horizon = c["at"]
            horizon += GROUP_WINDOW
        best = bb = None
        for s in (1, 2, 3, 4):
            for b in lists[s]:
                c = choice_of[b["id"]]
                if not c:
                    continue
                if group:  # P5: within the window, the shortest CIP goes first
                    urgent = is_urgent(b)
                    if c["at"] > horizon + EPS and not urgent:
                        continue
                    best_urgent = bool(bb) and is_urgent(bb)
                    if (best is None or (urgent and not best_urgent) or (urgent == best_urgent and (
                            cip_h(c) < cip_h(best) - EPS or (abs(cip_h(c) - cip_h(best)) < EPS and (
                            c["at"] < best["at"] - EPS or (abs(c["at"] - best["at"]) < EPS
                                                           and order_idx[b["id"]] < order_idx[bb["id"]])))))):
                        best, bb = c, b
                    continue
                if (best is None or c["at"] < best["at"] - EPS or (abs(c["at"] - best["at"]) < EPS and (
                        better(c, best) or (not better(best, c) and order_idx[b["id"]] < order_idx[bb["id"]])))):
                    best, bb = c, b
        return {"b": bb, "choice": best} if best else None

    def fill_key(lane, f):
        if fill_rule == "setup":
            return [line_change(lane, f), f["ready"]]
        if fill_rule == "lpt":
            return [-f["duration"], f["ready"]]
        if fill_rule == "spt":
            return [f["duration"], f["ready"]]
        if fill_rule == "random":
            return [fill_priority[f["id"]], 0]
        return [f["ready"], -f["duration"]]

    def next_fill():
        if not released:
            return None
        lane, at = -1, INF
        for l in range(n_lines):
            min_ready = min([f["ready"] for f in released if can_run(l, f)], default=INF)
            if min_ready == INF:
                continue
            t = max(filler_free[l], min_ready)
            if down_iv[l]:
                t = find_slot([down_iv[l]], t, 0.25)["start"]
            if t < at - EPS:
                at, lane = t, l
        if lane < 0:
            return None

        def urgent(f):
            return fill_window and f["due"] - at - f["duration"] < URGENT_SLACK

        def key(f):
            base = ([line_change(lane, f)] if group else []) + fill_key(lane, f)
            u = urgent(f)
            return [0 if f["id"] in prio_fill else 1, 0 if f.get("chain") else 1, 0 if u else 1,
                    f["due"] if u else 0] + base

        pick, kp = -1, None
        for i, f in enumerate(released):
            if f["ready"] > at + EPS or not can_run(lane, f):
                continue
            k = key(f)
            c = 0
            if kp is not None:
                for a, b in zip(k, kp):
                    if abs(a - b) > EPS:
                        c = -1 if a < b else 1
                        break
            if pick < 0 or c < 0 or (c == 0 and f["id"] < released[pick]["id"]):
                pick, kp = i, k
        return {"lane": lane, "at": at, "idx": pick}

    def commit_fill(nf):
        lane, idx = nf["lane"], nf["idx"]
        f = released.pop(idx)
        prev = filler_last[lane]
        line = lines[lane]
        w = line_change(lane, f)
        wash_rec = None
        if prev:
            free = max(filler_free[lane], floor)
            if w > EPS and down_iv[lane]:  # H14: no wash during a stop
                free = find_slot([down_iv[lane]], free, w)["start"]
            wash_rec = {"id": f"FCIP-{len(filler_cips) + 1}", "lane": lane, "filler": line.id, "start": free,
                        "end": free + w, "duration": w, "toFill": f["id"]}
            filler_cips.append(wash_rec)
        start = max(f["ready"], floor, (wash_rec["start"] if wash_rec else filler_free[lane]) + w)
        blockers = [sorted([iv for l in conflict_lanes[lane] for iv in fill_iv[l]], key=lambda x: x["start"])] \
            if conflict_lanes[lane] else None
        moved = True
        while moved:
            moved = False
            if line.weekly_max:  # H10
                while week_count.get((lane, math.floor((start + EPS) / WEEK)), 0) >= line.weekly_max:
                    start = (math.floor((start + EPS) / WEEK) + 1) * WEEK
                    moved = True
            if blockers:  # H11
                t = find_slot(blockers, start, f["duration"])["start"]
                if t > start + EPS:
                    start, moved = t, True
            if down_iv[lane]:  # H14
                t = find_slot([down_iv[lane]], start, f["duration"])["start"]
                if t > start + EPS:
                    start, moved = t, True
            sibs = sorted([x for x in fills if x["batch_id"] == f["batch_id"]], key=lambda x: x["start"])
            if sibs:  # H19
                t = find_slot([sibs], start, f["duration"])["start"]
                if t > start + EPS:
                    start, moved = t, True
        if line.weekly_max:
            wk = (lane, math.floor((start + EPS) / WEEK))
            week_count[wk] = week_count.get(wk, 0) + 1
        rec = {**f, "lane": lane, "filler": line.id, "start": start, "end": start + f["duration"],
               "wait": start - f["ready"], "cipId": wash_rec["id"] if wash_rec else None,
               "late": max(0.0, start + f["duration"] - f["due"])}
        fills.append(rec)
        insert_sorted(fill_iv[lane], rec)
        filler_free[lane] = rec["end"]
        filler_last[lane] = rec
        for r in released:
            if r["batch_id"] == f["batch_id"] and r["ready"] < rec["end"]:
                r["ready"] = rec["end"]
        nxt = chain_next.get(f["id"])
        if nxt:
            # H8/H19 (Sean, 2026-10-04): a trio's fills run one at a time, so the next starts when this one
            # ends; all of them may start 2h before the 3rd batch ends and count the hold limit from it.
            trio_last = trio_last_end.get(nxt["batch_id"], next(x for x in batches if x["id"] == nxt["batch_id"])["end"])
            released.append({**nxt, "ready": open_at(nxt, max(trio_last - min(TRIO_FILL_LEAD, nxt["duration"]),
                                                              rec["end"])),
                             "due": trio_last + nxt["hold_max"], "chain": f["chain"], "chainPos": f["chainPos"] + 1})
        fills_left[f["batch_id"]] -= 1
        if fills_left[f["batch_id"]] == 0 and hold_tank:  # H4
            done = max(x["end"] for x in fills if x["batch_id"] == f["batch_id"])
            for t in holders.get(f["batch_id"], []):
                if fill_source(t["last"]) == f["batch_id"]:
                    release_tank(t, max(t["last"]["end"], done))

    guard = 100000
    while (len(batches) < len(B) or released) and guard:
        guard -= 1
        nb = next_batch() if len(batches) < len(B) else None
        nf = next_fill()
        if nb and (not nf or nb["choice"]["at"] <= nf["at"] + EPS):
            if nb["choice"].get("group"):
                commit_group(nb["choice"])
            else:
                commit_batch(nb["b"], nb["choice"])
        elif nf:
            commit_fill(nf)
        else:
            break

    makespan = max([0.0] + [b["end"] for b in batches] + [f["end"] for f in fills])
    return {"batches": batches, "cips": cips, "fills": fills, "fillerCips": filler_cips, "makespan": makespan,
            "lateFills": sum(1 for f in fills if f["late"] > EPS), "fillWait": sum(f["wait"] for f in fills),
            "cipH": sum(c["duration"] for c in cips) + sum(c["duration"] for c in filler_cips),
            "strategy": {k: params.get(k) for k in ("rule", "fillRule", "fillWindow")}}


def window_fit(res: dict, limit: float) -> int:
    """POs done inside the week limit with no fill over hold limit (P0); a trio counts 3."""
    fills_of = {}
    for f in res["fills"]:
        fills_of.setdefault(f["batch_id"], []).append(f)
    seen, count = set(), 0
    for b in res["batches"]:
        if b["id"] in seen:
            continue
        ms = [x for x in res["batches"] if b["trio_id"] and x["trio_id"] == b["trio_id"]] or [b]
        seen.update(m["id"] for m in ms)
        fs = [f for m in ms for f in fills_of.get(m["id"], [])]
        end = max([m["end"] for m in ms] + [f["end"] for f in fs])
        if end <= limit + EPS and not any(f["late"] > EPS for f in fs):
            count += len(ms)
    return count


def schedule_score(res: dict, base: dict) -> list:
    return [-window_fit(res, base["fitLimit"]) if base.get("goal") == "fit" and base.get("fitLimit") else 0,
            0 if base.get("fillWindow") is False else res["lateFills"], res["makespan"], res["fillWait"], res["cipH"]]


def _cmp_scores(a, b):
    for x, y in zip(a, b):
        if abs(x - y) > EPS:
            return -1 if x < y else 1
    return 0


def search_candidates(plant: Plant, base: dict, rnd: int = 0) -> list[dict]:
    """The dispatch strategies v49 tries, in v49's order (fixed ones, then seeded random ones)."""
    out = []
    for rule in (["est", "campaign", "lpt", "spt"] if base.get("goal") == "fit" else ["est", "campaign", "lpt"]):
        for fr in ["fifo", "setup", "lpt", "spt"]:
            out.append({"rule": rule, "fillRule": fr})
            if base.get("fillWindow") is not False:
                out.append({"rule": rule, "fillRule": fr, "fillWindow": False})
    rng = mulberry32((plant.seed * 31 + rnd * 7919 + 17) & 0xFFFFFFFF)
    n = len(plant.batches)
    for _ in range(60 if n <= 60 else 30 if n <= 120 else 16):
        rule = "random" if rng() < 0.5 else ["est", "campaign", "lpt"][math.floor(rng() * 3)]
        fr = "random" if rng() < 0.6 else ["fifo", "setup", "lpt", "spt"][math.floor(rng() * 4)]
        out.append({"rule": rule, "fillRule": fr,
                    "batchPriority": {b.id: rng() for b in plant.batches} if rule == "random" else None,
                    "fillPriority": {f.id: rng() for f in plant.fills} if fr == "random" else None})
    return out


def search_schedules(plant: Plant, base: dict, rnd: int = 0) -> list[dict]:
    """Run every candidate strategy; best first by v49's score, duplicates dropped, top 10 kept."""
    results = []
    for c in search_candidates(plant, base, rnd):
        res = schedule_plant(plant, {**base, **c})
        res["strategy"] = c
        results.append((schedule_score(res, base), res))
    results.sort(key=cmp_to_key(lambda a, b: _cmp_scores(a[0], b[0])))
    seen, out = set(), []
    for _, res in results:
        sig = tuple(sorted([(b["id"], b["tank"], b["start"]) for b in res["batches"]] +
                           [(f["id"], str(f["lane"]), f["start"]) for f in res["fills"]]))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(res)
    return out[:OPTIONS_KEPT]


def to_schedule(res: dict, engine: str = "heuristic") -> Schedule:
    cips = {c["toBatch"]: c for c in res["cips"]}
    washes = {c["toFill"]: c for c in res["fillerCips"]}
    bs = [BatchTask(id=b["id"], tank=b["tank"], start=b["start"], end=b["end"],
                    cip_start=cips[b["id"]]["start"] if b["id"] in cips else None,
                    cip_end=cips[b["id"]]["end"] if b["id"] in cips else None,
                    cip_rule=cips[b["id"]]["rule"] if b["id"] in cips else None) for b in res["batches"]]
    fs = [FillTask(id=f["id"], line=f["filler"], start=f["start"], end=f["end"],
                   wash_start=washes[f["id"]]["start"] if f["id"] in washes else None,
                   wash_end=washes[f["id"]]["end"] if f["id"] in washes else None) for f in res["fills"]]
    return Schedule(engine=engine, batches=bs, fills=fs)


def best_heuristic(plant: Plant, downtime: list[Downtime], week_limit: float = 120.0, goal: str = "fit") -> Schedule:
    base = {"downtime": downtime, "goal": goal, "fitLimit": week_limit}
    best = search_schedules(plant, base)[0]
    sch = to_schedule(best)
    sch.objective = {"strategy": {k: v for k, v in best["strategy"].items() if k in ("rule", "fillRule", "fillWindow")}}
    return sch
