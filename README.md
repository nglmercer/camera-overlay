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

Build the frontend before the Rust release build so `static/` contains the latest web bundle:

```bash
npm run build:web
cargo build --release
```

The release binary embeds every file under `static/` at compile time, including the web favicon. The tray PNG is also embedded directly in the executable, so the binary does not need the `static/` directory or an icon file beside it at runtime.

To verify the embedding, run the binary from a directory that does not contain the repository assets and request the pages/assets:

```bash
cd /tmp
/path/to/camera-overlay/target/release/camera-overlay
curl -I http://127.0.0.1:8080/
curl -I http://127.0.0.1:8080/assets/index.css
curl -I http://127.0.0.1:8080/camera-overlay.svg
```

You can also run `cargo test`; the `e2e_serves_all_web_assets_from_the_binary` test checks the embedded HTML, JavaScript, CSS, and icon routes.

## MCP verification

The project includes a dependency-free MCP stdio server for launching the app and testing overlay positioning:

```bash
npm run mcp
```

Configure an MCP client with the command `node /path/to/camera-overlay/scripts/camera-overlay-mcp.mjs`. Available tools include `start_app`, `set_overlay_position`, `start_camera`, `stop_camera`, and `verify_corner_positions`. The last tool moves the overlay through top-left, top-right, bottom-left, and bottom-right, then verifies each `/overlay` response.

## HTTP & WebSocket Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Overlay page (OBS Browser Source) |
| GET | `/config` | Config UI |
| GET | `/ws` | Binary WebSocket JPEG stream + text overlay-control commands |
| GET | `/settings` | Get current config JSON |
| POST | `/settings` | Update config JSON |
| GET | `/overlay` | Get current overlay positioning state |
| POST | `/overlay` | Set overlay positioning state (broadcast to connected clients) |
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

## Overlay Positioning

By default the camera feed is **centered** in the browser source. You can reposition, resize, rotate, mirror, and style it using CSS custom properties exposed on the canvas element.

### Via URL (permalink)

Append an `overlay` query parameter with a base64-encoded JSON object:

```
http://localhost:8080/?overlay=eyJ4IjoyMCwieSI6MjAsIndpZHRoIjoiNTB2dyIsImhlaWdodCI6IjUwdmgiLCJmaXQiOiJjb3ZlIn0=
```

That example decodes to:

```json
{ "x": 20, "y": 20, "width": "50vw", "height": "50vh", "fit": "cover" }
```

### Via JavaScript (in OBS browser console or a custom script)

```js
// Move to top-left corner, 25% size
cameraOverlay.set({ x: 0, y: 0, width: '25vw', height: '25vh' });

// Full screen, cover crop
cameraOverlay.set({
  x: '50%', y: '50%', width: '100vw', height: '100vh',
  fit: 'cover', radius: 0,
});

// Rotate 90° and scale to 1.5×
cameraOverlay.set({ rotate: 90, scale: 1.5 });

// Mirror horizontally (useful for webcam self-view)
cameraOverlay.set({ mirrorH: true });
```

### Available properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `x` | number\|string | `0` | Horizontal offset (px, %, vw, etc.) |
| `y` | number\|string | `0` | Vertical offset (px, %, vh, etc.) |
| `width` | number\|string | `'100%'` | Canvas width |
| `height` | number\|string | `'100%'` | Canvas height |
| `scale` | number | `1` | Scale factor (0.1–10) |
| `rotate` | number | `0` | Rotation in degrees (-360–360) |
| `mirrorH` | boolean | `false` | Mirror horizontally |
| `mirrorV` | boolean | `false` | Mirror vertically |
| `fit` | string | `'contain'` | Object-fit: `contain`, `cover`, `fill`, `none` |
| `opacity` | number | `1` | Opacity (0–1) |
| `filter` | string | `'none'` | CSS filter (e.g. `blur(2px)`) |
| `border` | string | `'none'` | CSS border |
| `radius` | number\|string | `0` | Border-radius |
| `background` | string | `'transparent'` | Background color |
| `visible` | boolean | `true` | Show/hide the overlay |

### Quick examples

**Top-left corner, quarter size:**
```js
cameraOverlay.set({ x: 0, y: 0, width: '25vw', height: '25vh' });
```

**Full screen, cover crop:**
```js
cameraOverlay.set({ x: '50%', y: '50%', width: '100vw', height: '100vh', fit: 'cover' });
```

**Bottom-right corner, 30% size:**
```js
cameraOverlay.set({ x: '100%', y: '100%', width: '30vw', height: '30vh' });
```

State is persisted in `localStorage` between page reloads. Use `cameraOverlay.reset()` to restore defaults.

## Overlay Control API (REST + WebSocket)

External tools (e.g. MCP servers) can control the overlay via HTTP or WebSocket:

### REST endpoints

```bash
# Set overlay position (broadcasts to all connected overlay clients via WebSocket)
curl -X POST http://localhost:8080/overlay \
  -H 'Content-Type: application/json' \
  -d '{"x": 100, "y": 50, "width": "50vw", "height": "50vh", "fit": "cover"}'

# Get current overlay state
curl http://localhost:8080/overlay
```

### WebSocket control

Connected overlay clients also receive text messages on the `/ws` WebSocket. Each message is a JSON object matching the [overlay state properties](#available-properties):

```json
{"x": 100, "y": 50, "width": "50vw", "height": "50vh", "fit": "cover"}
```

The overlay page applies these automatically — no polling required.

## System Tray

A system tray icon provides quick access to common actions:

| Menu item | Action |
|-----------|--------|
| **Start Camera** / **Stop Camera** | Toggle camera capture |
| **Open Config** | Open the config UI in your browser |
| **Restart** | Restart the server |
| **Quit** | Exit the application |

Clicking the tray icon also opens the config page.

## Requirements

- Rust toolchain (1.70+)
- Node.js / bun (for frontend build)
- nokhwa native deps: `libv4l-dev` on Linux
- Tray icon native deps (Linux): `libgtk-3-dev libappindicator3-dev`
