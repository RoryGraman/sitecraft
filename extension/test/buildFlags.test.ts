import { describe, expect, it } from 'vitest';
import { isHarnessBuild } from '../buildFlags';

/**
 * One rule decides both the manifest's externally_connectable key and the
 * background's devReload hook. Both documented harness paths must agree.
 */
describe('isHarnessBuild', () => {
  it('is true for Vite mode harness', () => {
    expect(isHarnessBuild('harness', {})).toBe(true);
  });

  it('is true for SITECRAFT_HARNESS=1 in any mode', () => {
    expect(isHarnessBuild('production', { SITECRAFT_HARNESS: '1' })).toBe(true);
    expect(isHarnessBuild('development', { SITECRAFT_HARNESS: '1' })).toBe(true);
  });

  it('is false for a production build', () => {
    expect(isHarnessBuild('production', {})).toBe(false);
    expect(isHarnessBuild('production', { SITECRAFT_HARNESS: '0' })).toBe(false);
    expect(isHarnessBuild('production', { SITECRAFT_HARNESS: 'true' })).toBe(false);
    expect(isHarnessBuild('development', {})).toBe(false);
  });
});
