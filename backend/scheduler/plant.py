"""Plant constants and data models (brief section 1; rules H1, H5, H9, H10, H12, S1, S8)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

SYSTEMS = {1: ["T1A", "T1B", "T1C", "T1D"], 2: ["T2A", "T2B", "T2C", "T2D"],
           3: ["T3A", "T3B", "T3C", "T3D", "T3E"], 4: ["T4A", "T4B", "T4C", "T4D", "T4E"]}  # H1
TANK_SYSTEM = {t: s for s, ts in SYSTEMS.items() for t in ts}

CIP_HOURS = {"minor": 0.5, "standard": 1.5, "deep": 3.0}  # H5

PACK_LABEL = {"1000L": "1000 L IBC", "220L": "220 L drum", "110L": "110 L drum", "20L": "20 L pail",
              "1L": "1 L bottle", "3L": "3 L bottle", "5L": "5 L bottle"}
SMALL_PACKS = ["1L", "3L", "5L"]


class Line(BaseModel):
    id: str
    packs: list[str]
    twin: Optional[str] = None
    systems: Optional[list[int]] = None
    pack_change: float = 0.0
    weekly_max: Optional[int] = None
    excludes: list[str] = []


FILL_LINES = [  # H9, H10, H11
    Line(id="F1", packs=["1000L"], twin="F2"),
    Line(id="F2", packs=["1000L"], twin="F1"),
    Line(id="F3", packs=["220L", "110L"], twin="F4"),
    Line(id="F4", packs=["220L", "110L"], twin="F3"),
    Line(id="F5", packs=["20L"]),
    Line(id="F6", packs=["20L"]),
    Line(id="F7", packs=SMALL_PACKS, systems=[4], pack_change=3.0, weekly_max=3, excludes=["F5", "F6"]),
]
LINE_BY_ID = {l.id: l for l in FILL_LINES}
WEEK = 168.0  # F7's weekly cap counts per 168h from Monday 07:00 (H10)
TRIO_STAGGER = 1.0  # H8
TRIO_FILL_LEAD = 2.0  # H8
TARGET_WINDOW = 6.0  # P2
DEFAULT_CAPACITY = {1: 26000, 2: 22000, 3: 8000, 4: 6000}  # H12
# S14 (Sean, 2026-10-04 19:53 UTC): a fill PO's route time is its volume / the filler rate for its pack, with a
# +/-10% spread. Rates (litres per hour) are typical semi-automatic line figures chosen by Claude, to be
# replaced with the plant's own: IBC 8/h, 220 L drum 30/h, 110 L drum 45/h, 20 L pail 240/h,
# 1 L 3000/h, 3 L 1200/h, 5 L 900/h.
FILL_RATE_LPH = {"1000L": 8000, "220L": 6600, "110L": 4950, "20L": 4800, "1L": 3000, "3L": 3600, "5L": 4500}
FILL_RATE_SPREAD = 0.10
EPS = 1e-6


def lines_for(pack: str, system: int) -> list[str]:
    return [l.id for l in FILL_LINES if pack in l.packs and (l.systems is None or system in l.systems)]


def cip_rule(prev_sku: str, prev_cat: str, sku: str, cat: str) -> str:
    """H5 / H7 changeover matrix."""
    if prev_sku == sku:
        return "minor"
    if prev_cat != "A" and cat == "A":
        return "deep"
    return "standard"


def wash_hours(rule: str, mult: float = 1.0) -> float:
    """CIP length, scaled by the CIP multiplier and rounded to the quarter hour as v49 does."""
    from .rng import js_round
    return js_round(CIP_HOURS[rule] * mult * 4) / 4


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Product(Camel):
    sku: str
    name: str
    category: str
    allergen: Optional[str] = None
    affinity: list[int]
    hold_max: Optional[int] = None


class Batch(Camel):
    id: str
    sku: str
    product_name: str
    category: str
    system: int
    duration: float
    fill_ids: list[str]
    trio_id: Optional[str] = None
    volume_l: Optional[int] = None


class Fill(Camel):
    id: str
    batch_id: str
    sku: str
    product_name: str
    category: str
    system: int
    duration: float
    pack: str
    format: str
    volume_l: Optional[int] = None
    units: Optional[int] = None
    hold_max: Optional[int] = None


class Plant(Camel):
    seed: int
    products: list[Product]
    batches: list[Batch]
    fills: list[Fill]


class Downtime(Camel):
    id: str
    line: str
    start: float
    end: float
    kind: str = "scheduled"  # scheduled (PM, S8) or unscheduled (S9, M9)
    reason: str = ""


MAINT_SLOTS, MAINT_HOURS, MAINT_START = 3, 2.0, 24.0


def default_maintenance() -> list[Downtime]:
    """S8: 3 x 2h stops per line, one a day from Tuesday 07:00; the second twin of a pair 2h later (H15)."""
    out = []
    ids = [l.id for l in FILL_LINES]
    for l in FILL_LINES:
        stagger = MAINT_HOURS if l.twin and ids.index(l.twin) < ids.index(l.id) else 0.0
        for k in range(MAINT_SLOTS):
            s = MAINT_START + k * 24 + stagger
            out.append(Downtime(id=f"PM-{l.id}-{k + 1}", line=l.id, start=s, end=s + MAINT_HOURS,
                                kind="scheduled", reason="Planned maintenance"))
    return out


# ---------- Schedule ----------

class BatchTask(Camel):
    id: str
    tank: str
    start: float
    end: float
    cip_start: Optional[float] = None  # tank CIP before this batch (H5); None for a clean tank
    cip_end: Optional[float] = None
    cip_rule: Optional[str] = None


class FillTask(Camel):
    id: str
    line: str
    start: float
    end: float
    wash_start: Optional[float] = None  # line wash before this fill (H7, plus F7 pack change H10)
    wash_end: Optional[float] = None


class Schedule(Camel):
    engine: str
    batches: list[BatchTask]
    fills: list[FillTask]
    status: str = ""
    solve_seconds: float = 0.0
    objective: dict = {}
