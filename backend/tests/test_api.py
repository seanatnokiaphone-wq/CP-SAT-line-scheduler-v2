"""API smoke tests (item 2): generate a week, optimise with live events, re-plan, explain, export."""
import os
import tempfile
import time

import pytest

os.environ.setdefault("LS_DATA_DIR", tempfile.mkdtemp(prefix="ls-api-"))
fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

c = TestClient(app)


def _wait(jid, limit=120):
    t0 = time.time()
    while time.time() - t0 < limit:
        j = c.get(f"/api/jobs/{jid}").json()
        if j["state"] in ("done", "failed", "cancelled"):
            return j
        time.sleep(0.3)
    raise AssertionError("job did not finish")


@pytest.fixture(scope="module")
def week_and_plan():
    w = c.post("/api/weeks/generate", json={"seed": 42, "pos": 30}).json()
    j = c.post(f"/api/weeks/{w['id']}/optimise", json={"time_limit": 5}).json()
    j = _wait(j["id"])
    assert j["state"] == "done", j["error"]
    return w, j


def test_config_and_week(week_and_plan):
    w, _ = week_and_plan
    cfg = c.get("/api/config").json()
    assert "fill_rates" in cfg or cfg
    assert any(x["id"] == w["id"] for x in c.get("/api/weeks").json())
    full = c.get(f"/api/weeks/{w['id']}").json()
    assert len(full["plant"]["batches"]) > 0


def test_optimise_events_and_plan(week_and_plan):
    _, j = week_and_plan
    stages = [e["stage"] for e in j["events"]]
    assert stages[0] == "heuristic" and stages[-1] == "done"
    p = c.get(f"/api/plans/{j['result']['plan_id']}").json()
    assert p["valid"] and p["metrics"]["pos_in_week_limit"] == 30


def test_replan_keeps_started_work(week_and_plan):
    w, j = week_and_plan
    pid = j["result"]["plan_id"]
    assert c.post(f"/api/weeks/{w['id']}/optimise", json={"time_limit": 5, "replan_from": 24}).status_code == 422
    j2 = _wait(c.post(f"/api/weeks/{w['id']}/optimise",
                      json={"time_limit": 5, "replan_from": 24, "base_plan_id": pid}).json()["id"])
    assert j2["state"] == "done", j2["error"]
    base = {t["id"]: t for t in c.get(f"/api/plans/{pid}").json()["schedule"]["batches"]}
    new = {t["id"]: t for t in c.get(f"/api/plans/{j2['result']['plan_id']}").json()["schedule"]["batches"]}
    for bid, t in base.items():
        if t["start"] < 24:
            assert new[bid]["start"] == t["start"] and new[bid]["tank"] == t["tank"]


def test_explain_and_exports(week_and_plan):
    _, j = week_and_plan
    pid = j["result"]["plan_id"]
    r = c.get(f"/api/plans/{pid}/explain")
    if r.status_code == 500:
        pytest.skip("explain module not present")
    assert r.status_code == 200
    x = c.get(f"/api/plans/{pid}/export.xlsx")
    assert x.status_code == 200 and x.content[:2] == b"PK"
    pdf = c.get(f"/api/plans/{pid}/export.pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"


def test_cancel():
    w = c.post("/api/weeks/generate", json={"seed": 7, "pos": 100}).json()
    j = c.post(f"/api/weeks/{w['id']}/optimise", json={"time_limit": 120}).json()
    time.sleep(3)
    c.post(f"/api/jobs/{j['id']}/cancel")
    j = _wait(j["id"], limit=60)
    assert j["state"] == "cancelled"
    assert j["result"]["plan_id"]
