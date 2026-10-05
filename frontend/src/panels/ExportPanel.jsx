import { Card } from './common.jsx'

export default function ExportPanel({ week, plan }) {
  return (
    <Card title="Export">
      {plan ? (
        <>
          <p className="text-sm">Plan <b>{plan.name}</b></p>
          <div className="flex flex-wrap gap-2">
            <a className="btn" href={`/api/plans/${plan.id}/export.xlsx`}>Excel (.xlsx)</a>
            <a className="btn" href={`/api/plans/${plan.id}/export.pdf`}>PDF for the floor</a>
          </div>
          <p className="text-sm text-muted">Excel has a summary, a sheet per line and per tank (with planned stops), and every batch and fill PO. The PDF prints in black and white: the Gantt, then one run sheet per fill line and per system with a Done column.</p>
        </>
      ) : <p className="text-sm text-muted">Optimise or choose a plan to export it.</p>}
      <div className="flex flex-wrap gap-2 border-t border-line pt-2">
        <a className="btn" href={`/api/weeks/${week.id}/export.json`}>Save week (.json)</a>
      </div>
      <p className="text-sm text-muted">A saved week opens again with <b>Open…</b> at the top.</p>
    </Card>
  )
}
