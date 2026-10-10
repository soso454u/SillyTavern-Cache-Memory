import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryApiClient, API_PROFILE_FIELDS } from '../src/api-client.js';
import { normalizeSettings } from '../src/defaults.js';
import { CacheMemoryUI } from '../src/ui.js';

function fixture() {
    let settings = normalizeSettings({ apiBaseUrl: 'https://a.example/v1', model: 'a-model', temperature: 0.3 });
    const values = new Map([['secret', 'synthetic-legacy-key']]);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), get length() { return values.size; }, key: i => [...values.keys()][i] };
    const client = new SummaryApiClient({ getSettings: () => settings, storage, storageKey: 'secret' });
    const update = patch => { settings = normalizeSettings({ ...settings, ...patch }); };
    return { client, values, storage, update, get settings() { return settings; } };
}

test('named profiles migrate legacy credentials and all saved URL connections without exporting keys', async () => {
    const f = fixture();
    f.values.set('secret:connection:' + encodeURIComponent('https://old.example/v1'), JSON.stringify({ key: 'synthetic-old-key', model: 'old-model' }));
    const index = f.client.listProfiles();
    assert.equal(index.profiles.length, 2);
    assert.equal(f.client.readConnection().key, 'synthetic-legacy-key');
    const old = index.profiles[1];
    const settings = f.client.selectProfile(old.id);
    assert.equal(settings.apiBaseUrl, 'https://old.example/v1');
    assert.equal(settings.model, 'old-model');
    assert.ok(!('key' in settings));
    assert.equal(f.client.readConnection().key, 'synthetic-old-key');
    assert.equal(f.values.get('secret'), 'synthetic-legacy-key');
    assert.doesNotMatch(JSON.stringify(f.settings), /synthetic-.*key/);
    assert.ok(API_PROFILE_FIELDS.every(key => !/key|prompt/i.test(key)));
});

test('same URL profiles retain independent keys, model and every API parameter across reload', async () => {
    const f = fixture();
    const first = f.client.listProfiles().activeId;
    f.update({ thinkingMode: 'enabled', generationTransport: 'stream', summaryMaxTokens: 8192 });
    f.client.saveProfileSettings();
    const second = f.client.addProfile('备用');
    f.update(f.client.selectProfile(second));
    assert.equal(f.client.hasApiKey(), false);
    f.update({ apiBaseUrl: 'https://a.example/v1', model: 'b-model', temperature: 0.8, thinkingMode: 'disabled', generationTransport: 'non-stream', summaryMaxTokens: 1024, checkpointMaxTokens: 2345, longMemoryMaxTokens: 4567, tokenLimitParameter: 'max_completion_tokens' });
    await f.client.saveApiKey('synthetic-b-key');
    f.client.saveProfileSettings();
    const secondSettings = { ...f.settings };
    const secondIdentity = f.client.modelListIdentity();
    f.update(f.client.selectProfile(first));
    assert.equal(f.client.readConnection().key, 'synthetic-legacy-key');
    assert.equal(f.settings.model, 'a-model');
    assert.equal(f.settings.temperature, 0.3);
    assert.equal(f.settings.thinkingMode, 'enabled');
    assert.equal(f.settings.summaryMaxTokens, 8192);
    assert.notEqual(f.client.modelListIdentity(), secondIdentity);
    const reload = new SummaryApiClient({ getSettings: () => f.settings, storage: f.storage, storageKey: 'secret' });
    f.update(reload.selectProfile(second));
    for (const field of API_PROFILE_FIELDS) assert.equal(f.settings[field], secondSettings[field], field);
    assert.equal(reload.readConnection().key, 'synthetic-b-key');
    reload.renameProfile('新名字');
    assert.equal(reload.listProfiles().profiles[1].name, '新名字');
    f.update(reload.deleteProfile(second));
    assert.equal(reload.profileIndex().activeId, first);
    assert.equal(reload.readConnection().key, 'synthetic-legacy-key');
    assert.equal(f.values.has('secret:profile:' + second), false);
    assert.throws(() => reload.deleteProfile(first), /至少保留/);
});

