/**
 * System tray integration for Webcam Manager
 * Provides menu for camera selection, window control, and settings
 */

import {
  TrayIconBuilder,
  Menu,
  MenuItemBuilder,
  Icon,
  initialize,
  update,
  pollTrayEvents,
  pollMenuEvents,
  CheckMenuItemBuilder,
  SubmenuBuilder,
  PredefinedMenuItem,
} from 'tray-icon-node';
import type { WebcamManager } from './webcam-manager';
import type { CameraDevice, WindowPosition } from './types';
import { createLogger } from './logger';

const logger = createLogger('TrayIcon');

// Global references to prevent garbage collection
let tray: ReturnType<TrayIconBuilder['build']> | null = null;
let isRunning: boolean = true;

/**
 * Generate a simple camera icon as RGBA buffer
 */
export function generateIconData(): Buffer {
  const size = 32;
  const iconData = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      
      // Create a simple camera shape
      const centerX = size / 2;
      const centerY = size / 2;
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Camera body (dark gray rectangle)
      const inBody = x >= 4 && x < size - 4 && y >= 8 && y < size - 4;
      // Camera lens (blue circle)
      const inLens = dist < 10;
      // Flash (small white square)
      const inFlash = x >= size - 10 && x < size - 4 && y >= 4 && y < 10;
      
      if (inFlash) {
        iconData[idx] = 255;     // R
        iconData[idx + 1] = 255; // G
        iconData[idx + 2] = 255; // B
        iconData[idx + 3] = 255; // A
      } else if (inLens) {
        iconData[idx] = 66;      // R (blue color)
        iconData[idx + 1] = 133; // G
        iconData[idx + 2] = 244; // B
        iconData[idx + 3] = 255; // A
      } else if (inBody) {
        iconData[idx] = 60;      // R (dark gray)
        iconData[idx + 1] = 60;  // G
        iconData[idx + 2] = 60;  // B
        iconData[idx + 3] = 255; // A
      } else {
        // Transparent background
        iconData[idx] = 0;
        iconData[idx + 1] = 0;
        iconData[idx + 2] = 0;
        iconData[idx + 3] = 0;
      }
    }
  }

  return iconData;
}

/**
 * Tray menu controller
 */
export class TrayMenuController {
  private manager: WebcamManager;
  private menu: Menu;
  private cameraSubmenu: ReturnType<SubmenuBuilder['build']> | null = null;
  private positionSubmenu: ReturnType<SubmenuBuilder['build']> | null = null;
  private sizeSubmenu: ReturnType<SubmenuBuilder['build']> | null = null;

  // Menu item references for state updates
  private toggleCameraItem: ReturnType<CheckMenuItemBuilder['build']> | null = null;
  private alwaysOnTopItem: ReturnType<CheckMenuItemBuilder['build']> | null = null;

  constructor(manager: WebcamManager) {
    this.manager = manager;
    this.menu = new Menu();
    this.buildMenu();
  }

  /**
   * Build the complete menu structure
   */
  private buildMenu(): void {
    // Camera Toggle
    this.toggleCameraItem = new CheckMenuItemBuilder()
      .withText('Camera Active')
      .withId('toggle-camera')
      .withChecked(this.manager.isStreaming())
      .build();
    this.menu.appendCheckMenuItem(this.toggleCameraItem, 'toggle-camera');

    // Always on Top
    this.alwaysOnTopItem = new CheckMenuItemBuilder()
      .withText('Always on Top')
      .withId('toggle-always-on-top')
      .withChecked(false) // Would get from window manager
      .build();
    this.menu.appendCheckMenuItem(this.alwaysOnTopItem, 'toggle-always-on-top');

    this.menu.appendPredefinedMenuItem(PredefinedMenuItem.separator());

    // Camera Selection Submenu
    this.buildCameraSubmenu();

    // Position Submenu
    this.buildPositionSubmenu();

    // Size Submenu
    this.buildSizeSubmenu();

    this.menu.appendPredefinedMenuItem(PredefinedMenuItem.separator());

    // Window Controls
    const minimizeItem = new MenuItemBuilder()
      .withText('Minimize')
      .withId('minimize')
      .build();
    this.menu.appendMenuItem(minimizeItem);

    const restoreItem = new MenuItemBuilder()
      .withText('Restore')
      .withId('restore')
      .build();
    this.menu.appendMenuItem(restoreItem);

    this.menu.appendPredefinedMenuItem(PredefinedMenuItem.separator());

    // Exit
    const exitItem = new MenuItemBuilder()
      .withText('Exit')
      .withId('exit')
      .build();
    this.menu.appendMenuItem(exitItem);
  }

  /**
   * Build camera selection submenu
   */
  private buildCameraSubmenu(): void {
    this.cameraSubmenu = new SubmenuBuilder()
      .withText('Select Camera')
      .build();

    this.refreshCameraMenu();
    this.menu.appendSubmenu(this.cameraSubmenu);
  }

