# camera-overlay

A lightweight webcam overlay served over HTTP — designed for OBS Browser Source integration. Uses nokhwa for capture and axum for streaming, with a system tray icon for control.

## Architecture

- **Camera**: nokhwa captures frames → JPEG encoded → broadcast via channel
- **Server**: axum HTTP server streams MJPEG to browsers
- **Tray**: tray-icon for system tray presence
- **Config**: JSON config in `~/.config/camera-overlay/config.json`

## Commands

| Command | Description |
|---------|-------------|
| `cargo run` | Start the camera server |
| `cargo build --release` | Build production binary |
| `cargo clippy -- -D warnings` | Lint |
| `cargo check` | Type check |

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web UI with camera controls |
| GET | `/stream` | MJPEG stream (for OBS Browser Source) |
| GET | `/snapshot` | Single JPEG frame |
| GET | `/config` | Get current config |
| POST | `/config` | Update config |
| GET | `/cameras` | List available cameras |
| GET | `/status` | `{ running, has_frame, memory_rss_kb }` |
| POST | `/start` | Start camera capture |
| POST | `/stop` | Stop camera capture |

## Debugging memory growth

If RSS climbs after pressing **Start**, first find out *which* phase grows — the
helper script automates this (each phase is bounded with `timeout`):

```bash
./scripts/memory-debug.sh 30        # 30s per phase
timeout 300 ./scripts/memory-debug.sh   # or hard-bound the whole run
```

| Symptom | Likely cause |
|---------|--------------|
| Grows with **no `/stream` clients** | capture path (nokhwa/V4L2 buffers) → profile with heaptrack |
| Grows **only while a client streams** | per-client allocation churn, or the *client* (Chromium/OBS CEF caches decoded MJPEG frames — check whether it is the server process or OBS that grows) |
| Grows **per start/stop cycle** | camera open/close path (duplicate capture threads, driver buffers) |
| Never drops after **Stop** | normal for glibc malloc (arenas keep freed memory); only growth that *continues* after stop is a real leak |

Watch the server's own memory live (exposed in `/status`):

```bash
watch -n2 curl -s localhost:8080/status        # includes memory_rss_kb
```

Deeper profiling — always wrap in `timeout` so the run terminates and flushes
its report (SIGINT lets heaptrack/valgrind write output cleanly):

```bash
# heaptrack — best first tool: shows allocation stacks + a "leaked" summary
timeout --signal=SIGINT 180 heaptrack ./target/debug/camera-overlay
heaptrack_print heaptrack.camera-overlay.*.zst | less

# valgrind massif — heap usage over time, shows *where* the peak is held
timeout --signal=SIGINT 180 valgrind --tool=massif ./target/debug/camera-overlay
ms_print massif.out.* | less

# valgrind memcheck — definitive for *true* leaks (slow; keep the run short)
timeout --signal=SIGINT 120 valgrind --tool=memcheck --leak-check=full ./target/debug/camera-overlay
```

While any of these run, exercise the app from another shell exactly like the
bug report describes:

```bash
curl -X POST localhost:8080/start
curl -sN localhost:8080/stream -o /dev/null &   # one client, like OBS
curl -X POST localhost:8080/stop
```

Interpretation: allocations growing inside `nokhwa`/`v4l2` frames → capture
backend issue; growing multipart buffers per client → serving churn (fixed by
building each MJPEG part once per frame in `CameraFrame::new`); growth only in
the *OBS* process → client-side MJPEG frame caching, not this server.

## OBS Integration

1. Run the app
2. In OBS, add a **Browser Source**
3. Set URL to `http://localhost:8080/stream`
4. Set width/height to match your camera resolution
5. Check "Shutdown source when not visible" for performance

## Dependencies

- [axum](https://github.com/tokio-rs/axum) — HTTP server
- [nokhwa](https://github.com/l1npengtul/nokhwa) — camera capture
- [image](https://github.com/image-rs/image) — JPEG encoding
- [tray-icon](https://github.com/tauri-apps/tray-icon) — system tray

## Requirements

- Rust toolchain (1.70+)
- nokhwa native deps: `libv4l-dev` on Linux
