/**
 * Type definitions for Webcam Manager
 */

// ============================================================================
// Window Types
// ============================================================================

export type WindowPosition = 
  | 'top-left' 
  | 'top-right' 
  | 'bottom-left' 
  | 'bottom-right' 
  | 'center' 
  | 'top-center' 
  | 'bottom-center' 
  | 'custom';

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export interface WindowConfig {
  width: number;
  height: number;
  x: number;
  y: number;
  alwaysOnTop: boolean;
  opacity: number;
  decorated: boolean;
  visible: boolean;
  resizable: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Camera Types
// ============================================================================

export interface CameraDevice {
  index: string;
  name: string;
}

export interface CameraFormat {
  format: string;
  width: number;
  height: number;
  frameRate: number;
}

export interface CameraFrame {
  data: Buffer;
  width: number;
  height: number;
  format: string;
}

export interface CameraConfig {
  selectedCameraIndex: string | null;
  resolution: 'highest' | 'medium' | 'lowest';
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  targetFps: number;
}

// ============================================================================
// Input Types
// ============================================================================

export interface ShortcutConfig {
  action: string;
  keyCombo: string;
  enabled: boolean;
}

export interface InputConfig {
  globalShortcutsEnabled: boolean;
  blockInputWhenActive: boolean;
}

export type InputEventType = 'keyPress' | 'keyRelease' | 'mouseMove' | 'mousePress' | 'mouseRelease' | 'wheel';

export interface InputEvent {
  eventType: InputEventType;
  keyPress?: {
    key: string;
    code: number;
  };
  keyRelease?: {
    key: string;
    code: number;
  };
  mouseMove?: {
    x: number;
    y: number;
  };
  mousePress?: {
    button: string;
    x: number;
    y: number;
  };
  mouseRelease?: {
    button: string;
    x: number;
    y: number;
  };
}

// ============================================================================
// Application State
// ============================================================================

export interface AppState {
  cameraActive: boolean;
  lastUsedCamera: string | null;
  isStreaming: boolean;
  currentFps: number;
  frameCount: number;
}

// ============================================================================
// Configuration
// ============================================================================

export interface AppConfig {
  version: string;
  window: WindowConfig;
  camera: CameraConfig;
  input: InputConfig;
  state: AppState;
}

// ============================================================================
// Tray Menu Types
// ============================================================================

export type TrayMenuAction = 
  | 'toggle-camera'
  | 'toggle-always-on-top'
  | 'toggle-input-blocking'
  | 'toggle-decorations'
  | 'select-camera'
  | 'position-window'
  | 'window-size'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'settings'
  | 'exit';

export interface TrayMenuItem {
  id: string;
  label: string;
  type: 'normal' | 'checkbox' | 'submenu' | 'separator';
  checked?: boolean;
  enabled?: boolean;
  submenu?: TrayMenuItem[];
}

// ============================================================================
// Events
// ============================================================================

export type AppEventType = 
  | 'camera-started'
  | 'camera-stopped'
  | 'camera-changed'
  | 'frame-received'
  | 'window-moved'
  | 'window-resized'
  | 'window-state-changed'
  | 'shortcut-triggered'
  | 'config-changed'
  | 'error';

export interface AppEvent {
  type: AppEventType;
  payload?: any;
  timestamp: number;
}

export type EventHandler = (event: AppEvent) => void;
