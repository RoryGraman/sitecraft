import { describe, expect, it, vi } from 'vitest';
import { buildCssBundle, buildJsBundles, cssForUrl, renderJsBundle, shortHash } from '../src/bundle.js';
import type { SiteScript } from '../src/types.js';

let counter = 0;

function mk(overrides: Partial<SiteScript> = {}): SiteScript {
  counter += 1;
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `id-${counter}`,
    name: `Script ${counter}`,
    description: 'A test script.',
    urlPattern: 'https://a.com/*',
    kind: 'js',
    priority: 3,
    code: '',
    enabled: true,
    trial: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeWindow {
  postMessage: ReturnType<typeof vi.fn>;
  __log: string[];
  [key: string]: unknown;
}

function fakeWindow(): FakeWindow {
  return { postMessage: vi.fn(), __log: [] };
}

function execute(code: string, win: FakeWindow): void {
  const fn = new Function('window', 'document', code) as (w: FakeWindow, d: unknown) => void;
  fn(win, {});
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('shortHash', () => {
  it('returns 8 lowercase hex chars and is deterministic', () => {
    const h = shortHash('a');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash('a')).toBe(h);
  });

  it('differs for different inputs', () => {
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });

  it('pads short hashes to 8 chars', () => {
    expect(shortHash('')).toHaveLength(8);
    expect(shortHash('https://a.com/*')).toHaveLength(8);
  });
});

describe('buildJsBundles', () => {
  it('groups enabled js scripts by exact urlPattern', () => {
    const scripts = [
      mk({ id: 'b1', urlPattern: 'https://b.com/*' }),
      mk({ id: 'a1', urlPattern: 'https://a.com/*' }),
      mk({ id: 'a2', urlPattern: 'https://a.com/*' }),
      mk({ id: 'a3', urlPattern: 'https://a.com/watch*' }),
    ];
    const bundles = buildJsBundles(scripts);
    expect(bundles.map((b) => b.urlPattern)).toEqual([
      'https://a.com/*',
      'https://a.com/watch*',
      'https://b.com/*',
    ]);
    expect(bundles[0]?.scriptIds.sort()).toEqual(['a1', 'a2']);
    expect(bundles[1]?.scriptIds).toEqual(['a3']);
    expect(bundles[2]?.scriptIds).toEqual(['b1']);
  });

  it('skips disabled scripts and css scripts', () => {
    const scripts = [
      mk({ id: 'on' }),
      mk({ id: 'off', enabled: false }),
      mk({ id: 'style', kind: 'css', code: 'body { color: red; }' }),
      mk({ id: 'only-css', kind: 'css', urlPattern: 'https://c.com/*' }),
    ];
    const bundles = buildJsBundles(scripts);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.scriptIds).toEqual(['on']);
    expect(bundles[0]?.code).not.toContain('color: red');
  });

  it('uses a stable id derived from the urlPattern', () => {
    const [bundle] = buildJsBundles([mk({ urlPattern: 'https://x.com/*' })]);
    expect(bundle?.id).toBe('sitecraft-' + shortHash('https://x.com/*'));
    expect(bundle?.id).toMatch(/^sitecraft-[0-9a-f]{8}$/);
  });

  it('lists scriptIds in priority order', () => {
    const scripts = [
      mk({ id: 'c', priority: 3 }),
      mk({ id: 'a', priority: 1 }),
      mk({ id: 'b', priority: 2 }),
    ];
    const [bundle] = buildJsBundles(scripts);
    expect(bundle?.scriptIds).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array when nothing is enabled', () => {
    expect(buildJsBundles([])).toEqual([]);
    expect(buildJsBundles([mk({ enabled: false })])).toEqual([]);
  });

  it('bundle code is the rendered bundle for that group', () => {
    const a = mk({ id: 'a', code: "window.__log.push('a')" });
    const [bundle] = buildJsBundles([a]);
    const win = fakeWindow();
    execute(bundle?.code ?? '', win);
    expect(win.__log).toEqual(['a']);
  });
});

