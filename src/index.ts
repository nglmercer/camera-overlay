import { WindowBuilder, EventLoopBuilder, PixelRenderer, RenderOptions, ScaleMode } from 'webview-napi'
import { createLogger } from './logger'

const logger = createLogger('BasicRender')
// force x11
process.env.GDK_BACKEND = 'x11'
/**
 * Create a black pixel buffer (RGBA format)
 */
function createBlackBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  // Fill with black (0, 0, 0, 255)
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 0     // R
    buffer[i + 1] = 0 // G
    buffer[i + 2] = 0 // B
    buffer[i + 3] = 255 // A
  }
  return buffer
}

/**
 * Create a white pixel buffer (RGBA format)
 */
function createWhiteBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  // Fill with white (255, 255, 255, 255)
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 255     // R
    buffer[i + 1] = 255 // G
    buffer[i + 2] = 255 // B
    buffer[i + 3] = 255 // A
  }
  return buffer
}

/**
 * Main function to run basic render example
 */
async function main() {

  try {
    logger.info('Creating event loop...')
    const eventLoopBuilder = new EventLoopBuilder()
    const eventLoop = eventLoopBuilder.build()
    logger.success('Event loop created')

    // Window configuration
    const windowWidth = 800
    const windowHeight = 600

    logger.section('Window Configuration')
    logger.info('Creating window for pixel rendering...')
    logger.object('Window dimensions', { width: windowWidth, height: windowHeight })

    const builder = new WindowBuilder()
      .withTitle('Basic Render - Black/White Frames')
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

    // Create black and white buffers
    logger.section('Creating Pixel Buffers')
    const blackBuffer = createBlackBuffer(windowWidth, windowHeight)
    const whiteBuffer = createWhiteBuffer(windowWidth, windowHeight)
    logger.success('Pixel buffers created', {
      blackBufferSize: blackBuffer.length,
      whiteBufferSize: whiteBuffer.length
    })

    logger.info('Press Ctrl+C to exit')

    let frameCount = 0
    const maxFrames = 10 // Render 10 frames (5 black, 5 white)

    const renderInterval = setInterval(() => {
      if (frameCount >= maxFrames) {
        clearInterval(renderInterval)
        logger.success('Frame rendering completed', { totalFrames: frameCount })
        logger.info('Window will remain open. Press Ctrl+C to exit.')
        return
      }

      const isBlackFrame = frameCount % 2 === 0
      const buffer = isBlackFrame ? blackBuffer : whiteBuffer
      const frameColor = isBlackFrame ? 'BLACK' : 'WHITE'

      try {
        // Render the buffer to the window
        renderer.render(window, buffer)
        frameCount++

        logger.info(`Frame ${frameCount}/${maxFrames} rendered`, {
          color: frameColor,
          bufferSize: buffer.length
        })
      } catch (error) {
        logger.error('Error rendering frame', {
          frame: frameCount,
          error: error instanceof Error ? error.message : String(error)
        })
        clearInterval(renderInterval)
      }
    }, 500) // Render a new frame every 500ms

    // Start the event loop
    logger.section('Starting Event Loop')
    const poll = () => {
        if (eventLoop.runIteration()) {
            window.id;
            setTimeout(poll, 10);
        } else {
            process.exit(0);
        }
    };
    poll()

  } catch (error) {
    logger.error('Error executing basic render example', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    process.exit(1)
  }
}

main()
