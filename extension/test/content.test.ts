import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ContentMessage, SiteScript } from '@sitecraft/shared';
import {
  applyCss,
  computeCss,
  createSender,
  handleContentRequest,
  installCss,
  installErrorRelay,
  installMessageHandlers,
  isCssBlocked,
  start,
  STYLE_ELEMENT_ID,
} from '../src/content/lib';

// ---------------------------------------------------------------------------
// Fake chrome
// ---------------------------------------------------------------------------

type StorageChanges = Record<string, { newValue?: unknown; oldValue?: unknown }>;
type StorageListener = (changes: StorageChanges, areaName: string) => void;
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined | void;

type GetFn = (keys: string[]) => Promise<Record<string, unknown>>;
type SendFn = (message: ContentMessage) => Promise<unknown> | void;

interface FakeChrome {
  storage: {
    local: { get: Mock<GetFn> };
    onChanged: { addListener: Mock<(cb: StorageListener) => void>; fire: StorageListener };
  };
  runtime: {
    sendMessage: Mock<SendFn>;
    onMessage: { addListener: Mock<(cb: MessageListener) => void>; listeners: MessageListener[] };
  };
}

function fakeChrome(stored: Record<string, unknown> = {}): FakeChrome {
  const storageListeners: StorageListener[] = [];
  const messageListeners: MessageListener[] = [];
  return {
    storage: {
      local: { get: vi.fn<GetFn>(() => Promise.resolve(stored)) },
      onChanged: {
        addListener: vi.fn<(cb: StorageListener) => void>((cb) => {
          storageListeners.push(cb);
        }),
        fire: (changes, areaName) => {
          for (const cb of storageListeners) cb(changes, areaName);
        },
      },
    },
    runtime: {
      sendMessage: vi.fn<SendFn>(() => Promise.resolve()),
      onMessage: {
        addListener: vi.fn<(cb: MessageListener) => void>((cb) => {
          messageListeners.push(cb);
        }),
        listeners: messageListeners,
      },
    },
  };
}

const g = globalThis as unknown as { chrome?: unknown };

function installChrome(fake: FakeChrome): FakeChrome {
  g.chrome = fake;
  return fake;
}

let counter = 0;

