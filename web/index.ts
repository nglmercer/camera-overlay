import { OverlayApi, restoreOverlayState } from './api';
import { CanvasStreamRenderer } from './overlay';

class OverlayApp {
    private readonly wsRenderer: CanvasStreamRenderer;
    private readonly canvas: HTMLCanvasElement;
    private readonly api: OverlayApi;
    private isStreaming = false;

    constructor() {
        const canvas = document.getElementById('camera-canvas') as HTMLCanvasElement;
        if (!canvas) throw new Error('Camera canvas element not found');

        this.canvas = canvas;
        this.wsRenderer = new CanvasStreamRenderer(canvas);
        this.api = new OverlayApi(canvas, this.wsRenderer);
        window.cameraOverlay = this.api;
        restoreOverlayState(this.api);
        this.applyParams();
        this.wsRenderer.setOverlayHandler((state) => this.api.set(state as Parameters<typeof this.api.set>[0]));
    }

    private applyParams(): void {
        const params = new URLSearchParams(window.location.search);
        this.api.mirror({
            h: params.has('mirror_h') || this.api.getState().mirrorH,
            v: params.has('mirror_v') || this.api.getState().mirrorV,
        });
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
        this.api.show();
        this.canvas.style.display = 'block';
        this.wsRenderer.start();
    }

    private stopStream(): void {
        this.wsRenderer.stop();
        this.api.hide();
        this.canvas.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new OverlayApp();
    app.init();
});
