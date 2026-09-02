/**
 * Native messaging host loop.
 *
 * Reads HostInbound frames from stdin, dispatches them, and writes
 * HostOutbound frames to stdout. Nothing else may ever touch stdout: Chrome
 * treats every byte on it as part of a frame.
 *
 * Message semantics:
 *   ping          -> pong
 *   checkAuth     -> authResult
 *   run           -> progress* / inspect* -> result
 *   cancel        -> aborts that run
 *   inspectResult -> resolves the matching pending inspect
 */
import { randomUUID } from 'node:crypto';
import { NATIVE_MAX_MESSAGE_BYTES } from '@sitecraft/shared';
import type { AgentRequest, ExtensionHello, HostInbound, HostOutbound } from '@sitecraft/shared';
import type { AgentHooks, AgentRunOptions, RunAgentFn } from './agent.js';
import { FrameParser, FrameTooLargeError, encodeJsonFrame } from './framing.js';
import { nullLogger, type Logger } from './log.js';

export interface HostIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export interface HostDeps {
  runAgent: RunAgentFn;
  checkLogin: () => Promise<{ ok: boolean; detail: string }>;
  version: string;
  logger?: Logger;
  agentOptions?: AgentRunOptions;
  /** How long to wait for the extension to answer an inspect. Default 20 s. */
  inspectTimeoutMs?: number;
  /** How long checkAuth may take. Default 60 s. */
  authTimeoutMs?: number;
  /** Called with what the extension reports about itself on each ping. */
  onHello?(hello: ExtensionHello): void;
}

export interface HostHandle {
  /** Stop reading, abort every run, reject pending inspects. Idempotent. */
  stop(): void;
  /** Resolves after stop() or when stdin ends. */
  done: Promise<void>;
}

/** Largest outbound frame body we allow ourselves. Leaves slack under Chrome's 1 MB cap. */
export const OUTBOUND_MAX_BYTES = NATIVE_MAX_MESSAGE_BYTES - 1024;
export const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
export const DEFAULT_AUTH_TIMEOUT_MS = 60_000;

const INBOUND_TYPES: ReadonlySet<string> = new Set(['ping', 'checkAuth', 'run', 'cancel', 'inspectResult']);

