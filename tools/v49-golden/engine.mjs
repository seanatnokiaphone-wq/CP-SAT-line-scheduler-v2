/* ==========================================================================
   Plant model
   ========================================================================== */

const SYSTEMS = [
  { id: 1, tanks: ['T1A', 'T1B', 'T1C', 'T1D'] },
  { id: 2, tanks: ['T2A', 'T2B', 'T2C', 'T2D'] },
  { id: 3, tanks: ['T3A', 'T3B', 'T3C', 'T3D', 'T3E'] },
  { id: 4, tanks: ['T4A', 'T4B', 'T4C', 'T4D', 'T4E'] },
];

const CATEGORIES = {
  A: { label: 'Standard / Light', clean: 'Low' },
  B: { label: 'High Flavor / Strong Color', clean: 'Medium' },
  C: { label: 'Allergen-containing', clean: 'High' },
};

const CIP_RULES = {
  minor: { hours: 0.5, label: 'Minor Flush' },
  standard: { hours: 1.5, label: 'Standard CIP' },
  deep: { hours: 3.0, label: 'Deep CIP' },
};

const NAME_POOLS = {
  A: ['Classic Lemonade', 'Sparkling Spring Water', 'Light Lemon-Lime', 'Coconut Water', 'White Grape',
    'Cucumber Mint Tonic', 'Pear Spritz', 'Jasmine Green Tea', 'Clear Apple', 'Electrolyte Zero',
    'White Peach Tea', 'Honeydew Splash'],
  B: ['Black Cherry Soda', 'Blue Raspberry', 'Cola Classic', 'Root Beer', 'Ginger Beer', 'Cold Brew Coffee',
    'Blood Orange', 'Beet & Berry', 'Hibiscus Punch', 'Grape Soda', 'Mango Chili', 'Espresso Tonic'],
  C: ['Peanut Protein Shake', 'Almond Milk Latte', 'Hazelnut Cocoa', 'Whole Milk Chocolate', 'Soy Vanilla Shake',
    'Cashew Cold Brew', 'Whey Strawberry', 'Oat & Egg Nog', 'Sesame Matcha', 'Walnut Maple Milk',
    'Royal Milk Tea', 'Coconut Cashew Cream'],
};
const C_ALLERGENS = ['Peanut', 'Tree nut', 'Tree nut', 'Milk', 'Soy', 'Tree nut', 'Milk', 'Egg', 'Sesame',
  'Tree nut', 'Milk', 'Tree nut'];

// Pack sizes; the key's number is litres per unit.
const PACKS = {
  '1000L': { label: '1000 L IBC' },
  '220L': { label: '220 L drum' },
  '110L': { label: '110 L drum' },
  '20L': { label: '20 L pail' },
  '1L': { label: '1 L bottle' },
  '3L': { label: '3 L bottle' },
  '5L': { label: '5 L bottle' },
};
const SMALL_PACKS = ['1L', '3L', '5L'];
// The seven fill lines. F7 takes System 4's small packs only, needs a pack changeover when the pack
// size changes, takes at most three fills in any week, and never fills while F5 or F6 is filling.
const FILL_LINES = [
  { id: 'F1', packs: ['1000L'], twin: 'F2' },
  { id: 'F2', packs: ['1000L'], twin: 'F1' },
  { id: 'F3', packs: ['220L', '110L'], twin: 'F4' },
  { id: 'F4', packs: ['220L', '110L'], twin: 'F3' },
  { id: 'F5', packs: ['20L'] },
  { id: 'F6', packs: ['20L'] },
  { id: 'F7', packs: SMALL_PACKS, systems: [4], packChange: 3, weeklyMax: 3, excludes: ['F5', 'F6'] },
];
const WEEK = 168;

// Filler maintenance. Each line gets MAINT_SLOTS planned stops of MAINT_HOURS, one a day from
// Tuesday 07:00 (plan hour 24). Twin lines (F1/F2, F3/F4) never stop together; F5 and F6 may (Sean, 2026-10-03), so the
// second of each pair is staggered by MAINT_HOURS. Lines in different pairs may overlap.
export const MAINT_SLOTS = 3;
export const MAINT_HOURS = 2;
export const MAINT_START = 24;
export function defaultMaintenance(lines = FILL_LINES) {
  const out = [];
  lines.forEach((l) => {
    const stagger = l.twin && lines.findIndex((m) => m.id === l.twin) < lines.indexOf(l) ? MAINT_HOURS : 0;
    for (let k = 0; k < MAINT_SLOTS; k++) {
      const start = MAINT_START + k * 24 + stagger;
      out.push({ id: `PM-${l.id}-${k + 1}`, line: l.id, start, end: start + MAINT_HOURS, kind: 'scheduled', reason: 'Planned maintenance' });
    }
  });
  return out;
}
// Why a planned stop can't go where asked, or null if it can.
export function maintenanceClash(list, slot, lines = FILL_LINES) {
  if (!(slot.end > slot.start)) return 'The stop needs a length.';
  const twin = lines.find((l) => l.id === slot.line)?.twin;
  for (const m of list) {
    if (m.id === slot.id || m.kind !== 'scheduled') continue;
    if (!(m.start < slot.end - EPS && slot.start < m.end - EPS)) continue;
    if (m.line === slot.line) return `${slot.line} already has a stop then.`;
    if (m.line === twin) return `${slot.line} and ${twin} can't be down together.`;
  }
  return null;
}
// Unscheduled stops (breakdowns) the simulation springs on the fill lines: `perWeek` across the plant,
// 0.5–3h each, at random times inside the plan.
export function drawBreakdowns(perWeek, span, seed, lines = FILL_LINES) {
  const rng = mulberry32((seed * 7919 + 101) >>> 0);
  const n = Math.round(perWeek * Math.max(1, span) / WEEK);
  const out = [];
  for (let i = 0; i < n; i++) {
    const line = lines[Math.floor(rng() * lines.length)].id;
    const start = Math.round(rng() * Math.max(1, span - 2) * 4) / 4 + 0.25;
    const hours = 0.5 + 0.5 * Math.floor(rng() * 6);
    out.push({ id: `BD-${i + 1}`, line, start, end: start + hours, kind: 'unscheduled', reason: 'Breakdown' });
  }
  return out.sort((a, b) => a.start - b.start);
}
const GATE_LOOKAHEAD = 1; // a held-back batch is committed this close to when it would otherwise start
const URGENT_SLACK = 2;
const TARGET_WINDOW = 6; // a targeted priority fill starts within this many hours of its target
const TARGET_LEAD = 2; // hours of hold time left before a fill jumps the line queue

const DISPATCH_RULES = {
  est: 'Earliest start',
  campaign: 'Category campaign',
  lpt: 'Longest batch first',
  spt: 'Shortest order first',
  random: 'Randomized batch order',
};
const FILL_RULES = {
  fifo: 'first-ready fill',
  setup: 'least filler CIP',
  lpt: 'longest fill first',
  spt: 'shortest fill first',
  random: 'randomized fill order',
};
const OPTIONS_KEPT = 10;
const RANDOM_CANDIDATES = 60;
// Large order books get fewer randomized tries so a re-roll stays around a second.
const randomCandidates = (n) => (n <= 60 ? RANDOM_CANDIDATES : n <= 120 ? 30 : 16);

const START_HOUR = 7; // plan hour 0 is Monday 07:00
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// A day and clock hour in the plan week, as plan hours from Monday 07:00.
const targetHour = ({ day, hour }) => day * 24 + hour - START_HOUR;
const EPS = 1e-6;

