import { useEffect, useState } from 'react'
import { api, fh } from '../api.js'
import { Card } from './common.jsx'
import { Field } from './WeekBar.jsx'

const LINES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']

// What-if: run the week again with changed inputs and compare each against the base plan.
export default function ScenariosPanel({ week, running, job, startJob, setPlanA, setPlanB, fail }) {
  const [presets, setPresets] = useState([])
  const [chosen, setChosen] = useState(new Set())
  const [custom, setCustom] = useState({ name: '', line: 'F3', speed: 0, hold: 0, cip: 0, drop: [] })
  const [tl, setTl] = useState(week.plant.batches.length > 60 ? 60 : 20)
  useEffect(() => { api.presets().then(setPresets).catch(fail) }, [fail])
  const set = (k, v) => setCustom(c => ({ ...c, [k]: v }))

  const customScenario = () => {
    const s = { name: custom.name.trim() || 'My what-if' }
    if (+custom.speed) s.line_rate = { [custom.line]: 1 + custom.speed / 100 }
    if (+custom.hold) s.hold_extra_h = Math.round(+custom.hold * 4) / 4
    if (+custom.cip) s.cip_mult = 1 - custom.cip / 100
    if (custom.drop.length) s.remove_downtime = custom.drop
    return Object.keys(s).length > 1 ? s : null
  }
  const run = async () => {
    const list = presets.filter(p => chosen.has(p.name)).map(p => p.scenario)
    const c = customScenario(); if (c) list.push(c)
    if (!list.length) return fail(new Error('Pick at least one what-if, or fill in your own.'))
    try { startJob(await api.scenarios(week.id, { scenarios: list, time_limit: +tl })) } catch (e) { fail(e) }
  }
  const res = job && job.kind === 'scenarios' && job.week_id === week.id ? job : null
  const base = res?.result?.plans?.['Base plan'] || Object.values(res?.result?.plans || {})[0]

  return (
    <>
      <Card title="What-if scenarios">
        <ul className="flex flex-col gap-1 text-sm">
          {presets.map(p => (
            <li key={p.name}><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={chosen.has(p.name)}
              onChange={() => setChosen(s => { const n = new Set(s); n.has(p.name) ? n.delete(p.name) : n.add(p.name); return n })} />
              <span><b>{p.name}</b><br /><span className="text-muted">{p.overrides}</span></span></label></li>
          ))}
        </ul>
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold">Your own</summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Name"><input className="field w-40" value={custom.name} placeholder="My what-if" onChange={e => set('name', e.target.value)} /></Field>
            <Field label="Line"><select className="field" value={custom.line} onChange={e => set('line', e.target.value)}>{LINES.map(l => <option key={l}>{l}</option>)}</select></Field>
            <Field label="Faster %"><input className="field w-20" type="number" value={custom.speed} onChange={e => set('speed', e.target.value)} /></Field>
            <Field label="Hold limit +h"><input className="field w-20" type="number" step="0.25" value={custom.hold} onChange={e => set('hold', e.target.value)} /></Field>
            <Field label="CIP quicker %"><input className="field w-20" type="number" value={custom.cip} onChange={e => set('cip', e.target.value)} /></Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2"><span className="cap">No maintenance on</span>
            {LINES.map(l => <label key={l} className="flex items-center gap-1"><input type="checkbox" checked={custom.drop.includes(l)}
              onChange={e => set('drop', e.target.checked ? [...custom.drop, l] : custom.drop.filter(x => x !== l))} />{l}</label>)}
          </div>
        </details>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Seconds per plan"><input className="field w-24" type="number" min="3" value={tl} onChange={e => setTl(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={running} onClick={run}>{running ? 'Running…' : 'Run what-ifs'}</button>
          {running && res && <button className="btn btn-danger" onClick={() => api.cancel(res.id).catch(fail)}>Stop</button>}
        </div>
        <p className="text-sm text-muted">Each what-if is optimised from scratch alongside a base plan with today's inputs, one after another.</p>
      </Card>
      {res && (
        <Card title="Results" right={<span className="text-sm text-muted">{res.state}</span>}>
          {!res.result && <p className="text-sm text-muted">{res.events.at(-1)?.stage || 'Queued'}</p>}
          {res.result && (
            <ul className="flex flex-col">
              {res.result.rows.map(r => {
                const pid = res.result.plans[r.name]
                return (
                  <li key={r.name} className="border-t border-line py-2 text-sm first:border-t-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <b>{r.name}</b>
                      {r.verdict?.includes('Best of all') && <span className="rounded-full bg-accent px-2 text-xs font-semibold text-white">best</span>}
                      <span className="ml-auto flex gap-1">
                        <button className="btn !px-2 !py-0.5 text-xs" onClick={() => { setPlanA(pid); setPlanB(base && base !== pid ? base : null) }}>View vs base</button>
                      </span>
                    </div>
                    <p className="font-mono text-xs tabular-nums">{r.metrics.pos_in_week_limit}/{r.metrics.batch_pos} in week · {r.metrics.fills_over_hold_limit} over hold · ends {fh(r.metrics.makespan)}
                      {r.delta && r.name !== 'Base plan' && <span className="text-muted"> · Δ in week {r.delta.pos_in_week_limit >= 0 ? '+' : ''}{r.delta.pos_in_week_limit}</span>}</p>
                    <p className="text-muted">{r.verdict}</p>
                  </li>
                )
              })}
            </ul>
          )}
          {res.error && <p className="text-sm text-bad">{res.error}</p>}
        </Card>
      )}
    </>
  )
}
