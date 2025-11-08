"use client"

import { useEffect, useMemo, useRef, useState } from "react"

/**
 * @typedef {{ id: string, lat: number, lng: number, popup?: string }} TrainUpdate
 */

const INDIA_CENTER = [20.5937, 78.9629]
const INDIA_BOUNDS = [
  [6.465, 68.1097],   // SW
  [35.5133, 97.3956], // NE
]
const LEAFLET_CSS_ID = "leaflet-css"
const LEAFLET_JS_ID = "leaflet-js"
const LEAFLET_VERSION = "1.9.4"
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`
const ICON_BASE = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/`

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export default function RealTimeLeafletMap() {
  const center = useMemo(() => INDIA_CENTER, [])
  const [status, setStatus] = useState("disconnected")
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())
  const animationsRef = useRef(new Map())
  const pathsRef = useRef(new Map()) // id -> { polyline, coords: L.LatLng[] }
  const MAX_PATH_POINTS = 500
  const MIN_SEGMENT_METERS = 5
  const isZoomingRef = useRef(false)
  const FOLLOW_PADDING_PX = 100
  const canvasRendererRef = useRef(null)
  const wsRef = useRef(null)
  const [selectedTrainId, setSelectedTrainId] = useState(null)
  const selectedTrainIdRef = useRef(null)
  useEffect(() => { selectedTrainIdRef.current = selectedTrainId }, [selectedTrainId])
  const startPositionsRef = useRef(new Map())
  const lastSamplesRef = useRef(new Map())
  const speedsRef = useRef(new Map())
  const geocodeCacheRef = useRef(new Map())
  const geocodePendingRef = useRef(new Map())
  const [infoTick, setInfoTick] = useState(0)
  const [geoTick, setGeoTick] = useState(0)
  const [wsUrl, setWsUrl] = useState(null)

  useEffect(() => {
    if (!document.getElementById(LEAFLET_CSS_ID)) {
      const link = document.createElement("link")
      link.id = LEAFLET_CSS_ID
      link.rel = "stylesheet"
      link.href = LEAFLET_CSS
      document.head.appendChild(link)
    }

    if (typeof window !== "undefined" && window.L) {
      initMap()
    } else if (!document.getElementById(LEAFLET_JS_ID)) {
      const script = document.createElement("script")
      script.id = LEAFLET_JS_ID
      script.src = LEAFLET_JS
      script.async = true
      script.defer = true
      script.onload = () => initMap()
      script.onerror = () => {
        console.error("Failed to load Leaflet from CDN")
      }
      document.body.appendChild(script)
    } else {
      const script = document.getElementById(LEAFLET_JS_ID)
      script?.addEventListener("load", initMap)
      return () => script?.removeEventListener("load", initMap)
    }

    function initMap() {
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
        zoomAnimation: false,
        fadeAnimation: false,
        preferCanvas: true,
        minZoom: 3,
        maxZoom: 20,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        zoomSnap: 0.25,
        wheelDebounceTime: 20,
        wheelPxPerZoomLevel: 80,
      })
      mapRef.current = map

      try {
        canvasRendererRef.current = L.canvas({ padding: 0.5 })
      } catch {}

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 20,
      }).addTo(map)

      try {
        const bounds = L.latLngBounds(INDIA_BOUNDS)
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6, animate: false })
      } catch {}

      map.on("zoomstart", () => {
        isZoomingRef.current = true
        animationsRef.current.forEach((cancel) => {
          if (typeof cancel === "function") {
            try { cancel() } catch {}
          }
        })
        animationsRef.current.clear()
      })

      map.on("zoomend", () => {
        isZoomingRef.current = false
        // click center event
        try {
          const selId = selectedTrainIdRef.current
          if (selId) {
            const m = markersRef.current.get(selId)
            if (m) {
              const target = m.getLatLng()
              ensureWithinViewport(map, target, FOLLOW_PADDING_PX)
            }
          }
          nudgeMap(map)
        } catch {}
      })
    }

    return () => {
      if (mapRef.current) {
        try {
          mapRef.current.remove()
        } catch {}
        mapRef.current = null
      }
      markersRef.current.forEach((m) => {
        try {
          m.remove()
        } catch {}
      })
      markersRef.current.clear()
      pathsRef.current.forEach(({ polyline }) => {
        try {
          polyline.remove()
        } catch {}
      })
      pathsRef.current.clear()
    }
  }, [center])

  useEffect(() => {
    const rawEnv =
      typeof window !== "undefined"
        ? process.env.NEXT_PUBLIC_WS_URL ?? null
        : process.env?.NEXT_PUBLIC_WS_URL ?? null;
  
    let resolvedUrl = "";
  
    if (rawEnv) {
      try {
        const u = new URL(rawEnv, window?.location?.href ?? undefined);
        resolvedUrl = u.toString();
      } catch {
        resolvedUrl = rawEnv;
      }
    } else if (typeof window !== "undefined" && window.location) {

      const isDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
      if (isDev) {
        resolvedUrl = "ws://139.59.12.175:8000";
      } else {
        const loc = window.location;
        const proto = loc.protocol === "https:" ? "wss:" : "ws:";
        resolvedUrl = `${proto}//${loc.hostname}:8000`;
      }
    } else {
      // Fallback to local backend
      resolvedUrl = "ws://139.59.12.175:8000";
    }
  
    try {
      // expose for debugging in dev
      window.__WS_RESOLVED__ = resolvedUrl;
      // Set the WebSocket URL for display (client-side only)
      setWsUrl(resolvedUrl);
    } catch {}
  
    let ws = null;
    let shouldStop = false;
    let reconnectAttempts = 0;
    const MAX_BACKOFF = 30000;
  
    const makeBackoff = (attempt) => {
      const base = Math.min(MAX_BACKOFF, 1000 * Math.pow(1.6, attempt));
      const jitter = Math.random() * 300;
      return Math.floor(base + jitter);
    };
  
    // Heartbeat setup
    let lastPongTs = Date.now();
    const HEARTBEAT_INTERVAL = 15000;
    let heartbeatTimer = null;
  
    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
            if (Date.now() - lastPongTs > HEARTBEAT_INTERVAL * 3) {
              try {
                ws.close();
              } catch {}
            }
          }
        } catch {}
      }, HEARTBEAT_INTERVAL);
    }
  
    function stopHeartbeat() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  
    function connect() {
      reconnectAttempts++;
      try {
        ws = new WebSocket(resolvedUrl);
        wsRef.current = ws;
      } catch (e) {
        scheduleReconnect();
        return;
      }
  
      ws.addEventListener("open", () => {
        reconnectAttempts = 0;
        setStatus("connected");
        lastPongTs = Date.now();
        startHeartbeat();
      });
  
      ws.addEventListener("message", (event) => {
        // parse once
        let parsed = null;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          parsed = null;
        }
  
        // heartbeat/pong handling
        if (parsed && (parsed.type === "pong" || parsed.type === "heartbeat")) {
          lastPongTs = Date.now();
          return;
        }

        // normal updates
        try {
          const data = parsed ?? JSON.parse(event.data);
          const updates = Array.isArray(data) ? data : [data];
          applyUpdates(updates);
        } catch {
          console.warn("WS received non-JSON message:", event.data);
        }
      });
  
      ws.addEventListener("close", () => {
        setStatus("disconnected");
        stopHeartbeat();
        wsRef.current = null;
        if (!shouldStop) scheduleReconnect();
      });
  
      ws.addEventListener("error", () => {
        setStatus("disconnected");
      });
    }
  
    let reconnectTimer = null;
    function scheduleReconnect() {
      if (shouldStop) return;
      const backoff = makeBackoff(reconnectAttempts);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(), backoff);
    }
  
    connect();
  
    // Cleanup on unmount
    return () => {
      shouldStop = true;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);
  
  

  function applyUpdates(updates) {
    const L = window.L
    if (!L || !mapRef.current) return

    for (const u of updates) {
      if (!u || typeof u !== "object") continue
      
      // Map backend format to frontend format
      // Backend sends: train_id, lat, lon, speed, timestamp
      // Frontend expects: id, lat, lng, popup
      const id = u.train_id || u.id
      const lat = u.lat
      const lng = u.lon || u.lng
      const speed = u.speed
      const timestamp = u.timestamp
      const popup = u.popup
      
      if (!id) continue
      if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) continue
      
      // Use backend speed if available
      if (typeof speed === "number" && !Number.isNaN(speed)) {
        speedsRef.current.set(id, speed)
      }

      const existing = markersRef.current.get(id)
      if (!existing) {
        const m = L.circleMarker([lat, lng], {
          radius: 5,
          color: "#16a34a",
          weight: 2,
          fill: true,
          fillColor: "#16a34a",
          fillOpacity: 1,
          updateWhenZooming: true,
          updateWhenDragging: true,
          renderer: canvasRendererRef.current || undefined,
        }).addTo(mapRef.current)
        try {
          m.on("click", () => {
            setSelectedTrainId(id)
          })
        } catch {}
        if (popup) { try { m.bindPopup(popup) } catch {} }
        markersRef.current.set(id, m)
        ensurePathInitialized(id, [lat, lng])
        try {
          if (!startPositionsRef.current.has(id)) {
            startPositionsRef.current.set(id, L.latLng(lat, lng))
          }
        } catch {}
        try {
          // Use timestamp from backend if available, otherwise use performance.now()
          const t = timestamp ? timestamp : performance.now()
          lastSamplesRef.current.set(id, { lat, lng, t })
        } catch {}
      } else {
        try {
          // If speed wasn't provided by backend, calculate from position changes
          if (typeof speed !== "number" || Number.isNaN(speed)) {
            const now = timestamp ? timestamp : performance.now()
            const prev = lastSamplesRef.current.get(id)
            if (prev && mapRef.current) {
              const dist = mapRef.current.distance(L.latLng(prev.lat, prev.lng), L.latLng(lat, lng))
              const dt = Math.max(0.001, (now - prev.t) / 1000)
              const speedKmh = (dist * 3.6) / dt
              speedsRef.current.set(id, speedKmh)
            }
          }
          // Use timestamp from backend if available, otherwise use performance.now()
          const t = timestamp ? timestamp : performance.now()
          lastSamplesRef.current.set(id, { lat, lng, t })
        } catch {}
        try {
          if (!startPositionsRef.current.has(id)) {
            startPositionsRef.current.set(id, L.latLng(lat, lng))
          }
        } catch {}
        const cancel = animationsRef.current.get(id)
        if (typeof cancel === "function") {
          try { cancel() } catch {}
        }
        const current = existing.getLatLng()
        const dLat = Math.abs(current.lat - lat)
        const dLng = Math.abs(current.lng - lng)
        const tinyMove = dLat < 0.00005 && dLng < 0.00005
        if (tinyMove || isZoomingRef.current) {
          existing.setLatLng([lat, lng])
        } else {
          const cancelNew = animateMarker(existing, [lat, lng])
          animationsRef.current.set(id, cancelNew)
        }
        if (popup) { try { existing.bindPopup(popup) } catch {} }
        appendToPath(id, [lat, lng])

        // click center event
        if (selectedTrainIdRef.current === id && !isZoomingRef.current) {
          try {
            const map = mapRef.current
            if (map) {
              const target = window.L.latLng(lat, lng)
              const needsPan = !isPointWithinViewport(map, target, FOLLOW_PADDING_PX)
              if (needsPan) {
                map.panTo(target, { animate: true, duration: 0.25, easeLinearity: 0.2, noMoveStart: true })
              }
              setInfoTick((n) => n + 1)
            }
          } catch {}
        }
      }
    }
  }

  function animateMarker(marker, targetLatLng) {
    const L = window.L
    const startLatLng = marker.getLatLng()
    const endLatLng = L.latLng(targetLatLng[0], targetLatLng[1])
    const deltaLat = Math.abs(endLatLng.lat - startLatLng.lat)
    const deltaLng = Math.abs(endLatLng.lng - startLatLng.lng)
    const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng)
    const duration = Math.min(1000, Math.max(200, distance * 6000))
    const start = performance.now()

    let rafId = null
    const step = (now) => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / duration)
      const k = easeInOutQuad(t)
      const lat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * k
      const lng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * k
      marker.setLatLng([lat, lng])
      if (t < 1) {
        rafId = requestAnimationFrame(step)
      }
    }
    rafId = requestAnimationFrame(step)
    return () => rafId && cancelAnimationFrame(rafId)
  }

  // click center event
  useEffect(() => {
    if (!selectedTrainId || !mapRef.current) return
    const marker = markersRef.current.get(selectedTrainId)
    if (!marker) return
    const target = marker.getLatLng()
    const map = mapRef.current
    const desiredZoom = Math.min(map.getMaxZoom(), Math.max(7, map.getZoom() + 2))
    try {
      map.setView(target, desiredZoom, { animate: false })
    } catch {}
  }, [selectedTrainId])

  // select train by id
  useEffect(() => {
    if (typeof window === "undefined") return
    window.selectTrain = (id) => setSelectedTrainId(id)
    return () => { try { delete window.selectTrain } catch {} }
  }, [])

  // reset to india on escape key
  useEffect(() => {
    function resetToIndia() {
      const map = mapRef.current
      if (!map || !window.L) return
      try {
        const bounds = window.L.latLngBounds(INDIA_BOUNDS)
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6, animate: false })
        setSelectedTrainId(null)
      } catch {}
    }
    function onKey(e) {
      const key = e.key || e.code
      if (key === "Escape" || key === "Esc") {
        e.preventDefault?.()
        resetToIndia()
      }
    }
    const node = containerRef.current
    window.addEventListener("keydown", onKey, true)
    document.addEventListener("keydown", onKey, true)
    node?.addEventListener?.("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      document.removeEventListener("keydown", onKey, true)
      node?.removeEventListener?.("keydown", onKey, true)
    }
  }, [])

  function ensurePathInitialized(id, latLngArray) {
    const L = window.L
    if (!mapRef.current) return
    if (pathsRef.current.has(id)) return
    const coords = latLngArray.map((p) => L.latLng(p[0], p[1]))
    const polyline = L.polyline(coords, {
      color: "#16a34a",
      weight: 2,
      opacity: 0.8,
      updateWhenZooming: true,
      updateWhenDragging: true,
      renderer: canvasRendererRef.current || undefined,
    }).addTo(mapRef.current)
    pathsRef.current.set(id, { polyline, coords })
  }

  function appendToPath(id, latLng) {
    const L = window.L
    const map = mapRef.current
    if (!map) return
    if (!pathsRef.current.has(id)) {
      ensurePathInitialized(id, [latLng])
      return
    }
    const entry = pathsRef.current.get(id)
    const nextPoint = L.latLng(latLng[0], latLng[1])
    const prevPoint = entry.coords[entry.coords.length - 1]
    const distance = map.distance(prevPoint, nextPoint)
    if (distance < MIN_SEGMENT_METERS) return
    entry.coords.push(nextPoint)
    if (entry.coords.length > MAX_PATH_POINTS) {
      entry.coords.splice(0, entry.coords.length - MAX_PATH_POINTS)
      entry.polyline.setLatLngs(entry.coords)
    } else {
      try { entry.polyline.addLatLng(nextPoint) } catch { entry.polyline.setLatLngs(entry.coords) }
    }
  }

  function isPointWithinViewport(map, latlng, paddingPx) {
    try {
      const size = map.getSize()
      const p = map.latLngToContainerPoint(latlng)
      const left = paddingPx
      const top = paddingPx
      const right = size.x - paddingPx
      const bottom = size.y - paddingPx
      return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
    } catch {
      return true
    }
  }

  function ensureWithinViewport(map, latlng, paddingPx) {
    if (!isPointWithinViewport(map, latlng, paddingPx)) {
      try { map.panTo(latlng, { animate: false }) } catch {}
    }
  }

  function nudgeMap(map) {
    try {
      map.panBy([1, 1], { animate: false })
      map.panBy([-1, -1], { animate: false })
    } catch {}
  }

  function formatLatLngOrCity(lat, lng, id) {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`
    const cached = geocodeCacheRef.current.get(key)
    if (cached) return cached
    reverseGeocode(lat, lng)
      .then((place) => {
        try {
          const k = `${lat.toFixed(5)},${lng.toFixed(5)}`
          geocodeCacheRef.current.set(k, place)
          setGeoTick((n) => n + 1)
        } catch {}
      })
      .catch(() => {})
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  }

  async function reverseGeocode(lat, lng) {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`
    if (geocodeCacheRef.current.has(key)) return geocodeCacheRef.current.get(key)
    if (geocodePendingRef.current.has(key)) return geocodePendingRef.current.get(key)
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10&addressdetails=1`
    const p = fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        const addr = json?.address || {}
        const city = addr.city || addr.town || addr.village || addr.hamlet || addr.suburb
        const state = addr.state
        const country = addr.country_code ? addr.country_code.toUpperCase() : undefined
        const place = city && state
          ? `${city}, ${state}`
          : (json?.display_name?.split(',').slice(0, 2).join(', ').trim() || `${lat.toFixed(5)}, ${lng.toFixed(5)}`)
        const finalPlace = country ? `${place}, ${country}` : place
        geocodeCacheRef.current.set(key, finalPlace)
        geocodePendingRef.current.delete(key)
        return finalPlace
      })
      .catch(() => {
        geocodePendingRef.current.delete(key)
        return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
      })
    geocodePendingRef.current.set(key, p)
    return p
  }

  function getSelectedInfo() {
    infoTick; geoTick;
    if (!selectedTrainId) return null
    const id = selectedTrainId
    const marker = markersRef.current.get(id)
    const start = startPositionsRef.current.get(id)
    const current = marker?.getLatLng()
    const speed = speedsRef.current.get(id)
    const speedText = Number.isFinite(speed) ? `${speed.toFixed(1)} km/h` : "—"
    const startText = start ? formatLatLngOrCity(start.lat, start.lng, id) : "—"
    const currText = current ? formatLatLngOrCity(current.lat, current.lng, id) : "—"
    const startRaw = start ? `${start.lat.toFixed(5)}, ${start.lng.toFixed(5)}` : "—"
    const currRaw = current ? `${current.lat.toFixed(5)}, ${current.lng.toFixed(5)}` : "—"
    return { id, speedText, startText, currText, startRaw, currRaw }
  }

  const statusDotClass = status === "connected" ? "bg-green-500" : "bg-red-500"

  return (
    <section className="rounded-lg border border-gray-700 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Live Map</h2>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${statusDotClass}`}
            aria-label={status}
            title={status}
          />
          <span className="text-sm text-gray-400 capitalize">{status}</span>
        </div>
      </div>

      <div className="flex gap-3 items-stretch">
        <div ref={containerRef} className="h-[80vh] rounded-md flex-1 min-w-0" role="region" aria-label="Real-time train map" />

        <aside className="h-[80vh] w-80 shrink-0 rounded-md border border-gray-700 p-3 overflow-auto bg-black/20">
          {(() => {
            const info = getSelectedInfo()
            if (!info) {
              return (
                <div className="text-sm text-gray-400">
                  Click a train to see details.
                </div>
              )
            }
            return (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">Train {info.id}</div>
                  <button
                    className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
                    onClick={() => setSelectedTrainId(null)}
                  >
                    Clear
                  </button>
                </div>
                <div>
                  <div className="text-gray-400">Speed</div>
                  <div>{info.speedText}</div>
                </div>
                <div>
                  <div className="text-gray-400">Start</div>
                  <div>{info.startText}</div>
                  <div className="text-xs text-gray-500">{info.startRaw}</div>
                </div>
                <div>
                  <div className="text-gray-400">Current</div>
                  <div>{info.currText}</div>
                  <div className="text-xs text-gray-500">{info.currRaw}</div>
                </div>
              </div>
            )
          })()}
        </aside>
      </div>

      <p className="mt-2 text-xs text-gray-500">
        WebSocket: {wsUrl ?? process.env.NEXT_PUBLIC_WS_URL ?? "connecting..."}
      </p>
    </section>
  )
}
