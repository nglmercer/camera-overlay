/**
 * Frame conversion utilities for camera rendering
 * Provides optimized conversion from various camera formats to RGBA
 */

export interface FrameData {
  data: Buffer;
  width: number;
  height: number;
  format: string;
}

/**
 * Convert camera frame data to RGBA buffer for rendering
 * Uses fast nearest-neighbor scaling for better performance
 * Quality setting: 'fast' (nearest neighbor) or 'quality' (bilinear)
 */
export function convertFrameToRGBABuffer(
  frame: FrameData,
  bufferWidth: number,
  bufferHeight: number,
  quality: 'fast' | 'quality' = 'fast'
): Buffer {
  const targetSize = bufferWidth * bufferHeight * 4;
  const buffer = Buffer.alloc(targetSize);

  const sourceData = frame.data;
  const sourceWidth = frame.width;
  const sourceHeight = frame.height;

  // Fast path: no scaling needed
  if (sourceWidth === bufferWidth && sourceHeight === bufferHeight) {
    return convertFrameToRGBABufferNoScale(frame, buffer);
  }

  // Calculate scaling factors
  const scaleX = sourceWidth / bufferWidth;
  const scaleY = sourceHeight / bufferHeight;

  // Handle different source formats
  if (frame.format === 'RGB' || frame.format === 'MJPEG' || frame.format === 'YUYV') {
    if (quality === 'fast') {
      convertRGBToRGBAWithNearestNeighbor(sourceData, buffer, sourceWidth, sourceHeight, bufferWidth, bufferHeight, scaleX, scaleY);
    } else {
      convertRGBToRGBAWithScaling(sourceData, buffer, sourceWidth, sourceHeight, bufferWidth, bufferHeight, scaleX, scaleY);
    }
  } else if (frame.format === 'RGBA') {
    if (quality === 'fast') {
      convertRGBAToRGBAWithNearestNeighbor(sourceData, buffer, sourceWidth, sourceHeight, bufferWidth, bufferHeight, scaleX, scaleY);
    } else {
      convertRGBAToRGBAWithScaling(sourceData, buffer, sourceWidth, sourceHeight, bufferWidth, bufferHeight, scaleX, scaleY);
    }
  } else {
    fillGradient(buffer, bufferWidth, bufferHeight);
  }

  return buffer;
}

/**
 * Fast path: convert without scaling when dimensions match
 */
function convertFrameToRGBABufferNoScale(frame: FrameData, buffer: Buffer): Buffer {
  const sourceData = frame.data;
  const pixelCount = frame.width * frame.height;

  if (frame.format === 'RGB' || frame.format === 'MJPEG' || frame.format === 'YUYV') {
    // RGB to RGBA
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * 3;
      const dstIdx = i * 4;
      buffer[dstIdx] = sourceData[srcIdx] ?? 0;
      buffer[dstIdx + 1] = sourceData[srcIdx + 1] ?? 0;
      buffer[dstIdx + 2] = sourceData[srcIdx + 2] ?? 0;
      buffer[dstIdx + 3] = 255;
    }
  } else if (frame.format === 'RGBA') {
    // Direct copy
    sourceData.copy(buffer);
  } else {
    fillGradient(buffer, frame.width, frame.height);
  }

  return buffer;
}

/**
 * Convert RGB to RGBA with bilinear interpolation scaling
 */
function convertRGBToRGBAWithScaling(
  sourceData: Buffer,
  buffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  bufferWidth: number,
  bufferHeight: number,
  scaleX: number,
  scaleY: number
): void {
  for (let y = 0; y < bufferHeight; y++) {
    const srcY = y * scaleY;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, sourceHeight - 1);
    const fy = srcY - y0;

    for (let x = 0; x < bufferWidth; x++) {
      const srcX = x * scaleX;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, sourceWidth - 1);
      const fx = srcX - x0;

      // Bilinear interpolation
      const idx00 = (y0 * sourceWidth + x0) * 3;
      const idx10 = (y0 * sourceWidth + x1) * 3;
      const idx01 = (y1 * sourceWidth + x0) * 3;
      const idx11 = (y1 * sourceWidth + x1) * 3;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const dstIdx = (y * bufferWidth + x) * 4;
      buffer[dstIdx] = Math.round(
        w00 * (sourceData[idx00] ?? 0) +
        w10 * (sourceData[idx10] ?? 0) +
        w01 * (sourceData[idx01] ?? 0) +
        w11 * (sourceData[idx11] ?? 0)
      );
      buffer[dstIdx + 1] = Math.round(
        w00 * (sourceData[idx00 + 1] ?? 0) +
        w10 * (sourceData[idx10 + 1] ?? 0) +
        w01 * (sourceData[idx01 + 1] ?? 0) +
        w11 * (sourceData[idx11 + 1] ?? 0)
      );
      buffer[dstIdx + 2] = Math.round(
        w00 * (sourceData[idx00 + 2] ?? 0) +
        w10 * (sourceData[idx10 + 2] ?? 0) +
        w01 * (sourceData[idx01 + 2] ?? 0) +
        w11 * (sourceData[idx11 + 2] ?? 0)
      );
      buffer[dstIdx + 3] = 255;
    }
  }
}

/**
 * Convert RGBA to RGBA with bilinear interpolation scaling
 */
