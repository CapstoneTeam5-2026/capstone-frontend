// components/TrainTabs.jsx
"use client"

import React from "react"
import SimpleDropdown from "./SimpleDropdown"

/**
 * TrainTabs (updated)
 * - Uses SimpleDropdown for mobile (pixel-perfect styling)
 * - Desktop: horizontal dark tabs
 * - Keeps theme consistent with HistoryComponent
 */

const tabList = [
  { value: "live", label: "Live Tracking" },
  { value: "history", label: "History" },
]

export default function TrainTabs({ children }) {
  const [tab, setTab] = React.useState("live")

  return (
    <div className="w-full">
      {/* Mobile: custom dropdown (always visible on small screens) */}
      <div className="sm:hidden mb-4">
        <SimpleDropdown
          value={tab}
          items={tabList}
          onChange={(v) => setTab(v)}
          placeholder="Select view"
        />
      </div>

      {/* Desktop tabs */}
      <nav className="hidden sm:block mb-4" aria-label="Primary">
        <ul
          role="tablist"
          className="flex gap-2 bg-gray-900 rounded-md border border-gray-800 p-1"
          style={{ alignItems: "stretch" }}
        >
          {tabList.map(({ value, label }) => {
            const active = tab === value
            return (
              <li key={value} role="presentation" className="flex-1">
                <button
                  role="tab"
                  aria-current={active}
                  aria-selected={active}
                  onClick={() => setTab(value)}
                  className={[
                    "w-full h-full text-sm font-medium py-2 px-4 rounded-md transition",
                    active
                      ? "bg-gray-800 text-white ring-1 ring-indigo-500/40 shadow-sm"
                      : "bg-gray-900 text-gray-300 hover:bg-gray-800 hover:text-white",
                  ].join(" ")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span className="leading-tight">{label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Content */}
      <div>{children(tab)}</div>
    </div>
  )
}
