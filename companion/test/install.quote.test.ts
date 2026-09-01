import { describe, expect, it } from 'vitest';
import { buildWrapperScript, parseWrapperScript, shQuote } from '../src/install.js';

describe('shQuote / parseWrapperScript', () => {
  it('quotes paths with spaces, dollars, quotes and backticks for /bin/sh', () => {
    const nodePath = '/Users/some one/.nvm/versions/node/v23/bin/node';
    const cliPath = '/tmp/we$ird "dir"/`x`/bin/sitecraft.js';
    const script = buildWrapperScript({ nodePath, cliPath });
    expect(script).toBe(
      '#!/bin/sh\nexec "/Users/some one/.nvm/versions/node/v23/bin/node" "/tmp/we\\$ird \\"dir\\"/\\`x\\`/bin/sitecraft.js" host "$@"\n',
    );
    expect(parseWrapperScript(script)).toEqual({ nodePath, cliPath });
  });

  it('leaves plain paths unchanged and rejects other content', () => {
    expect(shQuote('/opt/node/bin/node')).toBe('"/opt/node/bin/node"');
    const script = buildWrapperScript({ nodePath: '/opt/node/bin/node', cliPath: '/x/bin/sitecraft.js' });
    expect(script).toBe('#!/bin/sh\nexec "/opt/node/bin/node" "/x/bin/sitecraft.js" host "$@"\n');
    expect(parseWrapperScript(script)).toEqual({ nodePath: '/opt/node/bin/node', cliPath: '/x/bin/sitecraft.js' });
    expect(parseWrapperScript('#!/bin/sh\necho hi\n')).toBeNull();
  });
});
