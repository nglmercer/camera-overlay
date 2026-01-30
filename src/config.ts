/**
 * Configuration management for Webcam Manager
 * Handles JSON storage with platform-specific paths
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import type { AppConfig, WindowConfig, CameraConfig, InputConfig, AppState } from './types';
import { createLogger } from './logger';

const logger = createLogger('Config');

const CONFIG_VERSION = '1.0.0';

const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  width: 640,
  height: 480,
  x: 100,
  y: 100,
  alwaysOnTop: true,
  opacity: 1.0,
  decorated: true,
  visible: true,
  resizable: true,
};

const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  selectedCameraIndex: null,
  resolution: 'highest',
  mirrorHorizontal: false,
  mirrorVertical: false,
  targetFps: 30,
};

const DEFAULT_INPUT_CONFIG: InputConfig = {
  globalShortcutsEnabled: true,
  blockInputWhenActive: false,
  shortcuts: {
    'toggle-camera': 'Ctrl+Shift+C',
    'screenshot': 'Ctrl+Shift+S',
    'hide-window': 'Ctrl+Shift+H',
    'toggle-always-on-top': 'Ctrl+Shift+T',
    'position-top-left': 'Ctrl+Shift+Home',
    'position-top-right': 'Ctrl+Shift+End',
    'position-bottom-left': 'Ctrl+Shift+PageDown',
    'position-bottom-right': 'Ctrl+Shift+PageUp',
    'position-center': 'Ctrl+Shift+C',
  },
};

const DEFAULT_APP_STATE: AppState = {
  cameraActive: false,
  lastUsedCamera: null,
  isStreaming: false,
  currentFps: 0,
  frameCount: 0,
};

const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  window: DEFAULT_WINDOW_CONFIG,
  camera: DEFAULT_CAMERA_CONFIG,
  input: DEFAULT_INPUT_CONFIG,
  state: DEFAULT_APP_STATE,
};

/**
 * Get platform-specific config directory
 */
function getConfigDir(): string {
  const plat = platform();
  
  switch (plat) {
    case 'win32':
      return join(process.env.APPDATA || homedir(), 'webcam-manager');
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'webcam-manager');
    case 'linux':
    default:
      return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'webcam-manager');
  }
}

/**
 * Configuration manager class
 */
export class ConfigManager {
  private configPath: string;
  private config: AppConfig;
  private saveTimeout: Timer | null = null;

  constructor() {
    this.configPath = join(getConfigDir(), 'config.json');
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Initialize config - load from disk or create default
   */
  async initialize(): Promise<void> {
    try {
      const configDir = getConfigDir();
      
      // Ensure config directory exists
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
        logger.info('Created config directory', { path: configDir });
      }

      // Try to load existing config
      if (existsSync(this.configPath)) {
        await this.load();
      } else {
        // Save default config
        await this.save();
        logger.info('Created default configuration', { path: this.configPath });
      }
    } catch (error) {
      logger.error('Failed to initialize config', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall back to defaults
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Load configuration from disk
   */
  async load(): Promise<void> {
    try {
      const data = await readFile(this.configPath, 'utf-8');
      const loaded = JSON.parse(data) as Partial<AppConfig>;
      
      // Merge with defaults to ensure all fields exist
      this.config = {
        ...DEFAULT_CONFIG,
        ...loaded,
        window: { ...DEFAULT_WINDOW_CONFIG, ...loaded.window },
        camera: { ...DEFAULT_CAMERA_CONFIG, ...loaded.camera },
        input: { ...DEFAULT_INPUT_CONFIG, ...loaded.input },
        state: { ...DEFAULT_APP_STATE, ...loaded.state },
      };

      // Update version
      this.config.version = CONFIG_VERSION;

      logger.info('Configuration loaded', { path: this.configPath });
    } catch (error) {
      logger.error('Failed to load config, using defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Save configuration to disk (debounced)
   */
  async save(): Promise<void> {
    // Clear existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Debounce saves to avoid excessive disk writes
    return new Promise((resolve, reject) => {
      this.saveTimeout = setTimeout(async () => {
        try {
          const data = JSON.stringify(this.config, null, 2);
          await writeFile(this.configPath, data, 'utf-8');
          logger.debug('Configuration saved', { path: this.configPath });
          resolve();
        } catch (error) {
          logger.error('Failed to save config', {
            error: error instanceof Error ? error.message : String(error),
          });
          reject(error);
        }
      }, 100) as unknown as Timer;
    });
  }

  /**
   * Save immediately without debouncing
   */
  async saveImmediate(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    
    const data = JSON.stringify(this.config, null, 2);
    await writeFile(this.configPath, data, 'utf-8');
    logger.info('Configuration saved immediately', { path: this.configPath });
  }

  // ============================================================================
  // Getters
  // ============================================================================

  getConfig(): AppConfig {
    return { ...this.config };
  }

  getWindowConfig(): WindowConfig {
    return { ...this.config.window };
  }

  getCameraConfig(): CameraConfig {
    return { ...this.config.camera };
  }

  getInputConfig(): InputConfig {
    return { ...this.config.input };
  }

  getAppState(): AppState {
    return { ...this.config.state };
  }

  // ============================================================================
  // Setters
  // ============================================================================

  setWindowConfig(window: Partial<WindowConfig>): void {
    this.config.window = { ...this.config.window, ...window };
    this.save().catch(() => {});
  }

  setCameraConfig(camera: Partial<CameraConfig>): void {
    this.config.camera = { ...this.config.camera, ...camera };
    this.save().catch(() => {});
  }

  setInputConfig(input: Partial<InputConfig>): void {
    this.config.input = { ...this.config.input, ...input };
    this.save().catch(() => {});
  }

  setAppState(state: Partial<AppState>): void {
    this.config.state = { ...this.config.state, ...state };
    this.save().catch(() => {});
  }

  // ============================================================================
  // Specific helpers
  // ============================================================================

  setWindowPosition(x: number, y: number): void {
    this.config.window.x = x;
    this.config.window.y = y;
    this.save().catch(() => {});
  }

  setWindowSize(width: number, height: number): void {
    this.config.window.width = width;
    this.config.window.height = height;
    this.save().catch(() => {});
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.config.window.alwaysOnTop = alwaysOnTop;
    this.save().catch(() => {});
  }

  setSelectedCamera(index: string | null): void {
    this.config.camera.selectedCameraIndex = index;
    if (index) {
      this.config.state.lastUsedCamera = index;
    }
    this.save().catch(() => {});
  }

  setCameraActive(active: boolean): void {
    this.config.state.cameraActive = active;
    this.save().catch(() => {});
  }

  setStreaming(streaming: boolean): void {
    this.config.state.isStreaming = streaming;
    this.save().catch(() => {});
  }

  setFps(fps: number): void {
    this.config.state.currentFps = fps;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async dispose(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.saveImmediate();
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
