import { describe, expect, it } from 'vitest';
import { isValidMatchPattern, matchesPattern, parseMatchPattern, patternForUrl } from '../src/matchPattern.js';

describe('parseMatchPattern', () => {
  it('parses a host pattern', () => {
    expect(parseMatchPattern('https://www.youtube.com/*')).toEqual({
      scheme: 'https',
      host: 'www.youtube.com',
      subdomains: false,
      port: null,
      path: '/*',
      allUrls: false,
    });
  });
  it('parses subdomain wildcard and port', () => {
    expect(parseMatchPattern('*://*.example.com:8080/foo*')).toMatchObject({
      scheme: '*',
      host: 'example.com',
      subdomains: true,
      port: '8080',
      path: '/foo*',
    });
  });
  it('parses <all_urls>', () => {
    expect(parseMatchPattern('<all_urls>')).toMatchObject({ allUrls: true });
  });
  it('parses file patterns', () => {
    expect(parseMatchPattern('file:///Users/*')).toMatchObject({ scheme: 'file', host: '', path: '/Users/*' });
    expect(parseMatchPattern('file:///*')).toMatchObject({ scheme: 'file', host: '', port: null, path: '/*' });
  });
  it.each([
    '',
    'youtube.com/*',
    'https://*foo.com/*',
    'https://www.youtube.com',
    'ws://a.com/*',
    'https://*.com/*',
    'https://a.com/*?x=*',
  ])('rejects %s', (p) => {
    expect(parseMatchPattern(p)).toBeNull();
    expect(isValidMatchPattern(p)).toBe(false);
  });

  it('parses the all-hosts pattern', () => {
    expect(parseMatchPattern('*://*/*')).toEqual({
      scheme: '*',
      host: '*',
      subdomains: false,
      port: null,
      path: '/*',
      allUrls: false,
    });
  });
  it('parses a star host with a port', () => {
    expect(parseMatchPattern('http://*:8080/*')).toMatchObject({ host: '*', subdomains: false, port: '8080' });
  });
  it('parses IPv4 hosts', () => {
    expect(parseMatchPattern('http://127.0.0.1/*')).toMatchObject({ host: '127.0.0.1', port: null });
    expect(parseMatchPattern('http://127.0.0.1:4174/*')).toMatchObject({ host: '127.0.0.1', port: '4174' });
  });
  it('parses bracketed IPv6 hosts', () => {
    expect(parseMatchPattern('http://[::1]:4174/*')).toMatchObject({ host: '[::1]', port: '4174', path: '/*' });
    expect(parseMatchPattern('http://[::1]/*')).toMatchObject({ host: '[::1]', port: null });
  });
  it('lowercases the host', () => {
    expect(parseMatchPattern('https://A.COM/*')).toMatchObject({ host: 'a.com' });
    expect(parseMatchPattern('https://*.Example.COM/*')).toMatchObject({ host: 'example.com', subdomains: true });
  });
  it('drops a trailing dot from the host', () => {
    expect(parseMatchPattern('https://a.com./*')).toMatchObject({ host: 'a.com' });
  });
  it('accepts a wildcard port', () => {
    expect(parseMatchPattern('https://a.com:*/*')).toMatchObject({ host: 'a.com', port: '*' });
  });
  it('normalizes port digits', () => {
    expect(parseMatchPattern('https://a.com:08080/*')).toMatchObject({ port: '8080' });
  });
  it('keeps the path as written', () => {
    expect(parseMatchPattern('https://a.com/')).toMatchObject({ path: '/' });
    expect(parseMatchPattern('https://a.com/**')).toMatchObject({ path: '/**' });
    expect(parseMatchPattern('https://a.com/a/b*/c')).toMatchObject({ path: '/a/b*/c' });
  });
  it.each([
    'HTTPS://a.com/*',
    'Https://a.com/*',
    'https://a.com:/*',
    'https://a.com:99999/*',
    'https://a.com:80a/*',
    'https://a.com:8080',
    'https://',
    'https:///*',
    'https://a..com/*',
    'https://.a.com/*',
    'https://foo.*.com/*',
    'https://*.*/*',
    'https://a.com/*#x',
    'https://a.com/a b',
    ' https://a.com/*',
    'https://a.com/* ',
    'https://user@a.com/*',
    'https://a com/*',
    'wss://a.com/*',
    'chrome://extensions/*',
    'chrome-extension://abc/*',
    'file://host/*',
    'file://*/*',
    'file://',
    'file:///a?b',
    'http://[::1/*',
    'http://[zz]/*',
    '<all_urls',
    '*',
    '*://',
    '*://*',
    '://a.com/*',
  ])('rejects %s', (p) => {
    expect(parseMatchPattern(p)).toBeNull();
    expect(isValidMatchPattern(p)).toBe(false);
  });
  it('returns null for non-string input', () => {
    expect(parseMatchPattern(undefined as unknown as string)).toBeNull();
    expect(parseMatchPattern(null as unknown as string)).toBeNull();
    expect(parseMatchPattern(42 as unknown as string)).toBeNull();
  });
});

