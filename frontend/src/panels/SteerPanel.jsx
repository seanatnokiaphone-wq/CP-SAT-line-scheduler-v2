import { useState } from 'react'
import { clock, fh } from '../api.js'
import { Card, runOptimise, steerSummary } from './common.jsx'
import { Field } from './WeekBar.jsx'

// Planner steering: pin a PO where it is (M11), mark a fill urgent (P1) or give it a target start (P2),
// and re-plan from a time so work already started stays put (M1, M10).
export default function SteerPanel({ week, plan, selected, steer, setSteer, pick, running, startJob, fail }) {
  const [tl, setTl] = useState(week.plant.batches.length > 60 ? 120 : 30)
  const [tgt, setTgt] = useState('')
  const po = selected && (week.plant.batches.find(b => b.id === selected) || week.plant.fills.find(f => f.id === selected))
  const isFill = po && 'batchId' in po
  const task = po && plan && (isFill ? plan.schedule.fills : plan.schedule.batches).find(t => t.id === selected)
  const pin = steer.pins[selected]
  const starred = steer.starred.includes(selected)
  const upd = f => setSteer(s => f({ ...s, pins: { ...s.pins }, targets: { ...s.targets }, starred: [...s.starred] }))

  const pinHere = timeToo => upd(s => { s.pins[selected] = isFill ? { line: task.line, ...(timeToo ? { start: task.start } : {}) } : { tank: task.tank, ...(timeToo ? { start: task.start } : {}) }; return s })
  const unpin = id => upd(s => { delete s.pins[id]; return s })
  const toggleStar = () => upd(s => { s.starred = starred ? s.starred.filter(x => x !== selected) : [...s.starred, selected]; return s })
  const setTarget = () => upd(s => { const h = Math.round(+tgt * 4) / 4; if (tgt === '' || isNaN(h)) delete s.targets[selected]; else s.targets[selected] = h; return s })
  const nowHours = () => { const d = new Date(), mon = new Date(d); mon.setHours(7, 0, 0, 0); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); if (mon > d) mon.setDate(mon.getDate() - 7)
    return Math.max(0, Math.min(168, Math.floor((d - mon) / 9e5) / 4)) }
  const go = async () => { try { await runOptimise(week, plan, steer, { time_limit: tl, goal: 'fit', name: steer.replanFrom != null ? `Re-plan from ${clock(steer.replanFrom)}` : 'Steered plan' }, startJob) } catch (e) { fail(e) } }

  return (
    <>
      <Card title="Selected PO">
        {!po && <p className="text-sm text-muted">Click a batch or fill on the Gantt (or a row in PO data) to steer it.</p>}
        {po && (
          <>
            <div className="text-sm">
              <b className="font-mono">{po.id}</b> · {po.productName} <span className="font-mono text-muted">({po.sku}, cat {po.category})</span><br />
              {task ? <>{isFill ? task.line : task.tank}, {clock(task.start)} to {clock(task.end)} ({fh(task.start)}–{fh(task.end)})</> : <span className="text-muted">Not in the plan shown.</span>}
            </div>
            {task && (
              <div className="flex flex-wrap gap-2">
                <button className="btn" onClick={() => pinHere(true)}>Pin time and {isFill ? 'line' : 'tank'}</button>
                <button className="btn" onClick={() => pinHere(false)}>Pin {isFill ? 'line' : 'tank'} only</button>
                {pin && <button className="btn btn-danger" onClick={() => unpin(selected)}>Unpin</button>}
              </div>
            )}
            {pin && <p className="text-sm">Pinned <span className="rid">M11</span>: {pin.line || pin.tank}{pin.start != null ? `, starts ${clock(pin.start)}` : ', any time'}</p>}
            {isFill && (
              <div className="flex flex-wrap items-end gap-2">
                <button className={`btn ${starred ? 'btn-primary' : ''}`} onClick={toggleStar} aria-pressed={starred}>★ {starred ? 'Urgent' : 'Mark urgent'}</button>
                <span className="rid self-center">P1</span>
                <Field label={<>Target start (h) <span className="rid">P2</span></>}><input className="field w-24" type="number" step="0.25" min="0" placeholder={steer.targets[selected] ?? ''} value={tgt} onChange={e => setTgt(e.target.value)} /></Field>
                <button className="btn" onClick={setTarget}>{tgt === '' ? 'Clear target' : 'Set target'}</button>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Re-plan from a time">
        <p className="text-sm text-muted">Work that has started by this time stays exactly where it is; everything else is re-optimised to start at or after it (M1, M10).</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Hours from Mon 07:00"><input className="field w-28" type="number" step="0.25" min="0" max="168" value={steer.replanFrom ?? ''} placeholder="off"
            onChange={e => upd(s => { s.replanFrom = e.target.value === '' ? null : Math.round(+e.target.value * 4) / 4; return s })} /></Field>
          <button className="btn" onClick={() => upd(s => { s.replanFrom = nowHours(); return s })}>Now</button>
          <button className="btn" onClick={() => upd(s => { s.replanFrom = null; return s })}>Off</button>
        </div>
        {steer.replanFrom != null && <p className="text-sm">From <b>{clock(steer.replanFrom)}</b> ({fh(steer.replanFrom)}).</p>}
      </Card>

      <Card title="Steering" right={<button className="btn" disabled={!steerSummary(steer)} onClick={() => setSteer({ pins: {}, starred: [], targets: {}, replanFrom: null })}>Clear all</button>}>
        <List steer={steer} pick={pick} unpin={unpin} upd={upd} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Time limit (s)"><input className="field w-24" type="number" min="3" value={tl} onChange={e => setTl(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={running || !steerSummary(steer)} onClick={go}>Re-optimise with steering</button>
        </div>
        {!plan && steer.replanFrom != null && <p className="text-sm text-bad">Re-planning needs a plan shown to start from.</p>}
      </Card>
    </>
  )
}

function List({ steer, pick, unpin, upd }) {
  const rows = [
    ...Object.entries(steer.pins).map(([id, p]) => ({ id, what: `Pinned to ${p.line || p.tank}${p.start != null ? ` at ${fh(p.start)}` : ''}`, rule: 'M11', rm: () => unpin(id) })),
    ...steer.starred.map(id => ({ id, what: 'Urgent fill', rule: 'P1', rm: () => upd(s => { s.starred = s.starred.filter(x => x !== id); return s }) })),
    ...Object.entries(steer.targets).map(([id, h]) => ({ id, what: `Target start ${fh(h)}`, rule: 'P2', rm: () => upd(s => { delete s.targets[id]; return s }) })),
  ]
  if (!rows.length) return <p className="text-sm text-muted">Nothing pinned or marked yet.</p>
  return (
    <ul className="flex flex-col text-sm">
      {rows.map(r => (
        <li key={r.id + r.rule} className="flex items-center gap-2 border-t border-line py-1">
          <button className="font-mono hover:text-accent" onClick={() => pick(r.id)}>{r.id}</button>
          <span className="flex-1">{r.what}</span><span className="rid">{r.rule}</span>
          <button className="text-muted hover:text-bad" aria-label={`Remove ${r.what} for ${r.id}`} onClick={r.rm}>×</button>
        </li>
      ))}
    </ul>
  )
}