test('switching profiles during a pending request preserves connection and explicit compatibility retry', async () => {
    const f = fixture();
    f.client.listProfiles();
    const second = f.client.addProfile('第二个');
    const attempts = [];
    let rejectFirst;
    f.client.requestOpenAICompatible = async options => {
        attempts.push(options);
        if (attempts.length === 1) return new Promise((_, reject) => { rejectFirst = reject; });
        return { data: { choices: [{ message: { content: '合成输出' } }] }, response: { status: 200 }, diagnostics: {}, source: 'proxy' };
    };
    const pending = f.client.complete({ systemPrompt: '合成', userContent: '测试' });
    f.update(f.client.selectProfile(second));
    f.update({ apiBaseUrl: 'https://b.example/v1', model: 'b-model', temperature: 0.9 });
    await f.client.saveApiKey('synthetic-b-key');
    rejectFirst(new Error('unsupported max_tokens; use max_completion_tokens'));
    assert.equal((await pending).content, '合成输出');
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
        assert.equal(attempt.connection.settings.apiBaseUrl, 'https://a.example/v1');
        assert.equal(attempt.connection.key, 'synthetic-legacy-key');
        assert.equal(attempt.payload.model, 'a-model');
        assert.equal(attempt.payload.temperature, 0.3);
    }
    assert.equal(attempts[1].payload.max_tokens, undefined);
});

test('settings automatically persist and browser storage failure never shows saved', async t => {
    const f = fixture();
    f.client.listProfiles();
    let saves = 0;
    const output = { dataset: {}, textContent: '' };
    const ui = new CacheMemoryUI({ getSettings: () => f.settings, apiClient: f.client, updateSettings: f.update, persistSettings: async () => saves++ });
    ui.config = { querySelectorAll: () => [output] };
    ui.setStatus = () => {};
    t.after(() => clearTimeout(ui.settingsSaveTimer));
    f.update({ temperature: 0.45 }); ui.markSettingsDirty();
    await new Promise(resolve => setTimeout(resolve, 470));
    assert.equal(saves, 1);
    assert.equal(ui.settingsDirty, false);
    assert.equal(output.textContent, '已自动保存');
    assert.equal(f.client.readConnection().temperature, 0.45);
    f.storage.setItem = () => { throw new Error('Storage blocked'); };
    ui.markSettingsDirty();
    await assert.rejects(ui.saveSettingsNow(), /Storage blocked/);
    assert.equal(output.dataset.state, 'failed');
    assert.equal(ui.settingsDirty, true);
});

test('separate ST windows keep their key paired with their own selected URL', async () => {
    const f = fixture();
    const first = f.client.listProfiles().activeId;
    const second = f.client.addProfile('第二个窗口');
    let otherSettings = { ...f.settings };
    const other = new SummaryApiClient({ getSettings: () => otherSettings, storage: f.storage, storageKey: 'secret' });
    otherSettings = { ...otherSettings, ...other.selectProfile(second), apiBaseUrl: 'https://b.example/v1', model: 'b-model' };
    await other.saveApiKey('synthetic-other-key');
    other.saveProfileSettings();
    assert.equal(f.client.profileIndex().activeId, first);
    assert.equal(f.client.readConnection().key, 'synthetic-legacy-key');
    assert.equal(f.settings.apiBaseUrl, 'https://a.example/v1');
    assert.equal(other.readConnection().key, 'synthetic-other-key');
});

test('a named profile saves a typed key even before a URL is entered', async () => {
    const f = fixture();
    f.client.listProfiles();
    f.update(f.client.selectProfile(f.client.addProfile('先填密钥')));
    assert.equal(f.settings.apiBaseUrl, '');
    assert.equal(await f.client.saveApiKey('synthetic-key-first'), true);
    assert.equal(f.client.hasApiKey(), true);
    f.update({ apiBaseUrl: 'https://c.example/v1' });
    f.client.saveProfileSettings();
    assert.equal(f.client.readConnection().key, 'synthetic-key-first');
});

test('migration retains an existing legacy key even when the URL was left blank', () => {
    const f = fixture();
    f.update({ apiBaseUrl: '' });
    f.client.listProfiles();
    assert.equal(f.client.readConnection().key, 'synthetic-legacy-key');
});
