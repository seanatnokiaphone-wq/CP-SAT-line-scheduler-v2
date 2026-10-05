import { useEffect, useRef } from 'react'
import { createViewer } from './viewer/viewer.js'

// The Gantt / KPI / PO-data / compare viewer (ported from tools/viewer/template.html), mounted once and fed data.
export default function Viewer({ data, onSelect, selectRef }) {
  const el = useRef(null), v = useRef(null), sel = useRef(onSelect)
  sel.current = onSelect
  useEffect(() => {
    v.current = createViewer(el.current, { onSelect: id => sel.current?.(id) })
    if (selectRef) selectRef.current = id => v.current?.select(id)
    return () => { v.current.destroy(); v.current = null }
  }, [selectRef])
  useEffect(() => { if (data && v.current) v.current.update(data) }, [data])
  return <div ref={el} />
}
