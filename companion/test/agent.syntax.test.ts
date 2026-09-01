import { describe, expect, it } from 'vitest';
import { jsSyntaxError } from '../src/agent.js';

describe('jsSyntaxError', () => {
  it('accepts code that parses as an async function body, including top-level await and return', () => {
    expect(jsSyntaxError("(() => { document.title = 'x'; })();")).toBeNull();
    expect(jsSyntaxError('await new Promise((r) => setTimeout(r, 1)); return;')).toBeNull();
    expect(jsSyntaxError('// only a comment')).toBeNull();
  });

  it('reports a syntax error with its message', () => {
    expect(jsSyntaxError('(() => { document.title = ; })();')).toMatch(/Unexpected token/);
    expect(jsSyntaxError('function (')).not.toBeNull();
    expect(jsSyntaxError('const = 1;')).not.toBeNull();
  });
});
