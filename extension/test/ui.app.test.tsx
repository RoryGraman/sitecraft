import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_ID } from '@sitecraft/shared';
import {
  FakeBridge,
  allByTestId,
  buttonByText,
  byTestId,
  cleanup,
  click,
  failing,
  flush,
  mount,
  queryTestId,
  script,
  tabB,
  text,
  type,
} from './ui.fakes';

afterEach(async () => {
  await cleanup();
  localStorage.removeItem('sitecraft-model');
});

describe('App onboarding gate', () => {
  it('shows onboarding with three live rows when checks fail', async () => {
    const bridge = new FakeBridge({ onboarding: failing });
    await mount(bridge);
    expect(byTestId('onboarding-userscripts')).toBeTruthy();
    expect(byTestId('onboarding-companion')).toBeTruthy();
    expect(byTestId('onboarding-login')).toBeTruthy();
    expect(byTestId<HTMLButtonElement>('onboarding-continue').disabled).toBe(true);
    expect(text()).toContain('node companion/bin/sitecraft.js install');
    expect(text()).toContain('Specified native messaging host not found.');
    // Chat stays mounted (so a thread survives a temporary gate) but is hidden.
    const chatInput = document.querySelector('[data-testid="chat-input"]');
    expect(chatInput).not.toBeNull();
    expect(chatInput?.closest('[hidden]')).not.toBeNull();
    // The page strip waits for the main UI.
    expect(queryTestId('page-strip')).toBeNull();
  });

  it('opens the extension details page through the background', async () => {
    const bridge = new FakeBridge({ onboarding: failing });
    await mount(bridge);
    await click(buttonByText('Open extension details'));
    expect(bridge.callsOf('openUrl')).toEqual([{ type: 'openUrl', url: `chrome://extensions/?id=${EXTENSION_ID}` }]);
  });

  it('moves to the chat once every check passes and records onboardingDone once', async () => {
    const bridge = new FakeBridge({ onboarding: failing });
    await mount(bridge);
    expect(byTestId<HTMLButtonElement>('onboarding-continue').disabled).toBe(true);
    bridge.onboarding = { ...failing, userScriptsEnabled: true, companion: { state: 'connected', companionVersion: '0.1.0' }, claudeLogin: { state: 'ok' } };
    await click(buttonByText('Retry'));
    expect(byTestId('chat-input')).toBeTruthy();
    expect(bridge.callsOf('setOnboardingDone')).toEqual([{ type: 'setOnboardingDone', done: true }]);
    expect(bridge.state.settings.onboardingDone).toBe(true);
  });

  it('enables Continue in Setup when all checks pass and sends setOnboardingDone', async () => {
    const bridge = new FakeBridge({ onboardingDone: false });
    await mount(bridge);
    // Mounting with passing checks already recorded onboardingDone once.
    expect(bridge.callsOf('setOnboardingDone')).toHaveLength(1);
    await click(byTestId('footer-setup'));
    const cont = byTestId<HTMLButtonElement>('onboarding-continue');
    expect(cont.disabled).toBe(false);
    await click(cont);
    expect(bridge.callsOf('setOnboardingDone')).toHaveLength(2);
    expect(byTestId('chat-input')).toBeTruthy();
  });

  it('shows the chat for the active page when all checks pass', async () => {
    const bridge = new FakeBridge();
    await mount(bridge);
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(false);
    expect(byTestId<HTMLButtonElement>('chat-send').disabled).toBe(false);
    // Extension mode has no picker and no follow checkbox. The strip names the page.
    expect(queryTestId('tab-picker')).toBeNull();
    expect(queryTestId('follow-active')).toBeNull();
    expect(queryTestId('dev-reload')).toBeNull();
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId('page-strip').textContent).toContain('A video');
    expect(bridge.callsOf('getActiveTab')).toEqual([{ type: 'getActiveTab' }]);
    expect(bridge.callsOf('listTabs')).toHaveLength(0);
  });

  it('skips onboarding when setup is done and the companion is connected', async () => {
    const bridge = new FakeBridge({
      onboarding: { userScriptsEnabled: false, companion: { state: 'connected', companionVersion: '0.1.0' }, claudeLogin: { state: 'unknown' } },
      onboardingDone: true,
    });
    await mount(bridge);
    expect(byTestId('chat-input')).toBeTruthy();
  });

  it('reopens onboarding from the Setup link', async () => {
    const bridge = new FakeBridge();
    await mount(bridge);
    await click(byTestId('footer-setup'));
    expect(byTestId('onboarding-continue')).toBeTruthy();
  });
});

