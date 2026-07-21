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

        // Prefer WebRTC if RTCPeerConnection is available
        if (typeof RTCPeerConnection !== 'undefined') {
            this.mode = 'webrtc';
            this.webrtcRenderer = new WebRTCStreamRenderer(this.videoEl);
        } else {
            this.mode = 'websocket';
            this.wsRenderer = new CanvasStreamRenderer(this.canvas);
        }

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

    private startStream(): void {
        if (this.mode === 'webrtc' && this.webrtcRenderer) {
            this.videoEl.style.display = 'block';
            this.canvas.style.display = 'none';
            this.webrtcRenderer.start();
        } else if (this.wsRenderer) {
            this.canvas.style.display = 'block';
            this.videoEl.style.display = 'none';
            this.wsRenderer.start();
        }
    }

    private stopStream(): void {
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
