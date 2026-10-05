import { useRef, useState } from 'react'
import { api } from '../api.js'

export default function WeekBar({ weeks, weekId, setWeekId, refresh, fail }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ seed: 42, pos: 60, trio_three_fill_pct: 25, fill_time: 'rate' })
  const [confirmDel, setConfirmDel] = useState(false)
  const file = useRef(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const generate = async e => {
    e.preventDefault()
    try { const w = await api.generate({ ...form, seed: +form.seed, pos: +form.pos, trio_three_fill_pct: +form.trio_three_fill_pct }); await refresh(); setWeekId(w.id); setOpen(false) } catch (err) { fail(err) }
  }
  const upload = async e => {
    const f = e.target.files[0]; e.target.value = ''
    if (!f) return
    try { const w = await api.upload(JSON.parse(await f.text())); await refresh(); setWeekId(w.id) } catch (err) { fail(err) }
  }
  const del = async () => {
    try { await api.deleteWeek(weekId); setConfirmDel(false); setWeekId(null); await refresh() } catch (err) { fail(err) }
  }

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[26px] font-bold leading-tight tracking-tight">Line Scheduler</h1>
          <p className="max-w-[75ch] text-muted">4 systems, 18 tanks, 7 fill lines. The v49 heuristic makes a first plan, CP-SAT improves it, and the rule checker checks every plan before it is shown.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="cap" htmlFor="week">Week</label>
          <select id="week" className="field max-w-[280px]" value={weekId || ''} onChange={e => setWeekId(e.target.value)}>
            {weeks.map(w => <option key={w.id} value={w.id}>{w.name} ({w.plans.length} plans)</option>)}
          </select>
          <button className="btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>New week</button>
          <button className="btn" onClick={() => file.current.click()}>Open…</button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={upload} />
          {weekId && !confirmDel && <button className="btn btn-danger" onClick={() => setConfirmDel(true)}>Delete</button>}
          {confirmDel && <span className="flex items-center gap-2 text-sm">Delete this week and its plans?
            <button className="btn btn-danger" onClick={del}>Delete</button><button className="btn" onClick={() => setConfirmDel(false)}>Keep</button></span>}
        </div>
      </div>
      {open && (
        <form onSubmit={generate} className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-3">
          <Field label="Seed"><input className="field w-24" type="number" value={form.seed} onChange={e => set('seed', e.target.value)} /></Field>
          <Field label="Batch POs"><input className="field w-24" type="number" min="1" max="400" value={form.pos} onChange={e => set('pos', e.target.value)} /></Field>
          <Field label={<>Trios with 3 fills % <span className="rid">H8</span></>}><input className="field w-24" type="number" min="0" max="100" value={form.trio_three_fill_pct} onChange={e => set('trio_three_fill_pct', e.target.value)} /></Field>
          <Field label={<>Fill times <span className="rid">S14</span></>}>
            <select className="field" value={form.fill_time} onChange={e => set('fill_time', e.target.value)}>
              <option value="rate">Volume ÷ filler rate ±10%</option><option value="random">v49 random 0.5–3h</option>
            </select>
          </Field>
          <button className="btn btn-primary" type="submit">Generate</button>
          <p className="basis-full text-sm text-muted">Same seed and size give the same orders as the v49 prototype (with 3-fill trios at 0% and v49 fill times).</p>
        </form>
      )}
    </header>
  )
}

export function Field({ label, children }) {
  return <label className="flex flex-col gap-1"><span className="cap">{label}</span>{children}</label>
}