/* ==========================================================================
   Mock data generation (seeded so a plan can be reproduced)
   ========================================================================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A full batch fills the system's tank; capacity is in litres.
export const DEFAULT_CAPACITY = { 1: 26000, 2: 22000, 3: 8000, 4: 6000 };
// Share of batch POs per system that split into two fill POs, in percent.
export const DEFAULT_DOUBLE_FILL = { 1: 20, 2: 20, 3: 20, 4: 20 };

export function generatePlant(seed, batchCount, fillMin = 0.5, fillMax = 3, batchMin = 3, batchMax = 6,
  { capacity = DEFAULT_CAPACITY, holdRange = [6, 12], doubleFill = DEFAULT_DOUBLE_FILL, trioPct = 60, mix = null, runTimes = null } = {}) {
  // Run times can differ by system ({ system: { batch: [lo, hi], fill: [lo, hi] } }); the rest use the plant-wide ranges.
  const batchSpan = (sys) => (runTimes && runTimes[sys] && runTimes[sys].batch) || [batchMin, batchMax];
  const fillSpan = (sys) => (runTimes && runTimes[sys] && runTimes[sys].fill) || [fillMin, fillMax];
  const rng = mulberry32(seed);
  const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const shuffle = (arr) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  // 1. Products: 20 SKUs spread over the three cleaning categories.
  const nA = randInt(7, 10);
  const nB = randInt(5, 7);
  const nC = 20 - nA - nB;
  const cats = shuffle([...Array(nA).fill('A'), ...Array(nB).fill('B'), ...Array(nC).fill('C')]);
  const pools = Object.fromEntries(
    Object.entries(NAME_POOLS).map(([cat, names]) => [cat, shuffle(names.map((name, i) => ({ name, i })))])
  );
  const products = cats.map((category, i) => {
    const entry = pools[category].pop();
    const affinity = shuffle([1, 2, 3, 4]).slice(0, rng() < 0.6 ? 1 : 2).sort();
    return {
      sku: `SKU-${101 + i}`,
      name: entry.name,
      category,
      allergen: category === 'C' ? C_ALLERGENS[entry.i] : null,
      affinity,
    };
  });
  // Every system must be able to run at least one SKU.
  for (const sys of SYSTEMS) {
    if (!products.some((p) => p.affinity.includes(sys.id))) {
      const p = pick(products.filter((q) => q.affinity.length === 1));
      p.affinity = [...p.affinity, sys.id].sort();
    }
  }

  // 2. Orders: batch POs routed to the least-loaded system the SKU can run on. Small packs (F7) only
  // come from System 4 and are rare: about three per week of work.
  // F7 takes at most 3 fills a week, so the data asks for no more than that over the plan's rough
  // length (the 18 tanks get through about 2.6 batch-hours per clock hour).
  let smallUsed = 0;
  const load = [0, 0, 0, 0];
  const batches = [];
  const fills = [];
  // System 1 orders come in trios: three batch POs of the same SKU and run time. The trio has a
  // single fill PO, linked to the first batch, which empties all three tanks.
  let trioLeft = 0;
  let trioSpec = null;
  let trioN = 0;
  // An order mix ({ system: { A, B, C } }) fixes how many batch POs each system makes of each category.
  // System 1's orders still come partly as trios (3 POs of one SKU), taken from the same counts.
  let slots = null;
  if (mix) {
    const units = [];
    for (const sys of SYSTEMS) {
      for (const cat of ['A', 'B', 'C']) {
        let left = Math.max(0, Math.round((mix[sys.id] || {})[cat] || 0));
        while (left > 0) {
          if (sys.id === 1 && left >= 3 && rng() * 100 < trioPct) { units.push({ system: 1, cat, trio: true }); left -= 3; } else { units.push({ system: sys.id, cat, trio: false }); left -= 1; }
        }
      }
    }
    slots = shuffle(units).flatMap((u) => (u.trio ? [u, { member: true }, { member: true }] : [u]));
    batchCount = slots.length;
  }
  const planWeeks = Math.max(1, Math.floor((batchCount * (batchMin + batchMax)) / 2 / 2.6 / WEEK));
  const smallCap = 3 * planWeeks;
  // A product of `cat` that can run on `sys`; if none can, the one with the fewest systems learns it.
  const productFor = (sys, cat) => {
    const ok = products.filter((q) => q.category === cat && q.affinity.includes(sys));
    if (ok.length) return pick(ok);
    const any = products.filter((q) => q.category === cat).sort((a, b) => a.affinity.length - b.affinity.length);
    const q = any[0];
    q.affinity = [...q.affinity, sys].sort();
    return q;
  };
  for (let i = 0; i < batchCount; i++) {
    let p;
    let duration;
    let system;
    let trioId = null;
    if (trioLeft > 0) {
      ({ p, duration, system } = trioSpec);
      trioLeft -= 1;
      trioId = trioSpec.id;
    } else if (slots) {
      const u = slots[i];
      system = u.system;
      p = productFor(system, u.cat);
      duration = randInt(...batchSpan(system));
      if (u.trio) {
        trioSpec = { p, duration, system, id: `TRIO-${++trioN}` };
        trioLeft = 2;
        trioId = trioSpec.id;
      }
    } else {
      p = pick(products);
      system = [...p.affinity].sort((a, b) => load[a - 1] - load[b - 1])[0];
      duration = randInt(...batchSpan(system));
      // Only some System 1 orders are trios; the rest are ordinary single batches.
      if (system === 1 && rng() * 100 < trioPct) {
        trioSpec = { p, duration, system, id: `TRIO-${++trioN}` };
        trioLeft = 2;
        trioId = trioSpec.id;
      }
    }
    load[system - 1] += duration;
    const id = `BPO-${1001 + i}`;
    const fillIds = [];
    // A trio has one fill PO (drawn here on its last batch, then moved to its first below).
    const trioLast = !trioId || trioLeft === 0 || i === batchCount - 1;
    const nFills = !trioLast ? 0 : rng() * 100 < (doubleFill[system] ?? 20) && !trioId ? 2 : 1;
    for (let f = 0; f < nFills; f++) {
      const [fLo, fHi] = fillSpan(system);
      const fDur = fLo + 0.5 * randInt(0, Math.round((fHi - fLo) * 2)); // half-hour steps
      let pack = pick(['1000L', '1000L', '220L', '110L', '20L', '20L']);
      if (system === 4 && smallUsed < smallCap && rng() < 0.3) {
        pack = pick(SMALL_PACKS);
        smallUsed += 1;
      }
      const fid = `FPO-${2001 + fills.length}`;
      fills.push({
        id: fid, batchId: id, sku: p.sku, productName: p.name, category: p.category, system,
        duration: fDur, pack, format: PACKS[pack].label,
      });
      fillIds.push(fid);
    }
    batches.push({
      id, sku: p.sku, productName: p.name, category: p.category, system, duration,
      fillIds, trioId,
    });
  }
  // A trio's fill PO is linked to its first batch (drawn on the last, so the data set stays the same).
  for (const b of batches) {
    if (!b.trioId || !b.fillIds.length) continue;
    const first = batches.find((x) => x.trioId === b.trioId);
    if (first === b) continue;
    for (const id of b.fillIds) fills.find((f) => f.id === id).batchId = first.id;
    first.fillIds = b.fillIds;
    b.fillIds = [];
  }
  // Volumes and hold limits come after the main draws (and from their own stream), so changing a
  // capacity or the hold range never reshuffles the orders.
  const holdRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const [holdLo, holdHi] = holdRange;
  for (const p of products) p.holdMax = holdLo + Math.floor(holdRng() * (holdHi - holdLo + 1));
  const holdOf = Object.fromEntries(products.map((p) => [p.sku, p.holdMax]));
  const byBatch = Object.fromEntries(batches.map((b) => [b.id, b]));
  for (const b of batches) b.volumeL = capacity[b.system];
  for (const f of fills) {
    const b = byBatch[f.batchId];
    const share = f.duration / b.fillIds.reduce((sum, id) => sum + fills.find((x) => x.id === id).duration, 0);
    const source = b.trioId ? batches.filter((x) => x.trioId === b.trioId).length * b.volumeL : b.volumeL;
    f.volumeL = Math.round(source * share);
    f.units = Math.floor(f.volumeL / parseFloat(f.pack));
    f.holdMax = holdOf[f.sku];
  }
  return { seed, products, batches, fills };
}

/* ==========================================================================
   Scheduling heuristic engine
   ========================================================================== */

export function cipRule(prev, next) {
  if (prev.sku === next.sku) return 'minor';
  if (prev.category !== 'A' && next.category === 'A') return 'deep';
  return 'standard';
}

// Earliest start >= ready on any lane where [start, start + dur) is free. Lanes are sorted interval lists.
function findSlot(lanes, ready, dur) {
  let best = null;
  lanes.forEach((lane, li) => {
    let t = ready;
    for (const iv of lane) {
      if (iv.end <= t + EPS) continue;
      if (iv.start >= t + dur - EPS) break;
      t = iv.end;
    }
    if (!best || t < best.start - EPS) best = { lane: li, start: t };
  });
  return best;
}

function insertSorted(lane, iv) {
  lane.push(iv);
  lane.sort((a, b) => a.start - b.start);
}

