/**
 * Webcam Manager - Main Entry Point
 * 
 * A desktop application for managing webcam feeds with:
 * - System tray integration
 * - Global keyboard shortcuts
 * - Customizable window positioning
 * - Camera selection and control
 */

import { createLogger } from './logger';
import { WebcamManager, createWebcamManager } from './webcam-manager';

const logger = createLogger('Main');

// Force X11 on Linux for better compatibility
process.env.GDK_BACKEND = 'x11';

// Global manager instance for cleanup
let manager: WebcamManager | null = null;

/**
 * Handle process signals for graceful shutdown
 */
function setupSignalHandlers(): void {
  let isShuttingDown = false;

  const shutdown = (signal: string, exitCode: number = 0) => {
    if (isShuttingDown) {
      // Prevent double execution
      return;
    }
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down...`);
    
    // Remove signal handlers to prevent recursion
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    
    if (manager) {
      try {
        manager.dispose();
      } catch (error) {
        logger.error('Error during shutdown', { error });
      }
    }
    
    // Allow time for cleanup before exit
    setTimeout(() => {
      process.exit(exitCode);
    }, 150);
  };

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
    shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
    // Don't exit on unhandled rejection, just log it
  });
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Webcam Manager - Usage
======================

Environment Variables:
  CAMERA_RESOLUTION=highest|medium|lowest  Set preferred camera resolution
  GDK_BACKEND=x11                          Force X11 backend (Linux)
  DEBUG=1                                  Enable debug logging

Keyboard Shortcuts:
  Ctrl+Shift+C    Toggle camera on/off
  Ctrl+Shift+H    Hide/Show window
  Ctrl+Shift+T    Toggle always on top
  Ctrl+Shift+Home Position window top-left
  Ctrl+Shift+End  Position window top-right
  Ctrl+Shift+M    Minimize window
  Ctrl+Shift+R    Restore window

Tray Icon:
  Right-click the tray icon for menu options including:
  - Camera selection
  - Window positioning
  - Always on top toggle
  - Exit

Examples:
  bun start
  CAMERA_RESOLUTION=medium bun start
`);
}

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  // Check for help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  setupSignalHandlers();

  try {
    logger.banner('Webcam Manager', 'Starting...');

    // Create and initialize manager
    manager = await createWebcamManager();

    // Start the event loop
    await manager.run();
  } catch (error) {
    logger.error('Fatal error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    
    if (manager) {
      try {
        manager.dispose();
      } catch (disposeError) {
        logger.error('Error during cleanup', { error: disposeError });
      }
    }
    
    // Delay exit to allow cleanup
    setTimeout(() => {
      process.exit(1);
    }, 100);
  }
}

// Run main
main();
