### WebSocket quick-start

- **Server URL**: default `ws://localhost:8080` (use `wss://...` if your site is HTTPS)

- **Start server**
  - Bun:
    ```bash
    bun ./webS/server.mjs
    ```
  - Python (if you have a Python server):
    ```bash
    python -m venv .venv
    . .venv/Scripts/Activate.ps1
    pip install -r webS/requirements.txt
    python webS/server.py
    ```

- **Configure client URL**
  - Hardcoded:
    ```javascript
    const wsUrl = "ws://localhost:8080"
    ```
  - Via env (recommended):
    ```javascript
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080"
    ```
    .env:
    ```bash
    NEXT_PUBLIC_WS_URL=ws://localhost:8080
    ```

- **Client connect snippet (JS)**
  ```javascript
  const ws = new WebSocket(wsUrl)

  ws.onopen = () => console.log("connected")
  ws.onclose = ws.onerror = () => console.log("disconnected")

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data)
    const updates = Array.isArray(data) ? data : [data]
    // each update: { id, lat, lng, popup? }
    console.log("updates", updates)
  }
  ```

- **Message schema**
  ```json
  { "id": "train-1", "lat": 20.59, "lng": 78.96, "popup": "optional" }
  ```

- **Troubleshooting**
  - Use `wss://` if your page is HTTPS.
  - Verify the server is listening on port 8080.
  - Check browser Network → WS frames for JSON payloads and errors.
  - If nothing shows, confirm `id` is string and `lat`/`lng` are numbers.


