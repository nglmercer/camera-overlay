/**
 * Global input handling for Webcam Manager
 * Uses rdev-node for keyboard/mouse event listening and simulation
 */

import { startListener } from 'rdev-node';
import type { InputEvent, InputConfig } from './types';
import { createLogger } from './logger';

// Type definitions for rdev-node events (since the package doesn't export them)
interface RdevKeyEvent {
  key: string;
  code: number;
}

interface RdevMouseMoveEvent {
  x: number;
  y: number;
}

interface RdevMouseButtonEvent {
  button: number;
}

type RdevEvent =
  | { eventType: 'keyPress'; keyPress: RdevKeyEvent }
  | { eventType: 'keyRelease'; keyRelease: RdevKeyEvent }
  | { eventType: 'mouseMove'; mouseMove: RdevMouseMoveEvent }
  | { eventType: 'mousePress'; mousePress: RdevMouseButtonEvent }
  | { eventType: 'mouseRelease'; mouseRelease: RdevMouseButtonEvent };

const logger = createLogger('Input');

/**
 * Key mapping from rdev key names to our internal format
 */
const KEY_MAP: Record<string, string> = {
  'KeyA': 'A', 'KeyB': 'B', 'KeyC': 'C', 'KeyD': 'D',
  'KeyE': 'E', 'KeyF': 'F', 'KeyG': 'G', 'KeyH': 'H',
  'KeyI': 'I', 'KeyJ': 'J', 'KeyK': 'K', 'KeyL': 'L',
  'KeyM': 'M', 'KeyN': 'N', 'KeyO': 'O', 'KeyP': 'P',
  'KeyQ': 'Q', 'KeyR': 'R', 'KeyS': 'S', 'KeyT': 'T',
  'KeyU': 'U', 'KeyV': 'V', 'KeyW': 'W', 'KeyX': 'X',
  'KeyY': 'Y', 'KeyZ': 'Z',
  'Digit0': '0', 'Digit1': '1', 'Digit2': '2', 'Digit3': '3',
  'Digit4': '4', 'Digit5': '5', 'Digit6': '6', 'Digit7': '7',
  'Digit8': '8', 'Digit9': '9',
  'Space': 'Space',
  'Enter': 'Enter',
  'Escape': 'Escape',
  'Tab': 'Tab',
  'Backspace': 'Backspace',
  'Delete': 'Delete',
  'Home': 'Home', 'End': 'End',
  'PageUp': 'PageUp', 'PageDown': 'PageDown',
  'ArrowUp': 'Up', 'ArrowDown': 'Down',
  'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
};

/**
 * Parse a key combination string (e.g., "Ctrl+Shift+C")
 */
