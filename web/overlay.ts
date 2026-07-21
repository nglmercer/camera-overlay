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

export interface SdpMessage {
    type: string;
    sdp: string;
}

/**
 * Canvas renderer utilizing off-thread createImageBitmap decoding.
 * Provides minimum latency and zero UI layout jank compared to standard <img> stream tag.
 * Used as a fallback when WebRTC is not available.
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

/**
 * WebRTC stream renderer.
 * Negotiates an offer/answer SDP with the Rust server, then renders
 * the incoming MediaStream into a <video autoplay muted> element.
 * Provides the lowest possible latency — sub-frame delivery via RTP.
 */
export class WebRTCStreamRenderer {
    private videoEl: HTMLVideoElement;
    private pc: RTCPeerConnection | null = null;
    private active = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(videoEl: HTMLVideoElement) {
        this.videoEl = videoEl;
    }

    public start(): void {
        if (this.active) return;
        this.active = true;
        void this.negotiate();
    }

    public stop(): void {
        this.active = false;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
        this.videoEl.srcObject = null;
        this.videoEl.pause();
    }

    private async negotiate(): Promise<void> {
        if (!this.active) return;

        try {
            this.pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });

            // Receive remote video track
            this.pc.ontrack = (event: RTCTrackEvent) => {
                if (event.streams && event.streams[0]) {
                    this.videoEl.srcObject = event.streams[0];
                    // Ensure autoplay muted is set
                    this.videoEl.muted = true;
                    this.videoEl.autoplay = true;
                    void this.videoEl.play().catch(() => {
                        // Autoplay policy: already muted so this should succeed
                    });
                }
            };

            this.pc.onconnectionstatechange = () => {
                const state = this.pc?.connectionState;
                if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                    if (this.active) {
                        this.retryTimer = setTimeout(() => {
                            void this.negotiate();
                        }, 2000);
                    }
                }
            };

            // Add a receive-only transceiver for video
            this.pc.addTransceiver('video', { direction: 'recvonly' });

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // Send SDP offer to Rust server
            const response = await fetch('/webrtc/offer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: offer.type,
                    sdp: offer.sdp,
                }),
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status} for /webrtc/offer`);
            }

            const answer: SdpMessage = await response.json();
            await this.pc.setRemoteDescription(new RTCSessionDescription(answer));

        } catch (err) {
            console.error('WebRTC negotiation failed:', err);
            if (this.active) {
                this.retryTimer = setTimeout(() => {
                    void this.negotiate();
                }, 3000);
            }
        }
    }
}