describe('matchesPattern', () => {
  it.each([
    ['https://www.youtube.com/*', 'https://www.youtube.com/watch?v=1', true],
    ['https://www.youtube.com/*', 'https://m.youtube.com/', false],
    ['*://*.youtube.com/*', 'https://m.youtube.com/', true],
    ['*://*.youtube.com/*', 'https://youtube.com/', true],
    ['*://*.youtube.com/*', 'https://notyoutube.com/', false],
    ['*://*/*', 'http://anything.test/x', true],
    ['*://*/*', 'ftp://anything.test/x', false],
    ['<all_urls>', 'file:///tmp/a.html', true],
    ['http://localhost:4174/*', 'http://localhost:4174/index.html', true],
    ['http://localhost/*', 'http://localhost:4174/index.html', true],
    ['http://localhost:4174/*', 'http://localhost:4175/index.html', false],
    ['https://a.com/foo*', 'https://a.com/foobar', true],
    ['https://a.com/foo*', 'https://a.com/fo', false],
    ['https://a.com/*/bar', 'https://a.com/x/y/bar', true],
    ['https://a.com/*', 'https://a.com/', true],
    ['https://a.com/*', 'https://a.com', true],
    ['https://a.com/*', 'https://A.COM/x', true],
    ['https://a.com/*', 'not a url', false],
    ['garbage', 'https://a.com/', false],
  ])('%s vs %s -> %s', (p, u, expected) => {
    expect(matchesPattern(p, u)).toBe(expected);
  });
  it('matches query strings as part of the path', () => {
    expect(matchesPattern('https://a.com/watch*', 'https://a.com/watch?v=1')).toBe(true);
    expect(matchesPattern('https://a.com/watch', 'https://a.com/watch?v=1')).toBe(false);
  });
  it('ignores the fragment', () => {
    expect(matchesPattern('https://a.com/page', 'https://a.com/page#top')).toBe(true);
    expect(matchesPattern('https://a.com/page', 'https://a.com/page#top?x=1')).toBe(true);
  });

  it.each([
    // schemes
    ['*://a.com/*', 'https://a.com/', true],
    ['*://a.com/*', 'http://a.com/', true],
    ['*://a.com/*', 'file:///a.com/', false],
    ['http://a.com/*', 'https://a.com/', false],
    ['https://a.com/*', 'HTTPS://A.COM/x', true],
    ['ftp://a.com/*', 'ftp://a.com/pub/', true],
    ['<all_urls>', 'https://a.com/', true],
    ['<all_urls>', 'http://127.0.0.1:4174/', true],
    ['<all_urls>', 'ftp://a.com/', true],
    ['<all_urls>', 'chrome://extensions/', false],
    ['<all_urls>', 'about:blank', false],
    ['<all_urls>', 'not a url', false],
    // ports
    ['http://localhost:80/*', 'http://localhost/', true],
    ['https://a.com:443/*', 'https://a.com/', true],
    ['https://a.com:8443/*', 'https://a.com/', false],
    ['https://a.com/*', 'https://a.com:8443/', true],
    ['https://a.com:*/*', 'https://a.com:8443/', true],
    ['http://127.0.0.1/*', 'http://127.0.0.1:4174/', true],
    ['http://127.0.0.1:4174/*', 'http://127.0.0.1:4174/x', true],
    ['http://127.0.0.1:4174/*', 'http://127.0.0.1/x', false],
    ['http://*:4174/*', 'http://localhost:4174/x', true],
    ['http://*:4174/*', 'http://localhost/x', false],
    ['http://[::1]:4174/*', 'http://[::1]:4174/x', true],
    ['http://[::1]/*', 'http://[0:0:0:0:0:0:0:1]:4174/x', true],
    // hosts
    ['https://a.com/*', 'https://a.com./x', true],
    ['https://a.com./*', 'https://a.com/x', true],
    ['*://*.a.com/*', 'http://x.y.a.com/', true],
    ['*://*.a.com/*', 'https://a.com.evil.com/', false],
    ['*://*.a.com/*', 'https://xa.com/', false],
    ['https://a.com/*', 'https://user:pw@a.com/', true],
    ['https://a.com/*', 'https://b.com/', false],
    ['https://*/*', 'https://anything.example/', true],
    ['https://*/*', 'https://[::1]/', true],
    ['https://*/*', 'http://anything.example/', false],
    // paths
    ['https://a.com/path', 'https://a.com/Path', false],
    ['https://a.com/a*c', 'https://a.com/abc', true],
    ['https://a.com/a*c', 'https://a.com/ac', true],
    ['https://a.com/a*c', 'https://a.com/ab', false],
    ['https://a.com/a.b*', 'https://a.com/a.bc', true],
    ['https://a.com/a.b*', 'https://a.com/aXbc', false],
    ['https://a.com/x+y', 'https://a.com/x+y', true],
    ['https://a.com/(x)', 'https://a.com/(x)', true],
    ['https://a.com/', 'https://a.com/x', false],
    ['https://a.com/', 'https://a.com/?q=1', false],
    ['https://a.com/*', 'https://a.com/x#frag?y', true],
    ['https://a.com/*?*', 'https://a.com/x?y', false],
    // file
    ['file:///Users/*', 'file:///Users/x/a.html', true],
    ['file:///Users/*', 'file:///tmp/a.html', false],
    ['file:///*', 'file:///tmp/a.html', true],
    ['file:///*', 'file://localhost/tmp/a.html', true],
    ['file:///*', 'https://a.com/', false],
    // junk
    ['https://a.com/*', '', false],
    ['', 'https://a.com/', false],
    ['', '', false],
    ['https://a.com/*', 'chrome://extensions/', false],
    ['https://a.com/*', 'https://a.com/%', true],
  ])('%s vs %s -> %s', (p, u, expected) => {
    expect(matchesPattern(p, u)).toBe(expected);
  });

  it('never throws on non-string input', () => {
    expect(matchesPattern(undefined as unknown as string, 'https://a.com/')).toBe(false);
    expect(matchesPattern('https://a.com/*', undefined as unknown as string)).toBe(false);
    expect(matchesPattern(null as unknown as string, null as unknown as string)).toBe(false);
    expect(matchesPattern({} as unknown as string, 12 as unknown as string)).toBe(false);
  });
});

