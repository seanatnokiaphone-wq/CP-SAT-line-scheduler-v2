"""Seeded week generator, a draw-for-draw port of v49's generatePlant (S3-S7, S12, S13, H8, H12, P3).

A seed gives the same orders as v49: every rng() call happens in the same order.
"""
from __future__ import annotations

import math
from typing import Optional

from .plant import DEFAULT_CAPACITY, PACK_LABEL, SMALL_PACKS, SYSTEMS, WEEK, Batch, Fill, Plant, Product
from .rng import js_round, mulberry32

NAME_POOLS = {
    "A": ["Classic Lemonade", "Sparkling Spring Water", "Light Lemon-Lime", "Coconut Water", "White Grape",
          "Cucumber Mint Tonic", "Pear Spritz", "Jasmine Green Tea", "Clear Apple", "Electrolyte Zero",
          "White Peach Tea", "Honeydew Splash"],
    "B": ["Black Cherry Soda", "Blue Raspberry", "Cola Classic", "Root Beer", "Ginger Beer", "Cold Brew Coffee",
          "Blood Orange", "Beet & Berry", "Hibiscus Punch", "Grape Soda", "Mango Chili", "Espresso Tonic"],
    "C": ["Peanut Protein Shake", "Almond Milk Latte", "Hazelnut Cocoa", "Whole Milk Chocolate", "Soy Vanilla Shake",
          "Cashew Cold Brew", "Whey Strawberry", "Oat & Egg Nog", "Sesame Matcha", "Walnut Maple Milk",
          "Royal Milk Tea", "Coconut Cashew Cream"],
}
C_ALLERGENS = ["Peanut", "Tree nut", "Tree nut", "Milk", "Soy", "Tree nut", "Milk", "Egg", "Sesame",
               "Tree nut", "Milk", "Tree nut"]
DEFAULT_DOUBLE_FILL = {1: 20, 2: 20, 3: 20, 4: 20}
# H8 (Sean, 2026-10-04 19:24 UTC): a trio is filled by 1 or 3 fill POs. Share of trios drawn with 3
# (default by Claude). 0 gives v49's weeks exactly (one fill per trio), which the parity tests use.
TRIO_THREE_FILL_PCT = 25


def _num(x: float):
    """Keep whole numbers as int so dumps compare equal to the JS JSON."""
    return int(x) if float(x).is_integer() else x


