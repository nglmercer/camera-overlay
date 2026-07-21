export interface CameraConfig {
    selected_camera_index?: number;
    resolution?: 'highest' | 'medium' | 'lowest';
    port?: number;
    mirror_horizontal?: boolean;
    mirror_vertical?: boolean;
    auto_start?: boolean;
    target_fps?: number;
}

export interface CameraDeviceInfo {
    index: number;
    name: string;
}

export interface CameraStatus {
    running: boolean;
    has_frame: boolean;
    memory_rss_kb?: number;
}

export interface StartResponse {
    ok: boolean;
    error?: string;
    running: boolean;
}

export interface StopResponse {
    ok: boolean;
    running: boolean;
}

/**
 * Canvas renderer utilizing off-thread createImageBitmap decoding.
 * Provides minimum latency and zero UI layout jank compared to standard <img> stream tag.
 */
export class CanvasStreamRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private ws: WebSocket | null = null;
    private active = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            throw new Error('Failed to obtain 2D rendering context');
        }
        this.ctx = context;
    }

    public start(): void {
        if (this.active) return;
        this.active = true;
        this.connect();
    }

    public stop(): void {
        this.active = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    private connect(): void {
        if (!this.active) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onmessage = async (event: MessageEvent) => {
            if (!this.active) return;
            try {
                const blob = new Blob([event.data as ArrayBuffer], { type: 'image/jpeg' });
                const bitmap = await createImageBitmap(blob);
                if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
                    this.canvas.width = bitmap.width;
                    this.canvas.height = bitmap.height;
                }
                this.ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
            } catch (e) {
                console.error('Error decoding/rendering WebSocket frame:', e);
            }
        };

        this.ws.onerror = () => {
            if (this.ws) this.ws.close();
        };

        this.ws.onclose = () => {
            if (this.active) {
                setTimeout(() => this.connect(), 1000);
            }
        };
    }
}
