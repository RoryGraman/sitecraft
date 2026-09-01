/**
 * Shared fakes and DOM helpers for the side panel UI tests.
 *
 * Not a test file. Each test file registers `afterEach(cleanup)` itself.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ActiveTabReason,
  OnboardingStatus,
  SidebarEvent,
  SidebarRequest,
  SidebarResponseFor,
  SidebarState,
  SiteScript,
  TabInfo,
} from '@sitecraft/shared';
import type { Bridge } from '../src/lib/bridge';
import { App } from '../src/sidepanel/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function script(over: Partial<SiteScript> = {}): SiteScript {
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

export const passing: OnboardingStatus = {
  userScriptsEnabled: true,
  companion: { state: 'connected', companionVersion: '0.1.0' },
  claudeLogin: { state: 'ok' },
};

export const failing: OnboardingStatus = {
  userScriptsEnabled: false,
  companion: { state: 'not-installed', detail: 'Specified native messaging host not found.' },
  claudeLogin: { state: 'unknown' },
};

export const tabA: TabInfo = { tabId: 11, windowId: 1, url: 'https://www.youtube.com/watch?v=1', title: 'A video', active: true };
export const tabB: TabInfo = { tabId: 12, windowId: 1, url: 'https://example.com/', title: 'Example', active: false };

export interface FakeBridgeInit {
  mode?: 'extension' | 'external';
  scripts?: SiteScript[];
  onboarding?: OnboardingStatus;
  onboardingDone?: boolean;
  /** Answer to listTabs. getDefaultTab answers with the first entry. */
  tabs?: TabInfo[];
  /** Answer to getActiveTab. Defaults to tabA. */
  activeTab?: TabInfo | null;
  /** Request types that reject. */
  failing?: SidebarRequest['type'][];
  /** Rejection message per failing type. Defaults to "<type> failed". */
  errors?: Partial<Record<SidebarRequest['type'], string>>;
}

export class FakeBridge implements Bridge {
  readonly mode: 'extension' | 'external';
  readonly calls: SidebarRequest[] = [];
  state: SidebarState;
  onboarding: OnboardingStatus;
  tabs: TabInfo[];
  activeTab: TabInfo | null;
  readonly failing: Set<SidebarRequest['type']>;
  readonly errors: Partial<Record<SidebarRequest['type'], string>>;
  private readonly listeners = new Set<(ev: SidebarEvent) => void>();

  constructor(init: FakeBridgeInit = {}) {
    this.mode = init.mode ?? 'extension';
    this.onboarding = init.onboarding ?? passing;
    this.tabs = init.tabs ?? [tabA, tabB];
    this.activeTab = init.activeTab === undefined ? tabA : init.activeTab;
    this.failing = new Set(init.failing ?? []);
    this.errors = init.errors ?? {};
    this.state = {
      scripts: init.scripts ?? [],
      settings: { onboardingDone: init.onboardingDone ?? false, companionHostName: 'com.sitecraft.companion' },
      errors: {},
      companion: this.onboarding.companion,
    };
  }

  request<R extends SidebarRequest>(req: R): Promise<SidebarResponseFor<R>> {
    this.calls.push(req);
    if (this.failing.has(req.type)) return Promise.reject(new Error(this.errors[req.type] ?? `${req.type} failed`));
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

  /** Broadcast an activeTabChanged event, as the background does. */
  emitActiveTab(windowId: number, tab: TabInfo | null, reason: ActiveTabReason = 'activated'): void {
    this.emit({ type: 'activeTabChanged', windowId, tab, reason });
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
      case 'getActiveTab':
        return this.activeTab;
      case 'devReload':
        return this.state;
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

type ChromeGlobal = { chrome?: { windows?: { getCurrent?: () => Promise<{ id?: number } | undefined> } } };

/** Install a fake chrome.windows.getCurrent that answers with this window id. */
export function installWindow(id: number): void {
  (globalThis as ChromeGlobal).chrome = { windows: { getCurrent: () => Promise.resolve({ id }) } };
}

/** Install a chrome.windows.getCurrent that rejects. */
export function installBrokenWindow(): void {
  (globalThis as ChromeGlobal).chrome = { windows: { getCurrent: () => Promise.reject(new Error('no window')) } };
}

export function uninstallWindow(): void {
  delete (globalThis as ChromeGlobal).chrome;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

export async function mount(bridge: Bridge): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App bridge={bridge} />);
  });
  await flush();
}

/** Unmount and remove the fake window. Register with afterEach in each test file. */
export async function cleanup(): Promise<void> {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
  uninstallWindow();
}

export function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`No element with data-testid=${id}`);
  return el;
}

export function queryTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

export function allByTestId(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

export function buttonByText(text: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button with text ${text}`);
  return btn;
}

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

export async function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  await act(async () => {
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/** Emit a bridge event inside act and let effects settle. */
export async function emit(bridge: FakeBridge, ev: SidebarEvent): Promise<void> {
  await act(async () => {
    bridge.emit(ev);
  });
  await flush();
}

/** Emit an activeTabChanged event inside act and let effects settle. A tab switch unless a reason is given. */
export async function emitActiveTab(
  bridge: FakeBridge,
  windowId: number,
  tab: TabInfo | null,
  reason: ActiveTabReason = 'activated',
): Promise<void> {
  await emit(bridge, { type: 'activeTabChanged', windowId, tab, reason });
}

export const text = (): string => document.body.textContent ?? '';

/** Ids of the script cards in DOM order. */
export function cardIds(): string[] {
  return allByTestId('script-card').map((c) => c.getAttribute('data-script-id') ?? '');
}