export function schedulePlant(plant, params) {
  const {
    lines = FILL_LINES, cipMult = 1, skids = 1, extraTanks = 0, rule = 'est', fillRule = 'fifo',
    batchPriority = null, fillPriority = null, holdTank = true, group = true, priorityFills = [], priorityTargets = {},
    trio = true, fillWindow = true, downtime = [],
    // Re-planning mid-run: orders that already started are locked in place and nothing new starts
    // before `now`. `floors` holds batches that cannot start before a given time.
    frozen = null,
  } = params;
  const floor = frozen ? frozen.now : 0;
  const frozenIds = new Set(frozen ? frozen.batches.map((x) => x.id) : []);
  const floors = frozen ? { ...(frozen.floors || {}) } : {};
  // System 1 trio rule: three batches of the same SKU run on separate tanks, each starting
  // TRIO_STAGGER after the one before. The trio's one fill PO sits on the last batch and starts
  // TRIO_OVERLAP before that batch ends; all three tanks stay held until it is done.
  const TRIO_SYSTEM = 1;
  const TRIO_STAGGER = 1;
  const TRIO_OVERLAP = TRIO_FILL_LEAD;
  // High-priority fill POs: their parent batches take the next free tank in their system, and the
  // fills themselves jump the filler queue.
  // Stars, plus fills the improvement pass has moved up the queue.
  const prioFill = new Set([...priorityFills, ...(params.boostFills || [])]);
  const prioBatch = new Set(plant.fills.filter((f) => prioFill.has(f.id)).map((f) => f.batchId));
  // A priority fill can carry a target start (plan hours); it must start within TARGET_WINDOW of it.
  const windowOpen = {}; // fill id -> earliest start
  const batchEarliest = {}; // batch id -> latest-sensible start so its fill can open the window
  for (const f of plant.fills) {
    const t = priorityTargets[f.id];
    if (!prioFill.has(f.id) || t == null) continue;
    windowOpen[f.id] = Math.max(0, t - TARGET_WINDOW);
    const b = plant.batches.find((x) => x.id === f.batchId);
    batchEarliest[b.id] = Math.max(batchEarliest[b.id] || 0, windowOpen[f.id] - b.duration);
  }
  const openAt = (f, ready) => (windowOpen[f.id] != null ? Math.max(ready, windowOpen[f.id]) : ready);
  // Product grouping: a decision may wait up to this long if it avoids or shortens a CIP.
  const GROUP_WINDOW = 3;

  const tanks = [];
  for (const s of SYSTEMS) {
    const ids = [...s.tanks];
    for (let k = 0; k < extraTanks; k++) ids.push(`T${s.id}X${k + 1}`);
    ids.forEach((id) => tanks.push({ id, system: s.id, last: null, releaseAt: 0, released: true }));
  }
  const skidLanes = Object.fromEntries(SYSTEMS.map((s) => [s.id, Array.from({ length: skids }, () => [])]));
  const washHours = (prev, next) => (prev ? Math.round(CIP_RULES[cipRule(prev, next)].hours * cipMult * 4) / 4 : 0);

  const fillsOf = Object.fromEntries(plant.batches.map((b) => [b.id, []]));
  for (const f of plant.fills) fillsOf[f.batchId].push(f);
  const fillHoursOf = Object.fromEntries(plant.batches.map((b) => [b.id, fillsOf[b.id].reduce((s, f) => s + f.duration, 0)]));

  // Batch priority: lower index goes first when a rule has to choose.
  const ranked = [...plant.batches].sort(
    rule === 'campaign'
      ? (a, b) => a.category.localeCompare(b.category) || a.sku.localeCompare(b.sku) || b.duration - a.duration
      : rule === 'random'
        ? (a, b) => batchPriority[a.id] - batchPriority[b.id]
        : rule === 'lpt'
          ? (a, b) => b.duration - a.duration || fillHoursOf[b.id] - fillHoursOf[a.id]
          : rule === 'spt'
            ? (a, b) => a.duration + fillHoursOf[a.id] - b.duration - fillHoursOf[b.id]
            : (a, b) => fillHoursOf[b.id] - fillHoursOf[a.id]
  );
  const orderIdx = Object.fromEntries(ranked.map((b, i) => [b.id, i]));

  const groupOf = {}; // batch id -> { id, members } for System 1 trios
  if (trio) {
    // Members keep their order on the PO list, so the batch with the fills always runs last.
    const byTrio = {};
    for (const b of plant.batches) {
      if (b.system !== TRIO_SYSTEM || !b.trioId) continue;
      if (!byTrio[b.trioId]) byTrio[b.trioId] = { id: b.trioId, members: [] };
      byTrio[b.trioId].members.push(b);
      groupOf[b.id] = byTrio[b.trioId];
    }
  }
  // Which batch's fills empty a tank: its own, or for a trio the last member's single fill.
  // trioOf keeps every trio; groupOf only the ones still placed together. A re-plan that locks part of
  // a trio (the rest has not started) breaks it: the rest is placed one by one, no earlier than the stagger.
  const trioOf = { ...groupOf };
  if (frozen) {
    const lockedIds = new Set(frozen.batches.map((x) => x.id));
    const lockedStart = Object.fromEntries(frozen.batches.map((x) => [x.id, x.start]));
    for (const g of new Set(Object.values(groupOf))) {
      const locked = g.members.filter((m) => lockedIds.has(m.id));
      if (!locked.length || locked.length === g.members.length) continue;
      const lead = Math.min(...locked.map((m) => lockedStart[m.id] - g.members.indexOf(m) * TRIO_STAGGER));
      g.members.forEach((m, j) => {
        delete groupOf[m.id];
        if (!lockedIds.has(m.id)) floors[m.id] = Math.max(floors[m.id] ?? -Infinity, lead + j * TRIO_STAGGER);
      });
    }
  }
  const brokenTrios = [...new Set(Object.values(trioOf))].filter((g) => !groupOf[g.members[0].id]);
  const placedStart = {};
  const fillSourceOf = (b) => (trioOf[b.id] ? trioOf[b.id].members[0].id : b.id);
  const holders = {}; // fill-carrying batch id -> tanks held until its fills are done
  const fillsLeft = Object.fromEntries(plant.batches.map((b) => [b.id, fillsOf[b.id].length]));
  const isLeader = (b) => !groupOf[b.id] || groupOf[b.id].members[0] === b;

  // Candidate start of batch b on tank t: tank released (empty, or every fill from it done) ->
  // wait for a CIP skid -> wash -> batch.
  const evaluate = (b, t) => {
    if (!t.released) return null;
    const rel = Math.max(t.releaseAt, floor);
    if (!t.last) return { tank: t, start: rel, at: rel, cip: null };
    const r = cipRule(t.last, b);
    const hours = washHours(t.last, b);
    const slot = findSlot(skidLanes[b.system], rel, hours);
    return {
      tank: t, start: slot.start + hours, at: slot.start,
      cip: { rule: r, hours, start: slot.start, end: slot.start + hours, lane: slot.lane, wait: slot.start - t.releaseAt },
    };
  };
  const cipHours = (c) => (c.cip ? c.cip.hours : 0);
  const better = (a, b) =>
    !b || a.start < b.start - EPS || (Math.abs(a.start - b.start) < EPS && cipHours(a) < cipHours(b) - EPS);
  // Place a whole trio: the earliest released tanks, CIPs packed on the skid in batch order, and the
  // first start pushed back until every member can start exactly TRIO_STAGGER after the previous one.
  const evaluateGroup = (g) => {
    const k = g.members.length;
    const lead = g.members[0];
    const ready = tanks.filter((t) => t.system === lead.system && t.released)
      .map((t) => evaluate(lead, t))
      .sort((a, b) => a.start - b.start || cipHours(a) - cipHours(b));
    if (ready.length < k) return null;
    const lanes = skidLanes[lead.system].map((lane) => [...lane]);
    const placements = [];
    let s0 = 0;
    for (let j = 0; j < k; j++) {
      const t = ready[j].tank;
      const m = g.members[j];
      let cip = null;
      let earliest = Math.max(t.releaseAt, floor);
      if (t.last) {
        const hours = washHours(t.last, m);
        const slot = findSlot(lanes, earliest, hours);
        insertSorted(lanes[slot.lane], { start: slot.start, end: slot.start + hours });
        cip = { rule: cipRule(t.last, m), hours, start: slot.start, end: slot.start + hours, lane: slot.lane, wait: slot.start - t.releaseAt };
        earliest = cip.end;
      }
      s0 = Math.max(s0, earliest - j * TRIO_STAGGER);
      placements.push({ tank: t, cip });
    }
    placements.forEach((pl, j) => { pl.start = s0 + j * TRIO_STAGGER; });
    const at = Math.min(s0, ...placements.filter((pl) => pl.cip).map((pl) => pl.cip.start));
    const wash = placements.reduce((sum, pl) => sum + (pl.cip ? pl.cip.hours : 0), 0);
    return { group: g, placements, start: s0, at, cip: wash ? { hours: wash } : null };
  };

  const bestTank = (b) => {
    if (groupOf[b.id]) return evaluateGroup(groupOf[b.id]);
    let best = null;
    for (const t of tanks) {
      if (t.system !== b.system) continue;
      const c = evaluate(b, t);
      if (c && better(c, best)) best = c;
    }
    return best;
  };

  const batches = [];
  const cips = [];
  const fills = [];
  const fillerCips = [];
  const tankOf = {};
  const released = []; // fill POs whose parent batch is scheduled, not yet on a filler
  const fillers = lines.length;
  const fillerFree = Array(fillers).fill(0);
  const fillerLast = Array(fillers).fill(null);
  const canRun = (lane, f) => lines[lane].packs.includes(f.pack) && (!lines[lane].systems || lines[lane].systems.includes(f.system));
  // Downtime before f on a line: product CIP after the previous fill, plus a pack changeover where the line needs one.
  const lineChange = (lane, f) => {
    const prev = fillerLast[lane];
    if (!prev) return 0;
    return washHours(prev, f) + (lines[lane].packChange && prev.pack !== f.pack ? lines[lane].packChange : 0);
  };
  const weekCount = {}; // `${lane}:${week}` -> fills started, for lines with a weekly cap
  // Lines that may not fill at the same time (F7 against F5 and F6), in both directions.
  const fillIv = lines.map(() => []);
  // Downtime per line: no fill or wash runs inside it.
  const downIv = lines.map((l) => downtime.filter((d) => d.line === l.id).map((d) => ({ start: d.start, end: d.end })).sort((a, b) => a.start - b.start));
  const conflictLanes = lines.map((l, i) => lines.flatMap((m, j) => (j !== i && ((l.excludes || []).includes(m.id) || (m.excludes || []).includes(l.id)) ? [j] : [])));
  const pending = { 1: [], 2: [], 3: [], 4: [] };
  ranked.forEach((b) => pending[b.system].push(b));
  const cache = new Map();
  const dirty = new Set([1, 2, 3, 4]);

  const releaseTank = (t, at) => {
    t.released = true;
    t.releaseAt = at;
    t.last.holdEnd = at;
    dirty.add(t.system);
  };

  // Trio fills form one chain; only the head is released, each later link once its predecessor is placed.
  const chainNext = {};
  const commitGroup = (choice) => {
    const { group: g, placements } = choice;
    placements.forEach((pl, j) => commitBatch(g.members[j], { tank: pl.tank, start: pl.start, cip: pl.cip, gateWait: pl.gateWait, slip: pl.slip, locked: pl.slip != null || frozenIds.has(g.members[j].id) }));
    const lastEnd = batches.find((x) => x.id === g.members[g.members.length - 1].id).end;
    const chain = g.members.flatMap((m) => fillsOf[m.id]);
    if (!chain.length) return;
    chain.forEach((f, i) => { if (i) chainNext[chain[i - 1].id] = f; });
    const head = chain[0];
    // The fill starts TRIO_OVERLAP before the last batch ends (never finishing before it does); its
    // hold limit runs from the end of the last batch.
    const firstEnd = batches.find((x) => x.id === g.members[0].id).end;
    released.push({ ...head, ready: openAt(head, Math.max(firstEnd, lastEnd - Math.min(TRIO_OVERLAP, head.duration))), due: lastEnd + head.holdMax, chain: g.id, chainPos: 1 });
  };

  const commitBatch = (b, choice) => {
    const t = choice.tank;
    let cip = null;
    if (choice.cip) {
      cip = {
        ...choice.cip, id: `CIP-${cips.length + 1}`, kind: 'cip', system: b.system, tank: t.id,
        duration: choice.cip.hours, fromBatch: t.last.id, toBatch: b.id, fromSku: t.last.sku, toSku: b.sku,
        fromCat: t.last.category, toCat: b.category, tankFreeAt: t.releaseAt,
      };
      insertSorted(skidLanes[b.system][cip.lane], cip);
      cips.push(cip);
    }
    const sb = {
      ...b, kind: 'batch', tank: t.id, start: choice.start, end: choice.start + b.duration, holdEnd: choice.start + b.duration,
      cipId: cip ? cip.id : null,
      tankWait: cip ? cip.tankFreeAt : 0,
      skidWait: cip ? cip.wait : 0,
      cipLock: cip ? cip.duration : 0,
      gateWait: choice.gateWait || 0,
      slip: choice.slip || 0,
      locked: !!choice.locked,
    };
    t.last = sb;
    tankOf[b.id] = t;
    cache.delete(b.id);
    batches.push(sb);
    placedStart[sb.id] = sb.start;
    pending[b.system].splice(pending[b.system].indexOf(b), 1);
    if (trioOf[b.id]) {
      sb.trio = trioOf[b.id].id;
      sb.trioPos = trioOf[b.id].members.indexOf(b) + 1;
      sb.trioSize = trioOf[b.id].members.length;
    }
    if (!groupOf[b.id]) {
      if (trioOf[b.id]) {
        // A broken trio's fill (on its first batch) is released once its last batch is placed,
        // from TRIO_OVERLAP before that batch ends.
        const g = trioOf[b.id];
        if (g.members.every((m) => placedStart[m.id] != null)) {
          const lastEnd = Math.max(...g.members.map((m) => batches.find((x) => x.id === m.id).end));
          const firstEnd = batches.find((x) => x.id === g.members[0].id).end;
          for (const f of fillsOf[g.members[0].id]) {
            if (!released.some((r) => r.id === f.id) && !fills.some((r) => r.id === f.id)) released.push({ ...f, ready: openAt(f, Math.max(firstEnd, lastEnd - Math.min(TRIO_OVERLAP, f.duration))), due: lastEnd + f.holdMax });
          }
        }
      } else {
        for (const f of fillsOf[b.id]) released.push({ ...f, ready: openAt(f, sb.end), due: sb.end + f.holdMax });
      }
    }
    const src = fillSourceOf(b);
    (holders[src] = holders[src] || []).push(t);
    if (holdTank && fillsOf[src].length) t.released = false;
    else t.releaseAt = sb.end;
    dirty.add(b.system);
  };

  // Next batch decision: EST (and grouping) look at every pending batch, the other rules only at each
  // system's next in line. With grouping on, any batch that can start within the window competes on
  // CIP length first, so repeat SKUs and same-category products land back to back on a tank.
  const wide = rule === 'est' || group;
  const choiceFor = (b) => {
    if (!cache.has(b.id)) cache.set(b.id, bestTank(b));
    return cache.get(b.id);
  };
  // Urgent batches go first, unless none of them can be placed yet: a re-plan that splits a trio can
  // leave tanks held until other batches run, so the rest of the system must still move.
  const listFor = (sys) => {
    const leaders = pending[sys].filter(isLeader);
    const urgent = leaders.filter(isUrgent);
    const list = urgent.some(choiceFor) ? urgent : wide ? leaders : leaders.slice(0, 1);
    list.forEach(choiceFor);
    return list;
  };
  // Fill window: hold a batch back so it does not finish long before a line can take its fills.
  // A line's free time is estimated as when it goes idle plus its share of the fills already queued.
  const cappedOnly = (f) => lines.every((l, i) => !canRun(i, f) || l.weeklyMax);
  const hasCapped = lines.some((l) => l.weeklyMax);
  const fillGate = () => {
    const share = Array(fillers).fill(0);
    for (const f of released) {
      const ok = lines.map((_, l) => canRun(l, f));
      const n = ok.filter(Boolean).length;
      ok.forEach((y, l) => { if (y) share[l] += f.duration / n; });
    }
    // A capped line (F7) that has used this week's fills is not free again until next week.
    const queued = Array(fillers).fill(0);
    for (const f of released) for (let l = 0; l < fillers; l++) if (lines[l].weeklyMax && canRun(l, f)) queued[l] += 1;
    const avail = (f) => {
      let t = Infinity;
      for (let l = 0; l < fillers; l++) {
        if (!canRun(l, f)) continue;
        let lt = fillerFree[l] + share[l];
        const cap = lines[l].weeklyMax;
        if (cap) {
          let wk = Math.floor((lt + EPS) / WEEK);
          let need = queued[l] + 1;
          while ((weekCount[`${l}:${wk}`] || 0) + need > cap) { need -= Math.max(0, cap - (weekCount[`${l}:${wk}`] || 0)); wk += 1; }
          lt = Math.max(lt, wk * WEEK);
        }
        t = Math.min(t, lt);
      }
      return t;
    };
    const delayOf = (b, start) => {
      let d = 0;
      for (const f of fillsOf[b.id]) {
        // A targeted priority fill: finish the batch as its start window opens, not long before.
        if (windowOpen[f.id] != null) d = Math.max(d, windowOpen[f.id] - (start + b.duration));
        // F7's weekly cap always applies: a batch whose only line is out of fills this week waits, rather than its tank.
        if (!fillWindow && !cappedOnly(f)) continue;
        d = Math.max(d, avail(f) + f.duration - f.holdMax - (start + b.duration));
      }
      return d;
    };
    return (b, c) => {
      if (!c) return c;
      if (c.group) {
        const d = Math.max(0, ...c.group.members.map((m, j) => Math.max(delayOf(m, c.placements[j].start), (floors[m.id] ?? -Infinity) - c.placements[j].start)));
        if (d < EPS) return c;
        return { ...c, start: c.start + d, at: Math.max(c.at, c.at + d - GATE_LOOKAHEAD), gateWait: d, placements: c.placements.map((pl) => ({ ...pl, start: pl.start + d, gateWait: d })) };
      }
      let d = Math.max(delayOf(b, c.start), (floors[b.id] ?? -Infinity) - c.start);
      // A broken trio still runs in order, each batch at least the stagger after the one before.
      if (trioOf[b.id]) {
        // Broken trios finish one at a time, oldest first: two half-placed trios would each hold
        // tanks the other needs, and neither could ever fill.
        const leadOf = (g) => Math.min(Infinity, ...g.members.map((m) => placedStart[m.id] ?? Infinity));
        const mine = leadOf(trioOf[b.id]);
        for (const g of brokenTrios) {
          if (g === trioOf[b.id] || g.members.every((m) => placedStart[m.id] != null)) continue;
          const lead = leadOf(g);
          if (lead < mine || (lead === mine && lead < Infinity && g.id < trioOf[b.id].id)) return null;
        }
        const j = trioOf[b.id].members.indexOf(b);
        if (j > 0) {
          const prev = batches.find((x) => x.id === trioOf[b.id].members[j - 1].id);
          if (!prev) return null;
          d = Math.max(d, prev.start + TRIO_STAGGER - c.start);
        }
      }
      // A batch held back is decided later, so its tank stays free for other work meanwhile.
      return d < EPS ? c : { ...c, start: c.start + d, at: Math.max(c.at, c.at + d - GATE_LOOKAHEAD), gateWait: d };
    };
  };
  // A targeted priority batch only jumps the queue once a tank in its system is free near its start time.
  const sysClock = (sys) => Math.min(Infinity, ...tanks.filter((t) => t.system === sys && t.released).map((t) => t.releaseAt));
  const urgentNow = (m) => prioBatch.has(m.id) && (batchEarliest[m.id] == null || batchEarliest[m.id] <= sysClock(m.system) + TARGET_LEAD);
  const isUrgent = (b) => (groupOf[b.id] ? groupOf[b.id].members : [b]).some(urgentNow);
  const nextBatch = () => {
    for (const sys of dirty) {
      for (const b of pending[sys]) cache.delete(b.id);
      listFor(sys);
    }
    dirty.clear();
    let best = null;
    let bb = null;
    const gate = fillWindow || hasCapped || Object.keys(windowOpen).length || Object.keys(floors).length ? fillGate() : null;
    const lists = Object.fromEntries([1, 2, 3, 4].map((sys) => [sys, listFor(sys)]));
    const choiceOf = new Map();
    for (const sys of [1, 2, 3, 4]) for (const b of lists[sys]) choiceOf.set(b.id, gate ? gate(b, cache.get(b.id)) : cache.get(b.id));
    let horizon = Infinity;
    if (group) {
      for (const sys of [1, 2, 3, 4]) for (const b of lists[sys]) { const c = choiceOf.get(b.id); if (c && c.at < horizon) horizon = c.at; }
      horizon += GROUP_WINDOW;
    }
    for (const sys of [1, 2, 3, 4]) {
      const list = lists[sys];
      for (const b of list) {
        const c = choiceOf.get(b.id);
        if (!c) continue;
        if (group) {
          const urgent = isUrgent(b);
          if (c.at > horizon + EPS && !urgent) continue;
          const bestUrgent = bb && isUrgent(bb);
          if (!best || (urgent && !bestUrgent) || (urgent === bestUrgent && (cipHours(c) < cipHours(best) - EPS || (Math.abs(cipHours(c) - cipHours(best)) < EPS &&
            (c.at < best.at - EPS || (Math.abs(c.at - best.at) < EPS && orderIdx[b.id] < orderIdx[bb.id])))))) {
            best = c;
            bb = b;
          }
          continue;
        }
        if (!best || c.at < best.at - EPS || (Math.abs(c.at - best.at) < EPS && (better(c, best) ||
          (!better(best, c) && orderIdx[b.id] < orderIdx[bb.id])))) {
          best = c;
          bb = b;
        }
      }
    }
    return best ? { b: bb, choice: best } : null;
  };

  const fillKey = (lane) => ({
    fifo: (f) => [f.ready, -f.duration],
    setup: (f) => [lineChange(lane, f), f.ready],
    lpt: (f) => [-f.duration, f.ready],
    spt: (f) => [f.duration, f.ready],
    random: (f) => [fillPriority[f.id], 0],
  }[fillRule]);
  const nextFill = () => {
    if (!released.length) return null;
    // The line that can next take an eligible fill decides first.
    let lane = -1;
    let at = Infinity;
    for (let l = 0; l < fillers; l++) {
      let minReady = Infinity;
      for (const f of released) if (canRun(l, f) && f.ready < minReady) minReady = f.ready;
      if (minReady === Infinity) continue;
      let t = Math.max(fillerFree[l], minReady);
      if (downIv[l].length) t = findSlot([downIv[l]], t, 0.25).start;
      if (t < at - EPS) { at = t; lane = l; }
    }
    if (lane < 0) return null;
    const ruleKey = fillKey(lane);
    const base = group ? (f) => [lineChange(lane, f), ...ruleKey(f)] : ruleKey;
    // Fills about to run out of hold time jump the queue, most urgent first.
    const urgent = (f) => fillWindow && f.due - at - f.duration < URGENT_SLACK;
    const key = (f) => [prioFill.has(f.id) ? 0 : 1, f.chain ? 0 : 1, urgent(f) ? 0 : 1, urgent(f) ? f.due : 0, ...base(f)];
    let pick = -1;
    let kp = null;
    released.forEach((f, i) => {
      if (f.ready > at + EPS || !canRun(lane, f)) return;
      const k = key(f);
      let cmp = 0;
      for (let j = 0; j < k.length && !cmp; j++) if (Math.abs(k[j] - kp?.[j]) > EPS) cmp = k[j] < kp[j] ? -1 : 1;
      if (pick < 0 || cmp < 0 || (cmp === 0 && f.id < released[pick].id)) {
        pick = i;
        kp = k;
      }
    });
    return { lane, at, idx: pick };
  };

  const commitFill = ({ lane, idx, start: forced }) => {
    const f = released.splice(idx, 1)[0];
    const prev = fillerLast[lane];
    const line = lines[lane];
    const wash = lineChange(lane, f);
    const packChange = prev && line.packChange && prev.pack !== f.pack ? line.packChange : 0;
    let washRec = null;
    if (prev) {
      // A wash still to come cannot be back-dated before `now`.
      let free = forced != null ? fillerFree[lane] : Math.max(fillerFree[lane], floor);
      if (forced == null && wash > EPS && downIv[lane].length) free = findSlot([downIv[lane]], free, wash).start;
      washRec = {
        id: `FCIP-${fillerCips.length + 1}`, kind: 'fcip', lane, filler: line.id, rule: cipRule(prev, f),
        start: free, end: free + wash, duration: wash, packChange, fromPack: prev.pack, toPack: f.pack, fromFill: prev.id, toFill: f.id,
        fromSku: prev.sku, toSku: f.sku, fromCat: prev.category, toCat: f.category, wait: 0,
      };
      fillerCips.push(washRec);
    }
    let start = forced != null ? forced : Math.max(f.ready, floor, (washRec ? washRec.start : fillerFree[lane]) + wash);
    // Push past the weekly cap and any fill on a line this one cannot run alongside, until both hold.
    const blockers = conflictLanes[lane].length
      ? [conflictLanes[lane].flatMap((l) => fillIv[l]).sort((a, b) => a.start - b.start)]
      : null;
    for (let moved = forced == null; moved;) {
      moved = false;
      if (line.weeklyMax) {
        while ((weekCount[`${lane}:${Math.floor((start + EPS) / WEEK)}`] || 0) >= line.weeklyMax) {
          start = (Math.floor((start + EPS) / WEEK) + 1) * WEEK;
          moved = true;
        }
      }
      if (blockers) {
        const t = findSlot(blockers, start, f.duration).start;
        if (t > start + EPS) { start = t; moved = true; }
      }
      if (downIv[lane].length) {
        const t = findSlot([downIv[lane]], start, f.duration).start;
        if (t > start + EPS) { start = t; moved = true; }
      }
      // One PO at a time from a batch (H19): never alongside another fill of the same batch.
      const sibs = fills.filter((x) => x.batchId === f.batchId).sort((a, b) => a.start - b.start);
      if (sibs.length) {
        const t = findSlot([sibs], start, f.duration).start;
        if (t > start + EPS) { start = t; moved = true; }
      }
    }
    if (line.weeklyMax) {
      const wk = `${lane}:${Math.floor((start + EPS) / WEEK)}`;
      weekCount[wk] = (weekCount[wk] || 0) + 1;
    }
    const rec = {
      ...f, kind: 'fill', lane, filler: line.id, start, end: start + f.duration, wait: start - f.ready, cipId: washRec ? washRec.id : null, cipLock: wash,
      late: Math.max(0, start + f.duration - f.due),
    };
    fills.push(rec);
    insertSorted(fillIv[lane], rec);
    fillerFree[lane] = rec.end;
    fillerLast[lane] = rec;
    for (const r of released) if (r.batchId === f.batchId && r.ready < rec.end) r.ready = rec.end;
    const nxt = chainNext[f.id];
    if (nxt) {
      const parentEnd = batches.find((x) => x.id === nxt.batchId).end;
      released.push({ ...nxt, ready: openAt(nxt, Math.max(parentEnd - Math.min(TRIO_OVERLAP, nxt.duration), rec.end - TRIO_OVERLAP)), due: parentEnd + nxt.holdMax, chain: f.chain, chainPos: f.chainPos + 1 });
    }
    fillsLeft[f.batchId] -= 1;
    if (fillsLeft[f.batchId] === 0 && holdTank) {
      const done = Math.max(...fills.filter((x) => x.batchId === f.batchId).map((x) => x.end));
      // Only a tank still holding this product is freed (a locked re-plan can refill a tank early).
      for (const t of holders[f.batchId] || []) if (fillSourceOf(t.last) === f.batchId) releaseTank(t, Math.max(t.last.end, done));
    }
  };

  // Locked orders first, in the order they happened, so tanks, skids and lines carry their real state.
  if (frozen) {
    const byId = Object.fromEntries(plant.batches.map((b) => [b.id, b]));
    const tankById = Object.fromEntries(tanks.map((t) => [t.id, t]));
    const steps = [
      ...frozen.batches.map((x) => ({ kind: 'b', t: x.cip ? x.cip.start : x.start, x })),
      ...frozen.fills.map((x) => ({ kind: 'f', t: x.start, x })),
    ].sort((a, b) => a.t - b.t || (a.kind === 'b' ? -1 : 1));
    // A whole locked trio goes in at its last member's step, once every tank it uses carries its earlier batch.
    const lastStep = {};
    steps.forEach((st, i) => { if (st.kind === 'b' && groupOf[st.x.id]) lastStep[groupOf[st.x.id].id] = i; });
    for (const [i, st] of steps.entries()) {
      if (st.kind === 'b') {
        const b = byId[st.x.id];
        const g = groupOf[b.id];
        if (g) {
          if (lastStep[g.id] !== i) continue;
          const placed = g.members.map((m) => frozen.batches.find((x) => x.id === m.id));
          if (placed.some((x) => !x)) continue;
          commitGroup({ group: g, placements: placed.map((x) => ({ tank: tankById[x.tank], start: x.start, cip: x.cip, slip: x.slip })) });
        } else {
          commitBatch(b, { tank: tankById[st.x.tank], start: st.x.start, cip: st.x.cip, slip: st.x.slip, locked: true });
        }
      } else {
        const idx = released.findIndex((f) => f.id === st.x.id);
        // A fill that ran off its scheduled time keeps its real run time.
        if (idx >= 0 && st.x.duration != null) released[idx] = { ...released[idx], duration: st.x.duration, planDuration: released[idx].planDuration ?? released[idx].duration, run: st.x.run, pause: st.x.pause };
        if (idx >= 0) commitFill({ lane: st.x.lane, idx, start: st.x.start });
      }
    }
    released.forEach((f) => { f.ready = Math.max(f.ready, floor); });
  }

  // Event loop: always take whichever decision (start a batch, or load a filler) happens first.
  let guard = 100000;
  while ((batches.length < plant.batches.length || released.length) && guard--) {
    const nb = batches.length < plant.batches.length ? nextBatch() : null;
    const nf = nextFill();
    if (nb && (!nf || nb.choice.at <= nf.at + EPS)) {
      if (nb.choice.group) commitGroup(nb.choice);
      else commitBatch(nb.b, nb.choice);
    }
    else if (nf) commitFill(nf);
    else break;
  }

  return {
    params: { lines, fillers, cipMult, skids, extraTanks, rule, fillRule, batchPriority, fillPriority, holdTank, group, priorityFills, priorityTargets, trio, fillWindow, frozen, downtime },
    downtime,
    tanks: tanks.map((t) => ({ id: t.id, system: t.system })),
    batches, cips, fills, fillerCips,
    ...computeMetrics(batches, cips, fills, fillerCips, tanks.length, fillers, skids, downtime),
  };
}

