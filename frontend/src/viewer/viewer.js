/* Plan viewer: the Gantt, KPIs, PO data grid and compare panel from tools/viewer/template.html, made into a
   component the React app mounts. createViewer(root, opts) -> {update(data), select(id), destroy()}.
   data = {plant, downtime, engines: {a: {label, schedule, metrics, valid}, b?: {...}}, seconds, timeLimit, marks}. */

const MARKUP = `
  <div class="vhead">
    <div class="seg" data-r="mode" role="group" aria-label="Plan shown"></div>
    <div class="meta" data-r="meta"></div>
  </div>
  <section class="kpis" data-r="kpis" aria-label="Plan scores"></section>
  <nav class="tabs" role="tablist" aria-label="View">
    <button role="tab" data-tab="gantt">Gantt</button><button role="tab" data-tab="data">PO data</button>
  </nav>
  <div data-r="ganttView" style="display:flex;flex-direction:column;gap:10px">
    <div class="bar">
      <button class="tb" data-r="crit" title="Outlines the chain of tasks that sets the plan's end time">Critical path</button>
      <button class="tb" data-r="tips" title="Shows a details card when you hover a block">Hover info</button>
      <div class="seg" data-r="links" role="group" aria-label="Batch-to-fill links"><button data-v="all">All links</button><button data-v="hover">Links on hover</button></div>
      <div class="seg" data-r="win" role="group" aria-label="Time window"><button data-v="window">Week limit (120h)</button><button data-v="plan">Plan only</button></div>
      <div class="seg" data-r="labels" role="group" aria-label="PO labels on the bars"><button data-v="off">Labels off</button><button data-v="po">PO</button><button data-v="sku">PO + SKU</button></div>
      <div class="seg" data-r="zoom" role="group" aria-label="Zoom"><button data-v="out" aria-label="Zoom out">−</button><button data-v="fit">Fit</button><button data-v="in" aria-label="Zoom in">+</button></div>
    </div>
    <div class="bar">
      <span class="lbl">Show</span>
      <span data-r="groups" style="display:contents"></span>
      <button class="tb" data-r="collapseAll"></button>
      <span class="lbl" style="margin-left:8px">Highlight</span>
      <span data-r="hls" style="display:contents"></span>
      <label class="tb" data-r="hlLinksL" title="Draws batch-to-fill links for the highlighted systems, in their colours"><input type="checkbox" data-r="hlLinks">Batch-to-fill links</label>
      <label class="tb" data-r="multiL" title="Shows only batches with more than one fill PO, with their fills and links"><input type="checkbox" data-r="multi"><span data-r="multiT">Batches with 2+ fills</span></label>
      <label class="tb" data-r="stripL" title="A strip under each tank shows its status over time, in the status colours"><input type="checkbox" data-r="strip">Tank status strip</label>
      <label class="tb" data-r="topL" title="Pins every tank's status at the hovered time to the top of the Gantt"><input type="checkbox" data-r="top">Tank status on top</label>
    </div>
    <div class="legend" data-r="legend"></div>
    <section class="diff" data-r="diff" hidden aria-label="Where the plans differ"></section>
    <div class="statusbar" data-r="statusbar" hidden></div>
    <div data-r="charts" style="display:flex;flex-direction:column;gap:18px"></div>
    <p class="hint">Hover any block to trace its batch, CIP and fill linkages. Click to select it (and steer it in the side panel), click empty space to clear. Click a system heading to collapse it.</p>
  </div>
  <div data-r="dataView" hidden>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="bar">
        <div class="seg" data-r="dview" role="tablist" aria-label="Table"></div>
        <input type="search" class="searchin" data-r="q" placeholder="Search PO, SKU, product, tank, line…" aria-label="Search">
        <span data-r="cats" style="display:inline-flex;gap:4px"></span>
        <select data-r="sysf" aria-label="System"><option value="all">All systems</option><option value="1">System 1</option><option value="2">System 2</option><option value="3">System 3</option><option value="4">System 4</option></select>
        <span class="hint num" data-r="rowcount"></span>
      </div>
      <p class="hint" data-r="dnote"></p>
      <div class="pogrid" data-r="grid"></div>
    </div>
  </div>
  <div class="tip" data-r="tip" hidden></div>`;

