/**
 * Window state management for Webcam Manager
 * Handles positioning, sizing, and window state
 */

import type { Window, EventLoop } from 'webview-napi';
import type { WindowConfig, WindowPosition, WindowState, WindowBounds } from './types';
import { createLogger } from './logger';
import { getDisplaySize } from 'rdev-node';
const logger = createLogger('WindowManager');
logger.enabled = false;

/**
 * Get screen dimensions (fallback values)
 * In a real implementation, you'd query the actual screen size
 */
function getScreenDimensions(): { width: number; height: number } {
  const size = getDisplaySize();
  return {
    width: size.width,
    height: size.height
  }
}

/**
 * Calculate window position based on preset
 */
export function calculatePosition(
  position: WindowPosition,
  windowWidth: number,
  windowHeight: number,
  screenWidth?: number,
  screenHeight?: number
): { x: number; y: number } {
  const screen = getScreenDimensions();
  const sw = screenWidth ?? screen.width;
  const sh = screenHeight ?? screen.height;

  // Add padding from screen edges
  const padding = 10;

  switch (position) {
    case 'top-left':
      return { x: padding, y: padding };
    
    case 'top-right':
      return { x: sw - windowWidth - padding, y: padding };
    
    case 'bottom-left':
      return { x: padding, y: sh - windowHeight - padding };
    
    case 'bottom-right':
      return { x: sw - windowWidth - padding, y: sh - windowHeight - padding };
    
    case 'center':
      return {
        x: Math.round((sw - windowWidth) / 2),
        y: Math.round((sh - windowHeight) / 2),
      };
    
    case 'top-center':
      return {
        x: Math.round((sw - windowWidth) / 2),
        y: padding,
      };
    
    case 'bottom-center':
      return {
        x: Math.round((sw - windowWidth) / 2),
        y: sh - windowHeight - padding,
      };
    
    case 'custom':
    default:
      return { x: 100, y: 100 };
  }
}

/**
 * Window manager class
 */
export class WindowManager {
  private window: Window | null = null;
  private config: WindowConfig;
  private currentState: WindowState = 'normal';
  private boundsBeforeMinimize: WindowBounds | null = null;

  constructor(config: WindowConfig) {
    this.config = { ...config };
  }

  /**
   * Set the managed window
   */
  setWindow(window: Window): void {
    this.window = window;
    logger.info('Window registered with manager', { windowId: window.id });
  }

  /**
   * Get current window config
   */
  getConfig(): WindowConfig {
    return { ...this.config };
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<WindowConfig>): void {
    this.config = { ...this.config, ...config };
    this.applyConfig();
  }

  /**
   * Apply current config to window
   */
  applyConfig(): void {
    if (!this.window) return;

    // Apply position
    this.setPosition(this.config.x, this.config.y);

    // Apply size
    this.setSize(this.config.width, this.config.height);

    // Apply always on top
    this.setAlwaysOnTop(this.config.alwaysOnTop);

    // Apply visibility
    this.setVisible(this.config.visible);

    logger.debug('Window config applied');
  }

  /**
   * Set window position
   */
  setPosition(x: number, y: number): void {
    if (!this.window) return;
    
    // Try to use native setPosition if available
    try {
        this.window.setOuterPosition(x, y);
        logger.debug('Window position set via native API', { x, y });

    } catch (error) {
      logger.warning('Failed to set window position', { x, y, error: String(error) });
    }
    
    // Always track the position in config
    this.config.x = x;
    this.config.y = y;
  }

  /**
   * Set window to a preset position
   */
  setPresetPosition(position: WindowPosition): void {
    const { x, y } = calculatePosition(
      position,
      this.config.width,
      this.config.height
    );
    
    this.setPosition(x, y);
    logger.info('Window positioned', { position, x, y });
  }

  /**
   * Set window size
   */
  setSize(width: number, height: number): void {
    if (!this.window) return;
    
    // webview-napi doesn't expose setSize directly
    // This would need to be implemented in the native layer
    this.config.width = width;
    this.config.height = height;
    this.window.setInnerSize(width,height)
    logger.debug('Window size set', { width, height });
  }

  /**
   * Update position from external source (e.g., window drag)
   * This updates the config without calling setOuterPosition
   */
  updatePosition(x: number, y: number): void {
    this.config.x = x;
    this.config.y = y;
    logger.debug('Position updated from external source', { x, y });
  }

  /**
   * Update size from external source (e.g., window resize)
   * This updates the config without calling setInnerSize
   */
  updateSize(width: number, height: number): void {
    this.config.width = width;
    this.config.height = height;
    logger.debug('Size updated from external source', { width, height });
  }

  /**
   * Set predefined window size
   * Sizes maintain 16:9 aspect ratio (standard camera aspect ratio)
   * - small: 320x180 (16:9) - positioned at bottom-right with no padding
   * - medium: 640x360 (16:9) - standard medium size
   * - large: 1280x720 (16:9) - HD resolution
   * - fullscreen: 1920x1080 (16:9) - Full HD, centered
   */
  setPredefinedSize(size: 'small' | 'medium' | 'large' | 'fullscreen'): void {
    // 16:9 aspect ratio sizes (standard for 1920x1080 cameras)
    const sizes = {
      small: { width: 320, height: 180 },    // 16:9
      medium: { width: 640, height: 360 },   // 16:9
      large: { width: 1280, height: 720 },   // 16:9
      fullscreen: { width: 1920, height: 1080 }, // 16:9 Full HD
    };

    const newSize = sizes[size];
    if (newSize) {
      this.setSize(newSize.width, newSize.height);

      // Reposition based on size for better UX
      if (size === 'small') {
        // Small size: position at bottom-right corner with no padding
        this.setPositionToCorner('bottom-right', 0);
      } else if (size === 'fullscreen') {
        // Fullscreen: center on screen
        this.setPresetPosition('center');
      }
      // medium and large keep their current position

      logger.info('Window size changed', { size, ...newSize });
    }
  }

