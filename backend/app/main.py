"""HTTP API for the line scheduler (item 2: a live app instead of a pre-computed viewer).

Run:  cd backend && uvicorn app.main:app --reload --port 8000
The React app (frontend/) talks to /api; a built front end in frontend/dist is served at / as well.

Weeks, plans and jobs live in memory and are also saved under backend/data/ so a restart keeps them.
One solve runs at a time (CP-SAT already uses every core); later jobs queue.
"""
from __future__ import annotations

import io
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from scheduler.cpsat import Settings
from scheduler.generator import generate_plant
from scheduler.optimise import optimise
from scheduler.plant import (FILL_LINES, FILL_RATE_LPH, SYSTEMS, WEEK, Downtime, Plant, Schedule,
                             default_maintenance)
from scheduler.validate import validate

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("LS_DATA_DIR") or Path(__file__).resolve().parents[1] / "data")
DATA.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="CP-SAT Line Scheduler", version="0.5.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

LOCK = threading.Lock()
WEEKS: dict[str, dict] = {}
PLANS: dict[str, dict] = {}
JOBS: dict[str, dict] = {}
POOL = ThreadPoolExecutor(max_workers=1)


def _dump(model) -> Any:
    return json.loads(model.model_dump_json(by_alias=True))


def _save(kind: str, obj: dict):
    (DATA / kind).mkdir(exist_ok=True)
    (DATA / kind / f"{obj['id']}.json").write_text(json.dumps(obj))


def _load():
    for kind, store in (("weeks", WEEKS), ("plans", PLANS)):
        for f in sorted((DATA / kind).glob("*.json")) if (DATA / kind).exists() else []:
            try:
                o = json.loads(f.read_text())
                store[o["id"]] = o
            except Exception:  # noqa: BLE001 - a bad file should not stop the server
                pass


_load()


def _week(wid: str) -> dict:
    w = WEEKS.get(wid)
    if not w:
        raise HTTPException(404, f"week {wid} not found")
    return w


def _plant(w) -> Plant:
    return Plant(**w["plant"])


def _downtime(w) -> list[Downtime]:
    return [Downtime(**d) for d in w["downtime"]]


def _new_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# ---------------- reference ----------------

@app.get("/api/health")
def health():
    return {"ok": True, "weeks": len(WEEKS), "plans": len(PLANS), "jobs_running": sum(j["state"] == "running" for j in JOBS.values())}


@app.get("/api/config")
def config():
    rules = (ROOT / "RULES.md").read_text() if (ROOT / "RULES.md").exists() else ""
    return {"week_limit": 120.0, "week_hours": WEEK, "systems": SYSTEMS,
            "lines": [_dump(l) if hasattr(l, "model_dump_json") else l.__dict__ for l in FILL_LINES],
            "fill_rates": FILL_RATE_LPH, "rules_md": rules}


# ---------------- weeks ----------------

class GenerateIn(BaseModel):
    seed: int = 42
    pos: int = Field(60, ge=1, le=400)
    name: Optional[str] = None
    trio_three_fill_pct: Optional[float] = None
    fill_time: str = "rate"


@app.post("/api/weeks/generate")
def generate(body: GenerateIn):
    kw = {"fill_time": body.fill_time}
    if body.trio_three_fill_pct is not None:
        kw["trio_three_fill_pct"] = body.trio_three_fill_pct
    plant = generate_plant(body.seed, body.pos, **kw)
    w = {"id": _new_id("wk"), "name": body.name or f"{body.pos} POs · seed {body.seed}", "created": time.time(),
         "source": "generated", "seed": body.seed, "pos": body.pos,
         "plant": _dump(plant), "downtime": [_dump(d) for d in default_maintenance()]}
    WEEKS[w["id"]] = w
    _save("weeks", w)
    return _week_summary(w)


@app.post("/api/weeks/upload")
async def upload(request: Request):
    """A week saved from this app (JSON with plant + downtime). Importing real plant files is a later step."""
    body = await request.json()
    try:
        plant = Plant(**body["plant"])
        dt = [Downtime(**d) for d in body.get("downtime") or [_dump(x) for x in default_maintenance()]]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"not a week file: {e}") from e
    w = {"id": _new_id("wk"), "name": body.get("name") or "Uploaded week", "created": time.time(), "source": "upload",
         "plant": _dump(plant), "downtime": [_dump(d) for d in dt]}
    WEEKS[w["id"]] = w
    _save("weeks", w)
    return _week_summary(w)


def _week_summary(w):
    p = w["plant"]
    plans = sorted([x for x in PLANS.values() if x["week_id"] == w["id"]], key=lambda x: x["created"])
    return {"id": w["id"], "name": w["name"], "created": w["created"], "batches": len(p["batches"]), "fills": len(p["fills"]),
            "plans": [_plan_summary(x) for x in plans]}


@app.get("/api/weeks")
def weeks():
    return [_week_summary(w) for w in sorted(WEEKS.values(), key=lambda w: -w["created"])]


