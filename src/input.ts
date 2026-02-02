/**
 * Global input handling for Webcam Manager
 * Uses rdev-node for keyboard/mouse event listening and simulation
 */

import { startListener, EventTypeValue, KeyCode, stringKeyToKeycode  } from 'rdev-node';
import type { InputEvent, InputConfig } from './types';
import { createLogger } from './logger';

const logger = createLogger('Input');
logger.enabled = false;

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
/**
 * A simple but effective Shortcut Manager
 */
export class InputManager {
  private pressedKeys = new Set<KeyCode>()
  private shortcuts = new Map<string, () => void>()

  constructor() {
    startListener((event) => {
      if (event.eventType === EventTypeValue.KeyPress && event.keyPress) {
        this.pressedKeys.add(event.keyPress.key)
        this.checkShortcuts()
      } else if (event.eventType === EventTypeValue.KeyRelease && event.keyRelease) {
        this.pressedKeys.delete(event.keyRelease.key)
      }
      return event
    })
  }

  /**
   * Register a shortcut like "Ctrl+Shift+S"
   */
  register(combo: string, callback: () => void) {
    const parts = combo.split('+').map(p => p.trim())
    const normalizedParts = parts.map(p => {
      const code = stringKeyToKeycode(p)
      if (!code) throw new Error(`Invalid key: ${p}`)
      return code
    }).sort()

    this.shortcuts.set(normalizedParts.join(','), callback)
    logger.info(`Registered shortcut: ${combo}`)
  }

  private checkShortcuts() {
    const sortedPressed = Array.from(this.pressedKeys).sort().join(',')
    const handler = this.shortcuts.get(sortedPressed)
    if (handler) handler()
  }
  public dispose(){
    process.exit(0)
  }
}
/**
 * Default shortcuts configuration
 * Note: Home, End, PageUp, PageDown are modifier keys that don't work well
 * as the main key in shortcuts. Use letter keys instead.
 */
export const DEFAULT_SHORTCUTS = {
  'toggle-camera': 'Ctrl+Shift+C',
  'screenshot': 'Ctrl+Shift+S',
  'hide-window': 'Ctrl+Shift+H',
  'toggle-always-on-top': 'Ctrl+Shift+T',
  'position-top-left': 'Ctrl+Shift+1',
  'position-top-right': 'Ctrl+Shift+2',
  'position-bottom-left': 'Ctrl+Shift+3',
  'position-bottom-right': 'Ctrl+Shift+4',
  'position-center': 'Ctrl+Shift+5',
  'minimize': 'Ctrl+Shift+M',
  'restore': 'Ctrl+Shift+R',
} as const;

/**
 * Create default input config
 */
export function createDefaultInputConfig(): InputConfig {
  return {
    globalShortcutsEnabled: true,
    blockInputWhenActive: false,
  };
}
