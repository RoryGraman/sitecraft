/**
 * Chrome extension match patterns.
 * Spec: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 *
 * Grammar: <scheme>://<host><path>
 *   scheme: '*' (http or https), 'http', 'https', 'file', 'ftp'
 *   host:   '*' | '*.example.com' | 'example.com' | 'localhost' | IP  (with optional :port)
 *   path:   must start with '/', '*' matches any run of characters
 *   '<all_urls>' matches everything.
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

/** Parse a match pattern. Returns null when the pattern is invalid. */
export function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  void pattern;
  throw new Error('not implemented');
}

/** True when the pattern is syntactically valid. */
export function isValidMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null;
}

/** True when `url` matches `pattern`. Invalid patterns and invalid URLs return false. */
export function matchesPattern(pattern: string, url: string): boolean {
  void pattern;
  void url;
  throw new Error('not implemented');
}

/**
 * Build the default pattern for a page URL: same scheme and host, any path.
 * e.g. https://www.youtube.com/watch?v=1 -> https://www.youtube.com/*
 * Returns null for unsupported URLs (chrome://, about:, data:, ...).
 */
export function patternForUrl(url: string): string | null {
  void url;
  throw new Error('not implemented');
}