function computeMetrics(batches, cips, fills, fillerCips, nTanks, fillers, skids, downtime = []) {
  const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
  const makespan = Math.max(0, ...batches.map((b) => b.end), ...fills.map((f) => f.end));
  const span = makespan || 1;
  const batchH = sum(batches, (b) => b.duration);
  // Filling hours leave out the time a fill sat stopped for a line downtime.
  const pauseH = (f) => sum(f.pause || [], (p) => p.end - p.start);
  const fillH = sum(fills, (f) => f.duration - pauseH(f));
  // Line downtime inside the plan, planned maintenance and unscheduled stops apart.
  const downIn = (d) => Math.max(0, Math.min(d.end, span) - Math.max(0, d.start));
  const downPlannedH = sum(downtime.filter((d) => d.kind === 'scheduled'), downIn);
  const downUnschedH = sum(downtime.filter((d) => d.kind !== 'scheduled'), downIn);
  const cipH = sum(cips, (c) => c.duration);
  const perSystem = SYSTEMS.map((s) => {
    const bs = batches.filter((b) => b.system === s.id);
    const cs = cips.filter((c) => c.system === s.id);
    const fs = fills.filter((f) => f.system === s.id);
    const nT = s.tanks.length + (nTanks - 18) / 4;
    const end = Math.max(0, ...bs.map((b) => b.end), ...fs.map((f) => f.end));
    return {
      id: s.id,
      tanks: nT,
      batches: bs.length,
      fills: fs.length,
      end,
      batchH: sum(bs, (b) => b.duration),
      cipH: sum(cs, (c) => c.duration),
      fillH: sum(fs, (f) => f.duration - pauseH(f)),
      tankUtil: sum(bs, (b) => b.duration) / (nT * span),
      holdH: sum(bs, (b) => b.holdEnd - b.end),
      tankLock: (sum(bs, (b) => b.holdEnd - b.start) + sum(cs, (c) => c.duration)) / (nT * span),
      skidUtil: sum(cs, (c) => c.duration) / (skids * span),
      fillerUtil: sum(fs, (f) => f.duration - pauseH(f)) / (fillers * span),
      tankWait: sum(bs, (b) => b.tankWait),
      skidWait: sum(bs, (b) => b.skidWait),
      cipLock: sum(bs, (b) => b.cipLock),
      fillWait: sum(fs, (f) => f.wait),
      cipCounts: { minor: cs.filter((c) => c.rule === 'minor').length, standard: cs.filter((c) => c.rule === 'standard').length, deep: cs.filter((c) => c.rule === 'deep').length },
    };
  });
  return {
    makespan,
    totals: {
      batchH, fillH, cipH,
      tankUtil: batchH / (nTanks * span),
      holdH: sum(batches, (b) => b.holdEnd - b.end),
      tankLock: (sum(batches, (b) => b.holdEnd - b.start) + cipH) / (nTanks * span),
      fillerUtil: fillH / (fillers * span),
      fillerCipH: sum(fillerCips, (c) => c.duration),
      fillerCipCount: fillerCips.length,
      fillerLock: (fillH + sum(fillerCips, (c) => c.duration)) / (fillers * span),
      skidWait: sum(cips, (c) => c.wait),
      fillWait: sum(fills, (f) => f.wait),
      deep: cips.filter((c) => c.rule === 'deep').length,
      cipCount: cips.length,
      lateFills: fills.filter((f) => f.late > EPS).length,
      lateH: sum(fills, (f) => f.late),
      downPlannedH, downUnschedH,
      downCount: downtime.filter((d) => d.start < span).length,
      downLater: downtime.filter((d) => d.start >= span - EPS).length,
      pausedFills: fills.filter((f) => pauseH(f) > EPS).length,
      pauseH: sum(fills, pauseH),
      availability: 1 - (downPlannedH + downUnschedH) / (fillers * span),
    },
    perSystem,
  };
}

