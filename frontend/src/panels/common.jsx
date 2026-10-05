import { api, fh } from '../api.js'

// One request for every optimise: the planner's steering goes with it (M11 pins, P1 urgent fills, P2 targets, M1 re-plan).
export async function runOptimise(week, plan, steer, { time_limit, goal, name }, startJob) {
  const body = { time_limit: +time_limit, goal, starred: steer.starred, targets: steer.targets, pins: steer.pins, name: name || undefined }
  if (plan) body.base_plan_id = plan.id
  if (steer.replanFrom != null) {
    if (!plan) throw new Error('Re-planning from a time needs a plan to start from. Optimise once first.')
    body.replan_from = +steer.replanFrom
  }
  const j = await api.optimise(week.id, body)
  startJob(j)
}

export function steerSummary(steer) {
  const n = Object.keys(steer.pins).length, s = steer.starred.length, t = Object.keys(steer.targets).length
  const parts = []
  if (n) parts.push(`${n} pinned`)
  if (s) parts.push(`${s} urgent`)
  if (t) parts.push(`${t} target${t > 1 ? 's' : ''}`)
  if (steer.replanFrom != null) parts.push(`re-plan from ${fh(steer.replanFrom)}`)
  return parts.join(' · ')
}

export const M = [
  ['pos_in_week_limit', 'In week', 'P0', v => v],
  ['fills_over_hold_limit', 'Over hold', 'P3', v => v],
  ['makespan', 'Ends', 'P4', fh],
  ['fill_wait_h', 'Wait', 'P6', fh],
]

export function Metrics({ m, compact }) {
  if (!m) return null
  return (
    <span className={`flex flex-wrap gap-x-3 gap-y-0.5 font-mono tabular-nums ${compact ? 'text-xs' : 'text-sm'}`}>
      {M.map(([k, l, r, f]) => <span key={k} title={`${l} (${r})`}><span className="text-muted">{l} </span>{f(m[k])}{k === 'pos_in_week_limit' ? <span className="text-muted">/{m.batch_pos}</span> : ''}</span>)}
    </span>
  )
}

export function Card({ title, children, right }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
      {title && <div className="flex items-baseline justify-between gap-2"><h2 className="font-semibold">{title}</h2>{right}</div>}
      {children}
    </section>
  )
}
