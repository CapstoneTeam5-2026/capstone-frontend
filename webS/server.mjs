const port = 8080;

function rand(min, max) { return Math.random() * (max - min) + min; }

// Keep trains within India bounds
const BOUNDS = { latMin: 6.465, latMax: 35.5133, lngMin: 68.1097, lngMax: 97.3956 };

const MAX_VELOCITY = 0.00015;
const NOISE = 0.00003;
const UPDATE_INTERVAL = 1000; // ms

// Calculate speed in km/h from velocity (approximate)
function calculateSpeed(vx, vy) {
  // Rough conversion: 1 degree ≈ 111 km
  // Velocity is in degrees per second
  const speedDegreesPerSec = Math.sqrt(vx * vx + vy * vy);
  const speedKmh = speedDegreesPerSec * 111 * 3600; // Convert to km/h
  return Math.round(speedKmh * 10) / 10; // Round to 1 decimal
}

let trains = Array.from({ length: 5 }).map((_, i) => ({
  train_id: `train-${i + 1}`,
  id: `train-${i + 1}`, // Support both train_id and id
  lat: 20.5937 + rand(-3, 3),
  lon: 78.9629 + rand(-3, 3),
  lng: 78.9629 + rand(-3, 3), // Support both lon and lng
  vx: rand(-MAX_VELOCITY, MAX_VELOCITY),
  vy: rand(-MAX_VELOCITY, MAX_VELOCITY),
  timestamp: Date.now(),
}));

const conns = new Set();

Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WebSocket live at /", { status: 200 });
  },
  websocket: {
    open(ws) {
      conns.add(ws);
      // Send initial state
      const initialData = trains.map(t => ({
        train_id: t.train_id,
        id: t.id,
        lat: t.lat,
        lon: t.lon,
        lng: t.lng,
        speed: calculateSpeed(t.vx, t.vy),
        timestamp: t.timestamp,
        popup: `🚆 ${t.train_id}`,
      }));
      ws.send(JSON.stringify(initialData));
    },
    message(ws, msg) {
      // Handle ping/pong for heartbeat
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {}
    },
    close(ws) { 
      conns.delete(ws); 
    },
  },
});

setInterval(() => {
  const now = Date.now();
  trains = trains.map(t => {
    let vx = t.vx + rand(-NOISE, NOISE);
    let vy = t.vy + rand(-NOISE, NOISE);
    
    // Clamp velocities
    vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, vx));
    vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, vy));

    // Update position (velocity is in degrees per second, interval is 1 second)
    let lat = t.lat + vy;
    let lon = t.lon + vx;

    // Bounce off boundaries
    if (lat < BOUNDS.latMin) { 
      lat = BOUNDS.latMin + (BOUNDS.latMin - lat); 
      vy = Math.abs(vy); 
    }
    if (lat > BOUNDS.latMax) { 
      lat = BOUNDS.latMax - (lat - BOUNDS.latMax); 
      vy = -Math.abs(vy); 
    }
    if (lon < BOUNDS.lngMin) { 
      lon = BOUNDS.lngMin + (BOUNDS.lngMin - lon); 
      vx = Math.abs(vx); 
    }
    if (lon > BOUNDS.lngMax) { 
      lon = BOUNDS.lngMax - (lon - BOUNDS.lngMax); 
      vx = -Math.abs(vx); 
    }

    return { 
      ...t, 
      lat, 
      lon, 
      lng: lon, // Keep both lon and lng for compatibility
      vx, 
      vy,
      timestamp: now,
    };
  });

  // Send updates in the format the frontend expects
  const payload = trains.map(t => ({
    train_id: t.train_id,
    id: t.id,
    lat: t.lat,
    lon: t.lon,
    lng: t.lng,
    speed: calculateSpeed(t.vx, t.vy),
    timestamp: t.timestamp,
    popup: `🚆 ${t.train_id}`,
  }));

  const jsonPayload = JSON.stringify(payload);
  for (const ws of conns) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(jsonPayload);
      }
    } catch (err) {
      console.error("Error sending to client:", err);
    }
  }
}, UPDATE_INTERVAL);

console.log(`WebSocket server listening on ws://localhost:${port}`);