// Walk back from the last finishing order through whatever bound each start time.
export function criticalPath(res) {
  const all = [...res.batches, ...res.fills];
  if (!all.length) return [];
  const batchById = Object.fromEntries(res.batches.map((b) => [b.id, b]));
  const cipById = Object.fromEntries(res.cips.map((c) => [c.id, c]));
  let cur = all.reduce((a, b) => (b.end > a.end ? b : a));
  const chain = [];
  let guard = 100000;
  while (cur && guard--) {
    let next = null;
    let bound = 'Plan start';
    if (cur.kind === 'fill') {
      const parent = batchById[cur.batchId];
      const fcip = cur.cipId && res.fillerCips.find((c) => c.id === cur.cipId);
      const chainPrev = cur.chainPos > 1 && res.fills.find((f) => f.chain === cur.chain && f.chainPos === cur.chainPos - 1);
      const trioLastB = parent.trio ? fillWaitsOn(res, cur) : null;
      const trioBatch = trioLastB && (Math.abs(trioLastB.end - Math.min(TRIO_FILL_LEAD, cur.duration) - cur.start) < EPS || Math.abs(trioLastB.end - cur.start) < EPS) ? trioLastB : null;
      if (trioBatch && cur.start >= parent.end - EPS) {
        next = trioBatch;
        bound = 'Waits on trio batches';
      } else if (cur.start <= parent.end + EPS) {
        next = parent;
        bound = 'Waits on parent batch';
      } else if (chainPrev && Math.abs(chainPrev.end - 1 - cur.start) < EPS) {
        next = chainPrev;
        bound = 'Trio fill chain';
      } else if (fcip && Math.abs(fcip.end - cur.start) < EPS) {
        next = fcip;
        bound = 'Waits on filler CIP';
      } else if (trioBatch) {
        next = trioBatch;
        bound = 'Waits on trio batches';
      } else {
        next = chainPrev || parent;
        bound = 'Waits on filler';
      }
    } else if (cur.kind === 'fcip') {
      next = res.fills.find((f) => f.id === cur.fromFill);
      bound = 'Waits on filler';
    } else if (cur.kind === 'batch' && cur.gateWait > EPS) {
      bound = 'Held back so its fills stay inside the tank hold limit';
    } else if (cur.kind === 'batch' && cur.trio) {
      // A trio member starts on the stagger; the binding constraint is whichever member's CIP ended latest.
      const members = res.batches.filter((b) => b.trio === cur.trio);
      let bind = null;
      let at = -Infinity;
      for (const m of members) {
        const c = m.cipId && cipById[m.cipId];
        const t = (c ? c.end : 0) - (m.trioPos - 1);
        if (t > at + EPS) { at = t; bind = c; }
      }
      const prevMember = members.find((m) => m.trioPos === cur.trioPos - 1);
      if (bind && cur.start > EPS && Math.abs(at + (cur.trioPos - 1) - cur.start) < EPS && bind.toBatch === cur.id) {
        next = bind;
        bound = 'Waits on tank CIP';
      } else if (prevMember) {
        next = prevMember;
        bound = 'Trio 1h stagger';
      } else if (bind && cur.start > EPS) {
        next = bind;
        bound = 'Waits on trio partner CIP';
      }
    } else if (cur.kind === 'batch') {
      if (cur.cipId) {
        next = cipById[cur.cipId];
        bound = 'Waits on tank CIP';
      }
    } else if (cur.kind === 'cip') {
      if (cur.wait < EPS) {
        const prev = batchById[cur.fromBatch];
        const lastFill = res.fills.find((f) => f.batchId === prev.id && Math.abs(f.end - cur.start) < EPS);
        next = lastFill && cur.start > prev.end + EPS ? lastFill : prev;
        bound = next === prev ? 'Waits on tank' : 'Waits on fills to empty tank';
      } else {
        next = res.cips.find((c) => c.system === cur.system && c.lane === cur.lane && Math.abs(c.end - cur.start) < EPS);
        bound = 'Waits on CIP skid';
        if (!next) next = batchById[cur.fromBatch];
      }
    }
    if (cur.kind === 'batch' && cur.slip > EPS && !next) bound = `Started ${fmtH(cur.slip)} late in production`;
    else if (!next && cur.start > EPS && res.params.frozen) bound = 'Locked: already under way in production';
    chain.push({ task: cur, bound });
    cur = next;
  }
  return chain.reverse();
}