def generate_plant(seed: int, batch_count: int, fill_min=0.5, fill_max=3.0, batch_min=3, batch_max=6, *,
                   capacity: Optional[dict] = None, hold_range=(6, 12), double_fill: Optional[dict] = None,
                   trio_pct=60, mix: Optional[dict] = None, run_times: Optional[dict] = None,
                   trio_three_fill_pct=TRIO_THREE_FILL_PCT) -> Plant:
    capacity = {int(k): v for k, v in (capacity or DEFAULT_CAPACITY).items()}
    double_fill = {int(k): v for k, v in (double_fill or DEFAULT_DOUBLE_FILL).items()}
    run_times = {int(k): v for k, v in (run_times or {}).items()}
    mix = {int(k): v for k, v in mix.items()} if mix else None

    def batch_span(sys):
        return (run_times.get(sys) or {}).get("batch") or [batch_min, batch_max]

    def fill_span(sys):
        return (run_times.get(sys) or {}).get("fill") or [fill_min, fill_max]

    rng = mulberry32(seed)

    def rand_int(lo, hi):
        return lo + math.floor(rng() * (hi - lo + 1))

    def pick(arr):
        return arr[math.floor(rng() * len(arr))]

    def shuffle(arr):
        out = list(arr)
        for i in range(len(out) - 1, 0, -1):
            j = math.floor(rng() * (i + 1))
            out[i], out[j] = out[j], out[i]
        return out

    # 1. Products
    nA = rand_int(7, 10)
    nB = rand_int(5, 7)
    nC = 20 - nA - nB
    cats = shuffle(["A"] * nA + ["B"] * nB + ["C"] * nC)
    pools = {cat: shuffle([{"name": n, "i": i} for i, n in enumerate(names)]) for cat, names in NAME_POOLS.items()}
    products = []
    for i, category in enumerate(cats):
        entry = pools[category].pop()
        order = shuffle([1, 2, 3, 4])  # JS evaluates shuffle() before the slice length's rng()
        affinity = sorted(order[:1 if rng() < 0.6 else 2])
        products.append(dict(sku=f"SKU-{101 + i}", name=entry["name"], category=category,
                             allergen=C_ALLERGENS[entry["i"]] if category == "C" else None, affinity=affinity))
    for sys in SYSTEMS:
        if not any(sys in p["affinity"] for p in products):
            p = pick([q for q in products if len(q["affinity"]) == 1])
            p["affinity"] = sorted(p["affinity"] + [sys])

    # 2. Orders
    small_used = 0
    load = [0, 0, 0, 0]
    batches: list[dict] = []
    fills: list[dict] = []
    trio_left = 0
    trio_spec = None
    trio_n = 0
    slots = None
    if mix:
        units = []
        for sys in SYSTEMS:
            for cat in ["A", "B", "C"]:
                left = max(0, js_round((mix.get(sys) or {}).get(cat) or 0))
                while left > 0:
                    if sys == 1 and left >= 3 and rng() * 100 < trio_pct:
                        units.append({"system": 1, "cat": cat, "trio": True}); left -= 3
                    else:
                        units.append({"system": sys, "cat": cat, "trio": False}); left -= 1
        slots = []
        for u in shuffle(units):
            slots.extend([u, {"member": True}, {"member": True}] if u["trio"] else [u])
        batch_count = len(slots)
    plan_weeks = max(1, math.floor((batch_count * (batch_min + batch_max)) / 2 / 2.6 / WEEK))
    small_cap = 3 * plan_weeks

    def product_for(sys, cat):
        ok = [q for q in products if q["category"] == cat and sys in q["affinity"]]
        if ok:
            return pick(ok)
        anyp = sorted([q for q in products if q["category"] == cat], key=lambda q: len(q["affinity"]))
        q = anyp[0]
        q["affinity"] = sorted(q["affinity"] + [sys])
        return q

    for i in range(batch_count):
        trio_id = None
        if trio_left > 0:
            p, duration, system = trio_spec["p"], trio_spec["duration"], trio_spec["system"]
            trio_left -= 1
            trio_id = trio_spec["id"]
        elif slots is not None:
            u = slots[i]
            system = u["system"]
            p = product_for(system, u["cat"])
            duration = rand_int(*batch_span(system))
            if u["trio"]:
                trio_n += 1
                trio_spec = {"p": p, "duration": duration, "system": system, "id": f"TRIO-{trio_n}"}
                trio_left = 2
                trio_id = trio_spec["id"]
        else:
            p = pick(products)
            system = sorted(p["affinity"], key=lambda a: load[a - 1])[0]
            duration = rand_int(*batch_span(system))
            if system == 1 and rng() * 100 < trio_pct:
                trio_n += 1
                trio_spec = {"p": p, "duration": duration, "system": system, "id": f"TRIO-{trio_n}"}
                trio_left = 2
                trio_id = trio_spec["id"]
        load[system - 1] += duration
        bid = f"BPO-{1001 + i}"
        fill_ids = []
        trio_last = (not trio_id) or trio_left == 0 or i == batch_count - 1
        if not trio_last:
            n_fills = 0
        else:
            draw = rng() * 100  # one draw either way, so weeks without 3-fill trios match v49
            if trio_id:
                n_fills = 3 if draw < trio_three_fill_pct else 1  # H8: 1 or 3 fills per trio
            else:
                n_fills = 2 if draw < double_fill.get(system, 20) else 1
        for _ in range(n_fills):
            f_lo, f_hi = fill_span(system)
            f_dur = f_lo + 0.5 * rand_int(0, js_round((f_hi - f_lo) * 2))
            pack = pick(["1000L", "1000L", "220L", "110L", "20L", "20L"])
            if system == 4 and small_used < small_cap and rng() < 0.3:
                pack = pick(SMALL_PACKS)
                small_used += 1
            fid = f"FPO-{2001 + len(fills)}"
            fills.append(dict(id=fid, batchId=bid, sku=p["sku"], productName=p["name"], category=p["category"],
                              system=system, duration=f_dur, pack=pack, format=PACK_LABEL[pack]))
            fill_ids.append(fid)
        batches.append(dict(id=bid, sku=p["sku"], productName=p["name"], category=p["category"], system=system,
                            duration=duration, fillIds=fill_ids, trioId=trio_id))

    fill_by_id = {f["id"]: f for f in fills}
    for b in batches:  # a trio's fill moves to its first batch (H8)
        if not b["trioId"] or not b["fillIds"]:
            continue
        first = next(x for x in batches if x["trioId"] == b["trioId"])
        if first is b:
            continue
        for fid in b["fillIds"]:
            fill_by_id[fid]["batchId"] = first["id"]
        first["fillIds"] = b["fillIds"]
        b["fillIds"] = []

    hold_rng = mulberry32((seed ^ 0x9E3779B9) & 0xFFFFFFFF)
    hold_lo, hold_hi = hold_range
    for p in products:
        p["holdMax"] = hold_lo + math.floor(hold_rng() * (hold_hi - hold_lo + 1))
    hold_of = {p["sku"]: p["holdMax"] for p in products}
    by_batch = {b["id"]: b for b in batches}
    for b in batches:
        b["volumeL"] = capacity[b["system"]]
    for f in fills:
        b = by_batch[f["batchId"]]
        share = f["duration"] / sum(fill_by_id[x]["duration"] for x in b["fillIds"])
        source = (sum(1 for x in batches if x["trioId"] == b["trioId"]) * b["volumeL"]) if b["trioId"] else b["volumeL"]
        f["volumeL"] = js_round(source * share)
        f["units"] = math.floor(f["volumeL"] / float(f["pack"].rstrip("L")))
        f["holdMax"] = hold_of[f["sku"]]
    for b in batches:
        b["duration"] = _num(b["duration"])
    for f in fills:
        f["duration"] = _num(f["duration"])
    return Plant(seed=seed, products=[Product(**p) for p in products], batches=[Batch(**b) for b in batches],
                 fills=[Fill(**f) for f in fills])
