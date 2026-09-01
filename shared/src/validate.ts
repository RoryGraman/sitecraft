/**
 * Runtime validation of untrusted shapes. No dependencies (runs in the extension too).
 *
 * Every error message starts with the field name it is about. When several fields fail,
 * the messages are joined with '; '.
 */

import { parseMatchPattern } from './matchPattern.js';
import { SCHEMA_VERSION } from './types.js';
import type { AgentScriptOutput, ExportFile, Priority, ScriptKind, SiteScript } from './types.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const NAME_MAX_CHARS = 60;
export const DESCRIPTION_MAX_CHARS = 200;
export const CODE_MAX_CHARS = 200_000;

const EXPORT_FORMAT: ExportFile['format'] = 'sitecraft-scripts';

type Field<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T = never>(error: string): Field<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed string with a length range. */
function readText(field: string, value: unknown, min: number, max: number): Field<string> {
  if (typeof value !== 'string') return fail(`${field} must be a string`);
  const text = value.trim();
  if (text.length < min) return fail(`${field} must not be empty`);
  if (text.length > max) return fail(`${field} must be at most ${max} characters`);
  return { ok: true, value: text };
}

function readNonEmptyString(field: string, value: unknown): Field<string> {
  if (typeof value !== 'string') return fail(`${field} must be a string`);
  if (value === '') return fail(`${field} must not be empty`);
  return { ok: true, value };
}

function readKind(value: unknown): Field<ScriptKind> {
  if (value === 'css' || value === 'js') return { ok: true, value };
  return fail("kind must be 'css' or 'js'");
}

/** Integer 1..5. Numeric strings such as '2' are coerced. */
function readPriority(value: unknown): Field<Priority> {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (n === 1 || n === 2 || n === 3 || n === 4 || n === 5) return { ok: true, value: n };
  return fail('priority must be a whole number from 1 to 5');
}

/** Valid match pattern that names a specific site. */
function readUrlPattern(value: unknown): Field<string> {
  if (typeof value !== 'string') return fail('urlPattern must be a string');
  const pattern = value.trim();
  const parsed = parseMatchPattern(pattern);
  if (parsed === null) return fail(`urlPattern is not a valid match pattern: ${JSON.stringify(pattern)}`);
  if (parsed.allUrls || parsed.host === '*') {
    return fail('urlPattern is too broad. Use a specific site such as https://www.example.com/*');
  }
  return { ok: true, value: pattern };
}

/** Code is kept as written. Whitespace-only code is rejected. */
function readCode(value: unknown): Field<string> {
  if (typeof value !== 'string') return fail('code must be a string');
  if (value.trim() === '') return fail('code must not be empty');
  if (value.length > CODE_MAX_CHARS) return fail(`code must be at most ${CODE_MAX_CHARS} characters`);
  return { ok: true, value };
}

function readBoolean(field: string, value: unknown): Field<boolean> {
  if (typeof value === 'boolean') return { ok: true, value };
  return fail(`${field} must be true or false`);
}

function readIsoDate(field: string, value: unknown): Field<string> {
  if (typeof value !== 'string') return fail(`${field} must be a date string`);
  if (Number.isNaN(Date.parse(value))) return fail(`${field} is not a valid date: ${JSON.stringify(value)}`);
  return { ok: true, value };
}

/** Collects field results. Any failure turns the whole result into an error. */
class Collector {
  private readonly errors: string[] = [];

  /** Returns the field value, or undefined after recording the error. */
  take<T>(field: Field<T>): T | undefined {
    if (field.ok) return field.value;
    this.errors.push(field.error);
    return undefined;
  }

  finish<T>(build: () => T): ValidationResult<T> {
    if (this.errors.length > 0) return { ok: false, error: this.errors.join('; ') };
    return { ok: true, value: build() };
  }
}

/**
 * Validate the agent's structured output. Checks:
 *  - name: non-empty string, <= 60 chars (trimmed)
 *  - description: non-empty string, <= 200 chars (trimmed)
 *  - kind: 'css' | 'js'
 *  - urlPattern: valid match pattern (see matchPattern.ts), trimmed. Rejected: '<all_urls>' and
 *    any pattern whose host is '*' (such as the all-hosts pattern scheme star, host star,
 *    path star), because they are too broad.
 *  - priority: integer 1..5 (numeric strings are coerced)
 *  - code: non-empty string, <= 200_000 chars
 * Unknown fields are dropped.
 */
