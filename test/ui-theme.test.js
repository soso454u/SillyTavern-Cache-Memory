import test from 'node:test';
import assert from 'node:assert/strict';
import { applyUITheme, normalizeThemeMode, resolvedTheme } from '../src/ui-theme.js';
import { normalizeLoadedSettings, normalizeSettings } from '../src/defaults.js';
import { CacheMemoryUI } from '../src/ui.js';

test('theme choices migrate to system and manual choices survive reload', () => {
    assert.equal(normalizeLoadedSettings({}).uiThemeMode, 'system');
    assert.equal(normalizeThemeMode('custom'), 'system');
    assert.equal(resolvedTheme('system', true), 'dark');
    assert.equal(resolvedTheme('system', false), 'light');
    for (const mode of ['light', 'dark']) {
        assert.equal(resolvedTheme(mode, true), mode);
        assert.equal(resolvedTheme(mode, false), mode);
        assert.equal(normalizeSettings(JSON.parse(JSON.stringify(normalizeSettings({ uiThemeMode: mode })))).uiThemeMode, mode);
    }
    const overlay = { dataset: {} };
    applyUITheme(overlay, 'system', true);
    assert.deepEqual(overlay.dataset, { uiTheme: 'dark', themePreference: 'system' });
});

test('click routing does not treat an ancestor window mode marker as a button action', async () => {
    const handlers = {};
    const root = { dataset: {}, addEventListener: (name, callback) => handlers[name] = callback };
    const ui = new CacheMemoryUI({});
    ui.config = root;
    ui.populateSettings = () => { throw Error('Menu must not change mode'); };
    let tab, closes = 0;
    ui.activateSettingsTab = name => { tab = name; };
    ui.closeSettings = () => closes++;
    ui.bindSettings(root);
    const target = { closest(selector) {
        if (selector === '[data-summary-mode]') return { dataset: { summaryMode: 'normal' } }; // v1.24.0 ancestor collision
        if (selector === '[data-settings-tab]') return { dataset: { settingsTab: 'prompts' } };
        return null;
    } };
    await handlers.click({ target });
    assert.equal(tab, 'prompts');
    await handlers.click({ target: { closest: selector => selector === 'button[data-settings-close]' ? {} : null } });
    assert.equal(closes, 1);
});
