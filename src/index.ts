import { WindowBuilder, EventLoop, PixelRenderer, RenderOptions, ScaleMode } from 'webview-napi'
import { createLogger } from './logger'
import { cameraAPI } from './camera-api'

const logger = createLogger('CameraRender')
// force x11
process.env.GDK_BACKEND = 'x11'

/**
 * Convert camera frame data to RGBA buffer for rendering
 * Camera frame may be RGB, RGBA, MJPEG, or YUYV format
 * The PixelRenderer expects a buffer of exactly bufferWidth * bufferHeight * 4 bytes
 */
function convertFrameToRGBABuffer(frame: { data: Buffer; width: number; height: number; format: string }, bufferWidth: number, bufferHeight: number): Buffer {
  const targetSize = bufferWidth * bufferHeight * 4;
  const buffer = Buffer.alloc(targetSize);

  const sourceData = frame.data;
  const sourceWidth = frame.width;
  const sourceHeight = frame.height;

  // Calculate scaling factors if source and target dimensions differ
  const scaleX = sourceWidth / bufferWidth;
  const scaleY = sourceHeight / bufferHeight;

  // Handle different source formats
  if (frame.format === 'RGB') {
    // Convert RGB to RGBA with scaling
    for (let y = 0; y < bufferHeight; y++) {
      for (let x = 0; x < bufferWidth; x++) {
        // Calculate source pixel coordinates (nearest neighbor)
        const srcX = Math.min(Math.floor(x * scaleX), sourceWidth - 1);
        const srcY = Math.min(Math.floor(y * scaleY), sourceHeight - 1);

        const srcIndex = (srcY * sourceWidth + srcX) * 3;
        const dstIndex = (y * bufferWidth + x) * 4;

        buffer[dstIndex] = sourceData[srcIndex] ?? 0;       // R
        buffer[dstIndex + 1] = sourceData[srcIndex + 1] ?? 0; // G
        buffer[dstIndex + 2] = sourceData[srcIndex + 2] ?? 0; // B
        buffer[dstIndex + 3] = 255; // A
      }
    }
  } else if (frame.format === 'RGBA') {
    // Already RGBA, copy with scaling
    for (let y = 0; y < bufferHeight; y++) {
      for (let x = 0; x < bufferWidth; x++) {
        const srcX = Math.min(Math.floor(x * scaleX), sourceWidth - 1);
        const srcY = Math.min(Math.floor(y * scaleY), sourceHeight - 1);

        const srcIndex = (srcY * sourceWidth + srcX) * 4;
        const dstIndex = (y * bufferWidth + x) * 4;

        buffer[dstIndex] = sourceData[srcIndex] ?? 0;       // R
        buffer[dstIndex + 1] = sourceData[srcIndex + 1] ?? 0; // G
        buffer[dstIndex + 2] = sourceData[srcIndex + 2] ?? 0; // B
        buffer[dstIndex + 3] = sourceData[srcIndex + 3] ?? 255; // A
      }
    }
  } else if (frame.format === 'MJPEG' || frame.format === 'YUYV') {
    // These formats should already be decoded by camera-api.ts to RGB
    // Convert RGB to RGBA with scaling
    for (let y = 0; y < bufferHeight; y++) {
      for (let x = 0; x < bufferWidth; x++) {
        const srcX = Math.min(Math.floor(x * scaleX), sourceWidth - 1);
        const srcY = Math.min(Math.floor(y * scaleY), sourceHeight - 1);

        const srcIndex = (srcY * sourceWidth + srcX) * 3;
        const dstIndex = (y * bufferWidth + x) * 4;

        buffer[dstIndex] = sourceData[srcIndex] ?? 0;       // R
        buffer[dstIndex + 1] = sourceData[srcIndex + 1] ?? 0; // G
        buffer[dstIndex + 2] = sourceData[srcIndex + 2] ?? 0; // B
        buffer[dstIndex + 3] = 255; // A
      }
    }
  } else {
    // Unknown format, fill with gradient for debugging
    for (let y = 0; y < bufferHeight; y++) {
      for (let x = 0; x < bufferWidth; x++) {
        const index = (y * bufferWidth + x) * 4;
        buffer[index] = Math.floor(x * 255 / bufferWidth);       // R
        buffer[index + 1] = Math.floor(y * 255 / bufferHeight);  // G
        buffer[index + 2] = 128;                       // B
        buffer[index + 3] = 255;                       // A
      }
    }
  }

  return buffer;
}

