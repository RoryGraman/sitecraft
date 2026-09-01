/**
 * File logger. The native messaging host must never write to stdout except
 * framed messages, and Chrome swallows stderr, so we log to a file.
 * Default path: ~/.sitecraft/companion.log
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  readonly file: string | null;
}

export function sitecraftHome(home: string = os.homedir()): string {
  return path.join(home, '.sitecraft');
}

export function createLogger(opts: { file?: string | null; level?: LogLevel; toStderr?: boolean } = {}): Logger {
  const file = opts.file === undefined ? path.join(sitecraftHome(), 'companion.log') : opts.file;
  const min = LEVELS[opts.level ?? (process.env.SITECRAFT_LOG_LEVEL as LogLevel) ?? 'info'] ?? 20;
  let ready = false;
  const write = (level: LogLevel, msg: string, data?: unknown) => {
    if (LEVELS[level] < min) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (data !== undefined) {
      try {
        line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
      } catch {
        line += ' [unserializable]';
      }
    }
    line += '\n';
    if (opts.toStderr) process.stderr.write(line);
    if (!file) return;
    try {
      if (!ready) {
        mkdirSync(path.dirname(file), { recursive: true });
        ready = true;
      }
      appendFileSync(file, line);
    } catch {
      // Logging must never crash the host.
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    file,
  };
}

/** Silent logger for tests. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  file: null,
};