  /**
   * Refresh camera list in submenu
   */
  refreshCameraMenu(): void {
    if (!this.cameraSubmenu) return;

    const cameras = this.manager.getCameras();
    const currentCamera = this.manager.getCurrentCamera();

    if (cameras.length === 0) {
      const noCameraItem = new MenuItemBuilder()
        .withText('No cameras found')
        .withId('no-cameras')
        .build();
      this.cameraSubmenu.appendMenuItem(noCameraItem);
      return;
    }

    for (const cam of cameras) {
      const isActive = currentCamera?.index === cam.index;
      const item = new CheckMenuItemBuilder()
        .withText(cam.name)
        .withId(`camera-${cam.index}`)
        .withChecked(isActive)
        .build();
      this.cameraSubmenu.appendCheckMenuItem(item);
    }
  }

  /**
   * Build position submenu
   */
  private buildPositionSubmenu(): void {
    this.positionSubmenu = new SubmenuBuilder()
      .withText('Position')
      .build();

    const positions: { id: WindowPosition; label: string }[] = [
      { id: 'top-left', label: 'Top Left' },
      { id: 'top-right', label: 'Top Right' },
      { id: 'bottom-left', label: 'Bottom Left' },
      { id: 'bottom-right', label: 'Bottom Right' },
      { id: 'center', label: 'Center' },
    ];

    for (const pos of positions) {
      const item = new MenuItemBuilder()
        .withText(pos.label)
        .withId(`position-${pos.id}`)
        .build();
      this.positionSubmenu.appendMenuItem(item);
    }

    this.menu.appendSubmenu(this.positionSubmenu);
  }

  /**
   * Build size submenu
   */
  private buildSizeSubmenu(): void {
    this.sizeSubmenu = new SubmenuBuilder()
      .withText('Window Size')
      .build();

    const sizes = [
      { id: 'small', label: 'Small (320x240)' },
      { id: 'medium', label: 'Medium (640x480)' },
      { id: 'large', label: 'Large (1280x720)' },
    ];

    for (const size of sizes) {
      const item = new MenuItemBuilder()
        .withText(size.label)
        .withId(`size-${size.id}`)
        .build();
      this.sizeSubmenu.appendMenuItem(item);
    }

    this.menu.appendSubmenu(this.sizeSubmenu);
  }

  /**
   * Get the menu instance
   */
  getMenu(): Menu {
    return this.menu;
  }

  /**
   * Update menu item states
   */
  updateStates(): void {
    if (this.toggleCameraItem) {
      // Update checked state based on streaming status
      // Note: tray-icon-node may not support dynamic updates
    }
  }

  /**
   * Handle menu events
   */
  handleEvent(eventId: string): void {
    logger.info('Menu event', { id: eventId });

    switch (eventId) {
      case 'toggle-camera':
        this.manager.toggleCamera();
        break;

      case 'toggle-always-on-top':
        this.manager.toggleAlwaysOnTop();
        break;

      case 'minimize':
        this.manager.minimize();
        break;

      case 'restore':
        this.manager.restore();
        break;

      case 'exit':
        isRunning = false;
        break;

      default:
        // Handle dynamic IDs
        if (eventId.startsWith('camera-')) {
          const cameraIndex = eventId.replace('camera-', '');
          this.manager.selectCamera(cameraIndex);
        } else if (eventId.startsWith('position-')) {
          const position = eventId.replace('position-', '') as WindowPosition;
          this.manager.setPosition(position);
        } else if (eventId.startsWith('size-')) {
          const size = eventId.replace('size-', '') as 'small' | 'medium' | 'large';
          this.manager.setPredefinedSize(size);
        }
        break;
    }
  }
}

/**
 * Create and run tray icon with menu
 */
export async function runTrayIcon(manager: WebcamManager): Promise<void> {
  logger.info('Initializing tray icon...');

  initialize();

  const controller = new TrayMenuController(manager);
  const menu = controller.getMenu();

  const icon = Icon.fromRgba(generateIconData(), 32, 32);

  tray = new TrayIconBuilder()
    .withTitle('Webcam Manager')
    .withTooltip('Webcam Manager - Right click for menu')
    .withIcon(icon)
    .withMenu(menu)
    .build();

  logger.success('Tray icon created');

  // Event loop
  while (isRunning) {
    update();

    // Poll tray events
    const trayEvent = pollTrayEvents();
    if (trayEvent?.eventType) {
      logger.debug('Tray event', { type: trayEvent.eventType });
    }

    // Poll menu events
    const menuEvent = pollMenuEvents();
    if (menuEvent?.id) {
      controller.handleEvent(menuEvent.id);
    }

    // Small delay to prevent high CPU usage (~30 FPS)
    await new Promise((resolve) => setTimeout(resolve, 32));
  }

  logger.info('Tray icon shutting down...');
  tray = null;
  process.exit(1);
}

/**
 * Stop tray icon
 */
export function stopTrayIcon(): void {
  isRunning = false;
}

/**
 * Check if tray is running
 */
export function isTrayRunning(): boolean {
  return isRunning;
}
