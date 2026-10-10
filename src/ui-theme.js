export const UI_THEME_MODES = Object.freeze(['system', 'light', 'dark']);

export function normalizeThemeMode(value) {
    return UI_THEME_MODES.includes(value) ? value : 'system';
}

export function resolvedTheme(mode, prefersDark = false) {
    return normalizeThemeMode(mode) === 'system' ? prefersDark ? 'dark' : 'light' : mode;
}

// Only plugin overlays receive these attributes; the host page and RP text keep their theme.
export function applyUITheme(overlay, mode, prefersDark = false) {
    if (!overlay) return;
    overlay.dataset.uiTheme = resolvedTheme(mode, prefersDark);
    overlay.dataset.themePreference = normalizeThemeMode(mode);
}