interface PendingInspect {
  runId: string;
  resolve(html: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface ActiveRun {
  controller: AbortController;
  inspects: Set<string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isHostInbound(v: unknown): v is HostInbound {
  return isRecord(v) && typeof v.type === 'string' && INBOUND_TYPES.has(v.type) && typeof v.requestId === 'string';
}

function isAgentRequest(v: unknown): v is AgentRequest {
  return (
    isRecord(v) &&
    typeof v.request === 'string' &&
    isRecord(v.page) &&
    typeof v.page.url === 'string' &&
    typeof v.page.title === 'string' &&
    typeof v.page.snapshot === 'string' &&
    (v.model === undefined || typeof v.model === 'string') &&
    Array.isArray(v.existingScripts)
  );
}

/** The extension's self-report on a ping, or null when absent or malformed. */
function readHello(v: unknown): ExtensionHello | null {
  if (!isRecord(v) || typeof v.version !== 'string' || typeof v.userScriptsEnabled !== 'boolean') return null;
  return { version: v.version, userScriptsEnabled: v.userScriptsEnabled };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function startHost(io: HostIo, deps: HostDeps): HostHandle {
  const log = deps.logger ?? nullLogger;
  const inspectTimeoutMs = deps.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
  const authTimeoutMs = deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const runs = new Map<string, ActiveRun>();
  const inspects = new Map<string, PendingInspect>();
  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // ---- outbound -----------------------------------------------------------

  function writeFrame(msg: HostOutbound): void {
    if (stopped) return;
    let json = JSON.stringify(msg);
    const bytes = Buffer.byteLength(json);
    if (bytes > OUTBOUND_MAX_BYTES) {
      const replacement = oversizeReplacement(msg, bytes);
      log.error(`Outbound ${msg.type} message is too large (${bytes} bytes); replaced`, { type: msg.type });
      json = JSON.stringify(replacement);
    }
    try {
      io.stdout.write(encodeJsonFrame(json));
    } catch (err) {
      log.error('Failed to write to stdout', errorMessage(err));
    }
  }

  function oversizeReplacement(msg: HostOutbound, bytes: number): HostOutbound {
    const detail = `Message too large: ${bytes} bytes, limit is ${OUTBOUND_MAX_BYTES}.`;
    if (msg.type === 'result') {
      return { type: 'result', requestId: msg.requestId, ok: false, error: `Result too large to send. ${detail}` };
    }
    return { type: 'log', level: 'error', message: `Dropped oversize ${msg.type} message. ${detail}` };
  }

  function sendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    log[level](message);
    writeFrame({ type: 'log', level, message });
  }

  // ---- inspect bookkeeping -------------------------------------------------

  function rejectInspect(id: string, err: Error): void {
    const pending = inspects.get(id);
    if (!pending) return;
    inspects.delete(id);
    clearTimeout(pending.timer);
    runs.get(pending.runId)?.inspects.delete(id);
    pending.reject(err);
  }

  function resolveInspect(id: string, html: string): void {
    const pending = inspects.get(id);
    if (!pending) return;
    inspects.delete(id);
    clearTimeout(pending.timer);
    runs.get(pending.runId)?.inspects.delete(id);
    pending.resolve(html);
  }

  function requestInspect(runId: string, run: ActiveRun, selector: string): Promise<string> {
    if (run.controller.signal.aborted) return Promise.reject(new Error('Run cancelled'));
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => rejectInspect(id, new Error(`inspect_page timed out after ${Math.round(inspectTimeoutMs / 1000)} s`)),
        inspectTimeoutMs,
      );
      timer.unref?.();
      inspects.set(id, { runId, resolve, reject, timer });
      run.inspects.add(id);
      writeFrame({ type: 'inspect', requestId: id, runId, selector });
    });
  }

  // ---- run lifecycle --------------------------------------------------------

  function abortRun(runId: string, reason: string): boolean {
    const run = runs.get(runId);
    if (!run) return false;
    for (const id of [...run.inspects]) rejectInspect(id, new Error(reason));
    if (!run.controller.signal.aborted) run.controller.abort(new Error(reason));
    return true;
  }

  function finishRun(runId: string): void {
    const run = runs.get(runId);
    if (!run) return;
    for (const id of [...run.inspects]) rejectInspect(id, new Error('Run finished'));
    runs.delete(runId);
  }

  async function handleRun(requestId: string, payload: unknown): Promise<void> {
    if (runs.has(requestId)) {
      sendLog('warn', `Ignoring duplicate run ${requestId}`);
      return;
    }
    if (!isAgentRequest(payload)) {
      writeFrame({ type: 'result', requestId, ok: false, error: 'Run request is missing a valid payload.' });
      return;
    }
    const controller = new AbortController();
    const run: ActiveRun = { controller, inspects: new Set() };
    runs.set(requestId, run);
    log.info('Run started', { requestId, url: payload.page.url, request: payload.request.slice(0, 200) });

    const hooks: AgentHooks = {
      onProgress: (status) => {
        if (runs.get(requestId) !== run) return;
        writeFrame({ type: 'progress', requestId, status });
      },
      inspectPage: (selector) => requestInspect(requestId, run, selector),
      signal: controller.signal,
    };

    try {
      const script = await deps.runAgent(payload, hooks, deps.agentOptions);
      if (controller.signal.aborted) throw new Error('Run cancelled');
      log.info('Run finished', { requestId, name: script.name, kind: script.kind });
      writeFrame({ type: 'result', requestId, ok: true, script });
    } catch (err) {
      const error = controller.signal.aborted ? 'Run cancelled' : errorMessage(err);
      log.warn('Run failed', { requestId, error });
      writeFrame({ type: 'result', requestId, ok: false, error });
    } finally {
      finishRun(requestId);
    }
  }

