#!/usr/bin/env python3
import asyncio
import json
import signal
from typing import Set
from contextlib import asynccontextmanager

import redis.asyncio as redis
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
import uvicorn

# Global Redis connection pool
redis_pool = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Create connection pool
    global redis_pool
    redis_pool = redis.ConnectionPool(
        host="localhost",
        port=6379,
        db=0,
        decode_responses=True,
        max_connections=50,  # Limit max connections
        socket_keepalive=True,
        socket_connect_timeout=5,
        health_check_interval=30
    )
    print("✓ Redis connection pool created")
    
    yield
    
    # Shutdown: Close pool
    await redis_pool.disconnect()
    print("✓ Redis connection pool closed")

app = FastAPI(lifespan=lifespan)

# Add CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional: small in-memory registry of active websocket tasks (for graceful shutdown)
active_tasks: Set[asyncio.Task] = set()

@app.get("/")
async def root():
    with open("index.html") as f:
        return HTMLResponse(f.read())

@app.get("/api/history")
async def get_history(
    train_id: str = Query(..., description="Train ID to fetch history for"),
    from_time: str = Query(None, alias="from", description="Start time in ISO format (YYYY-MM-DDTHH:MM)"),
    to_time: str = Query(None, alias="to", description="End time in ISO format (YYYY-MM-DDTHH:MM)")
):
    """
    Fetch historical tracking data for a train.
    Returns an array of points with lat, lng, timestamp (ms), and optional speed.
    """
    try:
        # Create Redis client from pool
        r = redis.Redis(connection_pool=redis_pool)
        
        # Try to fetch from Redis (assuming data is stored in a sorted set or list)
        # Key format: "train_history:{train_id}"
        redis_key = f"train_history:{train_id}"
        
        # Parse time filters if provided
        from_timestamp = None
        to_timestamp = None
        
        if from_time:
            try:
                # Parse ISO format datetime (YYYY-MM-DDTHH:MM)
                dt = datetime.fromisoformat(from_time.replace("Z", "+00:00") if "Z" in from_time else from_time)
                from_timestamp = int(dt.timestamp() * 1000)  # Convert to milliseconds
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid 'from' time format: {from_time}")
        
        if to_time:
            try:
                dt = datetime.fromisoformat(to_time.replace("Z", "+00:00") if "Z" in to_time else to_time)
                to_timestamp = int(dt.timestamp() * 1000)  # Convert to milliseconds
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid 'to' time format: {to_time}")
        
        # Try to get data from Redis
        # Assuming data is stored as JSON strings in a sorted set keyed by timestamp
        history_points = []
        
        try:
            # Check if key exists
            exists = await r.exists(redis_key)
            
            if exists:
                # Fetch all data from sorted set (sorted by timestamp)
                # Format: ZRANGE key 0 -1 WITHSCORES
                raw_data = await r.zrange(redis_key, 0, -1, withscores=True)
                
                for data_str, score in raw_data:
                    try:
                        point = json.loads(data_str)
                        timestamp = int(score)  # Use score as timestamp if stored that way
                        
                        # Apply time filters
                        if from_timestamp and timestamp < from_timestamp:
                            continue
                        if to_timestamp and timestamp > to_timestamp:
                            continue
                        
                        # Ensure timestamp is in the point data
                        point["timestamp"] = timestamp
                        history_points.append(point)
                    except (json.JSONDecodeError, KeyError, ValueError) as e:
                        print(f"Error parsing history point: {e}")
                        continue
                
                # Sort by timestamp to ensure ascending order
                history_points.sort(key=lambda x: x.get("timestamp", 0))
            else:
                # No data in Redis - return empty array or mock data for testing
                # Uncomment the following block to return mock data for testing:
                """
                import random
                import time
                # Generate mock data for testing
                base_lat, base_lng = 20.5937, 78.9629  # India center
                now = int(time.time() * 1000)
                for i in range(50):
                    timestamp = now - (50 - i) * 60000  # 1 minute intervals
                    if from_timestamp and timestamp < from_timestamp:
                        continue
                    if to_timestamp and timestamp > to_timestamp:
                        continue
                    history_points.append({
                        "lat": base_lat + random.uniform(-0.5, 0.5),
                        "lng": base_lng + random.uniform(-0.5, 0.5),
                        "timestamp": timestamp,
                        "speed": random.uniform(0, 100)
                    })
                """
                pass  # Return empty array if no data found
        
        except Exception as e:
            print(f"Error fetching from Redis: {e}")
            # Continue and return empty array or re-raise
            pass
        
        finally:
            await r.close()
        
        return history_points
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    
    # Create Redis client from pool for this connection
    r = redis.Redis(connection_pool=redis_pool)
    pubsub = r.pubsub()
    
    # default channels if you want some
    subscribed_channels = set()

    # helper: subscribe to channels (idempotent)
    async def subscribe_channels(*channels):
        nonlocal subscribed_channels
        new = [c for c in channels if c not in subscribed_channels]
        if not new:
            return
        await pubsub.subscribe(*new)
        subscribed_channels.update(new)

    # helper: unsubscribe
    async def unsubscribe_channels(*channels):
        nonlocal subscribed_channels
        to_unsub = [c for c in channels if c in subscribed_channels]
        if not to_unsub:
            return
        await pubsub.unsubscribe(*to_unsub)
        for c in to_unsub:
            subscribed_channels.discard(c)

    # start with a default subscription (optional)
    await subscribe_channels("updates", "alerts")
    print(f"✓ WebSocket connected, subscribed to: {subscribed_channels}")

    async def reader_loop():
        try:
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    # message["data"] is a string (because decode_responses=True)
                    channel = message.get("channel", "unknown")
                    data = message["data"]
                    print(f"📨 [{channel}] Received: {data[:100]}{'...' if len(data) > 100 else ''}")
                    await ws.send_text(data)
                # small sleep to yield
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            # Task cancelled from outside (normal shutdown)
            raise
        except Exception as e:
            print(f"pubsub reader error: {e}")
            # break or re-raise
            raise

    # reader task per client
    reader_task = asyncio.create_task(reader_loop())
    active_tasks.add(reader_task)

    # heartbeat task to keep the ws alive and detect broken connections
    async def heartbeat():
        try:
            while True:
                await ws.send_text(json.dumps({"type": "heartbeat", "ts": int(asyncio.get_event_loop().time())}))
                await asyncio.sleep(15)
        except asyncio.CancelledError:
            raise
        except Exception:
            # likely connection closed
            return

    hb_task = asyncio.create_task(heartbeat())
    active_tasks.add(hb_task)

    try:
        while True:
            # wait for a message from client (we'll timeout to check websocket liveness)
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=1.0)
            except asyncio.TimeoutError:
                # no client message — continue looping
                await asyncio.sleep(0.01)
                continue

            # Expect JSON messages from client instructing subscribe/unsubscribe
            try:
                payload = json.loads(msg)
            except Exception:
                # echo invalid message
                await ws.send_text(json.dumps({"type": "error", "message": "invalid json"}))
                continue

            cmd = payload.get("type")
            if cmd == "subscribe":
                channels = payload.get("channels", [])
                if isinstance(channels, list) and channels:
                    await subscribe_channels(*channels)
                    print(f"➕ Subscribed to: {channels}")
                    await ws.send_text(json.dumps({"type": "subscribed", "channels": channels}))
                else:
                    await ws.send_text(json.dumps({"type": "error", "message": "subscribe requires channels list"}))
            elif cmd == "unsubscribe":
                channels = payload.get("channels", [])
                if isinstance(channels, list) and channels:
                    await unsubscribe_channels(*channels)
                    print(f"➖ Unsubscribed from: {channels}")
                    await ws.send_text(json.dumps({"type": "unsubscribed", "channels": channels}))
                else:
                    await ws.send_text(json.dumps({"type": "error", "message": "unsubscribe requires channels list"}))
            elif cmd == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
            else:
                await ws.send_text(json.dumps({"type": "error", "message": f"unknown command {cmd}"}))

    except WebSocketDisconnect:
        print("🔌 WebSocket disconnected")
        pass
    except Exception as e:
        print(f"WS loop error: {e}")
    finally:
        # cleanup tasks and subscriptions
        if not reader_task.done():
            reader_task.cancel()
        if not hb_task.done():
            hb_task.cancel()
        
        # unsubscribe all channels and close pubsub
        try:
            if subscribed_channels:
                await pubsub.unsubscribe(*list(subscribed_channels))
            await pubsub.close()
        except Exception as e:
            print(f"Error closing pubsub: {e}")
        
        # Close Redis client (returns connection to pool)
        await r.close()
        
        active_tasks.discard(reader_task)
        active_tasks.discard(hb_task)

# Signal handling is done by uvicorn's lifespan, remove custom handlers

if __name__ == "__main__":
    uvicorn.run("backend_server:app", host="0.0.0.0", port=8000, log_level="info")