export function createViewer(root, opts = {}){
root.classList.add('lsv'); root.innerHTML = MARKUP;
let W = null;
const onSelect = opts.onSelect || (() => {});
const SYSTEMS = [1,2,3,4];
const SYS = {1:['T1A','T1B','T1C','T1D'],2:['T2A','T2B','T2C','T2D'],3:['T3A','T3B','T3C','T3D','T3E'],4:['T4A','T4B','T4C','T4D','T4E']};
const LINES = ['F1','F2','F3','F4','F5','F6','F7'];
const PACKS = {F1:'1000L',F2:'1000L/220L',F3:'220L/110L',F4:'20L',F5:'1L/3L/5L',F6:'1L/3L/5L',F7:'1L/3L/5L'};
const WEEK = 120, ROW = 20, HEAD = 20, STRIP = 7, AXIS = 28, TRIO_LEAD = 2, E = 1e-3;
const CIP_H = {minor:0.5, standard:1.5, deep:3};
const CIP_LABEL = {minor:'Minor flush', standard:'Standard CIP', deep:'Deep CIP'};
const STATUS = [[0,'Clean and available'],[10,'CIP in progress'],[20,'Setup'],[30,'Batch in progress'],[40,'Waiting for filling'],[50,'Filling in progress'],['D','Emptied, awaiting CIP']];
const stVar = c => `var(--st-${String(c).toLowerCase()})`;
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const store = { get(k,d){ try{ const v = localStorage.getItem('lsv2.'+k); return v===null?d:JSON.parse(v) }catch(e){ return d } },
                set(k,v){ try{ localStorage.setItem('lsv2.'+k, JSON.stringify(v)) }catch(e){} } };
const sel = s => s.replace(/#([A-Za-z]+)/g, '[data-r="$1"]');
const $ = s => root.querySelector(sel(s)), $$ = s => root.querySelectorAll(sel(s));
const L = e => W.engines[e].label;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clock = h => { const t = 7 + h, d = Math.floor(t/24), m = Math.round((t - d*24)*60);
  const hh = Math.floor(m/60), mm = m%60; return `${DAYS[((d%7)+7)%7]}${d>=7?' wk2':''} ${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}` };
const r2 = h => Math.round(h*100)/100;
const hrs = h => r2(h) + ' h';
const fh = h => r2(h) + 'h';
const catVar = c => ({A:'--cat-a',B:'--cat-b',C:'--cat-c'}[c] || '--cat-x');
const cipRule = (pSku,pCat,sku,cat) => pSku===sku ? 'minor' : (pCat!=='A' && cat==='A' ? 'deep' : 'standard');

const S = {
  mode: 'a', tab: store.get('tab','gantt'),
  zoom: store.get('zoom','fit'), linkMode: store.get('linkMode', null), tips: store.get('tips', true),
  crit: store.get('crit', false), labels: store.get('labels','po'), win: store.get('win','window'),
  hidden: new Set(store.get('hidden', [])), collapsed: new Set(store.get('collapsed', [])),
  hl: new Set(store.get('hl', [])), hlLinks: store.get('hlLinks', false), multi: store.get('multi', false),
  strip: store.get('strip', false), top: store.get('top', false),
  dview: store.get('dview','batches'), sort: {key:null, dir:1}, q: '', cats: store.get('cats', {A:true,B:true,C:true}), sysf: 'all',
  selected: null, hovered: null, t: 0,
};
const save = (...ks) => ks.forEach(k => store.set(k, S[k] instanceof Set ? [...S[k]] : S[k]));


/* ---------- plan model: links, hold limits, washes, tank status, critical path ---------- */
let cache = {};
function derive(eng){
  const key = eng; if (cache[key]) return cache[key];
  const w = W, P = w.plant, sch = w.engines[eng].schedule;
  const sb = Object.fromEntries(sch.batches.map(b=>[b.id,b])), sf = Object.fromEntries(sch.fills.map(f=>[f.id,f]));
  const pb = Object.fromEntries(P.batches.map(b=>[b.id,b])), pf = Object.fromEntries(P.fills.map(f=>[f.id,f]));
  const trios = {}; P.batches.forEach(b => { if (b.trioId) (trios[b.trioId] ||= []).push(b.id) });
  const group = id => pb[id].trioId ? trios[pb[id].trioId] : [id];
  const fillsOf = {}; P.fills.forEach(f => (fillsOf[group(f.batchId)[0]] ||= []).push(f.id));
  const info = {}, over = new Set(), release = {};
  P.batches.forEach(b => release[b.id] = sb[b.id].end);
  P.fills.forEach(f => {
    const ms = group(f.batchId), ends = ms.map(m=>sb[m].end), last = Math.max(...ends);
    const ready = ms.length>1 ? Math.max(ends[0], last - Math.min(TRIO_LEAD, f.duration)) : ends[0];
    const due = last + f.holdMax, t = sf[f.id];
    const by = ms.reduce((a,m) => sb[m].end > sb[a].end ? m : a, ms[0]);
    info[f.id] = {ready, due, wait: t.start - ready, by, late: Math.max(0, t.end - due)};
    if (t.end > due + E) over.add(f.id);
    ms.forEach(m => release[m] = Math.max(release[m], t.end));
  });
  // wash rule on each line, from the fill before it (H7)
  const byLine = {}; sch.fills.forEach(f => (byLine[f.line] ||= []).push(f));
  const washRule = {}, prevOnLine = {};
  Object.values(byLine).forEach(arr => { arr.sort((a,b)=>a.start-b.start); arr.forEach((f,i) => {
    const p = arr[i-1]; prevOnLine[f.id] = p ? p.id : null;
    if (f.washStart==null) return;
    const a = pf[f.id], r = p ? cipRule(pf[p.id].sku, pf[p.id].category, a.sku, a.category) : 'standard';
    washRule[f.id] = (f.washEnd - f.washStart) > CIP_H[r] + E ? r + '+pack' : r;
  }) });
  const byTank = {}; sch.batches.forEach(b => (byTank[b.tank] ||= []).push(b));
  Object.values(byTank).forEach(a => a.sort((x,y)=>x.start-y.start));
  const trioPos = {}; Object.values(trios).forEach(ms => ms.forEach((m,i) => trioPos[m] = i+1));
  const end = Math.max(...sch.batches.map(b=>release[b.id]), ...sch.fills.map(f=>f.end));
  // tank status timeline (v49 V11 codes)
  const status = {};
  Object.entries(SYS).forEach(([s,tanks]) => tanks.forEach(tk => {
    const segs = [], push = (code,a,z) => { const st = Math.max(a, segs.length?segs[segs.length-1].end:0); if (z <= st + E) return;
      const l = segs[segs.length-1]; if (l && l.code===code && Math.abs(l.end-st)<E) l.end = z; else segs.push({code, start:st, end:z}) };
    let clk = 0, after = 0;
    for (const b of (byTank[tk]||[])){
      const cs = b.cipStart!=null && b.cipEnd>b.cipStart ? b.cipStart : b.start;
      push(after, clk, cs);
      if (b.cipStart!=null && b.cipEnd>b.cipStart) push(10, b.cipStart, b.cipEnd);
      push(0, b.cipEnd ?? clk, b.start);
      const su = b.start + (b.end-b.start)*0.05; push(20, b.start, su); push(30, su, b.end);
      const fs = (fillsOf[group(b.id)[0]]||[]).map(id=>sf[id]).sort((x,y)=>x.start-y.start);
      let tt = b.end;
      for (const f of fs){ const s0 = Math.max(f.start, b.end), z = Math.min(f.end, release[b.id]); if (z <= s0+E) continue; push(40, tt, s0); push(50, s0, z); tt = Math.max(tt, z) }
      push(40, tt, release[b.id]);
      clk = release[b.id]; after = 'D';
    }
    push(after, clk, Math.max(end, WEEK) + 48);
    status[tk] = segs;
  }));
  const d = {w, eng, P, sch, sb, sf, pb, pf, group, fillsOf, info, over, release, washRule, prevOnLine, byLine, byTank, trioPos, end, status};
  d.crit = critical(d);
  return cache[key] = d;
}

// Critical path: walk back from the last task to finish, following whatever held each task back.
function critical(d){
  const {sch, sb, sf, pb, info, group, byLine, byTank, release, trioPos, w} = d;
  const all = [...sch.batches.map(b=>({k:'b', t:b, end: b.end})), ...sch.fills.map(f=>({k:'f', t:f, end: f.end}))];
  let cur = all.reduce((a,b) => b.end > a.end ? b : a);
  const chain = [], seen = new Set();
  const f7Week = h => Math.floor(h/168), f7Count = {}; (byLine.F7||[]).forEach(f => f7Count[f7Week(f.start)] = (f7Count[f7Week(f.start)]||0) + 1);
  const f7Blocked = f => f.line==='F7' && f7Week(f.start) > 0 && (f7Count[f7Week(f.start)-1]||0) >= 3;
  const F7MSG = 'F7 cap: the 3 fills allowed in the week before are used (H10)';
  const stopAt = (line, t) => w.downtime.find(z => z.line===line && Math.abs(z.end - t) < E);
  while (cur && !seen.has(cur.t.id) && chain.length < 400){
    seen.add(cur.t.id);
    const step = {id: cur.t.id, k: cur.k, start: cur.t.start, end: cur.t.end, where: cur.k==='b' ? cur.t.tank : cur.t.line, bound: ''};
    chain.push(step);
    let next = null;
    if (cur.k === 'f'){
      const f = cur.t, i = info[f.id], arr = byLine[f.line], pos = arr.indexOf(f), prev = arr[pos-1];
      const gate = f.washStart!=null ? f.washStart : f.start;
      const sib = (d.fillsOf[group(d.pf[f.id].batchId)[0]]||[]).map(id=>sf[id]).find(x => x.id!==f.id && Math.abs(x.end - f.start) < E);
      if (sib && group(d.pf[f.id].batchId).length > 1){ next = {k:'f', t: sib}; step.bound = 'Trio fills run one at a time (H8)' }
      else if (Math.abs(f.start - i.ready) < E){ next = {k:'b', t: sb[i.by]}; step.bound = group(d.pf[f.id].batchId).length>1 ? 'Waits on trio batches (H8)' : 'Waits on parent batch (H3)' }
      else if (prev && Math.abs(prev.end - gate) < E){ next = {k:'f', t: prev}; step.bound = f.washStart!=null ? `Waits on ${f.line}, then ${(d.washRule[f.id]||'').replace('+pack',' + pack change')} wash` : `Waits on ${f.line}` }
      else if (stopAt(f.line, gate) || stopAt(f.line, f.start)){ step.bound = `Waits on planned stop on ${f.line} (H14)`; next = prev ? {k:'f', t: prev} : null }
      else if (f7Blocked(f)) step.bound = F7MSG;
      else { step.bound = 'Placed later by the solver (no single blocker)'; next = prev && prev.end > i.ready ? {k:'f', t: prev} : {k:'b', t: sb[i.by]} }
    } else {
      const b = cur.t, arr = byTank[b.tank], pos = arr.indexOf(b), prev = arr[pos-1], tp = trioPos[b.id];
      const pm = tp > 1 ? group(b.id)[tp-2] : null;
      if (pm && Math.abs(sb[pm].start + 1 - b.start) < E){ next = {k:'b', t: sb[pm]}; step.bound = 'Trio 1h stagger (H8)' }
      else if (prev && b.cipStart!=null && Math.abs(b.cipEnd - b.start) < E){
        if (Math.abs(release[prev.id] - b.cipStart) < E){
          const lastFill = (d.fillsOf[group(prev.id)[0]]||[]).map(id=>sf[id]).reduce((a,f)=>!a||f.end>a.end?f:a, null);
          next = lastFill && lastFill.end > prev.end + E ? {k:'f', t: lastFill} : {k:'b', t: prev};
          step.bound = `Waits on ${b.tank} CIP after its last fill (H4)`;
        } else {
          const sys = pb[b.id].system, other = d.sch.batches.find(x => pb[x.id].system===sys && x.cipEnd!=null && Math.abs(x.cipEnd - b.cipStart) < E);
          step.bound = `Waits on System ${sys} CIP skid`; next = other ? {k:'b', t: other} : {k:'b', t: prev};
        }
      }
      else if (b.start < E) step.bound = 'Plan start';
      else if ((d.fillsOf[group(b.id)[0]]||[]).some(id => f7Blocked(sf[id]))) step.bound = 'Held back so its F7 fill, pushed to next week by the F7 cap (H10), stays inside the hold limit (P3)';
      else step.bound = 'Placed later by the solver (no single blocker)';
    }
    cur = next;
  }
  return chain;
}

function related(d, id){
  if (!id) return null;
  const set = new Set([id]);
  const bid = d.pb[id] ? id : d.pf[id] ? d.pf[id].batchId : null;
  if (!bid) return set;
  const g = d.group(bid); g.forEach(m => set.add(m));
  (d.fillsOf[g[0]]||[]).forEach(f => set.add(f));
  return set;
}

/* ---------- Gantt ---------- */
function rows(){
  const r = []; let y = AXIS;
  const add = x => { x.y = y; r.push(x); y += x.h };
  for (const s of SYSTEMS){
    if (S.hidden.has(String(s))) continue;
    const c = S.collapsed.has(String(s));
    add({head:true, g:String(s), label:`System ${s}`, h:HEAD, c});
    if (c) add({sum:true, g:String(s), keys:SYS[s], label:'All tanks', h:ROW});
    else SYS[s].forEach(t => { add({tank:t, label:t, h:ROW}); if (S.strip) add({strip:t, h:STRIP}) });
  }
  if (!S.hidden.has('plant')){
    const c = S.collapsed.has('plant');
    add({head:true, g:'plant', label:'Fill lines', h:HEAD, c});
    if (c) add({sum:true, g:'plant', keys:LINES, label:'All lines', h:ROW});
    else LINES.forEach(l => add({line:l, label:l, h:ROW}));
  }
  const pos = {}; r.forEach(x => { if (x.tank) pos[x.tank]=x; if (x.line) pos[x.line]=x; if (x.sum) x.keys.forEach(k => pos[k]=x) });
  return {r, H: y + 6, pos};
}

function spanFor(engs){
  const end = Math.max(...engs.map(e => derive(e).end));
  return S.win === 'plan' ? Math.ceil((end + 1)/6)*6 : Math.ceil((Math.max(WEEK, end) + 4)/12)*12;
}
function pxFor(span){
  if (S.zoom === 'fit'){ const W = ($('#charts').clientWidth || 1000) - 100; return Math.max(1.5, W/span) }
  return S.zoom;
}

function gantt(d, idx, span, px){
  const {w, sch, pb, pf} = d;
  const {r, H, pos} = rows();
  const W = Math.ceil(span*px) + 8, X = h => 4 + h*px;
  const cy = k => pos[k].y + pos[k].h/2;
  const hlOn = S.hl.size > 0;
  const multiSet = new Set(); w.plant.batches.forEach(b => { if (b.fillIds.length > 1){ multiSet.add(b.id); b.fillIds.forEach(x=>multiSet.add(x)) } });
  const critSet = S.crit ? new Set(d.crit.map(c=>c.id)) : null;
  const fade = (id, sys) => { let o = 1;
    if (hlOn && !S.hl.has(sys)) o = .25;
    if (S.multi && !multiSet.has(id)) o = .25;
    if (critSet && !critSet.has(id)) o = Math.min(o, .45);
    return o };
  const colour = (cat, sys) => hlOn && S.hl.has(sys) ? `var(--sys-${sys})` : `var(${catVar(cat)})`;
  // PO data overlay on the bars: off, PO number, or PO number + SKU, cut to fit the bar
  const label = (id, p, room) => { if (S.labels === 'off') return '';
    const n = id.replace(/^[BF]PO-/,''), full = `${n} ${p.sku}`, fit = Math.floor(room / 6.1);
    return S.labels === 'sku' && full.length <= fit ? esc(full) : n.length <= fit ? n : '' };
  const o = [];
  o.push(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-svg="${idx}" role="img" aria-label="${d.eng} Gantt" class="${S.linkMode==='hover'?'hoveronly':''}">`);
  const hatch = (id, bg, fg) => `<pattern id="${id}${idx}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${bg}"/><line x1="0" y1="0" x2="0" y2="6" stroke="${fg}" stroke-width="2"/></pattern>`;
  o.push(`<defs>${hatch('pd','var(--down-soft)','var(--down)')}${hatch('pm','var(--panel)','var(--cip-minor)')}${hatch('ps','var(--panel)','var(--cip-std)')}${hatch('pp','var(--panel)','var(--cip-deep)')}
    <marker id="ar${idx}" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0L6,3L0,6z" fill="var(--muted)"/></marker>
    <marker id="aa${idx}" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0L6,3L0,6z" fill="var(--accent)"/></marker></defs>`);
  o.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="transparent" data-bg="1"/>`);
  r.forEach(x => { if (x.head) o.push(`<rect x="0" y="${x.y}" width="${W}" height="${x.h}" fill="var(--row)"/>`) });
  if (WEEK < span) o.push(`<rect x="${X(WEEK)}" y="${AXIS}" width="${W-X(WEEK)}" height="${H-AXIS}" fill="var(--grid)" opacity=".45"/>`);
  const step = px < 6 ? 12 : 6;
  for (let h=0; h<=span; h+=step){
    const day = h%24===0;
    o.push(`<line x1="${X(h)}" y1="${day?4:AXIS-6}" x2="${X(h)}" y2="${H}" stroke="var(--grid)" stroke-width="${day?1.2:1}"/>`);
    if (day && h % (24*Math.max(1, Math.ceil(130/(24*px)))) === 0) o.push(`<text x="${X(h)+4}" y="15" font-size="11" fill="var(--muted)">${clock(h)} · ${h}h</text>`);
  }
  // planned stops (H14)
  w.downtime.forEach(dt => { const y = pos[dt.line]; if (!y) return;
    o.push(`<rect data-k="d:${esc(dt.id)}" x="${X(dt.start)}" y="${y.y}" width="${(dt.end-dt.start)*px}" height="${y.h}" fill="url(#pd${idx})" opacity=".8"/>`) });
  // tank status strips
  r.forEach(x => { if (!x.strip) return; d.status[x.strip].forEach(g => { if (g.start >= span) return;
    o.push(`<rect x="${X(g.start)}" y="${x.y+1}" width="${Math.max(.5,(Math.min(g.end,span)-g.start)*px)}" height="${x.h-2}" fill="${stVar(g.code)}"/>`) }) });
  const cipFill = rule => `url(#${({minor:'pm',standard:'ps',deep:'pp'}[rule]||'ps')}${idx})`;
  // tanks: held, CIP, batch
  sch.batches.forEach(b => { const y = pos[b.tank]; if (!y) return; const p = pb[b.id], rel = d.release[b.id], op = fade(b.id, p.system);
    if (rel > b.end + E) o.push(`<rect data-id="${b.id}" data-k="h:${b.id}" x="${X(b.end)}" y="${y.y+4}" width="${(rel-b.end)*px}" height="${y.h-8}" fill="${colour(p.category,p.system)}" fill-opacity=".16" stroke="${colour(p.category,p.system)}" stroke-opacity=".7" stroke-dasharray="3 2" rx="2" opacity="${op}"/>`);
    if (b.cipStart!=null && b.cipEnd > b.cipStart) o.push(`<rect data-id="${b.id}" data-k="c:${b.id}" x="${X(b.cipStart)}" y="${y.y+3}" width="${Math.max(1,(b.cipEnd-b.cipStart)*px)}" height="${y.h-6}" fill="${cipFill(b.cipRule)}" stroke="var(--line)" rx="2" opacity="${op}"/>`);
    const bw = (b.end-b.start)*px, crit = critSet && critSet.has(b.id);
    o.push(`<rect data-id="${b.id}" data-k="b:${b.id}" x="${X(b.start)}" y="${y.y+2}" width="${Math.max(1,bw-0.5)}" height="${y.h-4}" fill="${colour(p.category,p.system)}" rx="2" opacity="${op}" ${crit?'stroke="var(--crit)" stroke-width="2.5"':''}/>`);
    if (p.trioId) o.push(`<rect x="${X(b.start)}" y="${y.y+2}" width="3" height="${y.h-4}" fill="var(--fg)" opacity="${.5*op}" pointer-events="none"/>`);
    const lb = label(b.id, p, bw - (p.trioId?8:6)); if (lb && !y.sum) o.push(`<text x="${X(b.start)+(p.trioId?6:4)}" y="${y.y+14}" font-size="10" fill="var(--bar-fg)" pointer-events="none" opacity="${op}">${lb}</text>`);
  });
  // fill lines: wash, fill
  sch.fills.forEach(f => { const y = pos[f.line]; if (!y) return; const p = pf[f.id], op = fade(f.id, p.system);
    if (f.washStart!=null && f.washEnd>f.washStart) o.push(`<rect data-id="${f.id}" data-k="w:${f.id}" x="${X(f.washStart)}" y="${y.y+3}" width="${Math.max(1,(f.washEnd-f.washStart)*px)}" height="${y.h-6}" fill="${cipFill((d.washRule[f.id]||'').split('+')[0])}" stroke="var(--line)" rx="2" opacity="${op}"/>`);
    const fw = (f.end-f.start)*px, late = d.over.has(f.id), crit = critSet && critSet.has(f.id);
    o.push(`<rect data-id="${f.id}" data-k="f:${f.id}" x="${X(f.start)}" y="${y.y+2}" width="${Math.max(1,fw-0.5)}" height="${y.h-4}" fill="${colour(p.category,p.system)}" rx="2" opacity="${op}" ${crit?'stroke="var(--crit)" stroke-width="2.5"':late?'stroke="var(--down)" stroke-width="2.5"':''}/>`);
    const lf = label(f.id, p, fw - 6); if (lf && !y.sum) o.push(`<text x="${X(f.start)+4}" y="${y.y+14}" font-size="10" fill="var(--bar-fg)" pointer-events="none" opacity="${op}">${lf}</text>`);
  });
  // batch-to-fill links (H2): one from each tank the fill empties
  sch.fills.forEach(f => { const yl = pos[f.line]; if (!yl) return; const p = pf[f.id];
    d.group(p.batchId).forEach(m => { const b = d.sb[m], yt = pos[b.tank]; if (!yt) return;
      const x1 = X(b.end), y1 = cy(b.tank), x2 = X(f.start), y2 = cy(f.line), dx = Math.max(18, Math.abs(x2-x1)*.5);
      const cls = S.multi && multiSet.has(m) ? ' multi' : (S.hlLinks && S.hl.has(p.system) ? ' sys' : '');
      o.push(`<path class="lk${cls}" data-f="${f.id}" data-b="${m}" d="M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2-1},${y2}" ${cls===' sys'?`style="stroke:var(--sys-${p.system})"`:''} marker-end="url(#ar${idx})"/>`);
    }) });
  // planner steering marks: pinned POs (M11) and urgent fills (P1), and the re-plan time (M1)
  const mk = w.marks || {};
  [...sch.batches.map(t=>[t, pos[t.tank]]), ...sch.fills.map(t=>[t, pos[t.line]])].forEach(([t, y]) => { if (!y || y.sum) return;
    if (mk.pinned && mk.pinned.has(t.id)) o.push(`<g pointer-events="none"><circle cx="${X(t.start)+1}" cy="${y.y+3}" r="4" fill="var(--fg)" stroke="var(--panel)" stroke-width="1.5"/></g>`);
    if (mk.starred && mk.starred.has(t.id)) o.push(`<text x="${X(t.end)-1}" y="${y.y+9}" font-size="12" text-anchor="end" fill="var(--st-10)" stroke="var(--panel)" stroke-width=".6" pointer-events="none">★</text>`);
  });
  if (w.replanFrom != null && w.replanFrom <= span){
    o.push(`<rect x="0" y="${AXIS}" width="${X(w.replanFrom)}" height="${H-AXIS}" fill="var(--fg)" opacity=".05" pointer-events="none"/>`);
    o.push(`<line x1="${X(w.replanFrom)}" y1="4" x2="${X(w.replanFrom)}" y2="${H}" stroke="var(--accent)" stroke-width="1.5"/>`);
    o.push(`<text x="${X(w.replanFrom)+4}" y="${AXIS-4}" font-size="10" fill="var(--accent)">RE-PLAN ${fh(w.replanFrom)}</text>`);
  }
  if (WEEK <= span){
    o.push(`<line x1="${X(WEEK)}" y1="4" x2="${X(WEEK)}" y2="${H}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="5 3"/>`);
    o.push(`<text x="${X(WEEK)-4}" y="${AXIS-4}" font-size="10" fill="var(--bad)" text-anchor="end">LIMIT ${WEEK}h</text>`);
  }
  o.push(`<line data-cursor="1" x1="-10" x2="-10" y1="${AXIS}" y2="${H}" stroke="var(--fg)" stroke-width="1" opacity=".35" pointer-events="none" ${S.top?'':'visibility="hidden"'}/>`);
  o.push('</svg>');
  const labels = `<div style="height:${AXIS}px"></div>` + r.map(x => x.head
    ? `<div class="head" data-col="${x.g}" style="height:${x.h}px" title="${x.c?'Expand':'Collapse'} ${x.label}">${x.c?'▸':'▾'} ${x.label}</div>`
    : x.strip ? `<div style="height:${x.h}px"></div>`
    : `<div class="${x.sum?'':'lane'}" style="height:${x.h}px" ${x.line?`title="${x.line} · ${PACKS[x.line]}"`:''}>${x.label}</div>`).join('');
  const m = w.engines[d.eng].metrics, title = esc(L(d.eng));
  const crit = S.crit ? `<div class="critlist"><b>Critical path</b> <span class="hint">latest task first, ${d.crit.length} steps; click one to pin it</span><ol>${d.crit.map(c =>
    `<li data-pin="${c.id}"><span class="num">${c.id}</span> on ${c.where}, <span class="num">${clock(c.start)}–${clock(c.end)}</span> <span>· ${c.bound}</span></li>`).join('')}</ol></div>` : '';
  return `<section class="chart" data-eng="${d.eng}"><h2>${title} <small class="num">${m.pos_in_week_limit}/${m.batch_pos} POs in week limit · ${m.fills_over_hold_limit} over hold limit · ends ${clock(m.makespan)} (${hrs(m.makespan)})</small></h2>
    <div class="gantt"><div class="labels">${labels}</div><div class="scroll" data-px="${px}">${o.join('')}</div></div>${crit}</section>`;
}

function engines(){ return S.mode==='both' ? ['a','b'] : [S.mode] }

function renderGantt(){
  const engs = engines(), span = spanFor(engs), px = pxFor(span);
  const keepScroll = [...$$('#charts .scroll')].map(s => s.scrollLeft);
  $('#charts').innerHTML = engs.map((e,i) => gantt(derive(e), i, span, px)).join('');
  $$('#charts .scroll').forEach((s,i) => { if (keepScroll[i]!=null) s.scrollLeft = keepScroll[i] });
  applyFocus(); renderStatus();
}

function applyFocus(){
  const id = S.hovered || S.selected;
  $$('#charts .chart').forEach(ch => {
    const d = derive(ch.dataset.eng), rel = related(d, id), svg = ch.querySelector('svg'), idx = svg.dataset.svg;
    svg.classList.toggle('focus', !!rel);
    svg.querySelectorAll('[data-id]').forEach(el => { const on = !!rel && rel.has(el.dataset.id); el.classList.toggle('on', on); el.classList.toggle('pin', el.dataset.id===S.selected && el.dataset.k && 'bf'.includes(el.dataset.k[0])) });
    svg.querySelectorAll('.lk').forEach(el => { const on = !!rel && rel.has(el.dataset.f) && rel.has(el.dataset.b);
      if (on !== el.classList.contains('on')){ el.classList.toggle('on', on); el.setAttribute('marker-end', `url(#${on?'aa':'ar'}${idx})`) } });
  });
}

/* ---------- tank status on top ---------- */
function renderStatus(){
  const bar = $('#statusbar'); bar.hidden = !S.top || S.tab!=='gantt';
  $$('[data-cursor]').forEach(l => l.setAttribute('visibility', S.top ? 'visible' : 'hidden'));
  if (bar.hidden) return;
  const eng = engines()[0], d = derive(eng), t = S.t;
  const at = segs => (segs.find(g => g.start <= t + E && t < g.end - E) || segs[segs.length-1]).code;
  bar.innerHTML = `<span class="lbl">Tank status</span><span class="num">${clock(t)} · ${fh(t)}${S.mode==='both'?' · '+esc(L('a')):''}</span>` +
    SYSTEMS.map(s => `<span class="grp"><span class="lbl">S${s}</span>${SYS[s].map(tk => { const c = at(d.status[tk]);
      const b = d.sch.batches.find(x => x.tank===tk && x.start <= t + E && t < d.release[x.id] - E);
      return `<span class="chipst" style="background:${stVar(c)}" title="${tk}: ${STATUS.find(z=>z[0]===c)[1]}${b?` · ${b.id} ${d.pb[b.id].sku}`:''}"><small>${tk}</small><b>${c}</b></span>` }).join('')}</span>`).join('') +
    `<button class="x" id="topx" aria-label="Hide tank status bar">×</button>`;
}

/* ---------- toolbar ---------- */
function renderToolbar(){
  const w = W;
  if (S.linkMode === null) S.linkMode = w.plant.fills.length > 80 ? 'hover' : 'all';
  const pressed = (sel, v) => $$(sel+' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v===v));
  pressed('#links', S.linkMode); pressed('#labels', S.labels); pressed('#win', S.win); pressed('#zoom', S.zoom==='fit'?'fit':'');
  $('#crit').setAttribute('aria-pressed', S.crit); $('#tips').setAttribute('aria-pressed', S.tips);
  $('#tips').textContent = S.tips ? 'Hover info on' : 'Hover info off';
  $('#groups').innerHTML = [...SYSTEMS.map(s=>[String(s),`System ${s}`]), ['plant','Fill lines']].map(([g,l]) =>
    `<span class="split ${S.hidden.has(g)?'':'on'}"><button data-show="${g}" aria-pressed="${!S.hidden.has(g)}">${l}</button><button data-col="${g}" aria-label="${S.collapsed.has(g)?'Expand':'Collapse'} ${l}">${S.collapsed.has(g)?'▸':'▾'}</button></span>`).join('');
  $('#collapseAll').textContent = S.collapsed.size ? 'Expand all' : 'Collapse all';
  $('#hls').innerHTML = SYSTEMS.map(s => `<label class="tb ${S.hl.has(s)?'on':''}"><input type="checkbox" data-hl="${s}" ${S.hl.has(s)?'checked':''}><i class="dot" style="background:var(--sys-${s})"></i>S${s}</label>`).join('');
  $('#hlLinks').checked = S.hlLinks; $('#hlLinks').disabled = !S.hl.size;
  $('#hlLinksL').className = 'tb ' + (S.hlLinks && S.hl.size ? 'on' : S.hl.size ? '' : 'off');
  const nMulti = w.plant.batches.filter(b => b.fillIds.length > 1).length;
  $('#multi').checked = S.multi; $('#multiT').textContent = `Batches with 2+ fills (${nMulti})`; $('#multiL').className = 'tb ' + (S.multi?'on':'');
  $('#strip').checked = S.strip; $('#stripL').className = 'tb ' + (S.strip?'on':'');
  $('#top').checked = S.top; $('#topL').className = 'tb ' + (S.top?'on':'');
  const hatch = c => `background:repeating-linear-gradient(45deg,${c} 0 2px,var(--panel) 2px 5px);outline:1px solid var(--line);outline-offset:-1px`;
  $('#legend').innerHTML = [
    `<i class="sw" style="background:linear-gradient(90deg,var(--cat-a) 33%,var(--cat-b) 33% 66%,var(--cat-c) 66%)"></i>Batch / fill PO (category A · B · C)`,
    `<i class="sw" style="${hatch('var(--cip-minor)')}"></i>Minor flush`, `<i class="sw" style="${hatch('var(--cip-std)')}"></i>Standard CIP`, `<i class="sw" style="${hatch('var(--cip-deep)')}"></i>Deep CIP`,
    `<i class="sw" style="background:var(--accent-soft);outline:1px dashed var(--muted);outline-offset:-1px"></i>Tank holding for fills (H4)`,
    `<i class="sw" style="${hatch('var(--down)')}"></i>Planned maintenance (H14)`,
    `<i class="sw" style="outline:2px solid var(--down);outline-offset:-2px"></i>Fill over hold limit (P3)`,
    S.crit ? `<i class="sw" style="outline:2px solid var(--crit);outline-offset:-2px"></i>Critical path` : '',
    `<svg width="22" height="10" aria-hidden="true"><path d="M1 9 C11 9 11 1 21 1" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>Batch to fill link (H2)`,
    `<i class="sw" style="border-left:2px dashed var(--bad);border-radius:0"></i>Week limit ${WEEK}h (P0)`,
    ...(S.strip || S.top ? STATUS.map(([c,l]) => `<i class="dot" style="background:${stVar(c)}"></i>${c} ${l}`) : []),
  ].filter(Boolean).map(x => `<span>${x}</span>`).join('');
}

/* ---------- KPIs ---------- */
const KPI = [
  ['pos_in_week_limit','POs in week limit','P0', +1, (v,m)=>`${v}<span class="old">/${m.batch_pos}</span>`],
  ['fills_over_hold_limit','Fills over hold limit','P3', -1, v=>v],
  ['makespan','Plan ends','P4', -1, v=>hrs(v)],
  ['fill_wait_h','Fill wait','P6', -1, v=>hrs(v)],
  ['cip_h','CIP and wash','P6', -1, v=>hrs(v)],
];
function kpis(){
  const w = W, one = !w.engines.b, a = w.engines.a.metrics, b = (w.engines.b || w.engines.a).metrics, lb = one ? '' : esc(L('b'));
  $('#kpis').innerHTML = KPI.map(([k,label,rule,dir,fmt]) => {
    const diff = a[k]-b[k], cls = Math.abs(diff)<1e-9 ? 'same' : (diff*dir>0 ? 'good':'bad');
    const dtxt = one ? '' : Math.abs(diff)<1e-9 ? `same as ${lb}` : `${diff>0?'+':'−'}${r2(Math.abs(diff))}${k==='pos_in_week_limit'||k==='fills_over_hold_limit'?'':' h'} vs ${lb}`;
    return `<div class="kpi"><div class="lbl">${label}<span class="rule">${rule}</span></div>
      <div class="vals"><span class="big num">${fmt(a[k],a)}</span>${one?'':`<span class="old num">${lb} ${String(fmt(b[k],b)).replace(/<[^>]+>/g,'')}</span>`}</div>
      <div class="d num ${cls}">${dtxt}</div></div>`}).join('');
  const pill = (e,lab) => `<span class="pill"><i style="background:var(${w.engines[e].valid?'--good':'--bad'})"></i>${lab}: ${w.engines[e].valid?'all hard rules pass':'rule breaks found'}</span>`;
  const trios = new Set(w.plant.batches.filter(b=>b.trioId).map(b=>b.trioId)).size;
  $('#meta').innerHTML = `${pill('a',esc(L('a')))}${one?'':pill('b',esc(L('b')))}<span class="num">${w.plant.batches.length} batches · ${w.plant.fills.length} fills · ${trios} System 1 trios</span>${w.note?`<span class="num">${esc(w.note)}</span>`:''}`;
}

/* ---------- PO data grid ---------- */
const catBadge = c => `<span class="cat" style="background:var(${catVar(c)})">${c}</span>`;
const dash = '<span class="dash">—</span>';
function dataViews(d){
  const P = d.P, stats = {}; P.batches.forEach(b => { const s = stats[b.sku] ||= {n:0,h:0}; s.n++; s.h += b.duration });
  return {
    batches: { label:`Batch POs (${P.batches.length})`, rows: P.batches.map(b => { const t = d.sb[b.id];
        return {...b, tank:t.tank, start:t.start, end:t.end, free:d.release[b.id], cip:t.cipStart!=null?t.cipEnd-t.cipStart:0, cipRule:t.cipRule, trio:b.trioId?`${b.trioId} #${d.trioPos[b.id]}`:'', fills:(d.fillsOf[d.group(b.id)[0]]||[]).join(', '), _s:[b.id,b.sku,b.productName,t.tank,b.trioId||'']} }),
      cols: [['id','Batch PO','m'],['sku','SKU','m'],['productName','Product'],['category','Cat','',r=>catBadge(r.category)],['system','Sys','r'],['tank','Tank','m'],['trio','Trio (H8)','m',r=>r.trio||dash],
        ['volumeL','Volume L','r',r=>r.volumeL.toLocaleString()],['duration','Dur','r',r=>fh(r.duration)],['start','Start','r',r=>`<span title="${clock(r.start)}">${fh(r.start)}</span>`],['end','End','r',r=>`<span title="${clock(r.end)}">${fh(r.end)}</span>`],
        ['free','Tank free (H4)','r',r=>`<span title="${clock(r.free)}">${fh(r.free)}</span>`],['cip','Pre-CIP','',r=>r.cip?`${CIP_LABEL[r.cipRule]||r.cipRule} ${fh(r.cip)}`:'<span class="dash">Clean tank</span>'],['fills','Fill POs','m',r=>r.fills||dash]] },
    fills: { label:`Fill POs (${P.fills.length})`, rows: P.fills.map(f => { const t = d.sf[f.id], i = d.info[f.id];
        return {...f, rate:f.volumeL/f.duration, line:t.line, start:t.start, end:t.end, ready:i.ready, due:i.due, late:i.late, wait:i.wait, wash:t.washStart!=null?t.washEnd-t.washStart:0, washRule:d.washRule[f.id]||'', _s:[f.id,f.batchId,f.sku,f.productName,f.format,t.line]} }),
      cols: [['id','Fill PO','m'],['batchId','Parent','m'],['sku','SKU','m'],['productName','Product'],['category','Cat','',r=>catBadge(r.category)],['system','Sys','r'],['line','Line','m'],['format','Format'],
        ['volumeL','Litres','r',r=>r.volumeL.toLocaleString()],['units','Units','r',r=>r.units.toLocaleString()],['duration','Dur','r',r=>fh(r.duration)],['rate','L/h (S14)','r',r=>Math.round(r.volumeL/r.duration).toLocaleString()],
        ['ready','Ready','r',r=>`<span title="${clock(r.ready)}">${fh(r.ready)}</span>`],['start','Start','r',r=>`<span title="${clock(r.start)}">${fh(r.start)}</span>`],['end','End','r',r=>`<span title="${clock(r.end)}">${fh(r.end)}</span>`],
        ['due','Fill by (P3)','r',r=>`<span title="hold limit ${r.holdMax}h">${fh(r.due)}</span>`],['late','Late','r',r=>r.late>E?`<span class="late">${fh(r.late)}</span>`:dash],['wait','Wait','r',r=>r.wait>E?fh(r.wait):'0h'],
        ['wash','Wash before','',r=>r.wash?`${(CIP_LABEL[r.washRule.split('+')[0]]||'Wash')}${r.washRule.includes('+')?' + pack change':''} ${fh(r.wash)}`:dash]] },
    products: { label:`Product SKUs (${P.products.length})`, rows: P.products.map(p => ({...p, id:p.sku, n:(stats[p.sku]||{n:0}).n, h:(stats[p.sku]||{h:0}).h, _s:[p.sku,p.name,p.allergen||'']})),
      cols: [['sku','SKU','m'],['name','Product'],['category','Cat','',r=>catBadge(r.category)],['allergen','Allergen','',r=>r.allergen?esc(r.allergen):'<span class="dash">None</span>'],
        ['affinity','Systems','',r=>r.affinity.map(a=>'S'+a).join(', ')],['holdMax','Hold limit','r',r=>fh(r.holdMax)],['n','Batches','r'],['h','Batch hrs','r',r=>fh(r.h)]] },
  };
}
function renderData(){
  const eng = S.mode==='b' ? 'b' : 'a', d = derive(eng), views = dataViews(d);
  if (!views[S.dview]) S.dview = 'batches';
  $('#dview').innerHTML = Object.entries(views).map(([k,v]) => `<button role="tab" data-v="${k}" aria-pressed="${k===S.dview}" aria-selected="${k===S.dview}">${v.label}</button>`).join('');
  $('#cats').innerHTML = ['A','B','C'].map(c => `<button class="chip" data-cat="${c}" aria-pressed="${!!S.cats[c]}" style="color:var(${catVar(c)})">Cat ${c}</button>`).join('');
  const v = views[S.dview], q = S.q.trim().toLowerCase();
  let rows = v.rows.filter(r => S.cats[r.category] && (S.sysf==='all' || (r.system ? r.system===+S.sysf : r.affinity.includes(+S.sysf))) && (!q || r._s.some(s => String(s).toLowerCase().includes(q))));
  if (S.sort.key){ const k = S.sort.key; rows = [...rows].sort((a,b) => { const x = a[k], y = b[k]; return (typeof x==='number' && typeof y==='number' ? x-y : String(x??'').localeCompare(String(y??''))) * S.sort.dir }) }
  else rows.sort((a,b) => String(a.id).localeCompare(String(b.id)));
  $('#rowcount').textContent = `${rows.length} rows`;
  $('#dnote').textContent = S.dview==='products' ? 'Products in this week. Hold limit is how long a filled tank may wait before its fills must finish.' :
    `Times are hours from Mon 07:00 in the plan “${esc(L(eng))}” (hover a time for the clock). Click a row to open it on the Gantt.`;
  const click = S.dview!=='products';
  $('#grid').innerHTML = `<table><thead><tr>${v.cols.map(([k,l,c]) => `<th class="${c==='r'?'r':''}" ${S.sort.key===k?`aria-sort="${S.sort.dir>0?'ascending':'descending'}"`:''}><button data-sort="${k}">${l}${S.sort.key===k?(S.sort.dir>0?' ▲':' ▼'):''}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr ${click?`class="click" data-open="${r.id}"`:''}>${v.cols.map(([k,,c,fmt]) => `<td class="${c||''}">${fmt?fmt(r):esc(r[k]??'')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${v.cols.length}" class="dash" style="text-align:center;padding:24px">No rows match these filters.</td></tr>`}</tbody></table>`;
}

/* ---------- tooltip ---------- */
function tipHtml(eng, key){
  const mk = W.marks || {}, id0 = key.slice(2);
  const extra = (mk.pinned && mk.pinned.has(id0) ? '<br><b>Pinned</b> <span class="r">M11</span>' : '') + (mk.starred && mk.starred.has(id0) ? '<br><b>★ Urgent fill</b> <span class="r">P1</span>' : '') + (mk.targets && mk.targets[id0] != null ? `<br>Target start ${clock(mk.targets[id0])} <span class="r">P2</span>` : '');
  return tipBody(eng, key) + extra;
}
function tipBody(eng, key){
  const d = derive(eng), w = d.w, t = key[0], id = key.slice(2);
  if (t==='d'){ const x = w.downtime.find(z=>z.id===id); return `<b>${esc(x.reason)}</b> · ${x.line}<br>${clock(x.start)} to ${clock(x.end)}<br><span class="r">H14 no filling or washing</span>` }
  if ('bhc'.includes(t)){ const b = d.sb[id], p = d.pb[id], fills = d.fillsOf[d.group(id)[0]]||[];
    const head = `<b>${id}</b> · ${esc(p.productName)} <span class="r">(${p.sku}, cat ${p.category})</span><br>Tank ${b.tank}, System ${p.system}${p.trioId?` · trio ${p.trioId}, batch ${d.trioPos[id]} of 3`:''}<br>`;
    if (t==='b') return head + `Makes ${clock(b.start)} to ${clock(b.end)} (${hrs(b.end-b.start)})<br>${p.volumeL.toLocaleString()} L · linked fills: ${fills.join(', ')}`;
    if (t==='h') return head + `Held full from ${clock(b.end)} to ${clock(d.release[id])}<br>Linked fills: ${fills.join(', ')}<br><span class="r">H4 tank held until its fills are done</span>`;
    return head + `${CIP_LABEL[b.cipRule]||'CIP'} ${clock(b.cipStart)} to ${clock(b.cipEnd)} (${hrs(b.cipEnd-b.cipStart)})<br><span class="r">H5 changeover matrix</span>`; }
  const f = d.sf[id], p = d.pf[id], i = d.info[id];
  if (t==='w'){ const r = d.washRule[id]||'', prev = d.prevOnLine[id];
    return `<b>${CIP_LABEL[r.split('+')[0]]||'Wash'}${r.includes('+')?' + pack change':''}</b> on ${f.line}<br>${prev?`After ${prev}, before ${id}`:`Before ${id}`}<br>${clock(f.washStart)} to ${clock(f.washEnd)} (${hrs(f.washEnd-f.washStart)})<br><span class="r">H7 line changeover</span>` }
  const g = d.group(p.batchId);
  return `<b>${id}</b> · ${esc(p.productName)} <span class="r">(${p.sku}, cat ${p.category})</span><br>${f.line} · ${esc(p.format)} · ${p.units} units<br>Fills ${clock(f.start)} to ${clock(f.end)} (${hrs(f.end-f.start)})<br>Linked to ${g.length>1?`trio ${g.join(', ')} (tanks ${g.map(m=>d.sb[m].tank).join(', ')})`:`${p.batchId} in ${d.sb[p.batchId].tank}`}<br>Ready ${clock(i.ready)} · waited ${hrs(i.wait)}<br>Hold limit ${p.holdMax} h, due by ${clock(i.due)}${d.over.has(id)?' <b style="color:var(--down)">· over by '+hrs(i.late)+' (P3)</b>':''}`;
}
const tip = $('#tip');
function placeTip(ev){
  const r = tip.getBoundingClientRect(); let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = Math.max(8, ev.clientX - r.width - 14);
  if (y + r.height > innerHeight - 8) y = Math.max(8, ev.clientY - r.height - 14);
  tip.style.left = x+'px'; tip.style.top = y+'px';
}
let raf = 0;
$('#charts').addEventListener('pointermove', ev => {
  const el = ev.target.closest && ev.target.closest('[data-k]'), ch = ev.target.closest('[data-eng]');
  const id = el && el.dataset.id || null;
  if (id !== S.hovered){ S.hovered = id; applyFocus() }
  if (el && S.tips && ch){ tip.innerHTML = tipHtml(ch.dataset.eng, el.dataset.k); tip.hidden = false; placeTip(ev) } else tip.hidden = true;
  if (S.top && ch){ const svg = ch.querySelector('svg'), px = +ch.querySelector('.scroll').dataset.px, rc = svg.getBoundingClientRect();
    const t = Math.max(0, (ev.clientX - rc.left - 4)/px);
    $$('[data-cursor]').forEach(l => { l.setAttribute('x1', 4+t*px); l.setAttribute('x2', 4+t*px) });
    S.t = Math.round(t*4)/4; cancelAnimationFrame(raf); raf = requestAnimationFrame(renderStatus) }
});
$('#charts').addEventListener('pointerleave', () => { tip.hidden = true; if (S.hovered){ S.hovered = null; applyFocus() } });
$('#charts').addEventListener('click', ev => {
  const col = ev.target.closest('[data-col]'); if (col){ toggleSet('collapsed', col.dataset.col); return }
  const pin = ev.target.closest('[data-pin]'); if (pin){ setSel(pin.dataset.pin); applyFocus(); scrollToTask(pin.dataset.pin); return }
  const el = ev.target.closest('[data-k]'), id = el && el.dataset.id;
  setSel(id && S.selected !== id ? id : null); applyFocus();
  if (el && S.tips){ const ch = ev.target.closest('[data-eng]'); tip.innerHTML = tipHtml(ch.dataset.eng, el.dataset.k); tip.hidden = false; placeTip(ev) }
});
const onScroll = () => tip.hidden = true; addEventListener('scroll', onScroll, {passive:true});

function scrollToTask(id){
  const el = $(`#charts [data-id="${CSS.escape(id)}"][data-k^="b"], #charts [data-id="${CSS.escape(id)}"][data-k^="f"]`);
  if (!el) return;
  const sc = el.closest('.scroll'), x = +el.getAttribute('x');
  sc.scrollLeft = Math.max(0, x - sc.clientWidth/3);
  const r = el.getBoundingClientRect(); if (r.top < 80 || r.bottom > innerHeight - 20) scrollBy({top: r.top - innerHeight/3, behavior:'smooth'});
}


/* ---------- compare: top 3 differences and the better plan ---------- */
function fitInfo(d){
  const ids = new Set(), seen = new Set();
  d.P.batches.forEach(b => { const g = d.group(b.id); if (seen.has(g[0])) return; g.forEach(m=>seen.add(m));
    const fs = d.fillsOf[g[0]]||[], end = Math.max(...g.map(m=>d.sb[m].end), ...fs.map(f=>d.sf[f].end));
    if (end <= WEEK + E && !fs.some(f => d.over.has(f))) g.forEach(m => ids.add(m)) });
  return ids;
}
const sumBy = (items, key, val) => items.reduce((o,x) => (o[key(x)] = (o[key(x)]||0) + val(x), o), {});
function biggest(a, b){ // key with the largest gap between two {key: hours} maps
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]); let best = null;
  ks.forEach(k => { const g = (b[k]||0) - (a[k]||0); if (!best || Math.abs(g) > Math.abs(best.g)) best = {k, g, a: a[k]||0, b: b[k]||0} });
  return best;
}
function renderDiff(){
  const el = $('#diff'); el.hidden = S.mode !== 'both'; if (el.hidden) return;
  const a = derive('a'), b = derive('b'), w = a.w, ma = w.engines.a.metrics, mb = w.engines.b.metrics, A = esc(L('a')), B = esc(L('b'));
  const chips = ids => ids.length ? `<div class="pos">${ids.slice(0,10).map(id => `<button data-pin="${id}">${id}</button>`).join('')}${ids.length>10?`<span class="hint">+${ids.length-10} more</span>`:''}</div>` : '';
  const items = [];
  // P0: POs inside the week limit
  const fa = fitInfo(a), fb = fitInfo(b), onlyA = [...fa].filter(x=>!fb.has(x)), onlyB = [...fb].filter(x=>!fa.has(x));
  if (ma.pos_in_week_limit !== mb.pos_in_week_limit || onlyA.length || onlyB.length){
    const bySys = ids => Object.entries(sumBy(ids, id=>a.pb[id].system, ()=>1)).sort((x,y)=>y[1]-x[1]).map(([s,n])=>`System ${s} (${n})`).join(', ');
    const d = ma.pos_in_week_limit - mb.pos_in_week_limit;
    items.push({rule:'P0', title:'POs finished inside the 120h week limit', win: d>0?'a':d<0?'b':null,
      n:`${ma.pos_in_week_limit} vs ${mb.pos_in_week_limit}`,
      text: `${onlyA.length ? `${A} gets ${onlyA.length} POs done in the week that ${B} does not, mostly ${bySys(onlyA)}.` : ''} ${onlyB.length ? `${B} gets ${onlyB.length} in that ${A} does not${onlyA.length?'':`, mostly ${bySys(onlyB)}`}.` : ''}`.trim(),
      ids: (d >= 0 ? onlyA : onlyB)});
  }
  // P3: fills over their hold limit
  if (ma.fills_over_hold_limit !== mb.fills_over_hold_limit){
    const la = [...a.over], lb = [...b.over], d = ma.fills_over_hold_limit - mb.fills_over_hold_limit;
    const worse = d < 0 ? b : a, worseIds = d < 0 ? lb : la;
    const lines = Object.entries(sumBy(worseIds, id=>worse.sf[id].line, ()=>1)).sort((x,y)=>y[1]-x[1]).slice(0,3).map(([l,n])=>`${l} (${n})`).join(', ');
    const lateH = ids => r2(ids.reduce((s,id) => s + (d<0?b:a).info[id].late, 0));
    items.push({rule:'P3', title:'Fills that finish past their hold limit', win: d<0?'a':'b',
      n:`${ma.fills_over_hold_limit} vs ${mb.fills_over_hold_limit}`,
      text:`${d<0?B:A} lets ${worseIds.length} fills run over the tank hold limit, by ${lateH(worseIds)}h in total, mostly on ${lines}. The tank sits full too long before it is emptied.`,
      ids: worseIds});
  }
  // P4: plan end
  if (Math.abs(ma.makespan - mb.makespan) > E){
    const d = ma.makespan - mb.makespan, last = dd => { const x = [...dd.sch.batches, ...dd.sch.fills].reduce((p,q)=>q.end>p.end?q:p); return x };
    const xa = last(a), xb = last(b);
    items.push({rule:'P4', title:'When the whole plan finishes', win: d<0?'a':'b', n:`${hrs(ma.makespan)} vs ${hrs(mb.makespan)}`,
      text:`${A} ends ${clock(ma.makespan)} with ${xa.id}${xa.line?` on ${xa.line}`:''}; ${B} ends ${clock(mb.makespan)} with ${xb.id}${xb.line?` on ${xb.line}`:''}. ${Math.abs(d)<1?'Under an hour apart.':`${hrs(Math.abs(d))} ${d<0?'earlier':'later'} with ${A}.`}`,
      ids:[xa.id, xb.id].filter((x,i,arr)=>arr.indexOf(x)===i)});
  }
  // P6: fill wait, by line
  if (Math.abs(ma.fill_wait_h - mb.fill_wait_h) > 0.5){
    const wl = dd => sumBy(dd.sch.fills, f=>f.line, f=>dd.info[f.id].wait), g = biggest(wl(a), wl(b)), d = ma.fill_wait_h - mb.fill_wait_h;
    const ids = (d<0 ? b : a).sch.fills.filter(f => f.line===g.k).sort((x,y)=>(d<0?b:a).info[y.id].wait-(d<0?b:a).info[x.id].wait).slice(0,6).map(f=>f.id);
    items.push({rule:'P6', title:'Time full tanks wait for a fill line', win: d<0?'a':'b', n:`${hrs(ma.fill_wait_h)} vs ${hrs(mb.fill_wait_h)}`,
      text:`The biggest gap is on ${g.k}: ${hrs(g.a)} of waiting with ${A} against ${hrs(g.b)} with ${B}. Less waiting means tanks are freed sooner for the next batch.`, ids});
  }
  // P6: CIP and wash hours
  if (Math.abs(ma.cip_h - mb.cip_h) > 0.5){
    const tk = dd => sumBy(dd.sch.batches.filter(x=>x.cipStart!=null), x=>`System ${dd.pb[x.id].system} tanks`, x=>x.cipEnd-x.cipStart);
    const ln = dd => sumBy(dd.sch.fills.filter(x=>x.washStart!=null), x=>x.line, x=>x.washEnd-x.washStart);
    const g = biggest({...tk(a), ...ln(a)}, {...tk(b), ...ln(b)}), d = ma.cip_h - mb.cip_h;
    const deep = dd => dd.sch.batches.filter(x=>x.cipRule==='deep').length + Object.values(dd.washRule).filter(r=>r.startsWith('deep')).length;
    items.push({rule:'P6', title:'Hours spent on CIP and line washes', win: d<0?'a':'b', n:`${hrs(ma.cip_h)} vs ${hrs(mb.cip_h)}`,
      text:`Most of the gap is on ${g.k} (${hrs(g.a)} vs ${hrs(g.b)}). Deep CIPs: ${deep(a)} with ${A}, ${deep(b)} with ${B}; better product order means fewer of them.`, ids: []});
  }
  const top = items.slice(0,3);
  // Verdict: the first priority level that differs decides (P2, P0, P3, P4, P6 wait, P6 CIP)
  const levels = [['target_miss_h','P2','target misses',-1],['pos_in_week_limit','P0','POs in the week limit',1],['fills_over_hold_limit','P3','fills over the hold limit',-1],
    ['makespan','P4','plan end',-1],['fill_wait_h','P6','fill wait',-1],['cip_h','P6','CIP hours',-1]];
  const dec = levels.find(([k]) => Math.abs((ma[k]||0) - (mb[k]||0)) > 1e-3);
  let verdict;
  if (!dec) verdict = 'The two plans score the same on every priority. Neither is better.';
  else { const [k,rule,label,dir] = dec, win = ((ma[k]||0) - (mb[k]||0))*dir > 0 ? A : B;
    const earlier = levels.slice(0, levels.indexOf(dec)).filter(l => l[0]!=='target_miss_h').map(l=>l[1]).filter((x,i,arr)=>arr.indexOf(x)===i);
    const loser = win===A ? 'b' : 'a', behind = items.filter(i => i.win===loser).map(i => `${i.title.toLowerCase()} (${i.rule})`);
    verdict = `<b>Best: ${win}.</b> It wins on ${label} (${rule})${earlier.length?`, after tying on ${earlier.join(', ')}`:''}, and that is the highest priority where the plans differ.${behind.length?` ${loser==='b'?B:A} is ahead on ${behind.join(' and ')}, which ranks lower.`:''}${!w.engines.a.valid||!w.engines.b.valid?' Note: one plan breaks a hard rule.':''}`; }
  el.innerHTML = `<h2>Where the plans differ <small class="hint">top ${top.length} of ${items.length}, in priority order; click a PO to find it on the charts</small></h2>
    <div class="verdict">${verdict}</div>
    <ol>${top.map((it,i) => `<li><div class="k"><span class="lbl">${i+1}. ${it.title} <span class="rule" style="color:var(--accent)">${it.rule}</span></span>${it.win?`<span class="win ${it.win==='a'?'cp':'v4'}">${it.win==='a'?A:B} better</span>`:''}</div>
      <div class="n num">${it.n} <span class="hint">${A} vs ${B}</span></div><p>${it.text}</p>${chips(it.ids)}</li>`).join('')}</ol>`;
}
$('#diff').addEventListener('click', e => { const b = e.target.closest('[data-pin]'); if (!b) return; setSel(b.dataset.pin); applyFocus(); scrollToTask(b.dataset.pin) });

/* ---------- wiring ---------- */
function toggleSet(name, v){ S[name].has(v) ? S[name].delete(v) : S[name].add(v); save(name); renderToolbar(); renderGantt() }
function render(){
  if (S.mode!=='a' && !W.engines.b) S.mode = 'a';
  $('#mode').innerHTML = W.engines.b ? `<button data-v="a">${esc(L('a'))}</button><button data-v="b">${esc(L('b'))}</button><button data-v="both">Compare</button>` : '';
  $('#mode').hidden = !W.engines.b;
  $$('#mode button').forEach(b=>b.setAttribute('aria-pressed', b.dataset.v===S.mode));
  $$('.tabs button').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===S.tab));
  $('#ganttView').hidden = S.tab!=='gantt'; $('#dataView').hidden = S.tab!=='data';
  kpis(); renderToolbar();
  if (S.tab==='gantt'){ renderDiff(); renderGantt() } else { renderData(); renderStatus() }
}
$('#mode').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return; S.mode = v; render() });
$('.tabs').addEventListener('click', e => { const v = e.target.dataset.tab; if (!v) return; S.tab = v; save('tab'); render() });
$('#crit').addEventListener('click', () => { S.crit = !S.crit; save('crit'); renderToolbar(); renderGantt() });
$('#tips').addEventListener('click', () => { S.tips = !S.tips; save('tips'); renderToolbar() });
$('#links').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return; S.linkMode = v; save('linkMode'); renderToolbar(); renderGantt() });
$('#labels').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return; S.labels = v; save('labels'); renderToolbar(); renderGantt() });
$('#win').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return; S.win = v; save('win'); renderToolbar(); renderGantt() });
$('#zoom').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return;
  const cur = pxFor(spanFor(engines()));
  S.zoom = v==='fit' ? 'fit' : Math.min(40, Math.max(1.5, v==='in' ? cur*1.4 : cur/1.4)); save('zoom'); renderToolbar(); renderGantt() });
