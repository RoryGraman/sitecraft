/**
 * DOM snapshot trimming.
 *
 * Turns a live page (or one element) into a compact HTML string for the agent.
 * All work happens on a clone, so the page is never changed.
 * Pure DOM logic: no chrome.* calls, so it runs in jsdom tests as-is.
 *
 * Rules, in order:
 *  1. Empty <script> and <style> bodies. Keep the tags and their attributes.
 *  2. Drop the children of <svg>, <noscript>, <template> and <iframe>. Keep the tags.
 *  3. Remove comments.
 *  4. Strip inline style attributes longer than 200 chars.
 *  5. Strip srcset attributes longer than 200 chars.
 *  6. Strip data: URLs longer than 100 chars from any attribute (the "data:" prefix stays).
 *  7. Collapse runs of more than maxRepeatedSiblings consecutive siblings with the same
 *     tag and the same class attribute. Keep the first maxRepeatedSiblings and insert
 *     <!-- sitecraft: N more <tag> siblings collapsed -->.
 *  8. Collapse whitespace runs in text nodes to one space (not inside <pre> or <textarea>).
 *  9. If the result is still longer than maxChars, cut it so that the result plus the
 *     marker <!-- sitecraft: truncated --> fits in maxChars.
 */

import { INSPECT_MAX_CHARS, SNAPSHOT_MAX_CHARS } from '@sitecraft/shared';

export interface SnapshotOptions {
  /** Hard cap on the result length, marker included. Default SNAPSHOT_MAX_CHARS. */
  maxChars?: number;
  /** How many consecutive same-tag same-class siblings to keep. Default 5. */
  maxRepeatedSiblings?: number;
}

export type ElementOuterHtmlResult =
  | { ok: true; html: string; count: number }
  | { ok: false; error: string };

/** Appended when the output had to be cut. */
export const TRUNCATED_MARKER = '<!-- sitecraft: truncated -->';

const DEFAULT_MAX_REPEATED_SIBLINGS = 5;
const MAX_STYLE_ATTR_CHARS = 200;
const MAX_SRCSET_ATTR_CHARS = 200;
const MAX_DATA_URL_CHARS = 100;

/** Elements whose children are dropped. The tag and its attributes stay. */
const EMPTY_CHILDREN_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'svg',
  'noscript',
  'template',
  'iframe',
]);

/** Text inside these elements keeps its whitespace. */
const PRESERVE_WHITESPACE_SELECTOR = 'pre, textarea';

/** A data: URL longer than MAX_DATA_URL_CHARS. "data:" itself is 5 chars. */
const LONG_DATA_URL = new RegExp(`data:[^\\s'")]{${MAX_DATA_URL_CHARS - 5 + 1},}`, 'gi');

export function snapshotDom(root: Document | Element, opts: SnapshotOptions = {}): string {
  const maxChars = opts.maxChars ?? SNAPSHOT_MAX_CHARS;
  const maxRepeated = opts.maxRepeatedSiblings ?? DEFAULT_MAX_REPEATED_SIBLINGS;

  const source = isDocument(root) ? root.documentElement : root;
  if (!source) return '';

  const clone = source.cloneNode(true) as Element;
  trimTree(clone, maxRepeated);
  // Merge text nodes left adjacent by removed comments and collapsed siblings.
  clone.normalize();
  collapseWhitespace(clone);

  return capLength(clone.outerHTML, maxChars);
}

/**
 * Trimmed outer HTML of the first element matching `selector`, plus the match count.
 * Returns ok:false when the selector does not parse.
 */
export function elementOuterHtml(
  root: Document,
  selector: string,
  maxChars: number = INSPECT_MAX_CHARS,
): ElementOuterHtmlResult {
  let matches: NodeListOf<Element>;
  try {
    matches = root.querySelectorAll(selector);
  } catch (e) {
    return { ok: false, error: `Invalid selector "${selector}": ${errorMessage(e)}` };
  }
  const first = matches[0];
  if (!first) return { ok: true, html: '', count: 0 };
  return { ok: true, html: snapshotDom(first, { maxChars }), count: matches.length };
}

// ---------------------------------------------------------------------------
// Internals. Everything below operates on the clone only.
// ---------------------------------------------------------------------------

function isDocument(node: Document | Element): node is Document {
  return node.nodeType === Node.DOCUMENT_NODE;
}

/** Walks the clone top-down. Children removed here are never visited. */
function trimTree(rootEl: Element, maxRepeated: number): void {
  const stack: Element[] = [rootEl];
  for (let el = stack.pop(); el; el = stack.pop()) {
    trimAttributes(el);
    if (EMPTY_CHILDREN_TAGS.has(el.localName)) {
      emptyChildren(el);
      continue;
    }
    removeCommentChildren(el);
    collapseRepeatedChildren(el, maxRepeated);
    for (const child of Array.from(el.children)) stack.push(child);
  }
}

function emptyChildren(el: Element): void {
  el.textContent = '';
  // <template> serializes its content fragment, not its child nodes.
  if (el.localName === 'template' && 'content' in el) {
    (el as HTMLTemplateElement).content.replaceChildren();
  }
}

function trimAttributes(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const { name, value } = attr;
    if (name === 'style' && value.length > MAX_STYLE_ATTR_CHARS) {
      el.removeAttribute(name);
      continue;
    }
    if (name === 'srcset' && value.length > MAX_SRCSET_ATTR_CHARS) {
      el.removeAttribute(name);
      continue;
    }
    if (value.length > MAX_DATA_URL_CHARS) {
      const next = value.replace(LONG_DATA_URL, 'data:');
      if (next !== value) el.setAttribute(name, next);
    }
  }
}

function removeCommentChildren(el: Element): void {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) node.remove();
  }
}

/**
 * Collapses runs of consecutive element children with the same tag and class.
 * Blank text nodes between siblings do not break a run. Other text does.
 */
function collapseRepeatedChildren(el: Element, maxRepeated: number): void {
  if (!Number.isFinite(maxRepeated) || maxRepeated < 1) return;
  const keep = Math.floor(maxRepeated);

  let run: Element[] = [];
  const flush = (): void => {
    const removed = run.slice(keep);
    const firstRemoved = removed[0];
    if (firstRemoved) {
      const marker = el.ownerDocument.createComment(
        ` sitecraft: ${removed.length} more <${firstRemoved.localName}> siblings collapsed `,
      );
      firstRemoved.before(marker);
      for (const node of removed) node.remove();
    }
    run = [];
  };

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      const head = run[0];
      if (head && sameKind(head, child)) {
        run.push(child);
      } else {
        flush();
        run = [child];
      }
    } else if (node.nodeType === Node.TEXT_NODE && !isBlank(node.nodeValue)) {
      flush();
    }
  }
  flush();
}

function sameKind(a: Element, b: Element): boolean {
  return a.localName === b.localName && (a.getAttribute('class') ?? '') === (b.getAttribute('class') ?? '');
}

function isBlank(text: string | null): boolean {
  return text === null || /^\s*$/.test(text);
}

/** Collapses whitespace runs in every text node to one space. */
function collapseWhitespace(rootEl: Element): void {
  const walker = rootEl.ownerDocument.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    texts.push(node as Text);
  }
  for (const text of texts) {
    if (!/\s/.test(text.data)) continue;
    if (text.parentElement?.closest(PRESERVE_WHITESPACE_SELECTOR)) continue;
    text.data = text.data.replace(/\s+/g, ' ');
  }
}

function capLength(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  const cut = Math.max(0, maxChars - TRUNCATED_MARKER.length);
  return html.slice(0, cut) + TRUNCATED_MARKER;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
