/**
 * Fallback page functions for chrome.scripting.executeScript.
 *
 * The background uses these only when the content script does not answer
 * (for example a tab that was open before the extension was installed).
 * executeScript serializes the function, so each function here must be fully
 * self-contained: no imports, no module-level helpers, no closures. The
 * trimming rules are a simplified copy of src/lib/domSnapshot.ts.
 */

export type PageInspectResult = { ok: true; html: string; count: number } | { ok: false; error: string };

/**
 * Trimmed HTML of the whole document. Runs inside the page (isolated world).
 * Rules: empty script/style/svg/noscript/template/iframe children, drop
 * comments, strip long style/srcset attributes and long data: URLs, collapse
 * runs of more than `maxSiblings` same-tag same-class siblings, collapse
 * whitespace, cap the length with a marker.
 */
export function snapshotInPage(maxChars: number, maxSiblings: number): string {
  const MARKER = '<!-- sitecraft: truncated -->';
  const EMPTY = ['script', 'style', 'svg', 'noscript', 'template', 'iframe'];
  const root = document.documentElement;
  if (!root) return '';
  const clone = root.cloneNode(true) as Element;
  const keep = Number.isFinite(maxSiblings) && maxSiblings >= 1 ? Math.floor(maxSiblings) : 5;

  const stack: Element[] = [clone];
  while (stack.length > 0) {
    const el = stack.pop() as Element;

    // Attributes.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const value = attr.value;
      if ((name === 'style' || name === 'srcset') && value.length > 200) {
        el.removeAttribute(name);
        continue;
      }
      if (value.length > 100 && /data:/i.test(value)) {
        el.setAttribute(name, value.replace(/data:[^\s'")]{96,}/gi, 'data:'));
      }
    }

    // Elements whose children never help the agent.
    if (EMPTY.indexOf(el.localName) !== -1) {
      el.textContent = '';
      if (el.localName === 'template' && 'content' in el) {
        (el as HTMLTemplateElement).content.replaceChildren();
      }
      continue;
    }

    // Comments and repeated siblings.
    let run: Element[] = [];
    const flush = (): void => {
      const removed = run.slice(keep);
      const first = removed[0];
      if (first) {
        const marker = document.createComment(` sitecraft: ${removed.length} more <${first.localName}> siblings collapsed `);
        first.before(marker);
        for (const node of removed) node.remove();
      }
      run = [];
    };
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const child = node as Element;
        const head = run[0];
        const same =
          head !== undefined &&
          head.localName === child.localName &&
          (head.getAttribute('class') || '') === (child.getAttribute('class') || '');
        if (same) run.push(child);
        else {
          flush();
          run = [child];
        }
      } else if (node.nodeType === Node.TEXT_NODE && !/^\s*$/.test(node.nodeValue || '')) {
        flush();
      }
    }
    flush();

    for (const child of Array.from(el.children)) stack.push(child);
  }

  // Whitespace.
  clone.normalize();
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    if (!/\s/.test(text.data)) continue;
    if (text.parentElement && text.parentElement.closest('pre, textarea')) continue;
    text.data = text.data.replace(/\s+/g, ' ');
  }

  const html = clone.outerHTML;
  if (html.length <= maxChars) return html;
  return html.slice(0, Math.max(0, maxChars - MARKER.length)) + MARKER;
}

/**
 * Outer HTML of the first element matching `selector`, plus the match count.
 * Script and style bodies and comments are dropped from the copy. Runs inside
 * the page (isolated world).
 */
export function elementOuterHtmlInPage(selector: string, maxChars: number): PageInspectResult {
  const MARKER = '<!-- sitecraft: truncated -->';
  let matches: NodeListOf<Element>;
  try {
    matches = document.querySelectorAll(selector);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid selector ${JSON.stringify(selector)}: ${detail}` };
  }
  const first = matches[0];
  if (!first) return { ok: true, html: '', count: 0 };

  const clone = first.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll('script, style, svg, noscript, template, iframe'))) {
    el.textContent = '';
  }
  if (['script', 'style', 'svg', 'noscript', 'template', 'iframe'].indexOf(clone.localName) !== -1) {
    clone.textContent = '';
  }
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  for (const c of comments) c.parentNode?.removeChild(c);

  let html = clone.outerHTML;
  if (html.length > maxChars) html = html.slice(0, Math.max(0, maxChars - MARKER.length)) + MARKER;
  return { ok: true, html, count: matches.length };
}