  /**
   * Set window position to a specific corner with custom padding
   */
  setPositionToCorner(
    corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
    padding: number = 10
  ): void {
    const screen = getScreenDimensions();

    let x: number;
    let y: number;

    switch (corner) {
      case 'top-left':
        x = padding;
        y = padding;
        break;
      case 'top-right':
        x = screen.width - this.config.width - padding;
        y = padding;
        break;
      case 'bottom-left':
        x = padding;
        y = screen.height - this.config.height - padding;
        break;
      case 'bottom-right':
        x = screen.width - this.config.width - padding;
        y = screen.height - this.config.height - padding;
        break;
    }

    // Ensure position is never negative
    x = Math.max(0, x);
    y = Math.max(0, y);

    this.setPosition(x, y);
    logger.info('Window positioned to corner', { corner, x, y, padding });
  }

  /**
   * Toggle always on top
   */
  setAlwaysOnTop(alwaysOnTop: boolean): void {
    if (!this.window) return;
    
    // webview-napi doesn't expose always on top directly
    // This would need platform-specific implementation
    this.config.alwaysOnTop = alwaysOnTop;
    this.window.setAlwaysOnTop(alwaysOnTop)
    logger.info('Always on top changed', { alwaysOnTop });
  }

  toggleAlwaysOnTop(): boolean {
    this.config.alwaysOnTop = !this.config.alwaysOnTop;
    this.setAlwaysOnTop(this.config.alwaysOnTop);
    return this.config.alwaysOnTop;
  }

  /**
   * Set window visibility
   */
  setVisible(visible: boolean): void {
    if (!this.window) return;
    
    // webview-napi doesn't expose setVisible directly
    this.config.visible = visible;
    this.window.setVisible(visible)

    logger.info('Window visibility changed', { visible });
  }

  toggleVisible(): boolean {
    this.config.visible = !this.config.visible;
    this.setVisible(this.config.visible);
    return this.config.visible;
  }

  /**
   * Set window decorations
   */
  setDecorated(decorated: boolean): void {
    this.config.decorated = decorated;
    logger.info('Window decorations changed', { decorated });
  }

  toggleDecorated(): boolean {
    this.config.decorated = !this.config.decorated;
    this.setDecorated(this.config.decorated);
    return this.config.decorated;
  }

  /**
   * Set window opacity
   */
  setOpacity(opacity: number): void {
    // Clamp between 0 and 1
    this.config.opacity = Math.max(0, Math.min(1, opacity));
    logger.info('Window opacity changed', { opacity: this.config.opacity });
  }

  /**
   * Minimize window
   */
  minimize(): void {
    if (!this.window || this.currentState === 'minimized') return;
    
    this.boundsBeforeMinimize = {
      x: this.config.x,
      y: this.config.y,
      width: this.config.width,
      height: this.config.height,
    };
    
    this.currentState = 'minimized';
    this.setVisible(false);
    
    logger.info('Window minimized');
  }

  /**
   * Maximize window
   */
  maximize(): void {
    if (!this.window || this.currentState === 'maximized') return;
    
    if (this.currentState === 'normal') {
      this.boundsBeforeMinimize = {
        x: this.config.x,
        y: this.config.y,
        width: this.config.width,
        height: this.config.height,
      };
    }
    
    // Set to fullscreen size
    const screen = getScreenDimensions();
    this.setSize(screen.width, screen.height);
    this.setPosition(0, 0);
    
    this.currentState = 'maximized';
    
    logger.info('Window maximized');
  }

  /**
   * Restore window to normal state
   */
  restore(): void {
    if (!this.window || this.currentState === 'normal') return;
    
    if (this.boundsBeforeMinimize) {
      this.setPosition(this.boundsBeforeMinimize.x, this.boundsBeforeMinimize.y);
      this.setSize(this.boundsBeforeMinimize.width, this.boundsBeforeMinimize.height);
    }
    
    this.setVisible(true);
    this.currentState = 'normal';
    
    logger.info('Window restored');
  }

  /**
   * Get current window state
   */
  getState(): WindowState {
    return this.currentState;
  }

  /**
   * Get current window bounds
   */
  getBounds(): WindowBounds {
    return {
      x: this.config.x,
      y: this.config.y,
      width: this.config.width,
      height: this.config.height,
    };
  }

  /**
   * Check if window is always on top
   */
  isAlwaysOnTop(): boolean {
    return this.config.alwaysOnTop;
  }

  /**
   * Check if window is visible
   */
  isVisible(): boolean {
    return this.config.visible;
  }

  /**
   * Check if window is decorated
   */
  isDecorated(): boolean {
    return this.config.decorated;
  }
}
