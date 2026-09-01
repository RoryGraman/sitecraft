/**
 * Content script entry (src/content/main.ts). Runs at document_start in every http(s) page.
 * Named main.ts, not index.ts, so its chunk name differs from the background entry;
 * CRXJS names entry chunks by basename and the service worker loader would
 * otherwise import the content chunk.
 * All logic lives in ./lib; this file only starts it and must never throw.
 */

import { start } from './lib';

(() => {
  try {
    void start().catch((e: unknown) => {
      console.warn('Sitecraft: content script failed to start.', e);
    });
  } catch (e) {
    console.warn('Sitecraft: content script failed to start.', e);
  }
})();
