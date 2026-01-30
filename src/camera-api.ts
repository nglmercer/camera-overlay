import { listCameras, Camera, bufMjpegToRgb, bufYuyv422ToRgb, type Frame, type CameraFormat as NokhwaCameraFormat, FrameFormat } from 'nokhwa-node';
import { selectBestCameraFormat, type CameraFormat } from './frame-converter';

// Type definitions based on nokhwa-node API
interface NokhwaCameraInfo {
    index: string;
    name: string;
}

export interface CameraDevice {
    index: string;
    name: string;
}

export interface CameraFrame {
    data: Buffer;
    width: number;
    height: number;
    format: string;
}

export class CameraAPI {
    private cameras: CameraDevice[] = [];
    private activeCamera: Camera | null = null;
    private isStreaming: boolean = false;
    private frameCallback: ((frame: CameraFrame) => void) | null = null;
    private streamInterval: Timer | null = null;
    private frameCount: number = 0;
    private targetFps: number = 30;
    private lastFrameTime: number = 0;

    /**
     * List all available cameras
     */
    listCameras(): CameraDevice[] {
        try {
            const nokhwaCameras = listCameras() as NokhwaCameraInfo[];
            this.cameras = nokhwaCameras.map(cam => ({
                index: cam.index.toString(),
                name: cam.name
            }));
            return this.cameras;
        } catch (error) {
            console.error("Failed to list cameras:", error);
            return [];
        }
    }

    /**
     * Get cached camera list (without querying hardware)
     */
    getCachedCameras(): CameraDevice[] {
        return this.cameras;
    }

    /**
     * Select and initialize a camera by index
     */
    selectCamera(cameraIndex: string): boolean {
        try {
            // Stop any active stream first
            this.stopStream();

            // Create new camera instance
            this.activeCamera = new Camera(cameraIndex);

            // CRITICAL: nokhwa-node often auto-opens the camera. 
            // We MUST stop it to change settings or set requests, 
            // otherwise we get "Device or resource busy" errors.
            try {
                if (this.activeCamera.isStreamOpen()) {
                    this.activeCamera.stopStream();
                    console.log("Stopped auto-opened camera stream to allow configuration");
                }
            } catch (e) {
                console.warn("Error during initial camera stop:", e);
            }

            // Query and log all compatible formats, prefer MJPEG
            try {
                const compatibleFormats = this.activeCamera.compatibleCameraFormats();
                if (compatibleFormats.length > 0) {
                    console.log(`Found ${compatibleFormats.length} compatible formats:`);
                    compatibleFormats.forEach((fmt, i) => {
                        console.log(`  [${i}] ${fmt.format} ${fmt.resolution.width}x${fmt.resolution.height} @ ${fmt.frameRate}fps`);
                    });

                    // Use frame-converter to select best format
                    const preferredRes = (process.env.CAMERA_RESOLUTION as 'highest' | 'medium' | 'lowest') || 'highest';
                    const bestFormat = selectBestCameraFormat(
                        compatibleFormats.map(f => ({
                            format: f.format as string,
                            width: f.resolution.width,
                            height: f.resolution.height,
                            frameRate: f.frameRate
                        })),
                        preferredRes
                    );
                    if (bestFormat) {
                        console.log(`Selected format: ${bestFormat.format} ${bestFormat.width}x${bestFormat.height} @ ${bestFormat.frameRate}fps (${preferredRes})`);
                    } else {
                        console.log(`No format selected, using: ${compatibleFormats[0]!.format} ${compatibleFormats[0]!.resolution.width}x${compatibleFormats[0]!.resolution.height}`);
                    }
                }
            } catch (formatError) {
                console.warn("Could not query compatible formats:", formatError);
            }

            console.log(`Camera selected and configured: ${cameraIndex}`);
            return true;
        } catch (error) {
            console.error(`Failed to select camera ${cameraIndex}:`, error);
            this.activeCamera = null;
            return false;
        }
    }

    /**
     * Start capturing frames from the selected camera
     */
    startStream(frameCallback: (frame: CameraFrame) => void): boolean {
        if (!this.activeCamera) {
            console.error("No camera selected");
            return false;
        }

        try {
            this.frameCallback = frameCallback;
            this.frameCount = 0;

            try {
                // Try to set MJPEG format explicitly before opening stream
                const compatibleFormats = this.activeCamera.compatibleCameraFormats();
                const preferredRes = (process.env.CAMERA_RESOLUTION as 'highest' | 'medium' | 'lowest') || 'highest';
                const bestFormat = selectBestCameraFormat(
                    compatibleFormats.map(f => ({
                        format: f.format as string,
                        width: f.resolution.width,
                        height: f.resolution.height,
                        frameRate: f.frameRate
                    })),
                    preferredRes
                );

                if (bestFormat) {
                    console.log(`Requesting format: ${bestFormat.format} ${bestFormat.width}x${bestFormat.height} @ ${bestFormat.frameRate}fps (${preferredRes})...`);
                } else {
                    console.log("MJPEG not available, using automatic format selection...");
                }

                // Set camera request for highest resolution (this helps with format selection)
                this.activeCamera.setCameraRequest({
                    requestType: 'AbsoluteHighestResolution' as any
                });
            } catch (e) {
                console.warn("Could not set camera request:", e);
            }

            console.log("Opening camera stream...");
            this.activeCamera.openStream();
            
            this.isStreaming = true;
            console.log("Camera stream starting, waiting for stabilization...");

            // Start frame capture loop with dynamic FPS based on camera format
            const capture = () => {
                if (!this.isStreaming || !this.activeCamera) return;

                const now = Date.now();
                const elapsed = now - this.lastFrameTime;
                const frameInterval = 1000 / this.targetFps;

                // Capture frame
                this.captureFrame();
                this.lastFrameTime = now;

                // Schedule next frame with dynamic timing
                const nextFrameDelay = Math.max(1, frameInterval - (Date.now() - now));
                this.streamInterval = setTimeout(capture, nextFrameDelay) as any;
            };

            // Wait for stabilization and get actual camera FPS
            setTimeout(() => {
                if (this.isStreaming && this.activeCamera) {
                    // Get actual camera format to set correct FPS
                    try {
                        const format = this.activeCamera.cameraFormat();
                        this.targetFps = format.frameRate;
                        console.log(`Camera stream ready at ${format.resolution.width}x${format.resolution.height} @ ${this.targetFps}fps`);
                    } catch {
                        console.log("Camera stream ready");
                    }
                    this.lastFrameTime = Date.now();
                    capture();
                }
            }, 1000); // 1 second stabilization

            return true;
        } catch (error) {
            console.error("Failed to start stream:", error);
            this.isStreaming = false;
            return false;
        }
    }

