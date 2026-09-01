/**
 * Chrome extension match patterns.
 * Spec: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 *
 * Grammar: <scheme>://<host><path>
 *   scheme: '*' (http or https), 'http', 'https', 'file', 'ftp'. Lowercase only, as in Chrome.
 *   host:   '*' | '*.example.com' | 'example.com' | 'localhost' | IPv4 | '[IPv6]'  (with optional :port)
 *           Hosts are compared case-insensitively. A trailing dot is ignored.
 *           '*.host' needs at least two labels after the star, so '*.com' is rejected.
 *   path:   must start with '/', '*' matches any run of characters. '?' and '#' are not allowed.
 *           The path is matched against pathname + search of the URL. The fragment is ignored.
 *   '<all_urls>' matches every URL with a supported scheme.
 *
 * The patterns accepted here are handed straight to chrome.userScripts.register, so the
 * parser stays at least as strict as Chrome.
 */

export interface ParsedMatchPattern {
  scheme: '*' | 'http' | 'https' | 'file' | 'ftp';
  /** Host without the leading '*.'. Empty string for file:// patterns. '*' for any host. */
  host: string;
  /** True when the pattern starts with '*.' (matches host and all subdomains). */
  subdomains: boolean;
  /** Port or null when unspecified. '*' means any port. */
  port: string | null;
  /** Path glob, always starts with '/'. */
  path: string;
  /** True for the '<all_urls>' pattern. */
  allUrls: boolean;
}

type Scheme = ParsedMatchPattern['scheme'];

const ALL_URLS = '<all_urls>';

const PATTERN_SCHEMES: ReadonlySet<string> = new Set(['*', 'http', 'https', 'file', 'ftp']);

/** URL schemes a pattern can ever match. */
const URL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'file', 'ftp']);

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443', ftp: '21' };

/** Dot-separated labels of letters, digits, '-' and '_'. */
const HOST_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** Starts with '/', no whitespace, no query, no fragment. */
const PATH_RE = /^\/[^\s?#]*$/;

const PORT_RE = /^\d{1,5}$/;

const MAX_PORT = 65535;

function isPatternScheme(value: string): value is Scheme {
  return PATTERN_SCHEMES.has(value);
}

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** Normalize a port token. Returns null when invalid. */
function parsePort(token: string): string | null {
  if (token === '*') return '*';
  if (!PORT_RE.test(token)) return null;
  const n = Number(token);
  return n <= MAX_PORT ? String(n) : null;
}

interface HostPort {
  host: string;
  subdomains: boolean;
  port: string | null;
}

/** Canonicalize a bracketed IPv6 literal through the URL parser. Returns null when invalid. */
function parseIpv6Literal(literal: string): string | null {
  try {
    const hostname = new URL(`http://${literal}/`).hostname;
    return hostname.startsWith('[') ? hostname : null;
  } catch {
    return null;
  }
}

function parseHostPort(input: string): HostPort | null {
  if (input.startsWith('[')) {
    const close = input.indexOf(']');
    if (close < 0) return null;
    const host = parseIpv6Literal(input.slice(0, close + 1));
    if (host === null) return null;
    const rest = input.slice(close + 1);
    if (rest === '') return { host, subdomains: false, port: null };
    if (!rest.startsWith(':')) return null;
    const port = parsePort(rest.slice(1));
    return port === null ? null : { host, subdomains: false, port };
  }

  let hostPart = input;
  let port: string | null = null;
  const colon = hostPart.indexOf(':');
  if (colon >= 0) {
    port = parsePort(hostPart.slice(colon + 1));
    if (port === null) return null;
    hostPart = hostPart.slice(0, colon);
  }

  hostPart = hostPart.toLowerCase();
  if (hostPart === '*') return { host: '*', subdomains: false, port };

  let subdomains = false;
  if (hostPart.startsWith('*.')) {
    subdomains = true;
    hostPart = hostPart.slice(2);
  }
  hostPart = stripTrailingDot(hostPart);
  if (!HOST_RE.test(hostPart)) return null;
  if (subdomains && !hostPart.includes('.')) return null;
  return { host: hostPart, subdomains, port };
}

/** Parse a match pattern. Returns null when the pattern is invalid. */
export function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  if (typeof pattern !== 'string') return null;
  if (pattern === ALL_URLS) {
    return { scheme: '*', host: '*', subdomains: false, port: null, path: '/*', allUrls: true };
  }

  const separator = pattern.indexOf('://');
  if (separator <= 0) return null;
  const scheme = pattern.slice(0, separator);
  if (!isPatternScheme(scheme)) return null;
  const rest = pattern.slice(separator + 3);

  if (scheme === 'file') {
    if (!PATH_RE.test(rest)) return null;
    return { scheme, host: '', subdomains: false, port: null, path: rest, allUrls: false };
  }

  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const path = rest.slice(slash);
  if (!PATH_RE.test(path)) return null;
  const hostPort = parseHostPort(rest.slice(0, slash));
  if (hostPort === null) return null;
  return { scheme, ...hostPort, path, allUrls: false };
}

/** True when the pattern is syntactically valid. */
export function isValidMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null;
}

function schemeMatches(patternScheme: Scheme, urlScheme: string): boolean {
  if (patternScheme === '*') return urlScheme === 'http' || urlScheme === 'https';
  return patternScheme === urlScheme;
}

function hostMatches(parsed: ParsedMatchPattern, hostname: string): boolean {
  if (parsed.host === '*') return true;
  const host = stripTrailingDot(hostname.toLowerCase());
  if (host === parsed.host) return true;
  return parsed.subdomains && host.endsWith(`.${parsed.host}`);
}

function portMatches(patternPort: string | null, url: URL, urlScheme: string): boolean {
  if (patternPort === null || patternPort === '*') return true;
  const effective = url.port !== '' ? url.port : DEFAULT_PORTS[urlScheme];
  if (effective === undefined) return false;
  return Number(effective) === Number(patternPort);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathMatches(glob: string, url: URL): boolean {
  const source = glob.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 's').test(url.pathname + url.search);
}

/** True when `url` matches `pattern`. Invalid patterns and invalid URLs return false. */
export function matchesPattern(pattern: string, url: string): boolean {
  try {
    const parsed = parseMatchPattern(pattern);
    if (parsed === null || typeof url !== 'string') return false;
    const parsedUrl = new URL(url);
    const urlScheme = parsedUrl.protocol.slice(0, -1);
    if (!URL_SCHEMES.has(urlScheme)) return false;
    if (parsed.allUrls) return true;
    if (!schemeMatches(parsed.scheme, urlScheme)) return false;
    if (parsed.scheme !== 'file') {
      if (!hostMatches(parsed, parsedUrl.hostname)) return false;
      if (!portMatches(parsed.port, parsedUrl, urlScheme)) return false;
    }
    return pathMatches(parsed.path, parsedUrl);
  } catch {
    return false;
  }
}

/**
 * Build the default pattern for a page URL: same scheme and host, any path.
 * e.g. https://www.youtube.com/watch?v=1 -> https://www.youtube.com/*
 * Returns null for unsupported URLs (chrome://, about:, data:, ...).
 */
export function patternForUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol === 'file:') return 'file:///*';
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
  const host = stripTrailingDot(parsedUrl.hostname);
  if (host === '') return null;
  const hostPort = parsedUrl.port !== '' ? `${host}:${parsedUrl.port}` : host;
  const pattern = `${parsedUrl.protocol}//${hostPort}/*`;
  return isValidMatchPattern(pattern) ? pattern : null;
}
