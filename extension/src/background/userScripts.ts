/**
 * chrome.userScripts registration.
 *
 * Enabled JS scripts are grouped into one bundle per urlPattern (see
 * shared/src/bundle.ts). Each bundle is registered as one user script in the
 * MAIN world at document_end. Registration runs one bundle at a time so that
 * a pattern Chrome rejects does not block the other bundles.
 */

import { buildJsBundles, type JsBundle, type SiteScript } from '@sitecraft/shared';

/** Called once per bundle that Chrome refused to register. */
export type BundleErrorCallback = (scriptIds: string[], message: string) => void;

export interface RegisterAllResult {
  /** Number of bundles Chrome accepted. */
  registered: number;
  /** True when chrome.userScripts is unavailable and nothing was attempted. */
  skipped: boolean;
}

/**
 * Detection recommended by the Chrome docs. The API object is missing when the
 * permission is absent or the "Allow User Scripts" toggle is off, so touching
 * it throws.
 */
export function isUserScriptsAvailable(): boolean {
  try {
    const probe: unknown = chrome.userScripts.getScripts();
    // Swallow a late rejection. Only a synchronous throw means "unavailable".
    void Promise.resolve(probe).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function toRegistration(bundle: JsBundle): chrome.userScripts.RegisteredUserScript {
  return {
    id: bundle.id,
    matches: [bundle.urlPattern],
    js: [{ code: bundle.code }],
    world: 'MAIN',
    runAt: 'document_end',
    allFrames: false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Replace every registered user script with the bundles built from `scripts`.
 * Unregisters everything first, then registers each bundle on its own.
 * Failures are reported through `onBundleError` and do not stop the rest.
 */
export async function registerAll(
  scripts: SiteScript[],
  onBundleError?: BundleErrorCallback,
): Promise<RegisterAllResult> {
  if (!isUserScriptsAvailable()) {
    return { registered: 0, skipped: true };
  }

  await chrome.userScripts.unregister();

  let registered = 0;
  for (const bundle of buildJsBundles(scripts)) {
    try {
      await chrome.userScripts.register([toRegistration(bundle)]);
      registered += 1;
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`Sitecraft: could not register user script for ${bundle.urlPattern}: ${message}`);
      onBundleError?.(bundle.scriptIds, message);
    }
  }

  return { registered, skipped: false };
}