  async function handleCheckAuth(requestId: string): Promise<void> {
    try {
      const res = await withTimeout(deps.checkLogin(), authTimeoutMs, 'Login check');
      writeFrame({ type: 'authResult', requestId, ok: res.ok, detail: res.detail });
    } catch (err) {
      writeFrame({ type: 'authResult', requestId, ok: false, detail: errorMessage(err) });
    }
  }

  // ---- inbound dispatch -----------------------------------------------------

  function dispatch(raw: unknown): void {
    if (!isHostInbound(raw)) {
      const type = isRecord(raw) && typeof raw.type === 'string' ? raw.type : typeof raw;
      sendLog('warn', `Ignoring unknown message type: ${type}`);
      return;
    }
    switch (raw.type) {
      case 'ping': {
        const hello = readHello((raw as { extension?: unknown }).extension);
        if (hello && deps.onHello) {
          try {
            deps.onHello(hello);
          } catch (err) {
            log.warn('onHello failed', errorMessage(err));
          }
        }
        writeFrame({ type: 'pong', requestId: raw.requestId, companionVersion: deps.version, node: process.version });
        return;
      }
      case 'checkAuth':
        void handleCheckAuth(raw.requestId);
        return;
      case 'run':
        void handleRun(raw.requestId, (raw as { payload?: unknown }).payload);
        return;
      case 'cancel':
        if (!abortRun(raw.requestId, 'Run cancelled')) log.debug('Cancel for unknown run', raw.requestId);
        return;
      case 'inspectResult':
        if (!inspects.has(raw.requestId)) {
          log.debug('inspectResult for unknown inspect', raw.requestId);
          return;
        }
        if (raw.ok) resolveInspect(raw.requestId, typeof raw.html === 'string' ? raw.html : '');
        else rejectInspect(raw.requestId, new Error(typeof raw.error === 'string' ? raw.error : 'inspect failed'));
        return;
    }
  }

  // With onError set the parser never throws: bad frames are logged and
  // skipped, and every message decoded before them is still delivered.
  const parser = new FrameParser({
    onError: (err) => {
      if (err instanceof FrameTooLargeError) {
        log.error('Dropped buffered input: frame header out of range. Stream may be out of sync.', err.message);
      } else {
        log.error('Dropped frame with invalid JSON', err.message);
      }
    },
  });

  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let messages: unknown[];
    try {
      messages = parser.push(buf);
    } catch (err) {
      log.error('Frame parser error', errorMessage(err));
      parser.reset();
      return;
    }
    for (const m of messages) {
      try {
        dispatch(m);
      } catch (err) {
        log.error('Unhandled error while dispatching a message', errorMessage(err));
      }
    }
  };

  const onEnd = (): void => {
    log.info('stdin closed');
    stop();
  };

  const onStdinError = (err: unknown): void => {
    log.error('stdin error', errorMessage(err));
    stop();
  };

  const onStdoutError = (err: unknown): void => {
    log.error('stdout error', errorMessage(err));
    stop();
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    io.stdin.off('data', onData);
    io.stdin.off('end', onEnd);
    io.stdin.off('close', onEnd);
    io.stdin.off('error', onStdinError);
    io.stdout.off('error', onStdoutError);
    try {
      io.stdin.pause();
    } catch {
      // A closed stream may refuse; nothing to do.
    }
    for (const runId of [...runs.keys()]) abortRun(runId, 'Host stopped');
    for (const id of [...inspects.keys()]) rejectInspect(id, new Error('Host stopped'));
    runs.clear();
    resolveDone();
  }

  io.stdin.on('data', onData);
  io.stdin.on('end', onEnd);
  io.stdin.on('close', onEnd);
  io.stdin.on('error', onStdinError);
  io.stdout.on('error', onStdoutError);

  return { stop, done };
}
