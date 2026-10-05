import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Card } from './common.jsx'

// Why each batch PO misses the week limit (P0) and why each fill runs past its hold limit (P3), from /explain.
export default function ExplainPanel({ plan, pick, fail }) {
  const [x, setX] = useState(null)
  const [show, setShow] = useState('outside')
  const [open, setOpen] = useState(null)
  useEffect(() => {
    setX(null)
    if (plan) api.explain(plan.id).then(setX).catch(fail)
  }, [plan, fail])
  if (!plan) return <Card><p className="text-sm text-muted">Optimise or choose a plan first.</p></Card>
  if (!x) return <Card><p className="text-sm text-muted">Working out the reasons…</p></Card>

  const s = x.summary
  // one row per batch group (a trio's 3 batches share their reasons)
  const seen = new Set()
  const outside = Object.entries(x.pos).filter(([, p]) => p.kind === 'batch' && p.status === 'outside_week')
    .filter(([id, p]) => { const k = p.fill_ids.join() || id; if (seen.has(k)) return false; seen.add(k); return true })
  const late = Object.entries(x.pos).filter(([, p]) => p.kind === 'fill' && p.status === 'late_fill')
  const rows = show === 'outside' ? outside : show === 'late' ? late : []

  return (
    <>
      <Card title="Summary"><p className="text-sm">{s.text}</p>
        {s.structural_impossible > 0 && <p className="text-sm"><b>{s.structural_impossible}</b> System 1 trio or batch groups cannot meet their hold limit in any plan at the S14 fill rates: their fills need more time back to back than the hold limit allows.</p>}
      </Card>
      <div className="flex flex-wrap gap-1" role="tablist">
        {[['outside', `Outside week (${outside.length})`, 'P0'], ['late', `Late fills (${late.length})`, 'P3'], ['crit', `Critical path (${x.critical_path.length})`, 'P4']].map(([k, l, r]) => (
          <button key={k} role="tab" aria-selected={show === k} className={`btn ${show === k ? 'border-accent bg-accent-soft' : ''}`} onClick={() => setShow(k)}>{l} <span className="rid">{r}</span></button>
        ))}
      </div>
      {show !== 'crit' && (
        <Card>
          {!rows.length && <p className="text-sm text-muted">None in this plan.</p>}
          <ul className="flex flex-col">
            {rows.map(([id, p]) => (
              <li key={id} className="border-t border-line py-2 first:border-t-0">
                <div className="flex items-baseline gap-2">
                  <button className="font-mono font-semibold hover:text-accent" onClick={() => pick(id)}>{id}</button>
                  <span className="text-sm text-muted">{p.kind === 'fill' ? `${p.line}, ${p.late_h}h past hold limit` : `${p.tank}, done at ${Math.round(p.done_at * 100) / 100}h`}</span>
                  {p.structural && <span className="rounded bg-row px-1.5 text-xs text-bad" title="Cannot meet its hold limit in any plan at the S14 fill rates">can't fit</span>}
                  <button className="ml-auto text-xs text-muted hover:text-fg" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>{open === id ? 'Less' : `Why (${p.reasons.length})`}</button>
                </div>
                {(open === id ? p.reasons : p.reasons.slice(0, 1)).map((r, i) => (
                  <p key={i} className="mt-1 flex gap-2 text-sm"><span className="rid w-8 shrink-0">{r.rule}</span><span className="min-w-0">{r.text}</span></p>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {show === 'crit' && (
        <Card>
          <p className="text-sm text-muted">The chain of tasks that sets when the plan ends, latest first. Click one to find it on the Gantt.</p>
          <ol className="flex flex-col text-sm">
            {x.critical_path.map(c => (
              <li key={c.id} className="border-t border-line py-1.5">
                <button className="font-mono hover:text-accent" onClick={() => pick(c.id)}>{c.id}</button> <span className="text-muted">on {c.where}, {c.start_clock}–{c.end_clock}</span>
                <p className="flex gap-2"><span className="rid w-8 shrink-0">{c.rule}</span><span className="min-w-0">{c.reason}</span></p>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  )
}
