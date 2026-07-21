import { CanvasStreamRenderer } from './overlay';

class OverlayApp {
    private renderer: CanvasStreamRenderer | null = null;
    private canvas: HTMLCanvasElement;
    private isStreaming = false;

    constructor() {
        this.canvas = document.getElementById('camera-canvas') as HTMLCanvasElement;
        if (!this.canvas) {
            throw new Error('Camera canvas element not found');
        }
        this.renderer = new CanvasStreamRenderer(this.canvas);
        this.applyParams();
    }

    private applyParams(): void {
        const params = new URLSearchParams(window.location.search);
        if (params.has('mirror_h')) this.canvas.classList.add('mirror-h');
        if (params.has('mirror_v')) this.canvas.classList.add('mirror-v');
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
                this.canvas.style.display = 'block';
                this.renderer?.start();
                this.isStreaming = true;
            } else if (!status.running && this.isStreaming) {
                this.renderer?.stop();
                this.canvas.style.display = 'none';
                this.isStreaming = false;
            }
        } catch (_) {
            // Ignore poll errors
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new OverlayApp();
    app.init();
});