    /**
     * Stop the camera stream
     */
    stopStream(): void {
        if (this.streamInterval) {
            clearTimeout(this.streamInterval);
            this.streamInterval = null;
        }

        if (this.activeCamera) {
            try {
                // Check if stream is open before trying to stop
                if (this.activeCamera.isStreamOpen()) {
                    this.activeCamera.stopStream();
                }
            } catch (error) {
                console.error("Error stopping stream:", error);
            }
        }

        this.isStreaming = false;
        this.frameCallback = null;
        console.log("Camera stream stopped");
    }

    /**
     * Capture a single frame with retry logic
     */
    private captureFrame(): void {
        if (!this.activeCamera || !this.isStreaming || !this.frameCallback) {
            return;
        }

        // Check if stream is actually open
        if (!this.activeCamera.isStreamOpen()) {
            return;
        }

        if (this.frameCount < 5) {
            console.log(`Capturing frame ${this.frameCount + 1}...`);
        }
        this.frameCount++;
        
        try {
            // Use the native captureFrame method directly
            const frame = this.activeCamera.captureFrame();
            //console.log(`Frame ${this.frameCount} captured successfully, data len: ${frame?.data?.length}`);

            if (!frame || !frame.data || frame.data.length === 0) {
                return;
            }

            // Use dimensions from the frame itself
            const width = frame.width;
            const height = frame.height;
            let formatStr = "RGBA";

            try {
                const camFormat = this.activeCamera.cameraFormat();
                formatStr = camFormat.format;
            } catch {
                // Keep default formatStr if cameraFormat fails
            }

            let decodedData: Buffer = frame.data;

            // Handle decoding if needed
            // Check if data is already uncompressed (nokhwa sometimes autodocodes or reports incorrectly)
            const expectedRgbaSize = width * height * 4;
            const expectedRgbSize = width * height * 3;
            if (frame.data.length === expectedRgbaSize) {
                 formatStr = "RGBA";
            } else if (frame.data.length === expectedRgbSize) {
                 formatStr = "RGB";
            }

            if (formatStr === "MJPEG") {
                try {
                    // Safety check for MJPEG data
                    if (frame.data.length < 10) throw new Error("MJPEG frame too small");
                    const rgbData = bufMjpegToRgb(width, height, frame.data);
                    if (rgbData) {
                        decodedData = rgbData;
                        formatStr = "RGB"; 
                    }
                } catch (decodeError) {
                    if (this.frameCount % 60 === 1) console.error("Failed to decode MJPEG frame:", decodeError);
                }
            } else if (formatStr === "YUYV") {
                try {
                    const rgbData = bufYuyv422ToRgb(width, height, frame.data);
                    if (rgbData) {
                        decodedData = rgbData;
                        formatStr = "RGB";
                    }
                } catch (decodeError) {
                    if (this.frameCount % 60 === 1) console.error("Failed to decode YUYV frame:", decodeError);
                }
            }

            this.frameCallback({
                data: decodedData,
                width: width,
                height: height,
                format: formatStr
            });
        } catch (error) {
            if (this.frameCount % 30 === 1) {
                console.error("Frame capture error:", error);
            }
        }
    }

    /**
     * Check if camera is currently streaming
     */
    getIsStreaming(): boolean {
        return this.isStreaming;
    }

    /**
     * Check if a camera is selected
     */
    hasSelectedCamera(): boolean {
        return this.activeCamera !== null;
    }

    /**
     * Get current camera format info
     */
    getCameraFormat(): { width: number; height: number; format: string } | null {
        if (!this.activeCamera) {
            return null;
        }

        try {
            const format = this.activeCamera.cameraFormat();
            return {
                width: format.resolution.width,
                height: format.resolution.height,
                format: format.format
            };
        } catch (error) {
            console.error("Failed to get camera format:", error);
            return null;
        }
    }

    /**
     * Get camera info
     */
    getCameraInfo(): NokhwaCameraInfo | null {
        if (!this.activeCamera) {
            return null;
        }

        try {
            return this.activeCamera.info();
        } catch (error) {
            console.error("Failed to get camera info:", error);
            return null;
        }
    }

    /**
     * Check if stream is open
     */
    isStreamOpen(): boolean {
        if (!this.activeCamera) {
            return false;
        }

        try {
            return this.activeCamera.isStreamOpen();
        } catch (error) {
            console.error("Failed to check stream status:", error);
            return false;
        }
    }

    /**
     * Cleanup resources
     */
    dispose(): void {
        this.stopStream();
        this.activeCamera = null;
        this.cameras = [];
    }
}

// Export singleton instance
export const cameraAPI = new CameraAPI();
