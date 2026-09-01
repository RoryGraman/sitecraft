/**
 * Runtime validation of untrusted shapes. No dependencies (runs in the extension too).
 */

import type { AgentScriptOutput, ExportFile, SiteScript } from './types.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate the agent's structured output. Checks:
 *  - name: non-empty string, <= 60 chars (trimmed)
 *  - description: non-empty string, <= 200 chars (trimmed)
 *  - kind: 'css' | 'js'
 *  - urlPattern: valid match pattern (see matchPattern.ts). Rejected: '<all_urls>' and the
 *    all-hosts pattern (scheme star, host star, path star), because they are too broad.
 *  - priority: integer 1..5 (numeric strings are coerced)
 *  - code: non-empty string, <= 200_000 chars
 */
export function validateAgentOutput(input: unknown): ValidationResult<AgentScriptOutput> {
  void input;
  throw new Error('not implemented');
}

/** Validate a single stored SiteScript (used by import and storage migrations). */
export function validateSiteScript(input: unknown): ValidationResult<SiteScript> {
  void input;
  throw new Error('not implemented');
}

/** Parse and validate an export file. Invalid scripts are reported, valid ones returned. */
export function parseExportFile(json: string): ValidationResult<{ file: ExportFile; invalid: string[] }> {
  void json;
  throw new Error('not implemented');
}