describe('Chat', () => {
  it('sends the picked model with the request and remembers it', async () => {
    const bridge = new FakeBridge({ activeTab: tabB });
    await mount(bridge);
    const picker = byTestId<HTMLSelectElement>('model-picker');
    await act(async () => {
      picker.value = 'claude-fable-5';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type(byTestId<HTMLTextAreaElement>('chat-input'), 'Hide it');
    await click(byTestId('chat-send'));
    expect(bridge.callsOf('runRequest')).toEqual([{ type: 'runRequest', tabId: 12, text: 'Hide it', model: 'claude-fable-5' }]);
    expect(localStorage.getItem('sitecraft-model')).toBe('claude-fable-5');
  });

  it('sends a request for the active page and shows progress then a result card', async () => {
    const bridge = new FakeBridge({ activeTab: tabB });
    await mount(bridge);
    await type(byTestId<HTMLTextAreaElement>('chat-input'), 'Hide the promo banner');
    await click(byTestId('chat-send'));
    expect(bridge.callsOf('runRequest')).toEqual([{ type: 'runRequest', tabId: 12, text: 'Hide the promo banner' }]);
    expect(byTestId<HTMLButtonElement>('chat-send').disabled).toBe(true);

    await act(async () => {
      bridge.emit({ type: 'runProgress', runId: 'run-1', status: 'Looking at the page' });
    });
    expect(text()).toContain('Looking at the page');

    const saved = script();
    bridge.state = { ...bridge.state, scripts: [saved] };
    await act(async () => {
      bridge.emit({ type: 'stateChanged', state: bridge.state });
      bridge.emit({ type: 'runDone', runId: 'run-1', outcome: { ok: true, script: saved, isUpdate: false } });
    });
    await flush();
    expect(text()).toContain('Hide promo banner');
    expect(text()).not.toContain('Looking at the page');
    expect(byTestId<HTMLButtonElement>('chat-send').disabled).toBe(false);

    await click(byTestId('result-keep'));
    expect(bridge.callsOf('keepScript')).toEqual([{ type: 'keepScript', id: 's1' }]);
    expect(byTestId<HTMLButtonElement>('result-keep').disabled).toBe(true);

    await click(byTestId('result-undo'));
    expect(bridge.callsOf('undoScript')).toEqual([{ type: 'undoScript', id: 's1', tabId: 12 }]);
    expect(byTestId<HTMLButtonElement>('result-undo').disabled).toBe(true);
  });

  it('shows the error and saves nothing when a run fails', async () => {
    const bridge = new FakeBridge();
    await mount(bridge);
    await type(byTestId<HTMLTextAreaElement>('chat-input'), 'Do a thing');
    await click(byTestId('chat-send'));
    await act(async () => {
      bridge.emit({ type: 'runDone', runId: 'run-1', outcome: { ok: false, error: 'Agent returned no script' } });
    });
    expect(text()).toContain('Agent returned no script');
    expect(document.querySelector('[data-testid="result-keep"]')).toBeNull();
  });

  it('runs the modify flow with a chip that can be cleared', async () => {
    const saved = script();
    const bridge = new FakeBridge({ scripts: [saved] });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(byTestId('script-modify'));
    expect(text()).toContain('Modifying: Hide promo banner');
    await type(byTestId<HTMLTextAreaElement>('chat-input'), 'Also hide it on the home page');
    await click(byTestId('chat-send'));
    expect(bridge.callsOf('runRequest')).toEqual([
      { type: 'runRequest', tabId: 11, text: 'Also hide it on the home page', targetScriptId: 's1' },
    ]);
    await act(async () => {
      bridge.emit({ type: 'runDone', runId: 'run-1', outcome: { ok: true, script: saved, isUpdate: true } });
    });
    await flush();
    expect(text()).not.toContain('Modifying:');

    await click(byTestId('result-modify'));
    expect(text()).toContain('Modifying: Hide promo banner');
    await click(byTestId('modify-clear'));
    expect(text()).not.toContain('Modifying:');
  });
});

describe('Manager', () => {
  it('groups scripts by host in All sites and supports toggle, priority, and inline delete', async () => {
    const bridge = new FakeBridge({
      scripts: [
        script(),
        script({ id: 's2', name: 'Big comments', urlPattern: 'https://example.com/*', kind: 'js', priority: 1, trial: false }),
      ],
    });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(byTestId('scope-all'));
    expect(allByTestId('script-card')).toHaveLength(2);
    const groups = [...document.querySelectorAll('[data-testid="script-group"]')].map((g) => g.getAttribute('data-host'));
    expect(groups).toEqual(['example.com', 'www.youtube.com']);

    const toggles = allByTestId('script-toggle') as HTMLInputElement[];
    await click(toggles[1]!);
    expect(bridge.callsOf('toggleScript')).toEqual([{ type: 'toggleScript', id: 's1', enabled: false }]);

    const prio = allByTestId('script-priority')[1] as HTMLSelectElement;
    expect(prio.value).toBe('3');
    await type(prio, '1');
    expect(bridge.callsOf('setPriority')).toEqual([{ type: 'setPriority', id: 's1', priority: 1 }]);

    await click(allByTestId('script-delete')[1]!);
    expect(bridge.callsOf('deleteScript')).toHaveLength(0);
    await click(byTestId('script-delete-confirm'));
    expect(bridge.callsOf('deleteScript')).toEqual([{ type: 'deleteScript', id: 's1' }]);
    expect(allByTestId('script-card')).toHaveLength(1);
  });

  it('edits code with Save and shows a trial badge and last error with Clear', async () => {
    const bridge = new FakeBridge({ scripts: [script()] });
    bridge.state.errors = { s1: { scriptId: 's1', message: 'boom', url: 'https://www.youtube.com/', at: '2026-08-31T00:00:00.000Z' } };
    await mount(bridge);
    await click(byTestId('tab-manager'));
    expect(text()).toContain('Trial');
    expect(text()).toContain('boom');
    await click(byTestId('script-error-clear'));
    expect(bridge.callsOf('clearError')).toEqual([{ type: 'clearError', id: 's1' }]);

    await click(byTestId('script-edit'));
    await type(byTestId<HTMLTextAreaElement>('script-code'), 'body { color: red; }');
    await click(byTestId('script-save'));
    expect(bridge.callsOf('updateCode')).toEqual([{ type: 'updateCode', id: 's1', code: 'body { color: red; }' }]);
  });

  it('exports JSON into a textarea and imports pasted JSON', async () => {
    const bridge = new FakeBridge({ scripts: [script()] });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(byTestId('export-button'));
    const out = byTestId<HTMLTextAreaElement>('export-json');
    expect(out.value).toContain('"sitecraft-scripts"');

    await click(byTestId('import-button'));
    await type(byTestId<HTMLTextAreaElement>('import-json'), '{"format":"sitecraft-scripts"}');
    await click(byTestId('import-submit'));
    expect(bridge.callsOf('importScripts')).toEqual([{ type: 'importScripts', json: '{"format":"sitecraft-scripts"}' }]);
    expect(text()).toContain('Imported 2');
    expect(text()).toContain('Skipped 1');
    expect(text()).toContain('bad one');
  });
});
