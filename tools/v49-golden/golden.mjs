// Writes golden JSON from v49's own engine: the generated week and v49's best heuristic schedule.
import { writeFileSync } from 'fs';
import { generatePlant, searchSchedules, defaultMaintenance, windowFit } from './engine.mjs';
const out = process.argv[2] || '../../backend/tests/golden';
const cases = [];
for (const seed of [1, 2, 3, 7, 11, 42, 99, 123, 2024, 31337]) for (const n of [10, 30, 100, 200]) cases.push({ seed, n });
cases.push({ seed: 5, n: 60, opts: { trioPct: 100, doubleFill: { 1: 50, 2: 50, 3: 50, 4: 50 }, holdRange: [8, 10] } });
cases.push({ seed: 6, n: 0, opts: { mix: { 1: { A: 6, B: 4, C: 3 }, 2: { A: 5, B: 3, C: 2 }, 3: { A: 4, B: 4, C: 4 }, 4: { A: 7, B: 2, C: 3 } } } });
cases.push({ seed: 8, n: 80, opts: { runTimes: { 1: { batch: [4, 8], fill: [1, 2] }, 3: { batch: [2, 3], fill: [0.5, 1] } } } });
const downtime = defaultMaintenance();
for (const c of cases) {
  const plant = generatePlant(c.seed, c.n, 0.5, 3, 3, 6, c.opts || {});
  const name = `s${c.seed}_n${c.n}${c.opts ? '_opts' : ''}`;
  const g = { case: c, plant };
  if (c.n <= 200) {
    const best = searchSchedules(plant, { downtime, goal: 'fit', fitLimit: 120 }, 0)[0];
    const r = best.res;
    g.heuristic = {
      strategy: { rule: best.strategy.rule, fillRule: best.strategy.fillRule, fillWindow: best.strategy.fillWindow ?? true },
      makespan: r.makespan, lateFills: r.totals.lateFills, fit120: windowFit(r, 120).count,
      cipH: r.totals.cipH, fillerCipH: r.totals.fillerCipH, fillWait: r.totals.fillWait,
      batches: r.batches.map((b) => ({ id: b.id, tank: b.tank, start: b.start, end: b.end })),
      cips: r.cips.map((x) => ({ tank: x.tank, toBatch: x.toBatch, start: x.start, end: x.end, rule: x.rule })),
      fills: r.fills.map((f) => ({ id: f.id, line: f.filler, start: f.start, end: f.end })),
      fillerCips: r.fillerCips.map((x) => ({ line: x.filler, toFill: x.toFill, start: x.start, end: x.end })),
    };
  }
  writeFileSync(`${out}/${name}.json`, JSON.stringify(g));
}
writeFileSync(`${out}/downtime_default.json`, JSON.stringify(downtime));
console.log('wrote', cases.length);
