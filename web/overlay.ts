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

    /** Resolves when the RTCPeerConnection has finished gathering ICE candidates. */
    private waitForIceGathering(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (!this.pc || this.pc.iceGatheringState === 'complete') {
                console.log('[WebRTC Debug] ICE gathering already complete');
                resolve();
                return;
            }
            console.log('[WebRTC Debug] Waiting for ICE gathering to complete... current state:', this.pc.iceGatheringState);
            const check = () => {
                console.log('[WebRTC Debug] ICE gathering state changed to:', this.pc?.iceGatheringState);
                if (this.pc?.iceGatheringState === 'complete') {
                    this.pc.removeEventListener('icegatheringstatechange', check);
                    resolve();
                }
            };
            this.pc.addEventListener('icegatheringstatechange', check);
            // Safety timeout: if gathering stalls, proceed with whatever we have
            setTimeout(() => {
                console.warn('[WebRTC Debug] ICE gathering timeout reached (3s), proceeding with gathered candidates');
                this.pc?.removeEventListener('icegatheringstatechange', check);
                resolve();
            }, 3000);
        });
    }

    private async negotiate(): Promise<void> {
        if (!this.active) return;
        console.log('[WebRTC Debug] Starting SDP negotiation...');

        if (this.pc) {
            console.log('[WebRTC Debug] Closing existing RTCPeerConnection');
            this.pc.close();
            this.pc = null;
        }

        try {
            this.pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ],
            });

            this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
                if (event.candidate) {
                    console.log('[WebRTC Debug] Discovered ICE Candidate:', event.candidate.candidate);
                } else {
                    console.log('[WebRTC Debug] All ICE Candidates gathered');
                }
            };

            this.pc.oniceconnectionstatechange = () => {
                console.log('[WebRTC Debug] ICE Connection State:', this.pc?.iceConnectionState);
            };

            // Receive remote video track
            this.pc.ontrack = (event: RTCTrackEvent) => {
                console.log('[WebRTC Debug] Received remote track:', event.track.kind, event.streams);
                if (event.streams && event.streams[0]) {
                    this.videoEl.srcObject = event.streams[0];
                    // Ensure autoplay muted is set
                    this.videoEl.muted = true;
                    this.videoEl.autoplay = true;
                    this.videoEl.playsInline = true;
                    console.log('[WebRTC Debug] Attached MediaStream to <video> element. Attempting play()...');
                    void this.videoEl.play().then(() => {
                        console.log('[WebRTC Debug] <video> play() succeeded');
                    }).catch((err) => {
                        console.error('[WebRTC Debug] <video> play() failed:', err);
                    });
                }
            };

            this.pc.onconnectionstatechange = () => {
                const state = this.pc?.connectionState;
                console.log('[WebRTC Debug] Connection State Changed:', state);
                if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                    if (this.active) {
                        console.warn(`[WebRTC Debug] Connection state is ${state}, scheduling retry...`);
                        this.retryTimer = setTimeout(() => {
                            void this.negotiate();
                        }, 3000);
                    }
                }
            };

            // Add a receive-only transceiver for video
            console.log('[WebRTC Debug] Adding video transceiver (recvonly)');
            this.pc.addTransceiver('video', { direction: 'recvonly' });

            const offer = await this.pc.createOffer();
            console.log('[WebRTC Debug] Created local offer SDP:\n', offer.sdp);
            await this.pc.setLocalDescription(offer);

            // Wait for ICE gathering to finish so all host candidates are embedded
            await this.waitForIceGathering();

            const localSdp = this.pc.localDescription;
            if (!localSdp) throw new Error('No local description after ICE gathering');

            console.log('[WebRTC Debug] Sending final offer SDP to /webrtc/offer:\n', localSdp.sdp);

            // Send fully-gathered SDP offer to Rust server
            const response = await fetch('/webrtc/offer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: localSdp.type,
                    sdp: localSdp.sdp,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Server returned HTTP ${response.status} for /webrtc/offer: ${errText}`);
            }

            const answer: SdpMessage = await response.json();
            console.log('[WebRTC Debug] Received SDP Answer from server:\n', answer.sdp);
            await this.pc.setRemoteDescription(new RTCSessionDescription(answer as RTCSessionDescriptionInit));
            console.log('[WebRTC Debug] Remote description set successfully!');

        } catch (err) {
            console.error('[WebRTC Debug] WebRTC negotiation failed:', err);
            if (this.active) {
                this.retryTimer = setTimeout(() => {
                    void this.negotiate();
                }, 4000);
            }
        }
    }
}
