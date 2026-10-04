import { generatePlant, searchSchedules, windowFit, defaultMaintenance } from './engine.mjs';
for (const [s,n] of [[42,30],[42,100],[1,200],[42,200],[7,200]]) {
  const p = generatePlant(s, n); const t0=Date.now();
  const r = searchSchedules(p, { downtime: defaultMaintenance(), goal: 'fit', fitLimit: 120 }, 0)[0].res;
  const f7 = r.fills.filter(f=>f.filler==='F7').length;
  console.log(`| ${s} | ${n} | ${p.fills.length} | ${f7} | ${windowFit(r,120).count} | ${r.totals.lateFills} | ${r.makespan} | ${(r.totals.cipH+r.totals.fillerCipH).toFixed(1)} | ${((Date.now()-t0)/1000).toFixed(1)} |`);
}
