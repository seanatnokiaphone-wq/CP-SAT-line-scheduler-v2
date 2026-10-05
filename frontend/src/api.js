// Thin client for the FastAPI backend (backend/app/main.py).
async function call(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail) } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return r.json()
}

export const api = {
  config: () => call('GET', '/api/config'),
  weeks: () => call('GET', '/api/weeks'),
  week: id => call('GET', `/api/weeks/${id}`),
  generate: body => call('POST', '/api/weeks/generate', body),
  upload: body => call('POST', '/api/weeks/upload', body),
  deleteWeek: id => call('DELETE', `/api/weeks/${id}`),
  plan: id => call('GET', `/api/plans/${id}`),
  deletePlan: id => call('DELETE', `/api/plans/${id}`),
  explain: id => call('GET', `/api/plans/${id}/explain`),
  optimise: (wid, body) => call('POST', `/api/weeks/${wid}/optimise`, body),
  presets: () => call('GET', '/api/scenarios/presets'),
  scenarios: (wid, body) => call('POST', `/api/weeks/${wid}/scenarios`, body),
  job: id => call('GET', `/api/jobs/${id}`),
  cancel: id => call('POST', `/api/jobs/${id}/cancel`),
  // Live progress: one message per event (with the plan so far), then onEnd(job view).
  stream(id, onEvent, onEnd) {
    const es = new EventSource(`/api/jobs/${id}/stream`)
    es.onmessage = e => onEvent(JSON.parse(e.data))
    es.addEventListener('end', e => { es.close(); onEnd(JSON.parse(e.data)) })
    es.onerror = () => { es.close(); api.job(id).then(onEnd).catch(() => onEnd({ id, state: 'failed', error: 'lost connection to the server' })) }
    return () => es.close()
  },
}

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const clock = h => {
  const m = Math.round((7 + h) * 60), d = Math.floor(m / 1440), r = m - d * 1440
  return `${DAYS[d % 7]}${d >= 7 ? ' wk2' : ''} ${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`
}
export const fh = h => `${Math.round(h * 100) / 100}h`
