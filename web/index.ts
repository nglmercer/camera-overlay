import { CanvasStreamRenderer, WebRTCStreamRenderer } from './overlay';

type StreamMode = 'webrtc' | 'websocket';

class OverlayApp {
    private webrtcRenderer: WebRTCStreamRenderer | null = null;
    private wsRenderer: CanvasStreamRenderer | null = null;
    private videoEl: HTMLVideoElement;
    private canvas: HTMLCanvasElement;
    private isStreaming = false;
    private mode: StreamMode = 'webrtc';

    constructor() {
        this.videoEl = document.getElementById('camera-video') as HTMLVideoElement;
        this.canvas = document.getElementById('camera-canvas') as HTMLCanvasElement;

        if (!this.videoEl || !this.canvas) {
            throw new Error('Camera video/canvas elements not found');
        }

        // Use WebSocket canvas renderer for zero-latency raw JPEG frame rendering
        this.mode = 'websocket';
        this.wsRenderer = new CanvasStreamRenderer(this.canvas);

        this.applyParams();
    }

    private applyParams(): void {
        const params = new URLSearchParams(window.location.search);
        if (params.has('mirror_h')) {
            this.videoEl.classList.add('mirror-h');
            this.canvas.classList.add('mirror-h');
        }
        if (params.has('mirror_v')) {
            this.videoEl.classList.add('mirror-v');
            this.canvas.classList.add('mirror-v');
        }
    }

    public async init(): Promise<void> {
        await this.checkStatusAndConnect();
        window.setInterval(() => this.checkStatusAndConnect(), 3000);
    }

    private async checkStatusAndConnect(): Promise<void> {
        try {
            const r = await fetch('/status');
            if (!r.ok) return;
            const status = await r.json();

            if (status.running && !this.isStreaming) {
                this.startStream();
                this.isStreaming = true;
            } else if (!status.running && this.isStreaming) {
                this.stopStream();
                this.isStreaming = false;
            }
        } catch (_) {
            // Ignore poll errors
        }
    }

    private fallbackTimer: number | null = null;

    private startStream(): void {
        console.log(`[OverlayApp] Starting stream in mode: ${this.mode}`);
        
        // Instantiate WebSocket renderer as fallback option
        if (!this.wsRenderer) {
            this.wsRenderer = new CanvasStreamRenderer(this.canvas);
        }

        if (this.mode === 'webrtc' && this.webrtcRenderer) {
            this.videoEl.style.display = 'block';
            this.canvas.style.display = 'none';
            this.webrtcRenderer.start();

            // Fallback check: if WebRTC video isn't playing within 4 seconds, switch to WebSocket canvas
            if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
            this.fallbackTimer = window.setTimeout(() => {
                if (this.videoEl.paused || this.videoEl.readyState < 2) {
                    console.warn('[OverlayApp] WebRTC stream not playing after 4s. Falling back to low-latency WebSocket stream!');
                    this.switchToWebSocket();
                }
            }, 4000);
        } else {
            this.switchToWebSocket();
        }
    }

    private switchToWebSocket(): void {
        console.log('[OverlayApp] Activating WebSocket canvas stream...');
        this.mode = 'websocket';
        this.webrtcRenderer?.stop();
        this.videoEl.style.display = 'none';
        this.canvas.style.display = 'block';
        if (!this.wsRenderer) {
            this.wsRenderer = new CanvasStreamRenderer(this.canvas);
        }
        this.wsRenderer.start();
    }

    private stopStream(): void {
        if (this.fallbackTimer !== null) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
        this.webrtcRenderer?.stop();
        this.wsRenderer?.stop();
        this.videoEl.style.display = 'none';
        this.canvas.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new OverlayApp();
    app.init();
});
