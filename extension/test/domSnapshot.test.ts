import { describe, expect, it } from 'vitest';
import { elementOuterHtml, snapshotDom, TRUNCATED_MARKER } from '../src/lib/domSnapshot';

/** Parse a fresh document so tests never share DOM state. */
function parse(body: string, head = ''): Document {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`,
    'text/html',
  );
}

/** Repeat an HTML snippet n times, replacing {i} with the 1-based index. */
function repeat(html: string, n: number): string {
  return Array.from({ length: n }, (_, i) => html.replace(/\{i\}/g, String(i + 1))).join('\n  ');
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('snapshotDom', () => {
  it('serializes the document element for a Document root', () => {
    const doc = parse('<main id="m">Hi</main>', '<title>T</title>');
    const out = snapshotDom(doc);
    expect(out.startsWith('<html>')).toBe(true);
    expect(out).toContain('<title>T</title>');
    expect(out).toContain('<main id="m">Hi</main>');
    expect(out.endsWith('</html>')).toBe(true);
  });

  it('serializes only the given element for an Element root', () => {
    const doc = parse('<div id="a">A</div><div id="b"><span>B</span></div>');
    const el = doc.querySelector('#b');
    expect(el).not.toBeNull();
    expect(snapshotDom(el as Element)).toBe('<div id="b"><span>B</span></div>');
  });

  it('never mutates the original tree', () => {
    const longStyle = `color: red; ${'margin: 0; '.repeat(40)}`;
    const doc = parse(
      `<script>alert(1)</script><!-- keep --><div style="${longStyle}"></div><ul>${repeat('<li class="x">{i}</li>', 8)}</ul>`,
    );
    const before = doc.documentElement.outerHTML;
    snapshotDom(doc);
    expect(doc.documentElement.outerHTML).toBe(before);
    expect(doc.querySelector('script')?.textContent).toBe('alert(1)');
    expect(doc.querySelectorAll('li').length).toBe(8);
    expect(doc.querySelector('div')?.getAttribute('style')).toBe(longStyle);
  });

  it('empties script and style bodies but keeps the tags and attributes', () => {
    const doc = parse(
      '<script src="a.js" type="module">alert("secret")</script><style media="all">body{color:red}</style><p>text</p>',
    );
    const out = snapshotDom(doc);
    expect(out).toContain('<script src="a.js" type="module"></script>');
    expect(out).toContain('<style media="all"></style>');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('color:red');
    expect(out).toContain('<p>text</p>');
  });

  it('removes comments', () => {
    const doc = parse('<div><!-- top secret --><p>a</p><!-- another --></div>');
    const out = snapshotDom(doc);
    expect(out).not.toContain('top secret');
    expect(out).not.toContain('another');
    expect(out).toContain('<div><p>a</p></div>');
  });

  it('drops svg children but keeps the svg tag and attributes', () => {
    const doc = parse(
      '<svg class="icon" viewBox="0 0 10 10"><defs><linearGradient id="g"></linearGradient></defs><path d="M0 0L10 10"></path></svg>',
    );
    const out = snapshotDom(doc);
    expect(out).toContain('<svg class="icon" viewBox="0 0 10 10"></svg>');
    expect(out).not.toContain('<path');
    expect(out).not.toContain('linearGradient');
  });

  it('drops noscript, template and iframe children but keeps the tags', () => {
    const doc = parse(
      '<noscript><img src="pixel.gif"></noscript>' +
        '<template id="tpl"><div class="from-template">t</div></template>' +
        '<iframe src="https://example.com/embed" title="e"><p>fallback</p></iframe>',
    );
    const out = snapshotDom(doc);
    expect(out).toContain('<noscript></noscript>');
    expect(out).toContain('<template id="tpl"></template>');
    expect(out).toContain('<iframe src="https://example.com/embed" title="e"></iframe>');
    expect(out).not.toContain('pixel.gif');
    expect(out).not.toContain('from-template');
    expect(out).not.toContain('fallback');
  });

  it('strips inline style attributes longer than 200 chars and keeps short ones', () => {
    const long = 'a'.repeat(201);
    const short = 'color: red';
    const doc = parse(`<div id="l" style="${long}"></div><div id="s" style="${short}"></div>`);
    const out = snapshotDom(doc);
    expect(out).toContain('<div id="l"></div>');
    expect(out).toContain(`<div id="s" style="${short}"></div>`);
  });

  it('strips data: URLs longer than 100 chars and keeps short ones', () => {
    const payload = 'A'.repeat(200);
    const longUrl = `data:image/png;base64,${payload}`;
    const shortUrl = 'data:image/gif;base64,R0lGOD';
    const doc = parse(
      `<img id="l" src="${longUrl}" alt="logo"><img id="s" src="${shortUrl}">` +
        `<div id="bg" style="background:url(data:image/png;base64,${'B'.repeat(150)})"></div>`,
    );
    const out = snapshotDom(doc);
    expect(out).not.toContain(payload);
    expect(out).not.toContain('B'.repeat(150));
    expect(out).toContain('<img id="l"');
    expect(out).toContain('alt="logo"');
    expect(out).toContain(`<img id="s" src="${shortUrl}">`);
    // The style attribute is under 200 chars, so it stays; only the URL payload goes.
    expect(out).toMatch(/<div id="bg" style="background:url\(data:[^A-Za-z0-9]*\)"><\/div>/);
  });

  it('strips srcset attributes longer than 200 chars and keeps short ones', () => {
    const longSrcset = Array.from(
      { length: 12 },
      (_, i) => `https://cdn.example.com/img-${i}-wide.jpg ${i + 1}x`,
    ).join(', ');
    expect(longSrcset.length).toBeGreaterThan(200);
    const shortSrcset = 'a.jpg 1x, b.jpg 2x';
    const doc = parse(`<img id="l" src="x.jpg" srcset="${longSrcset}"><img id="s" srcset="${shortSrcset}">`);
    const out = snapshotDom(doc);
    expect(out).toContain('<img id="l" src="x.jpg">');
    expect(out).toContain(`<img id="s" srcset="${shortSrcset}">`);
  });

  it('collapses runs of more than maxRepeatedSiblings same-tag same-class siblings', () => {
    const doc = parse(`<ul>\n  ${repeat('<li class="item">{i}</li>', 12)}\n</ul>`);
    const out = snapshotDom(doc);
    for (let i = 1; i <= 5; i++) expect(out).toContain(`<li class="item">${i}</li>`);
    for (let i = 6; i <= 12; i++) expect(out).not.toContain(`<li class="item">${i}</li>`);
    expect(out).toContain('<!-- sitecraft: 7 more <li> siblings collapsed -->');
    expect(out).toMatch(
      /<li class="item">5<\/li>\s*<!-- sitecraft: 7 more <li> siblings collapsed -->\s*<\/ul>/,
    );
  });

  it('respects a custom maxRepeatedSiblings', () => {
    const doc = parse(`<div>${repeat('<p class="row">{i}</p>', 6)}</div>`);
    const out = snapshotDom(doc, { maxRepeatedSiblings: 2 });
    expect(out).toContain('<p class="row">2</p>');
    expect(out).not.toContain('<p class="row">3</p>');
    expect(out).toContain('<!-- sitecraft: 4 more <p> siblings collapsed -->');
  });

  it('does not collapse runs at or below the limit', () => {
    const doc = parse(`<ul>${repeat('<li class="item">{i}</li>', 5)}</ul>`);
    const out = snapshotDom(doc);
    expect(out).not.toContain('sitecraft:');
    for (let i = 1; i <= 5; i++) expect(out).toContain(`<li class="item">${i}</li>`);
  });

  it('starts a new run when the tag or class changes', () => {
    const doc = parse(
      `<div>${repeat('<span class="a">a{i}</span>', 3)}${repeat('<span class="b">b{i}</span>', 3)}${repeat('<b class="a">c{i}</b>', 3)}</div>`,
    );
    const out = snapshotDom(doc, { maxRepeatedSiblings: 4 });
    expect(out).not.toContain('sitecraft:');
    expect(countOf(out, '<span class="a">')).toBe(3);
    expect(countOf(out, '<span class="b">')).toBe(3);
    expect(countOf(out, '<b class="a">')).toBe(3);
  });

  it('treats a missing class and an empty class as the same', () => {
    const doc = parse(`<div>${repeat('<i>{i}</i>', 3)}${repeat('<i class="">{i}</i>', 3)}</div>`);
    const out = snapshotDom(doc, { maxRepeatedSiblings: 4 });
    expect(out).toContain('<!-- sitecraft: 2 more <i> siblings collapsed -->');
  });

  it('lets non-blank text between siblings break a run', () => {
    const doc = parse(
      `<p>${repeat('<em class="t">{i}</em>', 3)} and ${repeat('<em class="t">{i}</em>', 3)}</p>`,
    );
    const out = snapshotDom(doc, { maxRepeatedSiblings: 4 });
    expect(out).not.toContain('sitecraft:');
    expect(countOf(out, '<em class="t">')).toBe(6);
  });

  it('collapses nested runs inside kept siblings too', () => {
    const row = `<tr class="r">${repeat('<td class="c">{i}</td>', 8)}</tr>`;
    const doc = parse(`<table><tbody>${repeat(row, 8)}</tbody></table>`);
    const out = snapshotDom(doc, { maxRepeatedSiblings: 3 });
    expect(countOf(out, '<!-- sitecraft: 5 more <tr> siblings collapsed -->')).toBe(1);
    expect(countOf(out, '<!-- sitecraft: 5 more <td> siblings collapsed -->')).toBe(3);
    expect(countOf(out, '<tr class="r">')).toBe(3);
    expect(countOf(out, '<td class="c">')).toBe(9);
  });

  it('collapses whitespace runs to a single space', () => {
    const doc = parse('<div>\n\n   <p>\n  Hello\n\n world  </p>\n   </div>');
    const out = snapshotDom(doc);
    expect(out).toContain('<div> <p> Hello world </p> </div>');
  });

  it('keeps whitespace inside pre and textarea', () => {
    const doc = parse('<pre>a\n  b</pre><textarea>x\n\n  y</textarea>');
    const out = snapshotDom(doc);
    expect(out).toContain('<pre>a\n  b</pre>');
    expect(out).toContain('<textarea>x\n\n  y</textarea>');
  });

  it('merges whitespace left behind by removed comments and collapsed siblings', () => {
    const doc = parse('<div>\n  <!-- a -->\n  <!-- b -->\n  <span>x</span>\n</div>');
    const out = snapshotDom(doc);
    expect(out).toContain('<div> <span>x</span> </div>');
  });

  it('caps the output at maxChars and appends a truncation marker', () => {
    // Unique classes so the sibling collapse rule does not shrink the fixture first.
    const doc = parse(repeat('<p class="k{i}">Some paragraph text that takes up room.</p>', 40));
    const out = snapshotDom(doc, { maxChars: 500 });
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(TRUNCATED_MARKER).toBe('<!-- sitecraft: truncated -->');
  });

  it('adds no truncation marker when the output fits', () => {
    const doc = parse('<p>small</p>');
    const out = snapshotDom(doc, { maxChars: 500 });
    expect(out).not.toContain('truncated');
  });

  it('measures the cap after trimming, not before', () => {
    const doc = parse(`<script>${'x'.repeat(10_000)}</script><p>after</p>`);
    const out = snapshotDom(doc, { maxChars: 500 });
    expect(out).toContain('<script></script>');
    expect(out).toContain('<p>after</p>');
    expect(out).not.toContain('truncated');
  });

  it('uses the shared default cap when no maxChars is given', () => {
    const doc = parse(
      repeat('<p class="k{i}">Some paragraph text that takes up room on the page.</p>', 2000),
    );
    const out = snapshotDom(doc);
    expect(out.length).toBeLessThanOrEqual(60_000);
    expect(out.endsWith(TRUNCATED_MARKER)).toBe(true);
  });
});