describe('patternForUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=1', 'https://www.youtube.com/*'],
    ['http://localhost:4174/index.html', 'http://localhost:4174/*'],
    ['file:///Users/x/a.html', 'file:///*'],
    ['chrome://extensions/', null],
    ['about:blank', null],
    ['data:text/html,hi', null],
    ['nonsense', null],
  ])('%s -> %s', (u, expected) => {
    expect(patternForUrl(u)).toBe(expected);
  });

  it.each([
    ['https://A.COM/x', 'https://a.com/*'],
    ['https://a.com./x', 'https://a.com/*'],
    ['https://a.com:443/', 'https://a.com/*'],
    ['https://user:pw@a.com:8443/x#y', 'https://a.com:8443/*'],
    ['http://127.0.0.1:4174/', 'http://127.0.0.1:4174/*'],
    ['http://[::1]:4174/', 'http://[::1]:4174/*'],
    ['https://bücher.de/', 'https://xn--bcher-kva.de/*'],
    ['ftp://a.com/x', null],
    ['javascript:void(0)', null],
    ['blob:https://a.com/1234', null],
    ['chrome-extension://abc/x.html', null],
    ['', null],
  ])('%s -> %s', (u, expected) => {
    expect(patternForUrl(u)).toBe(expected);
  });

  it('returns null for non-string input', () => {
    expect(patternForUrl(undefined as unknown as string)).toBeNull();
    expect(patternForUrl(null as unknown as string)).toBeNull();
  });

  it('produces patterns that validate and match the source url', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=1',
      'http://localhost:4174/index.html',
      'http://127.0.0.1/',
      'http://[::1]:4174/x',
      'https://A.COM./x',
      'file:///Users/x/a.html',
    ]) {
      const pattern = patternForUrl(url);
      expect(pattern, url).not.toBeNull();
      expect(isValidMatchPattern(pattern as string), url).toBe(true);
      expect(matchesPattern(pattern as string, url), url).toBe(true);
    }
  });
});
