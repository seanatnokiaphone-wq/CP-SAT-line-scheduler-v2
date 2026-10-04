"""Benchmark CP-SAT against v49's heuristic on golden weeks; writes one JSON line per case."""
import json
import subprocess
import sys

cases = sys.argv[1].split(",")
tl = sys.argv[2] if len(sys.argv) > 2 else "60"
out = sys.argv[3] if len(sys.argv) > 3 else "bench.jsonl"
for c in cases:
    r = subprocess.run([sys.executable, "run_compare.py", c, tl], capture_output=True, text=True)
    line = [l for l in r.stdout.splitlines() if l.startswith("{")]
    with open(out, "a") as fh:
        fh.write((line[-1] if line else json.dumps({"case": c, "error": r.stderr[-500:]})) + "\n")
    print(c, "done", flush=True)
