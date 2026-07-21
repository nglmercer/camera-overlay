export interface Messages {
    pageTitle: string;
    configTitle: string;
    configSubtitle: string;
    backToOverlay: string;
    language: string;
    status: string;
    camera: string;
    running: string;
    off: string;
    startCamera: string;
    stopCamera: string;
    cameraSettings: string;
    cameraDevice: string;
    loadingCameras: string;
    noCamerasFound: string;
    resolutionPreference: string;
    highest: string;
    medium: string;
    lowest: string;
    targetFps: string;
    transformAndAutoStart: string;
    mirrorHorizontally: string;
    mirrorVertically: string;
    autoStart: string;
    obsIntegration: string;
    httpPort: string;
    overlayUrl: string;
    websocketStreamEndpoint: string;
    copy: string;
    copied: string;
    copyFailed: string;
    quickSetup: string;
    quickSetupStep1: string;
    quickSetupStep2: string;
    quickSetupStep3: string;
    quickSetupStep4: string;
    browserSourceLabel: string;
    livePreview: string;
    previewEmpty: string;
    previewHint: string;
    startFailed: string;
    loadSettingsFailed: string;
    loadCamerasFailed: string;
    settingsSaved: string;
    saving: string;
    error: string;
}

export type Locale = 'en' | 'es' | 'pt-BR';
export type TranslationKey = keyof Messages;

import en from './locales/en';
import es from './locales/es';
import ptBR from './locales/pt-BR';

const catalogs: Record<Locale, Messages> = { en, es, 'pt-BR': ptBR };
const storageKey = 'camera-overlay-locale';
let currentLocale: Locale = resolveLocale();

function localeFromValue(value: string | null): Locale | null {
    if (!value) return null;
    if (value === 'es' || value.toLowerCase().startsWith('es-')) return 'es';
    if (value === 'pt-BR' || value.toLowerCase().startsWith('pt')) return 'pt-BR';
    if (value === 'en' || value.toLowerCase().startsWith('en-')) return 'en';
    return null;
}

function resolveLocale(): Locale {
    const queryLocale = localeFromValue(new URLSearchParams(window.location.search).get('lang'));
    if (queryLocale) return queryLocale;

    const storedLocale = localeFromValue(window.localStorage.getItem(storageKey));
    if (storedLocale) return storedLocale;

    return localeFromValue(navigator.language) || 'en';
}

export function getLocale(): Locale {
    return currentLocale;
}

export function setLocale(locale: Locale): void {
    currentLocale = locale;
    window.localStorage.setItem(storageKey, locale);
    document.documentElement.lang = locale;
    applyTranslations();
}

export function t(key: TranslationKey, variables: Record<string, string | number> = {}): string {
    const template = catalogs[currentLocale][key] || catalogs.en[key] || key;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name] ?? `{${name}}`));
}

export function applyTranslations(): void {
    document.documentElement.lang = currentLocale;
    document.title = t('configTitle');

    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
        element.textContent = t(element.dataset.i18n as TranslationKey);
    });
    document.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((element) => {
        element.innerHTML = t(element.dataset.i18nHtml as TranslationKey);
    });
    document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((element) => {
        element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder as TranslationKey));
    });
}

export function getLocaleOptions(): Array<{ value: Locale; label: string }> {
    return [
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
        { value: 'pt-BR', label: 'Português (Brasil)' },
    ];
}
