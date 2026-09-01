import { describe, expect, it } from 'vitest';
import { parseExportFile, validateAgentOutput, validateSiteScript } from '../src/validate.js';
import { SCHEMA_VERSION } from '../src/types.js';
import type { AgentScriptOutput, SiteScript } from '../src/types.js';

const goodOutput: AgentScriptOutput = {
  name: 'Hide shorts',
  description: 'Removes the Shorts shelf from the home page.',
  kind: 'css',
  urlPattern: 'https://www.youtube.com/*',
  priority: 3,
  code: '#shorts { display: none; }',
};

const goodScript: SiteScript = {
  id: '4d2e6c0a-2b3a-4a7d-9c1a-0b1f6d9e8c11',
  name: 'Hide shorts',
  description: 'Removes the Shorts shelf from the home page.',
  urlPattern: 'https://www.youtube.com/*',
  kind: 'css',
  priority: 3,
  code: '#shorts { display: none; }',
  enabled: true,
  trial: false,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:05:00.000Z',
};

function expectError(result: { ok: boolean; error?: string }, field: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(field);
}

describe('validateAgentOutput', () => {
  it('accepts a good object', () => {
    expect(validateAgentOutput(goodOutput)).toEqual({ ok: true, value: goodOutput });
  });

  it('trims name and description', () => {
    const r = validateAgentOutput({ ...goodOutput, name: '  Hide shorts \n', description: '\tDesc. ' });
    expect(r).toEqual({ ok: true, value: { ...goodOutput, name: 'Hide shorts', description: 'Desc.' } });
  });

  it('trims the url pattern', () => {
    const r = validateAgentOutput({ ...goodOutput, urlPattern: ' https://www.youtube.com/* ' });
    expect(r).toEqual({ ok: true, value: goodOutput });
  });

  it('coerces a numeric-string priority', () => {
    const r = validateAgentOutput({ ...goodOutput, priority: '2' });
    expect(r).toEqual({ ok: true, value: { ...goodOutput, priority: 2 } });
  });

  it('accepts every priority from 1 to 5 and both kinds', () => {
    for (const priority of [1, 2, 3, 4, 5]) {
      expect(validateAgentOutput({ ...goodOutput, priority }).ok).toBe(true);
    }
    expect(validateAgentOutput({ ...goodOutput, kind: 'js', code: 'console.log(1)' }).ok).toBe(true);
  });

  it('drops unknown fields', () => {
    const r = validateAgentOutput({ ...goodOutput, extra: 1, nested: { a: 1 } });
    expect(r).toEqual({ ok: true, value: goodOutput });
  });

  it('accepts a subdomain wildcard and a port', () => {
    expect(validateAgentOutput({ ...goodOutput, urlPattern: '*://*.youtube.com/*' }).ok).toBe(true);
    expect(validateAgentOutput({ ...goodOutput, urlPattern: 'http://localhost:4174/*' }).ok).toBe(true);
  });

  it('accepts code at the size limit and a max-length name', () => {
    expect(validateAgentOutput({ ...goodOutput, code: 'a'.repeat(200_000) }).ok).toBe(true);
    expect(validateAgentOutput({ ...goodOutput, name: 'n'.repeat(60) }).ok).toBe(true);
    expect(validateAgentOutput({ ...goodOutput, description: 'd'.repeat(200) }).ok).toBe(true);
  });

  it.each([
    ['missing code', { ...goodOutput, code: undefined }, 'code'],
    ['empty code', { ...goodOutput, code: '' }, 'code'],
    ['whitespace code', { ...goodOutput, code: '  \n ' }, 'code'],
    ['code too long', { ...goodOutput, code: 'a'.repeat(200_001) }, 'code'],
    ['non-string code', { ...goodOutput, code: 42 }, 'code'],
    ['kind html', { ...goodOutput, kind: 'html' }, 'kind'],
    ['missing kind', { ...goodOutput, kind: undefined }, 'kind'],
    ['uppercase kind', { ...goodOutput, kind: 'CSS' }, 'kind'],
    ['all_urls', { ...goodOutput, urlPattern: '<all_urls>' }, 'urlPattern'],
    ['all hosts', { ...goodOutput, urlPattern: '*://*/*' }, 'urlPattern'],
    ['https all hosts', { ...goodOutput, urlPattern: 'https://*/*' }, 'urlPattern'],
    ['bare host', { ...goodOutput, urlPattern: 'youtube.com' }, 'urlPattern'],
    ['missing pattern', { ...goodOutput, urlPattern: undefined }, 'urlPattern'],
    ['empty pattern', { ...goodOutput, urlPattern: '' }, 'urlPattern'],
    ['priority 0', { ...goodOutput, priority: 0 }, 'priority'],
    ['priority 6', { ...goodOutput, priority: 6 }, 'priority'],
    ['priority 2.5', { ...goodOutput, priority: 2.5 }, 'priority'],
    ['priority "2.5"', { ...goodOutput, priority: '2.5' }, 'priority'],
    ['priority "abc"', { ...goodOutput, priority: 'abc' }, 'priority'],
    ['priority ""', { ...goodOutput, priority: '' }, 'priority'],
    ['priority null', { ...goodOutput, priority: null }, 'priority'],
    ['missing priority', { ...goodOutput, priority: undefined }, 'priority'],
    ['priority boolean', { ...goodOutput, priority: true }, 'priority'],
    ['name too long', { ...goodOutput, name: 'n'.repeat(61) }, 'name'],
    ['empty name', { ...goodOutput, name: '   ' }, 'name'],
    ['missing name', { ...goodOutput, name: undefined }, 'name'],
    ['non-string name', { ...goodOutput, name: ['x'] }, 'name'],
    ['description too long', { ...goodOutput, description: 'd'.repeat(201) }, 'description'],
    ['empty description', { ...goodOutput, description: '' }, 'description'],
    ['missing description', { ...goodOutput, description: undefined }, 'description'],
  ])('rejects %s', (_label, input, field) => {
    expectError(validateAgentOutput(input), field);
  });

  it.each([null, undefined, 'string', 42, true, [], () => undefined])('rejects non-object input %s', (input) => {
    const r = validateAgentOutput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it('reports every failing field', () => {
    const r = validateAgentOutput({ name: '', kind: 'html', priority: 9 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const field of ['name', 'description', 'kind', 'urlPattern', 'priority', 'code']) {
      expect(r.error).toContain(field);
    }
  });
});

describe('validateSiteScript', () => {
  it('accepts a full record', () => {
    expect(validateSiteScript(goodScript)).toEqual({ ok: true, value: goodScript });
  });

  it('accepts a trial script and a js script', () => {
    expect(validateSiteScript({ ...goodScript, trial: true, enabled: false }).ok).toBe(true);
    expect(validateSiteScript({ ...goodScript, kind: 'js', code: 'document.title = "x"' }).ok).toBe(true);
  });

  it('accepts an empty description', () => {
    expect(validateSiteScript({ ...goodScript, description: '' })).toEqual({
      ok: true,
      value: { ...goodScript, description: '' },
    });
  });

  it('coerces a numeric-string priority and trims text', () => {
    const r = validateSiteScript({ ...goodScript, priority: '4', name: ' N ', urlPattern: ' https://a.com/* ' });
    expect(r).toEqual({ ok: true, value: { ...goodScript, priority: 4, name: 'N', urlPattern: 'https://a.com/*' } });
  });

  it('drops unknown fields', () => {
    expect(validateSiteScript({ ...goodScript, legacy: true })).toEqual({ ok: true, value: goodScript });
  });

  it.each([
    ['numeric id', { ...goodScript, id: 12 }, 'id'],
    ['empty id', { ...goodScript, id: '' }, 'id'],
    ['missing id', { ...goodScript, id: undefined }, 'id'],
    ['unparseable createdAt', { ...goodScript, createdAt: 'yesterday' }, 'createdAt'],
    ['numeric createdAt', { ...goodScript, createdAt: 1725000000000 }, 'createdAt'],
    ['empty createdAt', { ...goodScript, createdAt: '' }, 'createdAt'],
    ['unparseable updatedAt', { ...goodScript, updatedAt: 'not a date' }, 'updatedAt'],
    ['missing updatedAt', { ...goodScript, updatedAt: undefined }, 'updatedAt'],
    ['string enabled', { ...goodScript, enabled: 'true' }, 'enabled'],
    ['numeric enabled', { ...goodScript, enabled: 1 }, 'enabled'],
    ['missing enabled', { ...goodScript, enabled: undefined }, 'enabled'],
    ['string trial', { ...goodScript, trial: 'no' }, 'trial'],
    ['missing trial', { ...goodScript, trial: undefined }, 'trial'],
    ['bad kind', { ...goodScript, kind: 'less' }, 'kind'],
    ['bad priority', { ...goodScript, priority: 7 }, 'priority'],
    ['bad pattern', { ...goodScript, urlPattern: 'youtube.com' }, 'urlPattern'],
    ['too broad pattern', { ...goodScript, urlPattern: '<all_urls>' }, 'urlPattern'],
    ['empty code', { ...goodScript, code: '' }, 'code'],
    ['empty name', { ...goodScript, name: '' }, 'name'],
    ['long name', { ...goodScript, name: 'n'.repeat(61) }, 'name'],
    ['long description', { ...goodScript, description: 'd'.repeat(201) }, 'description'],
    ['non-string description', { ...goodScript, description: 5 }, 'description'],
  ])('rejects %s', (_label, input, field) => {
    expectError(validateSiteScript(input), field);
  });

  it.each([null, undefined, 'string', 0, false, []])('rejects non-object input %s', (input) => {
    expect(validateSiteScript(input).ok).toBe(false);
  });
});

describe('parseExportFile', () => {
  const badScript = { ...goodScript, id: 'bad-1', priority: 9 };
  const second = { ...goodScript, id: 'second', name: 'Second' };

  function exportJson(scripts: unknown[], overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      format: 'sitecraft-scripts',
      version: SCHEMA_VERSION,
      exportedAt: '2026-08-31T12:00:00.000Z',
      scripts,
      ...overrides,
    });
  }

  it('parses a good file', () => {
    const r = parseExportFile(exportJson([goodScript, second]));
    expect(r).toEqual({
      ok: true,
      value: {
        file: {
          format: 'sitecraft-scripts',
          version: SCHEMA_VERSION,
          exportedAt: '2026-08-31T12:00:00.000Z',
          scripts: [goodScript, second],
        },
        invalid: [],
      },
    });
  });

  it('parses a file with no scripts', () => {
    const r = parseExportFile(exportJson([]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.file.scripts).toEqual([]);
  });

  it('rejects bad JSON', () => {
    const r = parseExportFile('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it('rejects an empty string', () => {
    expect(parseExportFile('').ok).toBe(false);
  });

  it.each(['"string"', '42', 'null', '[]', 'true'])('rejects non-object JSON %s', (json) => {
    expect(parseExportFile(json).ok).toBe(false);
  });

  it('rejects the wrong format', () => {
    const r = parseExportFile(exportJson([goodScript], { format: 'other' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('format');
  });

  it('rejects a missing format', () => {
    const r = parseExportFile(JSON.stringify({ version: 1, exportedAt: 'x', scripts: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('format');
  });

  it('rejects a newer version', () => {
    const r = parseExportFile(exportJson([goodScript], { version: SCHEMA_VERSION + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('version');
  });

  it('rejects a non-numeric version', () => {
    const r = parseExportFile(exportJson([goodScript], { version: '1' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('version');
  });

  it('rejects scripts that is not an array', () => {
    const r = parseExportFile(exportJson([], { scripts: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('scripts');
  });

  it('rejects a missing scripts field', () => {
    const r = parseExportFile(JSON.stringify({ format: 'sitecraft-scripts', version: SCHEMA_VERSION, exportedAt: 'x' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('scripts');
  });

  it('rejects a non-string exportedAt', () => {
    const r = parseExportFile(exportJson([], { exportedAt: 12 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('exportedAt');
  });

  it('keeps valid scripts and reports invalid ones by id', () => {
    const r = parseExportFile(exportJson([goodScript, badScript, second]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.file.scripts).toEqual([goodScript, second]);
    expect(r.value.invalid).toEqual(['bad-1']);
  });

  it('reports invalid scripts without an id by position', () => {
    const r = parseExportFile(exportJson([goodScript, { name: 'no id' }, 'junk', null]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.file.scripts).toEqual([goodScript]);
    expect(r.value.invalid).toEqual(['#2', '#3', '#4']);
  });

  it('returns canonical script records', () => {
    const r = parseExportFile(exportJson([{ ...goodScript, priority: '5', extra: true }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.file.scripts).toEqual([{ ...goodScript, priority: 5 }]);
  });
});