@app.get("/api/weeks/{wid}")
def week(wid: str):
    w = _week(wid)
    return {**_week_summary(w), "plant": w["plant"], "downtime": w["downtime"]}


@app.delete("/api/weeks/{wid}")
def delete_week(wid: str):
    _week(wid)
    WEEKS.pop(wid)
    (DATA / "weeks" / f"{wid}.json").unlink(missing_ok=True)
    for pid in [k for k, v in PLANS.items() if v["week_id"] == wid]:
        PLANS.pop(pid)
        (DATA / "plans" / f"{pid}.json").unlink(missing_ok=True)
    return {"ok": True}


# ---------------- plans ----------------

def _plan_summary(p):
    return {"id": p["id"], "week_id": p["week_id"], "name": p["name"], "engine": p["engine"], "created": p["created"],
            "metrics": p["metrics"], "valid": p["valid"], "seconds": p.get("seconds"), "kind": p.get("kind", "optimise")}


def _store_plan(w, sch: Schedule, name: str, info: dict | None = None, kind="optimise", settings: dict | None = None):
    plant, dt = _plant(w), _downtime(w)
    rep = validate(plant, sch, dt)
    p = {"id": _new_id("pl"), "week_id": w["id"], "name": name, "engine": sch.engine, "created": time.time(),
         "metrics": rep.metrics, "valid": rep.ok, "violations": [v.__dict__ if hasattr(v, "__dict__") else v for v in rep.violations][:50],
         "schedule": _dump(sch), "info": _jsonable(info or {}), "kind": kind, "settings": settings or {},
         "seconds": (info or {}).get("seconds")}
    PLANS[p["id"]] = p
    _save("plans", p)
    return p


def _jsonable(o):
    return json.loads(json.dumps(o, default=lambda x: _dump(x) if hasattr(x, "model_dump_json") else str(x)))


def _plan(pid: str) -> dict:
    p = PLANS.get(pid)
    if not p:
        raise HTTPException(404, f"plan {pid} not found")
    return p


@app.get("/api/plans/{pid}")
def plan(pid: str):
    return _plan(pid)


@app.delete("/api/plans/{pid}")
def delete_plan(pid: str):
    _plan(pid)
    PLANS.pop(pid)
    (DATA / "plans" / f"{pid}.json").unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/plans/{pid}/explain")
def plan_explain(pid: str):
    from scheduler.explain import explain
    p = _plan(pid)
    w = _week(p["week_id"])
    return explain(_plant(w), Schedule(**p["schedule"]), _downtime(w))


@app.get("/api/plans/{pid}/export.xlsx")
def export_xlsx(pid: str):
    from scheduler.exports import to_xlsx
    p = _plan(pid)
    w = _week(p["week_id"])
    buf = io.BytesIO()
    to_xlsx(_plant(w), Schedule(**p["schedule"]), _downtime(w), p["metrics"], buf)
    return StreamingResponse(io.BytesIO(buf.getvalue()), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{_fname(w, p)}.xlsx"'})


@app.get("/api/plans/{pid}/export.pdf")
def export_pdf(pid: str):
    from scheduler.exports import to_pdf
    p = _plan(pid)
    w = _week(p["week_id"])
    buf = io.BytesIO()
    to_pdf(_plant(w), Schedule(**p["schedule"]), _downtime(w), p["metrics"], buf)
    return StreamingResponse(io.BytesIO(buf.getvalue()), media_type="application/pdf",
                             headers={"Content-Disposition": f'attachment; filename="{_fname(w, p)}.pdf"'})


def _fname(w, p):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in f"{w['name']}-{p['name']}")[:80]


@app.get("/api/weeks/{wid}/export.json")
def export_week(wid: str):
    w = _week(wid)
    return JSONResponse({"name": w["name"], "plant": w["plant"], "downtime": w["downtime"]},
                        headers={"Content-Disposition": f'attachment; filename="{_fname(w, {"name": "week"})}.json"'})


# ---------------- jobs: optimise and scenarios ----------------

class OptimiseIn(BaseModel):
    time_limit: float = Field(60, ge=3, le=3600)
    goal: str = "fit"
    name: Optional[str] = None
    starred: list[str] = []  # P1 urgent fills
    targets: dict[str, float] = {}  # P2 fill -> wanted start hour
    pins: dict[str, dict] = {}  # M11
    replan_from: Optional[float] = None  # M1/M10, needs base_plan_id
    base_plan_id: Optional[str] = None


def _job(kind, week_id, title):
    j = {"id": _new_id("job"), "kind": kind, "week_id": week_id, "title": title, "state": "queued", "created": time.time(),
         "events": [], "result": None, "error": None, "cancel": False}
    JOBS[j["id"]] = j
    return j


def _event(j, ev: dict):
    with LOCK:
        ev = {**ev, "n": len(j["events"]), "t": round(time.time() - j.get("started", time.time()), 1)}
        j["events"].append(ev)


