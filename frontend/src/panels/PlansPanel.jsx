import { useState } from 'react'
import { api } from '../api.js'
import { Card, Metrics, runOptimise, steerSummary } from './common.jsx'
import { Field } from './WeekBar.jsx'

export default function PlansPanel({ week, plans, planA, planB, setPlanA, setPlanB, job, running, startJob, steer, fail, refresh }) {
  const [opt, setOpt] = useState({ time_limit: week.plant.batches.length > 60 ? 120 : 30, goal: 'fit', name: '' })
  const base = plans.find(p => p.id === planA)
  const ss = steerSummary(steer)
  const go = async () => { try { await runOptimise(week, base, steer, opt, startJob) } catch (e) { fail(e) } }
  const del = async id => { try { await api.deletePlan(id); if (id === planA) setPlanA(null); if (id === planB) setPlanB(null); refresh() } catch (e) { fail(e) } }
  const jobHere = job && job.week_id === week.id && job.kind === 'optimise'

  return (
    <>
      <Card title="Optimise">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Time limit (s)"><input className="field w-24" type="number" min="3" max="3600" value={opt.time_limit} onChange={e => setOpt(o => ({ ...o, time_limit: e.target.value }))} /></Field>
          <Field label="Goal">
            <select className="field" value={opt.goal} onChange={e => setOpt(o => ({ ...o, goal: e.target.value }))}>
              <option value="fit">Most POs in week limit (P0)</option><option value="fast">Fastest finish (P4)</option>
            </select>
          </Field>
        </div>
        <Field label="Plan name (optional)"><input className="field" value={opt.name} placeholder="e.g. Monday plan" onChange={e => setOpt(o => ({ ...o, name: e.target.value }))} /></Field>
        {ss && <p className="text-sm">Steering applied: <b>{ss}</b>. Change it on the Steer tab.</p>}
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={running} onClick={go}>{running ? 'Solving…' : 'Optimise'}</button>
          {running && <button className="btn btn-danger" onClick={() => api.cancel(job.id).catch(fail)}>Stop and keep best</button>}
        </div>
        <p className="text-sm text-muted">Big weeks use half the time on the whole week, then improve it 48h at a time. The plan on the left updates live as better plans are found.</p>
      </Card>

      {jobHere && <Progress job={job} />}

      <Card title={`Plans (${plans.length})`} right={<span className="text-xs text-muted">Show · Compare</span>}>
        {!plans.length && <p className="text-sm text-muted">None yet.</p>}
        <ul className="flex flex-col divide-y divide-line">
          {[...plans].reverse().map(p => (
            <li key={p.id} className={`flex flex-col gap-1 py-2 ${p.id === planA ? 'bg-accent-soft -mx-3 px-3' : ''}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="planA" aria-label={`Show ${p.name}`} checked={p.id === planA} onChange={() => { setPlanA(p.id); if (planB === p.id) setPlanB(null) }} />
                <input type="checkbox" aria-label={`Compare with ${p.name}`} disabled={p.id === planA} checked={p.id === planB} onChange={e => setPlanB(e.target.checked ? p.id : null)} />
                <span className="min-w-0 flex-1 truncate font-medium" title={p.name}>{p.name}</span>
                <span className={`text-xs ${p.valid ? 'text-good' : 'text-bad'}`}>{p.valid ? 'valid' : 'rule breaks'}</span>
                <button className="text-muted hover:text-bad" aria-label={`Delete ${p.name}`} onClick={() => del(p.id)}>×</button>
              </div>
              <Metrics m={p.metrics} compact />
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}

function Progress({ job }) {
  const evs = job.events.filter(e => e.metrics)
  const last = evs.at(-1)
  return (
    <Card title={job.title} right={<span className={`text-sm font-semibold ${job.state === 'failed' ? 'text-bad' : job.state === 'done' ? 'text-good' : 'text-accent'}`}>{job.state}</span>}>
      {last && <Metrics m={last.metrics} />}
      <ol className="max-h-48 overflow-y-auto font-mono text-xs">
        {[...job.events].reverse().map(e => (
          <li key={e.n} className="flex gap-2 border-t border-line py-0.5"><span className="w-12 shrink-0 text-right text-muted">{e.t}s</span><span className="min-w-0 flex-1 truncate">{e.stage}</span>
            {e.metrics && <span>{e.metrics.pos_in_week_limit}/{e.metrics.batch_pos}</span>}</li>
        ))}
      </ol>
      {job.error && <p className="text-sm text-bad">{job.error}</p>}
    </Card>
  )
}
