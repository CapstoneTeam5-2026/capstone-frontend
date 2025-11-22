"use client"

import React, { useEffect, useRef, useState } from "react"

export default function SimpleDropdown({ value, items = [], onChange = () => {}, placeholder = "Select" }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const focusedIndexRef = useRef(-1)

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("click", onDoc)
    return () => document.removeEventListener("click", onDoc)
  }, [])

  useEffect(() => {
    if (!open) focusedIndexRef.current = -1
  }, [open])

  function onKeyDown(e) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); setOpen(true); return
    }
    if (!open) return
    if (e.key === "Escape") { setOpen(false); return }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      focusedIndexRef.current = Math.min(items.length - 1, focusedIndexRef.current + 1)
      scrollToIndex(focusedIndexRef.current)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      focusedIndexRef.current = Math.max(0, focusedIndexRef.current - 1)
      scrollToIndex(focusedIndexRef.current)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const idx = focusedIndexRef.current >= 0 ? focusedIndexRef.current : items.findIndex(i => i.value === value)
      if (idx >= 0) { onChange(items[idx].value); setOpen(false) }
    }
  }

  function scrollToIndex(i) {
    const list = ref.current?.querySelector("[role='listbox']")
    const item = list?.children?.[i]
    if (item) item.scrollIntoView({ block: "nearest" })
  }

  const currentLabel = items.find(i => i.value === value)?.label ?? placeholder

  return (
    <div ref={ref} className="relative w-full z-[1000]" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(s => !s)}
        className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-gray-100 text-sm flex items-center justify-between focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <span className="truncate">{currentLabel}</span>
        <svg className="w-4 h-4 text-gray-400 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
          <path d="M6 9l6 6 6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          tabIndex={-1}
          className="absolute z-[1000] mt-1 w-full bg-gray-900 border border-gray-800 rounded shadow max-h-56 overflow-auto text-sm"
          style={{ boxShadow: "0 6px 18px rgba(2,6,23,0.6)", zIndex: 1000 }}
        >
          {items.map((it, idx) => {
            const active = it.value === value
            return (
              <li
                key={it.value}
                role="option"
                aria-selected={active}
                onClick={() => { onChange(it.value); setOpen(false) }}
                onMouseEnter={() => { focusedIndexRef.current = idx }}
                className={`px-3 py-2 cursor-pointer text-gray-100 ${active ? "bg-indigo-600/30" : "hover:bg-gray-800"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate">{it.label}</span>
                  {active && (
                    <svg className="w-4 h-4 text-indigo-300 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                      <path d="M20 6L9 17l-5-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
