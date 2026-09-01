import { describe, expect, it, vi } from 'vitest';
import { DESCRIPTION_MAX_CHARS, NAME_MAX_CHARS, validateAgentOutput } from '@sitecraft/shared';
import { clampText, normalizeAgentOutput } from '../src/agent.js';
import type { Logger } from '../src/log.js';

// This file does not mock @sitecraft/shared. It proves the clamp against the real validator.

const LONG_DESCRIPTION =
  'Removes the login wall overlay and restores scrolling on article pages. ' +
  'It also hides the gateway banner, the fade-out gradient and the subscription prompt. ' +
  'Note that the site may still block some content server side.';

const GOOD = {
  name: 'Remove login wall',
  description: 'Removes the login wall on article pages.',
  kind: 'css',
  urlPattern: 'https://www.nytimes.com/*',
  priority: 3,
  code: '.gateway-container { display: none !important; }',
};

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn<(msg: string, data?: unknown) => void>> } {
  const warn = vi.fn<(msg: string, data?: unknown) => void>();
  const logger: Logger = { debug: () => undefined, info: () => undefined, warn, error: () => undefined, file: null };
  return { logger, warn };
}

describe('clampText', () => {
  it('returns short text unchanged apart from trimming', () => {
    expect(clampText('  Hides the banner.  ', 200)).toBe('Hides the banner.');
  });

  it('cuts at the last full sentence when one ends in the second half of the limit', () => {
    const out = clampText(LONG_DESCRIPTION, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toBe(
      'Removes the login wall overlay and restores scrolling on article pages. ' +
        'It also hides the gateway banner, the fade-out gradient and the subscription prompt.',
    );
  });

  it('cuts at a word boundary and adds an ellipsis when no sentence fits', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const out = clampText(words, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('...')).toBe(true);
    const body = out.slice(0, -3);
    expect(words.startsWith(body)).toBe(true);
    expect(words[body.length]).toBe(' '); // the cut falls on a word boundary
  });

  it('hard cuts a single very long token', () => {
    const out = clampText('x'.repeat(500), 60);
    expect(out.length).toBe(60);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('normalizeAgentOutput', () => {
  it('leaves a valid output untouched', () => {
    expect(normalizeAgentOutput(GOOD)).toEqual(GOOD);
  });

  it('clamps an over-long description so the real validator accepts it', () => {
    expect(validateAgentOutput({ ...GOOD, description: LONG_DESCRIPTION }).ok).toBe(false);
    const { logger, warn } = fakeLogger();
    const out = normalizeAgentOutput({ ...GOOD, description: LONG_DESCRIPTION }, logger) as { description: string };
    expect(out.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    const v = validateAgentOutput(out);
    expect(v.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith('Agent output clamped', expect.objectContaining({ field: 'description' }));
  });

  it('clamps an over-long name', () => {
    const out = normalizeAgentOutput({ ...GOOD, name: 'A very long script name that goes on and on and on past sixty characters' }) as { name: string };
    expect(out.name.length).toBeLessThanOrEqual(NAME_MAX_CHARS);
    expect(validateAgentOutput(out).ok).toBe(true);
  });

  it('does not touch non-object candidates or other fields', () => {
    expect(normalizeAgentOutput('nope')).toBe('nope');
    expect(normalizeAgentOutput(undefined)).toBeUndefined();
    const out = normalizeAgentOutput({ ...GOOD, code: 'x'.repeat(300) }) as { code: string };
    expect(out.code.length).toBe(300);
  });
});