export function validateAgentOutput(input: unknown): ValidationResult<AgentScriptOutput> {
  if (!isRecord(input)) return { ok: false, error: 'output must be an object' };
  const c = new Collector();
  const name = c.take(readText('name', input.name, 1, NAME_MAX_CHARS));
  const description = c.take(readText('description', input.description, 1, DESCRIPTION_MAX_CHARS));
  const kind = c.take(readKind(input.kind));
  const urlPattern = c.take(readUrlPattern(input.urlPattern));
  const priority = c.take(readPriority(input.priority));
  const code = c.take(readCode(input.code));
  return c.finish(() => ({
    name: name as string,
    description: description as string,
    kind: kind as ScriptKind,
    urlPattern: urlPattern as string,
    priority: priority as Priority,
    code: code as string,
  }));
}

/**
 * Validate a single stored SiteScript (used by import and storage migrations).
 * Same field rules as validateAgentOutput, plus id, enabled, trial, createdAt, updatedAt.
 * The description may be empty here because users can edit it.
 */
export function validateSiteScript(input: unknown): ValidationResult<SiteScript> {
  if (!isRecord(input)) return { ok: false, error: 'script must be an object' };
  const c = new Collector();
  const id = c.take(readNonEmptyString('id', input.id));
  const name = c.take(readText('name', input.name, 1, NAME_MAX_CHARS));
  const description = c.take(readText('description', input.description, 0, DESCRIPTION_MAX_CHARS));
  const urlPattern = c.take(readUrlPattern(input.urlPattern));
  const kind = c.take(readKind(input.kind));
  const priority = c.take(readPriority(input.priority));
  const code = c.take(readCode(input.code));
  const enabled = c.take(readBoolean('enabled', input.enabled));
  const trial = c.take(readBoolean('trial', input.trial));
  const createdAt = c.take(readIsoDate('createdAt', input.createdAt));
  const updatedAt = c.take(readIsoDate('updatedAt', input.updatedAt));
  return c.finish(() => ({
    id: id as string,
    name: name as string,
    description: description as string,
    urlPattern: urlPattern as string,
    kind: kind as ScriptKind,
    priority: priority as Priority,
    code: code as string,
    enabled: enabled as boolean,
    trial: trial as boolean,
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  }));
}

/** Label for an invalid export entry: its id when it has one, else its 1-based position. */
function invalidLabel(entry: unknown, index: number): string {
  if (isRecord(entry) && typeof entry.id === 'string' && entry.id !== '') return entry.id;
  return `#${index + 1}`;
}

/**
 * Parse and validate an export file. Invalid scripts are reported, valid ones returned.
 * Files written by a newer schema version are rejected.
 */
export function parseExportFile(json: string): ValidationResult<{ file: ExportFile; invalid: string[] }> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'file is not valid JSON' };
  }
  if (!isRecord(data)) return { ok: false, error: 'file is not a Sitecraft export' };
  if (data.format !== EXPORT_FORMAT) {
    return { ok: false, error: `format must be '${EXPORT_FORMAT}'` };
  }
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'version must be a whole number' };
  }
  if (version > SCHEMA_VERSION) {
    return { ok: false, error: `version ${version} is newer than this extension supports (${SCHEMA_VERSION})` };
  }
  if (typeof data.exportedAt !== 'string') return { ok: false, error: 'exportedAt must be a string' };
  if (!Array.isArray(data.scripts)) return { ok: false, error: 'scripts must be an array' };

  const scripts: SiteScript[] = [];
  const invalid: string[] = [];
  data.scripts.forEach((entry: unknown, index: number) => {
    const result = validateSiteScript(entry);
    if (result.ok) scripts.push(result.value);
    else invalid.push(invalidLabel(entry, index));
  });

  return {
    ok: true,
    value: {
      file: { format: EXPORT_FORMAT, version, exportedAt: data.exportedAt, scripts },
      invalid,
    },
  };
}
