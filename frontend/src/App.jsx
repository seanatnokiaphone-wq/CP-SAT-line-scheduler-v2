import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import Viewer from './Viewer.jsx'
import WeekBar from './panels/WeekBar.jsx'
import PlansPanel from './panels/PlansPanel.jsx'
import SteerPanel from './panels/SteerPanel.jsx'
import ExplainPanel from './panels/ExplainPanel.jsx'
import ScenariosPanel from './panels/ScenariosPanel.jsx'
import ExportPanel from './panels/ExportPanel.jsx'

const TABS = [['plans', 'Optimise'], ['steer', 'Steer'], ['explain', 'Explain'], ['whatif', 'What-if'], ['export', 'Export']]
const emptySteer = () => ({ pins: {}, starred: [], targets: {}, replanFrom: null })

export default function App() {
  const [weeks, setWeeks] = useState([])
  const [weekId, setWeekId] = useState(null)
  const [week, setWeek] = useState(null)
  const [planA, setPlanA] = useState(null) // plan shown
  const [planB, setPlanB] = useState(null) // plan compared against
  const [plans, setPlans] = useState({}) // id -> full plan
  const [job, setJob] = useState(null) // running or last job, with live events
  const [steer, setSteer] = useState(emptySteer)
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('plans')
  const [error, setError] = useState(null)
  const selectRef = useRef(null)

  const fail = useCallback(e => setError(String(e.message || e)), [])
  const refreshWeeks = useCallback(() => api.weeks().then(setWeeks).catch(fail), [fail])
  useEffect(() => { refreshWeeks() }, [refreshWeeks])
  useEffect(() => { if (!weekId && weeks.length) setWeekId(weeks[0].id) }, [weeks, weekId])

  const summary = weeks.find(w => w.id === weekId)
  const planList = useMemo(() => summary?.plans || [], [summary])

  // load a week; reset steering and pick its newest plan
  useEffect(() => {
    if (!weekId) { setWeek(null); return }
    let live = true
    api.week(weekId).then(w => { if (!live) return; setWeek(w); setSteer(emptySteer()); setSelected(null); setPlanB(null)
      const opt = w.plans.filter(p => p.kind !== 'scenario'); setPlanA(opt.length ? opt[opt.length - 1].id : w.plans.at(-1)?.id || null) }).catch(fail)
    return () => { live = false }
  }, [weekId, fail])

  // fetch full plans on demand
  useEffect(() => {
    [planA, planB].filter(id => id && !plans[id]).forEach(id => api.plan(id).then(p => setPlans(m => ({ ...m, [id]: p }))).catch(fail))
  }, [planA, planB, plans, fail])

  const startJob = useCallback(j => {
    setJob({ ...j, events: [], live: null })
    const stop = api.stream(j.id, ev => setJob(cur => cur && cur.id === j.id ? { ...cur, state: 'running', events: [...cur.events, { ...ev, schedule: undefined }], live: ev.schedule ? ev : cur.live } : cur),
      end => {
        setJob(cur => cur && cur.id === j.id ? { ...cur, ...end, events: cur.events, live: null } : cur)
        refreshWeeks()
        if (end.result?.plan_id) { setPlanB(prev => prev ?? null); setPlanA(end.result.plan_id) }
        if (end.error) fail(new Error(end.error))
      })
    return stop
  }, [refreshWeeks, fail])

  const running = job && (job.state === 'queued' || job.state === 'running')

  const marks = useMemo(() => ({ pinned: new Set(Object.keys(steer.pins)), starred: new Set(steer.starred), targets: steer.targets }), [steer])
  const data = useMemo(() => {
    if (!week) return null
    const A = planA && plans[planA], B = planB && plans[planB]
    const eng = p => ({ label: p.name, schedule: p.schedule, metrics: p.metrics, valid: p.valid })
    let engines = null, note = ''
    if (running && job.live) {
      engines = { a: { label: `Live: ${job.live.stage}`, schedule: job.live.schedule, metrics: job.live.metrics, valid: job.live.valid } }
      if (A) engines.b = eng(A)
      note = `solving… ${job.live.t ?? ''}s`
    } else if (A) {
      engines = { a: eng(A) }
      if (B && B.id !== A.id) engines.b = eng(B)
      note = A.seconds != null ? `${A.engine} · ${Math.round(A.seconds)} s` : A.engine
    }
    if (!engines) return null
    return { plant: week.plant, downtime: week.downtime, engines, marks, replanFrom: steer.replanFrom, note }
  }, [week, planA, planB, plans, running, job, marks, steer.replanFrom])

  const pick = id => { selectRef.current?.(id) }
  const A = planA && plans[planA]

  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 py-4">
      <WeekBar weeks={weeks} weekId={weekId} setWeekId={setWeekId} refresh={refreshWeeks} fail={fail} />
      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-bad px-3 py-2 text-sm text-bad">
          <span>{error}</span><button className="btn" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {!weeks.length && <Empty />}
      {week && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <main className="min-w-0">
            {data ? <Viewer data={data} onSelect={setSelected} selectRef={selectRef} />
              : <div className="rounded-lg border border-line bg-panel p-6 text-muted">This week has no plan yet. Press <b>Optimise</b> to make one.</div>}
          </main>
          <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-3 xl:max-h-[calc(100vh-24px)] xl:self-start xl:overflow-y-auto">
            <nav className="flex gap-0.5 overflow-x-auto border-b border-line" role="tablist">
              {TABS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={`-mb-px border-b-2 shrink-0 px-2 py-2 text-sm font-medium ${tab === k ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}>
                  {l}{k === 'steer' && (Object.keys(steer.pins).length + steer.starred.length) ? ` (${Object.keys(steer.pins).length + steer.starred.length})` : ''}
                </button>
              ))}
            </nav>
            {tab === 'plans' && <PlansPanel week={week} plans={planList} planA={planA} planB={planB} setPlanA={setPlanA} setPlanB={setPlanB}
              job={job} running={running} startJob={startJob} steer={steer} fail={fail} refresh={refreshWeeks} />}
            {tab === 'steer' && <SteerPanel week={week} plan={A} selected={selected} steer={steer} setSteer={setSteer} pick={pick}
              running={running} startJob={startJob} fail={fail} />}
            {tab === 'explain' && <ExplainPanel plan={A} pick={pick} fail={fail} />}
            {tab === 'whatif' && <ScenariosPanel week={week} running={running} job={job} startJob={startJob} setPlanA={setPlanA} setPlanB={setPlanB} fail={fail} />}
            {tab === 'export' && <ExportPanel week={week} plan={A} />}
          </aside>
        </div>
      )}
    </div>
  )
}

function Empty() {
  return (
    <div className="rounded-lg border border-line bg-panel p-6">
      <h2 className="text-lg font-semibold">No weeks yet</h2>
      <p className="text-muted">Use <b>New week</b> above to generate a week of POs (the v49 generator, by seed), or <b>Open</b> a week file saved from this app.</p>
    </div>
  )
}