/**
 * Main function to run camera render example
 */
async function main() {

  try {
    logger.info('Creating event loop...')
    logger.success('Event loop created')

    // Window configuration
    const windowWidth = 800
    const windowHeight = 600

    logger.section('Window Configuration')
    logger.info('Creating window for camera rendering...')
    logger.object('Window dimensions', { width: windowWidth, height: windowHeight })
    const eventLoop = new EventLoop();
    const builder = new WindowBuilder()
      .withTitle('Camera Feed')
      .withInnerSize(windowWidth, windowHeight)
      .withPosition(100, 100)
      .withResizable(true)
      .withDecorated(true)
      .withVisible(true)
      .withFocused(true)

    const window = builder.build(eventLoop)
    logger.success('Window created', { windowId: window.id })

    // Create pixel renderer with options
    const options: RenderOptions = {
      bufferWidth: windowWidth,
      bufferHeight: windowHeight,
      scaleMode: ScaleMode.Fit,
      backgroundColor: [0, 0, 0, 255]
    }
    const renderer = PixelRenderer.withOptions(options)
    logger.success('Pixel renderer created', {
      bufferWidth: options.bufferWidth,
      bufferHeight: options.bufferHeight
    })

    logger.info('Renderer configured', {
      scaleMode: options.scaleMode,
      backgroundColor: options.backgroundColor
    })

    // List available cameras
    logger.section('Camera Setup')
    const cameras = cameraAPI.listCameras()
    logger.info('Available cameras:', { count: cameras.length, cameras: cameras.map(c => c.name) })
    
    if (cameras.length === 0) {
      logger.error('No cameras found! Please connect a camera.')
      process.exit(1)
    }

    // Select the first available camera
    const selectedCamera = cameras[0]
    if (!selectedCamera) {
      logger.error('Failed to get camera info')
      process.exit(1)
    }
    logger.info('Selecting camera:', { index: selectedCamera.index, name: selectedCamera.name })
    
    if (!cameraAPI.selectCamera(selectedCamera.index)) {
      logger.error('Failed to select camera')
      process.exit(1)
    }
    logger.success('Camera selected')

    // Create a placeholder buffer for initial rendering
    const placeholderBuffer = Buffer.alloc(windowWidth * windowHeight * 4)
    for (let i = 0; i < placeholderBuffer.length; i += 4) {
      placeholderBuffer[i] = 50;     // R
      placeholderBuffer[i + 1] = 50; // G
      placeholderBuffer[i + 2] = 50; // B
      placeholderBuffer[i + 3] = 255; // A
    }
    
    // Render initial frame
    renderer.render(window, placeholderBuffer)
    logger.info('Initial placeholder frame rendered')

    // Frame callback for camera
    let frameCount = 0
    let lastFpsUpdate = Date.now()
    let fps = 0

    const frameCallback = (frame: { data: Buffer; width: number; height: number; format: string }) => {
      try {
        // Convert frame to RGBA buffer
        const buffer = convertFrameToRGBABuffer(frame, windowWidth, windowHeight)
        
        // Render the buffer to the window
        renderer.render(window, buffer)
        frameCount++
        fps++

        // Log FPS every second
        const now = Date.now()
        if (now - lastFpsUpdate >= 1000) {
          logger.info(`FPS: ${fps}, Total frames: ${frameCount}`)
          fps = 0
          lastFpsUpdate = now
        }

        // Log frame info occasionally
        if (frameCount <= 5 || frameCount % 60 === 0) {
          //logger.debug(`Frame ${frameCount}: ${frame.width}x${frame.height} ${frame.format}, data len: ${frame.data.length}`)
        }
      } catch (error) {
        logger.error('Error rendering frame', {
          frame: frameCount,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // Start camera stream
    logger.info('Starting camera stream...')
    if (!cameraAPI.startStream(frameCallback)) {
      logger.error('Failed to start camera stream')
      process.exit(1)
    }
    logger.success('Camera stream started')

    logger.info('Window is open. Right-click tray icon to change camera. Press Ctrl+C to exit.')

    // Start the event loop
    logger.section('Starting Event Loop')
    const poll = () => {
        if (eventLoop.runIteration()) {
            window.id;
            setTimeout(poll, 10);
        } else {
            cameraAPI.stopStream()
            process.exit(0);
        }
    };
    poll()

  } catch (error) {
    logger.error('Error executing camera render example', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    process.exit(1)
  }
}

main()