// Same orders, many dispatch strategies: the deterministic rule pairs plus a batch of randomized
// priority orders. Returns the distinct schedules ranked by makespan (fastest first).
export function searchSchedules(plant, base, round, opts = {}) {
  return rankSchedules(searchCandidates(plant, base, round, opts).map((c) => ({ strategy: c, res: schedulePlant(plant, { ...base, ...c }) })), base);
}

// The dispatch strategies a search tries, in order.
export function searchCandidates(plant, base, round, { randomN = null, keep = null } = {}) {
  const candidates = keep ? [keep] : [];
  for (const rule of base.goal === 'fit' ? ['est', 'campaign', 'lpt', 'spt'] : ['est', 'campaign', 'lpt']) {
    for (const fillRule of ['fifo', 'setup', 'lpt', 'spt']) {
      candidates.push({ rule, fillRule });
      // Holding batches back for the fill window can backfire when lines are congested, so the
      // plain dispatch runs too and competes on late fills.
      if (base.fillWindow !== false) candidates.push({ rule, fillRule, fillWindow: false });
    }
  }
  const rng = mulberry32((plant.seed * 31 + round * 7919 + 17) >>> 0);
  const nRandom = randomN ?? randomCandidates(plant.batches.length);
  for (let i = 0; i < nRandom; i++) {
    const rule = rng() < 0.5 ? 'random' : ['est', 'campaign', 'lpt'][Math.floor(rng() * 3)];
    const fillRule = rng() < 0.6 ? 'random' : ['fifo', 'setup', 'lpt', 'spt'][Math.floor(rng() * 4)];
    candidates.push({
      rule,
      fillRule,
      batchPriority: rule === 'random' ? Object.fromEntries(plant.batches.map((b) => [b.id, rng()])) : null,
      fillPriority: fillRule === 'random' ? Object.fromEntries(plant.fills.map((f) => [f.id, rng()])) : null,
    });
  }
  return candidates;
}

// Best first: with the "most POs in the window" goal, most POs done on time inside the week limit;
// then fewest late fills, then makespan, fill wait and CIP hours; duplicates dropped.
export const scheduleScore = (res, base) => [
  base.goal === 'fit' && base.fitLimit ? -windowFit(res, base.fitLimit).count : 0,
  base.fillWindow === false ? 0 : res.totals.lateFills,
  res.makespan, res.totals.fillWait, res.totals.cipH + res.totals.fillerCipH,
];
export const compareScores = (a, b) => {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > EPS) return a[i] - b[i];
  return 0;
};
export function rankSchedules(results, base) {
  const seen = new Set();
  const score = new Map(results.map((r) => [r, scheduleScore(r.res, base)]));
  return [...results]
    .sort((a, b) => compareScores(score.get(a), score.get(b)))
    .filter(({ res }) => {
      const sig = [...res.batches.map((b) => `${b.id}${b.tank}${b.start}`), ...res.fills.map((f) => `${f.id}${f.lane}${f.start}`)].sort().join();
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    })
    .slice(0, OPTIONS_KEPT);
}

/* ---------- Fit to the window: how many POs are done in time, and why the rest spill over ---------- */

// A PO is done in the window when its batch (every batch, for a trio) and all its fills end by
// `limit` and no fill is past its hold limit. Counts batch POs, so a trio counts 3.
export function windowFit(res, limit) {
  const fillsOf = {};
  for (const f of res.fills) (fillsOf[f.batchId] = fillsOf[f.batchId] || []).push(f);
  const seen = new Set();
  const groups = [];
  for (const b of res.batches) {
    if (seen.has(b.id)) continue;
    const members = b.trio ? res.batches.filter((x) => x.trio === b.trio).sort((x, y) => x.trioPos - y.trioPos) : [b];
    members.forEach((m) => seen.add(m.id));
    const fills = members.flatMap((m) => fillsOf[m.id] || []);
    const end = Math.max(...members.map((m) => m.end), ...fills.map((f) => f.end));
    const late = fills.some((f) => f.late > EPS);
    groups.push({ members, fills, end, late, ok: end <= limit + EPS && !late });
  }
  const count = groups.filter((g) => g.ok).reduce((a, g) => a + g.members.length, 0);
  const spilled = groups.filter((g) => !g.ok).sort((a, b) => a.end - b.end);
  return { count, total: res.batches.length, groups, spilled };
}

// Why a group spilled over: the biggest wait it hit on the way.
export function spillReason(g, limit) {
  if (g.end <= limit + EPS && g.late) {
    const f = g.fills.reduce((a, x) => (x.late > a.late ? x : a));
    return { key: 'late', text: `${f.id} on ${f.filler} finishes ${fmtH(Math.round(f.late * 10) / 10)} past its hold limit${f.wait > 0.5 ? ` (waited ${fmtH(Math.round(f.wait * 10) / 10)} for the line)` : ''}` };
  }
  const waits = [];
  for (const m of g.members) {
    if (m.tankWait > EPS) waits.push({ key: 'tank', h: m.tankWait, text: `waited ${fmtH(m.tankWait)} for a free tank in System ${m.system}` });
    if (m.skidWait > EPS) waits.push({ key: 'skid', h: m.skidWait, text: `waited ${fmtH(m.skidWait)} for the System ${m.system} CIP skid` });
    if (m.gateWait > EPS) waits.push({ key: 'gate', h: m.gateWait, text: `held back ${fmtH(m.gateWait)} so its fill would not wait too long` });
  }
  for (const f of g.fills) {
    if (f.wait > EPS) waits.push({ key: 'line', h: f.wait, text: `${f.id} waited ${fmtH(f.wait)} for ${f.filler}` });
    const ph = (f.pause || []).reduce((a, q) => a + q.end - q.start, 0);
    if (ph > EPS) waits.push({ key: 'down', h: ph, text: `${f.id} stopped ${fmtH(ph)} while ${f.filler} was down` });
  }
  const top = waits.sort((a, b) => b.h - a.h)[0];
  return top && top.h >= 0.5 ? top : { key: 'queue', text: 'queued behind earlier orders' };
}

/* ---------- Planned maintenance placed in line gaps ---------- */