describe('renderJsBundle', () => {
  it('runs priority levels in order 1 to 5', async () => {
    const scripts = [
      mk({ id: 'p1', priority: 1, code: "window.__log.push('a')" }),
      mk({ id: 'p3', priority: 3, code: "window.__log.push('c')" }),
      mk({ id: 'p2', priority: 2, code: "window.__log.push('b')" }),
    ];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toEqual(['a', 'b', 'c']);
  });

  it('waits for async work in a level before starting the next', async () => {
    const scripts = [
      mk({
        id: 'slow',
        priority: 1,
        code: "await new Promise(r => setTimeout(() => { window.__log.push('slow'); r(); }, 5))",
      }),
      mk({ id: 'after', priority: 2, code: "window.__log.push('after')" }),
    ];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    expect(win.__log).toEqual([]);
    await tick(30);
    expect(win.__log).toEqual(['slow', 'after']);
  });

  it('a throwing script does not block later levels and is reported', async () => {
    const scripts = [
      mk({ id: 'bad', priority: 1, code: "throw new Error('boom')" }),
      mk({ id: 'good', priority: 2, code: "window.__log.push('ok')" }),
    ];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toContain('ok');
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    expect(win.postMessage).toHaveBeenCalledWith(
      { source: 'sitecraft', type: 'script-error', scriptId: 'bad', message: 'boom' },
      '*',
    );
  });

  it('a script that returns a rejected promise is reported the same way', async () => {
    const scripts = [
      mk({ id: 'rej', priority: 1, code: "return Promise.reject(new Error('nope'))" }),
      mk({ id: 'good', priority: 2, code: "window.__log.push('ok')" }),
    ];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toEqual(['ok']);
    expect(win.postMessage).toHaveBeenCalledWith(
      { source: 'sitecraft', type: 'script-error', scriptId: 'rej', message: 'nope' },
      '*',
    );
  });

  it('reports non-Error throws as strings', async () => {
    const scripts = [mk({ id: 'str', priority: 1, code: "throw 'plain string'" })];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.postMessage).toHaveBeenCalledWith(
      { source: 'sitecraft', type: 'script-error', scriptId: 'str', message: 'plain string' },
      '*',
    );
  });

  it('a throwing script does not stop its siblings in the same level', async () => {
    const scripts = [
      mk({ id: 'bad', priority: 2, code: "throw new Error('boom')" }),
      mk({ id: 'x', priority: 2, code: "window.__log.push('x')" }),
    ];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toEqual(['x']);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  it('two scripts in the same level both run', async () => {
    const scripts = [
      mk({ id: 'x', priority: 3, code: "window.__log.push('x')" }),
      mk({ id: 'y', priority: 3, code: "window.__log.push('y')" }),
    ];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log.sort()).toEqual(['x', 'y']);
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it('does not leak script variables into the window or global scope', async () => {
    const scripts = [mk({ id: 'leaky', priority: 1, code: "var leaked = 1; window.__log.push('ran')" })];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toEqual(['ran']);
    expect(win.leaked).toBeUndefined();
    expect((globalThis as Record<string, unknown>).leaked).toBeUndefined();
  });

  it('runs each script in strict mode', async () => {
    // Assigning to an undeclared variable throws in strict mode.
    const scripts = [mk({ id: 'sloppy', priority: 1, code: 'undeclaredVariable = 1' })];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const payload = win.postMessage.mock.calls[0]?.[0] as { scriptId: string; message: string };
    expect(payload.scriptId).toBe('sloppy');
    expect(payload.message).toMatch(/undeclaredVariable/);
    expect((globalThis as Record<string, unknown>).undeclaredVariable).toBeUndefined();
    expect(renderJsBundle(scripts)).toContain('"use strict"');
  });

  it('tolerates a trailing line comment in script code', async () => {
    const scripts = [mk({ id: 'c', priority: 1, code: "window.__log.push('done') // trailing" })];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toEqual(['done']);
  });

  it('embeds ids safely even when they contain quotes', async () => {
    const scripts = [mk({ id: 'we"ird\'id', name: 'Na"me', priority: 1, code: "throw new Error('x')" })];
    const win = fakeWindow();
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.postMessage).toHaveBeenCalledWith(
      { source: 'sitecraft', type: 'script-error', scriptId: 'we"ird\'id', message: 'x' },
      '*',
    );
  });

  it('still reports when postMessage itself throws', async () => {
    const scripts = [
      mk({ id: 'bad', priority: 1, code: "throw new Error('boom')" }),
      mk({ id: 'good', priority: 2, code: "window.__log.push('ok')" }),
    ];
    const win = fakeWindow();
    win.postMessage.mockImplementation(() => {
      throw new Error('postMessage blocked');
    });
    execute(renderJsBundle(scripts), win);
    await tick();
    expect(win.__log).toEqual(['ok']);
  });
});

describe('buildCssBundle', () => {
  it('returns an empty string when there is nothing to inject', () => {
    expect(buildCssBundle([])).toBe('');
    expect(buildCssBundle([mk({ kind: 'js', code: 'x()' })])).toBe('');
    expect(buildCssBundle([mk({ kind: 'css', enabled: false, code: 'a{}' })])).toBe('');
  });

  it('ignores disabled and js scripts', () => {
    const css = buildCssBundle([
      mk({ id: 'on', kind: 'css', code: '.on { color: red; }' }),
      mk({ id: 'off', kind: 'css', enabled: false, code: '.off { color: blue; }' }),
      mk({ id: 'js', kind: 'js', code: 'document.title = "x"' }),
    ]);
    expect(css).toContain('.on { color: red; }');
    expect(css).not.toContain('.off');
    expect(css).not.toContain('document.title');
  });

  it('orders priority 1 first, ties by createdAt ascending', () => {
    const css = buildCssBundle([
      mk({ id: 'p3-late', kind: 'css', priority: 3, createdAt: '2026-03-01T00:00:00.000Z', code: '.p3late{}' }),
      mk({ id: 'p1', kind: 'css', priority: 1, createdAt: '2026-05-01T00:00:00.000Z', code: '.p1{}' }),
      mk({ id: 'p3-early', kind: 'css', priority: 3, createdAt: '2026-02-01T00:00:00.000Z', code: '.p3early{}' }),
      mk({ id: 'p5', kind: 'css', priority: 5, createdAt: '2026-01-01T00:00:00.000Z', code: '.p5{}' }),
    ]);
    const order = ['.p1{}', '.p3early{}', '.p3late{}', '.p5{}'].map((s) => css.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('precedes each block with a comment holding the script id and name', () => {
    const css = buildCssBundle([
      mk({ id: 'abc', name: 'Hide banner', kind: 'css', code: '.banner { display: none; }' }),
    ]);
    const marker = '/* sitecraft:abc Hide banner */';
    expect(css).toContain(marker);
    expect(css.indexOf(marker)).toBeLessThan(css.indexOf('.banner { display: none; }'));
  });

  it('does not let a name close the comment early', () => {
    const css = buildCssBundle([
      mk({ id: 'abc', name: 'evil */ body { display: none }', kind: 'css', code: '.x{}' }),
    ]);
    // Exactly one comment terminator, and everything after it is only the real code.
    expect(css.match(/\*\//g)).toHaveLength(1);
    const afterComment = css.slice(css.indexOf('*/') + 2);
    expect(afterComment).not.toContain('display: none');
    expect(afterComment).toContain('.x{}');
  });
});

describe('cssForUrl', () => {
  it('returns an empty string when nothing matches', () => {
    expect(cssForUrl([], 'https://a.com/')).toBe('');
    expect(cssForUrl([mk({ kind: 'js', code: 'd()' })], 'https://a.com/')).toBe('');
  });

  it('keeps only enabled css scripts whose pattern matches the url, priority 1 first', () => {
    const match = mk({ kind: 'css', code: 'a{}', priority: 5 });
    const first = mk({ kind: 'css', code: 'p1{}', priority: 1 });
    const disabled = mk({ kind: 'css', code: 'b{}', enabled: false });
    const otherSite = mk({ kind: 'css', code: 'c{}', urlPattern: 'https://b.com/*' });
    const js = mk({ kind: 'js', code: 'd()' });
    const out = cssForUrl([match, disabled, otherSite, js, first], 'https://a.com/path?x=1');
    expect(out).toContain(`sitecraft:${match.id}`);
    expect(out.indexOf('p1{}')).toBeLessThan(out.indexOf('a{}'));
    expect(out).not.toContain('b{}');
    expect(out).not.toContain('c{}');
    expect(out).not.toContain('d()');
  });

  it('returns an empty string for an unsupported url', () => {
    const css = mk({ kind: 'css', code: 'x{}' });
    expect(cssForUrl([css], 'chrome://extensions')).toBe('');
    expect(cssForUrl([css], 'not a url')).toBe('');
  });
});
