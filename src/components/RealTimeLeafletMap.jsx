"use client"

import { useEffect, useMemo, useRef, useState } from "react"



const INDIA_CENTER = [20.5937, 78.9629]
const INDIA_BOUNDS = [
  [6.465, 68.1097],
  [35.5133, 97.3956],
]
const LEAFLET_VERSION = "1.9.4"
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`
const ICON_BASE = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/`

function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t }

export default function RealTimeLeafletMap({ onSelectTrain } = {}) {
  const center = useMemo(() => INDIA_CENTER, [])
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const canvasRendererRef = useRef(null)

  const markersRef = useRef(new Map())
  const pathsRef = useRef(new Map())
  const lastSeenRef = useRef(new Map())
  const pendingRef = useRef(new Map())
  const animationsRef = useRef(new Map())
  const lastSamplesRef = useRef(new Map())
  const speedsRef = useRef(new Map())
  const wsRef = useRef(null)

  const [status, setStatus] = useState("disconnected")
  const [wsUrl, setWsUrl] = useState(null)
  const [selectedTrainId, setSelectedTrainId] = useState(null)

  const MAX_PATH_POINTS = 500
  const MIN_SEGMENT_METERS = 5
  const STALE_MS = 10 * 60 * 1000
  const PROCESS_INTERVAL = 100

  useEffect(() => { if (onSelectTrain) onSelectTrain(selectedTrainId) }, [selectedTrainId, onSelectTrain])

  useEffect(() => {
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link")
      link.id = "leaflet-css"
      link.rel = "stylesheet"
      link.href = LEAFLET_CSS
      document.head.appendChild(link)
    }

    if (typeof window !== "undefined" && window.L) {
      init()
    } else if (!document.getElementById("leaflet-js")) {
      const s = document.createElement("script")
      s.id = "leaflet-js"
      s.src = LEAFLET_JS
      s.async = true
      s.defer = true
      s.onload = init
      s.onerror = () => console.error("Failed to load Leaflet")
      document.body.appendChild(s)
    } else {
      const s = document.getElementById("leaflet-js")
      s?.addEventListener("load", init)
      return () => s?.removeEventListener("load", init)
    }

    function init() {
      if (!containerRef.current || mapRef.current || !window.L) return
      const L = window.L
      if (L?.Icon?.Default) {
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: `${ICON_BASE}marker-icon-2x.png`,
          iconUrl: `${ICON_BASE}marker-icon.png`,
          shadowUrl: `${ICON_BASE}marker-shadow.png`,
        })
      }

      const map = L.map(containerRef.current, {
        center,
        zoom: 5,
        preferCanvas: true,
        minZoom: 3,
        maxZoom: 20,
        zoomSnap: 0.25,
        attributionControl: false,
      })
      mapRef.current = map

      try { canvasRendererRef.current = L.canvas({ padding: 0.5 }) } catch {}
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 }).addTo(map)

      try {
        const bounds = L.latLngBounds(INDIA_BOUNDS)
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6, animate: false })
      } catch {}

      map.on("zoomstart", () => { cancelAllAnimations(); pendingRef.current.clear() })
      map.on("movestart", () => { cancelAllAnimations(); pendingRef.current.clear() })
    }

    return () => {
      try { mapRef.current?.remove() } catch {}
      mapRef.current = null
      markersRef.current.forEach(m => { try { m.remove() } catch {} })
      markersRef.current.clear()
      pathsRef.current.forEach(p => { try { p.polyline.remove() } catch {} })
      pathsRef.current.clear()
    }
  }, [center])

  //websocket
  useEffect(() => {
    let resolved = null
    try {
      resolved = (typeof window !== "undefined" && process.env.NEXT_PUBLIC_WS_URL) || null
      if (!resolved && typeof window !== "undefined") {
        const isDev = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        resolved = isDev ? "ws://localhost:8000" : (window.location.protocol === "https:" ? `wss://${window.location.hostname}:8000` : `ws://${window.location.hostname}:8000`)
      }
    } catch { resolved = "ws://localhost:8000" }
    setWsUrl(resolved)
    window.__WS_RESOLVED__ = resolved

    let ws = null
    let stopped = false
    let reconnectAttempts = 0
    let reconnectTimer = null
    const MAX_BACKOFF = 30000
    const backoff = (a) => Math.min(MAX_BACKOFF, 1000 * Math.pow(1.6, a)) + Math.random() * 300

    let heartbeatTimer = null
    const HEARTBEAT = 15000
    function startHeartbeat() {
      stopHeartbeat()
      heartbeatTimer = setInterval(() => {
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })) } catch {}
      }, HEARTBEAT)
    }
    function stopHeartbeat() { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = null }

    function connect() {
      reconnectAttempts++
      try {
        ws = new WebSocket(resolved)
        wsRef.current = ws
      } catch { scheduleReconnect(); return }
      ws.addEventListener("open", () => { reconnectAttempts = 0; setStatus("connected"); startHeartbeat() })
      ws.addEventListener("message", (ev) => {
        try {
          const data = JSON.parse(ev.data)
          if (data && (data.type === "pong" || data.type === "heartbeat")) return
          const arr = Array.isArray(data) ? data : [data]
          for (const u of arr) {
            if (!u) continue
            const id = u.train_id || u.id
            const lat = typeof u.lat === "number" ? u.lat : undefined
            const lng = typeof u.lon === "number" ? u.lon : (typeof u.lng === "number" ? u.lng : undefined)
            if (!id || typeof lat !== "number" || typeof lng !== "number") continue
            u.__received_ts = Date.now()
            pendingRef.current.set(id, u)
          }
        } catch {}
      })
      ws.addEventListener("close", () => { setStatus("disconnected"); stopHeartbeat(); wsRef.current = null; if (!stopped) scheduleReconnect() })
      ws.addEventListener("error", () => setStatus("disconnected"))
    }

    function scheduleReconnect() {
      if (stopped) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(connect, backoff(reconnectAttempts))
    }

    connect()

    let raf = null
    let last = 0
    function loop(now) {
      if (now - last >= PROCESS_INTERVAL) {
        last = now
        processPending()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      stopped = true
      stopHeartbeat()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch {}
      wsRef.current = null
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  function processPending() {
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return

    const nowTs = Date.now()
    const entries = Array.from(pendingRef.current.entries())
    if (entries.length === 0) {
      for (const [id, last] of lastSeenRef.current.entries()) {
        if (nowTs - last > STALE_MS) removeTrain(id)
      }
      return
    }
    pendingRef.current.clear()

    const updates = entries.map(([_, v]) => v)
    for (const u of updates) {
      const id = u.train_id || u.id
      const lat = u.lat
      const lng = u.lon || u.lng
      const speed = u.speed
      const timestamp = u.timestamp ?? performance.now()

      lastSeenRef.current.set(id, nowTs)
      if (typeof speed === "number" && !Number.isNaN(speed)) speedsRef.current.set(id, speed)

      let marker = markersRef.current.get(id)
      if (!marker) {
        marker = L.circleMarker([lat, lng], {
          radius: 5,
          color: "#16a34a",
          weight: 2,
          fill: true,
          fillColor: "#16a34a",
          fillOpacity: 1,
          renderer: canvasRendererRef.current || undefined,
        }).addTo(map)
        try { marker.on("click", () => setSelectedTrainId(id)) } catch {}
        if (u.popup) try { marker.bindPopup(u.popup) } catch {}

        markersRef.current.set(id, marker)
        ensurePathInitialized(id, [lat, lng])
        lastSamplesRef.current.set(id, { lat, lng, t: timestamp })
      } else {
        if (typeof speed !== "number" || Number.isNaN(speed)) {
          try {
            const prev = lastSamplesRef.current.get(id)
            const now = timestamp
            if (prev) {
              const dist = map.distance(window.L.latLng(prev.lat, prev.lng), window.L.latLng(lat, lng))
              const dt = Math.max(0.001, (now - prev.t) / 1000)
              const kmh = (dist * 3.6) / dt
              speedsRef.current.set(id, kmh)
            }
            lastSamplesRef.current.set(id, { lat, lng, t: now })
          } catch {}
        } else {
          lastSamplesRef.current.set(id, { lat, lng, t: timestamp })
        }

        const cancel = animationsRef.current.get(id)
        if (typeof cancel === "function") try { cancel() } catch {}
        const cur = marker.getLatLng()
        const dLat = Math.abs(cur.lat - lat)
        const dLng = Math.abs(cur.lng - lng)
        const tiny = dLat < 0.00004 && dLng < 0.00004
        if (tiny) {
          marker.setLatLng([lat, lng])
        } else {
          const cancelNew = animateMarker(marker, [lat, lng])
          animationsRef.current.set(id, cancelNew)
        }
        if (u.popup) try { marker.bindPopup(u.popup) } catch {}
        appendToPath(id, [lat, lng])
      }
    }

    for (const [id, last] of lastSeenRef.current.entries()) {
      if (nowTs - last > STALE_MS) removeTrain(id)
    }
  }

  function removeTrain(id) {
    const m = markersRef.current.get(id)
    if (m) { try { m.remove() } catch {} }
    markersRef.current.delete(id)
    const p = pathsRef.current.get(id)
    if (p) { try { p.polyline.remove() } catch {} }
    pathsRef.current.delete(id)
    lastSeenRef.current.delete(id)
    const cancel = animationsRef.current.get(id)
    if (typeof cancel === "function") try { cancel() } catch {}
    animationsRef.current.delete(id)
    speedsRef.current.delete(id)
    lastSamplesRef.current.delete(id)
  }

  function cancelAllAnimations() {
    animationsRef.current.forEach((c) => { if (typeof c === "function") try { c() } catch {} })
    animationsRef.current.clear()
  }

  function ensurePathInitialized(id, latLngArray) {
    const L = window.L
    const map = mapRef.current
    if (!map || !L) return
    if (pathsRef.current.has(id)) return
    const coords = latLngArray.map((p) => L.latLng(p[0], p[1]))
    const polyline = L.polyline(coords, {
      color: "#16a34a",
      weight: 2,
      opacity: 0.8,
      renderer: canvasRendererRef.current || undefined,
    }).addTo(map)
    pathsRef.current.set(id, { polyline, coords })
  }

  function appendToPath(id, latLng) {
    const L = window.L
    const map = mapRef.current
    if (!map || !L) return
    if (!pathsRef.current.has(id)) { ensurePathInitialized(id, [latLng]); return }
    const entry = pathsRef.current.get(id)
    const next = L.latLng(latLng[0], latLng[1])
    const prev = entry.coords[entry.coords.length - 1]
    const distance = map.distance(prev, next)
    if (distance < MIN_SEGMENT_METERS) return
    entry.coords.push(next)
    if (entry.coords.length > MAX_PATH_POINTS) entry.coords.splice(0, entry.coords.length - MAX_PATH_POINTS)
    try { entry.polyline.setLatLngs(entry.coords) } catch { entry.polyline.setLatLngs(entry.coords) }
  }

  function animateMarker(marker, [lat, lng]) {
    const L = window.L
    const start = marker.getLatLng()
    const end = L.latLng(lat, lng)
    const deltaLat = Math.abs(end.lat - start.lat)
    const deltaLng = Math.abs(end.lng - start.lng)
    const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng)
    const duration = Math.min(600, Math.max(150, distance * 6000))
    const t0 = performance.now()
    let raf = null
    function step(now) {
      const elapsed = now - t0
      const t = Math.min(1, elapsed / duration)
      const k = easeInOutQuad(t)
      const latv = start.lat + (end.lat - start.lat) * k
      const lngv = start.lng + (end.lng - start.lng) * k
      marker.setLatLng([latv, lngv])
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }

  const statusDot = status === "connected" ? "bg-green-500" : "bg-red-500"

  // expose selectTrain for debugging
  useEffect(() => {
    if (typeof window === "undefined") return
    window.selectTrain = (id) => setSelectedTrainId(id)
    return () => { try { delete window.selectTrain } catch {} }
  }, [])

  return (
    <section className="rounded-lg border border-gray-700 p-3 bg-gray-900 text-gray-100">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Live Map</h2>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusDot}`} title={status} />
            <span className="text-sm text-gray-400 capitalize">{status}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-3 items-stretch">
        <div className="flex-1 rounded-md overflow-hidden border border-gray-800" style={{ minHeight: 420 }}>
          <div ref={containerRef} className="h-[60vh] lg:h-[80vh] w-full" role="region" aria-label="Real-time train map" />
        </div>

        <aside className="w-full lg:w-80 shrink-0 rounded-md border border-gray-700 p-3 overflow-auto bg-black/20">
          <div className="text-sm">
            <div className="mb-3">Click a train marker to select it.</div>
            <div className="font-semibold mb-2">Selected</div>
            {selectedTrainId ? (
              <>
                <div className="mb-2">Train {selectedTrainId}</div>
                <button className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600" onClick={() => setSelectedTrainId(null)}>Clear</button>
              </>
            ) : (
              <div className="text-gray-400">No train selected</div>
            )}
          </div>
        </aside>
      </div>

      <p className="mt-2 text-xs text-gray-400">WebSocket: {wsUrl ?? "connecting..."}</p>
    </section>
  )
}
