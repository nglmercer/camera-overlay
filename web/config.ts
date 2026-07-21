import { CanvasStreamRenderer, CameraConfig, CameraDeviceInfo, CameraStatus, StartResponse } from './overlay';
import { applyTranslations, getLocale, getLocaleOptions, setLocale, t, type Locale } from './i18n';

class ConfigApp {
    private wsRenderer: CanvasStreamRenderer | null = null;
    private config: CameraConfig = {};
    private statusPoll: number | null = null;
    private copyResetTimer: number | null = null;

    constructor() {
        const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
        if (canvas) this.wsRenderer = new CanvasStreamRenderer(canvas);
        this.bindEvents();
    }

    public async init(): Promise<void> {
        applyTranslations();
        this.syncLanguageSelect();
        await this.loadConfig();
        await this.loadCameras();
        this.syncForm();
        await this.refreshStatus();
        this.statusPoll = window.setInterval(() => this.refreshStatus(), 2000);
    }

    private bindEvents(): void {
        document.getElementById('btn-start')?.addEventListener('click', () => this.startCamera());
        document.getElementById('btn-stop')?.addEventListener('click', () => this.stopCamera());
        document.getElementById('btn-copy-stream')?.addEventListener('click', () => this.copyUrl('stream-url'));
        document.getElementById('btn-copy-overlay')?.addEventListener('click', () => this.copyUrl('overlay-url'));
        document.getElementById('language-select')?.addEventListener('change', (event) => {
            const locale = (event.target as HTMLSelectElement).value as Locale;
            setLocale(locale);
            this.syncLanguageSelect();
            this.setRunningUi(this.isRunning());
            this.updatePreviewText();
        });

        const formInputs = ['resolution', 'port', 'mirror-h', 'mirror-v', 'auto-start', 'fps', 'camera-select'];
        formInputs.forEach((id) => {
            document.getElementById(id)?.addEventListener('change', () => this.updateConfig());
        });
    }