// Slides each planned stop to the quietest 2h on its line within the same production day
// (07:00 to 07:00), keeping clear of its twin's stops and the line's other stops. `res` is a plan
// made with the stops where they were; the stop moves to where that plan leaves the line idle.
export function placeMaintenance(res, maintenance, lines = FILL_LINES) {
  const lane = Object.fromEntries(res.params.lines.map((l, i) => [l.id, i]));
  const busyOn = (line) => [
    ...res.fills.filter((f) => f.filler === line),
    ...res.fillerCips.filter((c) => c.filler === line && c.duration > EPS),
  ];
  const twinOf = Object.fromEntries(lines.map((l) => [l.id, l.twin]));
  const placed = [];
  for (const m of [...maintenance].sort((a, b) => a.start - b.start)) {
    if (m.kind !== 'scheduled' || lane[m.line] == null) { placed.push(m); continue; }
    const len = m.end - m.start;
    const origin = m.origStart ?? m.start;
    const day = Math.floor((origin + EPS) / 24) * 24;
    const busy = busyOn(m.line);
    // Stops already placed that this one must not touch: the same line, or its twin.
    const others = [...placed, ...maintenance.filter((x) => !placed.includes(x) && x !== m)]
      .filter((x) => x.kind === 'scheduled' && (x.line === m.line || x.line === twinOf[m.line]));
    let best = null;
    for (let t = day; t <= day + 24 - len + EPS; t += 0.25) {
      if (others.some((x) => x.start < t + len - EPS && t < x.end - EPS)) continue;
      const overlap = busy.reduce((a, b) => a + Math.max(0, Math.min(b.end, t + len) - Math.max(b.start, t)), 0);
      const cost = [overlap, Math.abs(t - origin)];
      if (!best || cost[0] < best.cost[0] - EPS || (Math.abs(cost[0] - best.cost[0]) < EPS && cost[1] < best.cost[1] - EPS)) best = { t, cost };
    }
    const start = best ? best.t : m.start;
    placed.push({ ...m, start, end: start + len, origStart: origin });
  }
  return placed;
}

/* ---------- Improvement pass: keep reshuffling the best plan while it gets better ---------- */

// Starts from the best schedule's strategy and tries moving fills up the line queues (as if
// starred, but not shown as stars): fills of orders that spill over or run late first, then others
// that wait long. A change is kept when the plan scores no worse. Call step(budgetMs) until true.
export function improveJob(plant, base, start, maxTries = 400, seed = 1) {
  const rng = mulberry32((seed * 9301 + 49297) >>> 0);
  const startScore = scheduleScore(start.res, base);
  let cur = { ...start.strategy, boostFills: [...(start.strategy.boostFills || [])] };
  let curRes = start.res;
  let curScore = startScore;
  const job = { tries: 0, accepted: 0, maxTries, best: start, bestScore: startScore, startScore, done: false };
  const pickFrom = (arr) => arr[Math.floor(rng() * arr.length)];
  const mutate = () => {
    const boost = new Set(cur.boostFills);
    const r = rng();
    // Fills that would help most if they went sooner: late, spilling past the window, or waiting long.
    const lim = base.fitLimit || Infinity;
    const hot = curRes.fills.filter((f) => !boost.has(f.id) && (f.late > EPS || f.end > lim || f.wait > 2));
    const any = curRes.fills.filter((f) => !boost.has(f.id));
    if (r < 0.6 || !boost.size) {
      const f = hot.length && rng() < 0.85 ? pickFrom(hot) : any.length ? pickFrom(any) : null;
      if (f) boost.add(f.id);
    } else if (r < 0.85) {
      boost.delete(pickFrom([...boost]));
    } else {
      boost.delete(pickFrom([...boost]));
      const f = hot.length ? pickFrom(hot) : null;
      if (f) boost.add(f.id);
    }
    return { ...cur, boostFills: [...boost] };
  };
  job.step = (budgetMs) => {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    while (job.tries < job.maxTries) {
      const cand = mutate();
      const res = schedulePlant(plant, { ...base, ...cand });
      const sc = scheduleScore(res, base);
      job.tries += 1;
      if (compareScores(sc, curScore) <= 0) {
        cur = cand;
        curRes = res;
        curScore = sc;
        if (compareScores(sc, job.bestScore) < 0) { job.best = { strategy: cand, res, improved: true }; job.bestScore = sc; job.accepted += 1; }
      }
      if (now() - t0 >= budgetMs) break;
    }
    job.done = job.tries >= job.maxTries;
    return job.done;
  };
  return job;
}

/* ==========================================================================
   Production simulation: run the plan forward, slip a few POs, re-plan what has not started
   ========================================================================== */

export const SIM_SPEEDS = [5, 10, 20, 50, 100, 200]; // simulated minutes per real second
export const SIM_DELAY = [1, 4]; // a slipped PO starts this many hours late (half-hour steps)
export const LOOKAHEAD = 24; // hours ahead of "now" scanned for bottlenecks

// Which batch POs will start late once the run reaches them, and by how much. A trio slips as a unit.
export function drawDisruptions(plant, pct, seed) {
  const rng = mulberry32((seed * 2654435761 + 977) >>> 0);
  const out = {};
  const seenTrio = new Set();
  for (const b of plant.batches) {
    const hit = rng() * 100 < pct;
    const d = SIM_DELAY[0] + 0.5 * Math.floor(rng() * ((SIM_DELAY[1] - SIM_DELAY[0]) * 2 + 1));
    if (b.trioId) {
      if (seenTrio.has(b.trioId)) continue;
      seenTrio.add(b.trioId);
    }
    if (hit) out[b.id] = d;
  }
  return out;
}

// The batch whose end a fill waits on: its own, or for a trio's fill the trio's last batch.
export const fillWaitsOn = (res, f) => {
  const b = res.batches.find((x) => x.id === f.batchId);
  return b && b.trio ? res.batches.filter((x) => x.trio === b.trio).reduce((a, x) => (x.trioPos > a.trioPos ? x : a)) : b;
};
export const TRIO_FILL_LEAD = 2; // a trio's fill may start this long before its last batch ends
// The key a slip is filed under: the batch itself, or its trio's first batch.
export const slipKey = (res, b) => (b.trio ? res.batches.find((x) => x.trio === b.trio && x.trioPos === 1).id : b.id);

// Everything that has started by `now` (its CIP or the batch itself) is locked. `shift` slips the
// named batches by some hours as they are locked; the rest of a slipped trio follows on its stagger.
export function freezeAt(res, now, shift = {}, fillAt = {}, downtime = res.params.downtime || []) {
  const cipById = Object.fromEntries(res.cips.map((c) => [c.id, c]));
  const began = (b) => (b.cipId ? cipById[b.cipId].start : b.start) < now + EPS;
  // A slipped trio's first batch drags along the members whose CIP has already begun.
  const slipOf = (b) => shift[b.id] ?? (b.trio && b.start >= now - EPS ? shift[slipKey(res, b)] : undefined);
  // A batch that already slipped stays where it slipped to.
  const batches = res.batches.filter((b) => began(b) || shift[b.id] != null || b.slip > EPS).map((b) => {
    const c = b.cipId && cipById[b.cipId];
    return {
      id: b.id, tank: b.tank, start: b.start + (slipOf(b) || 0), slip: (b.slip || 0) + (slipOf(b) || 0),
      cip: c ? { rule: c.rule, hours: c.duration, start: c.start, end: c.end, lane: c.lane, wait: c.wait } : null,
    };
  });
  const lockedBatch = new Set(batches.map((b) => b.id));
  // `fillAt` gives a fill starting now its real start and run time.
  // A fill whose line wash has begun is locked too, so the wash is not restarted.
  const fcipById = Object.fromEntries(res.fillerCips.map((c) => [c.id, c]));
  const fillBegan = (f) => f.start < now + EPS || (f.cipId && fcipById[f.cipId].start < now - EPS && fcipById[f.cipId].duration > EPS);
  const lockedEnd = Object.fromEntries(batches.map((x) => {
    const b = res.batches.find((y) => y.id === x.id);
    return [x.id, x.start + b.duration];
  }));
  // ...unless its batch now finishes later than the fill was due to start.
  const stillFits = (f) => {
    if (f.start < now + EPS || fillAt[f.id]) return true;
    const w = fillWaitsOn(res, f);
    return lockedEnd[w.id] - (w.trio ? Math.min(TRIO_FILL_LEAD, f.duration) : 0) <= f.start + EPS && lockedEnd[f.batchId] <= f.start + EPS;
  };
  // A fill running long or late takes precedence over one that has only begun its wash on a line it cannot share.
  const lines = res.params.lines;
  const clash = (f) => res.fills.some((g) => {
    const a = fillAt[g.id];
    if (!a || g.id === f.id) return false;
    const lf = lines[f.lane];
    const lg = lines[g.lane];
    const shared = g.lane === f.lane || (lf.excludes || []).includes(lg.id) || (lg.excludes || []).includes(lf.id);
    return shared && f.start < a.start + a.duration - EPS && a.start < f.end - EPS;
  });
  // ...or one whose line has since gone down across its slot.
  const inDown = (f) => downtime.some((d) => d.line === f.filler && d.start < f.end - EPS && f.start < d.end - EPS);
  const fills = res.fills.filter((f) => (fillAt[f.id] || f.run || f.start < now - EPS || (fillBegan(f) && stillFits(f) && !clash(f) && !inDown(f))) && lockedBatch.has(f.batchId)).map((f) => ({
    id: f.id, lane: f.lane, start: fillAt[f.id] ? fillAt[f.id].start : f.start,
    duration: fillAt[f.id] ? fillAt[f.id].duration : f.planDuration != null ? f.duration : null,
    run: fillAt[f.id] ? fillAt[f.id].run : f.run,
    pause: fillAt[f.id] ? fillAt[f.id].pause : f.pause,
  }));
  const floors = { ...(res.params.frozen ? res.params.frozen.floors : {}) };
  return { now, batches, fills, floors };
}

// How far off its scheduled start and end each fill PO runs: a random share of its run time
// within `range` (percent), early or late at each end.
export function drawFillDeviation(plant, range, seed) {
  const rng = mulberry32((seed * 40503 + 7) >>> 0);
  const pct = () => (rng() < 0.5 ? -1 : 1) * (range[0] + rng() * (range[1] - range[0]));
  return Object.fromEntries(plant.fills.map((f) => [f.id, { s: pct(), e: pct() }]));
}

