# Webcam Manager

A desktop application for managing webcam feeds with system tray integration, global shortcuts, and customizable window positioning.

## Architecture

### Core Dependencies

| Package | Purpose |
|---------|---------|
| `webview-napi` | Window rendering using Tao (windowing) and Wry (webview) with pixel buffer rendering |
| `nokhwa-node` | Cross-platform camera access and frame capture |
| `rdev-node` | Global input listening and event simulation |
| `tray-icon-node` | System tray icon with context menu |

## Features

### Window Management
- **Always on Top**: Keep window above other applications
- **Position Presets**: Quick positioning (top-left, top-right, bottom-left, bottom-right, center)
- **Size Controls**: Minimize, maximize, restore, or custom dimensions
- **Transparency**: Adjustable window opacity
- **Borderless Mode**: Toggle window decorations

### Camera Management
- **Multi-Camera Support**: Switch between available cameras
- **Resolution Selection**: Auto-select best format (MJPEG preferred) or manual override
- **FPS Display**: Real-time frame rate counter
- **Mirror/Flip**: Horizontal and vertical flip options

### Input Handling
- **Global Shortcuts**: System-wide keyboard shortcuts
  - `Ctrl+Shift+C`: Toggle camera on/off
  - `Ctrl+Shift+S`: Take screenshot
  - `Ctrl+Shift+H`: Hide/Show window
  - `Ctrl+Shift+T`: Toggle always on top
  - `Ctrl+Shift+Arrow Keys`: Position window
- **Input Blocking**: Option to block input events when window is active

### System Tray
- **Tray Menu Actions**:
  - Toggle Camera (Start/Stop)
  - Toggle Always on Top
  - Toggle Input Blocking
  - Select Camera (submenu with all cameras)
  - Position Window (submenu with presets)
  - Window Size (submenu)
  - Settings
  - Exit

### Configuration (JSON Storage)

```typescript
interface AppConfig {
  // Window state
  window: {
    width: number;
    height: number;
    x: number;
    y: number;
    alwaysOnTop: boolean;
    opacity: number;
    decorated: boolean;
  };
  
  // Camera settings
  camera: {
    selectedCameraIndex: string | null;
    resolution: 'highest' | 'medium' | 'lowest';
    mirrorHorizontal: boolean;
    mirrorVertical: boolean;
    targetFps: number;
  };
  
  // Input settings
  input: {
    globalShortcutsEnabled: boolean;
    blockInputWhenActive: boolean;
    shortcuts: Record<string, string>; // action -> key combination
  };
  
  // App state
  state: {
    cameraActive: boolean;
    lastUsedCamera: string | null;
  };
}
```

Configuration is stored in `~/.config/webcam-manager/config.json` (Linux), `%APPDATA%/webcam-manager/config.json` (Windows), or `~/Library/Application Support/webcam-manager/config.json` (macOS).

## Usage Examples

### Basic Startup
```bash
bun start
```

### With Environment Variables
```bash
# Force specific resolution
CAMERA_RESOLUTION=highest bun start

# Force X11 backend (Linux)
GDK_BACKEND=x11 bun start

# Debug mode
DEBUG=1 bun start
```

### Programmatic API
```typescript
import { WebcamManager } from './webcam-manager';

const manager = new WebcamManager();
await manager.initialize();

// Select specific camera
await manager.selectCamera('0');

// Set position
manager.setPosition('top-right');

// Toggle always on top
manager.setAlwaysOnTop(true);
```

## File Structure

```
src/
├── index.ts           # Application entry point
├── webcam-manager.ts  # Main application class
├── camera-api.ts      # Camera management (nokhwa-node wrapper)
├── frame-converter.ts # Frame format conversion utilities
├── window-manager.ts  # Window state and positioning
├── input.ts           # Global input handling (rdev-node)
├── trayicon.ts        # System tray integration
├── config.ts          # JSON configuration management
├── logger.ts          # Structured logging
└── types.ts           # TypeScript type definitions
```

## Development

### Prerequisites
- Bun runtime
- Linux: libwebkit2gtk-4.0-dev, libgtk-3-dev
- Camera access permissions

### Scripts
- `bun start` - Start the application
- `bun run dev` - Start with hot reload
- `bun run build` - Build for production
- `bun run lint` - Run linter
- `bun run test` - Run tests

## Platform Notes

### Linux
- Requires X11 (Wayland support via XWayland)
- May need `v4l2-ctl` for camera enumeration
- Grant camera permissions: `sudo usermod -a -G video $USER`

### Windows
- Requires Windows 10 or later
- Camera access through MediaFoundation

### macOS
- Requires macOS 10.14 or later
- Camera permissions in System Preferences
