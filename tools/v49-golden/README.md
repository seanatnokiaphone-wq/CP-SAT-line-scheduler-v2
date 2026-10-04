# v49 engine in Node

`engine.mjs` is lines 57-1590 of App-v49-2026-10-04.jsx (plant model, generator, dispatch heuristic, scoring), unchanged.
It runs in plain Node 22 with no dependencies.

- `node base.mjs`  heuristic baseline table (seeds 42/1/7, 30-200 POs, default PM, 120h week limit)
- `node f7.mjs`    where F7 fills land at 200 POs (shows the H10 weekly-cap spill past hour 168)
- `node size.mjs`  rough MILP size estimate per week size (formula from the design doc)

Next step: a script here that writes golden JSON (generatePlant + schedulePlant) for the Python parity tests.