// How much earlier a fill could start without breaking a rule: its batch and hold window, the wash
// before it on its line, lines it cannot run alongside, and its line's week.
export function earlyRoom(res, f) {
  if (res.params.priorityTargets && res.params.priorityTargets[f.id] != null) return 0;
  let room = Math.max(0, f.wait);
  const cip = f.cipId && res.fillerCips.find((c) => c.id === f.cipId);
  if (cip) room = Math.min(room, f.start - cip.end);
  const lines = res.params.lines;
  const me = lines[f.lane];
  for (const g of res.fills) {
    if (g.id === f.id || g.end > f.start + EPS) continue;
    const other = lines[g.lane];
    if (g.lane === f.lane || g.batchId === f.batchId || (me.excludes || []).includes(other.id) || (other.excludes || []).includes(me.id)) room = Math.min(room, f.start - g.end);
  }
  if (me.weeklyMax) room = Math.min(room, f.start - Math.floor((f.start + EPS) / WEEK) * WEEK);
  for (const d of res.params.downtime || []) if (d.line === me.id && d.end <= f.start + EPS) room = Math.min(room, f.start - d.end);
  return Math.max(0, room);
}

// Where a fill really runs once it gets going, from its scheduled slot and its deviation.
// Lays `runH` hours of filling from `start` on a line, stopping for each downtime it meets.
export function withPauses(start, runH, downs) {
  const ds = [...downs].sort((a, b) => a.start - b.start);
  // The line is down when the fill is due: it starts once the line is back.
  let s0 = start;
  for (const d of ds) if (d.start <= s0 + EPS && d.end > s0 + EPS) s0 = d.end;
  let t = s0;
  let left = runH;
  const pause = [];
  for (const d of ds) {
    if (d.end <= t + EPS) continue;
    if (d.start >= t + left - EPS) break;
    left -= Math.max(0, d.start - t);
    pause.push({ start: Math.max(t, d.start), end: d.end });
    t = d.end;
  }
  return { start: s0, end: t + left, pause };
}

const downsOn = (res, line) => (res.params.downtime || []).filter((d) => d.line === line);

export function fillActual(res, f, dev, now) {
  const round = (h) => Math.round(h * 60) / 60;
  let ds = round(dev.s / 100 * f.duration);
  if (ds < 0) ds = -Math.min(-ds, Math.floor(earlyRoom(res, f) * 60 + EPS) / 60, Math.max(0, f.start - now));
  const start = f.start + ds;
  // A fill never finishes before its batch does (a trio's fill starts while the last batch runs).
  const batchEnd = fillWaitsOn(res, f).end;
  const end = Math.max(start + f.duration * 0.5, batchEnd, f.end + round(dev.e / 100 * f.duration));
  const runH = Math.round((end - start) * 600) / 600;
  // A late start or long run that reaches a downtime stops for it and finishes afterwards.
  const laid = withPauses(start, runH, downsOn(res, f.filler));
  const duration = laid.end - laid.start;
  return {
    start: laid.start, duration, pause: laid.pause.length ? laid.pause : undefined,
    run: { schedStart: f.start, schedEnd: f.end, sPct: ((laid.start - f.start) / f.duration) * 100, ePct: ((laid.start + duration - f.end) / f.duration) * 100, runH },
  };
}

// A line goes down at `d.start`: the fill running on it (if any) stops until the line is back.
export function breakdownHits(res, d) {
  const f = res.fills.find((x) => x.filler === d.line && x.start < d.start - EPS && x.end > d.start + EPS);
  if (!f) {
    // A fill already under way in the simulation (its start drawn) that was due to start during the stop waits for it to end.
    const g = res.fills.find((x) => x.filler === d.line && x.run && x.start >= d.start - EPS && x.start < d.end - EPS);
    if (!g) return null;
    const runH = g.run.runH != null ? g.run.runH : g.duration - (g.pause || []).reduce((a, p) => a + (p.end - p.start), 0);
    const laid = withPauses(d.end, runH, downsOn(res, g.filler));
    return { [g.id]: { start: laid.start, duration: laid.end - laid.start, pause: laid.pause, run: { ...g.run, runH, ePct: ((laid.end - g.run.schedEnd) / (g.planDuration || g.duration)) * 100 } } };
  }
  const paused = (f.pause || []).reduce((a, p) => a + Math.max(0, Math.min(p.end, d.start) - p.start), 0);
  const runH = f.run && f.run.runH != null ? f.run.runH : f.duration - (f.pause || []).reduce((a, p) => a + (p.end - p.start), 0);
  const done = d.start - f.start - paused;
  const before = (f.pause || []).filter((p) => p.end <= d.start + EPS);
  const laid = withPauses(d.end, Math.max(0, runH - done), downsOn(res, f.filler));
  const pause = [...before, { start: d.start, end: laid.start }, ...laid.pause];
  const duration = laid.end - f.start;
  const run = { ...(f.run || { schedStart: f.start, schedEnd: f.end, sPct: 0 }), runH, ePct: ((f.start + duration - (f.run ? f.run.schedEnd : f.end)) / (f.planDuration || f.duration)) * 100 };
  return { [f.id]: { start: f.start, duration, pause, run } };
}

// Re-plan from `now`: locked orders stay, the rest get the best fit. `wide` searches harder.
export function replanFrom(plant, res, now, shift, base, wide = false, fillAt = null) {
  const job = replanJob(plant, res, now, shift, base, wide, fillAt);
  while (!stepJob(plant, job, Infinity));
  return finishJob(job);
}

// A re-plan as a job that can run a few strategies at a time, so a big plant never freezes the page.
export function replanJob(plant, res, now, shift, base, wide = false, fillAt = null) {
  const frozen = freezeAt(res, now, shift, fillAt || {}, base.downtime || []);
  const keep = { rule: res.params.rule, fillRule: res.params.fillRule, batchPriority: res.params.batchPriority, fillPriority: res.params.fillPriority, fillWindow: res.params.fillWindow };
  const jobBase = { ...base, frozen };
  // A fill running off its time just pushes the plan on with the same strategy; a late batch re-plans.
  const cands = fillAt ? [keep] : searchCandidates(plant, jobBase, Math.round(now * 10), { randomN: wide ? 24 : 0, keep });
  return { base: jobBase, cands, results: [], single: !!fillAt };
}

// Runs strategies until `budgetMs` is spent; true once every strategy has run.
export function stepJob(plant, job, budgetMs) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  while (job.results.length < job.cands.length) {
    const c = job.cands[job.results.length];
    job.results.push({ strategy: c, res: schedulePlant(plant, { ...job.base, ...c }) });
    if (clock() >= budgetMs) break;
  }
  return job.results.length >= job.cands.length;
}

export const finishJob = (job) => (job.single ? job.results[0] : rankSchedules(job.results, job.base)[0]);

// Trouble in the next LOOKAHEAD hours: fill queues, late fills, long tank holds, CIP skid queues.
export function lookAhead(res, now, hours = LOOKAHEAD) {
  const end = now + hours;
  const inWin = (t) => t.start < end && t.end > now;
  const issues = [];
  const queued = res.fills.filter((f) => inWin(f) && f.start >= now - EPS && f.wait > 2 + EPS);
  const byLine = {};
  queued.forEach((f) => { (byLine[f.filler] = byLine[f.filler] || []).push(f); });
  Object.entries(byLine).forEach(([line, fs]) => issues.push({
    kind: 'queue', ids: fs.map((f) => f.id), at: Math.min(...fs.map((f) => f.start)),
    text: `${line}: ${fs.length} fill${fs.length > 1 ? 's' : ''} queue up to ${fmtH(Math.max(...fs.map((f) => f.wait)))} after the batch ends`,
  }));
  res.fills.filter((f) => inWin(f) && f.late > EPS).forEach((f) => issues.push({
    kind: 'late', ids: [f.id, f.batchId], at: f.start, text: `${f.id} on ${f.filler} finishes ${fmtH(f.late)} past its hold limit`,
  }));
  res.batches.filter((b) => b.holdEnd > now && b.end < end && b.holdEnd - b.end > 6 + EPS).forEach((b) => issues.push({
    kind: 'hold', ids: [b.id, ...b.fillIds], at: b.end, text: `${b.tank} sits full ${fmtH(b.holdEnd - b.end)} waiting on fills for ${b.id}`,
  }));
  res.cips.filter((c) => inWin(c) && c.start >= now - EPS && c.wait > 1 + EPS).forEach((c) => issues.push({
    kind: 'skid', ids: [c.id, c.toBatch], at: c.start, text: `System ${c.system} CIP skid queue ${fmtH(c.wait)} before ${c.toBatch}`,
  }));
  return issues.sort((a, b) => a.at - b.at);
}

// How many not-yet-started orders a re-plan moves (tank, line or start time).
export function movedCount(a, b, now) {
  const key = (t) => `${t.tank || t.filler}|${t.start}`;
  const am = Object.fromEntries([...a.batches, ...a.fills].map((t) => [t.id, key(t)]));
  return [...b.batches, ...b.fills].filter((t) => t.start >= now - EPS && am[t.id] !== key(t)).length;
}

// No schedule can beat this: fills cannot start before the shortest batch ends and each group of
// interchangeable lines must work through all of its fill hours; and each batch must be followed by its longest fill.
export function makespanLowerBound(plant, lines = FILL_LINES) {
  const minBatch = Math.min(...plant.batches.map((b) => b.duration));
  const chain = Math.max(...plant.batches.map((b) => b.duration + Math.max(...plant.fills.filter((f) => f.batchId === b.id).map((f) => f.duration))));
  let worst = 0;
  for (const pack of Object.keys(PACKS)) {
    const n = lines.filter((l) => l.packs.includes(pack)).length;
    const groupPacks = new Set(lines.filter((l) => l.packs.includes(pack)).flatMap((l) => l.packs));
    const hours = plant.fills.filter((f) => groupPacks.has(f.pack)).reduce((s, f) => s + f.duration, 0);
    if (n && hours) worst = Math.max(worst, hours / n);
  }
  return Math.max(chain, minBatch + Math.ceil(worst * 4) / 4);
}

export const strategyLabel = ({ rule, fillRule, boostFills }) => `${DISPATCH_RULES[rule]} · ${FILL_RULES[fillRule]}${boostFills && boostFills.length ? ` · improved (${boostFills.length} fill${boostFills.length > 1 ? 's' : ''} moved up the line queue)` : ''}`;

/* ==========================================================================
   Formatting helpers
   ========================================================================== */

const fmtH = (h) => `${Number.isInteger(h) ? h : Number(h.toFixed(h * 4 === Math.round(h * 4) ? 2 : 1))}h`;
const fmtClock = (planH) => {
  const h = planH + START_HOUR;
  const day = Math.floor(h / 24 + EPS);
  const rem = h - day * 24;
  const hh = Math.floor(rem + EPS);
  const mm = Math.round((rem - hh) * 60);
  const dayLabel = day < 7 ? DAYS[day] : `D${day + 1}`;
  return `${dayLabel} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
