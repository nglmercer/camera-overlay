/**
 * Main Webcam Manager class
 * Orchestrates camera, window, input, and tray functionality
 */

import { WindowBuilder, EventLoop, PixelRenderer, RenderOptions, ScaleMode, type Window } from 'webview-napi';
import { createLogger } from './logger';
import { cameraAPI } from './camera-api';
import { convertFrameToRGBABuffer } from './frame-converter';
import { ConfigManager } from './config';
import { WindowManager } from './window-manager';
import { InputManager } from './input';
import { runTrayIcon, stopTrayIcon, setOnExitCallback } from './trayicon';
import type { AppConfig, CameraDevice, WindowPosition } from './types';

const logger = createLogger('WebcamManager');

/**
 * Webcam Manager - Main application controller
 */
export class WebcamManager {
  private configManager: ConfigManager;
  private windowManager: WindowManager;
  private inputManager: InputManager;
  
  private window: Window | null = null;
  private eventLoop: EventLoop | null = null;
  private renderer: PixelRenderer | null = null;
  
  private isRunning: boolean = false;
  private frameCount: number = 0;
  private lastFpsUpdate: number = 0;
  private currentFps: number = 0;
  
  private cameras: CameraDevice[] = [];
  private cameraWidth: number = 640;
  private cameraHeight: number = 480;

  constructor() {
    this.configManager = new ConfigManager();
    this.windowManager = new WindowManager(this.configManager.getWindowConfig());
    this.inputManager = new InputManager(this.configManager.getInputConfig());
  }

