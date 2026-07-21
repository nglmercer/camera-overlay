import type { CanvasStreamRenderer } from './overlay';

export interface OverlayState {
    x: number | string;
    y: number | string;
    width: number | string;
    height: number | string;
    scale: number;
    rotate: number;
    mirrorH: boolean;
    mirrorV: boolean;
    fit: 'contain' | 'cover' | 'fill' | 'none';
    opacity: number;
    filter: string;
    border: string;
    radius: number | string;
    background: string;
    visible: boolean;
}

export type OverlayPatch = Partial<OverlayState>;

export const DEFAULT_STATE: OverlayState = {
    x: 0,
    y: 0,
    width: '100%',
    height: '100%',
    scale: 1,
    rotate: 0,
    mirrorH: false,
    mirrorV: false,
    fit: 'contain',
    opacity: 1,
    filter: 'none',
    border: 'none',
    radius: 0,
    background: 'transparent',
    visible: true,
};

const storageKey = 'camera-overlay-state';
const maxStringLength = 256;
const listeners = new Set<(state: Readonly<OverlayState>) => void>();

function cssLength(value: number | string): string | null {
    if (typeof value === 'number') return Number.isFinite(value) ? `${value}px` : null;
    if (value.length > maxStringLength) return null;
    if (/^(?:-?\d+(?:\.\d+)?(?:px|%|vw|vh|vmin|vmax|rem|em)|calc\([^;{}]+\))$/.test(value.trim())) return value.trim();
    return null;
}

function cssRadius(value: number | string): string | null {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? `${value}px` : null;
    return /^(?:\d+(?:\.\d+)?(?:px|%|rem|em))$/.test(value.trim()) ? value.trim() : null;
}