@app.post("/api/weeks/{wid}/optimise")
def start_optimise(wid: str, body: OptimiseIn):
    w = _week(wid)
    base = None
    if body.base_plan_id:
        base = Schedule(**_plan(body.base_plan_id)["schedule"])
    if body.replan_from is not None and base is None:
        raise HTTPException(422, "re-planning from a time needs base_plan_id (the plan being re-planned)")
    title = body.name or (f"Re-plan from {body.replan_from}h" if body.replan_from is not None else f"Optimise {int(body.time_limit)}s")
    j = _job("optimise", wid, title)

    def run():
        j["state"], j["started"] = "running", time.time()
        plant, dt = _plant(w), _downtime(w)
        s = Settings(time_limit=body.time_limit, goal=body.goal, starred=body.starred, targets=body.targets,
                     pins=body.pins, replan_from=body.replan_from, should_stop=lambda: j["cancel"])

        def on_progress(e):
            _event(j, {"stage": e["stage"], "engine": e["engine"], "metrics": e["metrics"], "valid": e["valid"],
                       "schedule": _dump(e["schedule"])})
        try:
            sch, info = optimise(plant, dt, s, base=base, on_progress=on_progress)
            p = _store_plan(w, sch, title, info, settings=body.model_dump())
            j["result"] = {"plan_id": p["id"]}
            j["state"] = "cancelled" if j["cancel"] else "done"
        except Exception as e:  # noqa: BLE001
            j["state"], j["error"] = "failed", f"{type(e).__name__}: {e}"
        j["finished"] = time.time()

    POOL.submit(run)
    return _job_view(j)


class ScenariosIn(BaseModel):
    scenarios: list[dict]
    time_limit: float = Field(30, ge=3, le=1800)


@app.get("/api/scenarios/presets")
def presets():
    from scheduler.scenarios import PRESETS
    return [{"name": s.name, "overrides": s.describe(), "scenario": json.loads(s.model_dump_json(exclude_none=True))} for s in PRESETS]


@app.post("/api/weeks/{wid}/scenarios")
def start_scenarios(wid: str, body: ScenariosIn):
    from scheduler.scenarios import Scenario, compare, run_scenarios
    w = _week(wid)
    try:
        scs = [Scenario(**s) for s in body.scenarios]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, str(e)) from e
    j = _job("scenarios", wid, f"What-if: {', '.join(s.name for s in scs)}")

    def run():
        j["state"], j["started"] = "running", time.time()
        try:
            _event(j, {"stage": f"running {len(scs) + 1} plans, {int(body.time_limit)}s each"})
            res = run_scenarios(_plant(w), _downtime(w), scs, Settings(time_limit=body.time_limit, should_stop=lambda: j["cancel"]))
            rows = compare(res)
            plans = {}
            for r in res:
                p = _store_plan(w, r["schedule"], f"What-if: {r['name']}", {"overrides": r["overrides"], "seconds": r["seconds"]}, kind="scenario")
                # a scenario changes inputs (durations, stops, hold limits), so its own check is the one that counts
                p.update(metrics=r["metrics"], valid=r["valid"])
                _save("plans", p)
                plans[r["name"]] = p["id"]
            j["result"] = {"rows": _jsonable([{k: v for k, v in r.items()} for r in rows]),
                           "overrides": {r["name"]: r["overrides"] for r in res}, "plans": plans}
            j["state"] = "done"
        except Exception as e:  # noqa: BLE001
            j["state"], j["error"] = "failed", f"{type(e).__name__}: {e}"
        j["finished"] = time.time()

    POOL.submit(run)
    return _job_view(j)


def _job_view(j, since: int = 0, with_schedules=False):
    evs = j["events"][since:]
    if not with_schedules:
        evs = [{k: v for k, v in e.items() if k != "schedule"} for e in evs]
    return {k: j[k] for k in ("id", "kind", "week_id", "title", "state", "created", "result", "error")} | {"events": evs, "event_count": len(j["events"])}


@app.get("/api/jobs")
def jobs():
    return [_job_view(j) for j in sorted(JOBS.values(), key=lambda j: -j["created"])][:30]


@app.get("/api/jobs/{jid}")
def job(jid: str, since: int = 0):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "job not found")
    return _job_view(j, since)


@app.post("/api/jobs/{jid}/cancel")
def cancel(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "job not found")
    j["cancel"] = True
    return _job_view(j)


@app.get("/api/jobs/{jid}/stream")
def stream(jid: str):
    """Server-sent events: one per progress event (with the plan so far), then a final 'end'."""
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "job not found")

    def gen():
        sent = 0
        while True:
            evs = j["events"][sent:]
            for e in evs:
                yield f"data: {json.dumps(e)}\n\n"
            sent += len(evs)
            if j["state"] in ("done", "failed", "cancelled") and sent >= len(j["events"]):
                yield f"event: end\ndata: {json.dumps(_job_view(j, sent))}\n\n"
                return
            time.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------------- front end ----------------

DIST = ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