$('#groups').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.show) toggleSet('hidden', b.dataset.show); else if (b.dataset.col) toggleSet('collapsed', b.dataset.col) });
$('#collapseAll').addEventListener('click', () => { S.collapsed = S.collapsed.size ? new Set() : new Set(['1','2','3','4','plant']); save('collapsed'); renderToolbar(); renderGantt() });
$('#hls').addEventListener('change', e => { const s = +e.target.dataset.hl; if (!s) return; S.hl.has(s) ? S.hl.delete(s) : S.hl.add(s); save('hl'); renderToolbar(); renderGantt() });
[['hlLinks','hlLinks'],['multi','multi'],['strip','strip'],['top','top']].forEach(([id,k]) =>
  $('#'+id).addEventListener('change', e => { S[k] = e.target.checked; save(k); renderToolbar(); renderGantt() }));
$('#statusbar').addEventListener('click', e => { if (e.target.id==='topx'){ S.top = false; save('top'); renderToolbar(); renderGantt() } });
$('#dview').addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return; S.dview = v; S.sort = {key:null,dir:1}; save('dview'); renderData() });
$('#cats').addEventListener('click', e => { const c = e.target.dataset.cat; if (!c) return; S.cats = {...S.cats, [c]: !S.cats[c]}; save('cats'); renderData() });
$('#sysf').addEventListener('change', e => { S.sysf = e.target.value; renderData() });
$('#q').addEventListener('input', e => { S.q = e.target.value; renderData() });
$('#grid').addEventListener('click', e => {
  const th = e.target.closest('[data-sort]'); if (th){ const k = th.dataset.sort; S.sort = {key:k, dir: S.sort.key===k ? -S.sort.dir : 1}; renderData(); return }
  const tr = e.target.closest('[data-open]'); if (!tr) return;
  S.selected = tr.dataset.open; if (S.mode==='both') S.mode = 'a'; S.tab = 'gantt'; save('tab'); setSel(S.selected); render();
  requestAnimationFrame(() => scrollToTask(S.selected));
});
let rz = 0; const onResize = () => { if (!W || S.zoom!=='fit' || S.tab!=='gantt') return; clearTimeout(rz); rz = setTimeout(renderGantt, 150) }; addEventListener('resize', onResize);


function setSel(id){ if (S.selected === id) return; S.selected = id; onSelect(id) }

return {
  /* New week or plans: drop cached derivations; keep the toolbar and the selection if the PO still exists. */
  update(data){
    const newWeek = !W || W.plant !== data.plant;
    W = data; cache = {};
    if (newWeek){ S.linkMode = store.get('linkMode', null); if (S.selected && !data.plant.batches.some(b=>b.id===S.selected) && !data.plant.fills.some(f=>f.id===S.selected)) setSel(null) }
    render();
  },
  select(id){ setSel(id); if (S.tab!=='gantt'){ S.tab = 'gantt'; render() } else applyFocus(); requestAnimationFrame(() => id && scrollToTask(id)) },
  destroy(){ removeEventListener('scroll', onScroll); removeEventListener('resize', onResize); root.innerHTML = '' },
};
}
