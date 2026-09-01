/**
 * Build-time switches. Vite loads this file in Node.
 *
 * A harness build lets the dev harness page drive the extension. It is
 * selected by `vite build --mode harness` or by SITECRAFT_HARNESS=1.
 * manifest.config.ts applies the same rule for `externally_connectable`, and
 * vite.config.ts turns it into the `__SITECRAFT_HARNESS__` constant that
 * src/background/index.ts reads to wire the devReload request.
 */
export function isHarnessBuild(mode: string, env: Record<string, string | undefined>): boolean {
  return mode === 'harness' || env.SITECRAFT_HARNESS === '1';
}