describe('elementOuterHtml', () => {
  it('returns the first match and the total match count', () => {
    const doc = parse(
      '<div class="card" id="c1"><h2>One</h2></div><div class="card" id="c2">Two</div><div class="card" id="c3">Three</div>',
    );
    const res = elementOuterHtml(doc, '.card');
    expect(res).toEqual({ ok: true, html: '<div class="card" id="c1"><h2>One</h2></div>', count: 3 });
  });

  it('returns count 0 and empty html when nothing matches', () => {
    const doc = parse('<p>x</p>');
    expect(elementOuterHtml(doc, '.missing')).toEqual({ ok: true, html: '', count: 0 });
  });

  it('caps the html at maxChars with the truncation marker', () => {
    const doc = parse(
      `<section id="big">${repeat('<p class="k{i}">Lots of text in here for sure.</p>', 50)}</section>`,
    );
    const res = elementOuterHtml(doc, '#big', 300);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.count).toBe(1);
    expect(res.html.length).toBeLessThanOrEqual(300);
    expect(res.html.startsWith('<section id="big">')).toBe(true);
    expect(res.html.endsWith(TRUNCATED_MARKER)).toBe(true);
  });

  it('applies the same trimming as snapshotDom', () => {
    const doc = parse(
      '<div id="w"><script>alert("secret")</script><!-- hidden --><svg><path d="M0 0"></path></svg></div>',
    );
    const res = elementOuterHtml(doc, '#w');
    expect(res).toEqual({ ok: true, html: '<div id="w"><script></script><svg></svg></div>', count: 1 });
  });

  it('returns ok:false for an invalid selector', () => {
    const doc = parse('<p>x</p>');
    const res = elementOuterHtml(doc, 'div[');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.length).toBeGreaterThan(0);
    expect(res.error).toContain('div[');
  });

  it('returns ok:false for an empty selector', () => {
    const doc = parse('<p>x</p>');
    expect(elementOuterHtml(doc, '').ok).toBe(false);
  });

  it('never mutates the page', () => {
    const doc = parse('<div id="w"><script>alert("secret")</script></div>');
    const before = doc.documentElement.outerHTML;
    elementOuterHtml(doc, '#w');
    expect(doc.documentElement.outerHTML).toBe(before);
  });
});
