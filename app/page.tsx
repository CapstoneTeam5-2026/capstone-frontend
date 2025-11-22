"use client"

import React from "react"
import TrainTabs from "../src/components/TrainTabs"
import RealTimeLeafletMap from "../src/components/RealTimeLeafletMap"
import HistoryComponent from "../src/components/HistoryComponent"

type TabName = "live" | "history"

const HomePage: React.FC = () => {
  return (
    <main className="p-4" role="main" aria-label="Home — Live and Historical train tracking">
      <div className="max-w-full mx-auto">
        <TrainTabs>
          {(tab: TabName) =>
            tab === "live" ? <RealTimeLeafletMap /> : <HistoryComponent />
          }
        </TrainTabs>
      </div>
    </main>
  )
}

export default HomePage
