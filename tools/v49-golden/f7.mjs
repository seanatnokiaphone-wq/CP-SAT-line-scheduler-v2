import { generatePlant, searchSchedules, defaultMaintenance } from './engine.mjs';
for (const s of [1,42,7]) { const p = generatePlant(s, 200); const r = searchSchedules(p, { downtime: defaultMaintenance(), goal: 'fit', fitLimit: 120 }, 0)[0].res;
 console.log(s, r.makespan, r.fills.filter(f=>f.filler==='F7').map(f=>`${f.start.toFixed(1)}-${f.end.toFixed(1)}${f.late>0?' over':''}`).join(', ')); }
