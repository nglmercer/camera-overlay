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
logger.enabled = false;

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
 * Main application entry point
 */
async function main(): Promise<void> {
  // Check for help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
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