function mk(overrides: Partial<SiteScript> = {}): SiteScript {
  counter += 1;
  const now = `2026-01-01T00:00:0${counter}.000Z`;
  return {
    id: `id-${counter}`,
    name: `Script ${counter}`,
    description: 'A test script.',
    urlPattern: '*://localhost/*',
    kind: 'css',
    priority: 3,
    code: `.s${counter} { color: red; }`,
    enabled: true,
    trial: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function styleEl(doc: Document = document): HTMLStyleElement | null {
  return doc.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
}

function sentMessages(fake: FakeChrome): ContentMessage[] {
  return fake.runtime.sendMessage.mock.calls.map((call) => call[0] as ContentMessage);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  counter = 0;
});

afterEach(() => {
  delete g.chrome;
  styleEl()?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// computeCss
// ---------------------------------------------------------------------------

describe('computeCss', () => {
  const url = 'http://localhost:3000/page';

  it('returns an empty string when nothing matches', () => {
    expect(computeCss([], url)).toBe('');
    expect(computeCss(undefined, url)).toBe('');
    expect(computeCss('garbage', url)).toBe('');
  });

  it('keeps only enabled css scripts whose pattern matches the url', () => {
    const keep = mk({ code: '.keep { color: red; }' });
    const disabled = mk({ enabled: false, code: '.disabled { color: red; }' });
    const js = mk({ kind: 'js', code: 'window.x = 1' });
    const other = mk({ urlPattern: 'https://example.com/*', code: '.other { color: red; }' });
    const css = computeCss([disabled, js, other, keep], url);
    expect(css).toContain('.keep');
    expect(css).toContain(`sitecraft:${keep.id}`);
    expect(css).not.toContain('.disabled');
    expect(css).not.toContain('window.x');
    expect(css).not.toContain('.other');
  });

  it('orders priority 1 before priority 5', () => {
    const late = mk({ priority: 5, code: '.late { color: red; }' });
    const early = mk({ priority: 1, code: '.early { color: red; }' });
    const css = computeCss([late, early], url);
    expect(css.indexOf('.early')).toBeGreaterThan(-1);
    expect(css.indexOf('.early')).toBeLessThan(css.indexOf('.late'));
  });

  it('ignores malformed entries instead of throwing', () => {
    const good = mk({ code: '.good { color: red; }' });
    const css = computeCss([null, 42, { kind: 'css', enabled: true }, good], url);
    expect(css).toContain('.good');
  });
});

// ---------------------------------------------------------------------------
// applyCss / isCssBlocked
// ---------------------------------------------------------------------------

describe('applyCss', () => {
  it('inserts one style element with the given text', () => {
    const style = applyCss(document, 'body { color: red; }');
    expect(style).not.toBeNull();
    expect(style?.id).toBe(STYLE_ELEMENT_ID);
    expect(style?.textContent).toBe('body { color: red; }');
    expect(document.querySelectorAll(`#${STYLE_ELEMENT_ID}`).length).toBe(1);
  });

  it('reuses the existing element on a second call', () => {
    const first = applyCss(document, 'a { color: red; }');
    const second = applyCss(document, 'b { color: blue; }');
    expect(second).toBe(first);
    expect(styleEl()?.textContent).toBe('b { color: blue; }');
    expect(document.querySelectorAll(`#${STYLE_ELEMENT_ID}`).length).toBe(1);
  });

  it('removes the element when the css is empty', () => {
    applyCss(document, 'a { color: red; }');
    expect(applyCss(document, '')).toBeNull();
    expect(styleEl()).toBeNull();
  });

  it('does nothing for empty css when no element exists', () => {
    expect(applyCss(document, '')).toBeNull();
    expect(styleEl()).toBeNull();
  });

  it('falls back to documentElement when head does not exist yet', () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.head.remove();
    expect(doc.head).toBeNull();
    const style = applyCss(doc, 'p { margin: 0; }');
    expect(style?.parentNode).toBe(doc.documentElement);
  });
});

describe('isCssBlocked', () => {
  it('is false for empty css', () => {
    const style = document.createElement('style');
    expect(isCssBlocked(style, '')).toBe(false);
  });

  it('is true when the sheet is missing', () => {
    const style = document.createElement('style');
    style.textContent = 'a { color: red; }';
    expect(style.sheet).toBeNull();
    expect(isCssBlocked(style, 'a { color: red; }')).toBe(true);
  });

  it('is true when the sheet has no rules', () => {
    const style = applyCss(document, '/* nothing */');
    expect(style).not.toBeNull();
    expect(isCssBlocked(style as HTMLStyleElement, '/* nothing */')).toBe(true);
  });

  it('is false when rules parsed', () => {
    const style = applyCss(document, 'a { color: red; }');
    expect(isCssBlocked(style as HTMLStyleElement, 'a { color: red; }')).toBe(false);
  });

  it('is true when reading the sheet throws', () => {
    const style = document.createElement('style');
    Object.defineProperty(style, 'sheet', {
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(isCssBlocked(style, 'a { color: red; }')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// installCss (storage read + live swap)
// ---------------------------------------------------------------------------

describe('installCss', () => {
  const url = 'http://localhost:3000/';

  it('inserts the bundle for the stored scripts', async () => {
    const chrome = fakeChrome({ scripts: [mk({ priority: 2, code: '.b { x: 1 }' }), mk({ priority: 1, code: '.a { x: 1 }' })] });
    const send = vi.fn();
    await installCss(document, url, chrome.storage, send);
    expect(chrome.storage.local.get).toHaveBeenCalledWith(['scripts']);
    const text = styleEl()?.textContent ?? '';
    expect(text).toContain('.a');
    expect(text).toContain('.b');
    expect(text.indexOf('.a')).toBeLessThan(text.indexOf('.b'));
    expect(send).not.toHaveBeenCalled();
  });

  it('inserts nothing when no css matches', async () => {
    const chrome = fakeChrome({ scripts: [mk({ kind: 'js' })] });
    await installCss(document, url, chrome.storage, vi.fn());
    expect(styleEl()).toBeNull();
  });

  it('sends cssBlocked when the sheet has no rules', async () => {
    const chrome = fakeChrome({ scripts: [mk({ code: '/* comment only */' })] });
    const send = vi.fn();
    await installCss(document, url, chrome.storage, send);
    expect(send).toHaveBeenCalledWith({ type: 'cssBlocked', url });
  });

  it('sends cssBlocked when the sheet is null', async () => {
    vi.spyOn(HTMLStyleElement.prototype, 'sheet', 'get').mockReturnValue(null);
    const chrome = fakeChrome({ scripts: [mk()] });
    const send = vi.fn();
    await installCss(document, url, chrome.storage, send);
    expect(send).toHaveBeenCalledWith({ type: 'cssBlocked', url });
  });

  it('swaps the style text on a local scripts change', async () => {
    const chrome = fakeChrome({ scripts: [mk({ code: '.one { x: 1 }' })] });
    await installCss(document, url, chrome.storage, vi.fn());
    expect(styleEl()?.textContent).toContain('.one');

    chrome.storage.onChanged.fire({ scripts: { newValue: [mk({ code: '.two { x: 1 }' })] } }, 'local');
    expect(styleEl()?.textContent).toContain('.two');
    expect(styleEl()?.textContent).not.toContain('.one');

    chrome.storage.onChanged.fire({ scripts: { newValue: [] } }, 'local');
    expect(styleEl()).toBeNull();

    chrome.storage.onChanged.fire({ scripts: { newValue: [mk({ code: '.three { x: 1 }' })] } }, 'local');
    expect(styleEl()?.textContent).toContain('.three');
  });

  it('ignores changes from other areas and other keys', async () => {
    const chrome = fakeChrome({ scripts: [mk({ code: '.one { x: 1 }' })] });
    await installCss(document, url, chrome.storage, vi.fn());
    chrome.storage.onChanged.fire({ scripts: { newValue: [] } }, 'sync');
    chrome.storage.onChanged.fire({ settings: { newValue: {} } }, 'local');
    expect(styleEl()?.textContent).toContain('.one');
  });

  it('does not let a slow initial read overwrite a newer change', async () => {
    const chrome = fakeChrome();
    let resolveGet: (value: Record<string, unknown>) => void = () => undefined;
    chrome.storage.local.get.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const done = installCss(document, url, chrome.storage, vi.fn());
    chrome.storage.onChanged.fire({ scripts: { newValue: [mk({ code: '.newer { x: 1 }' })] } }, 'local');
    expect(styleEl()?.textContent).toContain('.newer');
    resolveGet({ scripts: [mk({ code: '.older { x: 1 }' })] });
    await done;
    expect(styleEl()?.textContent).toContain('.newer');
    expect(styleEl()?.textContent).not.toContain('.older');
  });

  it('warns instead of throwing when storage fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chrome = fakeChrome();
    chrome.storage.local.get.mockImplementation(() => Promise.reject(new Error('boom')));
    await expect(installCss(document, url, chrome.storage, vi.fn())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(styleEl()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error relay
// ---------------------------------------------------------------------------

describe('installErrorRelay', () => {
  function post(data: unknown, source: Window | null = window): void {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  }

  it('forwards trusted script-error posts', () => {
    const send = vi.fn();
    const remove = installErrorRelay(window, send);
    post({ source: 'sitecraft', type: 'script-error', scriptId: 'abc', message: 'boom' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'scriptError',
      scriptId: 'abc',
      message: 'boom',
      url: window.location.href,
    });
    remove();
    post({ source: 'sitecraft', type: 'script-error', scriptId: 'abc', message: 'again' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores messages from other windows', () => {
    const send = vi.fn();
    installErrorRelay(window, send);
    post({ source: 'sitecraft', type: 'script-error', scriptId: 'abc', message: 'boom' }, null);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores messages with the wrong source, type or shape', () => {
    const send = vi.fn();
    installErrorRelay(window, send);
    post({ source: 'other', type: 'script-error', scriptId: 'abc', message: 'boom' });
    post({ source: 'sitecraft', type: 'hello', scriptId: 'abc', message: 'boom' });
    post({ source: 'sitecraft', type: 'script-error', message: 'no id' });
    post('sitecraft');
    post(null);
    expect(send).not.toHaveBeenCalled();
  });

  it('coerces a non-string message to text', () => {
    const send = vi.fn();
    installErrorRelay(window, send);
    post({ source: 'sitecraft', type: 'script-error', scriptId: 'abc', message: 42 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ scriptId: 'abc', message: '42' }));
  });
});

// ---------------------------------------------------------------------------
// Message handlers (takeSnapshot / inspect)
// ---------------------------------------------------------------------------

describe('handleContentRequest', () => {
  it('answers takeSnapshot with a capped snapshot string', () => {
    document.body.innerHTML = '<main id="m">Hello</main>';
    const reply = handleContentRequest(document, { type: 'takeSnapshot', maxChars: 5000 });
    expect(typeof reply).toBe('string');
    expect(reply as string).toContain('<main id="m">Hello</main>');
    const small = handleContentRequest(document, { type: 'takeSnapshot', maxChars: 60 }) as string;
    expect(small.length).toBeLessThanOrEqual(60);
  });

  it('answers inspect with the first match and the count', () => {
    document.body.innerHTML = '<div class="x">A</div><div class="x">B</div>';
    expect(handleContentRequest(document, { type: 'inspect', selector: '.x', maxChars: 1000 })).toEqual({
      ok: true,
      html: '<div class="x">A</div>',
      count: 2,
    });
    expect(handleContentRequest(document, { type: 'inspect', selector: '.none' })).toEqual({
      ok: true,
      html: '',
      count: 0,
    });
    const bad = handleContentRequest(document, { type: 'inspect', selector: '[[' }) as { ok: boolean };
    expect(bad.ok).toBe(false);
  });

  it('returns undefined for unknown messages', () => {
    expect(handleContentRequest(document, { type: 'other' })).toBeUndefined();
    expect(handleContentRequest(document, null)).toBeUndefined();
    expect(handleContentRequest(document, 'takeSnapshot')).toBeUndefined();
  });
});

describe('installMessageHandlers', () => {
  it('responds synchronously and does not return true', () => {
    document.body.innerHTML = '<p id="p">Text</p>';
    const chrome = fakeChrome();
    installMessageHandlers(document, chrome.runtime.onMessage);
    const listener = chrome.runtime.onMessage.listeners[0];
    expect(listener).toBeDefined();
    if (!listener) return;

    const snap = vi.fn();
    expect(listener({ type: 'takeSnapshot', maxChars: 1000 }, {}, snap)).not.toBe(true);
    expect(snap).toHaveBeenCalledTimes(1);
    expect(snap.mock.calls[0]?.[0]).toContain('<p id="p">Text</p>');

    const insp = vi.fn();
    expect(listener({ type: 'inspect', selector: '#p', maxChars: 1000 }, {}, insp)).not.toBe(true);
    expect(insp).toHaveBeenCalledWith({ ok: true, html: '<p id="p">Text</p>', count: 1 });

    const other = vi.fn();
    expect(listener({ type: 'somethingElse' }, {}, other)).not.toBe(true);
    expect(other).not.toHaveBeenCalled();
  });

  it('answers inspect with ok:false when the handler throws', () => {
    const chrome = fakeChrome();
    installMessageHandlers(document, chrome.runtime.onMessage);
    const listener = chrome.runtime.onMessage.listeners[0];
    if (!listener) throw new Error('listener missing');
    vi.spyOn(document, 'querySelectorAll').mockImplementation(() => {
      throw new Error('kaput');
    });
    const insp = vi.fn();
    listener({ type: 'inspect', selector: '#p' }, {}, insp);
    expect(insp).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

// ---------------------------------------------------------------------------
// createSender
// ---------------------------------------------------------------------------

describe('createSender', () => {
  it('sends the message through runtime.sendMessage', () => {
    const chrome = fakeChrome();
    const send = createSender(chrome.runtime);
    send({ type: 'cssBlocked', url: 'http://localhost:3000/' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'cssBlocked', url: 'http://localhost:3000/' });
  });

  it('swallows a rejected promise and a synchronous throw', async () => {
    const chrome = fakeChrome();
    chrome.runtime.sendMessage.mockImplementationOnce(() => Promise.reject(new Error('Receiving end does not exist.')));
    const send = createSender(chrome.runtime);
    expect(() => send({ type: 'cssBlocked', url: 'u' })).not.toThrow();
    await flush();
    chrome.runtime.sendMessage.mockImplementationOnce(() => {
      throw new Error('Extension context invalidated.');
    });
    expect(() => send({ type: 'cssBlocked', url: 'u' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// start (full wiring through globalThis.chrome)
// ---------------------------------------------------------------------------

describe('start', () => {
  it('wires css, error relay and message handlers using the global chrome', async () => {
    document.body.innerHTML = '<section id="s">S</section>';
    const chrome = installChrome(fakeChrome({ scripts: [mk({ code: '.wired { x: 1 }' })] }));
    await start();

    expect(styleEl()?.textContent).toContain('.wired');
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'sitecraft', type: 'script-error', scriptId: 'id-9', message: 'nope' },
        source: window,
      }),
    );
    expect(sentMessages(chrome)).toContainEqual({
      type: 'scriptError',
      scriptId: 'id-9',
      message: 'nope',
      url: window.location.href,
    });

    const listener = chrome.runtime.onMessage.listeners[0];
    const reply = vi.fn();
    listener?.({ type: 'inspect', selector: '#s' }, {}, reply);
    expect(reply).toHaveBeenCalledWith({ ok: true, html: '<section id="s">S</section>', count: 1 });
  });

  it('reports cssBlocked through the global chrome when the sheet is empty', async () => {
    const chrome = installChrome(fakeChrome({ scripts: [mk({ code: '/* blocked */' })] }));
    await start();
    expect(sentMessages(chrome)).toContainEqual({ type: 'cssBlocked', url: window.location.href });
  });

  it('does not throw when chrome is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete g.chrome;
    await expect(start()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
