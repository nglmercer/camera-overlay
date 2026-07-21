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
| POST | `/start` | Start camera capture |
| POST | `/stop` | Stop camera capture |

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
