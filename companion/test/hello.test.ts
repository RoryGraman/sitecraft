import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extensionRecordPath, writeExtensionRecord } from '../src/hello.js';

let home = '';

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = '';
});

describe('writeExtensionRecord', () => {
  it('writes the hello with a time under ~/.sitecraft/extension.json', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'sitecraft-hello-'));
    const now = new Date('2026-09-01T12:00:00.000Z');
    const file = await writeExtensionRecord(home, { version: '0.1.0', userScriptsEnabled: true }, '0.2.0', now);
    expect(file).toBe(extensionRecordPath(home));
    expect(file).toBe(path.join(home, '.sitecraft', 'extension.json'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      at: '2026-09-01T12:00:00.000Z',
      version: '0.1.0',
      userScriptsEnabled: true,
      companionVersion: '0.2.0',
    });
  });

  it('replaces an earlier record atomically and leaves no temp file', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'sitecraft-hello-'));
    await writeExtensionRecord(home, { version: '0.1.0', userScriptsEnabled: false }, '0.2.0');
    const file = await writeExtensionRecord(home, { version: '0.1.0', userScriptsEnabled: true }, '0.2.0');
    expect(JSON.parse(await readFile(file, 'utf8')).userScriptsEnabled).toBe(true);
    expect(await readdir(path.dirname(file))).toEqual(['extension.json']);
  });
});
