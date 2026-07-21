import { CanvasStreamRenderer, CameraConfig, CameraDeviceInfo, CameraStatus, StartResponse } from './overlay';

class ConfigApp {
    private renderer: CanvasStreamRenderer | null = null;
    private config: CameraConfig = {};
    private statusPoll: number | null = null;

    constructor() {
        const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
        if (canvas) {
            this.renderer = new CanvasStreamRenderer(canvas);
        }
        this.bindEvents();
    }

    public async init(): Promise<void> {
        await this.loadConfig();
        await this.loadCameras();
        this.syncForm();
        await this.refreshStatus();
        this.statusPoll = window.setInterval(() => this.refreshStatus(), 2000);
    }

    private bindEvents(): void {
        document.getElementById('btn-start')?.addEventListener('click', () => this.startCamera());
        document.getElementById('btn-stop')?.addEventListener('click', () => this.stopCamera());
        document.getElementById('btn-snapshot')?.addEventListener('click', () => this.refreshSnapshot());
        document.getElementById('btn-copy-stream')?.addEventListener('click', () => this.copyUrl('stream-url'));
        document.getElementById('btn-copy-overlay')?.addEventListener('click', () => this.copyUrl('overlay-url'));

        const formInputs = ['resolution', 'port', 'mirror-h', 'mirror-v', 'auto-start', 'fps', 'camera-select'];
        formInputs.forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.updateConfig());
        });
    }

    private setError(msg: string): void {
        const el = document.getElementById('error-msg');
        if (!el) return;
        if (msg) {
            el.textContent = msg;
            el.classList.add('visible');
        } else {
            el.textContent = '';
            el.classList.remove('visible');
        }
    }

    private setRunningUi(running: boolean): void {
        const badge = document.getElementById('status-badge');
        const btnStart = document.getElementById('btn-start') as HTMLButtonElement | null;
        const btnStop = document.getElementById('btn-stop') as HTMLButtonElement | null;

        if (badge) {
            badge.textContent = running ? 'RUNNING' : 'OFF';
            badge.className = `status ${running ? 'status-on' : 'status-off'}`;
        }
        if (btnStart) btnStart.disabled = running;
        if (btnStop) btnStop.disabled = !running;
    }

    private showCanvasPreview(): void {
        const canvas = document.getElementById('preview-canvas');
        const placeholder = document.getElementById('preview-placeholder');
        if (canvas) canvas.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
        this.renderer?.start();
    }

    private hidePreview(): void {
        this.renderer?.stop();
        const canvas = document.getElementById('preview-canvas');
        const placeholder = document.getElementById('preview-placeholder');
        if (canvas) canvas.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }

    private async loadConfig(): Promise<void> {
        try {
            const r = await fetch('/settings');
            this.config = await r.json();
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    private async loadCameras(): Promise<void> {
        try {
            const r = await fetch('/cameras');
            const cameras: CameraDeviceInfo[] = await r.json();
            const sel = document.getElementById('camera-select') as HTMLSelectElement | null;
            if (!sel) return;
            sel.innerHTML = '';
            if (!cameras.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No cameras found';
                sel.appendChild(opt);
                return;
            }
            cameras.forEach(c => {
                const opt = document.createElement('option');
                opt.value = String(c.index);
                opt.textContent = c.name;
                sel.appendChild(opt);
            });
            if (this.config.selected_camera_index != null) {
                sel.value = String(this.config.selected_camera_index);
            } else {
                this.config.selected_camera_index = parseInt(sel.value, 10) || 0;
            }
        } catch (e) {
            console.error('Failed to load cameras:', e);
        }
    }

    private syncForm(): void {
        const setVal = (id: string, val: string | number) => {
            const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
            if (el) el.value = String(val);
        };
        const setChecked = (id: string, val: boolean) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (el) el.checked = val;
        };

        setVal('resolution', this.config.resolution || 'medium');
        setVal('port', this.config.port || 8080);
        setChecked('mirror-h', this.config.mirror_horizontal || false);
        setChecked('mirror-v', this.config.mirror_vertical || false);
        setChecked('auto-start', this.config.auto_start || false);
        setVal('fps', this.config.target_fps || 30);
        this.updateUrls();
    }

    private updateUrls(): void {
        const portEl = document.getElementById('port') as HTMLInputElement | null;
        const hEl = document.getElementById('mirror-h') as HTMLInputElement | null;
        const vEl = document.getElementById('mirror-v') as HTMLInputElement | null;

        const port = portEl ? portEl.value : '8080';
        const h = hEl ? hEl.checked : false;
        const v = vEl ? vEl.checked : false;

        let overlayUrl = `http://localhost:${port}/`;
        const params: string[] = [];
        if (h) params.push('mirror_h');
        if (v) params.push('mirror_v');
        if (params.length) overlayUrl += '?' + params.join('&');

        const streamUrlInput = document.getElementById('stream-url') as HTMLInputElement | null;
        const overlayUrlInput = document.getElementById('overlay-url') as HTMLInputElement | null;

        if (streamUrlInput) streamUrlInput.value = `http://localhost:${port}/stream`;
        if (overlayUrlInput) overlayUrlInput.value = overlayUrl;
    }

    private async updateConfig(): Promise<void> {
        this.updateUrls();
        const getVal = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement)?.value;
        const getChecked = (id: string) => (document.getElementById(id) as HTMLInputElement)?.checked;

        this.config.resolution = getVal('resolution') as 'highest' | 'medium' | 'lowest';
        this.config.port = parseInt(getVal('port'), 10) || 8080;
        this.config.mirror_horizontal = getChecked('mirror-h');
        this.config.mirror_vertical = getChecked('mirror-v');
        this.config.auto_start = getChecked('auto-start');
        this.config.target_fps = parseInt(getVal('fps'), 10) || 30;

        const cam = getVal('camera-select');
        if (cam !== '') this.config.selected_camera_index = parseInt(cam, 10);

        await fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.config)
        });
    }

    private async refreshStatus(): Promise<void> {
        try {
            const r = await fetch('/status');
            if (!r.ok) return;
            const s: CameraStatus = await r.json();
            this.setRunningUi(s.running);
            if (s.running) {
                this.showCanvasPreview();
            } else {
                this.hidePreview();
            }
        } catch (_) { /* ignore status poll errors */ }
    }

    private async startCamera(): Promise<void> {
        this.setError('');
        const btn = document.getElementById('btn-start') as HTMLButtonElement | null;
        if (btn) btn.disabled = true;

        try {
            await this.updateConfig();
            const r = await fetch('/start', { method: 'POST' });
            let body: StartResponse = { ok: false, running: false };
            try { body = await r.json(); } catch (_) {}
            if (!r.ok || body.ok === false) {
                this.setRunningUi(false);
                this.hidePreview();
                this.setError(body.error || `Start failed (HTTP ${r.status})`);
                return;
            }
            this.setRunningUi(true);
            this.showCanvasPreview();
        } catch (e: unknown) {
            this.setRunningUi(false);
            this.hidePreview();
            const err = e as Error;
            this.setError(err.message || String(e));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    private async stopCamera(): Promise<void> {
        this.setError('');
        await fetch('/stop', { method: 'POST' });
        this.setRunningUi(false);
        this.hidePreview();
    }

    private async refreshSnapshot(): Promise<void> {
        this.setError('');
        const r = await fetch('/snapshot');
        if (r.ok) {
            const blob = await r.blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement | null;
            if (canvas) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d');
                ctx?.drawImage(bitmap, 0, 0);
                canvas.style.display = 'block';
                const placeholder = document.getElementById('preview-placeholder');
                if (placeholder) placeholder.style.display = 'none';
            }
            bitmap.close();
        } else {
            const text = await r.text();
            this.setError(text || `Snapshot unavailable (HTTP ${r.status}). Start the camera first.`);
        }
    }

    private copyUrl(id: string): void {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) {
            el.select();
            navigator.clipboard.writeText(el.value);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new ConfigApp();
    app.init();
});
