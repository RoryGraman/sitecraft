import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentMessage } from '@sitecraft/shared';
import { createStateStore } from '../src/background/state';
import { handleCssBlocked, installCssFallback } from '../src/background/css';
import { FakeEvent, FakeStorageArea, mkScript, resetIds, tick } from './router.fakes';

type MessageListener = (
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
) => void | boolean;

const g = globalThis as unknown as { chrome?: unknown };

afterEach(() => {
  delete g.chrome;
  resetIds();
});

describe('handleCssBlocked', () => {
  it('inserts the css bundle for the url into the tab', async () => {
    const area = new FakeStorageArea();
    area.data.scripts = [mkScript({ kind: 'css', code: 'a{color:red}' })];
    const store = createStateStore(area.asArea());
    const insertCSS = vi.fn<(tabId: number, css: string) => Promise<void>>(async () => undefined);
    const inserted = await handleCssBlocked(7, 'https://a.com/', store, insertCSS);
    expect(inserted).toBe(true);
    expect(insertCSS).toHaveBeenCalledTimes(1);
    expect(insertCSS.mock.calls[0]?.[0]).toBe(7);
    expect(insertCSS.mock.calls[0]?.[1]).toContain('a{color:red}');
  });

  it('does nothing when no css matches', async () => {
    const area = new FakeStorageArea();
    area.data.scripts = [mkScript({ kind: 'css', code: 'a{}', urlPattern: 'https://b.com/*' })];
    const store = createStateStore(area.asArea());
    const insertCSS = vi.fn<(tabId: number, css: string) => Promise<void>>(async () => undefined);
    expect(await handleCssBlocked(7, 'https://a.com/', store, insertCSS)).toBe(false);
    expect(insertCSS).not.toHaveBeenCalled();
  });
});

describe('installCssFallback', () => {
  function setup(scripts = [mkScript({ kind: 'css', code: 'a{color:red}' })]) {
    const area = new FakeStorageArea();
    area.data.scripts = scripts;
    const store = createStateStore(area.asArea());
    const onMessage = new FakeEvent<[unknown, chrome.runtime.MessageSender, (r?: unknown) => void]>();
    const insertCSS = vi.fn<(tabId: number, css: string) => Promise<void>>(async () => undefined);
    const listeners = new Set<MessageListener>();
    const event = {
      addListener: (l: MessageListener) => {
        listeners.add(l);
      },
      removeListener: (l: MessageListener) => {
        listeners.delete(l);
      },
      hasListener: (l: MessageListener) => listeners.has(l),
    } as unknown as typeof chrome.runtime.onMessage;
    const emit = (msg: unknown, sender: chrome.runtime.MessageSender): void => {
      for (const l of [...listeners]) l(msg, sender, () => undefined);
    };
    const off = installCssFallback(store, { insertCSS, onMessage: event });
    return { store, insertCSS, emit, off, listeners, onMessage };
  }

  it('inserts css when the content script reports a blocked style', async () => {
    const { insertCSS, emit } = setup();
    const msg: ContentMessage = { type: 'cssBlocked', url: 'https://a.com/' };
    emit(msg, { tab: { id: 3, url: 'https://a.com/' } as chrome.tabs.Tab });
    await tick();
    expect(insertCSS).toHaveBeenCalledTimes(1);
    expect(insertCSS.mock.calls[0]?.[0]).toBe(3);
    expect(insertCSS.mock.calls[0]?.[1]).toContain('a{color:red}');
  });

  it('prefers the sender tab url over the message url', async () => {
    const { insertCSS, emit } = setup([mkScript({ kind: 'css', code: 'b{}', urlPattern: 'https://b.com/*' })]);
    emit({ type: 'cssBlocked', url: 'https://b.com/' }, { tab: { id: 3, url: 'https://a.com/' } as chrome.tabs.Tab });
    await tick();
    expect(insertCSS).not.toHaveBeenCalled();
  });

  it('ignores other messages and messages without a tab', async () => {
    const { insertCSS, emit } = setup();
    emit({ type: 'scriptError', scriptId: 'x', message: 'm', url: 'https://a.com/' }, { tab: { id: 3 } as chrome.tabs.Tab });
    emit({ type: 'cssBlocked', url: 'https://a.com/' }, {});
    emit('garbage', { tab: { id: 3 } as chrome.tabs.Tab });
    await tick();
    expect(insertCSS).not.toHaveBeenCalled();
  });

  it('logs and survives an insertCSS failure', async () => {
    const { insertCSS, emit } = setup();
    insertCSS.mockRejectedValueOnce(new Error('No tab with id: 3.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    emit({ type: 'cssBlocked', url: 'https://a.com/' }, { tab: { id: 3, url: 'https://a.com/' } as chrome.tabs.Tab });
    await tick();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns a function that removes the listener', async () => {
    const { insertCSS, emit, off, listeners } = setup();
    expect(listeners.size).toBe(1);
    off();
    expect(listeners.size).toBe(0);
    emit({ type: 'cssBlocked', url: 'https://a.com/' }, { tab: { id: 3, url: 'https://a.com/' } as chrome.tabs.Tab });
    await tick();
    expect(insertCSS).not.toHaveBeenCalled();
  });

  it('uses chrome.scripting.insertCSS by default', async () => {
    const insert = vi.fn<(injection: chrome.scripting.CSSInjection) => Promise<void>>(async () => undefined);
    const listeners = new Set<MessageListener>();
    g.chrome = {
      scripting: { insertCSS: insert },
      runtime: {
        onMessage: {
          addListener: (l: MessageListener) => {
            listeners.add(l);
          },
          removeListener: (l: MessageListener) => {
            listeners.delete(l);
          },
        },
      },
    };
    const area = new FakeStorageArea();
    area.data.scripts = [mkScript({ kind: 'css', code: 'a{color:red}' })];
    const store = createStateStore(area.asArea());
    installCssFallback(store);
    for (const l of [...listeners]) {
      l({ type: 'cssBlocked', url: 'https://a.com/' }, { tab: { id: 9, url: 'https://a.com/' } as chrome.tabs.Tab }, () => undefined);
    }
    await tick();
    expect(insert).toHaveBeenCalledTimes(1);
    const arg = insert.mock.calls[0]?.[0] as { target: { tabId: number }; css: string };
    expect(arg.target.tabId).toBe(9);
    expect(arg.css).toContain('a{color:red}');
  });
});