export function parseKeyCombo(combo: string): {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
} {
  const parts = combo.split('+').map(p => p.trim().toLowerCase());
  
  return {
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
    meta: parts.includes('meta') || parts.includes('command') || parts.includes('cmd'),
    key: parts.find(p => !['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'command', 'cmd'].includes(p)) || '',
  };
}

/**
 * Format key combo from parts
 */
export function formatKeyCombo(
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  meta: boolean,
  key: string
): string {
  const parts: string[] = [];
  if (ctrl) parts.push('Ctrl');
  if (shift) parts.push('Shift');
  if (alt) parts.push('Alt');
  if (meta) parts.push('Meta');
  if (key) parts.push(key.charAt(0).toUpperCase() + key.slice(1));
  return parts.join('+');
}

/**
 * Input manager class
 */
export class InputManager {
  private config: InputConfig;
  private isListening: boolean = false;
  private pressedKeys: Set<string> = new Set();
  private shortcutHandlers: Map<string, () => void> = new Map();
  private eventCallback: ((event: InputEvent) => void) | null = null;
  private isRunning: boolean = false;

  constructor(config: InputConfig) {
    this.config = { ...config };
  }

  /**
   * Initialize input listening
   */
  initialize(): void {
    if (this.isListening) return;

    try {
      startListener((event) => {
        this.handleRdevEvent(event as unknown as RdevEvent);
        return event;
      });

      this.isListening = true;
      logger.info('Input listener started');
    } catch (error) {
      logger.error('Failed to start input listener', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop input listening
   */
  stop(): void {
    this.isRunning = false;
    this.isListening = false;
    this.pressedKeys.clear();
    logger.info('Input listener stopped');
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<InputConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Input config updated');
  }

  /**
   * Register a shortcut handler
   */
  registerShortcut(action: string, handler: () => void): void {
    this.shortcutHandlers.set(action, handler);
    logger.debug('Shortcut registered', { action });
  }

  /**
   * Unregister a shortcut handler
   */
  unregisterShortcut(action: string): void {
    this.shortcutHandlers.delete(action);
    logger.debug('Shortcut unregistered', { action });
  }

  /**
   * Set event callback for all input events
   */
  setEventCallback(callback: (event: InputEvent) => void): void {
    this.eventCallback = callback;
  }

  /**
   * Handle rdev events
   */
  private handleRdevEvent(event: RdevEvent): void {
    const inputEvent = this.convertEvent(event);
    
    if (!inputEvent) return;

    // Track pressed keys
    if (inputEvent.eventType === 'keyPress' && inputEvent.keyPress) {
      this.pressedKeys.add(inputEvent.keyPress.key.toLowerCase());
      this.checkShortcuts(inputEvent);
    } else if (inputEvent.eventType === 'keyRelease' && inputEvent.keyRelease) {
      this.pressedKeys.delete(inputEvent.keyRelease.key.toLowerCase());
    }

    // Forward event if callback is set
    if (this.eventCallback) {
      this.eventCallback(inputEvent);
    }
  }

  /**
   * Convert rdev event to our format
   */
  private convertEvent(event: RdevEvent): InputEvent | null {
    // Handle key press
    if ('keyPress' in event && event.keyPress) {
      const key = KEY_MAP[event.keyPress.key] || event.keyPress.key;
      return {
        eventType: 'keyPress',
        keyPress: {
          key,
          code: event.keyPress.code,
        },
      };
    }

    // Handle key release
    if ('keyRelease' in event && event.keyRelease) {
      const key = KEY_MAP[event.keyRelease.key] || event.keyRelease.key;
      return {
        eventType: 'keyRelease',
        keyRelease: {
          key,
          code: event.keyRelease.code,
        },
      };
    }

    // Handle mouse move
    if ('mouseMove' in event && event.mouseMove) {
      return {
        eventType: 'mouseMove',
        mouseMove: {
          x: event.mouseMove.x,
          y: event.mouseMove.y,
        },
      };
    }

    // Handle mouse press
    if ('mousePress' in event && event.mousePress) {
      return {
        eventType: 'mousePress',
        mousePress: {
          button: String(event.mousePress.button),
          x: 0, // rdev doesn't always provide coords
          y: 0,
        },
      };
    }

    // Handle mouse release
    if ('mouseRelease' in event && event.mouseRelease) {
      return {
        eventType: 'mouseRelease',
        mouseRelease: {
          button: String(event.mouseRelease.button),
          x: 0,
          y: 0,
        },
      };
    }

    return null;
  }

  /**
   * Check if a shortcut was triggered
   */
  private checkShortcuts(event: InputEvent): void {
    if (!this.config.globalShortcutsEnabled) return;
    if (event.eventType !== 'keyPress' || !event.keyPress) return;

    const pressedKey = event.keyPress.key.toLowerCase();
    
    // Check each configured shortcut
    for (const [action, combo] of Object.entries(this.config.shortcuts)) {
      const parsed = parseKeyCombo(combo);
      
      // Check if key matches
      if (parsed.key.toLowerCase() !== pressedKey) continue;
      
      // Check modifiers (simplified - assumes Ctrl+Shift mainly)
      const hasCtrl = this.pressedKeys.has('ctrl') || this.pressedKeys.has('control');
      const hasShift = this.pressedKeys.has('shift');
      const hasAlt = this.pressedKeys.has('alt');
      const hasMeta = this.pressedKeys.has('meta') || this.pressedKeys.has('command');
      
      if (hasCtrl === parsed.ctrl &&
          hasShift === parsed.shift &&
          hasAlt === parsed.alt &&
          hasMeta === parsed.meta) {
        
        logger.info('Shortcut triggered', { action, combo });
        
        const handler = this.shortcutHandlers.get(action);
        if (handler) {
          try {
            handler();
          } catch (error) {
            logger.error('Shortcut handler error', {
              action,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        
        break;
      }
    }
  }

  /**
   * Get currently pressed keys
   */
  getPressedKeys(): string[] {
    return Array.from(this.pressedKeys);
  }

  /**
   * Check if a key is currently pressed
   */
  isKeyPressed(key: string): boolean {
    return this.pressedKeys.has(key.toLowerCase());
  }

  /**
   * Enable/disable global shortcuts
   */
  setGlobalShortcutsEnabled(enabled: boolean): void {
    this.config.globalShortcutsEnabled = enabled;
    logger.info('Global shortcuts', { enabled });
  }

  /**
   * Toggle global shortcuts
   */
  toggleGlobalShortcuts(): boolean {
    this.config.globalShortcutsEnabled = !this.config.globalShortcutsEnabled;
    logger.info('Global shortcuts toggled', { enabled: this.config.globalShortcutsEnabled });
    return this.config.globalShortcutsEnabled;
  }

  /**
   * Check if listening
   */
  isActive(): boolean {
    return this.isListening;
  }

  /**
   * Get configuration
   */
  getConfig(): InputConfig {
    return { ...this.config };
  }

  /**
   * Cleanup
   */
  dispose(): void {
    try {
      this.stop();
      this.shortcutHandlers.clear();
      this.eventCallback = null;
      logger.info('Input manager disposed');
    } catch (error) {
      logger.error('Error disposing input manager', { error });
    }
  }
}

/**
 * Default shortcuts configuration
 */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  'toggle-camera': 'Ctrl+Shift+C',
  'screenshot': 'Ctrl+Shift+S',
  'hide-window': 'Ctrl+Shift+H',
  'toggle-always-on-top': 'Ctrl+Shift+T',
  'position-top-left': 'Ctrl+Shift+Home',
  'position-top-right': 'Ctrl+Shift+End',
  'position-bottom-left': 'Ctrl+Shift+PageDown',
  'position-bottom-right': 'Ctrl+Shift+PageUp',
  'position-center': 'Ctrl+Shift+C',
  'minimize': 'Ctrl+Shift+M',
  'restore': 'Ctrl+Shift+R',
};

/**
 * Create default input config
 */
export function createDefaultInputConfig(): InputConfig {
  return {
    globalShortcutsEnabled: true,
    blockInputWhenActive: false,
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
}
