import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTENSION_ID,
  type OnboardingStatus,
  type SidebarEvent,
  type SidebarRequest,
  type SidebarResponseFor,
  type SidebarState,
  type SiteScript,
  type TabInfo,
} from '@sitecraft/shared';
import type { Bridge } from '../src/lib/bridge';
import { App } from '../src/sidepanel/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function script(over: Partial<SiteScript> = {}): SiteScript {
  return {
    id: 's1',
    name: 'Hide promo banner',
    description: 'Hides the promo banner at the top.',
    urlPattern: 'https://www.youtube.com/*',
    kind: 'css',
    priority: 3,
    code: '#promo-banner { display: none !important; }',
    enabled: true,
    trial: true,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...over,
  };
}

const passing: OnboardingStatus = {
  userScriptsEnabled: true,
  companion: { state: 'connected', companionVersion: '0.1.0' },
  claudeLogin: { state: 'ok' },
};

const failing: OnboardingStatus = {
  userScriptsEnabled: false,
  companion: { state: 'not-installed', detail: 'Specified native messaging host not found.' },
  claudeLogin: { state: 'unknown' },
};

const tabA: TabInfo = { tabId: 11, windowId: 1, url: 'https://www.youtube.com/watch?v=1', title: 'A video', active: true };
const tabB: TabInfo = { tabId: 12, windowId: 1, url: 'https://example.com/', title: 'Example', active: false };

class FakeBridge implements Bridge {
  readonly mode = 'extension' as const;
  readonly calls: SidebarRequest[] = [];
  state: SidebarState;
  onboarding: OnboardingStatus;
  tabs: TabInfo[];
  private readonly listeners = new Set<(ev: SidebarEvent) => void>();

  constructor(init: { scripts?: SiteScript[]; onboarding?: OnboardingStatus; onboardingDone?: boolean; tabs?: TabInfo[] } = {}) {
    this.onboarding = init.onboarding ?? passing;
    this.tabs = init.tabs ?? [tabA, tabB];
    this.state = {
      scripts: init.scripts ?? [],
      settings: { onboardingDone: init.onboardingDone ?? false, companionHostName: 'com.sitecraft.companion' },
      errors: {},
      companion: this.onboarding.companion,
    };
  }

  request<R extends SidebarRequest>(req: R): Promise<SidebarResponseFor<R>> {
    this.calls.push(req);
    return Promise.resolve(this.handle(req) as SidebarResponseFor<R>);
  }

  onEvent(cb: (ev: SidebarEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(ev: SidebarEvent): void {
    for (const l of [...this.listeners]) l(ev);
  }

  callsOf<T extends SidebarRequest['type']>(type: T): Extract<SidebarRequest, { type: T }>[] {
    return this.calls.filter((c): c is Extract<SidebarRequest, { type: T }> => c.type === type);
  }

  private patch(id: string, p: Partial<SiteScript>): SidebarState {
    this.state = { ...this.state, scripts: this.state.scripts.map((s) => (s.id === id ? { ...s, ...p } : s)) };
    return this.state;
  }

  private handle(req: SidebarRequest): unknown {
    switch (req.type) {
      case 'getState':
        return this.state;
      case 'checkOnboarding':
        return this.onboarding;
      case 'checkCompanion':
        return this.onboarding.companion;
      case 'listTabs':
        return this.tabs;
      case 'getDefaultTab':
        return this.tabs[0] ?? null;
      case 'runRequest':
        return { runId: 'run-1' };
      case 'exportScripts':
        return JSON.stringify({ format: 'sitecraft-scripts', version: 1, exportedAt: 'now', scripts: this.state.scripts });
      case 'importScripts':
        return { imported: 2, skipped: 1, errors: ['bad one'] };
      case 'keepScript':
        return this.patch(req.id, { trial: false });
      case 'undoScript':
        return this.patch(req.id, { enabled: false });
      case 'toggleScript':
        return this.patch(req.id, { enabled: req.enabled });
      case 'setPriority':
        return this.patch(req.id, { priority: req.priority });
      case 'updateCode':
        return this.patch(req.id, { code: req.code });
      case 'deleteScript':
        this.state = { ...this.state, scripts: this.state.scripts.filter((s) => s.id !== req.id) };
        return this.state;
      case 'setOnboardingDone':
        this.state = { ...this.state, settings: { ...this.state.settings, onboardingDone: req.done } };
        return this.state;
      default:
        return this.state;
    }
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(bridge: Bridge): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App bridge={bridge} />);
  });
  await flush();
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
});

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`No element with data-testid=${id}`);
  return el;
}

function allByTestId(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button with text ${text}`);
  return btn;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  await act(async () => {
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

const text = (): string => document.body.textContent ?? '';

describe('App onboarding gate', () => {
  it('shows onboarding with three live rows when checks fail', async () => {
    const bridge = new FakeBridge({ onboarding: failing });
    await mount(bridge);
    expect(byTestId('onboarding-userscripts')).toBeTruthy();
    expect(byTestId('onboarding-companion')).toBeTruthy();
    expect(byTestId('onboarding-login')).toBeTruthy();
    expect(byTestId<HTMLButtonElement>('onboarding-continue').disabled).toBe(true);
    expect(text()).toContain('npx sitecraft install');
    expect(text()).toContain('node companion/bin/sitecraft.js install');
    expect(text()).toContain('Specified native messaging host not found.');
    // Chat stays mounted (so a thread survives a temporary gate) but is hidden.
    const chatInput = document.querySelector('[data-testid="chat-input"]');
    expect(chatInput).not.toBeNull();
    expect(chatInput?.closest('[hidden]')).not.toBeNull();
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
    bridge.onboarding = passing;
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

  it('shows the chat when all checks pass', async () => {
    const bridge = new FakeBridge();
    await mount(bridge);
    expect(byTestId('chat-input')).toBeTruthy();
    expect(byTestId('chat-send')).toBeTruthy();
    const picker = byTestId<HTMLSelectElement>('tab-picker');
    expect(picker.options.length).toBe(2);
    expect(picker.value).toBe('11');
  });

  it('skips onboarding when setup is done and the companion is connected', async () => {
    const bridge = new FakeBridge({
      onboarding: { ...passing, userScriptsEnabled: false, claudeLogin: { state: 'unknown' } },
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
  it('sends a request for the picked tab and shows progress then a result card', async () => {
    const bridge = new FakeBridge();
    await mount(bridge);
    await type(byTestId<HTMLSelectElement>('tab-picker'), '12');
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
  it('groups scripts by host and supports toggle, priority, and inline delete', async () => {
    const bridge = new FakeBridge({
      scripts: [
        script(),
        script({ id: 's2', name: 'Big comments', urlPattern: 'https://example.com/*', kind: 'js', priority: 1, trial: false }),
      ],
    });
    await mount(bridge);
    await click(byTestId('tab-manager'));
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