function convertRGBAToRGBAWithScaling(
  sourceData: Buffer,
  buffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  bufferWidth: number,
  bufferHeight: number,
  scaleX: number,
  scaleY: number
): void {
  for (let y = 0; y < bufferHeight; y++) {
    const srcY = y * scaleY;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, sourceHeight - 1);
    const fy = srcY - y0;

    for (let x = 0; x < bufferWidth; x++) {
      const srcX = x * scaleX;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, sourceWidth - 1);
      const fx = srcX - x0;

      // Bilinear interpolation
      const idx00 = (y0 * sourceWidth + x0) * 4;
      const idx10 = (y0 * sourceWidth + x1) * 4;
      const idx01 = (y1 * sourceWidth + x0) * 4;
      const idx11 = (y1 * sourceWidth + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const dstIdx = (y * bufferWidth + x) * 4;
      buffer[dstIdx] = Math.round(
        w00 * (sourceData[idx00] ?? 0) +
        w10 * (sourceData[idx10] ?? 0) +
        w01 * (sourceData[idx01] ?? 0) +
        w11 * (sourceData[idx11] ?? 0)
      );
      buffer[dstIdx + 1] = Math.round(
        w00 * (sourceData[idx00 + 1] ?? 0) +
        w10 * (sourceData[idx10 + 1] ?? 0) +
        w01 * (sourceData[idx01 + 1] ?? 0) +
        w11 * (sourceData[idx11 + 1] ?? 0)
      );
      buffer[dstIdx + 2] = Math.round(
        w00 * (sourceData[idx00 + 2] ?? 0) +
        w10 * (sourceData[idx10 + 2] ?? 0) +
        w01 * (sourceData[idx01 + 2] ?? 0) +
        w11 * (sourceData[idx11 + 2] ?? 0)
      );
      buffer[dstIdx + 3] = Math.round(
        w00 * (sourceData[idx00 + 3] ?? 255) +
        w10 * (sourceData[idx10 + 3] ?? 255) +
        w01 * (sourceData[idx01 + 3] ?? 255) +
        w11 * (sourceData[idx11 + 3] ?? 255)
      );
    }
  }
}

/**
 * Convert RGB to RGBA with fast nearest-neighbor scaling
 * Much faster than bilinear interpolation
 */
function convertRGBToRGBAWithNearestNeighbor(
  sourceData: Buffer,
  buffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  bufferWidth: number,
  bufferHeight: number,
  scaleX: number,
  scaleY: number
): void {
  for (let y = 0; y < bufferHeight; y++) {
    const srcY = Math.min(Math.floor(y * scaleY), sourceHeight - 1);
    const rowOffset = srcY * sourceWidth;
    const dstRowOffset = y * bufferWidth;

    for (let x = 0; x < bufferWidth; x++) {
      const srcX = Math.min(Math.floor(x * scaleX), sourceWidth - 1);
      const srcIdx = (rowOffset + srcX) * 3;
      const dstIdx = (dstRowOffset + x) * 4;

      buffer[dstIdx] = sourceData[srcIdx] ?? 0;
      buffer[dstIdx + 1] = sourceData[srcIdx + 1] ?? 0;
      buffer[dstIdx + 2] = sourceData[srcIdx + 2] ?? 0;
      buffer[dstIdx + 3] = 255;
    }
  }
}

/**
 * Convert RGBA to RGBA with fast nearest-neighbor scaling
 * Much faster than bilinear interpolation
 */
function convertRGBAToRGBAWithNearestNeighbor(
  sourceData: Buffer,
  buffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  bufferWidth: number,
  bufferHeight: number,
  scaleX: number,
  scaleY: number
): void {
  for (let y = 0; y < bufferHeight; y++) {
    const srcY = Math.min(Math.floor(y * scaleY), sourceHeight - 1);
    const rowOffset = srcY * sourceWidth;
    const dstRowOffset = y * bufferWidth;

    for (let x = 0; x < bufferWidth; x++) {
      const srcX = Math.min(Math.floor(x * scaleX), sourceWidth - 1);
      const srcIdx = (rowOffset + srcX) * 4;
      const dstIdx = (dstRowOffset + x) * 4;

      buffer[dstIdx] = sourceData[srcIdx] ?? 0;
      buffer[dstIdx + 1] = sourceData[srcIdx + 1] ?? 0;
      buffer[dstIdx + 2] = sourceData[srcIdx + 2] ?? 0;
      buffer[dstIdx + 3] = sourceData[srcIdx + 3] ?? 255;
    }
  }
}

/**
 * Fill buffer with gradient for debugging unknown formats
 */
function fillGradient(buffer: Buffer, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      buffer[idx] = Math.floor(x * 255 / width);
      buffer[idx + 1] = Math.floor(y * 255 / height);
      buffer[idx + 2] = 128;
      buffer[idx + 3] = 255;
    }
  }
}

/**
 * Select best camera format based on preferences
 * Prioritizes MJPEG with highest resolution
 */
export interface CameraFormat {
  format: string;
  width: number;
  height: number;
  frameRate: number;
}

export function selectBestCameraFormat(
  formats: CameraFormat[],
  preferResolution: 'highest' | 'medium' | 'lowest' = 'highest'
): CameraFormat | null {
  if (formats.length === 0) return null;

  // Filter MJPEG formats
  const mjpegFormats = formats.filter(f => f.format === 'MJPEG');
  const formatsToConsider = mjpegFormats.length > 0 ? mjpegFormats : formats;

  // Sort by resolution and frame rate
  const sorted = formatsToConsider.sort((a, b) => {
    const resA = a.width * a.height;
    const resB = b.width * b.height;

    if (preferResolution === 'highest') {
      if (resB !== resA) return resB - resA;
      return b.frameRate - a.frameRate;
    } else if (preferResolution === 'lowest') {
      if (resA !== resB) return resA - resB;
      return b.frameRate - a.frameRate;
    } else {
      // Medium: prefer 720p or closest
      const targetRes = 1280 * 720;
      const diffA = Math.abs(resA - targetRes);
      const diffB = Math.abs(resB - targetRes);
      if (diffA !== diffB) return diffA - diffB;
      return b.frameRate - a.frameRate;
    }
  });

  return sorted[0] || null;
}
