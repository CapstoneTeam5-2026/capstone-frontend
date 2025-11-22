"use client"

import { useEffect, useRef, useState } from "react"

export default function HistoryComponent() {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const polyRef = useRef(null)
  const stopsLayerRef = useRef(null)

  const [trainId, setTrainId] = useState("")
  const [fromIso, setFromIso] = useState("")
  const [toIso, setToIso] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [infoText, setInfoText] = useState("Enter train id + optional range, then Load.")
  const [leafletLoaded, setLeafletLoaded] = useState(typeof window !== "undefined" && !!window.L)

  useEffect(() => {
    if (!containerRef.current) return
    if (!window.L) return
    const L = window.L
    // Initialize map centered on India (coordinates: latitude 20.5937, longitude 78.9629)
    const map = L.map(containerRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      preferCanvas: true,
      keyboard: true,
      zoomControl: true,
    })
    mapRef.current = map
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 }).addTo(map)
    stopsLayerRef.current = L.layerGroup().addTo(map)
    setLeafletLoaded(true)
    return () => { try { map.remove() } catch {} }
  }, [leafletLoaded])

  // --- API call (placeholder) ---
  async function fetchHistory(id, from, to) {
    setLoading(true)
    setError(null)
    setInfoText("Loading history…")
    try {
      const q = new URLSearchParams()
      q.set("train_id", id)
      if (from) q.set("from", from)
      if (to) q.set("to", to)

      const res = await fetch(`/api/history?${q.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const arr = await res.json()
      // API returns array of location points: [{ lat, lng, timestamp(ms), speed? }, ...] in chronological order
      if (!Array.isArray(arr) || arr.length === 0) {
        setInfoText("No history points found for this query.")
        renderHistory([])
      } else {
        setInfoText(`Loaded ${arr.length} points`)
        renderHistory(arr)
      }
    } catch (err) {
      setError(err.message || "Failed to fetch history")
      setInfoText("Failed to load history")
    } finally {
      setLoading(false)
    }
  }

  /**
   * Detects where the train stopped by analyzing movement patterns.
   * A stop is detected when the train stays in roughly the same location
   * (moves less than 20 meters) for at least 5 minutes, or moves slower than 0.5 km/h.
   */
  function detectStops(points) {
    const STOP_SECONDS = 300
    const MAX_SPEED = 0.5
    const MIN_MOVED_METERS = 20
    const stops = []
    let windowStart = 0
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const cur = points[i]
      const sp = typeof cur.speed === "number" ? cur.speed : undefined
      const dist = distanceMeters(prev.lat, prev.lng, cur.lat, cur.lng)

      // If train is moving (speed > threshold OR distance moved > threshold), reset the stop detection window
      if ((sp !== undefined && sp > MAX_SPEED) || dist > MIN_MOVED_METERS) {
        windowStart = i
        continue
      }

      // Calculate how long the train has been stationary (from windowStart to current point)
      const dur = (cur.timestamp - points[windowStart].timestamp) / 1000
      if (dur >= STOP_SECONDS) {
        // Use the middle point of the stop period as the stop location
        const mid = Math.floor((windowStart + i) / 2)
        stops.push({
          lat: points[mid].lat,
          lng: points[mid].lng,
          from: points[windowStart].timestamp,
          to: cur.timestamp,
        })
        windowStart = i + 1
      }
    }
    return stops
  }

  /**
   * Calculates the distance between two geographic coordinates using the Haversine formula.
   * Returns distance in meters. This accounts for Earth's curvature, not just flat distance.
   */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000
    const toRad = (d) => (d * Math.PI) / 180
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  function renderHistory(points) {
    if (!window.L || !mapRef.current) return
    const L = window.L
    const map = mapRef.current

    if (polyRef.current) {
      try { polyRef.current.remove() } catch {}
      polyRef.current = null
    }
    if (stopsLayerRef.current) {
      try { stopsLayerRef.current.clearLayers() } catch {}
    }

    if (!points || points.length === 0) {
      map.setView([20.5937, 78.9629], 5)
      return
    }

    const latlngs = points.map((p) => [p.lat, p.lng])
    polyRef.current = L.polyline(latlngs, { color: "#60a5fa", weight: 3, opacity: 0.95 }).addTo(map)

    const stops = detectStops(points)
    for (const s of stops) {
      const c = L.circleMarker([s.lat, s.lng], {
        radius: 5,
        color: "#f59e0b",
        fillColor: "#f59e0b",
        fillOpacity: 1,
        weight: 1,
      }).addTo(stopsLayerRef.current)
      c.bindPopup(`Stop: ${new Date(s.from).toLocaleString()} ↔ ${new Date(s.to).toLocaleString()}`)
    }

    if (stops.length > 0) {
      const last = stops[stops.length - 1]
      L.marker([last.lat, last.lng], { title: "Last halt" }).addTo(stopsLayerRef.current).bindPopup("Last significant halt")
    }

    try {
      const bounds = polyRef.current.getBounds()
      map.fitBounds(bounds, { padding: [24, 24] })
    } catch {}
  }

  function setRangeHours(hours) {
    const now = new Date()
    const from = new Date(now.getTime() - hours * 3600 * 1000)
    setFromIso(toInputLocal(from))
    setToIso(toInputLocal(now))
  }

  /**
   * Converts a date to the format needed for datetime-local input fields.
   * Handles timezone conversion so the displayed time matches the user's local timezone.
   */
  function toInputLocal(date) {
    const tzOffset = date.getTimezoneOffset() * 60000
    const local = new Date(date.getTime() - tzOffset)
    return local.toISOString().slice(0, 16)
  }
  return (
    <section className="rounded-lg border border-gray-700 p-4 bg-gray-900 text-gray-100">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Historical Tracking</h2>
          <p className="text-xs text-gray-400 mt-1">Search by Train ID and view the path.</p>
        </div>
      </div>

      <form
        className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!trainId) return setError("Train ID required")
          fetchHistory(trainId, fromIso, toIso)
        }}
        aria-label="History search"
      >
        <div className="sm:col-span-5">
          <label className="sr-only" htmlFor="trainId">Train ID</label>
          <input
            id="trainId"
            value={trainId}
            onChange={(e) => { setTrainId(e.target.value); setError(null) }}
            placeholder="Train ID (e.g., TR1234)"
            className="w-full px-3 py-2 bg-transparent border border-gray-700 rounded text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            inputMode="text"
            aria-required
          />
        </div>

        <div className="sm:col-span-3">
          <label className="sr-only" htmlFor="from">From</label>
          <input
            id="from"
            type="datetime-local"
            value={fromIso}
            onChange={(e) => setFromIso(e.target.value)}
            className="w-full px-3 py-2 bg-transparent border border-gray-700 rounded text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="sm:col-span-3">
          <label className="sr-only" htmlFor="to">To</label>
          <input
            id="to"
            type="datetime-local"
            value={toIso}
            onChange={(e) => setToIso(e.target.value)}
            className="w-full px-3 py-2 bg-transparent border border-gray-700 rounded text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="sm:col-span-1 flex gap-2">
          <button
            type="submit"
            disabled={!trainId || loading}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded text-sm font-medium"
            aria-disabled={!trainId || loading}
          >
            {loading ? "Loading…" : "Load"}
          </button>
          <button
            type="button"
            onClick={() => {
              setTrainId("")
              setFromIso("")
              setToIso("")
              setError(null)
              setInfoText("Enter train id + optional range, then Load.")
              if (polyRef.current) try { polyRef.current.remove() } catch {}
              if (stopsLayerRef.current) try { stopsLayerRef.current.clearLayers() } catch {}
              if (mapRef.current) try { mapRef.current.setView([20.5937, 78.9629], 5) } catch {}
            }}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm font-medium border border-gray-700"
          >
            Reset
          </button>
        </div>
      </form>

      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>Quick ranges:</span>
          <button onClick={() => setRangeHours(1)} className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700">1h</button>
          <button onClick={() => setRangeHours(6)} className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700">6h</button>
          <button onClick={() => setRangeHours(24)} className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700">24h</button>
        </div>

        <div className="text-xs text-gray-400">
          {error ? <span className="text-rose-400">Error: {error}</span> : <span>{infoText}</span>}
        </div>
      </div>

      <div className="h-[60vh] sm:h-[70vh] rounded-md overflow-hidden bg-black/10 border border-gray-800">
        {!leafletLoaded ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-sm text-gray-400">Leaflet not loaded. Open the Live tab first or include Leaflet in your page.</div>
          </div>
        ) : (
          <div ref={containerRef} className="h-full w-full" role="region" aria-label="Historical train map" />
        )}
      </div>

      <div className="mt-3 text-xs text-gray-400">
        <div>Stops detection: speed ≤ 0.5 km/h or unchanged position for ≥ 5 minutes (default).</div>
        <div className="mt-1">Expected history API response: <code className="text-xs bg-gray-800 px-1 py-0.5 rounded">[{`{ lat, lng, timestamp(ms), speed? }`}]</code> ordered ascending by timestamp.</div>
      </div>
    </section>
  )
}
