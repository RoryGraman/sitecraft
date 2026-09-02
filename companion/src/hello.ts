/**
 * Record of the extension's last hello, written for the setup wizard.
 *
 * The extension sends { version, userScriptsEnabled } with each ping. The host
 * writes it here, so a terminal can tell that this build is loaded and
 * talking, without reading Chrome's lazily written preference files.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionHello } from '@sitecraft/shared';
import { sitecraftHome } from './log.js';

export const EXTENSION_RECORD_FILENAME = 'extension.json';

export interface ExtensionRecord extends ExtensionHello {
  /** ISO time the hello arrived. */
  at: string;
  companionVersion: string;
}

export function extensionRecordPath(home: string): string {
  return path.join(sitecraftHome(home), EXTENSION_RECORD_FILENAME);
}

/** Write the record atomically (temp file, then rename). Returns the path. */
export async function writeExtensionRecord(
  home: string,
  hello: ExtensionHello,
  companionVersion: string,
  now: Date = new Date(),
): Promise<string> {
  const file = extensionRecordPath(home);
  const record: ExtensionRecord = {
    at: now.toISOString(),
    version: hello.version,
    userScriptsEnabled: hello.userScriptsEnabled,
    companionVersion,
  };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o644 });
  await rename(tmp, file);
  return file;
}
