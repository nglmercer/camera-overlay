import { WindowBuilder, EventLoop, PixelRenderer, RenderOptions, ScaleMode } from 'webview-napi'
import { createLogger } from './logger'
import { cameraAPI } from './camera-api'
import { convertFrameToRGBABuffer } from './frame-converter'

const logger = createLogger('CameraRender')
// force x11
process.env.GDK_BACKEND = 'x11'

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

    // Get camera resolution first to match renderer buffer size
    const cameras = cameraAPI.listCameras()
    let cameraWidth = windowWidth
    let cameraHeight = windowHeight

    if (cameras.length > 0) {
      // Select camera first to query its format
      const selectedCamera = cameras[0]
      if (selectedCamera && cameraAPI.selectCamera(selectedCamera.index)) {
        const format = cameraAPI.getCameraFormat()
        if (format) {
          cameraWidth = format.width
          cameraHeight = format.height
          logger.info(`Camera native resolution: ${cameraWidth}x${cameraHeight}`)
        }
      }
    }

    // Create pixel renderer with camera native resolution for best quality
    const options: RenderOptions = {
      bufferWidth: cameraWidth,
      bufferHeight: cameraHeight,
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
    logger.info('Available cameras:', { count: cameras.length, cameras: cameras.map(c => c.name) })

    if (cameras.length === 0) {
      logger.error('No cameras found! Please connect a camera.')
      process.exit(1)
    }

    // Select the first available camera (already selected earlier for resolution query)
    const selectedCamera = cameras[0]
    if (!selectedCamera) {
      logger.error('Failed to get camera info')
      process.exit(1)
    }
    logger.info('Selecting camera:', { index: selectedCamera.index, name: selectedCamera.name })

    // Camera was already selected earlier, just verify it's still selected
    if (!cameraAPI.hasSelectedCamera()) {
      if (!cameraAPI.selectCamera(selectedCamera.index)) {
        logger.error('Failed to select camera')
        process.exit(1)
      }
    }
    logger.success('Camera selected')

    // Create a placeholder buffer for initial rendering (use camera resolution)
    const placeholderBuffer = Buffer.alloc(cameraWidth * cameraHeight * 4)
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
        // Convert frame to RGBA buffer using camera native resolution with fast scaling
        const buffer = convertFrameToRGBABuffer(frame, cameraWidth, cameraHeight, 'fast')
        
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