  /**
   * Initialize the application
   */
  async initialize(): Promise<void> {
    logger.banner('Webcam Manager', 'Initializing...');

    try {
      // Load configuration
      await this.configManager.initialize();
      const config = this.configManager.getConfig();
      
      // Initialize camera first (to get camera resolution for window)
      await this.initializeCamera(config);
      
      // Initialize window with camera resolution
      await this.initializeWindow(config);
      
      // Initialize input
      this.initializeInput(config);
      
      // Auto-start camera if it was active or if this is first run
      if (config.state.cameraActive || config.camera.selectedCameraIndex === null) {
        await this.startCamera();
      }
      
      // Start tray icon in background
      this.startTrayIcon();
      
      this.isRunning = true;
      logger.success('Webcam Manager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Webcam Manager', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Initialize the window
   */
  private async initializeWindow(config: AppConfig): Promise<void> {
    logger.section('Window Initialization');

    this.eventLoop = new EventLoop();
    
    const windowConfig = config.window;
    const builder = new WindowBuilder()
      .withTitle('Webcam Manager')
      .withInnerSize(windowConfig.width, windowConfig.height)
      .withPosition(windowConfig.x, windowConfig.y)
      .withResizable(windowConfig.resizable)
      .withDecorated(windowConfig.decorated)
      .withVisible(windowConfig.visible)
      .withFocused(true);

    this.window = builder.build(this.eventLoop);
    this.windowManager.setWindow(this.window);

    logger.success('Window created', {
      id: this.window.id,
      size: `${windowConfig.width}x${windowConfig.height}`,
      position: `${windowConfig.x},${windowConfig.y}`,
    });

    // Initialize renderer
    const renderOptions: RenderOptions = {
      bufferWidth: this.cameraWidth,
      bufferHeight: this.cameraHeight,
      scaleMode: ScaleMode.Fit,
      backgroundColor: [0, 0, 0, 255],
    };
    
    this.renderer = PixelRenderer.withOptions(renderOptions);
    logger.success('Renderer initialized');

    // Render initial placeholder
    this.renderPlaceholder();
  }

  /**
   * Initialize camera
   */
  private async initializeCamera(config: AppConfig): Promise<void> {
    logger.section('Camera Initialization');

    // List available cameras
    this.cameras = cameraAPI.listCameras();
    logger.info('Available cameras', { 
      count: this.cameras.length,
      cameras: this.cameras.map(c => c.name),
    });

    if (this.cameras.length === 0) {
      logger.warning('No cameras found');
      return;
    }

    // Select camera from config or first available
    const cameraIndex = config.camera.selectedCameraIndex ?? this.cameras[0]!.index;
    await this.selectCamera(cameraIndex);
  }

  /**
   * Initialize input handling
   */
  private initializeInput(config: AppConfig): void {
    logger.section('Input Initialization');

    // Register shortcut handlers
    this.inputManager.registerShortcut('toggle-camera', () => this.toggleCamera());
    this.inputManager.registerShortcut('hide-window', () => this.windowManager.toggleVisible());
    this.inputManager.registerShortcut('toggle-always-on-top', () => {
      const newState = this.windowManager.toggleAlwaysOnTop();
      this.configManager.setAlwaysOnTop(newState);
    });
    this.inputManager.registerShortcut('position-top-left', () => this.windowManager.setPresetPosition('top-left'));
    this.inputManager.registerShortcut('position-top-right', () => this.windowManager.setPresetPosition('top-right'));
    this.inputManager.registerShortcut('position-bottom-left', () => this.windowManager.setPresetPosition('bottom-left'));
    this.inputManager.registerShortcut('position-bottom-right', () => this.windowManager.setPresetPosition('bottom-right'));
    this.inputManager.registerShortcut('position-center', () => this.windowManager.setPresetPosition('center'));
    this.inputManager.registerShortcut('minimize', () => this.windowManager.minimize());
    this.inputManager.registerShortcut('restore', () => this.windowManager.restore());

    // Start listening
    if (config.input.globalShortcutsEnabled) {
      this.inputManager.initialize();
    }

    logger.success('Input handlers registered');
  }

  /**
   * Start tray icon in background
   */
  private startTrayIcon(): void {
    // Set up exit callback for graceful shutdown from tray
    setOnExitCallback(() => {
      logger.info('Exit requested from tray icon');
      this.shutdown();
    });

    // Run tray icon in background (non-blocking)
    runTrayIcon(this).catch((error) => {
      logger.error('Tray icon error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    logger.info('Tray icon started');
  }

  /**
   * Select a camera by index
   */
  async selectCamera(cameraIndex: string): Promise<boolean> {
    logger.info('Selecting camera', { index: cameraIndex });

    // Stop current stream
    if (cameraAPI.getIsStreaming()) {
      cameraAPI.stopStream();
    }

    // Select new camera
    const success = cameraAPI.selectCamera(cameraIndex);
    if (!success) {
      logger.error('Failed to select camera', { index: cameraIndex });
      return false;
    }

    // Update camera dimensions
    const format = cameraAPI.getCameraFormat();
    if (format) {
      this.cameraWidth = format.width;
      this.cameraHeight = format.height;
      logger.info('Camera format', {
        resolution: `${format.width}x${format.height}`,
        format: format.format,
      });
    }

    // Update config
    this.configManager.setSelectedCamera(cameraIndex);
    
    // Auto-start if configured
    if (this.configManager.getAppState().cameraActive) {
      this.startCamera();
    }

    logger.success('Camera selected', { index: cameraIndex });
    return true;
  }

  /**
   * Start camera streaming
   */
  startCamera(): boolean {
    if (!this.renderer || !this.window) {
      logger.error('Cannot start camera: window not ready');
      return false;
    }

    if (cameraAPI.getIsStreaming()) {
      logger.info('Camera already streaming');
      return true;
    }

    logger.info('Starting camera stream...');

    const success = cameraAPI.startStream((frame) => {
      // Skip frame if shutting down
      if (!this.isRunning) {
        return;
      }

      try {
        // Validate frame data
        if (!frame || !frame.data || frame.data.length === 0) {
          return;
        }

        // Validate renderer and window are still available
        if (!this.renderer || !this.window) {
          return;
        }

        const buffer = convertFrameToRGBABuffer(
          frame,
          this.cameraWidth,
          this.cameraHeight,
          'fast'
        );

        // Double-check we're still running before rendering
        if (!this.isRunning || !this.renderer || !this.window) {
          return;
        }

        this.renderer.render(this.window, buffer);
        this.frameCount++;
        this.currentFps++;

        // Update FPS every second
        const now = Date.now();
        if (now - this.lastFpsUpdate >= 1000) {
          this.configManager.setFps(this.currentFps);
          logger.debug(`FPS: ${this.currentFps}, Frames: ${this.frameCount}`);
          this.currentFps = 0;
          this.lastFpsUpdate = now;
        }
      } catch (error) {
        logger.error('Frame render error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    if (success) {
      this.configManager.setCameraActive(true);
      this.configManager.setStreaming(true);
      logger.success('Camera stream started');
    } else {
      logger.error('Failed to start camera stream');
    }

    return success;
  }

  /**
   * Stop camera streaming
   */
  stopCamera(): void {
    try {
      cameraAPI.stopStream();
      this.configManager.setStreaming(false);
      this.configManager.setCameraActive(false);
      logger.info('Camera stream stopped');
    } catch (error) {
      logger.error('Error stopping camera', { error });
    }
  }

  /**
   * Toggle camera on/off
   */
  toggleCamera(): boolean {
    if (cameraAPI.getIsStreaming()) {
      this.stopCamera();
      this.renderPlaceholder();
      return false;
    } else {
      return this.startCamera();
    }
  }

  /**
   * Render placeholder frame
   */
  private renderPlaceholder(): void {
    if (!this.renderer || !this.window) return;

    const buffer = Buffer.alloc(this.cameraWidth * this.cameraHeight * 4);
    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = 30;     // R
      buffer[i + 1] = 30; // G
      buffer[i + 2] = 30; // B
      buffer[i + 3] = 255; // A
    }

    this.renderer.render(this.window, buffer);
  }

  /**
   * Set window position
   */
  setPosition(position: WindowPosition): void {
    this.windowManager.setPresetPosition(position);
    const bounds = this.windowManager.getBounds();
    this.configManager.setWindowPosition(bounds.x, bounds.y);
  }

  /**
   * Set window size
   */
  setSize(width: number, height: number): void {
    this.windowManager.setSize(width, height);
    this.configManager.setWindowSize(width, height);
  }

  /**
   * Set predefined window size
   */
  setPredefinedSize(size: 'small' | 'medium' | 'large'): void {
    this.windowManager.setPredefinedSize(size);
    const bounds = this.windowManager.getBounds();
    this.configManager.setWindowSize(bounds.width, bounds.height);
  }

  /**
   * Toggle always on top
   */
  toggleAlwaysOnTop(): boolean {
    const state = this.windowManager.toggleAlwaysOnTop();
    this.configManager.setAlwaysOnTop(state);
    return state;
  }

  /**
   * Toggle window visibility
   */
  toggleVisible(): boolean {
    return this.windowManager.toggleVisible();
  }

  /**
   * Minimize window
   */
  minimize(): void {
    this.windowManager.minimize();
  }

  /**
   * Maximize window
   */
  maximize(): void {
    this.windowManager.maximize();
  }

  /**
   * Restore window
   */
  restore(): void {
    this.windowManager.restore();
  }

  /**
   * Get available cameras
   */
  getCameras(): CameraDevice[] {
    return [...this.cameras];
  }

  /**
   * Get current camera info
   */
  getCurrentCamera(): { index: string; name: string } | null {
    const info = cameraAPI.getCameraInfo();
    if (!info) return null;
    return {
      index: info.index.toString(),
      name: info.name,
    };
  }

  /**
   * Check if camera is streaming
   */
  isStreaming(): boolean {
    return cameraAPI.getIsStreaming();
  }

  /**
   * Get current FPS
   */
  getFps(): number {
    return this.configManager.getAppState().currentFps;
  }

  /**
   * Run the main event loop
   */
  async run(): Promise<void> {
    if (!this.eventLoop || !this.window) {
      throw new Error('Webcam Manager not initialized');
    }

    logger.section('Running Event Loop');
    logger.info('Press Ctrl+C to exit');

    const poll = () => {
      if (!this.isRunning || !this.eventLoop) {
        this.shutdown();
        return;
      }

      if (this.eventLoop.runIteration()) {
        // Window still open, continue polling
        setTimeout(poll, 16); // ~60 FPS
      } else {
        // Window closed
        this.shutdown();
      }
    };

    poll();
  }

  /**
   * Shutdown the application
   */
  private shutdown(): void {
    if (!this.isRunning) {
      // Already shutting down, prevent double execution
      return;
    }

    logger.section('Shutting Down');
    
    this.isRunning = false;
    
    // Stop camera first to prevent frame callbacks during shutdown
    try {
      this.stopCamera();
    } catch (error) {
      logger.error('Error stopping camera', { error });
    }
    
    // Small delay to let camera callbacks finish
    setTimeout(() => {
      try {
        // Stop tray icon
        stopTrayIcon();
      } catch (error) {
        logger.error('Error stopping tray icon', { error });
      }
      
      try {
        // Stop input handling
        this.inputManager.dispose();
      } catch (error) {
        logger.error('Error disposing input manager', { error });
      }
      
      try {
        // Save config
        this.configManager.dispose().catch(() => {});
      } catch (error) {
        logger.error('Error saving config', { error });
      }
      
      logger.success('Goodbye!');
      
      // Use a small delay to allow async cleanup before exit
      setTimeout(() => {
        process.exit(0);
      }, 100);
    }, 100);
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.shutdown();
  }
}

/**
 * Create and initialize Webcam Manager
 */
export async function createWebcamManager(): Promise<WebcamManager> {
  const manager = new WebcamManager();
  await manager.initialize();
  return manager;
}