function safeCssText(value: string, allowNone = false): string | null {
    if (value.length > maxStringLength || /[;{}<>]/.test(value) || /url\s*\(/i.test(value)) return null;
    if (allowNone && value === 'none') return value;
    return /^[a-zA-Z0-9 ()_,.\-+#/%:]+$/.test(value) ? value : null;
}

function safeNumber(value: number, min: number, max: number): number | null {
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function parseState(value: unknown): OverlayPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const patch: OverlayPatch = {};
    const lengthFields = ['x', 'y', 'width', 'height'] as const;
    lengthFields.forEach((field) => {
        if (typeof input[field] === 'number' || typeof input[field] === 'string') {
            const parsed = cssLength(input[field] as number | string);
            if (parsed !== null) patch[field] = typeof input[field] === 'number' ? Number(input[field]) : parsed;
        }
    });
    if (typeof input.scale === 'number' && safeNumber(input.scale, 0.1, 10) !== null) patch.scale = input.scale;
    if (typeof input.rotate === 'number' && safeNumber(input.rotate, -360, 360) !== null) patch.rotate = input.rotate;
    if (typeof input.mirrorH === 'boolean') patch.mirrorH = input.mirrorH;
    if (typeof input.mirrorV === 'boolean') patch.mirrorV = input.mirrorV;
    if (input.fit === 'contain' || input.fit === 'cover' || input.fit === 'fill' || input.fit === 'none') patch.fit = input.fit;
    if (typeof input.opacity === 'number' && safeNumber(input.opacity, 0, 1) !== null) patch.opacity = input.opacity;
    if (typeof input.filter === 'string' && safeCssText(input.filter, true) !== null) patch.filter = input.filter;
    if (typeof input.border === 'string' && safeCssText(input.border, true) !== null) patch.border = input.border;
    if (typeof input.radius === 'number' || typeof input.radius === 'string') {
        const parsed = cssRadius(input.radius as number | string);
        if (parsed !== null) patch.radius = typeof input.radius === 'number' ? Number(input.radius) : parsed;
    }
    if (typeof input.background === 'string' && safeCssText(input.background) !== null) patch.background = input.background;
    if (typeof input.visible === 'boolean') patch.visible = input.visible;
    return patch;
}

function cssValue(value: number | string): string {
    return typeof value === 'number' ? `${value}px` : value;
}

declare global {
    interface Window {
        cameraOverlay: OverlayApi;
    }
}

export class OverlayApi {
    private readonly canvas: HTMLCanvasElement;
    private readonly renderer: CanvasStreamRenderer | null;
    private state: OverlayState;
    private readonly stateListeners = new Set<(state: Readonly<OverlayState>) => void>();

    constructor(canvas?: HTMLCanvasElement, renderer?: CanvasStreamRenderer | null) {
        const element = canvas || document.getElementById('camera-canvas');
        if (!(element instanceof HTMLCanvasElement)) throw new Error('Camera canvas element not found');
        this.canvas = element;
        this.renderer = renderer || null;
        this.state = { ...DEFAULT_STATE };
        this.applyState();
    }

    public getState(): Readonly<OverlayState> {
        return { ...this.state };
    }

    public set(patch: OverlayPatch): Readonly<OverlayState> {
        this.state = { ...this.state, ...parseState(patch) };
        this.applyState();
        this.persist();
        this.notify();
        return this.getState();
    }

    public reset(): Readonly<OverlayState> {
        this.state = { ...DEFAULT_STATE };
        this.applyState();
        window.localStorage.removeItem(storageKey);
        this.notify();
        return this.getState();
    }

    public mirror(axes: { h?: boolean; v?: boolean }): Readonly<OverlayState> {
        return this.set({
            mirrorH: axes.h ?? this.state.mirrorH,
            mirrorV: axes.v ?? this.state.mirrorV,
        });
    }

    public show(): void { this.set({ visible: true }); }
    public hide(): void { this.set({ visible: false }); }
    public toggle(force?: boolean): boolean {
        const visible = force ?? !this.state.visible;
        this.set({ visible });
        return visible;
    }

    public serialize(): string {
        return JSON.stringify(this.state);
    }

    public deserialize(json: string): Readonly<OverlayState> {
        try {
            return this.set(JSON.parse(json));
        } catch (_) {
            return this.getState();
        }
    }

    public subscribe(listener: (state: Readonly<OverlayState>) => void): () => void {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }

    private applyState(): void {
        const properties: Record<string, string> = {
            '--overlay-x': cssValue(this.state.x),
            '--overlay-y': cssValue(this.state.y),
            '--overlay-w': cssValue(this.state.width),
            '--overlay-h': cssValue(this.state.height),
            '--overlay-scale': String(this.state.scale),
            '--overlay-rotate': `${this.state.rotate}deg`,
            '--overlay-mirror-h': this.state.mirrorH ? '-1' : '1',
            '--overlay-mirror-v': this.state.mirrorV ? '-1' : '1',
            '--overlay-fit': this.state.fit,
            '--overlay-opacity': String(this.state.opacity),
            '--overlay-filter': this.state.filter,
            '--overlay-border': this.state.border,
            '--overlay-radius': cssValue(this.state.radius),
            '--overlay-bg': this.state.background,
            '--overlay-display': this.state.visible ? 'block' : 'none',
        };
        Object.entries(properties).forEach(([name, value]) => this.canvas.style.setProperty(name, value));
    }

    private persist(): void {
        try {
            window.localStorage.setItem(storageKey, this.serialize());
        } catch (_) {
            // Persistence is optional in restricted browser contexts.
        }
    }

    private notify(): void {
        const state = this.getState();
        this.stateListeners.forEach((listener) => listener(state));
        listeners.forEach((listener) => listener(state));
    }
}

export function restoreOverlayState(api: OverlayApi): void {
    const query = new URLSearchParams(window.location.search).get('overlay');
    if (query) {
        try {
            api.deserialize(decodeURIComponent(escape(atob(query))));
            return;
        } catch (_) {
            // Ignore invalid permalink state and try local storage.
        }
    }
    try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) api.deserialize(saved);
    } catch (_) {
        // Persistence is optional in restricted browser contexts.
    }
}

export function subscribeOverlay(listener: (state: Readonly<OverlayState>) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
