# camera-overlay

A lightweight webcam overlay served over HTTP — designed for OBS Browser Source integration. Uses nokhwa for capture and axum for streaming, with a system tray icon for control.

## Architecture

- **Camera**: nokhwa captures frames → JPEG encoded → broadcast via channel
- **Server**: axum HTTP server streams WebSocket JPEG frames & WebRTC to browsers
- **Tray**: tray-icon for system tray presence
- **Config**: JSON config in `~/.config/camera-overlay/config.json`

## Commands

| Command | Description |
|---------|-------------|
| `npm run build:web` | Build frontend web assets |
| `cargo run` | Start the camera server |
| `cargo check` | Type check |
| `cargo clippy -- -D warnings` | Lint Rust codebase |
| `cargo test` | Run unit and e2e integration tests |
| `cargo build --release` | Build production binary |

## HTTP & WebSocket Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Overlay page (OBS Browser Source) |
| GET | `/config` | Config UI |
| GET | `/ws` | Binary WebSocket JPEG stream |
| GET | `/settings` | Get current config JSON |
| POST | `/settings` | Update config JSON |
| GET | `/status` | `{ running, has_frame, memory_rss_kb }` |
| GET | `/cameras` | List available cameras |
| POST | `/start` | Start camera capture (`{ ok, error?, running }`) |
| POST | `/stop` | Stop camera capture |
| POST | `/webrtc/offer` | WebRTC offer/answer negotiation |

## OBS Integration

1. Run the app (`cargo run`)
2. In OBS, add a **Browser Source**
3. Set URL to `http://localhost:8080/`
4. Set width/height to match your camera resolution
5. Check "Shutdown source when not visible" for optimal performance

## Requirements

- Rust toolchain (1.70+)
- Node.js / bun (for frontend build)
- nokhwa native deps: `libv4l-dev` on Linux

