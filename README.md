# Capstone Frontend

A Next.js frontend with a real time Leaflet map that tracks trains over India via WebSocket updates.

## Stack
- Next.js (App Router) + React
- Tailwind CSS + shadcn/ui
- Leaflet (Canvas renderer)
- Bun (dev runtime and mock WS server)

## Quick start

Prerequisites: Bun installed (`https://bun.sh`).

Install and run dev server:
```bash
bun install
bun run dev
```
Open `http://localhost:3000`.

## Real-time WebSocket server
The map expects `ws://localhost:8080`.
Run the mock server provided:
```bash
bun ./webS/server.mjs
```
It emits train updates every second with shape:
```json
{ "id": "train-1", "lat": 20.59, "lng": 78.96, "popup": "optional" }
```
You can also send an array of such objects.

## Tips
- Press Escape to reset to the India view
- Click a train to focus and follow it
- Trails keep last 500 points; marker/trail sizes scale with zoom

## Config
- WS URL is currently hardcoded in `src/components/RealTimeLeafletMap.jsx`.
  If needed, add `NEXT_PUBLIC_WS_URL` and read from `process.env` in that file.

## Scripts
- Dev: `bun run dev`
- WS server: `bun ./webS/server.mjs`

## Structure
```
app/
components/
src/components/
webS/server.mjs
```

## Screenshots

> If the images below don't render on your viewer, use the links under them.

![Screenshot 1](assets/screenshots/not-so-working-map.png)

![Screenshot 2](assets/screenshots/working-map.png)



## License
MIT