    private syncLanguageSelect(): void {
        const select = document.getElementById('language-select') as HTMLSelectElement | null;
        if (!select) return;
        select.innerHTML = '';
        getLocaleOptions().forEach(({ value, label }) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        });
        select.value = getLocale();
        select.setAttribute('aria-label', t('language'));
    }

    private setError(msg: string): void {
        const el = document.getElementById('error-msg');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('visible', Boolean(msg));
    }

    private setSaveState(message: string, visible: boolean): void {
        const el = document.getElementById('save-state');
        if (!el) return;
        el.textContent = message;
        el.classList.toggle('visible', visible);
    }

    private setRunningUi(running: boolean): void {
        const badge = document.getElementById('status-badge');
        const btnStart = document.getElementById('btn-start') as HTMLButtonElement | null;
        const btnStop = document.getElementById('btn-stop') as HTMLButtonElement | null;

        if (badge) {
            badge.textContent = running ? t('running') : t('off');
            badge.className = `status ${running ? 'status-on' : 'status-off'}`;
        }
        if (btnStart) btnStart.disabled = running;
        if (btnStop) btnStop.disabled = !running;
    }

    private isRunning(): boolean {
        return document.getElementById('status-badge')?.classList.contains('status-on') || false;
    }

    private updatePreviewText(): void {
        const placeholder = document.getElementById('preview-placeholder');
        if (placeholder) placeholder.textContent = t('previewEmpty');
    }

    private showCanvasPreview(): void {
        document.body.classList.add('is-preview-visible');
        this.wsRenderer?.start();
    }

    private hidePreview(): void {
        document.body.classList.remove('is-preview-visible');
        this.wsRenderer?.stop();
    }

    private async loadConfig(): Promise<void> {
        try {
            const r = await fetch('/settings');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            this.config = await r.json();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('Failed to load settings:', e);
            this.setError(t('loadSettingsFailed', { message }));
        }
    }

    private async loadCameras(): Promise<void> {
        try {
            const r = await fetch('/cameras');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const cameras: CameraDeviceInfo[] = await r.json();
            const sel = document.getElementById('camera-select') as HTMLSelectElement | null;
            if (!sel) return;
            sel.innerHTML = '';
            if (!cameras.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = t('noCamerasFound');
                sel.appendChild(opt);
                return;
            }
            cameras.forEach((camera) => {
                const opt = document.createElement('option');
                opt.value = String(camera.index);
                opt.textContent = camera.name;
                sel.appendChild(opt);
            });
            if (this.config.selected_camera_index != null) {
                sel.value = String(this.config.selected_camera_index);
            } else {
                this.config.selected_camera_index = parseInt(sel.value, 10) || 0;
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('Failed to load cameras:', e);
            this.setError(t('loadCamerasFailed', { message }));
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
        const port = portEl?.value || '8080';
        const host = window.location.hostname || 'localhost';
        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const params = new URLSearchParams();
        if (hEl?.checked) params.set('mirror_h', '1');
        if (vEl?.checked) params.set('mirror_v', '1');

        let overlayUrl = `${protocol}//${host}:${port}/`;
        if (params.size) overlayUrl += `?${params.toString()}`;

        const streamUrlInput = document.getElementById('stream-url') as HTMLInputElement | null;
        const overlayUrlInput = document.getElementById('overlay-url') as HTMLInputElement | null;
        if (streamUrlInput) streamUrlInput.value = `${wsProtocol}//${host}:${port}/ws`;
        if (overlayUrlInput) overlayUrlInput.value = overlayUrl;
    }

    private async updateConfig(): Promise<void> {
        this.updateUrls();
        const card = document.getElementById('settings-heading')?.closest('.card');
        const getVal = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement)?.value || '';
        const getChecked = (id: string) => (document.getElementById(id) as HTMLInputElement)?.checked || false;

        this.config.resolution = getVal('resolution') as 'highest' | 'medium' | 'lowest';
        this.config.port = parseInt(getVal('port'), 10) || 8080;
        this.config.mirror_horizontal = getChecked('mirror-h');
        this.config.mirror_vertical = getChecked('mirror-v');
        this.config.auto_start = getChecked('auto-start');
        this.config.target_fps = parseInt(getVal('fps'), 10) || 30;

        const cam = getVal('camera-select');
        if (cam !== '') this.config.selected_camera_index = parseInt(cam, 10);

        this.setSaveState(t('saving'), true);
        try {
            const response = await fetch('/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.config),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.setSaveState(t('settingsSaved'), true);
            window.setTimeout(() => this.setSaveState('', false), 1800);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.setError(t('loadSettingsFailed', { message }));
            this.setSaveState('', false);
        } finally {
            if (card) card.classList.remove('is-saving');
        }
    }

    private async refreshStatus(): Promise<void> {
        try {
            const r = await fetch('/status');
            if (!r.ok) return;
            const s: CameraStatus = await r.json();
            this.setRunningUi(s.running);
            if (s.running) this.showCanvasPreview();
            else this.hidePreview();
        } catch (_) {
            // Status polling is intentionally silent for an OBS-friendly control page.
        }
    }

    private async startCamera(): Promise<void> {
        this.setError('');
        const btn = document.getElementById('btn-start') as HTMLButtonElement | null;
        if (btn) btn.disabled = true;

        try {
            await this.updateConfig();
            const r = await fetch('/start', { method: 'POST' });
            let body: StartResponse = { ok: false, running: false };
            try { body = await r.json(); } catch (_) { /* Empty response body. */ }
            if (!r.ok || body.ok === false) {
                this.setRunningUi(false);
                this.hidePreview();
                this.setError(body.error || t('startFailed', { status: r.status }));
                return;
            }
            this.setRunningUi(true);
            this.showCanvasPreview();
        } catch (e: unknown) {
            this.setRunningUi(false);
            this.hidePreview();
            this.setError(e instanceof Error ? e.message : String(e));
        }
    }

    private async stopCamera(): Promise<void> {
        this.setError('');
        try {
            const response = await fetch('/stop', { method: 'POST' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.setRunningUi(false);
            this.hidePreview();
        } catch (e) {
            this.setError(e instanceof Error ? e.message : String(e));
        }
    }

    private async copyUrl(id: string): Promise<void> {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return;
        try {
            await navigator.clipboard.writeText(el.value);
            const buttonId = id === 'stream-url' ? 'btn-copy-stream' : 'btn-copy-overlay';
            const button = document.getElementById(buttonId);
            if (!button) return;
            button.textContent = t('copied');
            if (this.copyResetTimer) window.clearTimeout(this.copyResetTimer);
            this.copyResetTimer = window.setTimeout(() => {
                button.textContent = t('copy');
            }, 1600);
        } catch (_) {
            this.setError(t('copyFailed'));
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new ConfigApp();
    app.init();
});
