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
  const targetPositionsRef = useRef(new Map())
  const startLocationsRef = useRef(new Map())
  const wsRef = useRef(null)

  const [status, setStatus] = useState("disconnected")
  const [wsUrl, setWsUrl] = useState(null)
  const [selectedTrainId, setSelectedTrainId] = useState(null)
  const [selectedTrainDetails, setSelectedTrainDetails] = useState(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [availableTrainIds, setAvailableTrainIds] = useState([])
  const [currentPlaceName, setCurrentPlaceName] = useState(null)
  const [startPlaceName, setStartPlaceName] = useState(null)
  const geocodingCacheRef = useRef(new Map())

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

      map.on("zoomstart", () => { cancelAllAnimations(true) })
      map.on("movestart", () => { cancelAllAnimations(true) })
      map.on("zoomend", () => { updateMarkerSizes() })
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
        resolved = isDev ? "ws://localhost:8080" : (window.location.protocol === "https:" ? `wss://${window.location.hostname}:8080` : `ws://${window.location.hostname}:8080`)
      }
    } catch { resolved = "ws://localhost:8080" }
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
        const zoom = map.getZoom()
        const baseRadius = 5
        const radius = Math.max(3, Math.min(12, baseRadius + (zoom - 5) * 0.5))
        marker = L.circleMarker([lat, lng], {
          radius,
          color: "#16a34a",
          weight: 2,
          fill: true,
          fillColor: "#16a34a",
          fillOpacity: 1,
          renderer: canvasRendererRef.current || undefined,
        }).addTo(map)
        try { 
          marker.on("click", () => {
            setSelectedTrainId(id)
            // Center on train marker
            setTimeout(() => {
              centerOnTrain(id)
            }, 50)
          })
        } catch {}
        if (u.popup) try { marker.bindPopup(u.popup) } catch {}

        markersRef.current.set(id, marker)
        ensurePathInitialized(id, [[lat, lng]])
        lastSamplesRef.current.set(id, { lat, lng, t: timestamp })
        targetPositionsRef.current.set(id, [lat, lng])
        // Store start location
        if (!startLocationsRef.current.has(id)) {
          startLocationsRef.current.set(id, { lat, lng })
        }
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
        targetPositionsRef.current.set(id, [lat, lng])
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
    targetPositionsRef.current.delete(id)
    startLocationsRef.current.delete(id)
  }

  function cancelAllAnimations(immediate = false) {
    animationsRef.current.forEach((c) => { if (typeof c === "function") try { c() } catch {} })
    animationsRef.current.clear()
    if (immediate) {
      // Set markers to their target positions immediately
      targetPositionsRef.current.forEach(([lat, lng], id) => {
        const marker = markersRef.current.get(id)
        if (marker) {
          try { marker.setLatLng([lat, lng]) } catch {}
        }
      })
    }
  }

  function updateMarkerSizes() {
    const map = mapRef.current
    if (!map) return
    const zoom = map.getZoom()
    const baseRadius = 5
    const radius = Math.max(3, Math.min(12, baseRadius + (zoom - 5) * 0.5))
    markersRef.current.forEach((marker) => {
      try { marker.setRadius(radius) } catch {}
    })
  }

  function ensurePathInitialized(id, latLngArray) {
    const L = window.L
    const map = mapRef.current
    if (!map || !L) return
    if (pathsRef.current.has(id)) return
    const coords = latLngArray.map((p) => L.latLng(p[0], p[1]))
    // Need at least 2 points for a visible line
    if (coords.length < 2) {
      // Duplicate the point to create a visible segment
      coords.push(L.latLng(coords[0].lat, coords[0].lng))
    }
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
    if (!pathsRef.current.has(id)) { 
      ensurePathInitialized(id, [[latLng[0], latLng[1]]])
      return 
    }
    const entry = pathsRef.current.get(id)
    if (!entry || !entry.coords || entry.coords.length === 0) {
      ensurePathInitialized(id, [[latLng[0], latLng[1]]])
      return
    }
    const next = L.latLng(latLng[0], latLng[1])
    const prev = entry.coords[entry.coords.length - 1]
    const distance = map.distance(prev, next)
    if (distance < MIN_SEGMENT_METERS) return
    entry.coords.push(next)
    if (entry.coords.length > MAX_PATH_POINTS) entry.coords.splice(0, entry.coords.length - MAX_PATH_POINTS)
    try { 
      entry.polyline.setLatLngs(entry.coords) 
      entry.polyline.redraw()
    } catch (e) { 
      try { entry.polyline.setLatLngs(entry.coords) } catch {}
    }
  }

  function animateMarker(marker, [lat, lng]) {
    const L = window.L
    const start = marker.getLatLng()
    const end = L.latLng(lat, lng)
    const deltaLat = Math.abs(end.lat - start.lat)
    const deltaLng = Math.abs(end.lng - start.lng)
    const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng)
    // Cap duration to prevent very long animations
    const duration = Math.min(1000, Math.max(100, distance * 4000))
    const t0 = performance.now()
    let raf = null
    let cancelled = false
    function step(now) {
      if (cancelled) return
      const elapsed = now - t0
      const t = Math.min(1, elapsed / duration)
      const k = easeInOutQuad(t)
      const latv = start.lat + (end.lat - start.lat) * k
      const lngv = start.lng + (end.lng - start.lng) * k
      try {
        marker.setLatLng([latv, lngv])
      } catch {}
      if (t < 1 && !cancelled) {
        raf = requestAnimationFrame(step)
      } else if (t >= 1) {
        // Ensure final position is set
        try { marker.setLatLng([lat, lng]) } catch {}
      }
    }
    raf = requestAnimationFrame(step)
    return () => { 
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
    }
  }

  const statusDot = status === "connected" ? "bg-green-500" : "bg-red-500"

  // Helper function to center map on a train marker
  function centerOnTrain(trainId) {
    const map = mapRef.current
    if (!map || !window.L || !trainId) return
    
    // Try to get the marker's current position first (most accurate)
    const marker = markersRef.current.get(trainId)
    let pos = null
    
    if (marker) {
      try {
        const latLng = marker.getLatLng()
        if (latLng && typeof latLng.lat === 'number' && typeof latLng.lng === 'number') {
          pos = [latLng.lat, latLng.lng]
        }
      } catch {}
    }
    
    // Fallback to target position if marker position not available
    if (!pos) {
      pos = targetPositionsRef.current.get(trainId)
    }
    
    // Validate position before centering
    if (pos && Array.isArray(pos) && pos.length >= 2 && 
        typeof pos[0] === 'number' && typeof pos[1] === 'number' &&
        !isNaN(pos[0]) && !isNaN(pos[1]) &&
        pos[0] >= -90 && pos[0] <= 90 && pos[1] >= -180 && pos[1] <= 180) {
      try {
        const currentZoom = map.getZoom()
        const targetZoom = Math.max(currentZoom, 12)
        // Center the map on the marker position
        map.setView([pos[0], pos[1]], targetZoom, { animate: true, duration: 0.5 })
      } catch {}
    }
  }

  // Update selected train details and center on train when selected
  useEffect(() => {
    if (!selectedTrainId) {
      setSelectedTrainDetails(null)
      setCurrentPlaceName(null)
      setStartPlaceName(null)
      return
    }
    
    // Center on selected train marker with retry mechanism
    let attempts = 0
    const maxAttempts = 5
    const tryCenter = () => {
      attempts++
      const marker = markersRef.current.get(selectedTrainId)
      const pos = targetPositionsRef.current.get(selectedTrainId)
      
      if (marker || pos) {
        centerOnTrain(selectedTrainId)
      } else if (attempts < maxAttempts) {
        setTimeout(tryCenter, 150)
      }
    }
    setTimeout(tryCenter, 200)
    
    let lastCurrentPos = null
    let lastStartLoc = null
    let geocodeTimeout = null
    
    async function fetchCityNames(currentPosData, startLoc) {
      // Fetch current position city name
      if (currentPosData && (!lastCurrentPos || 
          Math.abs(currentPosData.lat - lastCurrentPos.lat) > 0.01 || 
          Math.abs(currentPosData.lng - lastCurrentPos.lng) > 0.01)) {
        const cityName = await getPlaceName(currentPosData.lat, currentPosData.lng)
        if (cityName) setCurrentPlaceName(cityName)
        lastCurrentPos = currentPosData
      }
      
      // Fetch start location city name
      if (startLoc && (!lastStartLoc || 
          Math.abs(startLoc.lat - lastStartLoc.lat) > 0.01 || 
          Math.abs(startLoc.lng - lastStartLoc.lng) > 0.01)) {
        const cityName = await getPlaceName(startLoc.lat, startLoc.lng)
        if (cityName) setStartPlaceName(cityName)
        lastStartLoc = startLoc
      }
    }
    
    function updateDetails() {
      const marker = markersRef.current.get(selectedTrainId)
      const speed = speedsRef.current.get(selectedTrainId)
      const targetPos = targetPositionsRef.current.get(selectedTrainId)
      const startLoc = startLocationsRef.current.get(selectedTrainId)
      const currentPos = marker ? marker.getLatLng() : null
      
      const currentPosData = currentPos ? { lat: currentPos.lat, lng: currentPos.lng } : (targetPos ? { lat: targetPos[0], lng: targetPos[1] } : null)
      
      setSelectedTrainDetails({
        currentPos: currentPosData,
        speed,
        startLoc,
      })
      
      // Fetch place names when coordinates change (with debouncing for updates)
      if (geocodeTimeout) clearTimeout(geocodeTimeout)
      geocodeTimeout = setTimeout(() => {
        fetchCityNames(currentPosData, startLoc)
      }, 2000) // Debounce geocoding by 2 seconds for updates
    }
    
    // Initial fetch of city names immediately when train is selected
    const marker = markersRef.current.get(selectedTrainId)
    const targetPos = targetPositionsRef.current.get(selectedTrainId)
    const startLoc = startLocationsRef.current.get(selectedTrainId)
    const currentPos = marker ? marker.getLatLng() : null
    const currentPosData = currentPos ? { lat: currentPos.lat, lng: currentPos.lng } : (targetPos ? { lat: targetPos[0], lng: targetPos[1] } : null)
    
    // Fetch city names immediately
    fetchCityNames(currentPosData, startLoc)
    
    updateDetails()
    const interval = setInterval(updateDetails, 500)
    return () => {
      clearInterval(interval)
      if (geocodeTimeout) clearTimeout(geocodeTimeout)
    }
  }, [selectedTrainId])

  // expose selectTrain for debugging
  useEffect(() => {
    if (typeof window === "undefined") return
    window.selectTrain = (id) => setSelectedTrainId(id)
    return () => { try { delete window.selectTrain } catch {} }
  }, [])

  // Update available train IDs for search
  useEffect(() => {
    const interval = setInterval(() => {
      const trainIds = Array.from(markersRef.current.keys())
      setAvailableTrainIds(trainIds.sort())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Function to select train from search
  function selectTrainFromSearch(trainId) {
    setSelectedTrainId(trainId)
    setSearchQuery("")
    
    // Force centering with multiple attempts to ensure it works
    // First attempt immediately after state update
    requestAnimationFrame(() => {
      setTimeout(() => {
        centerOnTrain(trainId)
        
        // Retry a few times in case marker isn't ready yet
        let attempts = 0
        const maxAttempts = 3
        const retryInterval = setInterval(() => {
          attempts++
          const marker = markersRef.current.get(trainId)
          const pos = targetPositionsRef.current.get(trainId)
          
          if (marker || pos) {
            centerOnTrain(trainId)
            clearInterval(retryInterval)
          } else if (attempts >= maxAttempts) {
            clearInterval(retryInterval)
          }
        }, 200)
      }, 100)
    })
  }

  // Reverse geocoding function to get city name from coordinates
  async function getPlaceName(lat, lng) {
    if (!lat || !lng) return null
    
    // Round to 4 decimal places for caching (about 11 meters precision)
    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`
    if (geocodingCacheRef.current.has(cacheKey)) {
      return geocodingCacheRef.current.get(cacheKey)
    }

    try {
      // Use Nominatim reverse geocoding API (free, no API key required)
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`,
        {
          headers: {
            'User-Agent': 'TrainTracker/1.0' // Required by Nominatim
          }
        }
      )
      
      if (!response.ok) return null
      
      const data = await response.json()
      let cityName = null
      
      if (data.address) {
        // Prioritize city name, with fallbacks
        cityName = data.address.city || 
                   data.address.town || 
                   data.address.municipality ||
                   data.address.village || 
                   data.address.county || 
                   data.address.state_district ||
                   data.address.state
      }
      
      // If no city found in address, try to extract from display_name
      if (!cityName && data.display_name) {
        // display_name format is usually: "Name, City, State, Country"
        const parts = data.display_name.split(',').map(s => s.trim())
        // Usually city is the second part, but try to find it
        for (let i = 0; i < Math.min(parts.length, 3); i++) {
          if (parts[i] && !parts[i].match(/^\d+$/) && parts[i].length > 2) {
            cityName = parts[i]
            break
          }
        }
      }
      
      if (cityName) {
        geocodingCacheRef.current.set(cacheKey, cityName)
        // Limit cache size to prevent memory issues
        if (geocodingCacheRef.current.size > 100) {
          const firstKey = geocodingCacheRef.current.keys().next().value
          geocodingCacheRef.current.delete(firstKey)
        }
      }
      
      return cityName
    } catch (error) {
      console.error('Reverse geocoding error:', error)
      return null
    }
  }

  // Escape key handler to zoom out to default view and unselect train
  useEffect(() => {
    function handleEscape(e) {
      // Only handle if not typing in an input
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return
      if (e.key === "Escape" || e.keyCode === 27) {
        // Unselect train
        setSelectedTrainId(null)
        
        // Reset zoom to default view
        const map = mapRef.current
        if (map && window.L) {
          try {
            const bounds = window.L.latLngBounds(INDIA_BOUNDS)
            map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6, animate: true })
            e.preventDefault()
          } catch {}
        }
      }
    }
    document.addEventListener("keydown", handleEscape)
    return () => document.removeEventListener("keydown", handleEscape)
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
            <div className="mb-3">
              <label className="block text-xs text-gray-400 mb-1.5">Search Train</label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Type train ID..."
                className="w-full px-2.5 py-1.5 bg-gray-800 border border-gray-600 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500"
              />
              {searchQuery && (
                <div className="mt-2 max-h-48 overflow-y-auto border border-gray-700 rounded bg-gray-900">
                  {availableTrainIds
                    .filter(id => id.toLowerCase().includes(searchQuery.toLowerCase()))
                    .slice(0, 10)
                    .map(id => (
                      <button
                        key={id}
                        onClick={() => selectTrainFromSearch(id)}
                        className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-gray-800 transition-colors border-b border-gray-800 last:border-b-0"
                      >
                        🚆 {id}
                      </button>
                    ))}
                  {availableTrainIds.filter(id => id.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 && (
                    <div className="px-2.5 py-1.5 text-xs text-gray-500">No trains found</div>
                  )}
                </div>
              )}
            </div>
            <div className="font-semibold mb-2">Selected Train</div>
            {selectedTrainId ? (
              <>
                <div className="mb-3 space-y-2">
                  <div className="font-medium text-base">🚆 {selectedTrainId}</div>
                  
                  {selectedTrainDetails && (
                    <div className="space-y-2 text-xs">
                      {selectedTrainDetails.currentPos && (
                        <div className="border-t border-gray-700 pt-2">
                          <div className="text-gray-400 mb-1.5">Current Location</div>
                          {currentPlaceName ? (
                            <div className="text-green-400 font-semibold text-sm mb-2">🏙️ {currentPlaceName}</div>
                          ) : (
                            <div className="text-gray-500 text-xs mb-2 italic">Loading city name...</div>
                          )}
                          <div className="font-mono text-gray-300 text-xs">
                            <div>Lat: {selectedTrainDetails.currentPos.lat.toFixed(6)}</div>
                            <div>Lng: {selectedTrainDetails.currentPos.lng.toFixed(6)}</div>
                          </div>
                        </div>
                      )}
                      
                      {selectedTrainDetails.speed !== undefined && (
                        <div className="border-t border-gray-700 pt-2">
                          <div className="text-gray-400 mb-1">Speed</div>
                          <div className="text-gray-300 font-medium">{selectedTrainDetails.speed.toFixed(1)} km/h</div>
                        </div>
                      )}
                      
                      {selectedTrainDetails.startLoc && (
                        <div className="border-t border-gray-700 pt-2">
                          <div className="text-gray-400 mb-1.5">Start Location</div>
                          {startPlaceName ? (
                            <div className="text-blue-400 font-semibold text-sm mb-2">🏙️ {startPlaceName}</div>
                          ) : (
                            <div className="text-gray-500 text-xs mb-2 italic">Loading city name...</div>
                          )}
                          <div className="font-mono text-gray-300 text-xs">
                            <div>Lat: {selectedTrainDetails.startLoc.lat.toFixed(6)}</div>
                            <div>Lng: {selectedTrainDetails.startLoc.lng.toFixed(6)}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                <button 
                  className="rounded bg-gray-700 px-3 py-1.5 text-xs hover:bg-gray-600 transition-colors" 
                  onClick={() => setSelectedTrainId(null)}
                >
                  Clear Selection
                </button>
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
